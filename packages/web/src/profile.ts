import type { ProfileBorder, UserProfile } from '@vox/protocol';

const STORAGE_PREFIX = 'vox.profile.';
export const DEFAULT_PROFILE_ACCENT = '#e8a33d';
export const MAX_PROFILE_AVATAR_CHARS = 38 * 1024;

export interface ProfileFrameOption {
  id: ProfileBorder;
  label: string;
  hint: string;
}

export const PROFILE_FRAMES: readonly ProfileFrameOption[] = [
  { id: 'none', label: 'Essencial', hint: 'limpa e discreta' },
  { id: 'ember', label: 'Brasa', hint: 'ouro quente do v0x' },
  { id: 'royal', label: 'Royal', hint: 'camadas de prestígio' },
  { id: 'signal', label: 'Sinal', hint: 'energia de presença' },
  { id: 'frost', label: 'Frost', hint: 'contraste azulado' },
];

export function emptyProfile(fingerprint = ''): UserProfile {
  return {
    fingerprint,
    avatar: '',
    border: 'none',
    accent: DEFAULT_PROFILE_ACCENT,
    statusText: '',
    updatedAt: 0,
  };
}

export function loadLocalProfile(fingerprint: string): UserProfile | null {
  if (!fingerprint) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${fingerprint}`) ?? 'null') as Partial<UserProfile> | null;
    if (!parsed) return null;
    return normalizeProfile({ ...parsed, fingerprint });
  } catch {
    return null;
  }
}

export function saveLocalProfile(profile: UserProfile): void {
  if (!profile.fingerprint) return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${profile.fingerprint}`, JSON.stringify(normalizeProfile(profile)));
  } catch {
    // O perfil continua válido nesta sessão mesmo quando o armazenamento está cheio/privado.
  }
}

export function normalizeProfile(profile: Partial<UserProfile> & { fingerprint: string }): UserProfile {
  const border = PROFILE_FRAMES.some((item) => item.id === profile.border) ? profile.border! : 'none';
  const accent = typeof profile.accent === 'string' && /^#[0-9a-f]{6}$/i.test(profile.accent)
    ? profile.accent.toLowerCase()
    : DEFAULT_PROFILE_ACCENT;
  const avatar = typeof profile.avatar === 'string'
    && profile.avatar.length <= MAX_PROFILE_AVATAR_CHARS
    && (!profile.avatar || /^data:image\/(?:webp|jpeg|png);base64,[a-z0-9+/=]+$/i.test(profile.avatar))
    ? profile.avatar
    : '';
  return {
    fingerprint: profile.fingerprint,
    avatar,
    border,
    accent,
    statusText: typeof profile.statusText === 'string' ? profile.statusText.trim().slice(0, 64) : '',
    updatedAt: Number(profile.updatedAt) || 0,
  };
}

/**
 * Comprime o recorte quadrado até caber com folga no frame de controle.
 * WebP é tentado primeiro; JPEG funciona como fallback em WebViews antigos.
 */
export function encodeProfileAvatar(source: HTMLCanvasElement): string {
  const sizes = [192, 160, 128, 112, 96];
  const qualities = [0.88, 0.8, 0.72, 0.64];
  let smallest = '';

  for (const size of sizes) {
    const output = document.createElement('canvas');
    output.width = size;
    output.height = size;
    const ctx = output.getContext('2d');
    if (!ctx) throw new Error('Seu navegador não conseguiu processar a imagem.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, size, size);

    for (const quality of qualities) {
      let encoded = output.toDataURL('image/webp', quality);
      if (!encoded.startsWith('data:image/webp')) encoded = output.toDataURL('image/jpeg', quality);
      if (!smallest || encoded.length < smallest.length) smallest = encoded;
      if (encoded.length <= MAX_PROFILE_AVATAR_CHARS) return encoded;
    }
  }

  if (smallest && smallest.length <= MAX_PROFILE_AVATAR_CHARS) return smallest;
  throw new Error('A imagem ficou grande demais. Escolha uma foto com menos detalhes.');
}
