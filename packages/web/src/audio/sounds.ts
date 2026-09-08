/**
 * Avisos sonoros do cliente.
 *
 * Os pacotes sao sintetizados no AudioContext: nao adicionam download nem
 * dependem de arquivos externos. A tabela e deliberadamente separada do
 * player para, no futuro, aceitar pacotes OGG/WAV sem trocar os eventos.
 */

interface Blip {
  /** Frequencias percorridas, em Hz. */
  tones: number[];
  duration: number;
  gain: number;
}

export type SoundName =
  | 'join'
  | 'leave'
  | 'message'
  | 'poke'
  | 'connected'
  | 'lost'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'channel'
  | 'screen'
  | 'claim';

export type SoundPackId = 'radio' | 'minimal';

export const SOUND_PACK_LABELS: Record<SoundPackId, string> = {
  radio: 'v0x Radio',
  minimal: 'Minimal',
};

export const SOUND_EVENT_LABELS: Record<SoundName, string> = {
  join: 'Alguém entrou',
  leave: 'Alguém saiu',
  message: 'Mensagem recebida',
  poke: 'Poke recebido',
  connected: 'Conectado',
  lost: 'Conexão perdida',
  mute: 'Microfone mutado',
  unmute: 'Microfone ativado',
  deafen: 'Fones mutados',
  undeafen: 'Fones ativados',
  channel: 'Troca de canal',
  screen: 'Compartilhamento de tela',
  claim: 'Respawn reivindicado',
};

export const DEFAULT_SOUND_EVENTS: Record<SoundName, boolean> = {
  join: true,
  leave: true,
  message: true,
  poke: true,
  connected: true,
  lost: true,
  mute: true,
  unmute: true,
  deafen: true,
  undeafen: true,
  channel: true,
  screen: true,
  claim: true,
};

type SoundPack = Record<SoundName, Blip>;

const SOUND_PACKS: Record<SoundPackId, SoundPack> = {
  radio: {
    join: { tones: [523.25, 783.99], duration: 0.11, gain: 0.18 },
    leave: { tones: [523.25, 349.23], duration: 0.13, gain: 0.16 },
    message: { tones: [880, 880], duration: 0.05, gain: 0.12 },
    poke: { tones: [880, 1174.66, 880, 1174.66], duration: 0.35, gain: 0.3 },
    connected: { tones: [392, 587.33, 784], duration: 0.16, gain: 0.2 },
    lost: { tones: [587.33, 392, 261.63], duration: 0.22, gain: 0.2 },
    mute: { tones: [493.88, 329.63], duration: 0.12, gain: 0.16 },
    unmute: { tones: [329.63, 493.88], duration: 0.12, gain: 0.16 },
    deafen: { tones: [392, 293.66, 220], duration: 0.18, gain: 0.17 },
    undeafen: { tones: [220, 293.66, 392], duration: 0.18, gain: 0.17 },
    channel: { tones: [659.25, 783.99], duration: 0.13, gain: 0.15 },
    screen: { tones: [392, 587.33, 880], duration: 0.18, gain: 0.18 },
    claim: { tones: [587.33, 783.99, 1174.66], duration: 0.2, gain: 0.2 },
  },
  minimal: {
    join: { tones: [660], duration: 0.07, gain: 0.13 },
    leave: { tones: [420], duration: 0.08, gain: 0.11 },
    message: { tones: [880], duration: 0.04, gain: 0.09 },
    poke: { tones: [880, 1100], duration: 0.16, gain: 0.18 },
    connected: { tones: [520, 780], duration: 0.1, gain: 0.14 },
    lost: { tones: [520, 300], duration: 0.14, gain: 0.15 },
    mute: { tones: [440, 330], duration: 0.08, gain: 0.12 },
    unmute: { tones: [330, 440], duration: 0.08, gain: 0.12 },
    deafen: { tones: [300, 220], duration: 0.1, gain: 0.12 },
    undeafen: { tones: [220, 300], duration: 0.1, gain: 0.12 },
    channel: { tones: [700], duration: 0.08, gain: 0.11 },
    screen: { tones: [520, 780], duration: 0.12, gain: 0.14 },
    claim: { tones: [700, 980], duration: 0.13, gain: 0.15 },
  },
};

export class Sounds {
  enabled = true;
  private readonly bus: GainNode;
  private selectedPack: SoundPackId = 'radio';
  private readonly eventEnabled: Record<SoundName, boolean> = { ...DEFAULT_SOUND_EVENTS };

  constructor(private readonly ctx: AudioContext) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.7;
    this.bus.connect(ctx.destination);
  }

  get pack(): SoundPackId {
    return this.selectedPack;
  }

  set pack(value: SoundPackId) {
    if (value in SOUND_PACKS) this.selectedPack = value;
  }

  set volume(v: number) {
    this.bus.gain.value = Math.max(0, Math.min(1, v));
  }

  setEventEnabled(name: SoundName, enabled: boolean): void {
    this.eventEnabled[name] = enabled;
  }

  play(name: SoundName): void {
    this.playInternal(name, false);
  }

  /** Prévia um som pelo painel mesmo que o evento esteja desativado. */
  preview(name: SoundName): void {
    this.playInternal(name, true);
  }

  private playInternal(name: SoundName, preview: boolean): void {
    if (!this.enabled || (!preview && !this.eventEnabled[name]) || this.ctx.state !== 'running') return;
    const blip = SOUND_PACKS[this.selectedPack][name];
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
