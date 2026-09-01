/**
 * Preferencias de audio persistidas por servidor (localStorage).
 *
 * Chave: vox.audio.<serverId>
 */
import type { MicSettings } from './audio/microphone.js';
import { DEFAULT_MIC } from './audio/microphone.js';

export interface AudioPrefs {
  /** Configuracoes de captura */
  mic: MicSettings;
  /** Volume geral de saida 0..1.5 */
  outputVolume: number;
  /** Sons de aviso (join/leave/mensagem) */
  soundsEnabled: boolean;
  /** Preamp global de voz (ganho aplicado no mixer) */
  preamp: number;
}

const DEFAULT_PREFS: AudioPrefs = {
  mic: { ...DEFAULT_MIC },
  outputVolume: 1,
  soundsEnabled: true,
  preamp: 1,
};

function storageKey(serverId: number): string {
  return `vox.audio.${serverId}`;
}

export function loadAudioPrefs(serverId: number): AudioPrefs {
  try {
    const raw = localStorage.getItem(storageKey(serverId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
      return { ...DEFAULT_PREFS, ...parsed, mic: { ...DEFAULT_MIC, ...(parsed.mic ?? {}) } };
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