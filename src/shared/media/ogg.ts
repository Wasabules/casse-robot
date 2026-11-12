/*
 * Ce que le jeu demande d'un son en Ogg Opus qu'il n'a pas fait lui-même (l'ambiance d'un paquet de
 * carte, map/pack.ts) avant de le donner au navigateur : un seul flux Ogg, en pages intactes (leur
 * somme de contrôle), qui commence par l'en-tête Opus (« OpusHead », une ou deux voies) et ses
 * étiquettes (« OpusTags ») ; et sa durée, d'après la position de sa dernière page (en échantillons à
 * 48 kHz, moins le « pre-skip » de l'en-tête). Rien ici ne décode le son, ni ne lève d'exception.
 * Le format : RFC 3533 (Ogg), RFC 7845 (Opus dans Ogg).
 */

/** Ce qui ne va pas dans un son : pas de l'Ogg Opus lisible, trop de voies, une durée hors des bornes (s). */
export type OpusProblem =
  | { code: "format" }
  | { code: "channels"; channels: number }
  | { code: "duration"; seconds: number; min: number; max: number };

/** Ce qu'on sait d'un Ogg Opus lisible. */
export interface OpusInfo {
  readonly channels: number;
  /** Durée (s). */
  readonly seconds: number;
}

export type OpusInspection = { ok: true; info: OpusInfo } | { ok: false; problem: OpusProblem };

/** Les sommes de contrôle des pages Ogg : CRC-32 de polynôme 0x04c11db7, sans réflexion. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function oggCrc(bytes: Uint8Array, start: number, end: number, crcAt: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    // (le champ de la somme compte pour des zéros)
    const b = i >= crcAt && i < crcAt + 4 ? 0 : bytes[i];
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 255]) >>> 0;
  }
  return crc;
}

/** Fréquence de la position des pages Opus (Hz). */
const OPUS_RATE = 48000;

const matches = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/**
 * Vérifie un Ogg Opus (une ou deux voies : `maxChannels`) et sa durée, entre `min` et `max`
 * secondes. Parcourt toutes ses pages (bornées par la taille du fichier, qu'on a bornée avant).
 */
export function inspectOpus(bytes: Uint8Array, { min, max, maxChannels = 2 }: { min: number; max: number; maxChannels?: number }): OpusInspection {
  const bad: OpusInspection = { ok: false, problem: { code: "format" } };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  let page = 0;
  let serial = 0;
  let granule = -1;
  let preSkip = 0;
  let channels = 0;
  let sawEnd = false;
  // Les deux premiers paquets (l'en-tête, les étiquettes) : on lit le début de chacun
  let packet = 0;
  let packetStart = true;
  while (at < bytes.length) {
    if (sawEnd || !matches(bytes, at, "OggS") || at + 27 > bytes.length) return bad;
    if (bytes[at + 4] !== 0) return bad;
    const flags = bytes[at + 5];
    const segments = bytes[at + 26];
    const header = 27 + segments;
    if (at + header > bytes.length) return bad;
    let body = 0;
    for (let i = 0; i < segments; i++) body += bytes[at + 27 + i];
    const end = at + header + body;
    if (end > bytes.length) return bad;
    if (oggCrc(bytes, at, end, at + 22) !== dv.getUint32(at + 22, true)) return bad;
    const pageSerial = dv.getUint32(at + 14, true);
    const bos = (flags & 2) !== 0;
    // Un seul flux : la première page l'ouvre, aucune autre ne le rouvre ni n'en change
    if (page === 0 ? !bos : bos || pageSerial !== serial) return bad;
    if (page === 0) serial = pageSerial;
    if (dv.getUint32(at + 18, true) !== page) return bad;
    // Les paquets de la page : on regarde le début des deux premiers
    let offset = at + header;
    for (let i = 0; i < segments && packet < 2; i++) {
      const lacing = bytes[at + 27 + i];
      if (packetStart) {
        if (packet === 0) {
          if (!matches(bytes, offset, "OpusHead") || lacing < 19) return bad;
          // Version 0.x : seul l'octet de poids fort compte (RFC 7845, § 5.1)
          if (bytes[offset + 8] >> 4 !== 0) return bad;
          channels = bytes[offset + 9];
          preSkip = dv.getUint16(offset + 10, true);
          if (channels < 1) return bad;
          if (channels > maxChannels) return { ok: false, problem: { code: "channels", channels } };
        } else if (!matches(bytes, offset, "OpusTags")) {
          return bad;
        }
      }
      offset += lacing;
      // Un segment plus court que 255 termine son paquet
      packetStart = lacing < 255;
      if (packetStart) packet++;
    }
    // La position de la page (en échantillons) ; -1 : aucune ne finit sur cette page
    const lo = dv.getUint32(at + 6, true);
    const hi = dv.getInt32(at + 10, true);
    if (!(hi === -1 && lo === 0xffffffff)) {
      if (hi < 0 || hi > 0xffff) return bad;
      granule = hi * 0x100000000 + lo;
    }
    sawEnd = (flags & 4) !== 0;
    at = end;
    page++;
  }
  if (packet < 2 || granule < preSkip) return bad;
  const seconds = (granule - preSkip) / OPUS_RATE;
  if (seconds < min || seconds > max) return { ok: false, problem: { code: "duration", seconds: Math.round(seconds * 10) / 10, min, max } };
  return { ok: true, info: { channels, seconds } };
}
