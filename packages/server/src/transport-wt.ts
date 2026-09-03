/**
 * Voz por WebTransport: datagramas sobre QUIC.
 *
 * Isto existe por um motivo so. No WebSocket a voz anda em TCP, e TCP entrega
 * em ordem: um pacote perdido segura todos os que vieram depois ate a
 * retransmissao chegar. Para audio isso e o pior negocio possivel - o quadro
 * atrasado ja nao serve para nada, e ainda atrasou os bons. Datagrama nao tem
 * essa promessa: o que se perdeu se perdeu, e o resto passa direto.
 *
 * O controle continua no WebSocket. Ele quer exatamente o que o TCP oferece, e
 * QUIC nao melhora nada ali.
 *
 * O modulo nativo e opcional: sem ele, ou sem certificado, o servidor sobe
 * igual e todo mundo fala por WebSocket.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { MAX_VOICE_PACKET, VOICE_TOKEN_BYTES } from '@vox/protocol';
import { config } from './config.js';
import type { Registry } from './registry.js';
import type { Session, VoiceSink } from './session.js';

export interface VoiceEndpoint {
  port: number;
  /** SHA-256 do certificado, publicado so em desenvolvimento. */
  certHash: Uint8Array;
  /** Cria sob demanda o listener do hostname usado no WebSocket. */
  endpointFor(hostname: string): VoiceEndpointInfo;
  stop(): Promise<void>;
}

export interface VoiceEndpointInfo {
  port: number;
  certHash: Uint8Array;
}

/** Sessao sem token valido nesse tempo e descartada. */
const HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * De quanto em quanto tempo conferir se o certificado mudou no disco.
 *
 * Quem renova (Caddy, certbot) reescreve os arquivos e segue a vida. Sem esta
 * checagem o QUIC continuaria servindo o certificado velho ate alguem
 * reiniciar o processo - uma armadilha que so aparece dois meses depois.
 */
const CERT_WATCH_MS = 60 * 60 * 1000;

/**
 * Escritas de datagrama em voo por cliente. Passou disso, a rede dele nao esta
 * dando conta e a coisa certa e descartar voz nova, nao enfileirar audio velho.
 */
const MAX_INFLIGHT = 8;

/** Formato minimo que usamos da sessao WebTransport. */
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

interface CertificatePair {
  host: string;
  certPath: string;
  keyPath: string;
}

interface Http3ServerLike {
  ready: Promise<unknown>;
  startServer(): void;
  stopServer(): void;
  updateCert(cert: string, privKey: string, http2only: boolean): void;
  sessionStream(path: string): ReadableStream<unknown>;
}

type Http3ServerConstructor = new (init: {
  port: number;
  host: string;
  secret: string;
  cert: string;
  privKey: string;
  defaultDatagramsReadableMode: 'bytes';
}) => Http3ServerLike;

interface ActiveEndpoint extends VoiceEndpointInfo {
  host: string;
  certPath: string;
  keyPath: string;
  cert: string;
  server: Http3ServerLike;
  watcher: ReturnType<typeof setInterval>;
}

export async function startVoiceTransport(registry: Registry): Promise<VoiceEndpoint | null> {
  let Http3Server: typeof import('@fails-components/webtransport').Http3Server;
  try {
    ({ Http3Server } = await import('@fails-components/webtransport'));
  } catch (err) {
    console.warn('[vox] WebTransport indisponivel (modulo nativo ausente):', String(err));
    return null;
  }

  const certDir = certificateDirectory();
  const initial = findInitialCertificate(certDir);
  if (!initial) {
    // Caso comum no primeiro boot atras de um proxy: o certificado ainda nao
    // foi emitido. Nao e erro, e so cedo demais.
    console.warn(
      `[vox] nenhum certificado do WebTransport encontrado${certDir ? ` em ${certDir}` : ''};` +
        ' a voz segue no WebSocket ate o certificado ser emitido.',
    );
    return null;
  }

  const manager = new VoiceTransportManager(Http3Server, registry, certDir);
  const first = manager.start(initial, config.wtPort);
  try {
    await first.server.ready;
  } catch (err) {
    await manager.stop();
    throw err;
  }

  return {
    port: first.port,
    certHash: first.certHash,
    endpointFor: (hostname) => manager.endpointFor(hostname),
    stop: () => manager.stop(),
  };
}

class VoiceTransportManager {
  private readonly endpoints = new Map<string, ActiveEndpoint>();
  private readonly usedPorts = new Set<number>();

  constructor(
    private readonly Http3Server: Http3ServerConstructor,
    private readonly registry: Registry,
    private readonly certDir: string,
  ) {}

  start(pair: CertificatePair, port: number): ActiveEndpoint {
    this.usedPorts.add(port);
    return this.create(pair, port);
  }

  /**
   * O WebSocket ja passou pelo Caddy, portanto neste ponto o certificado do
   * hostname normalmente ja existe. Se nao existir, devolvemos 0 e a voz
   * continua no WebSocket; a proxima conexao tenta novamente.
   */
  endpointFor(hostname: string): VoiceEndpointInfo {
    const host = normalizeHostname(hostname);
    const existing = this.endpoints.get(host);
    if (existing) return infoOf(existing);

    const pair = certificatePairFor(host, this.certDir) ?? legacyCertificatePair(host, this.certDir);
    if (!pair) {
      if (host) {
        console.warn(`[vox] certificado QUIC de ${host} ainda nao existe; voz segue no WebSocket`);
      }
      return emptyEndpoint();
    }

    const port = this.nextPort();
    if (port === 0) {
      console.error(
        `[vox] intervalo UDP do WebTransport esgotado (${config.wtPort}-${config.wtPortMax});` +
          ` aumente VOX_WT_PORT_MAX para habilitar ${host}`,
      );
      return emptyEndpoint();
    }

    try {
      return infoOf(this.create(pair, port));
    } catch (err) {
      this.usedPorts.delete(port);
      console.error(`[vox] falha ao iniciar WebTransport para ${host}:`, String(err));
      return emptyEndpoint();
    }
  }

  private create(pair: CertificatePair, port: number): ActiveEndpoint {
    const cert = readFileSync(pair.certPath, 'utf8');
    const privKey = readFileSync(pair.keyPath, 'utf8');
    const server = new this.Http3Server({
      port,
      host: config.wtHost,
      secret: randomBytes(32).toString('hex'),
      cert,
      privKey,
      defaultDatagramsReadableMode: 'bytes',
    });
    const endpoint = {
      host: pair.host,
      port,
      certPath: pair.certPath,
      keyPath: pair.keyPath,
      cert,
      server,
      watcher: undefined as unknown as ReturnType<typeof setInterval>,
      certHash: config.wtPublishHash ? certificateHash(cert) : new Uint8Array(0),
    } satisfies ActiveEndpoint;
    this.endpoints.set(pair.host, endpoint);
    server.startServer();
    void server.ready.catch((err) => {
      if (this.endpoints.get(pair.host) === endpoint) {
        this.endpoints.delete(pair.host);
        this.usedPorts.delete(port);
        clearInterval(endpoint.watcher);
      }
      console.error(`[vox] WebTransport de ${pair.host} não ficou disponível:`, String(err));
    });
    void acceptLoop(server.sessionStream('/vox'), this.registry);
    endpoint.watcher = watchCertificate(endpoint);
    console.log(`[vox] voz por WebTransport para ${pair.host} em udp/${port} (${config.wtHost})`);
    return endpoint;
  }

  private nextPort(): number {
    const first = Math.max(1, Math.min(65535, config.wtPort));
    const last = Math.max(first, Math.min(65535, config.wtPortMax));
    for (let port = first; port <= last; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    return 0;
  }

  async stop(): Promise<void> {
    for (const endpoint of this.endpoints.values()) {
      clearInterval(endpoint.watcher);
      try {
        endpoint.server.stopServer();
      } catch {
        // O addon pode ainda estar inicializando quando o processo encerra.
      }
    }
    this.endpoints.clear();
    this.usedPorts.clear();
  }
}

function emptyEndpoint(): VoiceEndpointInfo {
  return { port: 0, certHash: new Uint8Array(0) };
}

function infoOf(endpoint: ActiveEndpoint): VoiceEndpointInfo {
  return {
    port: endpoint.port,
    certHash: endpoint.certHash,
  };
}

function watchCertificate(endpoint: ActiveEndpoint): ReturnType<typeof setInterval> {
  let seen = certificateMtime(endpoint);
  const timer = setInterval(() => {
    const now = certificateMtime(endpoint);
    if (now === seen) return;
    seen = now;
    try {
      const cert = readFileSync(endpoint.certPath, 'utf8');
      endpoint.server.updateCert(cert, readFileSync(endpoint.keyPath, 'utf8'), false);
      endpoint.cert = cert;
      endpoint.certHash = config.wtPublishHash ? certificateHash(cert) : new Uint8Array(0);
      console.log(`[vox] certificado QUIC de ${endpoint.host} recarregado`);
    } catch (err) {
      console.error(`[vox] falha ao recarregar certificado QUIC de ${endpoint.host}:`, err);
    }
  }, CERT_WATCH_MS);
  timer.unref();
  return timer;
}

function certificateMtime(endpoint: Pick<ActiveEndpoint, 'certPath' | 'keyPath'>): number {
  return Math.max(mtimeOf(endpoint.certPath), mtimeOf(endpoint.keyPath));
}

function certificateDirectory(): string {
  if (config.wtCertDir) return config.wtCertDir;
  if (!config.wtCert) return '';
  const host = hostFromCertificatePath(config.wtCert);
  return host ? dirname(dirname(config.wtCert)) : '';
}

function findInitialCertificate(certDir: string): CertificatePair | null {
  if (config.wtCert && config.wtKey && existsSync(config.wtCert) && existsSync(config.wtKey)) {
    return {
      host: hostFromCertificatePath(config.wtCert),
      certPath: config.wtCert,
      keyPath: config.wtKey,
    };
  }
  if (!certDir || !existsSync(certDir)) return null;
  try {
    for (const entry of readdirSync(certDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pair = certificatePairFor(entry.name, certDir);
      if (pair) return pair;
    }
  } catch {
    // O Caddy pode ainda estar criando o armazenamento no primeiro boot.
  }
  return null;
}

function certificatePairFor(hostname: string, certDir: string): CertificatePair | null {
  const host = normalizeHostname(hostname);
  if (!certDir || !host || !isHostname(host)) return null;
  const certPath = join(certDir, host, `${host}.crt`);
  const keyPath = join(certDir, host, `${host}.key`);
  return existsSync(certPath) && existsSync(keyPath) ? { host, certPath, keyPath } : null;
}

/** Compatibilidade com instalações que usam um certificado fora do Caddy. */
function legacyCertificatePair(host: string, certDir: string): CertificatePair | null {
  if (certDir || !config.wtCert || !config.wtKey || !existsSync(config.wtCert) || !existsSync(config.wtKey)) {
    return null;
  }
  return { host, certPath: config.wtCert, keyPath: config.wtKey };
}

function hostFromCertificatePath(path: string): string {
  const host = basename(dirname(path)).toLowerCase();
  const filename = basename(path, extname(path)).toLowerCase();
  return host === filename && isHostname(host) ? host : '';
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isHostname(hostname: string): boolean {
  return hostname.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname);
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function acceptLoop(sessions: ReadableStream<unknown>, registry: Registry): Promise<void> {
  const reader = sessions.getReader();
  for (;;) {
    let session: WTSession;
    try {
      const { done, value } = await reader.read();
      if (done) return;
      session = value as WTSession;
    } catch (err) {
      console.error('[vox] laco de sessoes WebTransport parou:', err);
      return;
    }
    // Uma sessao ruim nao pode derrubar o laco que aceita as outras.
    void serve(session, registry).catch(() => closeQuietly(session));
  }
}

async function serve(session: WTSession, registry: Registry): Promise<void> {
  await session.ready;

  const token = await withTimeout(readToken(session), HANDSHAKE_TIMEOUT_MS);
  if (!token) return closeQuietly(session);

  const sink = makeSink(session);
  // O segredo identifica a sessao em qualquer servidor virtual; o caminho do
  // WebTransport e um so justamente por isso.
  const owner = registry.bindVoice(token.value, sink);
  const hub = owner ? registry.hubOf(owner) : undefined;
  await token.reply(owner && hub ? 1 : 0);

  if (!owner || !hub) return closeQuietly(session);

  // A partir daqui a sessao pertence a um cliente autenticado.
  void session.closed.then(
    () => release(owner, sink),
    () => release(owner, sink),
  );

  const reader = session.datagrams.readable.getReader();
  for (;;) {
    let frame: Uint8Array | undefined;
    try {
      const { done, value } = await reader.read();
      if (done) break;
      frame = value;
    } catch {
      break;
    }
    // Datagrama maior que o teto so pode ser cliente quebrado ou malicioso.
    if (frame && frame.length <= MAX_VOICE_PACKET) hub.handleFrame(owner, frame);
  }
  release(owner, sink);
}

/**
 * O primeiro stream bidirecional carrega o segredo do Welcome.
 *
 * Stream e nao datagrama porque isto precisa chegar: um handshake perdido
 * deixaria o cliente esperando para sempre por um canal que nunca abriu.
 */
async function readToken(
  session: WTSession,
): Promise<{ value: Uint8Array; reply: (byte: number) => Promise<void> } | null> {
  const streams = session.incomingBidirectionalStreams.getReader();
  const { done, value: stream } = await streams.read();
  if (done || !stream) return null;

  const reader = stream.readable.getReader();
  const buf = new Uint8Array(VOICE_TOKEN_BYTES);
  let filled = 0;
  while (filled < VOICE_TOKEN_BYTES) {
    const chunk = await reader.read();
    if (chunk.done || !chunk.value) return null;
    const take = Math.min(VOICE_TOKEN_BYTES - filled, chunk.value.length);
    buf.set(chunk.value.subarray(0, take), filled);
    filled += take;
  }

  return {
    value: buf,
    async reply(byte: number) {
      const writer = stream.writable.getWriter();
      try {
        await writer.write(new Uint8Array([byte]));
        await writer.close();
      } catch {
        // cliente sumiu no meio do handshake
      }
    },
  };
}

function makeSink(session: WTSession): VoiceSink {
  const writable = session.datagrams.createWritable
    ? session.datagrams.createWritable()
    : session.datagrams.writable!;
  const writer = writable.getWriter();
  let inflight = 0;
  let dead = false;

  return {
    send(frame) {
      if (dead || inflight >= MAX_INFLIGHT) return;
      inflight++;
      writer.write(frame).then(
        () => {
          inflight--;
        },
        () => {
          inflight--;
          dead = true;
        },
      );
    },
    close() {
      dead = true;
      writer.close().catch(() => {});
      closeQuietly(session);
    },
  };
}

/** So limpa se a sessao ainda for a atual - o cliente pode ter reaberto. */
function release(owner: Session, sink: VoiceSink): void {
  if (owner.voice === sink) owner.voice = null;
}

function closeQuietly(session: WTSession): void {
  try {
    session.close();
  } catch {
    // ja fechada
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * O navegador compara o SHA-256 do DER, nao do PEM. Extrai o corpo base64 e
 * tira o hash dos bytes de verdade.
 */
function certificateHash(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----[\s\S]*/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64');
  return new Uint8Array(createHash('sha256').update(der).digest());
}
