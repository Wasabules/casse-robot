import type { MapFile } from "./format";

/*
 * Une carte en texte (le fichier .casse-map.json), lisible et exacte : un champ de premier niveau par
 * ligne, un élément d'une liste (boîte, accessoire, zone…) par ligne, ce qui est court sur une ligne.
 * Chaque nombre s'écrit au plus court qui le redonne exactement, et -0 s'écrit « -0 » : JSON.stringify
 * l'écrirait « 0 », alors que JSON.parse relit « -0 » tel quel (le signe d'un zéro d'une orientation
 * exportée d'une arène du jeu compte pour la redonner au bit près, voir map/export.ts).
 */

/** Au-delà de cette longueur, un objet ou une liste d'objets s'écrit sur plusieurs lignes. */
const LINE = 100;

const number = (v: number): string => (Object.is(v, -0) ? "-0" : JSON.stringify(v));

/** Une valeur JSON sur une ligne (sans les champs indéfinis, comme JSON.stringify). */
function compact(v: unknown): string {
  if (typeof v === "number") return number(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : compact(x))).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}:${compact(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Une liste de nombres, ou de listes de nombres (des points, des liaisons) : sur une ligne. */
const flat = (list: readonly unknown[]): boolean => list.every((x) => !x || typeof x !== "object" || (Array.isArray(x) && x.every((y) => !y || typeof y !== "object")));

function layout(v: unknown, indent: string): string {
  const line = compact(v);
  if (line.length <= LINE || !v || typeof v !== "object" || (Array.isArray(v) && flat(v))) return line;
  const inner = `${indent}  `;
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + compact(x)).join(",\n")}\n${indent}]`;
  const fields = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${layout(x, inner)}`);
  return `{\n${fields.join(",\n")}\n${indent}}`;
}

/**
 * L'ordre des champs de premier niveau dans un fichier : ce qui décrit la carte, puis ses éléments,
 * puis son relief (une très longue ligne) ; un champ inconnu (« $schema ») en tête.
 */
const FILE_ORDER: readonly string[] = [
  "format", "meta", "bounds", "limits", "sky", "ground", "ambience", "water", "lava", "vents", "falls", "paths", "urban", "nav", "navGraph",
  "zones", "places", "spawns", "boxes", "props", "prefabs", "terrain",
] satisfies readonly (keyof MapFile)[];

/**
 * Le texte d'un fichier de carte (terminé par un saut de ligne) ; aussi la carte d'un paquet
 * (map/pack.ts). Une carte lue (`readMap`) puis réécrite redonne le même texte.
 */
export function mapText(map: MapFile | object): string {
  const rank = (k: string): number => FILE_ORDER.indexOf(k);
  const keys = Object.keys(map).sort((a, b) => rank(a) - rank(b));
  const ordered = Object.fromEntries(keys.map((k) => [k, (map as Record<string, unknown>)[k]]));
  return `${layout(ordered, "")}\n`;
}
