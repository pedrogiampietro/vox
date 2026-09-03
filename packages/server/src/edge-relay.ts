/**
 * Link privado entre a origem e um edge regional de voz.
 *
 * O edge termina WebTransport perto do usuario e usa este WebSocket somente
 * para levar os frames ate a origem. A origem continua sendo a autoridade de
 * autenticacao, canais e moderacao; o edge so pode abrir um link com um token
 * de voz valido e recebe do Hub as mudancas de estado necessarias para o
 * encaminhamento local.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { FrameKind, MAX_VOICE_PACKET, VOICE_TOKEN_BYTES } from '@vox/protocol';
import { config } from './config.js';
import type { Registry } from './registry.js';
import type { Session, VoiceSink, VoiceState } from './session.js';

const PATH = '/internal/edge';
const EDGE_ACCEPT = 0xf0;
const EDGE_STATE = 0xf1;
const EDGE_REJECT = 0xf2;

export function attachEdgeWebSocket(
  server: HttpServer | HttpsServer,
  registry: Registry,
): void {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_VOICE_PACKET,
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== PATH) return;
    if (!authorized(req)) return reject(socket, 401, 'edge nao autorizado');

    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, registry));
  });
}

function serve(ws: WebSocket, registry: Registry): void {
  ws.binaryType = 'nodebuffer';
  let owner: Session | null = null;
  let sink: EdgeVoiceSink | null = null;
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    if (owner && sink && owner.voice === sink) owner.voice = null;
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return close(ws, 1003, 'link binario esperado');
    const frame = toBytes(data);
    if (!owner) {
      if (frame.length !== VOICE_TOKEN_BYTES) return close(ws, 1008, 'token invalido');
      sink = new EdgeVoiceSink(ws);
      owner = registry.bindEdgeVoice(frame, sink);
      const hub = owner ? registry.hubOf(owner) : undefined;
      if (!owner || !hub) {
        sendControl(ws, new Uint8Array([EDGE_REJECT]));
        return close(ws, 1008, 'sessao de voz recusada');
      }
      sendControl(ws, encodeAccept(owner.id, hub.voiceState(owner)));
      return;
    }

    if (frame.length > MAX_VOICE_PACKET || frame[0] !== FrameKind.Voice) {
      return close(ws, 1008, 'frame de voz invalido');
    }
    const hub = registry.hubOf(owner);
    if (hub) hub.handleFrame(owner, frame);
  });

  ws.once('close', release);
  ws.once('error', release);
}

class EdgeVoiceSink implements VoiceSink {
  constructor(private readonly ws: WebSocket) {}

  send(frame: Uint8Array): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(frame, { binary: true });
  }

  close(): void {
    close(this.ws, 1000, 'sessao encerrada');
  }

  updateState(state: VoiceState): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(encodeState(state), { binary: true });
  }
}

function encodeAccept(clientId: number, state: VoiceState): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = EDGE_ACCEPT;
  writeState(out, 1, clientId, state);
  return out;
}

function encodeState(state: VoiceState): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = EDGE_STATE;
  writeState(out, 1, 0, state);
  return out;
}

function writeState(out: Uint8Array, offset: number, clientId: number, state: VoiceState): void {
  out[offset] = clientId & 0xff;
  out[offset + 1] = (clientId >>> 8) & 0xff;
  out[offset + 2] = state.channelId & 0xff;
  out[offset + 3] = (state.channelId >>> 8) & 0xff;
  out[offset + 4] = state.channelFlags & 0xff;
  out[offset + 5] = state.clientFlags & 0xff;
  out[offset + 6] = state.group & 0xff;
}

function authorized(req: IncomingMessage): boolean {
  if (!config.voiceEdgeSecret) return false;
  const value = req.headers['x-vox-edge-secret'];
  const actual = typeof value === 'string' ? Buffer.from(value) : Buffer.alloc(0);
  const expected = Buffer.from(config.voiceEdgeSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendControl(ws: WebSocket, frame: Uint8Array): void {
  if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
}

function close(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

function reject(socket: Duplex, code: number, reason: string): void {
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
