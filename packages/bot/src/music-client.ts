import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import {
  ChannelFlags,
  FrameKind,
  Op,
  PROTOCOL_VERSION,
  VoiceFlags,
  encodeClientMessage,
  encodeVoice,
  decodeServerMessage,
} from '@vox/protocol';
import type { ChannelInfo, ServerMessage } from '@vox/protocol';

const FRAME_MS = 20;
const DEFAULT_ADDRESS = 'ws://127.0.0.1:9987/vox';

const source = process.argv[2];
if (!source) {
  console.error('uso: npm run music-bot --workspace=@vox/bot -- <url-ou-arquivo>');
  process.exit(1);
}

const address = process.env['VOX_BOT_ADDRESS'] || DEFAULT_ADDRESS;
const nickname = process.env['VOX_BOT_NICK'] || 'music';
const password = process.env['VOX_BOT_PASSWORD'] || '';
const channelName = process.env['VOX_BOT_CHANNEL'] || '';
const channelId = Number(process.env['VOX_BOT_CHANNEL_ID'] || 0);
const ffmpegBin = process.env['VOX_FFMPEG'] || 'ffmpeg';

const identity = await createIdentity();
const ws = new WebSocket(address);
ws.binaryType = 'arraybuffer';

let selfId = 0;
let seq = 0;
let channels: ChannelInfo[] = [];
let player: MusicPlayer | null = null;

ws.on('open', () => {
  send({
    t: Op.Hello,
    version: PROTOCOL_VERSION,
    nickname,
    password,
    publicKey: identity.publicKey,
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
  void handle(msg);
});

ws.on('close', (_code, reason) => {
  player?.stop();
  console.log(`[music] desconectado ${reason.toString()}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('[music] websocket:', err.message);
});

async function handle(msg: ServerMessage): Promise<void> {
  switch (msg.t) {
    case Op.Challenge:
      send({ t: Op.Auth, signature: await identity.sign(msg.nonce) });
      break;
    case Op.Welcome:
      selfId = msg.clientId;
      console.log(`[music] conectado como #${selfId} em ${msg.serverName}`);
      break;
    case Op.Snapshot:
      channels = msg.channels;
      joinConfiguredChannel();
      player ??= new MusicPlayer(source!, sendVoice);
      player.start();
      break;
    case Op.ChannelAdd:
    case Op.ChannelUpdate:
      channels = channels.filter((c) => c.id !== msg.channel.id).concat(msg.channel);
      break;
    case Op.Failure:
      console.error(`[music] erro do servidor: ${msg.message}`);
      break;
  }
}

function joinConfiguredChannel(): void {
  const targetId = channelId || findChannelId(channelName);
  if (targetId > 0) send({ t: Op.JoinChannel, channelId: targetId, password: '' });
}

function findChannelId(name: string): number {
  if (name) {
    const found = channels.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
  }
  return channels.find((c) => (c.flags & ChannelFlags.Default) !== 0)?.id ?? channels[0]?.id ?? 0;
}

function send(msg: Parameters<typeof encodeClientMessage>[0]): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(encodeClientMessage(msg));
}

function sendVoice(payload: Uint8Array, flags: number = VoiceFlags.None): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(encodeVoice(seq, flags, payload));
  seq = (seq + 1) & 0xffff;
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

class MusicPlayer {
  private readonly demux = new OggOpusDemuxer((packet) => this.queue.push(packet));
  private queue: Uint8Array[] = [];
  private ffmpeg: ReturnType<typeof spawn> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private finished = false;

  constructor(
    private readonly input: string,
    private readonly sendPacket: (payload: Uint8Array, flags?: number) => void,
  ) {}

  start(): void {
    if (this.ffmpeg) return;
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
      '-frame_duration', String(FRAME_MS),
      '-b:a', process.env['VOX_BOT_BITRATE'] || '96k',
      '-f', 'opus',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ffmpeg;

    ffmpeg.stdout.on('data', (chunk: Buffer) => this.demux.push(chunk));
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[ffmpeg] ${text}`);
    });
    ffmpeg.on('close', (code) => {
      this.finished = true;
      console.log(`[music] ffmpeg finalizou (${code ?? 0})`);
    });
    ffmpeg.on('error', (err) => {
      console.error(`[music] nao consegui iniciar ffmpeg (${ffmpegBin}): ${err.message}`);
      this.finished = true;
    });

    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ffmpeg?.kill('SIGTERM');
    this.ffmpeg = null;
    this.queue.length = 0;
  }

  private tick(): void {
    const packet = this.queue.shift();
    if (packet) {
      this.sendPacket(packet, this.finished && this.queue.length === 0 ? VoiceFlags.EndOfTalk : VoiceFlags.None);
      return;
    }
    if (this.finished) {
      this.stop();
      ws.close(1000, 'musica finalizada');
    }
  }
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
