/**
 * Captura e codificacao de voz.
 *
 * Usa WebCodecs (AudioEncoder) em vez de libopus em WASM: o Opus ja esta
 * dentro do navegador, entao nao baixamos nem um byte de codec e a codificacao
 * roda em codigo nativo. O AEC, a supressao de ruido e o AGC vem de graca das
 * constraints do getUserMedia - sao os mesmos do WebRTC.
 */

import { MAX_VOICE_PAYLOAD, VoiceFlags, encodeVoice } from '@vox/protocol';

export interface MicSettings {
  /** '' = dispositivo padrao do sistema. */
  deviceId: string;
  bitrate: number;
  activation: 'voice' | 'ptt';
  /** Limiar de RMS para deteccao de voz, 0..1. */
  threshold: number;
}

export const DEFAULT_MIC: MicSettings = {
  deviceId: '',
  // 48 kbps is a good speech-quality target while keeping the realtime
  // transport light. 64 kbps remains available in the settings UI.
  bitrate: 48_000,
  activation: 'voice',
  threshold: 0.02,
};

const FRAME_SAMPLES = 960; // 20ms a 48kHz
const FRAME_US = 20_000;
/** Continua transmitindo apos uma queda curta, para nao cortar finais/silabas. */
const HANGOVER_MS = 550;
/** A fala pode cair abaixo do limiar de inicio sem encerrar imediatamente. */
const STOP_THRESHOLD_RATIO = 0.65;
/** Suavizacao assimetrica: ataque rapido, soltura lenta. */
const VAD_ATTACK = 0.45;
const VAD_RELEASE = 0.12;
const MIN_CALIBRATED_THRESHOLD = 0.012;
const MAX_CALIBRATED_THRESHOLD = 0.08;

export interface MicHealth {
  /** Quadros PCM recebidos do AudioWorklet. */
  capturedFrames: number;
  /** Quadros aceitos pelo encoder e enviados ao transporte. */
  encodedFrames: number;
  /** Quadros que precisaram ser descartados por excesso de payload. */
  droppedFrames: number;
  /** Maior fila observada no AudioEncoder. */
  maxEncoderQueue: number;
  /** Maior intervalo entre quadros recebidos do AudioWorklet. */
  maxCaptureGapMs: number;
}

interface Calibration {
  until: number;
  sum: number;
  frames: number;
  resolve: (threshold: number | null) => void;
}

export class Microphone {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private encoder: AudioEncoder | null = null;

  private seq = 0;
  private timestamp = 0;
  /** Flags na ordem das chamadas de encode, casadas com as saidas. */
  private readonly pending: number[] = [];
  private hangoverUntil = 0;
  private wasTransmitting = false;
  private vadLevel = 0;
  private lastFrameAt = 0;
  private calibration: Calibration | null = null;

  readonly health: MicHealth = {
    capturedFrames: 0,
    encodedFrames: 0,
    droppedFrames: 0,
    maxEncoderQueue: 0,
    maxCaptureGapMs: 0,
  };

  /** Nivel suavizado 0..1, para o medidor da interface. */
  level = 0;
  /** Verdadeiro enquanto estiver realmente mandando pacotes. */
  transmitting = false;
  /** Tecla de push-to-talk pressionada. */
  pttDown = false;
  /** Microfone silenciado pelo usuario. */
  muted = false;

  settings: MicSettings = { ...DEFAULT_MIC };

  static get supported(): boolean {
    return typeof AudioEncoder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  constructor(private readonly send: (frame: Uint8Array) => void) {}

  async start(ctx: AudioContext, settings: MicSettings): Promise<void> {
    await this.stop();
    this.settings = normalizeSettings(settings);

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}),
        channelCount: 1,
        sampleRate: { ideal: 48_000 },
        sampleSize: { ideal: 16 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    const encoder = new AudioEncoder({
      output: (chunk) => this.onEncoded(chunk),
      error: (err) => console.error('[vox] encoder:', err),
    });
    this.encoder = encoder;
    encoder.configure(this.encoderConfig());

    this.source = ctx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(ctx, 'vox-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.worklet.port.onmessage = (ev: MessageEvent<Float32Array<ArrayBuffer>>) => this.onFrame(ev.data);
    this.source.connect(this.worklet);
  }

  private encoderConfig(): AudioEncoderConfig {
    return {
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 1,
      bitrate: this.settings.bitrate,
      opus: {
        // 'voip' privilegia inteligibilidade da fala sobre fidelidade musical.
        application: 'voip',
        frameDuration: FRAME_US,
        // FEC embutido: parte do quadro anterior viaja junto e cobre perdas.
        useinbandfec: true,
        packetlossperc: 10,
        complexity: 10,
      },
    } as AudioEncoderConfig;
  }

  /** Troca de bitrate sem derrubar a captura. */
  reconfigure(patch: Partial<MicSettings>): void {
    const before = this.settings;
    this.settings = normalizeSettings({ ...before, ...patch });
    if (this.encoder && this.encoder.state === 'configured' && patch.bitrate !== undefined) {
      this.encoder.configure(this.encoderConfig());
    }
  }

  /**
   * Mede o ruido ambiente por alguns instantes e sugere um limiar de voz.
   * Enquanto mede, nada e transmitido. Retorna null quando a captura ainda
   * nao foi iniciada.
   */
  calibrateThreshold(durationMs = 1500): Promise<number | null> {
    if (!this.stream || !this.worklet) return Promise.resolve(null);
    if (this.calibration) return Promise.resolve(null);

    return new Promise((resolve) => {
      const calibration: Calibration = {
        until: performance.now() + durationMs,
        sum: 0,
        frames: 0,
        resolve,
      };
      this.calibration = calibration;
      setTimeout(() => {
        if (this.calibration === calibration) this.finishCalibration(calibration);
      }, durationMs + 100);
    });
  }

  private finishCalibration(calibration: Calibration): void {
    if (this.calibration !== calibration) return;
    this.calibration = null;
    if (calibration.frames === 0) {
      calibration.resolve(null);
      return;
    }
    const noise = calibration.sum / calibration.frames;
    const threshold = clamp(noise * 2.5, MIN_CALIBRATED_THRESHOLD, MAX_CALIBRATED_THRESHOLD);
    calibration.resolve(threshold);
  }

  private onFrame(pcm: Float32Array<ArrayBuffer>): void {
    const now = performance.now();
    this.health.capturedFrames++;
    if (this.lastFrameAt > 0) {
      this.health.maxCaptureGapMs = Math.max(this.health.maxCaptureGapMs, now - this.lastFrameAt);
    }
    this.lastFrameAt = now;

    // RMS do quadro; o nivel suavizado alimenta o medidor e o VAD.
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
    const rms = Math.sqrt(sum / pcm.length);
    const normalized = Math.min(1, rms * 4);
    this.level = this.level * 0.7 + normalized * 0.3;
    const vadWeight = rms >= this.vadLevel ? VAD_ATTACK : VAD_RELEASE;
    this.vadLevel += (rms - this.vadLevel) * vadWeight;

    const calibration = this.calibration;
    if (calibration) {
      calibration.sum += rms;
      calibration.frames++;
      if (now >= calibration.until) this.finishCalibration(calibration);
      this.transmitting = false;
      return;
    }

    let active: boolean;
    if (this.muted) {
      active = false;
    } else if (this.settings.activation === 'ptt') {
      active = this.pttDown;
    } else {
      const startThreshold = this.settings.threshold;
      const stopThreshold = startThreshold * STOP_THRESHOLD_RATIO;
      const threshold = this.wasTransmitting ? stopThreshold : startThreshold;
      if (this.vadLevel >= threshold) this.hangoverUntil = now + HANGOVER_MS;
      active = now < this.hangoverUntil;
    }

    if (!active) {
      // Marca a ultima saida pendente como fim de fala, se houver.
      if (this.wasTransmitting && this.pending.length > 0) {
        this.pending[this.pending.length - 1] = VoiceFlags.EndOfTalk;
      }
      this.wasTransmitting = false;
      this.transmitting = false;
      return;
    }

    const encoder = this.encoder;
    if (!encoder || encoder.state !== 'configured') return;

    this.transmitting = true;
    this.wasTransmitting = true;
    this.pending.push(VoiceFlags.None);
    this.health.maxEncoderQueue = Math.max(this.health.maxEncoderQueue, encoder.encodeQueueSize);

    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: 48_000,
      numberOfFrames: FRAME_SAMPLES,
      numberOfChannels: 1,
      timestamp: this.timestamp,
      data: pcm,
    });
    this.timestamp += FRAME_US;
    encoder.encode(data);
    data.close();
  }

  private onEncoded(chunk: EncodedAudioChunk): void {
    const flags = this.pending.shift() ?? VoiceFlags.None;
    if (chunk.byteLength > MAX_VOICE_PAYLOAD) {
      this.health.droppedFrames++;
      return;
    }

    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    this.send(encodeVoice(this.seq, flags, payload));
    this.health.encodedFrames++;
    this.seq = (this.seq + 1) & 0xffff;
  }

  async stop(): Promise<void> {
    this.transmitting = false;
    this.level = 0;
    this.vadLevel = 0;
    this.hangoverUntil = 0;
    this.wasTransmitting = false;
    this.lastFrameAt = 0;
    if (this.calibration) {
      const calibration = this.calibration;
      this.calibration = null;
      calibration.resolve(null);
    }
    this.pending.length = 0;

    this.source?.disconnect();
    this.source = null;

    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.encoder) {
      const enc = this.encoder;
      this.encoder = null;
      try {
        if (enc.state === 'configured') await enc.flush();
        enc.close();
      } catch {
        // encoder ja fechado
      }
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }
}

function normalizeSettings(settings: MicSettings): MicSettings {
  return {
    deviceId: settings.deviceId || '',
    bitrate: clamp(Number(settings.bitrate) || DEFAULT_MIC.bitrate, 16_000, 64_000),
    activation: settings.activation === 'ptt' ? 'ptt' : 'voice',
    threshold: clamp(Number(settings.threshold) || DEFAULT_MIC.threshold, 0.005, 0.3),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
