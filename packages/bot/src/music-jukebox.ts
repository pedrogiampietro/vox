import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import {
  ChannelFlags,
  ChatScope,
  FrameKind,
  NO_CHANNEL,
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
// O yt-dlp é usado somente como extrator do SoundCloud. O YouTube não faz
// parte do jukebox e não há dependência de cookies ou login dessa plataforma.
const extractorBin = process.env['VOX_YTDLP'] || 'yt-dlp';
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
  /** 'extractor' = precisa passar pelo extrator do SoundCloud. */
  source: 'direct' | 'extractor';
  /** URL ou path (direct) ou query original (extractor). */
  input: string;
  title: string;
}

interface ChannelSession {
  channelId: number;
  queue: TrackRequest[];
  current: TrackRequest | null;
  player: VoxConnection | null;
  activePlayer: MusicPlayer | null;
  cancelled: boolean;
  cancelVersion: number;
}

const sessions = new Map<number, ChannelSession>();
let controller: VoxConnection;
let controllerChannelId = 0;

function getSession(channelId: number): ChannelSession {
  let session = sessions.get(channelId);
  if (!session) {
    session = {
      channelId,
      queue: [],
      current: null,
      player: null,
      activePlayer: null,
      cancelled: false,
      cancelVersion: 0,
    };
    sessions.set(channelId, session);
  }
  return session;
}

function requestedChannelId(senderId: number): number {
  return controller.clients.get(senderId)?.channelId ?? NO_CHANNEL;
}

function isControllerChannel(channelId: number): boolean {
  return channelId > 0 && channelId === controllerChannelId;
}

function releaseEmptySession(session: ChannelSession): void {
  if (!session.current && !session.activePlayer && session.queue.length === 0) {
    sessions.delete(session.channelId);
  }
}

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
  const channelId = requestedChannelId(msg.senderId);

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
  const existingSession = channelId ? sessions.get(channelId) : undefined;
  if (lower === 'fila' || lower === 'queue') {
    reply(existingSession?.queue.length
      ? existingSession.queue.map((t, i) => `${i + 1}. ${t.query} - ${t.requestedByName}`).join('\n')
      : 'fila vazia');
    return;
  }
  if (lower === 'skip' || lower === 'pular') {
    if (!existingSession?.activePlayer) reply('nada tocando agora');
    else existingSession.activePlayer.stop(true);
    return;
  }
  if (lower === 'stop' || lower === 'parar') {
    if (existingSession) {
      existingSession.cancelled = true;
      existingSession.cancelVersion++;
      existingSession.queue.length = 0;
      if (existingSession.activePlayer) existingSession.activePlayer.stop(true);
      else if (existingSession.player) existingSession.player.close('parar');
      releaseEmptySession(existingSession);
    }
    reply('fila limpa');
    return;
  }

  if (!channelId) {
    reply(`nao achei o canal de ${msg.senderName}`);
    return;
  }

  // O canal de controle fica ocupado pelo bot permanente. Se aceitarmos uma
  // faixa ali, o player temporario entra junto do controlador e a presenca do
  // proprio bot pode manter a sessao viva indefinidamente. Pedidos devem vir
  // por DM ou do canal de voz onde a musica sera ouvida.
  if (isControllerChannel(channelId)) {
    reply('pedidos de musica nao podem ser feitos no canal bot; use DM ou outro canal de voz');
    return;
  }

  const session = getSession(channelId);
  session.cancelled = false;
  session.queue.push({
    query: body,
    requestedBy: msg.senderId,
    requestedByName: msg.senderName,
    channelId,
    viaDm: isDm,
  });
  reply(session.activePlayer || session.current ? `adicionado na fila: ${body}` : `tocando agora: ${body}`);
  void pumpQueue(session);
}

function joinBotChannel(): void {
  const id = controller.findChannel(botChannelName);
  controllerChannelId = id;
  console.log(`[jukebox] joinBotChannel: name="${botChannelName}" foundId=${id} currentCh=${controller.self?.channelId}`);
  if (id && controller.self?.channelId !== id) controller.send({ t: Op.JoinChannel, channelId: id, password: '' });
}

async function pumpQueue(session: ChannelSession): Promise<void> {
  if (session.activePlayer || session.current) return;
  session.current = session.queue.shift() ?? null;
  if (!session.current) {
    releaseEmptySession(session);
    return;
  }
  const current = session.current;
  const cancelVersion = session.cancelVersion;

  // Defesa em profundidade para filas criadas antes de o canal de controle
  // ser identificado ou por uma mudança de configuração durante a execução.
  if (isControllerChannel(current.channelId)) {
    session.current = null;
    session.queue.length = 0;
    session.cancelled = true;
    session.cancelVersion++;
    if (current.viaDm) {
      controller.send({
        t: Op.ChatSend,
        scope: ChatScope.Private,
        targetId: current.requestedBy,
        text: 'pedidos de musica nao podem ser feitos no canal bot; use DM ou outro canal de voz',
      });
    } else {
      announce('pedidos de musica nao podem ser feitos no canal bot; use DM ou outro canal de voz');
    }
    releaseEmptySession(session);
    return;
  }

  let track: ResolvedTrack;
  try {
    track = await resolveTrack(current.query);
  } catch (err) {
    const raw = trimError(err);
    const friendly = friendlyResolveError(current.query, raw);
    if (session.cancelVersion === cancelVersion && !session.cancelled && current.viaDm) {
      controller.send({ t: Op.ChatSend, scope: ChatScope.Private, targetId: current.requestedBy, text: friendly });
    } else if (session.cancelVersion === cancelVersion && !session.cancelled) {
      announce(friendly);
    }
    session.current = null;
    if (!session.cancelled) void pumpQueue(session);
    else releaseEmptySession(session);
    return;
  }

  if (session.cancelVersion !== cancelVersion || session.cancelled || session.current !== current) {
    session.current = null;
    if (!session.cancelled) void pumpQueue(session);
    else releaseEmptySession(session);
    return;
  }

  let player: VoxConnection;
  player = new VoxConnection(`music-${session.channelId}`, () => {}, () => {
    if (session.player !== player) return;
    console.error(`[jukebox] player do canal ${session.channelId} perdeu a conexão`);
    session.player = null;
    session.activePlayer?.stop(false);
    if (!session.activePlayer) {
      session.current = null;
      void pumpQueue(session);
    }
  });
  session.player = player;
  try {
    await player.connect();
  } catch (err) {
    session.player = null;
    session.current = null;
    if (session.cancelVersion === cancelVersion && !session.cancelled) {
      announce(`nao consegui conectar o player do canal: ${trimError(err)}`);
    }
    if (!session.cancelled) void pumpQueue(session);
    else releaseEmptySession(session);
    return;
  }
  if (session.cancelVersion !== cancelVersion || session.cancelled || session.current !== current) {
    player.close('cancelado');
    session.player = null;
    session.current = null;
    if (!session.cancelled) void pumpQueue(session);
    else releaseEmptySession(session);
    return;
  }
  player.send({ t: Op.JoinChannel, channelId: current.channelId, password: '' });

  // Anuncia o que esta tocando: DM para quem pediu por DM, senao no canal `bot`.
  // NUNCA no canal de voz — ninguem quer ver metadados no chat do canal.
  const announceMsg = `tocando: ${track.title} (pedido por ${current.requestedByName})`;
  if (current.viaDm) {
    controller.send({ t: Op.ChatSend, scope: ChatScope.Private, targetId: current.requestedBy, text: announceMsg });
  } else {
    announce(announceMsg);
  }

  session.activePlayer = new MusicPlayer(track, player, session, () => {
    session.activePlayer = null;
    player?.close('fim');
    if (session.player === player) session.player = null;
    session.current = null;
    if (!session.cancelled && session.queue.length > 0) void pumpQueue(session);
    else releaseEmptySession(session);
  });
  session.activePlayer.start();
}

function announce(text: string): void {
  controller.send({ t: Op.ChatSend, scope: ChatScope.Channel, targetId: 0, text });
}

function friendlyResolveError(query: string, raw: string): string {
  return `nao consegui resolver "${query}": ${raw}`;
}

/** Log do extrator/ffmpeg vem em spam de linhas repetitivas. Deixa so o essencial. */
function trimError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const last = lines[lines.length - 1] || raw;
  return last.length > 200 ? last.slice(0, 200) + '…' : last;
}

/**
 * O SoundCloud é a única fonte de busca do jukebox. O extrator ainda é o
 * binário yt-dlp por compatibilidade, mas não recebe cookies do YouTube.
 */
const soundCloudSearchPrefix = 'scsearch5:';

async function resolveTrack(query: string): Promise<ResolvedTrack> {
  if (isYouTubeUrl(query)) {
    throw new Error('links do YouTube não são suportados; use o SoundCloud');
  }

  // Arquivo local ou URL de arquivo (mp3/ogg/opus/m4a/wav/flac) vao direto pro
  // ffmpeg — nao precisam do extrator.
  if (looksDirectAudioFile(query)) return { source: 'direct', input: query, title: query };

  // Links de página aceitos: somente SoundCloud.
  if (/^https?:\/\//i.test(query)) {
    if (!isSoundCloudUrl(query)) throw new Error('link não suportado; use um link do SoundCloud ou pesquise pelo nome');
    return await resolveViaUrl(query);
  }

  try {
    return await resolveViaSoundCloud(query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[jukebox] SoundCloud falhou: ${msg.slice(0, 240)}`);
    throw new Error(`SoundCloud: ${trimError(err)}`);
  }
}

async function resolveViaUrl(url: string): Promise<ResolvedTrack> {
  const lines = await runCapture(extractorBin, [
    '--no-playlist',
    '-f', 'bestaudio',
    '--print', '%(title)s',
    url,
  ]);
  const title = lines.map((l) => l.trim()).find(Boolean) || url;
  return { source: 'extractor', input: url, title };
}

async function resolveViaSoundCloud(query: string): Promise<ResolvedTrack> {
  const lines = await runCapture(extractorBin, [
    '--flat-playlist',
    '--no-warnings',
    '--print', '%(webpage_url)s\t%(title)s',
    `${soundCloudSearchPrefix}${query}`,
  ]);
  const candidates = lines
    .map((line) => {
      const separator = line.indexOf('\t');
      return separator < 0
        ? { url: line.trim(), title: query }
        : { url: line.slice(0, separator).trim(), title: line.slice(separator + 1).trim() || query };
    })
    .filter((candidate) => isSoundCloudUrl(candidate.url));
  if (candidates.length === 0) throw new Error('nenhuma faixa encontrada no SoundCloud');

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      await runCapture(extractorBin, [
        '--no-playlist',
        '--no-warnings',
        '-f', 'bestaudio',
        '--simulate',
        '--print', '%(title)s',
        candidate.url,
      ]);
      return { source: 'extractor', input: candidate.url, title: candidate.title };
    } catch (err) {
      failures.push(`${candidate.title}: ${trimError(err)}`);
    }
  }
  throw new Error(`nenhuma faixa reproduzível no SoundCloud${failures.length ? ` (${failures[0]})` : ''}`);
}

/**
 * Arquivo local ou URL diretamente reproduzivel por ffmpeg (mp3/ogg/opus/etc).
 */
function looksDirectAudioFile(value: string): boolean {
  const audioExt = /\.(mp3|ogg|opus|m4a|aac|wav|flac|webm|mp4)(\?|#|$)/i;
  if (/^https?:\/\//i.test(value)) return audioExt.test(value);
  if (/^[a-z]:[\\/]/i.test(value)) return existsSync(value);
  // Path que existe no disco.
  if (value.includes('/') || value.includes('\\')) return existsSync(value);
  return false;
}

function isYouTubeUrl(value: string): boolean {
  return /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(value);
}

function isSoundCloudUrl(value: string): boolean {
  return /^https?:\/\/(?:www\.|m\.|on\.)?soundcloud\.com\//i.test(value);
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
  private rejectReady: ((reason?: unknown) => void) | null = null;
  private identity: Awaited<ReturnType<typeof createIdentity>> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly nickname: string,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onUnexpectedClose?: () => void,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
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
        const error = new Error(`${this.nickname}: conexão encerrada inesperadamente`);
        this.rejectReady?.(error);
        this.rejectReady = null;
        if (this.onUnexpectedClose) this.onUnexpectedClose();
        else {
          console.error(`[jukebox] ${this.nickname}: encerrando processo para systemd reiniciar limpo`);
          process.exit(1);
        }
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
    this.rejectReady?.(new Error(`${this.nickname}: ${reason}`));
    this.rejectReady = null;
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
  private extractor: ReturnType<typeof spawn> | null = null;
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
    private readonly session: ChannelSession,
    private readonly onDone: () => void,
  ) {}

  start(): void {
    // Fluxo: extrator do SoundCloud -> ffmpeg (transcode) -> Vox.
    const usingExtractor = this.track.source === 'extractor';
    let ffmpegInput = this.track.input;

    if (usingExtractor) {
      const extractor = spawn(extractorBin, [
        '--no-playlist',
        '-f', 'bestaudio',
        '-o', '-',
        '--no-warnings',
        '--quiet',
        this.track.input,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.extractor = extractor;
      extractor.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) console.error(`[soundcloud] ${text}`);
      });
      extractor.on('error', (err) => {
        announce(`nao consegui iniciar o extrator do SoundCloud: ${err.message}`);
        this.stop(false);
      });
      ffmpegInput = 'pipe:0';
    }

    // Corrente de audio:
    //  - dynaudnorm: normaliza dinamicamente (deixa musicas em volume parecido);
    //  - volume=<gain>: atenuacao final (musicas mixadas alto facil saturam
    //    Opus mesmo depois do dynaudnorm; -12dB deixa margem).
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
    ], { stdio: [usingExtractor ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ffmpeg;

    if (usingExtractor && this.extractor?.stdout && ffmpeg.stdin) {
      this.extractor.stdout.pipe(ffmpeg.stdin);
      // Se ffmpeg fechar antes do extrator terminar, EPIPE quebra o processo.
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
      if (c.channelId === myCh && c.id !== this.conn.selfId && c.id !== controller.selfId) listeners++;
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
      this.session.queue.length = 0; // limpa somente a fila deste canal
      this.session.cancelled = true;
      this.session.cancelVersion++;
      this.stop(false);
    }
  }

  stop(skipped: boolean): void {
    this.finished = true;
    if (this.ffmpeg) this.ffmpeg.kill('SIGTERM');
    this.ffmpeg = null;
    if (this.extractor) this.extractor.kill('SIGTERM');
    this.extractor = null;
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
