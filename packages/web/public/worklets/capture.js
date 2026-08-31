/**
 * Captura: junta os blocos de 128 amostras que o Web Audio entrega em quadros
 * de 20ms (960 amostras a 48kHz), que e o quadro do Opus.
 *
 * Roda na thread de audio, entao nada de alocar em excesso nem de logs.
 */

const FRAME = 960;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let read = 0;
    while (read < channel.length) {
      const take = Math.min(FRAME - this.filled, channel.length - read);
      this.buf.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;

      if (this.filled === FRAME) {
        // Copia transferida para a thread principal: sem copia extra na ponte.
        const frame = new Float32Array(this.buf);
        this.port.postMessage(frame, [frame.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('vox-capture', CaptureProcessor);
