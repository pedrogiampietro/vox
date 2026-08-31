/**
 * Leitura/escrita binaria little-endian.
 *
 * Little-endian porque x86 e ARM sao LE nativamente: evita byteswap em toda
 * leitura. Strings sao UTF-8 com prefixo de tamanho u16 (max 65535 bytes).
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  /** String UTF-8 com prefixo u16. */
  str(v: string): this {
    const bytes = ENC.encode(v);
    if (bytes.length > 0xffff) throw new RangeError('string acima de 64KB');
    this.u16(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
    return this;
  }

  /** Bytes crus, sem prefixo. Use por ultimo no pacote. */
  raw(v: Uint8Array): this {
    this.ensure(v.length);
    this.buf.set(v, this.pos);
    this.pos += v.length;
    return this;
  }

  /** Array com contagem u16 na frente. */
  list<T>(items: readonly T[], write: (w: Writer, item: T) => void): this {
    this.u16(items.length);
    for (const item of items) write(this, item);
    return this;
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

export class Reader {
  private view: DataView;
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new RangeError('pacote truncado');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  str(): string {
    const len = this.u16();
    this.need(len);
    const out = DEC.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return out;
  }

  /** Resto do pacote sem copiar. Valido enquanto o buffer de origem viver. */
  rest(): Uint8Array {
    const out = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return out;
  }

  list<T>(read: (r: Reader) => T): T[] {
    const n = this.u16();
    const out: T[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = read(this);
    return out;
  }
}
