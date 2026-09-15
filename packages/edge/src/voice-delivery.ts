import type { EdgeClientTelemetry } from '@vox/protocol';
import { performance } from 'node:perf_hooks';

/** Absorve picos curtos sem acumular segundos de áudio atrasado. */
export const MAX_VOICE_INFLIGHT = 24;
const LATENCY_SAMPLES = 64;

/** Counts our actual discards. A resolved QUIC write is not a delivery ACK. */
export class VoiceDelivery {
  readonly counters: EdgeClientTelemetry;
  private closed = false;
  private readonly writeSamples: number[] = [];

  constructor(clientId: number, sessionId: string,
    private readonly write: (frame: Uint8Array) => Promise<void>,
    private readonly onDrop: (bytes: number) => void,
    private readonly onError: () => void,
  ) {
    this.counters = { clientId, sessionId, receivedPackets: 0, submittedPackets: 0,
      backpressureDrops: 0, writeErrors: 0, upstreamDrops: 0, inflight: 0, peakInflight: 0,
      adaptiveLimit: MAX_VOICE_INFLIGHT, writeLatencyMs: 0, writeLatencyP95Ms: 0 };
  }

  send(frame: Uint8Array): void {
    if (this.closed) return;
    this.counters.adaptiveLimit = this.adaptiveLimit();
    if (this.counters.inflight >= this.counters.adaptiveLimit) {
      this.counters.backpressureDrops++;
      this.onDrop(frame.byteLength);
      return;
    }
    this.counters.inflight++;
    this.counters.peakInflight = Math.max(this.counters.peakInflight, this.counters.inflight);
    void this.submit(frame);
  }

  private async submit(frame: Uint8Array): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.write(frame);
      this.counters.submittedPackets++;
    } catch {
      this.counters.writeErrors++;
      this.onDrop(frame.byteLength);
      this.onError();
    } finally {
      this.counters.inflight--;
      this.recordWriteLatency(performance.now() - startedAt);
    }
  }

  private recordWriteLatency(elapsedMs: number): void {
    const elapsed = Math.max(0, Math.min(10_000, elapsedMs));
    this.writeSamples.push(elapsed);
    if (this.writeSamples.length > LATENCY_SAMPLES) this.writeSamples.shift();
    this.counters.writeLatencyMs = round(this.counters.writeLatencyMs === 0
      ? elapsed : this.counters.writeLatencyMs + (elapsed - this.counters.writeLatencyMs) * 0.2);
    const sorted = [...this.writeSamples].sort((a, b) => a - b);
    this.counters.writeLatencyP95Ms = round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0);
    this.counters.adaptiveLimit = this.adaptiveLimit();
  }

  private adaptiveLimit(): number {
    // Em uma escrita lenta, manter 24 datagramas representaria até 480 ms de
    // áudio atrasado. Reduzimos a janela gradualmente e preservamos o áudio
    // mais novo; em rota saudável ela volta ao teto de 24 automaticamente.
    const delay = Math.max(this.counters.writeLatencyMs, this.counters.writeLatencyP95Ms);
    if (delay > 120) return 8;
    if (delay > 70) return 12;
    if (delay > 35) return 18;
    return MAX_VOICE_INFLIGHT;
  }

  close(): void { this.closed = true; }
}

function round(value: number): number { return Math.round(value * 10) / 10; }
