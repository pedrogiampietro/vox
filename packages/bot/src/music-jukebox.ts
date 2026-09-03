import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import {
  ChannelFlags,
  ChatScope,
  FrameKind,
  Op,
  PROTOCOL_VERSION,
  VoiceFlags,
  decodeServerMessage,
  encodeClientMessage,
  encodeVoice,
} from '@vox/protocol';
import type { ChannelInfo, ClientInfo, ClientMessage, ServerMessage } from '@vox/protocol';

const address = process.env['VOX_BOT_ADDRESS'] || 'ws://127.0.0.1:9987/vox';
const password = process.env['VOX_BOT_PASSWORD'] || '';
const botChannelName = process.env['VOX_BOT_CHANNEL'] || 'bot';
const ffmpegBin = process.env['VOX_FFMPEG'] || 'ffmpeg';
const ytdlpBin = process.env['VOX_YTDLP'] || 'yt-dlp';
const ytdlpExtraArgs = (process.env['VOX_YTDLP_ARGS'] || '').trim();
const bitrate = process.env['VOX_BOT_BITRATE'] || '96k';
/** Ganho aplicado ao audio antes de encodar. 0.25 = -12dB, padrao seguro. */
const volumeGain = Number(process.env['VOX_BOT_VOLUME'] || '0.25');

interface TrackRequest {
  query: string;
  requestedBy: number;
  requestedByName: string;
  channelId: number;
  viaDm: boolean;
}

interface ResolvedTrack {
  /** 'direct' = URL/arquivo acessivel diretamente pelo ffmpeg. */
  /** 'ytdlp' = precisa passar por yt-dlp (cookies, JS challenge, etc.). */
  source: 'direct' | 'ytdlp';
  /** URL ou path (direct) ou query original (ytdlp). */
  input: string;
  title: string;
}

const queue: TrackRequest[] = [];
let current: TrackRequest | null = null;
let controller: VoxConnection;
let player: VoxConnection | null = null;
let activePlayer: MusicPlayer | null = null;

async function onControllerMessage(msg: ServerMessage): Promise<void> {
  if (msg.t === Op.Snapshot) {
    joinBotChannel();
    return;
  }
  if (msg.t === Op.ChannelAdd || msg.t === Op.ChannelUpdate) {
    joinBotChannel();
    return;
  }
  if (msg.t !== Op.ChatDeliver) return;
  if (msg.senderId === 0) return;
  if (msg.senderId === controller.selfId) return;
  // Aceita mensagens de duas formas:
  //  - Chat do canal `bot` (quem esta la digitando comandos)
  //  - DM enviada diretamente ao bot (funciona de qualquer canal — o bot vai
  //    ate o canal atual do requisitante para tocar).
  if (msg.scope === ChatScope.Channel) {
    const senderInfo = controller.clients.get(msg.senderId);
    if (!senderInfo || senderInfo.channelId !== controller.self?.channelId) return;
  } else if (msg.scope === ChatScope.Private) {
    if (msg.targetId !== controller.selfId) return;
  } else {
    return;
  }
  const isDm = msg.scope === ChatScope.Private;

  const body = msg.text.trim();
  if (!body) return;

  // reply: se veio por DM, responde DM pro requisitante; se veio pelo canal,
  // anuncia no canal do bot.
  const reply = (text: string): void => {
    if (isDm) {
      controller.send({ t: Op.ChatSend, scope: ChatScope.Private, targetId: msg.senderId, text });
    } else {
      controller.send({ t: Op.ChatSend, scope: ChatScope.Channel, targetId: 0, text });
    }
  };

  const lower = body.toLowerCase();
  if (lower === 'fila' || lower === 'queue') {
    reply(queue.length ? queue.map((t, i) => `${i + 1}. ${t.query} - ${t.requestedByName}`).join('\n') : 'fila vazia');
    return;
  }
  if (lower === 'skip' || lower === 'pular') {
    if (!activePlayer) reply('nada tocando agora');
    else activePlayer.stop(true);
    return;
  }
  if (lower === 'stop' || lower === 'parar') {
    queue.length = 0;
    if (activePlayer) activePlayer.stop(true);
    reply('fila limpa');
    return;
  }

  const requester = controller.clients.get(msg.senderId);
  const channelId = requester?.channelId ?? 0;
  if (!channelId) {
    reply(`nao achei o canal de ${msg.senderName}`);
    return;
  }

  queue.push({
    query: body,
    requestedBy: msg.senderId,
    requestedByName: msg.senderName,
    channelId,
    viaDm: isDm,
  });
  reply(activePlayer ? `adicionado na fila: ${body}` : `tocando agora: ${body}`);
  void pumpQueue();
}

function joinBotChannel(): void {
  const id = controller.findChannel(botChannelName);
  console.log(`[jukebox] joinBotChannel: name="${botChannelName}" foundId=${id} currentCh=${controller.self?.channelId}`);
  if (id && controller.self?.channelId !== id) controller.send({ t: Op.JoinChannel, channelId: id, password: '' });
}

async function pumpQueue(): Promise<void> {
  if (activePlayer || current) return;
  current = queue.shift() ?? null;
  if (!current) return;

  let track: ResolvedTrack;
  try {
    track = await resolveTrack(current.query);
  } catch (err) {
    const msg = `nao consegui resolver "${current.query}": ${trimError(err)}`;
    if (current.viaDm) {
      controller.send({ t: Op.ChatSend, scope: ChatScope.Private, targetId: current.requestedBy, text: msg });
    } else {
      announce(msg);
    }
    current = null;
    void pumpQueue();
    return;
  }

  player = new VoxConnection('music player', () => {});
  await player.connect();
  player.send({ t: Op.JoinChannel, channelId: current.channelId, password: '' });

  // Anuncia o que esta tocando: DM para quem pediu por DM, senao no canal `bot`.
  // NUNCA no canal de voz — ninguem quer ver metadados no chat do canal.
  const announceMsg = `tocando: ${track.title} (pedido por ${current.requestedByName})`;
  if (current.viaDm) {
    controller.send({ t: Op.ChatSend, scope: ChatScope.Private, targetId: current.requestedBy, text: announceMsg });
  } else {
    announce(announceMsg);
  }

  activePlayer = new MusicPlayer(track, player, () => {
    activePlayer = null;
    player?.close('fim');
    player = null;
    current = null;
    void pumpQueue();
  });
  activePlayer.start();
}

function announce(text: string): void {
  controller.send({ t: Op.ChatSend, scope: ChatScope.Channel, targetId: 0, text });
}

/** Log de yt-dlp/ffmpeg vem em spam de linhas repetitivas. Deixa so o essencial. */
function trimError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const last = lines[lines.length - 1] || raw;
  return last.length > 200 ? last.slice(0, 200) + '…' : last;
}

async function resolveTrack(query: string): Promise<ResolvedTrack> {
  if (looksDirect(query)) return { source: 'direct', input: query, title: query };

  // So extrai o titulo. A URL do googlevideo caduca em segundos e amarra-se
  // ao user-agent do resolver, entao nao adianta guardar — ffmpeg vai pegar
  // 403. No playback pipamos yt-dlp -> ffmpeg, aproveitando cookies e headers.
  const extra = ytdlpExtraArgs ? splitArgs(ytdlpExtraArgs) : [];
  const lines = await runCapture(ytdlpBin, [
    '--no-playlist',
    '-f', 'bestaudio',
    '--print', '%(title)s',
    ...extra,
    `ytsearch1:${query}`,
  ]);
  const title = lines.map((l) => l.trim()).find(Boolean) || query;
  return { source: 'ytdlp', input: `ytsearch1:${query}`, title };
}

/**
 * Split shell-ish "--flag valor --outra=x" preservando "aspas". Simples de
 * proposito — nao roda comando, so vira argv pro spawn.
 */
function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function looksDirect(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  if (/^[a-z]:[\\/]/i.test(value)) return existsSync(value);
  return value.includes('/') || value.includes('\\');
}

function runCapture(command: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString().split(/\r?\n/));
      else reject(new Error(Buffer.concat(err).toString().trim() || `${command} saiu com codigo ${code}`));
    });
  });
}

class VoxConnection {
  selfId = 0;
  channels = new Map<number, ChannelInfo>();
  clients = new Map<number, ClientInfo>();
  self: ClientInfo | null = null;

  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly ready: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private identity: Awaited<ReturnType<typeof createIdentity>> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly nickname: string,
    private readonly onMessage: (msg: ServerMessage) => void,
  ) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  async connect(): Promise<void> {
    this.identity = await createIdentity();
    const ws = new WebSocket(address);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.send({
        t: Op.Hello,
        version: PROTOCOL_VERSION,
        nickname: this.nickname,
        password,
        publicKey: this.identity!.publicKey,
        platform: 'Music Bot',
      });
    });
    ws.on('message', (data) => {
      if (typeof data === 'string') return;
      const frame = new Uint8Array(data as ArrayBuffer);
      if (frame[0] === FrameKind.Voice) return;
      let msg: ServerMessage;
      try {
        msg = decodeServerMessage(frame);
      } catch {
        return;
      }
      void this.handle(msg);
    });
    ws.on('error', (err) => console.error(`[jukebox] ${this.nickname}: error ${err.message}`));
    ws.on('close', (code, reason) => {
      const why = reason?.toString() || '(sem motivo)';
      console.error(`[jukebox] ${this.nickname}: ws close code=${code} reason="${why}"`);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (!this.closed) {
        console.error(`[jukebox] ${this.nickname}: encerrando processo para systemd reiniciar limpo`);
        process.exit(1);
      }
    });
    // Heartbeat: server drops us after ~30s idle. 10s garante margem antes do
    // timeout. Nao usamos unref pra o timer sozinho segurar o loop caso o ws
    // fique num estado esquisito e a gente ainda queira reagir.
    this.heartbeat = setInterval(() => {
      const state = this.ws?.readyState;
      this.send({ t: Op.Ping, stamp: Date.now() });
      console.log(`[jukebox] ${this.nickname}: ping (ws state=${state})`);
    }, 10_000);
    await this.ready;
    console.log(`[jukebox] ${this.nickname}: heartbeat armado (10s), self=${this.selfId}`);
  }

  private async handle(msg: ServerMessage): Promise<void> {
    switch (msg.t) {
      case Op.Challenge:
        this.send({ t: Op.Auth, signature: await this.identity!.sign(msg.nonce) });
        return;
      case Op.Welcome:
        this.selfId = msg.clientId;
        return;
      case Op.Snapshot:
        this.channels = new Map(msg.channels.map((c) => [c.id, c]));
        this.clients = new Map(msg.clients.map((c) => [c.id, c]));
        this.self = this.clients.get(this.selfId) ?? null;
        this.resolveReady?.();
        this.resolveReady = null;
        break;
      case Op.ChannelAdd:
      case Op.ChannelUpdate:
        this.channels.set(msg.channel.id, msg.channel);
        break;
      case Op.ChannelRemove:
        this.channels.delete(msg.channelId);
        break;
      case Op.ClientAdd:
        this.clients.set(msg.client.id, msg.client);
        if (msg.client.id === this.selfId) this.self = msg.client;
        break;
      case Op.ClientRemove:
        this.clients.delete(msg.clientId);
        break;
      case Op.ClientMove: {
        const c = this.clients.get(msg.clientId);
        if (c) c.channelId = msg.channelId;
        if (msg.clientId === this.selfId) this.self = c ?? null;
        break;
      }
    }
    this.onMessage(msg);
  }

  findChannel(name: string): number {
    const found = [...this.channels.values()].find((c) => c.name.toLowerCase() === name.toLowerCase());
    return found?.id ?? [...this.channels.values()].find((c) => (c.flags & ChannelFlags.Default) !== 0)?.id ?? 0;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClientMessage(msg));
  }

  sendVoice(payload: Uint8Array, flags: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeVoice(this.seq, flags, payload));
    this.seq = (this.seq + 1) & 0xffff;
  }

  close(reason: string): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.ws?.close(1000, reason);
  }
}

/**
 * ~1s de audio (50 pacotes de 20ms) empilhado antes de comecar a enviar,
 * pra dar folga contra latencia de rede/ffmpeg no start.
 */
const PREBUFFER_PACKETS = 50;
/** Duracao (ms) de audio por pacote Opus quando o ffmpeg gera com -frame_duration 20. */
const FRAME_MS = 20;

class MusicPlayer {
  private readonly demux = new OggOpusDemuxer((packet) => this.queue.push(packet));
  private queue: Uint8Array[] = [];
  private ffmpeg: ReturnType<typeof spawn> | null = null;
  private ytdlp: ReturnType<typeof spawn> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private aloneWatch: ReturnType<typeof setInterval> | null = null;
  private aloneSince = 0;
  private finished = false;
  private started = false;
  private startAt = 0;
  private packetsSent = 0;

  constructor(
    private readonly track: ResolvedTrack,
    private readonly conn: VoxConnection,
    private readonly onDone: () => void,
  ) {}

  start(): void {
    // Fluxo: yt-dlp (com cookies/JS runtime) -> ffmpeg (transcode) -> nos.
    // Assim o ffmpeg nao fala com o googlevideo direto (sempre da 403 sem
    // os headers/cookies certos), e nao precisamos armazenar URL caduca.
    const usingYtdlp = this.track.source === 'ytdlp';
    let ffmpegInput = this.track.input;

    if (usingYtdlp) {
      const extra = ytdlpExtraArgs ? splitArgs(ytdlpExtraArgs) : [];
      const ytdlp = spawn(ytdlpBin, [
        '--no-playlist',
        '-f', 'bestaudio',
        '-o', '-',
        '--no-warnings',
        '--quiet',
        ...extra,
        this.track.input,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.ytdlp = ytdlp;
      ytdlp.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) console.error(`[yt-dlp] ${text}`);
      });
      ytdlp.on('error', (err) => {
        announce(`nao consegui iniciar yt-dlp: ${err.message}`);
        this.stop(false);
      });
      ffmpegInput = 'pipe:0';
    }

    // Corrente de audio:
    //  - dynaudnorm: normaliza dinamicamente (deixa musicas em volume parecido);
    //  - volume=<gain>: atenuacao final (musicas mixadas alto no YouTube facil
    //    saturam Opus mesmo depois do dynaudnorm; -12dB deixa margem).
    const audioFilter = `dynaudnorm=f=200:g=15,volume=${volumeGain}`;

    const ffmpeg = spawn(ffmpegBin, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-i', ffmpegInput,
      '-vn',
      '-af', audioFilter,
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-application', 'audio',
      '-frame_duration', '20',
      '-b:a', bitrate,
      '-f', 'opus',
      'pipe:1',
    ], { stdio: [usingYtdlp ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ffmpeg;

    if (usingYtdlp && this.ytdlp?.stdout && ffmpeg.stdin) {
      this.ytdlp.stdout.pipe(ffmpeg.stdin);
      // Se ffmpeg fechar antes de yt-dlp terminar, EPIPE quebra o process.
      ffmpeg.stdin.on('error', () => {});
    }

    ffmpeg.stdout?.on('data', (chunk: Buffer) => this.demux.push(chunk));
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[ffmpeg] ${text}`);
    });
    ffmpeg.on('error', (err) => {
      announce(`nao consegui iniciar ffmpeg: ${err.message}`);
      this.stop(false);
    });
    ffmpeg.on('close', () => {
      this.finished = true;
    });

    // Tick roda a 10ms (oversampling), decidindo se ja e hora de mandar o
    // proximo pacote pelo wall-clock. Isso evita drift do setInterval, que
    // sozinho a 20ms produz pequenos jitters audiveis ao longo da musica.
    this.timer = setInterval(() => this.tick(), 10);

    // Watchdog: se o canal em que o bot esta tocando ficar sem ouvintes por
    // mais de 10s, para tudo. Evita bot deserto queimando CPU e banda.
    this.aloneWatch = setInterval(() => this.checkAlone(), 3_000);
  }

  private checkAlone(): void {
    const myCh = this.conn.self?.channelId;
    if (!myCh) return;
    let listeners = 0;
    for (const c of this.conn.clients.values()) {
      if (c.channelId === myCh && c.id !== this.conn.selfId) listeners++;
    }
    if (listeners > 0) {
      this.aloneSince = 0;
      return;
    }
    const now = Date.now();
    if (this.aloneSince === 0) {
      this.aloneSince = now;
      return;
    }
    if (now - this.aloneSince >= 10_000) {
      console.log('[jukebox] canal vazio ha 10s, encerrando faixa');
      queue.length = 0; // limpa fila tambem — nao adianta tocar pra ninguem
      this.stop(false);
    }
  }

  stop(skipped: boolean): void {
    this.finished = true;
    if (this.ffmpeg) this.ffmpeg.kill('SIGTERM');
    this.ffmpeg = null;
    if (this.ytdlp) this.ytdlp.kill('SIGTERM');
    this.ytdlp = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.aloneWatch) clearInterval(this.aloneWatch);
    this.aloneWatch = null;
    this.queue.length = 0;
    if (skipped) announce('pulando...');
    this.onDone();
  }

  private tick(): void {
    // Warmup: espera acumular buffer minimo (ou o ffmpeg terminar antes disso)
    // para que a rede tenha folga antes do primeiro pacote sair.
    if (!this.started) {
      if (this.queue.length < PREBUFFER_PACKETS && !this.finished) return;
      this.started = true;
      this.startAt = Date.now();
      this.packetsSent = 0;
    }

    // Manda quantos pacotes forem necessarios para acompanhar o relogio.
    // Se o loop atrasou (GC, IO), enviamos varios de uma vez para recuperar.
    const now = Date.now();
    const shouldHaveSent = Math.floor((now - this.startAt) / FRAME_MS) + 1;
    let sent = 0;
    while (this.packetsSent < shouldHaveSent && this.queue.length > 0) {
      const packet = this.queue.shift()!;
      const isLast = this.finished && this.queue.length === 0;
      this.conn.sendVoice(packet, isLast ? VoiceFlags.EndOfTalk : VoiceFlags.None);
      this.packetsSent++;
      sent++;
      // Guarda contra loop patologico: no maximo 5 pacotes por tick (100ms de audio).
      if (sent >= 5) break;
    }
    if (this.finished && this.queue.length === 0) this.stop(false);
  }
}

async function createIdentity(): Promise<{
  publicKey: Uint8Array;
  sign(data: Uint8Array): Promise<Uint8Array>;
}> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  return {
    publicKey,
    async sign(data) {
      return new Uint8Array(await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        data,
      ));
    },
  };
}

class OggOpusDemuxer {
  private buffer = Buffer.alloc(0);
  private packetParts: Buffer[] = [];

  constructor(private readonly onPacket: (packet: Uint8Array) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const start = this.buffer.indexOf('OggS');
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      if (this.buffer.length < 27) return;

      const segments = this.buffer[26]!;
      const headerLen = 27 + segments;
      if (this.buffer.length < headerLen) return;

      const laces = this.buffer.subarray(27, headerLen);
      const bodyLen = [...laces].reduce((sum, v) => sum + v, 0);
      if (this.buffer.length < headerLen + bodyLen) return;

      const body = this.buffer.subarray(headerLen, headerLen + bodyLen);
      this.buffer = this.buffer.subarray(headerLen + bodyLen);

      let offset = 0;
      for (const lace of laces) {
        const part = body.subarray(offset, offset + lace);
        offset += lace;
        this.packetParts.push(part);
        if (lace < 255) this.finishPacket();
      }
    }
  }

  private finishPacket(): void {
    const packet = Buffer.concat(this.packetParts);
    this.packetParts = [];
    if (packet.length === 0) return;
    if (packet.subarray(0, 8).toString() === 'OpusHead') return;
    if (packet.subarray(0, 8).toString() === 'OpusTags') return;
    this.onPacket(new Uint8Array(packet));
  }
}

controller = new VoxConnection('music', (msg) => void onControllerMessage(msg));
await controller.connect();

console.log(`[jukebox] ouvindo pedidos em "${botChannelName}" (${address})`);
