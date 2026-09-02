let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;

export function isMicTestRunning(): boolean {
  return stream !== null;
}

export function stopMicTest(): void {
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
  if (ctx) {
    ctx.close().catch(() => {});
    ctx = null;
  }
}

export async function startMicTest(): Promise<boolean> {
  stopMicTest();
  try {
    ctx = new AudioContext({ sampleRate: 48_000 });
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 1;
    src.connect(gain);
    gain.connect(ctx.destination);
    return true;
  } catch {
    stopMicTest();
    return false;
  }
}
