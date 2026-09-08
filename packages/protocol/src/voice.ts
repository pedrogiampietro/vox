/**
 * Pacote de voz - o caminho quente do protocolo.
 *
 * Layout (identico nos dois sentidos, 6 bytes de cabecalho):
 *
 *   offset  tam  campo
 *   0       1    FrameKind.Voice
 *   1       2    clientId  (u16 LE)
 *   3       2    seq       (u16 LE, com wrap)
 *   5       1    flags     (VoiceFlags)
 *   6       n    payload Opus
 *
 * O cliente envia clientId = 0; o servidor carimba o id real com uma escrita
 * de 2 bytes no lugar e reencaminha o MESMO buffer para todo mundo no canal.
 * Zero copia e zero realocacao por destinatario, que e o que mantem o
 * servidor barato.
 */

import { FrameKind } from './types.js';

export const VOICE_HEADER_SIZE = 6;

/** Limite de frames agrupados em uma mensagem WebSocket. */
export const MAX_VOICE_BATCH_FRAMES = 16;
/** Mantem o lote pequeno para nao acumular latencia nem ocupar a fila. */
export const MAX_VOICE_BATCH_BYTES = 8192;

/** Opus a 48kHz mono, 20ms, ate ~64kbps, com folga. Descarta acima disso. */
export const MAX_VOICE_PAYLOAD = 512;
export const MAX_VOICE_PACKET = VOICE_HEADER_SIZE + MAX_VOICE_PAYLOAD;

export interface VoicePacket {
  clientId: number;
  seq: number;
  flags: number;
  /** Vista do buffer original - copie se for guardar. */
  payload: Uint8Array;
}

/** Monta um pacote de voz. O clientId fica zerado para o servidor preencher. */
export function encodeVoice(
  seq: number,
  flags: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(VOICE_HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  out[0] = FrameKind.Voice;
  view.setUint16(1, 0, true);
  view.setUint16(3, seq & 0xffff, true);
  out[5] = flags;
  out.set(payload, VOICE_HEADER_SIZE);
  return out;
}

/** Escreve o remetente no lugar, sem copiar o buffer. */
export function stampSender(frame: Uint8Array, clientId: number): void {
  frame[1] = clientId & 0xff;
  frame[2] = (clientId >>> 8) & 0xff;
}

/** Le um frame de voz. Retorna null se estiver malformado. */
export function decodeVoice(frame: Uint8Array): VoicePacket | null {
  if (frame.length < VOICE_HEADER_SIZE || frame.length > MAX_VOICE_PACKET) return null;
  if (frame[0] !== FrameKind.Voice) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    clientId: view.getUint16(1, true),
    seq: view.getUint16(3, true),
    flags: frame[5]!,
    payload: frame.subarray(VOICE_HEADER_SIZE),
  };
}

/** Agrupa frames ja codificados, reduzindo chamadas de envio no WebSocket. */
export function encodeVoiceBatch(frames: readonly Uint8Array[]): Uint8Array {
  if (frames.length === 0 || frames.length > MAX_VOICE_BATCH_FRAMES) {
    throw new Error('quantidade invalida de frames de voz');
  }
  let total = 2;
  for (const frame of frames) {
    if (!decodeVoice(frame)) throw new Error('frame de voz invalido');
    total += 2 + frame.byteLength;
  }
  if (total > MAX_VOICE_BATCH_BYTES) throw new Error('lote de voz grande demais');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = FrameKind.VoiceBatch;
  out[1] = frames.length;
  let offset = 2;
  for (const frame of frames) {
    view.setUint16(offset, frame.byteLength, true);
    offset += 2;
    out.set(frame, offset);
    offset += frame.byteLength;
  }
  return out;
}

/** Le um lote WebSocket e devolve vistas dos frames sem novas copias. */
export function decodeVoiceBatch(frame: Uint8Array): Uint8Array[] | null {
  if (frame.length < 2 || frame.length > MAX_VOICE_BATCH_BYTES || frame[0] !== FrameKind.VoiceBatch) return null;
  const count = frame[1]!;
  if (count === 0 || count > MAX_VOICE_BATCH_FRAMES) return null;

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const frames: Uint8Array[] = [];
  let offset = 2;
  for (let index = 0; index < count; index++) {
    if (offset + 2 > frame.length) return null;
    const length = view.getUint16(offset, true);
    offset += 2;
    if (length < VOICE_HEADER_SIZE || length > MAX_VOICE_PACKET || offset + length > frame.length) return null;
    const voice = frame.subarray(offset, offset + length);
    if (!decodeVoice(voice)) return null;
    frames.push(voice);
    offset += length;
  }
  return offset === frame.length ? frames : null;
}

/** Distancia entre dois seq u16 respeitando o wrap (positivo = a e mais novo). */
export function seqDelta(a: number, b: number): number {
  return ((a - b + 0x8000) & 0xffff) - 0x8000;
}

