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
import { EDGE_VOICE_TELEMETRY, EDGE_TELEMETRY_HEADER, decodeEdgeTelemetry } from '@vox/protocol';
import { config } from './config.js';
import { serverMetrics } from './metrics.js';
import type { Registry } from './registry.js';
import type { Session, VoiceSink, VoiceState } from './session.js';

const PATH = '/internal/edge';
const EDGE_ACCEPT = 0xf0;
const EDGE_STATE = 0xf1;
const EDGE_REJECT = 0xf2;
const EDGE_MUX_REGISTER = 0xf3;
const EDGE_MUX_ACCEPT = 0xf4;
const EDGE_MUX_STATE = 0xf5;
const EDGE_MUX_VOICE = 0xf6;
const EDGE_MUX_DELIVERY = 0xf7;
const EDGE_MUX_RELEASE = 0xf8;
const EDGE_MUX_DELIVERY_CLIENT = 0xf9;
const EDGE_MUX_REJECT = 0xfa;
const EDGE_MUX_STATUS = 0xfb;

let nextMuxId = 1;

export function attachEdgeWebSocket(
  server: HttpServer | HttpsServer,
  registry: Registry,
): void {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: Math.max(MAX_VOICE_PACKET + 32, 2048),
  });
  wss.on('headers', (headers) => headers.push(`${EDGE_TELEMETRY_HEADER}: 1`));

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== PATH) return;
    if (!authorized(req)) return reject(socket, 401, 'edge nao autorizado');

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (req.headers['x-vox-edge-mux'] === '1') {
        serveMultiplexed(ws, registry, edgeIdFrom(req));
      } else {
        serve(ws, registry, edgeIdFrom(req));
      }
    });
  });
}

function serve(ws: WebSocket, registry: Registry, edgeId: string): void {
  ws.binaryType = 'nodebuffer';
  serverMetrics.recordEdgeUpstream(edgeId, 1);
  let owner: Session | null = null;
  let sink: EdgeVoiceSink | null = null;
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    if (owner && sink && owner.voice === sink) {
      owner.voice = null;
      registry.syncVoiceState(owner);
    }
    if (owner) {
      serverMetrics.recordEdgeSession(edgeId, -1);
      serverMetrics.recordVoiceTransport('quic', -1);
      serverMetrics.recordVoiceTransport('ws', 1);
    }
    serverMetrics.recordEdgeUpstream(edgeId, -1);
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return close(ws, 1003, 'link binario esperado');
    const frame = toBytes(data);
    if (!owner) {
      if (frame.length !== VOICE_TOKEN_BYTES) return close(ws, 1008, 'token invalido');
      sink = new EdgeVoiceSink(ws, edgeId);
      owner = registry.bindEdgeVoice(frame, sink);
      const hub = owner ? registry.hubOf(owner) : undefined;
      if (!owner || !hub) {
        sendControl(ws, new Uint8Array([EDGE_REJECT]));
        return close(ws, 1008, 'sessao de voz recusada');
      }
      serverMetrics.recordEdgeSession(edgeId, 1);
      serverMetrics.recordVoiceTransport('ws', -1);
      serverMetrics.recordVoiceTransport('quic', 1);
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

/**
 * Versao multiplexada: um websocket privado representa todos os usuarios de
 * um edge. O token continua autenticando cada sessao individualmente, mas a
 * voz que sai da origem pode ser entregue uma vez por canal/regiao.
 */
function serveMultiplexed(ws: WebSocket, registry: Registry, announcedEdgeId: string): void {
  ws.binaryType = 'nodebuffer';
  const edgeId = announcedEdgeId || `edge-mux-${nextMuxId++}`;
  serverMetrics.recordEdgeUpstream(edgeId, 1);
  const sessions = new Map<number, { owner: Session; sink: MultiplexedVoiceSink }>();
  let closed = false;

  const detach = (clientId: number, notifyEdge: boolean): void => {
    const entry = sessions.get(clientId);
    if (!entry) return;
    sessions.delete(clientId);
    if (entry.owner.voice === entry.sink) {
      entry.owner.voice = null;
      registry.syncVoiceState(entry.owner);
    }
    entry.sink.markDetached();
    serverMetrics.recordEdgeSession(edgeId, -1);
    serverMetrics.recordVoiceTransport('quic', -1);
    serverMetrics.recordVoiceTransport('ws', 1);
    if (notifyEdge) entry.sink.sendRelease();
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return close(ws, 1003, 'link binario esperado');
    const frame = toBytes(data);
    const kind = frame[0];

    if (kind === EDGE_MUX_REGISTER) {
      if (frame.length !== 3 + VOICE_TOKEN_BYTES) return close(ws, 1008, 'registro invalido');
      const requestId = readU16(frame, 1);
      let sink: MultiplexedVoiceSink;
      const owner = registry.bindEdgeVoice(frame.subarray(3), sink = new MultiplexedVoiceSink(
        ws,
        edgeId,
        0,
        () => detach(sink.clientId, false),
      ));
      const hub = owner ? registry.hubOf(owner) : undefined;
      if (!owner || !hub) {
        return sendControl(ws, encodeMuxReject(requestId));
      }
      sink.setClientId(owner.id);
      sessions.set(owner.id, { owner, sink });
      serverMetrics.recordEdgeSession(edgeId, 1);
      serverMetrics.recordVoiceTransport('ws', -1);
      serverMetrics.recordVoiceTransport('quic', 1);
      return sendControl(ws, encodeMuxAccept(requestId, owner.id, hub.voiceState(owner)));
    }

    if (kind === EDGE_MUX_VOICE) {
      if (frame.length <= 3 || frame.length > MAX_VOICE_PACKET + 3 || frame[3] !== FrameKind.Voice) {
        return close(ws, 1008, 'frame de voz invalido');
      }
      const entry = sessions.get(readU16(frame, 1));
      if (!entry) return;
      serverMetrics.recordEdgeTraffic(edgeId, 'inbound', frame.byteLength - 3);
      const hub = registry.hubOf(entry.owner);
      if (hub) hub.handleFrame(entry.owner, frame.subarray(3));
      return;
    }

    if (kind === EDGE_MUX_RELEASE) {
      if (frame.length !== 3) return close(ws, 1008, 'liberacao invalida');
      detach(readU16(frame, 1), false);
      return;
    }

    if (kind === EDGE_MUX_STATUS) {
      const status = decodeEdgeStatus(frame);
      if (!status) return close(ws, 1008, 'status de edge invalido');
      serverMetrics.updateEdgeStatus(edgeId, status);
      return;
    }

    if (kind === EDGE_VOICE_TELEMETRY) {
      const telemetry = decodeEdgeTelemetry(frame);
      if (!telemetry) return close(ws, 1008, 'telemetria de edge invalida');
      serverMetrics.updateEdgeVoiceTelemetry(edgeId, telemetry);
      return;
    }

    close(ws, 1008, 'frame de edge desconhecido');
  });

  const releaseAll = (): void => {
    if (closed) return;
    closed = true;
    for (const { owner, sink } of sessions.values()) {
      if (owner.voice === sink) {
        owner.voice = null;
        registry.syncVoiceState(owner);
      }
      sink.markDetached();
      serverMetrics.recordEdgeSession(edgeId, -1);
      serverMetrics.recordVoiceTransport('quic', -1);
      serverMetrics.recordVoiceTransport('ws', 1);
    }
    sessions.clear();
    serverMetrics.recordEdgeUpstream(edgeId, -1);
  };
  ws.once('close', releaseAll);
  ws.once('error', releaseAll);
}

class MultiplexedVoiceSink implements VoiceSink {
  readonly voiceGroupId: string;
  private closed = false;
  clientId: number;

  constructor(
    private readonly ws: WebSocket,
    readonly edgeId: string,
    clientId: number,
    private readonly onDetach: () => void,
  ) {
    this.voiceGroupId = edgeId;
    this.clientId = clientId;
  }

  setClientId(clientId: number): void {
    this.clientId = clientId;
  }

  send(frame: Uint8Array): void {
    this.sendClient(frame);
  }

  sendChannel(channelId: number, frame: Uint8Array): void {
    this.sendEnvelope(EDGE_MUX_DELIVERY, channelId, frame);
  }

  updateState(state: VoiceState): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    const out = new Uint8Array(10);
    out[0] = EDGE_MUX_STATE;
    writeU16(out, 1, this.clientId);
    writeState(out, 3, 0, state);
    this.ws.send(out, { binary: true });
  }

  close(): void {
    if (this.closed) return;
    this.detach();
    this.sendRelease();
  }

  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.onDetach();
  }

  markDetached(): void {
    this.closed = true;
  }

  sendRelease(): void {
    if (this.ws.readyState !== this.ws.OPEN || this.clientId <= 0) return;
    const out = new Uint8Array([EDGE_MUX_RELEASE, this.clientId & 0xff, (this.clientId >>> 8) & 0xff]);
    this.ws.send(out, { binary: true });
  }

  private sendClient(frame: Uint8Array): void {
    this.sendEnvelope(EDGE_MUX_DELIVERY_CLIENT, this.clientId, frame);
  }

  private sendEnvelope(kind: number, id: number, frame: Uint8Array): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > 4 * 1024 * 1024) {
      serverMetrics.recordVoiceDrop(frame.byteLength, this.edgeId);
      return;
    }
    const out = new Uint8Array(frame.byteLength + 3);
    out[0] = kind;
    writeU16(out, 1, id);
    out.set(frame, 3);
    serverMetrics.recordEdgeTraffic(this.edgeId, 'outbound', frame.byteLength);
    this.ws.send(out, { binary: true });
  }
}

class EdgeVoiceSink implements VoiceSink {
  constructor(private readonly ws: WebSocket, readonly edgeId: string) {}

  send(frame: Uint8Array): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) {
      serverMetrics.recordVoiceDrop(frame.byteLength);
      return;
    }
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

function encodeMuxAccept(requestId: number, clientId: number, state: VoiceState): Uint8Array {
  const out = new Uint8Array(12);
  out[0] = EDGE_MUX_ACCEPT;
  writeU16(out, 1, requestId);
  writeU16(out, 3, clientId);
  writeState(out, 5, 0, state);
  return out;
}

function encodeMuxReject(requestId: number): Uint8Array {
  const out = new Uint8Array(3);
  out[0] = EDGE_MUX_REJECT;
  writeU16(out, 1, requestId);
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

function writeU16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}

function readU16(frame: Uint8Array, offset: number): number {
  return frame[offset]! | (frame[offset + 1]! << 8);
}

function readU32(frame: Uint8Array, offset: number): number {
  return (frame[offset]!
    | (frame[offset + 1]! << 8)
    | (frame[offset + 2]! << 16)
    | (frame[offset + 3]! << 24)) >>> 0;
}

function decodeEdgeStatus(frame: Uint8Array): {
  attempts: number;
  successes: number;
  failures: number;
  cancelled: number;
  p50Ms: number;
  p95Ms: number;
  sessions: number;
  lastFailure: string;
} | null {
  if (frame.length < 20 || frame[0] !== EDGE_MUX_STATUS) return null;
  // Edges ainda em atualização usam o formato anterior, sem canceladas.
  if (20 + frame[19]! === frame.length) return {
    attempts: readU32(frame, 1),
    successes: readU32(frame, 5),
    failures: readU32(frame, 9),
    cancelled: 0,
    p50Ms: readU16(frame, 13),
    p95Ms: readU16(frame, 15),
    sessions: readU16(frame, 17),
    lastFailure: new TextDecoder().decode(frame.subarray(20)),
  };
  if (frame.length < 24) return null;
  const reasonLength = frame[23]!;
  if (24 + reasonLength !== frame.length) return null;
  return {
    attempts: readU32(frame, 1),
    successes: readU32(frame, 5),
    failures: readU32(frame, 9),
    cancelled: readU32(frame, 13),
    p50Ms: readU16(frame, 17),
    p95Ms: readU16(frame, 19),
    sessions: readU16(frame, 21),
    lastFailure: new TextDecoder().decode(frame.subarray(24)),
  };
}

function authorized(req: IncomingMessage): boolean {
  if (!config.voiceEdgeSecret) return false;
  const value = req.headers['x-vox-edge-secret'];
  const actual = typeof value === 'string' ? Buffer.from(value) : Buffer.alloc(0);
  const expected = Buffer.from(config.voiceEdgeSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** O edge se identifica para a origem poder evitar eco entre clientes locais. */
function edgeIdFrom(req: IncomingMessage): string {
  const value = req.headers['x-vox-edge-id'];
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
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
