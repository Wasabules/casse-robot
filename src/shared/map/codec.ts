import type { Terrain } from "../arena/terrain";
import type { MapTerrain } from "./format";

/*
 * Le relief d'une carte en texte : des hauteurs en Uint16 petit-boutiste, en base64. Écrit à la
 * main, sans `atob` ni `Buffer` : le code partagé tourne dans le navigateur comme dans Node.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

/** Octets → base64 (avec bourrage « = »). */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    chunk += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63]
      + (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=")
      + (i + 2 < bytes.length ? ALPHABET[n & 63] : "=");
    // Par morceaux : une concaténation d'une seule chaîne de plusieurs centaines de Ko reste rapide
    if (chunk.length >= 4096) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

/** Base64 → octets ; null si le texte n'en est pas (caractère étranger, longueur impossible). Les blancs sont ignorés. */
export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "");
  if (clean.length % 4 !== 0) return null;
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const ch = clean.charCodeAt(i + k);
      const last = i + 4 === clean.length;
      if (ch === 61 /* = */ && last && k >= 4 - pad) {
        n <<= 6;
        continue;
      }
      const v = ch < 128 ? DECODE[ch] : -1;
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Nombre de sommets d'un relief de `cells` cases par côté. */
export const vertexCount = (cells: number): number => (cells + 1) * (cells + 1);

/**
 * Hauteurs (m, dans l'ordre de `Terrain.heights`) → relief d'une carte : codées de 0 à 65 535
 * entre la plus basse et la plus haute (au millimètre près sur 65 m). `min`, `max` arrondis au cm.
 */
export function encodeTerrain(heights: Float32Array | readonly number[], cells: number, step: number): MapTerrain {
  if (heights.length !== vertexCount(cells)) throw new Error(`Relief : ${heights.length} hauteurs pour ${cells} cases (il en faut ${vertexCount(cells)})`);
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of heights) {
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  const min = Math.floor(lo * 100) / 100;
  const max = Math.max(min + 0.01, Math.ceil(hi * 100) / 100);
  const bytes = new Uint8Array(heights.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < heights.length; i++) {
    const code = Math.round(((heights[i] - min) / (max - min)) * 65535);
    view.setUint16(i * 2, Math.max(0, Math.min(65535, code)), true);
  }
  return { cells, step, min, max, heights: toBase64(bytes) };
}

/** Relief d'une carte → codes Uint16 ; null si ses données sont illisibles ou n'ont pas le bon nombre de valeurs. */
export function terrainCodes(t: MapTerrain): Uint16Array | null {
  const bytes = fromBase64(t.heights);
  if (!bytes || bytes.length !== vertexCount(t.cells) * 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codes = new Uint16Array(vertexCount(t.cells));
  for (let i = 0; i < codes.length; i++) codes[i] = view.getUint16(i * 2, true);
  return codes;
}

/**
 * Les reliefs déjà décodés, par relief de carte (le même objet : l'éditeur de cartes reconstruit
 * l'arène à chaque modification, et le relief n'a souvent pas changé). Un relief du jeu ne se modifie
 * jamais une fois décodé : tous ceux qui le lisent peuvent le partager.
 */
const DECODED = new WeakMap<MapTerrain, Terrain | null>();

/** Relief d'une carte → relief du jeu (arena/terrain.ts) ; null si ses données sont illisibles. */
export function decodeTerrain(t: MapTerrain): Terrain | null {
  const known = DECODED.get(t);
  if (known !== undefined) return known;
  const codes = terrainCodes(t);
  let terrain: Terrain | null = null;
  if (codes) {
    const heights = new Float32Array(codes.length);
    const scale = (t.max - t.min) / 65535;
    for (let i = 0; i < codes.length; i++) heights[i] = t.min + codes[i] * scale;
    terrain = { size: t.cells * t.step, cells: t.cells, heights };
  }
  DECODED.set(t, terrain);
  return terrain;
}
