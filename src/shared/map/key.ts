import type { MapKey } from "../arena/layout";
import type { MapFile } from "./format";

/*
 * Identifiant d'une carte communautaire : le hachage de son contenu, écrit sous une forme canonique
 * (clés triées, sans valeurs indéfinies) : la même carte a le même identifiant sur le serveur et dans
 * chaque navigateur, quel que soit l'ordre de ses champs ou la mise en forme de son fichier. Un
 * client qui l'a déjà (en cache, d'après cet identifiant) ne la reçoit pas une seconde fois.
 */

/** JSON aux clés triées, sans `undefined` : une forme unique pour un même contenu. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/** Hachage de 64 bits d'un texte (deux mélanges de 32 bits, à la manière de cyrb53), en 16 chiffres hexadécimaux. */
export function hash64(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** L'identifiant d'une carte (« map- » et 16 chiffres hexadécimaux), d'après son contenu. */
export function mapKey(map: MapFile): MapKey {
  return `map-${hash64(canonicalJson(map))}`;
}
