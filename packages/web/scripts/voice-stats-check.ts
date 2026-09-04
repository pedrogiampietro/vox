/**
 * Cenarios de rede sinteticos contra SenderMetrics.
 *
 * Jitter e perda so aparecem em rede ruim de verdade, que nao da para produzir
 * sob demanda numa call. Aqui a chegada de cada pacote e fabricada, entao o
 * numero certo e conhecido de antemao — e as contas com wrap de 16 bits,
 * pausa de fala e reordenacao ficam cobertas.
 *
 *   npm run check:voice-stats
 */

import { SenderMetrics } from '../src/audio/voice-stats.js';

let falhas = 0;
function check(nome: string, real: number, esperado: number, tol: number): void {
  const ok = Math.abs(real - esperado) <= tol;
  if (!ok) falhas++;
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${nome.padEnd(46)} ${real.toFixed(2)} (esperado ~${esperado} ±${tol})`);
}

// 1. Rede perfeita: 200 pacotes exatamente a cada 20ms.
{
  const m = new SenderMetrics();
  for (let i = 0; i < 200; i++) m.observe(i, i * 20);
  const s = m.closeWindow();
  check('perfeita · jitter', s.jitterMs, 0, 0.01);
  check('perfeita · perda %', s.lossPct, 0, 0.01);
  check('perfeita · perdidos', s.lostPackets, 0, 0);
}

// 2. Jitter de +-5ms alternado: o valor estavel do filtro RFC 3550 tende a
//    media de |D|, que aqui e 10ms.
{
  const m = new SenderMetrics();
  for (let i = 0; i < 400; i++) m.observe(i, i * 20 + (i % 2 === 0 ? 5 : -5));
  const s = m.closeWindow();
  check('jitter alternado ±5ms', s.jitterMs, 10, 1);
}

// 3. Perda de 10%: um a cada dez pacotes nunca chega.
{
  const m = new SenderMetrics();
  for (let i = 0; i < 500; i++) {
    if (i % 10 === 3) continue;
    m.observe(i, i * 20);
  }
  const s = m.closeWindow();
  check('perda 10% · %', s.lossPct, 10, 0.5);
  check('perda 10% · perdidos', s.lostPackets, 50, 1);
  check('perda 10% · recebidos', s.receivedPackets, 450, 1);
}

// 4. Wrap de 16 bits: comeca perto do fim da faixa e atravessa o zero.
{
  const m = new SenderMetrics();
  let t = 0;
  for (let i = 0; i < 200; i++) {
    const seq = (65_500 + i) & 0xffff;
    if (i % 20 === 7) { t += 20; continue; }
    m.observe(seq, t);
    t += 20;
  }
  const s = m.closeWindow();
  check('wrap u16 · perda %', s.lossPct, 5, 0.6);
  check('wrap u16 · perdidos', s.lostPackets, 10, 1);
  check('wrap u16 · jitter', s.jitterMs, 0, 0.5);
}

// 5. Pausa de fala: 2s de silencio nao pode virar pico de jitter.
{
  const m = new SenderMetrics();
  for (let i = 0; i < 100; i++) m.observe(i, i * 20);
  for (let i = 100; i < 200; i++) m.observe(i, 2_000 + i * 20);
  const s = m.closeWindow();
  check('pausa de 2s · jitter', s.jitterMs, 0, 0.5);
  check('pausa de 2s · perda %', s.lossPct, 0, 0.01);
}

// 6. Reordenacao sem perda: pares trocados nao contam como pacote perdido.
{
  const m = new SenderMetrics();
  for (let i = 0; i < 200; i += 2) {
    m.observe(i + 1, (i + 1) * 20);
    m.observe(i, (i + 1) * 20 + 2);
  }
  const s = m.closeWindow();
  check('reordenado · perda %', s.lossPct, 0, 0.01);
  check('reordenado · perdidos', s.lostPackets, 0, 0);
}

// 7. Janela: a perda medida e a do intervalo, nao a da sessao inteira.
{
  const m = new SenderMetrics();
  for (let i = 0; i < 100; i++) m.observe(i, i * 20);
  check('janela 1 (limpa) · perda %', m.closeWindow().lossPct, 0, 0.01);
  for (let i = 100; i < 200; i++) {
    if (i % 4 === 0) continue;
    m.observe(i, i * 20);
  }
  check('janela 2 (25% perda) · perda %', m.closeWindow().lossPct, 25, 1);
  for (let i = 200; i < 300; i++) m.observe(i, i * 20);
  check('janela 3 (limpa de novo) · perda %', m.closeWindow().lossPct, 0, 0.01);
}

console.log(falhas === 0 ? '\nTODOS OS CENARIOS PASSARAM' : `\n${falhas} FALHA(S)`);
process.exitCode = falhas === 0 ? 0 : 1;
