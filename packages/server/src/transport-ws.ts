/**
 * Transporte WebSocket.
 *
 * E o transporte universal: funciona em qualquer navegador, atravessa proxy e
 * so precisa da porta HTTPS. O controle mora aqui para sempre; a voz sai por
 * aqui ate o WebTransport subir.
 *
 * O caminho carrega o servidor virtual: `/vox/3` entra no servidor 3, e `/vox`
 * sozinho cai no primeiro. Escolher pelo caminho, e nao por uma porta por
 * servidor como o TS3 faz, mantem um certificado so e uma origem so.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeVoiceBatch, MAX_CONTROL_FRAME, MAX_VOICE_BATCH_FRAMES } from '@vox/protocol';
import { config } from './config.js';
import { serverMetrics } from './metrics.js';
import type { Hub } from './hub.js';
import type { Registry } from './registry.js';
import type { PeerSocket } from './session.js';

const ROUTE = /^\/vox(?:\/(\d+))?\/?$/;
const EDGE_ROUTE = '/internal/edge';

export function attachWebSocket(
  server: HttpServer | HttpsServer,
  registry: Registry,
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    // Comprimir voz Opus e desperdicio puro: ja esta comprimida e o deflate
    // adiciona latencia e CPU em cada um dos 50 pacotes por segundo.
    perMessageDeflate: false,
    maxPayload: MAX_CONTROL_FRAME,
    skipUTF8Validation: true,
  });

  /** Conexoes abertas por IP, para o teto de VOX_MAX_PER_IP. */
  const openPerIp = new Map<string, number>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === EDGE_ROUTE) return;
    const route = ROUTE.exec(path);
    if (!route) return reject(socket, 404, 'rota desconhecida');

    const hub = route[1]
      ? registry.get(Number(route[1]))
      : registry.getByHost(String(req.headers.host ?? '')) ?? registry.primaryIfBase(String(req.headers.host ?? ''));
    if (!hub) return reject(socket, 404, 'servidor virtual inexistente');

    const ip = clientIp(req);
    const hostname = requestHostname(req);
    // Se for um hostname novo, isso dispara a criação do listener QUIC antes
    // de o cliente terminar o handshake do WebSocket e receber o Welcome.
    registry.voiceEndpoint(hostname);
    const open = openPerIp.get(ip) ?? 0;
    if (config.maxPerIp > 0 && open >= config.maxPerIp) {
      return reject(socket, 429, 'limite de conexoes por IP');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      openPerIp.set(ip, open + 1);
      serve(ws, hub, ip, hostname, () => {
        const left = (openPerIp.get(ip) ?? 1) - 1;
        if (left <= 0) openPerIp.delete(ip);
        else openPerIp.set(ip, left);
      });
    });
  });

  return wss;
}

function serve(ws: WebSocket, hub: Hub, ip: string, hostname: string, onClose: () => void): void {
  ws.binaryType = 'nodebuffer';

  const voiceQueue: Uint8Array[] = [];
  let voiceQueueBytes = 0;
  let voiceFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushVoice = (): void => {
    if (voiceFlushTimer) {
      clearTimeout(voiceFlushTimer);
      voiceFlushTimer = null;
    }
    if (voiceQueue.length === 0 || ws.readyState !== ws.OPEN) {
      voiceQueue.length = 0;
      voiceQueueBytes = 0;
      return;
    }
    const frames = voiceQueue.splice(0, voiceQueue.length);
    voiceQueueBytes = 0;
    try {
      ws.send(frames.length === 1 ? frames[0]! : encodeVoiceBatch(frames), { binary: true });
    } catch {
      ws.terminate();
    }
  };

  const scheduleVoiceFlush = (): void => {
    if (voiceFlushTimer) return;
    voiceFlushTimer = setTimeout(flushVoice, 4);
    voiceFlushTimer.unref?.();
  };

  const queueVoice = (data: Uint8Array): void => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024 || voiceQueueBytes + data.byteLength > 64 * 1024) {
      serverMetrics.recordVoiceDrop(data.byteLength);
      return;
    }
    voiceQueue.push(data);
    voiceQueueBytes += data.byteLength;
    if (voiceQueue.length >= MAX_VOICE_BATCH_FRAMES) flushVoice();
    else scheduleVoiceFlush();
  };

  const peer: PeerSocket = {
    remote: ip,
    hostname,
    send(data) {
      // Controle e voz mantem a ordem observada pelo cliente.
      flushVoice();
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    sendVoice(data) {
      queueVoice(data);
    },
    close(reason) {
      try {
        ws.close(4000, reason.slice(0, 120));
      } catch {
        ws.terminate();
      }
    },
  };

  const session = hub.accept(peer);

  ws.on('message', (data, isBinary) => {
    // O protocolo e inteiramente binario; texto so pode ser cliente errado.
    if (!isBinary) return peer.close('esperado binario');
    hub.handleFrame(session, toBytes(data));
  });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    onClose();
    hub.drop(session);
  };

  ws.once('close', release);
  ws.once('error', release);
}

function requestHostname(req: IncomingMessage): string {
  const raw = String(req.headers.host ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));
  return raw.split(':')[0] ?? '';
}

/** Recusa antes do upgrade: o cliente recebe um status HTTP de verdade. */
function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Atras de um proxy reverso o socket sempre vem do proxy, entao o IP real esta
 * no X-Forwarded-For. Sem VOX_TRUST_PROXY ligado o cabecalho e ignorado - ele e
 * trivial de forjar quando o cliente fala direto com o servidor.
 */
function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = first?.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? '?';
}

/** ws entrega Buffer ou fragmentos; normaliza sem copiar quando possivel. */
function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
