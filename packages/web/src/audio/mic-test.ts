let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let samples: Float32Array<ArrayBuffer> | null = null;
let level = 0;

export function isMicTestRunning(): boolean {
  return stream !== null;
}

/** Nivel RMS suavizado da captura usada no teste, em uma escala de 0 a 1. */
export function micTestLevel(): number {
  if (!analyser || !samples) return 0;
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  level = level * 0.7 + Math.min(1, rms * 4) * 0.3;
  return level;
}

export function stopMicTest(): void {
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
  analyser = null;
  samples = null;
  level = 0;
  if (ctx) {
    ctx.close().catch(() => {});
    ctx = null;
  }
}

/**
 * Testa exatamente o dispositivo escolhido nas preferencias. O teste usa as
 * mesmas constraints da captura real para revelar nivel baixo/instavel antes
 * de entrar numa sala.
 */
export async function startMicTest(deviceId = ''): Promise<boolean> {
  stopMicTest();
  try {
    ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        sampleRate: { ideal: 48_000 },
        sampleSize: { ideal: 16 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    samples = new Float32Array(analyser.fftSize);

    // Mantem o loopback intencional, mas reduz o ganho para evitar microfonia
    // acidental. Fones continuam sendo recomendados durante o teste.
    const gain = ctx.createGain();
    gain.gain.value = 0.72;
    src.connect(analyser);
    src.connect(gain);
    gain.connect(ctx.destination);
    await ctx.resume();
    return true;
  } catch {
    stopMicTest();
    return false;
  }
}
