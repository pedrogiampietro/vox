/**
 * Reproducao de um remetente: uma fila de PCM que o Web Audio drena a 128
 * amostras por chamada. Fila vazia vira silencio (underrun), fila grande
 * demais e podada - preferimos cortar audio velho a acumular atraso.
 */

const START_QUEUED = 2880; // 60ms: absorve a variacao normal de chegada
const MAX_QUEUED = 48000; // 1 segundo a 48kHz

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queued = 0;
    this.started = false;

    this.port.onmessage = (event) => {
      const chunk = event.data;
      if (chunk === null) {
        this.queue.length = 0;
        this.queued = 0;
        this.offset = 0;
        this.started = false;
        return;
      }
      this.queue.push(chunk);
      this.queued += chunk.length;
      while (this.queued > MAX_QUEUED && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.queued -= dropped.length - this.offset;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    // O decoder pode entregar o primeiro frame antes de os seguintes
    // chegarem. Esperar 60ms aqui evita transformar jitter de rede em cortes.
    if (!this.started && this.queued < START_QUEUED) {
      out.fill(0);
      return true;
    }
    this.started = true;

    let written = 0;
    while (written < out.length && this.queue.length > 0) {
      const head = this.queue[0];
      const take = Math.min(out.length - written, head.length - this.offset);
      out.set(head.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      this.queued -= take;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (written < out.length) {
      out.fill(0, written);
      // Reinicia o pre-buffer na proxima chegada, em vez de continuar
      // consumindo silencio e acumular atraso invisivel.
      this.started = false;
    }
    return true;
  }
}

registerProcessor('vox-playback', PlaybackProcessor);
