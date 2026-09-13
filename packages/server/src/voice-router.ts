/**
 * Ponte do plano de controle para o roteador de voz em Rust.
 *
 * O Hub continua validando identidade, canal, mute e permissões. Quando o
 * processo de mídia está pronto, o Hub apenas publica o frame uma vez; o
 * roteador calcula o fan-out fora do event loop e devolve uma entrega agrupada
 * por frame. Se o processo estiver ausente ou cair, `route()` retorna false e
 * o caminho WebSocket/WebTransport existente continua funcionando.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { ClientFlags, FrameKind } from '@vox/protocol';
import type { Session, VoiceSink, VoiceState } from './session.js';
import type { Registry } from './registry.js';
import { config } from './config.js';
import { serverMetrics } from './metrics.js';

const MAGIC = Buffer.from('VXR1');
const REGISTER = 1;
const UNREGISTER = 2;
const VOICE = 3;
const PROBE = 4;
const READY = 0x80;
const DELIVERY = 0x81;
const METRIC = 0x82;
const REGISTER_SIZE = 26;
const UNREGISTER_SIZE = 17;
const VOICE_HEADER_SIZE = 27;
const DELIVERY_HEADER_SIZE = 21;
const METRIC_SIZE = 19;
const MAX_VOICE_PACKET = 518;

const GATEWAY_MAGIC = Buffer.from('VQX1');
const GATEWAY_AUTH_REQUEST = 1;
const GATEWAY_FRAME = 2;
const GATEWAY_RELEASE = 3;
const GATEWAY_AUTH_RESPONSE = 0x81;
const GATEWAY_SEND = 0x82;
const GATEWAY_CLOSE = 0x83;
const GATEWAY_BATCH = 0x84;
const GATEWAY_TOKEN_SIZE = 16;
const GATEWAY_AUTH_REQUEST_SIZE = 29;
const GATEWAY_FRAME_HEADER_SIZE = 11;
const GATEWAY_BATCH_HEADER_SIZE = 9;

interface RouterClient {
  session: Session;
  serverId: number;
  clientId: number;
  channelId: number;
  clientFlags: number;
  edgeGroup: number;
}

interface GatewayLink {
  session: Session;
  sink: VoiceSink;
}

export class VoiceRouter {
  private readonly enabled = config.voiceRouterEnabled;
  private readonly clients = new Map<string, RouterClient>();
  private readonly gatewayLinks = new Map<number, GatewayLink>();
  private readonly gatewaySessions = new Map<string, number>();
  private socket: Socket | null = null;
  private child: ChildProcess | null = null;
  private ready = false;
  private warnedUnavailable = false;
  private droppedCommands = 0;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private lastReadyAt = 0;
  private registry: Registry | null = null;

  /** Liga o plano de voz ao registro de sessões depois que ambos foram criados. */
  attachRegistry(registry: Registry): void {
    this.registry = registry;
  }

  start(): void {
    if (!this.enabled) return;
    if (!existsSync(config.voiceRouterBin)) {
      this.warnUnavailable(`binário não encontrado em ${config.voiceRouterBin}`);
      return;
    }

    this.socket = createSocket('udp4');
    this.socket.on('error', (error) => {
      this.droppedCommands++;
      this.ready = false;
      this.warnUnavailable(`UDP do roteador: ${error.message}`);
    });
    this.socket.on('message', (packet, remote) => this.receive(packet, remote));
    this.socket.bind(config.voiceRouterNodePort, config.voiceRouterNodeHost, () => {
      this.spawnIfNeeded();
      this.sendProbe();
      this.probeTimer = setInterval(() => {
        if (!this.child && !config.voiceRouterManagedExternally) this.spawnIfNeeded();
        this.sendProbe();
        if (this.ready && Date.now() - this.lastReadyAt > 3000) {
          this.ready = false;
          this.warnUnavailable('serviço de voz deixou de responder; usando fallback');
        }
      }, 1000);
      this.probeTimer.unref?.();
    });
  }

  close(): void {
    this.ready = false;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    this.lastReadyAt = 0;
    this.socket?.close();
    this.socket = null;
    // O serviço normalmente é independente e fica sob systemd. Só encerramos
    // um processo que este Node iniciou explicitamente.
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    this.child = null;
  }

  register(session: Session, state: VoiceState): void {
    if (session.id <= 0) return;
    const client = this.clientFor(session, state);
    this.clients.set(clientKey(client.serverId, client.clientId), client);
    this.sendRegister(client);
  }

  update(session: Session, state: VoiceState): void {
    if (session.id <= 0) return;
    const key = clientKey(session.serverId, session.id);
    const previous = this.clients.get(key);
    const next = this.clientFor(session, state);
    this.clients.set(key, next);
    if (!previous) {
      this.sendRegister(next);
      return;
    }
    if (previous.channelId !== next.channelId) {
      this.sendUnregister(previous);
      this.sendRegister(next);
      return;
    }
    // Atualizações de presença/permissão são frequentes. O worker só precisa
    // receber um novo registro quando algo que altera o roteamento mudou.
    if (previous.clientFlags !== next.clientFlags || previous.edgeGroup !== next.edgeGroup) {
      this.sendRegister(next);
    }
  }

  unregister(session: Session): void {
    const key = clientKey(session.serverId, session.id);
    const previous = this.clients.get(key);
    this.clients.delete(key);
    if (previous) this.sendUnregister(previous);
  }

  /** Retorna true somente quando o worker aceitou o frame para processamento. */
  route(session: Session, channelId: number, frame: Uint8Array): boolean {
    if (!this.ready || !this.socket || session.id <= 0) return false;
    if (frame.length < 7 || frame.length > MAX_VOICE_PACKET || frame[0] !== FrameKind.Voice) return false;
    const packet = Buffer.allocUnsafe(VOICE_HEADER_SIZE + frame.length);
    MAGIC.copy(packet, 0);
    packet[4] = VOICE;
    packet.writeUInt32LE(session.serverId >>> 0, 5);
    packet.writeUInt32LE(session.id >>> 0, 9);
    packet.writeUInt32LE(channelId >>> 0, 13);
    writeTimestamp(packet, 17, Date.now());
    packet.writeUInt16LE(frame.length, 25);
    Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).copy(packet, VOICE_HEADER_SIZE);
    this.send(packet);
    return true;
  }

  private spawnIfNeeded(): void {
    if (!this.socket || this.child) return;
    if (config.voiceRouterManagedExternally) {
      this.waitForReady();
      return;
    }
    this.child = spawn(config.voiceRouterBin, [], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        VOX_VOICE_ROUTER_LISTEN: config.voiceRouterListen,
        VOX_VOICE_ROUTER_TARGET: `${config.voiceRouterNodeHost}:${config.voiceRouterNodePort}`,
        VOX_VOICE_ROUTER_WORKERS: String(config.voiceRouterWorkers),
      },
    });
    this.child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString('utf8').trim();
      if (line) console.log(`[vox-voice] ${line}`);
    });
    this.child.once('error', (error) => {
      this.ready = false;
      this.warnUnavailable(`processo de voz: ${error.message}`);
    });
    this.child.once('exit', (code, signal) => {
      this.ready = false;
      this.child = null;
      console.warn(`[vox-voice] processo encerrado (${signal ?? `codigo ${code ?? '?'}`}); usando fallback`);
    });
    this.waitForReady();
  }

  private sendProbe(): void {
    if (!this.socket) return;
    const packet = Buffer.concat([MAGIC, Buffer.from([PROBE])]);
    this.send(packet);
  }

  private waitForReady(): void {
    setTimeout(() => {
      if (!this.ready) this.warnUnavailable('serviço não confirmou prontidão; usando fallback');
    }, 3000).unref();
  }

  private receive(packet: Buffer, remote: RemoteInfo): void {
    if (remote.address === config.voiceQuicGatewayControlHost && remote.port === config.voiceQuicGatewayControlPort) {
      this.receiveGateway(packet);
      return;
    }
    if (remote.address !== config.voiceRouterWorkerHost || remote.port !== config.voiceRouterWorkerPort) return;
    if (packet.length < 5 || !packet.subarray(0, 4).equals(MAGIC)) return;
    switch (packet[4]) {
      case READY:
        const recovered = !this.ready;
        this.ready = true;
        this.lastReadyAt = Date.now();
        this.warnedUnavailable = false;
        if (recovered) {
          console.log(`[vox-voice] roteador Rust pronto · ${config.voiceRouterWorkers} workers`);
          for (const client of this.clients.values()) this.sendRegister(client);
        }
        return;
      case DELIVERY:
        this.receiveDelivery(packet);
        return;
      case METRIC:
        this.receiveMetric(packet);
        return;
      default:
        return;
    }
  }

  private receiveGateway(packet: Buffer): void {
    if (!config.voiceQuicGatewayEnabled) return;
    if (packet.length < 5 || !packet.subarray(0, 4).equals(GATEWAY_MAGIC)) return;
    switch (packet[4]) {
      case GATEWAY_AUTH_REQUEST: {
        if (packet.length !== GATEWAY_AUTH_REQUEST_SIZE) return;
        const requestId = packet.readUInt32LE(5);
        const connectionId = packet.readUInt32LE(9);
        const token = packet.subarray(13, 13 + GATEWAY_TOKEN_SIZE);
        const sink = this.gatewaySink(connectionId);
        const session = this.registry
          ? this.registry.bindVoice(token, sink)
          : null;
        if (!session) {
          this.sendGatewayAuthResponse(requestId, false);
          return;
        }
        this.gatewayLinks.set(connectionId, { session, sink });
        this.gatewaySessions.set(clientKey(session.serverId, session.id), connectionId);
        serverMetrics.recordVoiceTransport('ws', -1);
        serverMetrics.recordVoiceTransport('quic', 1);
        this.sendGatewayAuthResponse(requestId, true);
        return;
      }
      case GATEWAY_FRAME: {
        if (packet.length < GATEWAY_FRAME_HEADER_SIZE) return;
        const connectionId = packet.readUInt32LE(5);
        const frameLength = packet.readUInt16LE(9);
        if (frameLength < 7 || frameLength > MAX_VOICE_PACKET
          || packet.length !== GATEWAY_FRAME_HEADER_SIZE + frameLength) return;
        const link = this.gatewayLinks.get(connectionId);
        if (!link || !link.session.live || link.session.voice !== link.sink) return;
        const hub = this.registry?.hubOf(link.session);
        if (hub) hub.handleFrame(link.session, packet.subarray(GATEWAY_FRAME_HEADER_SIZE));
        return;
      }
      case GATEWAY_RELEASE: {
        if (packet.length !== 9) return;
        const connectionId = packet.readUInt32LE(5);
        const link = this.gatewayLinks.get(connectionId);
        if (!link) return;
        this.gatewayLinks.delete(connectionId);
        serverMetrics.recordVoiceTransport('quic', -1);
        serverMetrics.recordVoiceTransport('ws', 1);
        if (link.session.voice === link.sink) {
          link.session.voice = null;
          this.registry?.syncVoiceState(link.session);
        }
        const sessionKey = clientKey(link.session.serverId, link.session.id);
        if (this.gatewaySessions.get(sessionKey) === connectionId) this.gatewaySessions.delete(sessionKey);
        return;
      }
      default:
        return;
    }
  }

  private gatewaySink(connectionId: number): VoiceSink {
    return {
      // A identidade física de cada conexão precisa ser única para o roteador
      // não descartar o fan-out entre clientes atendidos pelo mesmo gateway.
      // O agrupamento final acontece no pacote enviado ao gateway.
      voiceGroupId: `quic-gateway:${connectionId}`,
      send: (frame) => this.sendGatewayFrame(connectionId, frame),
      close: () => this.sendGatewayClose(connectionId),
    };
  }

  private sendGatewayAuthResponse(requestId: number, accepted: boolean): void {
    const packet = Buffer.alloc(10);
    GATEWAY_MAGIC.copy(packet, 0);
    packet[4] = GATEWAY_AUTH_RESPONSE;
    packet.writeUInt32LE(requestId >>> 0, 5);
    packet[9] = accepted ? 1 : 0;
    this.sendGateway(packet);
  }

  private sendGatewayFrame(connectionId: number, frame: Uint8Array): void {
    if (frame.length > MAX_VOICE_PACKET) return;
    const packet = Buffer.alloc(GATEWAY_FRAME_HEADER_SIZE + frame.length);
    GATEWAY_MAGIC.copy(packet, 0);
    packet[4] = GATEWAY_SEND;
    packet.writeUInt32LE(connectionId >>> 0, 5);
    packet.writeUInt16LE(frame.length, 9);
    Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).copy(packet, GATEWAY_FRAME_HEADER_SIZE);
    this.sendGateway(packet);
  }

  /** Envia o frame uma vez ao gateway; o Rust faz o fan-out final por QUIC. */
  private sendGatewayBatch(frame: Uint8Array, connectionIds: number[]): void {
    if (frame.length > MAX_VOICE_PACKET || connectionIds.length === 0 || connectionIds.length > 0xffff) return;
    const packet = Buffer.alloc(GATEWAY_BATCH_HEADER_SIZE + connectionIds.length * 4 + frame.length);
    GATEWAY_MAGIC.copy(packet, 0);
    packet[4] = GATEWAY_BATCH;
    packet.writeUInt16LE(connectionIds.length, 5);
    packet.writeUInt16LE(frame.length, 7);
    let offset = GATEWAY_BATCH_HEADER_SIZE;
    for (const connectionId of connectionIds) {
      packet.writeUInt32LE(connectionId >>> 0, offset);
      offset += 4;
    }
    Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).copy(packet, offset);
    this.sendGateway(packet);
  }

  private sendGatewayClose(connectionId: number): void {
    const packet = Buffer.alloc(9);
    GATEWAY_MAGIC.copy(packet, 0);
    packet[4] = GATEWAY_CLOSE;
    packet.writeUInt32LE(connectionId >>> 0, 5);
    this.sendGateway(packet);
  }

  private sendGateway(packet: Buffer): void {
    if (!this.socket || !config.voiceQuicGatewayEnabled) return;
    // Não crie um callback por frame: o socket já possui tratamento global de
    // erro e o hot path da voz não precisa aguardar confirmação individual.
    try {
      this.socket.send(packet, config.voiceQuicGatewayControlPort, config.voiceQuicGatewayControlHost);
    } catch {
      this.droppedCommands++;
    }
  }

  private receiveDelivery(packet: Buffer): void {
    if (packet.length < DELIVERY_HEADER_SIZE) return;
    const serverId = packet.readUInt32LE(5);
    const channelId = packet.readUInt32LE(13);
    const recipientCount = packet.readUInt16LE(17);
    const frameLength = packet.readUInt16LE(19);
    const expected = DELIVERY_HEADER_SIZE + recipientCount * 8 + frameLength;
    if (recipientCount === 0 || expected !== packet.length || frameLength < 7 || frameLength > MAX_VOICE_PACKET) return;

    const frame = new Uint8Array(packet.buffer, packet.byteOffset + DELIVERY_HEADER_SIZE + recipientCount * 8, frameLength);
    const grouped = new Map<string, VoiceSink>();
    const gatewayRecipients: number[] = [];
    for (let offset = DELIVERY_HEADER_SIZE; offset < DELIVERY_HEADER_SIZE + recipientCount * 8; offset += 8) {
      const targetServerId = packet.readUInt32LE(offset);
      const targetClientId = packet.readUInt32LE(offset + 4);
      if (targetServerId !== serverId) continue;
      const target = this.clients.get(clientKey(targetServerId, targetClientId));
      if (!target || !target.session.live || target.channelId !== channelId) continue;
      const sink = target.session.voice;
      if (sink?.voiceGroupId?.startsWith('quic-gateway:')) {
        const connectionId = this.gatewaySessions.get(clientKey(targetServerId, targetClientId));
        if (connectionId !== undefined) gatewayRecipients.push(connectionId);
      } else if (sink?.voiceGroupId && sink.sendChannel) {
        grouped.set(sink.voiceGroupId, sink);
      } else {
        target.session.sendVoice(frame, false);
      }
    }
    for (const sink of grouped.values()) sink.sendChannel!(channelId, frame);
    this.sendGatewayBatch(frame, gatewayRecipients);
  }

  private receiveMetric(packet: Buffer): void {
    if (packet.length !== METRIC_SIZE) return;
    const serverId = packet.readUInt32LE(5);
    const channelId = packet.readUInt32LE(9);
    const frameLength = packet.readUInt16LE(13);
    const recipients = packet.readUInt16LE(15);
    const dropped = packet.readUInt16LE(17);
    if (recipients > 0) serverMetrics.recordVoiceFanout(frameLength, recipients, `${serverId}:${channelId}`);
    if (dropped > 0) {
      this.droppedCommands += dropped;
      // O roteador só envia esta métrica quando a fila de voz ficou cheia.
      // Contabilizar o lote inteiro evita perder o sinal de saturação no painel.
      serverMetrics.recordVoiceDrops(frameLength, dropped);
    }
  }

  private sendRegister(client: RouterClient): void {
    if (!this.ready) return;
    const packet = Buffer.alloc(REGISTER_SIZE);
    MAGIC.copy(packet, 0);
    packet[4] = REGISTER;
    packet.writeUInt32LE(client.serverId >>> 0, 5);
    packet.writeUInt32LE(client.clientId >>> 0, 9);
    packet.writeUInt32LE(client.channelId >>> 0, 13);
    packet.writeUInt32LE(client.clientFlags >>> 0, 17);
    packet[21] = client.session.group & 0xff;
    packet.writeUInt32LE(client.edgeGroup >>> 0, 22);
    this.send(packet);
  }

  private sendUnregister(client: RouterClient): void {
    if (!this.ready) return;
    const packet = Buffer.alloc(UNREGISTER_SIZE);
    MAGIC.copy(packet, 0);
    packet[4] = UNREGISTER;
    packet.writeUInt32LE(client.serverId >>> 0, 5);
    packet.writeUInt32LE(client.clientId >>> 0, 9);
    packet.writeUInt32LE(client.channelId >>> 0, 13);
    this.send(packet);
  }

  private send(packet: Buffer): void {
    if (!this.socket) return;
    // O envio UDP interno é assíncrono; evitar um closure por pacote reduz a
    // pressão de GC durante fan-out intenso.
    try {
      this.socket.send(packet, config.voiceRouterWorkerPort, config.voiceRouterWorkerHost);
    } catch {
      this.droppedCommands++;
    }
  }

  private clientFor(session: Session, state: VoiceState): RouterClient {
    return {
      session,
      serverId: session.serverId,
      clientId: session.id,
      channelId: state.channelId,
      clientFlags: state.clientFlags & (ClientFlags.MutedMic | ClientFlags.LiveKitVoice),
      edgeGroup: hashGroup(session.voice?.voiceGroupId),
    };
  }

  private warnUnavailable(reason: string): void {
    if (this.warnedUnavailable) return;
    this.warnedUnavailable = true;
    console.warn(`[vox-voice] ${reason}; voz continua no transporte atual`);
  }
}

function clientKey(serverId: number, clientId: number): string {
  return `${serverId}:${clientId}`;
}

function hashGroup(value: string | undefined): number {
  if (!value) return 0;
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

function writeTimestamp(packet: Buffer, offset: number, timestampMs: number): void {
  // Date.now() permanece seguro como Number nesta escala; escrever as duas
  // metades evita criar um BigInt para cada frame recebido.
  packet.writeUInt32LE(timestampMs >>> 0, offset);
  packet.writeUInt32LE(Math.floor(timestampMs / 0x1_0000_0000) >>> 0, offset + 4);
}
