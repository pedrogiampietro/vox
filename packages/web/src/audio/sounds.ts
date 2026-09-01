/**
 * Avisos sonoros, sintetizados na hora.
 *
 * Nenhum arquivo de audio: sao dois osciladores e um envelope, o que custa
 * zero byte de download e mantem o cliente no tamanho que ele tem. Tambem
 * combina com o assunto - sao bipes de equipamento, nao jingles.
 *
 * Volume baixo de proposito: aviso que compete com a conversa vira ruido.
 */

interface Blip {
  /** Frequencias percorridas, em Hz. */
  tones: number[];
  duration: number;
  gain: number;
}

const BLIPS = {
  join: { tones: [523.25, 783.99], duration: 0.11, gain: 0.18 },
  leave: { tones: [523.25, 349.23], duration: 0.13, gain: 0.16 },
  message: { tones: [880, 880], duration: 0.05, gain: 0.12 },
  poke: { tones: [880, 1174.66, 880, 1174.66], duration: 0.35, gain: 0.3 },
  connected: { tones: [392, 587.33, 784], duration: 0.16, gain: 0.2 },
  lost: { tones: [587.33, 392, 261.63], duration: 0.22, gain: 0.2 },
} as const satisfies Record<string, Blip>;

export type SoundName = keyof typeof BLIPS;

export class Sounds {
  enabled = true;
  private readonly bus: GainNode;

  constructor(private readonly ctx: AudioContext) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(ctx.destination);
  }

  set volume(v: number) {
    this.bus.gain.value = Math.max(0, Math.min(1, v));
  }

  play(name: SoundName): void {
    if (!this.enabled || this.ctx.state !== 'running') return;
    const blip = BLIPS[name];
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(blip.tones[0]!, now);
    for (let i = 1; i < blip.tones.length; i++) {
      const at = now + (blip.duration * i) / (blip.tones.length - 1);
      osc.frequency.exponentialRampToValueAtTime(blip.tones[i]!, at);
    }

    // Ataque curto e queda exponencial: sem clique no inicio nem no fim.
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(blip.gain, now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + blip.duration);

    osc.connect(env).connect(this.bus);
    osc.start(now);
    osc.stop(now + blip.duration + 0.02);
  }
}
