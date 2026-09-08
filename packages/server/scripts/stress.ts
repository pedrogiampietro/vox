/**
 * Carga controlada do protocolo Vox.
 *
 * Abre clientes WebSocket reais, conclui Hello/Challenge/Auth, coloca todos
 * no canal inicial, mede RTT de Ping/Pong e envia voz sintetica opcional.
 * Nao usa navegador, microfone ou identidades reais.
 *
 * Exemplos (PowerShell):
 *   npm run stress
 *   npm run stress -- --clients 50 --speakers 5 --duration 60
 *   $env:VOX_MAX_PER_IP='0'; npm run stress -- --clients 100
 *
 * Para um destino que nao seja local, defina STRESS_CONFIRM=1 de proposito.
 */

import { webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import {
  FailureCode,
  FrameKind,
  Op,
  PROTOCOL_VERSION,
  decodeServerMessage,
  decodeVoice,
  encodeClientMessage,
  encodeVoice,
} from '@vox/protocol';
import type { ClientMessage, ServerMessage } from '@vox/protocol';

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;
const DEFAULT_URL = process.env.VOX_URL ?? 'ws://127.0.0.1:9987/vox';

type Options = {
  url: string;
  clients: number;
  speakers: number;
  durationSec: number;
  voiceBytes: number;
  voiceProfile: 'continuous' | 'realistic';
  voiceTransport: 'ws' | 'quic' | 'auto';
  voiceIntervalMs: number;
  batch: number;
  adminUrl: string;
  adminToken: string;
};

type AdminRuntime = {
  processCpuPercent: number;
  hostCpuPercent: number;
  eventLoopLagMs: number;
  eventLoopLagP95Ms: number;
  memory: { rssBytes: number; systemUsedPercent: number };
  traffic: { inboundKbps: number; outboundKbps: number };
};

type StressSummary = {
  target: string;
  clientsRequested: number;
  clientsActive: number;
  socketsOpen: number;
  voiceSent: number;
  voiceReceived: number;
  rttMs: { p50: number; p95: number; p99: number; samples: number };
  failures: string[];
  adminRuntime: AdminRuntime | null;
  pass: boolean;
};

type WelcomeVoice = {
  voiceToken: Uint8Array;
  voiceHost: string;
  wtPort: number;
  wtCertHash: Uint8Array;
  voiceEdges: { host: string; port: number; region: string; certHash: Uint8Array }[];
};

type VoiceTransportLike = {
  ready: Promise<unknown>;
  createBidirectionalStream(): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;
  datagrams: {
    readable: ReadableStream<Uint8Array>;
    createWritable?: () => WritableStream<Uint8Array>;
    writable?: WritableStream<Uint8Array>;
  };
  close(): void;
};

/** Canal de voz QUIC do mesmo formato usado pelo cliente web. */
class VoiceLink {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(
    private readonly transport: VoiceTransportLike,
    datagrams: WritableStream<Uint8Array>,
    private readonly onVoice: () => void,
  ) {
    this.writer = datagrams.getWriter();
    void this.read();
  }

  send(seq: number, payload: Uint8Array): void {
    void this.writer.write(encodeVoice(seq, 0, payload)).catch(() => {});
  }

  close(): void {
    this.transport.close();
  }

  private async read(): Promise<void> {
    const reader = this.transport.datagrams.readable.getReader();
    try {
      for (;;) {
        const packet = await reader.read();
        if (packet.done || !packet.value) return;
        if (decodeVoice(packet.value)) this.onVoice();
      }
    } catch {
      // Fechamento ou perda do edge; o resumo mostra a diferença de pacotes.
    }
  }
}

const options = parseOptions();
const runId = Math.random().toString(36).slice(2, 8);
const failures: string[] = [];

interface Identity {
  spki: Uint8Array;
  key: CryptoKey;
}

async function newIdentity(): Promise<Identity> {
  const pair = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  return { spki, key: pair.privateKey };
}

class StressClient {
  readonly ws: WebSocket;
  readonly latencies: number[] = [];
  readonly protocolFailures: { code: FailureCode; message: string }[] = [];
  connected = false;
  live = false;
  id = 0;
  sentVoice = 0;
  receivedVoice = 0;
  private readonly requestedVoiceTransport: 'ws' | 'quic' | 'auto';
  private welcome: WelcomeVoice | null = null;
  private voiceLink: VoiceLink | null = null;
  private identity: Identity | null = null;
  private readonly opened: Promise<void>;

  constructor(readonly nickname: string, url: string, voiceTransport: 'ws' | 'quic' | 'auto') {
    this.requestedVoiceTransport = voiceTransport;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';
    this.opened = new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        this.connected = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        this.ws.off('open', onOpen);
        this.ws.off('error', onError);
      };
      this.ws.once('open', onOpen);
      this.ws.once('error', onError);
    });
    this.ws.on('message', (data: Buffer) => this.receive(new Uint8Array(data)));
    this.ws.on('error', (error) => {
      this.protocolFailures.push({ code: FailureCode.Malformed, message: error.message });
    });
  }

  async start(): Promise<void> {
    await withTimeout(this.opened, 10_000, 'abertura do WebSocket');
    this.identity = await newIdentity();
    this.send({
      t: Op.Hello,
      version: PROTOCOL_VERSION,
      nickname: this.nickname,
      password: '',
      publicKey: this.identity.spki,
      platform: 'stress',
    });
    await until(() => this.live, 10_000, 'handshake');
  }

  private receive(frame: Uint8Array): void {
    if (frame[0] === FrameKind.Voice) {
      if (decodeVoice(frame)) this.receivedVoice++;
      return;
    }
    try {
      this.apply(decodeServerMessage(frame));
    } catch (error) {
      this.protocolFailures.push({
        code: FailureCode.Malformed,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private apply(message: ServerMessage): void {
    switch (message.t) {
      case Op.Challenge:
        void this.answer(message.nonce);
        break;
      case Op.Welcome:
        this.id = message.clientId;
        this.welcome = message;
        break;
      case Op.Snapshot:
        this.live = this.id > 0 && message.clients.some((client) => client.id === this.id);
        break;
      case Op.Pong:
        this.latencies.push(Math.max(0, Date.now() - message.stamp));
        break;
      case Op.Failure:
        this.protocolFailures.push({ code: message.code, message: message.message });
        break;
    }
  }

  private async answer(nonce: Uint8Array): Promise<void> {
    if (!this.identity) return;
    const signature = new Uint8Array(await webcrypto.subtle.sign(SIGN_ALGORITHM, this.identity.key, nonce));
    this.send({ t: Op.Auth, signature });
  }

  send(message: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeClientMessage(message));
  }

  ping(): void {
    if (this.live) this.send({ t: Op.Ping, stamp: Date.now() });
  }

  sendVoice(seq: number, payload: Uint8Array): void {
    if (!this.live || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.requestedVoiceTransport === 'quic' && !this.voiceLink) return;
    if (this.voiceLink) {
      this.voiceLink.send(seq, payload);
    } else {
      this.ws.send(encodeVoice(seq, 0, payload));
    }
    this.sentVoice++;
  }

  async openVoiceLink(): Promise<boolean> {
    const welcome = this.welcome;
    if (!welcome) return false;
    const candidate = welcome.voiceEdges.find((edge) => edge.host && edge.port > 0)
      ?? (welcome.voiceHost && welcome.wtPort > 0
        ? { host: welcome.voiceHost, port: welcome.wtPort, region: welcome.voiceHost, certHash: welcome.wtCertHash }
        : null);
    if (!candidate) return false;

    let transport: VoiceTransportLike | null = null;
    try {
      const mod = await import('@fails-components/webtransport');
      await mod.quicheLoaded;
      const init = candidate.certHash.length > 0
        ? { serverCertificateHashes: [{ algorithm: 'sha-256' as const, value: candidate.certHash }] }
        : {};
      transport = new mod.WebTransport(`https://${candidate.host}:${candidate.port}/vox`, init) as VoiceTransportLike;
      await withTimeout(transport.ready, 10_000, `WebTransport ${candidate.host}`);

      const stream = await withTimeout(transport.createBidirectionalStream(), 5_000, 'handshake WebTransport');
      const streamWriter = stream.writable.getWriter();
      await streamWriter.write(welcome.voiceToken);
      const reply = await withTimeout(stream.readable.getReader().read(), 5_000, 'resposta WebTransport');
      if (reply.value?.[0] !== 1) throw new Error('edge recusou a sessão de voz');

      const datagrams = transport.datagrams.createWritable
        ? transport.datagrams.createWritable()
        : transport.datagrams.writable;
      if (!datagrams) throw new Error('edge sem escrita de datagramas');
      this.voiceLink = new VoiceLink(transport, datagrams, () => this.receivedVoice++);
      return true;
    } catch (error) {
      transport?.close();
      if (this.requestedVoiceTransport === 'quic') {
        this.protocolFailures.push({
          code: FailureCode.Malformed,
          message: `QUIC: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return false;
    }
  }

  get voiceTransport(): 'ws' | 'quic' {
    return this.voiceLink ? 'quic' : 'ws';
  }

  async close(): Promise<void> {
    this.voiceLink?.close();
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.ws.once('close', finish);
      this.ws.close();
      const timeout = setTimeout(() => {
        this.ws.terminate();
        finish();
      }, 1500);
      timeout.unref?.();
    });
  }
}

async function main(): Promise<void> {
  ensureSafeTarget(options.url);
  console.log(`stress target=${options.url}`);
  console.log(`clientes=${options.clients} · speakers=${options.speakers} · duracao=${options.durationSec}s · voz=${options.voiceBytes}B/${options.voiceIntervalMs}ms · perfil=${options.voiceProfile} · transporte=${options.voiceTransport}`);
  if (options.clients > 8) {
    console.log('aviso: confirme que a instancia permite essa quantidade por IP (VOX_MAX_PER_IP); o padrao e 8');
  }

  const clients = Array.from({ length: options.clients }, (_, index) => (
    new StressClient(`stress-${runId}-${index + 1}`, options.url, options.voiceTransport)
  ));
  let adminRuntime: AdminRuntime | null = null;
  const pollAdmin = async (): Promise<void> => {
    if (!options.adminToken) return;
    try {
      const response = await fetch(options.adminUrl, {
        headers: { authorization: `Bearer ${options.adminToken}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { runtime?: AdminRuntime | null };
      adminRuntime = body.runtime ?? null;
    } catch (error) {
      if (!failures.some((failure) => failure.startsWith('admin:'))) {
        failures.push(`admin: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const adminTimer = options.adminToken
    ? setInterval(() => void pollAdmin(), 3000)
    : null;
  adminTimer?.unref?.();
  try {
    for (let offset = 0; offset < clients.length; offset += options.batch) {
      const batch = clients.slice(offset, offset + options.batch);
      await Promise.all(batch.map(async (client) => {
        try {
          await client.start();
        } catch (error) {
          failures.push(`${client.nickname}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
      console.log(`conexao ${Math.min(offset + options.batch, clients.length)}/${clients.length} · ativos=${clients.filter((client) => client.live).length}`);
    }

    await pollAdmin();
    if (options.voiceTransport !== 'ws') {
      const voiceClients = clients.filter((client) => client.live);
      const opened = await Promise.all(voiceClients.map((client) => client.openVoiceLink()));
      const quicClients = voiceClients.filter((client) => client.voiceTransport === 'quic').length;
      console.log(`voz QUIC: ${quicClients}/${voiceClients.length} conexões`);
      if (options.voiceTransport === 'quic' && quicClients !== voiceClients.length) {
        failures.push(`QUIC abriu em ${quicClients}/${voiceClients.length} clientes`);
      }
      if (options.voiceTransport === 'auto' && opened.every((value) => !value)) {
        console.log('voz QUIC indisponível; seguindo pelo WebSocket');
      }
    }
    const speakers = clients.filter((client) => client.live).slice(0, options.speakers);
    let sequence = 0;
    const voiceStops = speakers.map((speaker, index) => {
      let speakerSequence = sequence + index;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const sendNext = (): void => {
        const size = options.voiceProfile === 'realistic'
          ? realisticVoiceBytes(options.voiceBytes)
          : options.voiceBytes;
        const voicePayload = new Uint8Array(size);
        for (let offset = 0; offset < voicePayload.length; offset++) {
          voicePayload[offset] = (speakerSequence + offset * 31 + index * 17) & 0xff;
        }
        speaker.sendVoice(speakerSequence, voicePayload);
        speakerSequence++;
        sequence = Math.max(sequence, speakerSequence);
        const jitter = options.voiceProfile === 'realistic' ? Math.floor(Math.random() * 5) : 0;
        timer = setTimeout(sendNext, options.voiceIntervalMs + jitter);
        timer.unref?.();
      };
      timer = setTimeout(sendNext, Math.floor((index * options.voiceIntervalMs) / Math.max(1, speakers.length)));
      timer.unref?.();
      return (): void => {
        if (timer) clearTimeout(timer);
      };
    });
    const pingTimer = setInterval(() => {
      for (const client of clients) client.ping();
    }, 5000);
    try {
      await delay(options.durationSec * 1000);
    } finally {
      for (const stop of voiceStops) stop();
      clearInterval(pingTimer);
    }
    await pollAdmin();
  } finally {
    if (adminTimer) clearInterval(adminTimer);
    await Promise.all(clients.map((client) => client.close()));
  }

  for (const client of clients) {
    for (const failure of client.protocolFailures) {
      failures.push(`${client.nickname}: ${failure.message}`);
    }
  }
  if (!printSummary(clients, adminRuntime)) process.exitCode = 1;
}

function printSummary(clients: StressClient[], adminRuntime: AdminRuntime | null): boolean {
  const connected = clients.filter((client) => client.connected).length;
  const live = clients.filter((client) => client.live).length;
  const latencies = clients.flatMap((client) => client.latencies);
  const sentVoice = clients.reduce((sum, client) => sum + client.sentVoice, 0);
  const receivedVoice = clients.reduce((sum, client) => sum + client.receivedVoice, 0);
  const performanceFailures: string[] = [];
  const maxRttP95Ms = boundedNumber(process.env.STRESS_MAX_RTT_P95_MS, 250, 1, 60_000);
  const maxEventLoopP95Ms = boundedNumber(process.env.STRESS_MAX_EVENT_LOOP_P95_MS, 100, 1, 60_000);
  const rttP95 = percentile(latencies, 0.95);
  if (latencies.length > 0 && rttP95 > maxRttP95Ms) {
    performanceFailures.push(`RTT p95 acima do limite (${formatMs(rttP95)} > ${maxRttP95Ms}ms)`);
  }
  if (adminRuntime && adminRuntime.eventLoopLagMs > maxEventLoopP95Ms) {
    performanceFailures.push(`event loop atual acima do limite (${formatMs(adminRuntime.eventLoopLagMs)} > ${maxEventLoopP95Ms}ms)`);
  }
  const summaryFailures = [...failures, ...performanceFailures];
  const summary: StressSummary = {
    target: options.url,
    clientsRequested: clients.length,
    clientsActive: live,
    socketsOpen: connected,
    voiceSent: sentVoice,
    voiceReceived: receivedVoice,
    rttMs: {
      p50: percentile(latencies, 0.50),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      samples: latencies.length,
    },
    failures: summaryFailures,
    adminRuntime,
    pass: summaryFailures.length === 0 && live === clients.length,
  };
  console.log('\nresultado');
  console.log(`  clientes: ${live}/${clients.length} ativos (${connected} sockets abertos)`);
  console.log(`  voz: ${sentVoice} enviados · ${receivedVoice} recebidos`);
  console.log(`  RTT: ${latencies.length > 0 ? `p50 ${formatMs(summary.rttMs.p50)} · p95 ${formatMs(summary.rttMs.p95)} · p99 ${formatMs(summary.rttMs.p99)}` : 'sem amostras'}`);
  if (adminRuntime) {
    console.log(`  servidor: CPU ${adminRuntime.processCpuPercent.toFixed(1)}% (core · ${adminRuntime.hostCpuPercent.toFixed(1)}% host) · RSS ${formatBytes(adminRuntime.memory.rssBytes)} · RAM ${adminRuntime.memory.systemUsedPercent.toFixed(1)}% · banda ${adminRuntime.traffic.inboundKbps.toFixed(1)}/${adminRuntime.traffic.outboundKbps.toFixed(1)} kbps · loop p95 ${adminRuntime.eventLoopLagP95Ms.toFixed(1)}ms`);
  } else {
    console.log('  servidor: passe STRESS_ADMIN_TOKEN para incluir CPU, RAM, banda e event loop');
  }
  for (const failure of summaryFailures.slice(0, 12)) console.log(`  falha: ${failure}`);
  if (summaryFailures.length > 12) console.log(`  ... mais ${summaryFailures.length - 12} falhas`);
  console.log(summary.pass ? '\nPASS' : '\nFAIL');
  if (process.env.STRESS_JSON_OUT) {
    writeFileSync(process.env.STRESS_JSON_OUT, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
  return summary.pass;
}

function parseOptions(): Options {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Uso: npm run stress -- [--clients N] [--speakers N] [--duration SEC] [--url WS_URL] [--voice-profile continuous|realistic] [--voice-transport ws|quic|auto]');
    console.log('Env: STRESS_ADMIN_TOKEN, STRESS_ADMIN_URL, STRESS_CONFIRM=1, STRESS_VOICE_BYTES, STRESS_VOICE_INTERVAL_MS, STRESS_VOICE_PROFILE, STRESS_VOICE_TRANSPORT, STRESS_MAX_RTT_P95_MS, STRESS_MAX_EVENT_LOOP_P95_MS');
    process.exit(0);
  }
  return {
    url: argument('--url') ?? process.env.STRESS_URL ?? DEFAULT_URL,
    clients: boundedNumber(argument('--clients') ?? process.env.STRESS_CLIENTS, 8, 1, 2000),
    speakers: boundedNumber(argument('--speakers') ?? process.env.STRESS_SPEAKERS, 2, 0, 2000),
    durationSec: boundedNumber(argument('--duration') ?? process.env.STRESS_DURATION_SEC, 30, 1, 3600),
    voiceBytes: boundedNumber(process.env.STRESS_VOICE_BYTES, 96, 1, 512),
    voiceProfile: (argument('--voice-profile') ?? process.env.STRESS_VOICE_PROFILE) === 'realistic' ? 'realistic' : 'continuous',
    voiceTransport: parseVoiceTransport(argument('--voice-transport') ?? process.env.STRESS_VOICE_TRANSPORT),
    voiceIntervalMs: boundedNumber(process.env.STRESS_VOICE_INTERVAL_MS, 20, 10, 1000),
    batch: boundedNumber(process.env.STRESS_BATCH, 25, 1, 100),
    adminUrl: argument('--admin-url')
      ?? process.env.STRESS_ADMIN_URL
      ?? adminUrlFor(argument('--url') ?? process.env.STRESS_URL ?? DEFAULT_URL),
    adminToken: argument('--admin-token') ?? process.env.STRESS_ADMIN_TOKEN ?? '',
  };
}

function parseVoiceTransport(raw: string | undefined): 'ws' | 'quic' | 'auto' {
  if (raw === 'quic' || raw === 'auto') return raw;
  return 'ws';
}

function realisticVoiceBytes(base: number): number {
  const jitter = Math.max(8, Math.min(64, Math.round(base * 0.5)));
  const lower = Math.max(1, base - jitter);
  const upper = Math.min(512, base + jitter);
  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`numero invalido: ${raw}`);
  return Math.round(Math.max(min, Math.min(max, value)));
}

function adminUrlFor(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/overview';
  url.search = '';
  return url.toString();
}

function ensureSafeTarget(wsUrl: string): void {
  const hostname = new URL(wsUrl).hostname;
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (!local && process.env.STRESS_CONFIRM !== '1') {
    throw new Error('destino remoto bloqueado; defina STRESS_CONFIRM=1 para confirmar a carga');
  }
}

async function until(ready: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await delay(20);
  }
  throw new Error(`${label} nao terminou em ${timeoutMs}ms`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} nao terminou em ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], rank: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * rank) - 1));
  return sorted[index] ?? 0;
}

function formatMs(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}ms`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0] ?? 'KB';
  for (let index = 1; value >= 1024 && index < units.length; index++) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}${unit}`;
}

void main().catch((error) => {
  console.error(`stress falhou: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
