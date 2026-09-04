/**
 * Qualidade de recepcao de um remetente: jitter e perda.
 *
 * Fica separado do mixer de proposito — aqui e so aritmetica sobre numero de
 * sequencia e instante de chegada, sem AudioContext nem decoder. Isso mantem a
 * parte que erra silenciosamente (contas com wrap de 16 bits e janelas)
 * verificavel fora do navegador.
 *
 * O metodo e o do RFC 3550, adaptado a um detalhe nosso: o remetente so
 * incrementa `seq` quando transmite de fato, porque o VAD corta o silencio.
 * Isso e o que torna "buraco no seq" sinonimo de pacote perdido, e nao de
 * pausa na fala — mas obriga a reiniciar a referencia de transito a cada
 * rajada, senao a pausa entraria na conta como atraso de rede.
 */

import { seqDelta } from '@vox/protocol';

/** Duracao de um quadro Opus, que e o passo nominal entre dois seq. */
const FRAME_MS = 20;
/** Constante do filtro de jitter do RFC 3550. */
const JITTER_GAIN = 16;
/** Silencio maior que isto encerra a rajada de fala. */
const BURST_GAP_MS = 200;

export interface SenderSnapshot {
  /** Variacao do tempo de chegada, em ms. */
  jitterMs: number;
  /** Perda na janela recem-fechada, em %. */
  lossPct: number;
  receivedPackets: number;
  /** Buracos no seq desde o primeiro pacote: o que nunca chegou. */
  lostPackets: number;
}

export class SenderMetrics {
  /** Maior seq bruto ja visto e sua versao estendida, sem o wrap de 16 bits. */
  private maxSeq = -1;
  private maxExtended = 0;
  /** Primeiro seq estendido, base do "quantos deveriam ter chegado". */
  private baseExtended = 0;
  private received = 0;
  /** Transito do pacote anterior, para a diferenca do RFC 3550. */
  private lastTransit: number | null = null;
  private lastArrival = 0;
  /** Contagens do fim da janela anterior. */
  private expectedPrior = 0;
  private receivedPrior = 0;

  jitterMs = 0;
  lossPct = 0;

  get hasData(): boolean {
    return this.maxSeq >= 0;
  }

  observe(seq: number, arrivalMs: number): void {
    if (this.maxSeq < 0) {
      this.maxSeq = seq;
      this.maxExtended = seq;
      this.baseExtended = seq;
      this.received = 1;
      this.lastArrival = arrivalMs;
      return;
    }

    // Estendido = maior visto + distancia com sinal. Atravessa o wrap de 16
    // bits e ainda posiciona corretamente um pacote que chegou fora de ordem.
    const extended = this.maxExtended + seqDelta(seq, this.maxSeq);
    if (extended > this.maxExtended) {
      this.maxExtended = extended;
      this.maxSeq = seq;
    }
    this.received++;

    const silence = arrivalMs - this.lastArrival > BURST_GAP_MS;
    this.lastArrival = arrivalMs;

    const transit = arrivalMs - extended * FRAME_MS;
    if (silence || this.lastTransit === null) {
      this.lastTransit = transit;
      return;
    }
    const drift = Math.abs(transit - this.lastTransit);
    this.lastTransit = transit;
    this.jitterMs += (drift - this.jitterMs) / JITTER_GAIN;
  }

  /** Fecha a janela e devolve a leitura. */
  closeWindow(): SenderSnapshot {
    const expected = this.maxSeq < 0 ? 0 : this.maxExtended - this.baseExtended + 1;
    const expectedDelta = expected - this.expectedPrior;
    const receivedDelta = this.received - this.receivedPrior;
    this.expectedPrior = expected;
    this.receivedPrior = this.received;
    // Janela sem trafego mantem o valor anterior: zerar faria a leitura piscar
    // para 0% toda vez que a pessoa parasse de falar.
    if (expectedDelta > 0) {
      this.lossPct = (Math.max(expectedDelta - receivedDelta, 0) / expectedDelta) * 100;
    }
    return {
      jitterMs: Math.round(this.jitterMs * 10) / 10,
      lossPct: Math.round(this.lossPct * 10) / 10,
      receivedPackets: this.received,
      lostPackets: Math.max(expected - this.received, 0),
    };
  }
}
