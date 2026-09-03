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
const bitrate = process.env['VOX_BOT_BITRATE'] || '96k';

interface TrackRequest {
  query: string;
  requestedBy: number;
  requestedByName: string;
  channelId: number;
}

interface ResolvedTrack {
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
  if (msg.scope !== ChatScope.Channel) return;
  if (msg.senderId === 0) return;
  if (msg.senderId === controller.selfId) return;
  // Server ja filtrou por canal (so entrega para membros do canal do remetente).
  // Confirma pela info local: o sender precisa estar no mesmo canal que o bot.
  const senderInfo = controller.clients.get(msg.senderId);
  if (!senderInfo || senderInfo.channelId !== controller.self?.channelId) return;

  const body = msg.text.trim();
  if (!body) return;

  const lower = body.toLowerCase();
  if (lower === 'fila' || lower === 'queue') {
    announce(queue.length ? queue.map((t, i) => `${i + 1}. ${t.query} - ${t.requestedByName}`).join('\n') : 'fila vazia');
    return;
  }
  if (lower === 'skip' || lower === 'pular') {
    if (!activePlayer) announce('nada tocando agora');
    else activePlayer.stop(true);
    return;
  }
  if (lower === 'stop' || lower === 'parar') {
    queue.length = 0;
    if (activePlayer) activePlayer.stop(true);
    announce('fila limpa');
    return;
  }

  const requester = controller.clients.get(msg.senderId);
  const channelId = requester?.channelId ?? 0;
  if (!channelId) {
    announce(`nao achei o canal de ${msg.senderName}`);
    return;
  }

  queue.push({ query: body, requestedBy: msg.senderId, requestedByName: msg.senderName, channelId });
  announce(activePlayer ? `adicionado na fila: ${body}` : `tocando agora: ${body}`);
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
    announce(`nao consegui resolver "${current.query}": ${String(err)}`);
    current = null;
    void pumpQueue();
    return;
  }

  player = new VoxConnection('music player', () => {});
  await player.connect();
  player.send({ t: Op.JoinChannel, channelId: current.channelId, password: '' });
  player.send({
    t: Op.ChatSend,
    scope: ChatScope.Channel,
    targetId: 0,
    text: `tocando: ${track.title} (pedido por ${current.requestedByName})`,
  });

  activePlayer = new MusicPlayer(track.input, player, () => {
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

async function resolveTrack(query: string): Promise<ResolvedTrack> {
  if (looksDirect(query)) return { input: query, title: query };

  const lines = await runCapture(ytdlpBin, [
    '--no-playlist',
    '-f', 'bestaudio',
    '--print', '%(title)s',
    '--get-url',
    `ytsearch1:${query}`,
  ]);
  const useful = lines.map((l) => l.trim()).filter(Boolean);
  const url = [...useful].reverse().find((line: string) => /^https?:\/\//i.test(line));
  if (!url) throw new Error(`instale yt-dlp ou envie uma URL direta`);
  const title = useful.find((line) => line !== url) || query;
  return { input: url, title };
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

class MusicPlayer {
  private readonly demux = new OggOpusDemuxer((packet) => this.queue.push(packet));
  private queue: Uint8Array[] = [];
  private ffmpeg: ReturnType<typeof spawn> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private finished = false;

  constructor(
    private readonly input: string,
    private readonly conn: VoxConnection,
    private readonly onDone: () => void,
  ) {}

  start(): void {
    const ffmpeg = spawn(ffmpegBin, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-re',
      '-i', this.input,
      '-vn',
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-application', 'audio',
      '-frame_duration', '20',
      '-b:a', bitrate,
      '-f', 'opus',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ffmpeg;

    ffmpeg.stdout.on('data', (chunk: Buffer) => this.demux.push(chunk));
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
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

    this.timer = setInterval(() => this.tick(), 20);
  }

  stop(skipped: boolean): void {
    this.finished = true;
    if (this.ffmpeg) this.ffmpeg.kill('SIGTERM');
    this.ffmpeg = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
    if (skipped) announce('pulando...');
    this.onDone();
  }

  private tick(): void {
    const packet = this.queue.shift();
    if (packet) {
      this.conn.sendVoice(packet, this.finished && this.queue.length === 0 ? VoiceFlags.EndOfTalk : VoiceFlags.None);
      return;
    }
    if (this.finished) this.stop(false);
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
