import os from 'node:os';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { EdgeClientTelemetry, EdgeVoiceTelemetry } from '@vox/protocol';
import { config } from './config.js';

export type TrafficKind = 'control' | 'voice';
export type VoiceTransportKind = 'ws' | 'quic';

const LEGACY_EDGE_TTL_MS = 2 * 60_000;

export interface RuntimeHistoryPoint {
  at: number;
  processCpuPercent: number;
  eventLoopLagP95Ms: number;
  voiceFanoutRecipients: number;
  voiceDroppedPackets: number;
  voiceQueuedBytes: number;
}

export interface EdgeMetricsSnapshot {
  id: string;
  connected: boolean;
  /** O endpoint QUIC local da origem está pronto para receber clientes. */
  available: boolean;
  /** Último heartbeat ou sessão observado para este edge. */
  lastSeenAt: number;
  upstreams: number;
  sessions: number;
  localVoice: {
    reportedAt: number;
    droppedPackets: number;
    droppedBytes: number;
    clients: (EdgeClientTelemetry & { reportedAt: number })[];
  } | null;
  handshakes: {
    attempts: number;
    successes: number;
    failures: number;
    cancelled: number;
    successRate: number;
    p50Ms: number;
    p95Ms: number;
    lastFailure: string;
    lastFailureAt: number;
    lastSuccessAt: number;
  };
  traffic: {
    inboundBytesTotal: number;
    outboundBytesTotal: number;
    droppedPackets: number;
    droppedBytes: number;
  };
}

export interface RuntimeMetricsSnapshot {
  at: number;
  uptimeSec: number;
  cpuCount: number;
  processCpuPercent: number;
  hostCpuPercent: number;
  eventLoopLagMs: number;
  eventLoopLagP95Ms: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    systemTotalBytes: number;
    systemFreeBytes: number;
    systemUsedPercent: number;
  };
  traffic: {
    inboundBytesPerSec: number;
    outboundBytesPerSec: number;
    inboundKbps: number;
    outboundKbps: number;
    inboundBytesTotal: number;
    outboundBytesTotal: number;
    controlInboundBytesTotal: number;
    controlOutboundBytesTotal: number;
    voiceInboundBytesTotal: number;
    voiceOutboundBytesTotal: number;
    voiceFanoutFramesTotal: number;
    voiceFanoutRecipientsTotal: number;
    voiceDroppedPacketsTotal: number;
    voiceDroppedBytesTotal: number;
  };
  connections: {
    control: number;
    voiceWebSocket: number;
    voiceQuic: number;
    edgeUpstreams: number;
    edgeSessions: number;
  };
  voice: {
    queuedBytes: number;
    queuedClients: number;
    maxQueueBytes: number;
    channelFanout: {
      key: string;
      serverId: number;
      channelId: number;
      frames: number;
      recipients: number;
      averageRecipients: number;
    }[];
  };
  edges: EdgeMetricsSnapshot[];
  history: RuntimeHistoryPoint[];
}

interface TrafficTotals {
  inbound: number;
  outbound: number;
  controlInbound: number;
  controlOutbound: number;
  voiceInbound: number;
  voiceOutbound: number;
  voiceFanoutFrames: number;
  voiceFanoutRecipients: number;
  voiceDroppedPackets: number;
  voiceDroppedBytes: number;
}

interface EdgeTotals {
  connected: boolean;
  available: boolean;
  lastSeenAt: number;
  upstreams: number;
  sessions: number;
  handshakeAttempts: number;
  handshakeSuccesses: number;
  handshakeFailures: number;
  handshakeCancelled: number;
  handshakeDurations: number[];
  lastFailure: string;
  lastFailureAt: number;
  lastSuccessAt: number;
  reportedP50Ms: number;
  reportedP95Ms: number;
  reportedFailureCount: number;
  reportedSuccessCount: number;
  inboundBytes: number;
  outboundBytes: number;
  droppedPackets: number;
  droppedBytes: number;
  telemetryBootId: string;
  localVoice: EdgeMetricsSnapshot['localVoice'];
}

interface ChannelTotals {
  serverId: number;
  channelId: number;
  frames: number;
  recipients: number;
}

/**
 * Metricas leves do processo. Os contadores contam payloads do protocolo, nao
 * cabecalhos TCP/TLS: e o numero que melhor explica o consumo do Vox e tambem
 * funciona quando a voz troca WebSocket por WebTransport.
 */
export class RuntimeMetricsCollector {
  private telemetryWrite: Promise<void> = Promise.resolve();
  private readonly totals: TrafficTotals = {
    inbound: 0,
    outbound: 0,
    controlInbound: 0,
    controlOutbound: 0,
    voiceInbound: 0,
    voiceOutbound: 0,
    voiceFanoutFrames: 0,
    voiceFanoutRecipients: 0,
    voiceDroppedPackets: 0,
    voiceDroppedBytes: 0,
  };

  private readonly connections = {
    control: 0,
    voiceWebSocket: 0,
    voiceQuic: 0,
    edgeUpstreams: 0,
    edgeSessions: 0,
  };
  private readonly edges = new Map<string, EdgeTotals>();
  private readonly channels = new Map<string, ChannelTotals>();
  private readonly voiceQueues = new Map<string, number>();
  private readonly history: RuntimeHistoryPoint[] = [];
  private maxQueueBytes = 0;

  private previousTotals = { ...this.totals };
  private previousCpu = process.cpuUsage();
  private previousAt = process.hrtime.bigint();
  private lastSnapshotAt = 0;
  private lastSnapshot: RuntimeMetricsSnapshot | null = null;
  private readonly lagSamples: number[] = [];
  private lagTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.scheduleLagProbe();
  }

  recordInbound(kind: TrafficKind, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.totals.inbound += bytes;
    if (kind === 'voice') this.totals.voiceInbound += bytes;
    else this.totals.controlInbound += bytes;
  }

  recordConnection(kind: keyof typeof this.connections, delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.connections[kind] = Math.max(0, this.connections[kind] + Math.trunc(delta));
  }

  recordVoiceTransport(kind: VoiceTransportKind, delta: number): void {
    this.recordConnection(kind === 'ws' ? 'voiceWebSocket' : 'voiceQuic', delta);
  }

  recordVoiceQueue(id: string, bytes: number): void {
    if (!id) return;
    const value = Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : 0;
    if (value === 0) this.voiceQueues.delete(id);
    else this.voiceQueues.set(id, value);
    this.maxQueueBytes = Math.max(this.maxQueueBytes, value);
  }

  releaseVoiceQueue(id: string): void {
    if (id) this.voiceQueues.delete(id);
  }

  recordVoiceHandshake(edgeId: string, durationMs: number, success: boolean, reason = ''): void {
    const edge = this.edge(edgeId);
    edge.lastSeenAt = Date.now();
    edge.handshakeAttempts++;
    if (success) {
      edge.handshakeSuccesses++;
      edge.lastSuccessAt = Date.now();
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        edge.handshakeDurations.push(Math.min(60_000, durationMs));
        if (edge.handshakeDurations.length > 256) edge.handshakeDurations.shift();
      }
    } else {
      edge.handshakeFailures++;
      edge.lastFailure = reason.slice(0, 160);
      edge.lastFailureAt = Date.now();
    }
  }

  recordEdgeUpstream(edgeId: string, delta: number): void {
    const edge = this.edge(edgeId);
    edge.upstreams = Math.max(0, edge.upstreams + Math.trunc(delta));
    edge.connected = edge.upstreams > 0;
    edge.lastSeenAt = Date.now();
    this.recordConnection('edgeUpstreams', delta);
  }

  recordEdgeAvailability(edgeId: string, available: boolean): void {
    const edge = this.edge(edgeId);
    edge.available = available;
    edge.lastSeenAt = Date.now();
  }

  recordEdgeSession(edgeId: string, delta: number): void {
    const edge = this.edge(edgeId);
    edge.sessions = Math.max(0, edge.sessions + Math.trunc(delta));
    this.recordConnection('edgeSessions', delta);
  }

  recordEdgeTraffic(edgeId: string, direction: 'inbound' | 'outbound', bytes: number, dropped = false): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const edge = this.edge(edgeId);
    if (dropped) {
      edge.droppedPackets++;
      edge.droppedBytes += bytes;
      return;
    }
    if (direction === 'inbound') edge.inboundBytes += bytes;
    else edge.outboundBytes += bytes;
  }

  updateEdgeVoiceTelemetry(edgeId: string, report: EdgeVoiceTelemetry): void {
    const edge = this.edge(edgeId);
    const now = Date.now();
    if (edge.telemetryBootId !== report.bootId || !edge.localVoice) {
      edge.telemetryBootId = report.bootId;
      edge.localVoice = { reportedAt: now, droppedPackets: 0, droppedBytes: 0, clients: [] };
    }
    const local = edge.localVoice;
    const packets = Math.max(0, report.droppedPackets - local.droppedPackets);
    const bytes = Math.max(0, report.droppedBytes - local.droppedBytes);
    edge.droppedPackets += packets;
    edge.droppedBytes += bytes;
    this.totals.voiceDroppedPackets += packets;
    this.totals.voiceDroppedBytes += bytes;
    local.droppedPackets = Math.max(local.droppedPackets, report.droppedPackets);
    local.droppedBytes = Math.max(local.droppedBytes, report.droppedBytes);
    local.reportedAt = now;
    local.clients = local.clients.filter((c) => now - c.reportedAt < 120_000
      && c.sessionId !== report.client?.sessionId);
    if (report.client) local.clients.push({ ...report.client, reportedAt: now });
    // Bound retained diagnostics, including recently disconnected sessions.
    if (local.clients.length > 256) local.clients.splice(0, local.clients.length - 256);
    this.persistEdgeTelemetry(edgeId, report);
  }

  private persistEdgeTelemetry(edgeId: string, report: EdgeVoiceTelemetry): void {
    const day = new Date().toISOString().slice(0, 10);
    const file = join(config.dataDir, `voice-telemetry-${day}.jsonl`);
    const record = JSON.stringify({ at: Date.now(), edgeId, ...report }) + '\n';
    // Keep writes ordered without blocking the voice path. A single daily file
    // is easy to copy after an incident and remains append-only for recovery.
    this.telemetryWrite = this.telemetryWrite
      .then(() => mkdir(config.dataDir, { recursive: true }))
      .then(() => appendFile(file, record, 'utf8'))
      .catch(() => undefined);
  }

  /**
   * Visão compacta usada pelo seletor de rota no handshake do cliente.
   * Diferente do snapshot completo, não calcula CPU, memória ou histórico.
   */
  edgeRoutingHealth(): {
    id: string;
    connected: boolean;
    available: boolean;
    lastSeenAt: number;
    sessions: number;
    p95Ms: number;
  }[] {
    return [...this.edges.entries()].map(([id, edge]) => ({
      id,
      connected: edge.connected,
      available: edge.available,
      lastSeenAt: edge.lastSeenAt,
      sessions: edge.sessions,
      p95Ms: edge.reportedP95Ms || percentile(edge.handshakeDurations, 0.95),
    }));
  }

  updateEdgeStatus(edgeId: string, status: {
    attempts: number;
    successes: number;
    failures: number;
    cancelled: number;
    p50Ms: number;
    p95Ms: number;
    sessions: number;
    lastFailure: string;
  }): void {
    const edge = this.edge(edgeId);
    edge.lastSeenAt = Date.now();
    const sessions = Math.max(0, Math.trunc(status.sessions));
    this.recordConnection('edgeSessions', sessions - edge.sessions);
    edge.sessions = sessions;
    edge.handshakeAttempts = Math.max(0, Math.trunc(status.attempts));
    edge.handshakeSuccesses = Math.max(0, Math.trunc(status.successes));
    edge.handshakeFailures = Math.max(0, Math.trunc(status.failures));
    edge.handshakeCancelled = Math.max(0, Math.trunc(status.cancelled));
    edge.reportedP50Ms = finiteNonNegative(status.p50Ms);
    edge.reportedP95Ms = finiteNonNegative(status.p95Ms);
    if (status.lastFailure) {
      edge.lastFailure = status.lastFailure.slice(0, 160);
      if (edge.handshakeFailures > edge.reportedFailureCount) edge.lastFailureAt = Date.now();
    }
    if (edge.handshakeSuccesses > edge.reportedSuccessCount) edge.lastSuccessAt = Date.now();
    edge.reportedFailureCount = edge.handshakeFailures;
    edge.reportedSuccessCount = edge.handshakeSuccesses;
  }

  recordOutbound(kind: TrafficKind, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.totals.outbound += bytes;
    if (kind === 'voice') this.totals.voiceOutbound += bytes;
    else this.totals.controlOutbound += bytes;
  }

  /**
   * Registra uma entrega de voz inteira. O hot path pode fazer uma unica
   * atualizacao para os N destinatarios, em vez de repetir os mesmos testes
   * de tipo e validade para cada socket.
   */
  recordVoiceFanout(bytes: number, recipients: number, channelKey = ''): void {
    if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isInteger(recipients) || recipients <= 0) return;
    this.totals.outbound += bytes * recipients;
    this.totals.voiceOutbound += bytes * recipients;
    this.totals.voiceFanoutFrames++;
    this.totals.voiceFanoutRecipients += recipients;
    if (channelKey) {
      const [serverRaw, channelRaw] = channelKey.split(':');
      const serverId = Number(serverRaw);
      const channelId = Number(channelRaw);
      if (Number.isInteger(serverId) && Number.isInteger(channelId)) {
        const channel = this.channels.get(channelKey) ?? { serverId, channelId, frames: 0, recipients: 0 };
        channel.frames++;
        channel.recipients += recipients;
        this.channels.set(channelKey, channel);
        if (this.channels.size > 256) {
          const first = this.channels.keys().next().value as string | undefined;
          if (first) this.channels.delete(first);
        }
      }
    }
  }

  recordVoiceDrop(bytes: number, edgeId = ''): void {
    this.recordVoiceDrops(bytes, 1, edgeId);
  }

  recordVoiceDrops(bytes: number, count: number, edgeId = ''): void {
    if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(count) || count <= 0) return;
    const packets = Math.trunc(count);
    if (packets <= 0) return;
    this.totals.voiceDroppedPackets += packets;
    this.totals.voiceDroppedBytes += bytes * packets;
    if (edgeId) {
      const edge = this.edge(edgeId);
      edge.droppedPackets += packets;
      edge.droppedBytes += bytes * packets;
    }
  }

  snapshot(now = Date.now()): RuntimeMetricsSnapshot {
    // O SSE envia para todos os assinantes; uma amostra por segundo evita que
    // a quantidade de abas abertas altere a leitura de CPU e banda.
    if (this.lastSnapshot && now - this.lastSnapshotAt < 1000) return this.lastSnapshot;

    const currentAt = process.hrtime.bigint();
    const elapsedMicros = Math.max(1, Number(currentAt - this.previousAt) / 1000);
    const cpu = process.cpuUsage();
    const cpuMicros = (cpu.user - this.previousCpu.user) + (cpu.system - this.previousCpu.system);
    const cpuCount = Math.max(1, os.cpus().length);
    const elapsedSeconds = elapsedMicros / 1_000_000;
    const inboundDelta = this.totals.inbound - this.previousTotals.inbound;
    const outboundDelta = this.totals.outbound - this.previousTotals.outbound;
    const inboundBytesPerSec = Math.max(0, inboundDelta / elapsedSeconds);
    const outboundBytesPerSec = Math.max(0, outboundDelta / elapsedSeconds);
    const memory = process.memoryUsage();
    const systemTotalBytes = os.totalmem();
    const systemFreeBytes = os.freemem();
    const systemUsedPercent = systemTotalBytes > 0
      ? Math.max(0, Math.min(100, ((systemTotalBytes - systemFreeBytes) / systemTotalBytes) * 100))
      : 0;
    const lag = this.lagSamples.at(-1) ?? 0;
    const sortedLag = [...this.lagSamples].sort((a, b) => a - b);
    const lagP95 = sortedLag.length > 0
      ? sortedLag[Math.min(sortedLag.length - 1, Math.ceil(sortedLag.length * 0.95) - 1)] ?? 0
      : 0;

    this.previousAt = currentAt;
    this.previousCpu = cpu;
    this.previousTotals = { ...this.totals };
    this.lastSnapshotAt = now;
    const point: RuntimeHistoryPoint = {
      at: now,
      processCpuPercent: round(Math.max(0, (cpuMicros / elapsedMicros) * 100)),
      eventLoopLagP95Ms: round(lagP95),
      voiceFanoutRecipients: this.totals.voiceFanoutRecipients,
      voiceDroppedPackets: this.totals.voiceDroppedPackets,
      voiceQueuedBytes: [...this.voiceQueues.values()].reduce((sum, value) => sum + value, 0),
    };
    this.history.push(point);
    if (this.history.length > 60) this.history.shift();
    this.lastSnapshot = {
      at: now,
      uptimeSec: Math.round(process.uptime()),
      cpuCount,
      // O percentual principal e relativo a um core: o trabalho do Node fica
      // concentrado no event loop. 100% aqui significa um core ocupado; a
      // referencia equivalente na maquina inteira fica em hostCpuPercent.
      processCpuPercent: Math.max(0, (cpuMicros / elapsedMicros) * 100),
      hostCpuPercent: Math.max(0, (cpuMicros / (elapsedMicros * cpuCount)) * 100),
      eventLoopLagMs: round(lag),
      eventLoopLagP95Ms: round(lagP95),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        systemTotalBytes,
        systemFreeBytes,
        systemUsedPercent: round(systemUsedPercent),
      },
      traffic: {
        inboundBytesPerSec: round(inboundBytesPerSec),
        outboundBytesPerSec: round(outboundBytesPerSec),
        inboundKbps: round((inboundBytesPerSec * 8) / 1000),
        outboundKbps: round((outboundBytesPerSec * 8) / 1000),
        inboundBytesTotal: this.totals.inbound,
        outboundBytesTotal: this.totals.outbound,
        controlInboundBytesTotal: this.totals.controlInbound,
        controlOutboundBytesTotal: this.totals.controlOutbound,
        voiceInboundBytesTotal: this.totals.voiceInbound,
        voiceOutboundBytesTotal: this.totals.voiceOutbound,
        voiceFanoutFramesTotal: this.totals.voiceFanoutFrames,
        voiceFanoutRecipientsTotal: this.totals.voiceFanoutRecipients,
        voiceDroppedPacketsTotal: this.totals.voiceDroppedPackets,
        voiceDroppedBytesTotal: this.totals.voiceDroppedBytes,
      },
      connections: { ...this.connections },
      voice: {
        queuedBytes: point.voiceQueuedBytes,
        queuedClients: this.voiceQueues.size,
        maxQueueBytes: this.maxQueueBytes,
        channelFanout: [...this.channels.values()]
          .sort((a, b) => b.recipients - a.recipients)
          .slice(0, 12)
          .map((channel) => ({
            key: `${channel.serverId}:${channel.channelId}`,
            serverId: channel.serverId,
            channelId: channel.channelId,
            frames: channel.frames,
            recipients: channel.recipients,
            averageRecipients: channel.frames > 0 ? round(channel.recipients / channel.frames) : 0,
          })),
      },
      // IDs edge-mux-N eram provisórios e podiam se acumular a cada
      // reconexão. Mantemos uma janela curta para diagnóstico e depois
      // removemos apenas os que estão desconectados; edges nomeados continuam
      // visíveis mesmo quando offline.
      edges: [...this.edges.entries()]
        .filter(([id, edge]) => !isLegacyEdgeId(id)
          || edge.connected
          || edge.available
          || now - edge.lastSeenAt < LEGACY_EDGE_TTL_MS)
        .map(([id, edge]) => ({
        id,
        connected: edge.connected,
        available: edge.available,
        lastSeenAt: edge.lastSeenAt,
        upstreams: edge.upstreams,
        sessions: edge.sessions,
        localVoice: edge.localVoice ? { ...edge.localVoice,
          clients: edge.localVoice.clients.filter((c) => now - c.reportedAt < 120_000)
            .map((c) => ({ ...c })) } : null,
        handshakes: {
          attempts: edge.handshakeAttempts,
          successes: edge.handshakeSuccesses,
          failures: edge.handshakeFailures,
          cancelled: edge.handshakeCancelled,
          successRate: edge.handshakeAttempts > 0
            ? round((edge.handshakeSuccesses / edge.handshakeAttempts) * 100)
            : 0,
          p50Ms: edge.reportedP50Ms || percentile(edge.handshakeDurations, 0.5),
          p95Ms: edge.reportedP95Ms || percentile(edge.handshakeDurations, 0.95),
          lastFailure: edge.lastFailure,
          lastFailureAt: edge.lastFailureAt,
          lastSuccessAt: edge.lastSuccessAt,
        },
        traffic: {
          inboundBytesTotal: edge.inboundBytes,
          outboundBytesTotal: edge.outboundBytes,
          droppedPackets: edge.droppedPackets,
          droppedBytes: edge.droppedBytes,
        },
        })),
      history: this.history.map((item) => ({ ...item })),
    };
    return this.lastSnapshot;
  }

  private edge(id: string): EdgeTotals {
    const key = id.trim() || 'origin';
    const existing = this.edges.get(key);
    if (existing) return existing;
    const created: EdgeTotals = {
      connected: false,
      available: false,
      lastSeenAt: 0,
      upstreams: 0,
      sessions: 0,
      handshakeAttempts: 0,
      handshakeSuccesses: 0,
      handshakeFailures: 0,
      handshakeCancelled: 0,
      handshakeDurations: [],
      lastFailure: '',
      lastFailureAt: 0,
      lastSuccessAt: 0,
      reportedP50Ms: 0,
      reportedP95Ms: 0,
      reportedFailureCount: 0,
      reportedSuccessCount: 0,
      inboundBytes: 0,
      outboundBytes: 0,
      droppedPackets: 0,
      droppedBytes: 0,
      telemetryBootId: '',
      localVoice: null,
    };
    this.edges.set(key, created);
    return created;
  }

  private scheduleLagProbe(): void {
    const expected = performance.now() + 1000;
    this.lagTimer = setTimeout(() => {
      const sample = Math.max(0, performance.now() - expected);
      this.lagSamples.push(sample);
      if (this.lagSamples.length > 60) this.lagSamples.shift();
      this.scheduleLagProbe();
    }, 1000);
    this.lagTimer.unref?.();
  }
}

export const serverMetrics = new RuntimeMetricsCollector();

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], rank: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * rank) - 1));
  return round(sorted[index] ?? 0);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, round(value)) : 0;
}

function isLegacyEdgeId(id: string): boolean {
  return /^edge-mux-\d+$/i.test(id);
}
