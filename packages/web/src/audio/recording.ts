import type { MicHealth, MicSettings } from './microphone.js';
import type { VoiceQuality, VoiceTransport } from '../net/connection.js';
import type { VoicePlaybackHealth, VoiceSenderStats } from './mixer.js';
import type { VoiceSample } from '../client.js';

export interface RecordingTelemetry {
  transport: VoiceTransport;
  rttMs: number;
  /** RTT medido no caminho dedicado da voz; o RTT de controle pode ser outro. */
  voiceRttMs: number;
  voiceRegion: string;
  voiceQuality: VoiceQuality;
  droppedVoice: number;
  mic: MicSettings & { health: MicHealth };
  playback: VoicePlaybackHealth;
  /** Jitter e perda de cada remetente no instante da leitura. */
  senders: VoiceSenderStats[];
  /**
   * Serie de qualidade ate este instante. Vai nas duas leituras, mas so a do
   * fim cobre a gravacao inteira — e ela que permite comparar dois testes.
   */
  history: VoiceSample[];
}

export interface RecordingReport {
  schema: 2;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  mimeType: string;
  /** O sinal local entra antes do encoder; as vozes remotas entram depois do decoder. */
  signalPath: 'local-mic-vad-gated-pre-encoder-plus-remote-decoded-mix';
  start: RecordingTelemetry;
  end: RecordingTelemetry;
  delta: {
    droppedVoice: number;
    mic: {
      capturedFrames: number;
      encodedFrames: number;
      droppedFrames: number;
      maxEncoderQueue: number;
      maxCaptureGapMs: number;
    };
    playback: {
      receivedPackets: number;
      latePackets: number;
      reorderedPackets: number;
      skippedPackets: number;
    };
  };
  audio: {
    rms: number;
    peak: number;
    clippedSamples: number;
    silenceRatio: number;
  };
}

export interface VoiceRecordingResult {
  audioBlob: Blob;
  reportBlob: Blob;
  audioUrl: string;
  reportUrl: string;
  report: RecordingReport;
}

interface AudioStats {
  sumSquares: number;
  samples: number;
  peak: number;
  clippedSamples: number;
  measuredMs: number;
  silentMs: number;
  lastSampleAt: number;
}

/** Grava a saída do canal sem enviar áudio adicional para o servidor. */
export class VoiceRecorder {
  readonly input: GainNode;

  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly analyser: AnalyserNode;
  private readonly analyserSamples: Float32Array<ArrayBuffer>;
  private readonly ctx: AudioContext;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAtMs = 0;
  private startedAt = '';
  private startTelemetry: RecordingTelemetry | null = null;
  private stats: AudioStats = emptyStats();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    // Uma pequena folga evita que duas vozes simultâneas estourem a gravação.
    this.input.gain.value = 0.85;
    this.destination = ctx.createMediaStreamDestination();
    this.destination.channelCount = 1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyserSamples = new Float32Array(this.analyser.fftSize);
    this.input.connect(this.analyser);
    this.input.connect(this.destination);
  }

  static get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  get elapsedMs(): number {
    return this.startedAtMs > 0 ? performance.now() - this.startedAtMs : 0;
  }

  start(telemetry: RecordingTelemetry): void {
    if (!VoiceRecorder.supported) throw new Error('gravação de áudio não é suportada neste navegador');
    if (this.recording) throw new Error('já existe uma gravação em andamento');

    const mimeType = pickMimeType();
    this.recorder = mimeType
      ? new MediaRecorder(this.destination.stream, { mimeType, audioBitsPerSecond: 128_000 })
      : new MediaRecorder(this.destination.stream);
    this.chunks = [];
    this.stats = emptyStats();
    this.startedAtMs = performance.now();
    this.startedAt = new Date().toISOString();
    this.startTelemetry = cloneTelemetry(telemetry);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start(1000);
    this.timer = setInterval(() => this.sampleAudio(), 100);
  }

  async stop(telemetry: RecordingTelemetry): Promise<VoiceRecordingResult | null> {
    const recorder = this.recorder;
    const startTelemetry = this.startTelemetry;
    if (!recorder || !startTelemetry || recorder.state === 'inactive') return null;

    this.sampleAudio();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error('erro ao finalizar a gravação'));
      try {
        recorder.stop();
      } catch (err) {
        reject(err);
      }
    });

    const endedAt = new Date().toISOString();
    const report: RecordingReport = {
      schema: 2,
      startedAt: this.startedAt,
      endedAt,
      durationMs: Math.max(0, performance.now() - this.startedAtMs),
      mimeType: recorder.mimeType || 'audio/webm',
      signalPath: 'local-mic-vad-gated-pre-encoder-plus-remote-decoded-mix',
      start: startTelemetry,
      end: cloneTelemetry(telemetry),
      delta: makeDelta(startTelemetry, telemetry),
      audio: {
        rms: this.stats.samples > 0 ? Math.sqrt(this.stats.sumSquares / this.stats.samples) : 0,
        peak: this.stats.peak,
        clippedSamples: this.stats.clippedSamples,
        silenceRatio: this.stats.measuredMs > 0 ? this.stats.silentMs / this.stats.measuredMs : 0,
      },
    };
    const audioBlob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
    const reportBlob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const result: VoiceRecordingResult = {
      audioBlob,
      reportBlob,
      audioUrl: URL.createObjectURL(audioBlob),
      reportUrl: URL.createObjectURL(reportBlob),
      report,
    };

    this.recorder = null;
    this.startTelemetry = null;
    this.chunks = [];
    this.startedAtMs = 0;
    return result;
  }

  private sampleAudio(): void {
    if (!this.recording) return;
    this.analyser.getFloatTimeDomainData(this.analyserSamples);
    const now = performance.now();
    const elapsed = this.stats.lastSampleAt > 0 ? Math.max(0, now - this.stats.lastSampleAt) : 0;
    let sum = 0;
    let peak = 0;
    let clipped = 0;
    for (const sample of this.analyserSamples) {
      const magnitude = Math.abs(sample);
      sum += sample * sample;
      peak = Math.max(peak, magnitude);
      if (magnitude >= 0.99) clipped++;
    }
    const rms = Math.sqrt(sum / this.analyserSamples.length);
    this.stats.sumSquares += sum;
    this.stats.samples += this.analyserSamples.length;
    this.stats.peak = Math.max(this.stats.peak, peak);
    this.stats.clippedSamples += clipped;
    this.stats.measuredMs += elapsed;
    if (rms < 0.003) this.stats.silentMs += elapsed;
    this.stats.lastSampleAt = now;
  }
}

function pickMimeType(): string {
  for (const type of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function emptyStats(): AudioStats {
  return {
    sumSquares: 0,
    samples: 0,
    peak: 0,
    clippedSamples: 0,
    measuredMs: 0,
    silentMs: 0,
    lastSampleAt: 0,
  };
}

function cloneTelemetry(value: RecordingTelemetry): RecordingTelemetry {
  return {
    transport: value.transport,
    rttMs: value.rttMs,
    voiceRttMs: value.voiceRttMs,
    voiceRegion: value.voiceRegion,
    voiceQuality: value.voiceQuality,
    droppedVoice: value.droppedVoice,
    mic: {
      deviceId: value.mic.deviceId,
      bitrate: value.mic.bitrate,
      activation: value.mic.activation,
      threshold: value.mic.threshold,
      health: { ...value.mic.health },
    },
    playback: { ...value.playback },
    senders: value.senders.map((sender) => ({ ...sender })),
    history: value.history.map((sample) => ({ ...sample })),
  };
}

function makeDelta(start: RecordingTelemetry, end: RecordingTelemetry): RecordingReport['delta'] {
  return {
    droppedVoice: Math.max(0, end.droppedVoice - start.droppedVoice),
    mic: {
      capturedFrames: Math.max(0, end.mic.health.capturedFrames - start.mic.health.capturedFrames),
      encodedFrames: Math.max(0, end.mic.health.encodedFrames - start.mic.health.encodedFrames),
      droppedFrames: Math.max(0, end.mic.health.droppedFrames - start.mic.health.droppedFrames),
      maxEncoderQueue: end.mic.health.maxEncoderQueue,
      maxCaptureGapMs: end.mic.health.maxCaptureGapMs,
    },
    playback: {
      receivedPackets: Math.max(0, end.playback.receivedPackets - start.playback.receivedPackets),
      latePackets: Math.max(0, end.playback.latePackets - start.playback.latePackets),
      reorderedPackets: Math.max(0, end.playback.reorderedPackets - start.playback.reorderedPackets),
      skippedPackets: Math.max(0, end.playback.skippedPackets - start.playback.skippedPackets),
    },
  };
}
