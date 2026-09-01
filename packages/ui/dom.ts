/**
 * Utilitarios de DOM compartilhados pelo cliente e pelo painel.
 *
 * Nada de framework: os dois aplicativos sao pequenos o bastante para que uma
 * funcao de criacao de elemento resolva, e isso e o que mantem o cliente na
 * casa das dezenas de KB.
 */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/**
 * Cria um elemento. Chaves que comecam com "on" viram listener, "text" vira
 * textContent (nunca innerHTML - conteudo de rede jamais e interpretado como
 * marcacao), e o resto vira atributo.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Medidor de segmentos: o indicador de "tem audio passando agora". */
export function vu(live = false): HTMLElement {
  return el('span', { class: `vu${live ? ' live' : ''}` }, el('i'), el('i'), el('i'), el('i'));
}

export function hhmm(stamp: number): string {
  return new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Impressao digital em forma legivel: os primeiros bytes bastam para conferir. */
export function shortId(fingerprint: string): string {
  return fingerprint ? fingerprint.slice(0, 12) : '--';
}

/** Barra de vagas ocupadas. Mostra lotacao, nao so um numero. */
export function occupancy(used: number, total: number, slots = 12): HTMLElement {
  const box = el('span', { class: 'occupancy' });
  const filled = total > 0 ? Math.min(slots, Math.ceil((used / total) * slots)) : 0;
  for (let i = 0; i < slots; i++) {
    box.append(el('i', { class: i < filled ? 'filled' : '' }));
  }
  box.append(el('span', { class: 'count', text: `${used}/${total}` }));
  return box;
}
