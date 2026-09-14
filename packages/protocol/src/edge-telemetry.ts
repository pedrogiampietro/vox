/** Optional, negotiated on the private edge WebSocket; never sent to players. */
export const EDGE_VOICE_TELEMETRY = 0xfc;
export const EDGE_TELEMETRY_HEADER = 'x-vox-edge-telemetry';

export interface EdgeClientTelemetry {
  clientId: number;
  sessionId: string;
  receivedPackets: number;
  submittedPackets: number;
  backpressureDrops: number;
  writeErrors: number;
  upstreamDrops: number;
  inflight: number;
  peakInflight: number;
}

export interface EdgeVoiceTelemetry {
  bootId: string;
  droppedPackets: number;
  droppedBytes: number;
  client: EdgeClientTelemetry | null;
}

export function encodeEdgeTelemetry(value: EdgeVoiceTelemetry): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const out = new Uint8Array(json.length + 1);
  out[0] = EDGE_VOICE_TELEMETRY;
  out.set(json, 1);
  return out;
}

export function decodeEdgeTelemetry(frame: Uint8Array): EdgeVoiceTelemetry | null {
  if (frame[0] !== EDGE_VOICE_TELEMETRY || frame.length > 2048) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(frame.subarray(1))) as EdgeVoiceTelemetry;
    const counter = (n: unknown): boolean => Number.isSafeInteger(n) && Number(n) >= 0;
    if (!value || typeof value.bootId !== 'string' || !/^[a-f0-9]{16}$/.test(value.bootId)
      || !counter(value.droppedPackets) || !counter(value.droppedBytes)) return null;
    const c = value.client;
    if (c !== null && (!c || !counter(c.clientId) || c.clientId < 1 || c.clientId > 65535
      || typeof c.sessionId !== 'string' || !/^[a-f0-9]{16}$/.test(c.sessionId)
      || ![c.receivedPackets, c.submittedPackets, c.backpressureDrops, c.writeErrors,
        c.upstreamDrops, c.inflight, c.peakInflight].every(counter))) return null;
    return value;
  } catch { return null; }
}
