/** Temas do cliente. A escolha e local ao dispositivo, como audio e idioma. */
export const THEME_STORAGE_KEY = 'vox.theme';

export const THEMES = [
  { id: 'v0x', name: 'V0X', description: 'escuro quente original' },
  { id: 'midnight', name: 'Midnight', description: 'azul profundo e frio' },
  { id: 'forest', name: 'Forest', description: 'verde de terminal' },
  { id: 'violet', name: 'Violet', description: 'roxo elétrico discreto' },
  { id: 'light', name: 'Marfim', description: 'papel quente e alto contraste' },
  { id: 'glacier', name: 'Glacier', description: 'claro azul-gelo' },
  { id: 'sage', name: 'Sage', description: 'claro verde-sálvia' },
  { id: 'lavender', name: 'Lavender', description: 'claro lavanda suave' },
] as const;

export type ThemeId = typeof THEMES[number]['id'];

export function loadTheme(): ThemeId {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return THEMES.some((theme) => theme.id === value) ? value as ThemeId : 'v0x';
  } catch {
    return 'v0x';
  }
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme === 'v0x' ? '' : theme;
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* storage indisponivel */ }
}

/** Chamar antes do primeiro render evita o flash do tema padrao. */
export function applySavedTheme(): ThemeId {
  const theme = loadTheme();
  applyTheme(theme);
  return theme;
}
