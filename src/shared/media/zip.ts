import { crc32 } from "../map/png";
import { utf8Bytes, utf8Text } from "./utf8";

/*
 * Archive zip, lue et écrite sans dépendance : le paquet d'une carte en un seul fichier à échanger
 * (map/pack.ts). La (dé)compression « deflate » brute est fournie par l'appelant, comme celle d'un
 * PNG (`DecompressionStream("deflate-raw")` dans le navigateur, `zlib.inflateRawSync` dans Node) ; une
 * entrée y est rangée telle quelle (« stored ») ou dégonflée (« deflate »), rien d'autre.
 *
 * Lire une archive venue de n'importe qui : `openZip` lit son répertoire central (la taille de
 * l'archive et le nombre d'entrées bornés avant, les noms vérifiés : ni « .. », ni chemin absolu, ni
 * lecteur, ni doublon, une barre oblique inverse comptant pour une barre oblique ; pas de zip64, pas d'archive en plusieurs morceaux ni
 * chiffrée) ; l'appelant décide ensuite quelles entrées lire d'après leur nom et leur taille annoncée.
 * Une entrée lue se décompresse au plus à sa taille annoncée (une « bombe » ne remplit pas la mémoire),
 * puis on vérifie sa longueur et sa somme de contrôle. Rien ne lève d'exception : une archive fautive
 * est un problème, une entrée abîmée se lit null.
 *
 * Écrire : les entrées dans l'ordre donné, sans date (le 1er janvier 1980) ni attributs, les noms en
 * UTF-8 : les mêmes fichiers donnent les mêmes octets (avec la même compression).
 */

/** Décompression « deflate » brute (sans en-tête zlib) d'au plus `max` octets : lève (ou rejette) au-delà. */
export type InflateRaw = (data: Uint8Array, max: number) => Uint8Array | Promise<Uint8Array>;
/** Compression « deflate » brute. */
export type DeflateRaw = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Ce qu'on borne en ouvrant une archive : sa taille (octets), son nombre d'entrées (dossiers compris). */
export interface ZipLimits {
  readonly bytes: number;
  readonly entries: number;
}

/** Ce qui ne va pas dans une archive. */
export type ZipProblem =
  /** L'archive dépasse la taille permise (octets). */
  | { code: "tooLarge"; size: number; max: number }
  /** Pas une archive zip lisible (structure, zip64, plusieurs morceaux, chiffrée, méthode inconnue, nom en double). */
  | { code: "format" }
  /** Trop d'entrées. */
  | { code: "entries"; count: number; max: number }
  /** Une entrée au nom dangereux (« .. », absolu, lecteur, barre oblique inverse). */
  | { code: "path"; name: string };

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const STORED = 0;
const DEFLATE = 8;
/** Les drapeaux qu'on refuse : chiffrée (bit 0), chiffrement fort (bit 6). */
const ENCRYPTED = 0x41;
/** Drapeau des noms en UTF-8 (bit 11). */
const UTF8 = 0x800;
/** Date DOS du 1er janvier 1980 (la plus ancienne qu'on puisse écrire). */
const EPOCH_DATE = (0 << 9) | (1 << 5) | 1;

/** Un nom d'entrée sûr : relatif, sans « .. » ni « . », sans barre oblique inverse, lecteur ni caractère de contrôle. */
export function safeEntryName(name: string): boolean {
  if (!name || name.length > 255 || name.startsWith("/") || /[\\:\u0000-\u001f\u007f]/.test(name)) return false;
  return name.replace(/\/$/, "").split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** La somme de contrôle CRC-32 d'une entrée (celle des PNG, avec son inversion finale). */
const zipCrc = (bytes: Uint8Array): number => (crc32(bytes) ^ 0xffffffff) >>> 0;

interface Entry {
  readonly method: number;
  readonly crc: number;
  readonly packed: number;
  readonly size: number;
  readonly local: number;
}

/** Une archive ouverte : les noms de ses fichiers (pas ses dossiers), leur taille annoncée, et leur lecture. */
export class ZipArchive {
  private readonly bytes: Uint8Array;
  private readonly entries: ReadonlyMap<string, Entry>;
  /** Le début du répertoire central : les données des entrées sont avant. */
  private readonly central: number;

  constructor(bytes: Uint8Array, entries: ReadonlyMap<string, Entry>, central: number) {
    this.bytes = bytes;
    this.entries = entries;
    this.central = central;
  }

  /** Les fichiers de l'archive, dans l'ordre de son répertoire. */
  get names(): string[] {
    return [...this.entries.keys()];
  }

  /** La taille d'un fichier une fois décompressé, d'après le répertoire (-1 : pas dans l'archive). */
  size(name: string): number {
    return this.entries.get(name)?.size ?? -1;
  }

  /** Les octets d'un fichier, vérifiés (longueur, somme de contrôle) ; null s'il n'y est pas, ou abîmé. */
  async read(name: string, inflateRaw: InflateRaw): Promise<Uint8Array | null> {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const { local } = entry;
    if (local + 30 > this.central || dv.getUint32(local, true) !== LOCAL) return null;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    if (start + entry.packed > this.central) return null;
    const packed = this.bytes.subarray(start, start + entry.packed);
    let data: Uint8Array;
    if (entry.method === STORED) {
      data = packed.slice();
    } else {
      try {
        data = await inflateRaw(packed, entry.size);
      } catch {
        return null;
      }
    }
    return data.length === entry.size && zipCrc(data) === entry.crc ? data : null;
  }
}

export type ZipOpen = { ok: true; archive: ZipArchive } | { ok: false; problem: ZipProblem };

/** Ouvre une archive : lit et vérifie son répertoire central, sans rien décompresser. */
export function openZip(bytes: Uint8Array, limits: ZipLimits): ZipOpen {
  const format: ZipOpen = { ok: false, problem: { code: "format" } };
  if (bytes.length > limits.bytes) return { ok: false, problem: { code: "tooLarge", size: bytes.length, max: limits.bytes } };
  if (bytes.length < 22) return format;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // La fin du répertoire central : dans les derniers 22 octets, plus un commentaire d'au plus 65 535
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (dv.getUint32(at, true) === END && at + 22 + dv.getUint16(at + 20, true) === bytes.length) {
      end = at;
      break;
    }
  }
  if (end < 0) return format;
  const disk = dv.getUint16(end + 4, true);
  const centralDisk = dv.getUint16(end + 6, true);
  const here = dv.getUint16(end + 8, true);
  const count = dv.getUint16(end + 10, true);
  const size = dv.getUint32(end + 12, true);
  const offset = dv.getUint32(end + 16, true);
  // (zip64 : des 0xffff et 0xffffffff à la place des vraies valeurs ; plusieurs morceaux : des disques)
  if (disk !== 0 || centralDisk !== 0 || here !== count || count === 0xffff || offset === 0xffffffff || offset + size > end) return format;
  if (count > limits.entries) return { ok: false, problem: { code: "entries", count, max: limits.entries } };
  const entries = new Map<string, Entry>();
  const seen = new Set<string>();
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || dv.getUint32(at, true) !== CENTRAL) return format;
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const crc = dv.getUint32(at + 16, true);
    const packed = dv.getUint32(at + 20, true);
    const unpacked = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const next = at + 46 + nameLength + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    if (next > end) return format;
    // (l'ancien Compress-Archive de Windows PowerShell séparait les dossiers par des barres obliques inverses)
    const name = utf8Text(bytes.subarray(at + 46, at + 46 + nameLength))?.replace(/\\/g, "/");
    if (name === undefined) return format;
    at = next;
    if (!safeEntryName(name)) return { ok: false, problem: { code: "path", name: name.slice(0, 64) } };
    if (seen.has(name)) return format;
    seen.add(name);
    if (name.endsWith("/")) continue;
    if (flags & ENCRYPTED || (method !== STORED && method !== DEFLATE) || packed === 0xffffffff || unpacked === 0xffffffff) return format;
    if (method === STORED && packed !== unpacked) return format;
    entries.set(name, { method, crc, packed, size: unpacked, local });
  }
  return { ok: true, archive: new ZipArchive(bytes, entries, offset) };
}

/** Une entrée à écrire : son nom, ses octets, et si elle mérite d'être dégonflée (un PNG, un Ogg le sont déjà). */
export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly deflate?: boolean;
}

/** Écrit une archive (les entrées dans l'ordre donné ; une entrée dégonflée qui n'y gagne pas est rangée telle quelle). */
export async function writeZip(entries: readonly ZipEntry[], deflateRaw: DeflateRaw): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!safeEntryName(entry.name)) throw new Error(`Nom d'entrée refusé : ${entry.name}`);
    const name = utf8Bytes(entry.name);
    const crc = zipCrc(entry.data);
    let method = STORED;
    let packed = entry.data;
    if (entry.deflate) {
      const squeezed = await deflateRaw(entry.data);
      if (squeezed.length < entry.data.length) {
        method = DEFLATE;
        packed = squeezed;
      }
    }
    const header = new Uint8Array(30 + name.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, LOCAL, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, UTF8, true);
    h.setUint16(8, method, true);
    h.setUint16(10, 0, true);
    h.setUint16(12, EPOCH_DATE, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, packed.length, true);
    h.setUint32(22, entry.data.length, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, CENTRAL, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, UTF8, true);
    c.setUint16(10, method, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, EPOCH_DATE, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, packed.length, true);
    c.setUint32(24, entry.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(header, packed);
    centrals.push(central);
    offset += header.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const tail = new Uint8Array(22);
  const t = new DataView(tail.buffer);
  t.setUint32(0, END, true);
  t.setUint16(8, entries.length, true);
  t.setUint16(10, entries.length, true);
  t.setUint32(12, centralSize, true);
  t.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, tail]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
