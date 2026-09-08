import os from 'node:os';
import { performance } from 'node:perf_hooks';

export type TrafficKind = 'control' | 'voice';

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
    voiceDroppedPacketsTotal: number;
    voiceDroppedBytesTotal: number;
  };
}

interface TrafficTotals {
  inbound: number;
  outbound: number;
  controlInbound: number;
  controlOutbound: number;
  voiceInbound: number;
  voiceOutbound: number;
  voiceDroppedPackets: number;
  voiceDroppedBytes: number;
}

/**
 * Metricas leves do processo. Os contadores contam payloads do protocolo, nao
 * cabecalhos TCP/TLS: e o numero que melhor explica o consumo do Vox e tambem
 * funciona quando a voz troca WebSocket por WebTransport.
 */
export class RuntimeMetricsCollector {
  private readonly totals: TrafficTotals = {
    inbound: 0,
    outbound: 0,
    controlInbound: 0,
    controlOutbound: 0,
    voiceInbound: 0,
    voiceOutbound: 0,
    voiceDroppedPackets: 0,
    voiceDroppedBytes: 0,
  };

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

  recordOutbound(kind: TrafficKind, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.totals.outbound += bytes;
    if (kind === 'voice') this.totals.voiceOutbound += bytes;
    else this.totals.controlOutbound += bytes;
  }

  recordVoiceDrop(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.totals.voiceDroppedPackets++;
    this.totals.voiceDroppedBytes += bytes;
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
        voiceDroppedPacketsTotal: this.totals.voiceDroppedPackets,
        voiceDroppedBytesTotal: this.totals.voiceDroppedBytes,
      },
    };
    return this.lastSnapshot;
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
