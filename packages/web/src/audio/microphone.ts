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
  bitrate: 32_000,
  activation: 'voice',
  threshold: 0.02,
};

const FRAME_SAMPLES = 960; // 20ms a 48kHz
const FRAME_US = 20_000;
/** Continua transmitindo por um tempo apos a voz cair, para nao cortar finais. */
const HANGOVER_MS = 350;

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
    this.settings = { ...settings };

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this.encoder = new AudioEncoder({
      output: (chunk) => this.onEncoded(chunk),
      error: (err) => console.error('[vox] encoder:', err),
    });
    this.encoder.configure(this.encoderConfig());

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
        complexity: 5,
      },
    } as AudioEncoderConfig;
  }

  /** Troca de bitrate sem derrubar a captura. */
  reconfigure(patch: Partial<MicSettings>): void {
    const before = this.settings;
    this.settings = { ...before, ...patch };
    if (this.encoder && this.encoder.state === 'configured' && patch.bitrate !== undefined) {
      this.encoder.configure(this.encoderConfig());
    }
  }

  private onFrame(pcm: Float32Array<ArrayBuffer>): void {
    // RMS do quadro; o pico suavizado alimenta o medidor.
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
    const rms = Math.sqrt(sum / pcm.length);
    this.level = this.level * 0.7 + Math.min(1, rms * 4) * 0.3;

    const now = performance.now();
    let active: boolean;
    if (this.muted) {
      active = false;
    } else if (this.settings.activation === 'ptt') {
      active = this.pttDown;
    } else {
      if (rms >= this.settings.threshold) this.hangoverUntil = now + HANGOVER_MS;
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
    if (chunk.byteLength > MAX_VOICE_PAYLOAD) return;

    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    this.send(encodeVoice(this.seq, flags, payload));
    this.seq = (this.seq + 1) & 0xffff;
  }

  async stop(): Promise<void> {
    this.transmitting = false;
    this.level = 0;
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
