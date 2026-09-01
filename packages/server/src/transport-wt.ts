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
import { readFileSync, statSync } from 'node:fs';
import { MAX_VOICE_PACKET, VOICE_TOKEN_BYTES } from '@vox/protocol';
import { config } from './config.js';
import type { Registry } from './registry.js';
import type { Session, VoiceSink } from './session.js';

export interface VoiceEndpoint {
  port: number;
  /** SHA-256 do certificado, publicado so em desenvolvimento. */
  certHash: Uint8Array;
  stop(): Promise<void>;
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

export async function startVoiceTransport(registry: Registry): Promise<VoiceEndpoint | null> {
  if (!config.wtCert || !config.wtKey) return null;

  let Http3Server: typeof import('@fails-components/webtransport').Http3Server;
  try {
    ({ Http3Server } = await import('@fails-components/webtransport'));
  } catch (err) {
    console.warn('[vox] WebTransport indisponivel (modulo nativo ausente):', String(err));
    return null;
  }

  let cert: string;
  let privKey: string;
  try {
    cert = readFileSync(config.wtCert, 'utf8');
    privKey = readFileSync(config.wtKey, 'utf8');
  } catch {
    // Caso comum no primeiro boot atras de um proxy: o certificado ainda nao
    // foi emitido. Nao e erro, e so cedo demais.
    console.warn(
      `[vox] certificado do WebTransport ainda nao existe em ${config.wtCert};` +
        ' a voz segue no WebSocket. Reinicie o servidor apos a emissao.',
    );
    return null;
  }

  const server = new Http3Server({
    port: config.wtPort,
    host: config.wtHost,
    secret: randomBytes(32).toString('hex'),
    cert,
    privKey,
    defaultDatagramsReadableMode: 'bytes',
  });

  server.startServer();
  await server.ready;

  void acceptLoop(server.sessionStream('/vox'), registry);
  const watcher = watchCertificate(server);

  return {
    port: config.wtPort,
    certHash: config.wtPublishHash ? certificateHash(cert) : new Uint8Array(0),
    async stop() {
      clearInterval(watcher);
      server.stopServer();
    },
  };
}

/** Recarrega o certificado quando o arquivo muda, sem derrubar o servidor. */
function watchCertificate(server: {
  updateCert(cert: string, privKey: string, http2only: boolean): void;
}): ReturnType<typeof setInterval> {
  let seen = mtimeOf(config.wtCert);
  const timer = setInterval(() => {
    const now = mtimeOf(config.wtCert);
    if (now === seen) return;
    seen = now;
    try {
      server.updateCert(
        readFileSync(config.wtCert, 'utf8'),
        readFileSync(config.wtKey, 'utf8'),
        false,
      );
      console.log('[vox] certificado do WebTransport recarregado');
    } catch (err) {
      console.error('[vox] falha ao recarregar o certificado:', err);
    }
  }, CERT_WATCH_MS);
  timer.unref();
  return timer;
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
