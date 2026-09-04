/**
 * Recepcao de voz: um decodificador e uma saida por pessoa falando.
 *
 * O Web Audio ja soma tudo que chega no destino, entao nao existe "mixagem"
 * nossa - cada remetente vira um no independente com o proprio volume. Isso e
 * o que permite volume por usuario e, mais adiante, posicionamento estereo.
 *
 * O buffer de jitter e dirigido por chegada, nao por temporizador: em
 * transporte ordenado (WebSocket) ele custa zero, e quando a voz migrar para
 * datagramas ele ja reordena ate REORDER_LIMIT pacotes antes de desistir do
 * buraco.
 *
 * Aqui tambem sai a medicao de qualidade da recepcao. Ela e por remetente
 * porque o problema quase sempre e de um link so: mostrar uma media esconde
 * justamente a pessoa que esta ruim.
 */

import { VoiceFlags, seqDelta } from '@vox/protocol';
import type { VoicePacket } from '@vox/protocol';
import { SenderMetrics } from './voice-stats.js';

const FRAME_US = 20_000;
/** Quantos pacotes esperamos por um que ficou para tras antes de pular. */
const REORDER_LIMIT = 4;
/** Sem pacote por esse tempo, a pessoa parou de falar. */
const TALK_TIMEOUT_MS = 400;
/** Remetente sem pacote ha mais que isso sai do agregado. */
const STALE_SENDER_MS = 5_000;

interface RemoteVoice {
  decoder: AudioDecoder;
  node: AudioWorkletNode;
  gain: GainNode;
  timestamp: number;
  /** Proximo seq esperado; -1 antes do primeiro pacote. */
  nextSeq: number;
  pending: Map<number, Uint8Array>;
  lastPacketAt: number;
  volume: number;
  /** Mudo local: nao viaja para o servidor, e decisao de quem ouve. */
  muted: boolean;
  /** Jitter e perda deste remetente; ver voice-stats.ts. */
  metrics: SenderMetrics;
}

/** Qualidade da recepcao de um remetente especifico. */
export interface VoiceSenderStats {
  clientId: number;
  /** Variacao do tempo de chegada (RFC 3550), em ms. */
  jitterMs: number;
  /** Perda na ultima janela medida, em porcentagem. */
  lossPct: number;
  receivedPackets: number;
  /** Buracos no seq desde o inicio: o que nunca chegou. */
  lostPackets: number;
}

export interface VoicePlaybackHealth {
  receivedPackets: number;
  latePackets: number;
  reorderedPackets: number;
  skippedPackets: number;
  /**
   * Pior jitter e pior perda entre quem falou na janela — nao a media. Numa
   * call o que importa e o link que esta ruim, e a media o dilui.
   */
  jitterMs: number;
  lossPct: number;
}

export class VoiceMixer {
  private readonly voices = new Map<number, RemoteVoice>();
  /**
   * Volume e mudo escolhidos para cada pessoa, valendo antes mesmo de ela
   * falar. Guardar aqui evita criar decodificador e no de audio para quem
   * talvez nunca abra o microfone.
   */
  private readonly prefs = new Map<number, { volume: number; muted: boolean }>();
  readonly master: GainNode;
  readonly health: VoicePlaybackHealth = {
    receivedPackets: 0,
    latePackets: 0,
    reorderedPackets: 0,
    skippedPackets: 0,
    jitterMs: 0,
    lossPct: 0,
  };
  private recordTap: AudioNode | null = null;
  private outputVolume = 1;
  private outputPreamp = 1;

  constructor(private readonly ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  static get supported(): boolean {
    return typeof AudioDecoder !== 'undefined';
  }

  set volume(v: number) {
    this.outputVolume = v;
    this.applyMasterGain();
  }

  /** Preamp real da reproducao, limitado para evitar ganho descontrolado. */
  set preamp(v: number) {
    this.outputPreamp = Math.min(2, Math.max(0.5, v));
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    this.master.gain.value = this.outputVolume * this.outputPreamp;
  }

  /** Liga/desliga a saída mixada a um gravador local, sem afetar os speakers. */
  setRecordTap(tap: AudioNode | null): void {
    if (this.recordTap === tap) return;
    if (this.recordTap) this.master.disconnect(this.recordTap);
    this.recordTap = tap;
    if (tap) this.master.connect(tap);
  }

  push(packet: VoicePacket): void {
    if (packet.payload.length === 0) return;
    this.health.receivedPackets++;
    const voice = this.ensure(packet.clientId);
    const arrival = performance.now();
    voice.metrics.observe(packet.seq, arrival);
    voice.lastPacketAt = arrival;

    if (voice.nextSeq < 0) voice.nextSeq = packet.seq;

    const delta = seqDelta(packet.seq, voice.nextSeq);
    if (delta < 0) {
      this.health.latePackets++;
      return; // chegou tarde demais, ja tocamos por cima
    }

    // copyTo do EncodedAudioChunk exige memoria propria; a view veio do socket.
    const payload = packet.payload.slice();

    if (delta === 0) {
      this.feed(voice, payload);
      voice.nextSeq = (voice.nextSeq + 1) & 0xffff;
      this.drain(voice);
    } else {
      this.health.reorderedPackets++;
      voice.pending.set(packet.seq, payload);
      if (voice.pending.size > REORDER_LIMIT) this.skipGap(voice);
    }

    if (packet.flags & VoiceFlags.EndOfTalk) this.flushPending(voice);
  }

  /** Entrega tudo que ja da para tocar em sequencia. */
  private drain(voice: RemoteVoice): void {
    for (;;) {
      const next = voice.pending.get(voice.nextSeq);
      if (!next) return;
      voice.pending.delete(voice.nextSeq);
      this.feed(voice, next);
      voice.nextSeq = (voice.nextSeq + 1) & 0xffff;
    }
  }

  /** Desiste do pacote perdido e retoma no mais antigo que temos guardado. */
  private skipGap(voice: RemoteVoice): void {
    let oldest = -1;
    for (const seq of voice.pending.keys()) {
      if (oldest < 0 || seqDelta(seq, oldest) < 0) oldest = seq;
    }
    if (oldest < 0) return;
    this.health.skippedPackets++;
    voice.nextSeq = oldest;
    this.drain(voice);
  }

  private flushPending(voice: RemoteVoice): void {
    while (voice.pending.size > 0) this.skipGap(voice);
  }

  private feed(voice: RemoteVoice, payload: Uint8Array): void {
    if (voice.decoder.state !== 'configured') return;
    voice.decoder.decode(
      new EncodedAudioChunk({
        type: 'key', // todo quadro Opus e independente
        timestamp: voice.timestamp,
        duration: FRAME_US,
        data: payload,
      }),
    );
    voice.timestamp += FRAME_US;
  }

  private ensure(clientId: number): RemoteVoice {
    const existing = this.voices.get(clientId);
    if (existing) return existing;

    const pref = this.prefs.get(clientId) ?? { volume: 1, muted: false };

    const node = new AudioWorkletNode(this.ctx, 'vox-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const gain = this.ctx.createGain();
    node.connect(gain).connect(this.master);

    const voice: RemoteVoice = {
      decoder: null as unknown as AudioDecoder,
      node,
      gain,
      timestamp: 0,
      nextSeq: -1,
      pending: new Map(),
      lastPacketAt: 0,
      volume: pref.volume,
      muted: pref.muted,
      metrics: new SenderMetrics(),
    };
    gain.gain.value = pref.muted ? 0 : pref.volume;

    voice.decoder = new AudioDecoder({
      output: (data) => {
        const pcm = new Float32Array(data.numberOfFrames);
        data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
        data.close();
        node.port.postMessage(pcm, [pcm.buffer]);
      },
      error: (err) => console.error(`[vox] decoder ${clientId}:`, err),
    });
    voice.decoder.configure({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });

    this.voices.set(clientId, voice);
    return voice;
  }

  // ------------------------------------------------------------- medicao --

  /**
   * Fecha a janela de medicao e atualiza o agregado. Quem chama define a
   * cadencia — a cada dois segundos ja da um numero estavel sem custar nada.
   */
  sample(): VoiceSenderStats[] {
    const now = performance.now();
    const stats: VoiceSenderStats[] = [];
    let worstJitter = 0;
    let worstLoss = 0;

    for (const [clientId, voice] of this.voices) {
      if (!voice.metrics.hasData) continue;
      const snapshot = voice.metrics.closeWindow();
      // Quem parou de falar ha muito tempo nao deve continuar pesando no
      // numero que aparece no header.
      if (now - voice.lastPacketAt < STALE_SENDER_MS) {
        worstJitter = Math.max(worstJitter, snapshot.jitterMs);
        worstLoss = Math.max(worstLoss, snapshot.lossPct);
      }
      stats.push({ clientId, ...snapshot });
    }

    this.health.jitterMs = Math.round(worstJitter * 10) / 10;
    this.health.lossPct = Math.round(worstLoss * 10) / 10;
    return stats;
  }

  setVolume(clientId: number, volume: number): void {
    const pref = this.prefs.get(clientId) ?? { volume: 1, muted: false };
    pref.volume = volume;
    this.prefs.set(clientId, pref);
    const voice = this.voices.get(clientId);
    if (voice) {
      voice.volume = volume;
      this.applyGain(voice);
    }
  }

  setMuted(clientId: number, muted: boolean): void {
    const pref = this.prefs.get(clientId) ?? { volume: 1, muted: false };
    pref.muted = muted;
    this.prefs.set(clientId, pref);
    const voice = this.voices.get(clientId);
    if (voice) {
      voice.muted = muted;
      this.applyGain(voice);
    }
  }

  /** Mudo vence volume: silencio e silencio, sem meio termo. */
  private applyGain(voice: RemoteVoice): void {
    voice.gain.gain.value = voice.muted ? 0 : voice.volume;
  }

  isTalking(clientId: number): boolean {
    const voice = this.voices.get(clientId);
    if (!voice) return false;
    return performance.now() - voice.lastPacketAt < TALK_TIMEOUT_MS;
  }

  remove(clientId: number): void {
    const voice = this.voices.get(clientId);
    if (!voice) return;
    this.voices.delete(clientId);
    voice.node.port.postMessage(null);
    voice.node.disconnect();
    voice.gain.disconnect();
    try {
      if (voice.decoder.state !== 'closed') voice.decoder.close();
    } catch {
      // ja fechado
    }
  }

  clear(): void {
    for (const id of [...this.voices.keys()]) this.remove(id);
    this.prefs.clear();
  }
}
