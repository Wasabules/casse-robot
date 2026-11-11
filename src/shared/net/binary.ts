import type { Quat, Vec3 } from "../math/vec";

/*
 * Lecture et écriture de données binaires (petit-boutiste) pour les images envoyées par le
 * serveur. Les nombres réels sont en flottants 32 bits, sauf le temps (64 bits).
 */

export class Writer {
  private buffer = new ArrayBuffer(8192);
  private view = new DataView(this.buffer);
  private at = 0;

  u8(v: number): void {
    this.need(1);
    this.view.setUint8(this.at, v);
    this.at += 1;
  }

  u16(v: number): void {
    this.need(2);
    this.view.setUint16(this.at, v, true);
    this.at += 2;
  }

  u32(v: number): void {
    this.need(4);
    this.view.setUint32(this.at, v, true);
    this.at += 4;
  }

  f32(v: number): void {
    this.need(4);
    this.view.setFloat32(this.at, v, true);
    this.at += 4;
  }

  f64(v: number): void {
    this.need(8);
    this.view.setFloat64(this.at, v, true);
    this.at += 8;
  }

  vec3(v: Vec3): void {
    this.f32(v.x);
    this.f32(v.y);
    this.f32(v.z);
  }

  quat(q: Quat): void {
    this.f32(q.x);
    this.f32(q.y);
    this.f32(q.z);
    this.f32(q.w);
  }

  bytes(data: Uint8Array): void {
    this.need(data.length);
    new Uint8Array(this.buffer, this.at, data.length).set(data);
    this.at += data.length;
  }

  /** Les octets écrits (une copie). */
  finish(): Uint8Array {
    return new Uint8Array(this.buffer.slice(0, this.at));
  }

  private need(n: number): void {
    if (this.at + n <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength * 2;
    while (size < this.at + n) size *= 2;
    const bigger = new ArrayBuffer(size);
    new Uint8Array(bigger).set(new Uint8Array(this.buffer, 0, this.at));
    this.buffer = bigger;
    this.view = new DataView(bigger);
  }
}

export class Reader {
  private readonly view: DataView;
  private at = 0;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    const v = this.view.getUint8(this.at);
    this.at += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.at, true);
    this.at += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }

  vec3(): Vec3 {
    return { x: this.f32(), y: this.f32(), z: this.f32() };
  }

  quat(): Quat {
    return { x: this.f32(), y: this.f32(), z: this.f32(), w: this.f32() };
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.at, n);
    this.at += n;
    return out;
  }

  /** Octets restants. */
  rest(): Uint8Array {
    return this.bytes(this.view.byteLength - this.at);
  }
}

/** Texte en UTF-8 (TextEncoder n'est pas disponible sans DOM ni types Node). */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let c: number;
    if (b < 0x80) {
      c = b;
      i += 1;
    } else if (b < 0xe0) {
      c = ((b & 31) << 6) | (bytes[i + 1] & 63);
      i += 2;
    } else if (b < 0xf0) {
      c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63);
      i += 3;
    } else {
      c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      i += 4;
    }
    text += String.fromCodePoint(c);
  }
  return text;
}
