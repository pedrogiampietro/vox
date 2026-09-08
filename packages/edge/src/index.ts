/**
 * Edge regional de voz do Vox.
 *
 * O controle e a autoridade continuam na origem. Este processo termina
 * WebTransport perto dos usuarios, distribui voz entre clientes locais e
 * replica cada frame para a origem por um link WebSocket privado.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import {
  ChannelFlags,
  ClientFlags,
  FrameKind,
  Group,
  MAX_VOICE_PACKET,
  NO_CHANNEL,
  VOICE_PROBE_MAGIC,
  VOICE_TOKEN_BYTES,
  decodeVoice,
  stampSender,
} from '@vox/protocol';

const EDGE_ACCEPT = 0xf0;
const EDGE_STATE = 0xf1;
const EDGE_REJECT = 0xf2;

loadEnv();

const port = number('VOX_EDGE_WT_PORT', 9987);
const host = string('VOX_EDGE_WT_HOST', '0.0.0.0');
const certPath = string('VOX_EDGE_CERT', '');
const keyPath = string('VOX_EDGE_KEY', '');
const originUrl = string('VOX_EDGE_ORIGIN', 'wss://server-1.v0x.online/internal/edge');
const secret = string('VOX_EDGE_SECRET', '');
/** Nome estável deste edge, usado para a origem evitar eco regional. */
const edgeId = string('VOX_EDGE_ID', '');

if (!certPath || !keyPath || !existsSync(certPath) || !existsSync(keyPath)) {
  throw new Error('VOX_EDGE_CERT/VOX_EDGE_KEY ausentes ou inexistentes');
}
if (!secret) throw new Error('VOX_EDGE_SECRET ausente');

class EdgeRouter {
  private readonly channelClients = new Map<number, Set<EdgeClient>>();
  private readonly indexedChannel = new Map<EdgeClient, number>();
  private readonly localEchoes = new Map<string, number>();

  add(client: EdgeClient): void {
    this.updateChannel(client, client.channelId);
  }

  remove(client: EdgeClient): void {
    const previous = this.indexedChannel.get(client);
    if (previous !== undefined) this.channelClients.get(previous)?.delete(client);
    this.indexedChannel.delete(client);
  }

  updateChannel(client: EdgeClient, channelId: number): void {
    const previous = this.indexedChannel.get(client);
    if (previous === channelId) return;
    if (previous !== undefined) {
      const oldMembers = this.channelClients.get(previous);
      oldMembers?.delete(client);
      if (oldMembers?.size === 0) this.channelClients.delete(previous);
    }
    this.indexedChannel.delete(client);
    if (channelId === NO_CHANNEL) return;
    const members = this.channelClients.get(channelId) ?? new Set<EdgeClient>();
    members.add(client);
    this.channelClients.set(channelId, members);
    this.indexedChannel.set(client, channelId);
  }

  markLocalEcho(clientId: number, seq: number): void {
    this.pruneEchoes(Date.now());
    this.localEchoes.set(`${clientId}:${seq}`, Date.now() + 1500);
  }

  isLocalEcho(clientId: number, seq: number): boolean {
    const expires = this.localEchoes.get(`${clientId}:${seq}`) ?? 0;
    if (expires < Date.now()) {
      this.localEchoes.delete(`${clientId}:${seq}`);
      return false;
    }
    return true;
  }

  broadcastLocal(sender: EdgeClient, frame: Uint8Array): void {
    if (sender.channelId === NO_CHANNEL) return;
    const peers = this.channelClients.get(sender.channelId);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === sender) continue;
      if (peer.clientFlags & ClientFlags.MutedSpeakers) continue;
      peer.sendToBrowser(frame);
    }
  }

  private pruneEchoes(now: number): void {
    for (const [key, expires] of this.localEchoes) {
      if (expires < now) this.localEchoes.delete(key);
    }
  }
}

const Http3Server = (await import('@fails-components/webtransport')).Http3Server;
const http3 = new Http3Server({
  port,
  host,
  secret: randomBytes(32).toString('hex'),
  cert: readFileSync(certPath, 'utf8'),
  privKey: readFileSync(keyPath, 'utf8'),
  defaultDatagramsReadableMode: 'bytes',
});
const router = new EdgeRouter();

http3.startServer();
await http3.ready;
console.log(`[vox-edge] WebTransport ouvindo em udp/${port} (${host})`);
console.log(`[vox-edge] origem: ${originUrl}`);
void acceptLoop(http3.sessionStream('/vox'), router);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('[vox-edge] encerrando...');
    http3.stopServer();
    process.exit(0);
  });
}

class EdgeClient {
  channelId = NO_CHANNEL;
  channelFlags = 0;
  clientFlags = 0;
  group = Group.Guest;

  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private inflight = 0;
  private closed = false;

  constructor(
    private readonly session: WTSession,
    private readonly tokenStream: TokenStream,
    private readonly link: OriginLink,
    private readonly router: EdgeRouter,
    readonly clientId: number,
  ) {
    const datagrams = session.datagrams.createWritable
      ? session.datagrams.createWritable()
      : session.datagrams.writable!;
    this.writer = datagrams.getWriter();
  }

  applyState(state: VoiceState): void {
    this.channelId = state.channelId;
    this.channelFlags = state.channelFlags;
    this.clientFlags = state.clientFlags;
    this.group = state.group as Group;
    this.router.updateChannel(this, this.channelId);
  }

  canSpeak(): boolean {
    if (this.closed || this.channelId === NO_CHANNEL) return false;
    if (this.clientFlags & ClientFlags.MutedMic) return false;
    return !(this.channelFlags & ChannelFlags.Moderated) ||
      this.group >= Group.Moderator ||
      Boolean(this.clientFlags & ClientFlags.HasVoice);
  }

  sendVoice(frame: Uint8Array): void {
    if (this.closed) return;
    this.link.send(frame);
  }

  sendToBrowser(frame: Uint8Array): void {
    if (this.closed || this.inflight >= 8) return;
    this.inflight++;
    this.writer.write(frame).then(
      () => { this.inflight--; },
      () => { this.inflight--; this.close(); },
    );
  }

  onOriginVoice(frame: Uint8Array): void {
    const packet = decodeVoice(frame);
    if (!packet) return;
    if (this.router.isLocalEcho(packet.clientId, packet.seq)) return;
    this.sendToBrowser(frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.router.remove(this);
    this.link.close();
    try { this.writer.close(); } catch { /* ja fechando */ }
    try { this.session.close(); } catch { /* ja fechada */ }
  }
}

class OriginLink {
  private readonly ws: WebSocket;
  private readonly acceptedPromise: Promise<AcceptedState>;
  private resolveAccepted!: (value: AcceptedState) => void;
  private rejectAccepted!: (reason: Error) => void;
  private accepted = false;
  private client: EdgeClient | null = null;
  private readonly pending: Uint8Array[] = [];

  constructor(token: Uint8Array) {
    this.acceptedPromise = new Promise<AcceptedState>((resolve, reject) => {
      this.resolveAccepted = resolve;
      this.rejectAccepted = reject;
    });
    this.ws = new WebSocket(originUrl, {
      headers: {
        'x-vox-edge-secret': secret,
        ...(edgeId ? { 'x-vox-edge-id': edgeId } : {}),
      },
      handshakeTimeout: 5000,
    });
    const timeout = setTimeout(() => this.rejectAccepted(new Error('origem nao respondeu')), 6000);
    timeout.unref();
    this.ws.binaryType = 'nodebuffer';
    this.ws.once('open', () => this.ws.send(token, { binary: true }));
    this.ws.on('message', (data, isBinary) => {
      if (!isBinary) return this.fail(new Error('origem enviou texto'));
      const frame = toBytes(data);
      if (!this.accepted) {
        const state = decodeAccepted(frame);
        if (!state) return this.fail(new Error('origem recusou o edge'));
        this.accepted = true;
        clearTimeout(timeout);
        this.resolveAccepted(state);
        return;
      }
      if (frame[0] === EDGE_STATE) {
        const state = decodeState(frame);
        if (state) this.client?.applyState(state);
        return;
      }
      if (frame[0] === FrameKind.Voice) {
        if (this.client) this.client.onOriginVoice(frame);
        else this.pending.push(frame);
      }
    });
    this.ws.on('close', () => {
      if (!this.accepted) this.fail(new Error('link com a origem fechou'));
      this.client?.close();
    });
    this.ws.on('error', (err) => {
      if (!this.accepted) this.fail(err);
      this.client?.close();
    });
  }

  async waitAccepted(): Promise<AcceptedState> {
    return this.acceptedPromise;
  }

  setClient(client: EdgeClient): void {
    this.client = client;
    for (const frame of this.pending.splice(0)) client.onOriginVoice(frame);
  }

  send(frame: Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(frame, { binary: true });
  }

  close(): void {
    try { this.ws.close(); } catch { this.ws.terminate(); }
  }

  private fail(err: Error): void {
    if (!this.accepted) this.rejectAccepted(err);
    this.close();
  }
}

async function serve(session: WTSession, router: EdgeRouter): Promise<void> {
  await session.ready;
  const token = await readToken(session);
  if (!token) return closeSession(session);

  const link = new OriginLink(token.value);
  let accepted: AcceptedState;
  try {
    accepted = await link.waitAccepted();
  } catch {
    return closeSession(session);
  }

  const client = new EdgeClient(session, token, link, router, accepted.clientId);
  client.applyState(accepted);
  link.setClient(client);
  router.add(client);
  void echoProbeStreams(session);
  await token.reply(1);

  void session.closed.then(() => client.close(), () => client.close());
  const reader = session.datagrams.readable.getReader();
  for (;;) {
    let frame: Uint8Array | undefined;
    try {
      const chunk = await reader.read();
      if (chunk.done) break;
      frame = chunk.value;
    } catch {
      break;
    }
    if (!frame || frame.length > MAX_VOICE_PACKET || frame[0] !== FrameKind.Voice) continue;
    if (!client.canSpeak()) continue;
    const packet = decodeVoice(frame);
    if (!packet) continue;

    const stamped = frame.slice();
    stampSender(stamped, client.clientId);
    router.markLocalEcho(client.clientId, packet.seq);
    router.broadcastLocal(client, stamped);
    client.sendVoice(frame);
  }
  client.close();
}

async function acceptLoop(sessions: ReadableStream<unknown>, router: EdgeRouter): Promise<void> {
  const reader = sessions.getReader();
  for (;;) {
    try {
      const { done, value } = await reader.read();
      if (done) return;
      void serve(value as WTSession, router).catch((err) => {
        console.error('[vox-edge] sessao encerrada:', String(err));
      });
    } catch (err) {
      console.error('[vox-edge] laco de sessoes parou:', String(err));
      return;
    }
  }
}

async function echoProbeStreams(session: WTSession): Promise<void> {
  const streams = session.incomingBidirectionalStreams.getReader();
  try {
    for (;;) {
      const next = await streams.read();
      if (next.done || !next.value) return;
      void echoProbeStream(next.value).catch(() => {});
    }
  } catch {
    // A sessao fechou junto com o transporte principal.
  } finally {
    streams.releaseLock();
  }
}

async function echoProbeStream(stream: {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}): Promise<void> {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  try {
    const first = await reader.read();
    if (first.done || !first.value || first.value[0] !== VOICE_PROBE_MAGIC) return;
    await writer.write(first.value);
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done || !chunk.value) return;
      await writer.write(chunk.value);
    }
  } finally {
    try { await writer.close(); } catch { /* cliente sumiu */ }
  }
}

interface WTSession {
  ready: Promise<unknown>;
  closed: Promise<unknown>;
  close(info?: { closeCode?: number; reason?: string }): void;
  datagrams: {
    readable: ReadableStream<Uint8Array>;
    createWritable?: () => WritableStream<Uint8Array>;
    writable?: WritableStream<Uint8Array>;
  };
  incomingBidirectionalStreams: ReadableStream<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;
}

interface TokenStream {
  value: Uint8Array;
  reply(byte: number): Promise<void>;
}

interface VoiceState {
  channelId: number;
  channelFlags: number;
  clientFlags: number;
  group: number;
}

interface AcceptedState extends VoiceState {
  clientId: number;
}

async function readToken(session: WTSession): Promise<TokenStream | null> {
  const streams = session.incomingBidirectionalStreams.getReader();
  try {
    const first = await withTimeout(streams.read(), 5000);
    if (first?.done || !first?.value) return null;
    const stream = first.value;
    const reader = stream.readable.getReader();
    const token = new Uint8Array(VOICE_TOKEN_BYTES);
    let filled = 0;
    while (filled < token.length) {
      const chunk = await withTimeout(reader.read(), 5000);
      if (!chunk || chunk.done || !chunk.value) return null;
      const take = Math.min(token.length - filled, chunk.value.length);
      token.set(chunk.value.subarray(0, take), filled);
      filled += take;
    }
    return {
      value: token,
      async reply(byte) {
        const writer = stream.writable.getWriter();
        try {
          await writer.write(new Uint8Array([byte]));
          await writer.close();
        } catch { /* cliente sumiu */ }
      },
    };
  } finally {
    streams.releaseLock();
  }
}

function decodeAccepted(frame: Uint8Array): AcceptedState | null {
  if (frame.length < 8 || frame[0] !== EDGE_ACCEPT) return null;
  const state = decodeState(frame, 1);
  return state ? { clientId: readU16(frame, 1), ...state } : null;
}

function decodeState(frame: Uint8Array, offset = 1): VoiceState | null {
  if (frame.length < offset + 7) return null;
  return {
    channelId: readU16(frame, offset + 2),
    channelFlags: frame[offset + 4]!,
    clientFlags: frame[offset + 5]!,
    group: frame[offset + 6]!,
  };
}

function readU16(frame: Uint8Array, offset: number): number {
  return frame[offset]! | (frame[offset + 1]! << 8);
}

function closeSession(session: WTSession): void {
  try { session.close(); } catch { /* ja fechada */ }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try { return await Promise.race([work, guard]); }
  catch { return null; }
  finally { clearTimeout(timer); }
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function loadEnv(): void {
  for (const path of ['/etc/vox-edge.env', '.env']) {
    try {
      const text = readFileSync(path, 'utf8');
      for (const line of text.split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (/^[A-Z_][A-Z0-9_]*$/.test(key) && !(key in process.env)) {
          process.env[key] = line.slice(eq + 1).trim();
        }
      }
      return;
    } catch { /* tenta o proximo */ }
  }
}

function string(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function number(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
