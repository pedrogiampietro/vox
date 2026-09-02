const STORAGE_KEY = 'vox:pttKey';

export function loadPttKey(): string {
  return localStorage.getItem(STORAGE_KEY) || 'Space';
}

export function savePttKey(code: string): void {
  localStorage.setItem(STORAGE_KEY, code);
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Space: 'Espaço',
    ShiftLeft: 'Shift Esq',
    ShiftRight: 'Shift Dir',
    ControlLeft: 'Ctrl Esq',
    ControlRight: 'Ctrl Dir',
    AltLeft: 'Alt Esq',
    AltRight: 'Alt Dir',
    CapsLock: 'Caps Lock',
    Tab: 'Tab',
    Backquote: '`',
  };
  return map[code] || code;
}
