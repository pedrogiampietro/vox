import type { EdgeClientTelemetry } from '@vox/protocol';

/** Counts our actual discards. A resolved QUIC write is not a delivery ACK. */
export class VoiceDelivery {
  readonly counters: EdgeClientTelemetry;
  private closed = false;

  constructor(clientId: number, sessionId: string,
    private readonly write: (frame: Uint8Array) => Promise<void>,
    private readonly onDrop: (bytes: number) => void,
    private readonly onError: () => void,
  ) {
    this.counters = { clientId, sessionId, receivedPackets: 0, submittedPackets: 0,
      backpressureDrops: 0, writeErrors: 0, upstreamDrops: 0, inflight: 0, peakInflight: 0 };
  }

  send(frame: Uint8Array): void {
    if (this.closed) return;
    if (this.counters.inflight >= 8) {
      this.counters.backpressureDrops++;
      this.onDrop(frame.byteLength);
      return;
    }
    this.counters.inflight++;
    this.counters.peakInflight = Math.max(this.counters.peakInflight, this.counters.inflight);
    void this.submit(frame);
  }

  private async submit(frame: Uint8Array): Promise<void> {
    try {
      await this.write(frame);
      this.counters.submittedPackets++;
    } catch {
      this.counters.writeErrors++;
      this.onDrop(frame.byteLength);
      this.onError();
    } finally {
      this.counters.inflight--;
    }
  }

  close(): void { this.closed = true; }
}
