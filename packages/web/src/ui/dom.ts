export const $ = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
};

export function text(tag: string, cls: string, content: string): HTMLElement {
  const el = $(tag as keyof HTMLElementTagNameMap, cls);
  el.textContent = content;
  return el;
}

export function timeHHMM(stamp: number): string {
  const d = new Date(stamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
