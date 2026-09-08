/**
 * Preferencias de audio persistidas por servidor (localStorage).
 *
 * Chave: vox.audio.<serverId>
 */
import type { MicSettings } from './audio/microphone.js';
import { DEFAULT_MIC } from './audio/microphone.js';
import { DEFAULT_SOUND_EVENTS, type SoundName, type SoundPackId } from './audio/sounds.js';

export interface AudioPrefs {
  /** Configuracoes de captura */
  mic: MicSettings;
  /** Volume geral de saida 0..1.5 */
  outputVolume: number;
  /** Sons de aviso (liga/desliga geral). */
  soundsEnabled: boolean;
  /** Pacote sintetizado escolhido pelo usuario. */
  soundPack: SoundPackId;
  /** Volume do barramento de avisos, separado do volume da voz. */
  soundVolume: number;
  /** Eventos individuais; parcial para aceitar preferencias antigas. */
  soundEvents: Partial<Record<SoundName, boolean>>;
  /** Preamp global de voz (ganho aplicado no mixer) */
  preamp: number;
  /** Dispositivo de saida ('' = padrao do sistema) */
  outputDeviceId: string;
}

const DEFAULT_PREFS: AudioPrefs = {
  mic: { ...DEFAULT_MIC },
  outputVolume: 1,
  soundsEnabled: true,
  soundPack: 'radio',
  soundVolume: 0.7,
  soundEvents: { ...DEFAULT_SOUND_EVENTS },
  preamp: 1,
  outputDeviceId: '',
};

function storageKey(serverId: number): string {
  return `vox.audio.${serverId}`;
}

export function loadAudioPrefs(serverId: number): AudioPrefs {
  try {
    const raw = localStorage.getItem(storageKey(serverId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
      const soundPack: SoundPackId = parsed.soundPack === 'minimal' ? 'minimal' : 'radio';
      const soundVolume = Number.isFinite(parsed.soundVolume)
        ? Math.max(0, Math.min(1, Number(parsed.soundVolume)))
        : DEFAULT_PREFS.soundVolume;
      return {
        ...DEFAULT_PREFS,
        ...parsed,
        soundPack,
        soundVolume,
        soundEvents: { ...DEFAULT_SOUND_EVENTS, ...(parsed.soundEvents ?? {}) },
        mic: { ...DEFAULT_MIC, ...(parsed.mic ?? {}) },
      };
    }
  } catch {
    // ignora erro de parse
  }
  return { ...DEFAULT_PREFS };
}

export function saveAudioPrefs(serverId: number, prefs: AudioPrefs): void {
  try {
    localStorage.setItem(storageKey(serverId), JSON.stringify(prefs));
  } catch {
    // quota exceeded, etc.
  }
}
