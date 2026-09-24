/** Thrown when a packet is truncated or malformed. Never escapes a decode* helper. */
export class DecodeError extends Error {}

/** Growable little-endian binary writer. */
export class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  offset = 0;

  constructor(initial = 256) {
    this.buf = new ArrayBuffer(initial);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  private ensure(n: number): void {
    if (this.offset + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.offset + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes);
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.offset, v);
    this.offset += 1;
    return this;
  }
  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.offset, v);
    this.offset += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
    return this;
  }
  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
    return this;
  }
  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.offset, v, true);
    this.offset += 8;
    return this;
  }
  /** Unsigned LEB128 varint. */
  varint(v: number): this {
    let n = Math.max(0, Math.floor(v));
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      this.u8(byte);
    } while (n > 0);
    return this;
  }
  bytesRaw(data: Uint8Array): this {
    this.ensure(data.byteLength);
    this.bytes.set(data, this.offset);
    this.offset += data.byteLength;
    return this;
  }
  string(s: string): this {
    const data = new TextEncoder().encode(s);
    this.varint(data.byteLength);
    return this.bytesRaw(data);
  }

  /** Returns a copy of the written bytes. */
  finish(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }
}

/** Bounds-checked little-endian reader. */
export class ByteReader {
  private view: DataView;
  private bytes: Uint8Array;
  offset = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  private need(n: number): void {
    if (this.offset + n > this.bytes.byteLength) throw new DecodeError('truncated packet');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.offset++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      result += (byte & 0x7f) * mul;
      if ((byte & 0x80) === 0) return result;
      mul *= 128;
    }
    throw new DecodeError('varint too long');
  }
  bytesRaw(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  string(maxBytes = 1 << 20): string {
    const n = this.varint();
    if (n > maxBytes) throw new DecodeError('string too long');
    return new TextDecoder().decode(this.bytesRaw(n));
  }
  /** Requires a finite float (NaN/Infinity are rejected as malformed). */
  finite32(): number {
    const v = this.f32();
    if (!Number.isFinite(v)) throw new DecodeError('non-finite value');
    return v;
  }
  finite64(): number {
    const v = this.f64();
    if (!Number.isFinite(v)) throw new DecodeError('non-finite value');
    return v;
  }
}
