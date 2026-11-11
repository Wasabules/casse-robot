import type { HeightImage } from "./heightmap";

/*
 * Écriture d'une image de hauteurs en PNG, niveaux de gris 8 ou 16 bits (sans filtre) : pour
 * exporter le relief d'une carte vers un outil de terrain, et pour les essais et les outils
 * (tools/maps/). La compression est fournie par l'appelant (`CompressionStream("deflate")` dans le
 * navigateur, `zlib.deflateSync` dans Node), comme la décompression pour `decodePng`.
 */

/** Compression zlib. */
export type Deflate = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 d'un morceau de PNG (son type et ses données). */
export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** Une image de hauteurs (valeurs de 0 à 1) en PNG gris de `bits` bits. */
export async function encodePng(img: HeightImage, deflate: Deflate, bits: 8 | 16 = 16): Promise<Uint8Array> {
  const { width, height } = img;
  const bytes = bits / 8;
  const stride = width * bytes + 1;
  const raw = new Uint8Array(height * stride);
  const max = bits === 16 ? 65535 : 255;
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // sans filtre
    for (let x = 0; x < width; x++) {
      const v = Math.round(Math.min(1, Math.max(0, img.data[y * width + x])) * max);
      const at = y * stride + 1 + x * bytes;
      if (bits === 16) {
        raw[at] = v >> 8;
        raw[at + 1] = v & 255;
      } else raw[at] = v;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = bits;
  header[9] = 0; // niveaux de gris
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
