/**
 * Higieniza texto vindo da rede: remove controles, soft hyphen e zero-width
 * (o vetor classico de apelido falsificado) e corta no tamanho maximo.
 *
 * Escrito com comparacao de code point em vez de regex de propriedade Unicode
 * para nao depender de flags do runtime e nao gastar em cada mensagem de chat.
 */
export function clean(v: string, max: number): string {
  let out = '';
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    const junk =
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0xad ||
      (c >= 0x200b && c <= 0x200f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x2060 ||
      c === 0xfeff;
    if (!junk) out += ch;
  }
  return out.trim().slice(0, max);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(v) || 0));
}
