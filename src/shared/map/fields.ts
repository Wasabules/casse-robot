import type { BoxLook, PathSurface, StaticKind } from "../arena/layout";
import { ARENA_IDS } from "../arena/layout";
import { PROP_TYPES, propDef, type PropType } from "../catalog/props";
import type { ElementList, MapElement } from "./edit";
import { MAP_LIMITS, type MapPrefab } from "./format";

/*
 * Les champs de chaque sorte d'élément d'une carte, avec leurs bornes (celles que vérifie la
 * lecture, map/read.ts) : le panneau des propriétés de l'éditeur de cartes se construit d'après eux.
 * Leurs noms sont dans chaque langue (`editor.field.<clé>`), et ceux des choix aussi
 * (`ChoiceNames`). Un champ nouveau dans le format : une ligne ici (tests/mapEditor.test.ts vérifie
 * que ses bornes sont celles de la lecture).
 */

/** Les sortes d'éléments, chacune avec son formulaire. */
export type FormId =
  | "box" | "prop" | "house" | "tenement" | "fence" | "woods" | "rocks" | "ramp" | "bridge" | "containers"
  | "zone" | "place" | "vent" | "fall" | "path" | "lavaFlow" | "lavaPool" | "spawn";

/** D'où viennent les noms des choix (le client les traduit). */
export type ChoiceNames = "boxKind" | "look" | "prop" | "surface" | "roofKind" | "rockLook" | "letter";

/** Les champs (leur nom : `editor.field.<clé>`). */
export type FieldKey =
  | "x" | "z" | "y" | "yaw" | "pitch" | "roll" | "kind" | "look" | "size" | "round" | "underpass" | "approach" | "type" | "scale" | "group"
  | "width" | "depth" | "height" | "wall" | "roof" | "roofKind" | "door" | "through" | "floors" | "ruin" | "seed" | "material" | "radius"
  | "count" | "trees" | "spacing" | "length" | "rise" | "base" | "parapets" | "piers" | "levels" | "label" | "name" | "steam" | "top"
  | "bottom" | "dir" | "surface" | "r" | "facing";

export type FieldSpec =
  /** Un nombre ; `optional` : absent, la valeur par défaut (« auto ») ; `int` : entier. */
  | { readonly key: FieldKey; readonly type: "number"; readonly min: number; readonly max: number; readonly step: number; readonly optional?: boolean; readonly int?: boolean }
  /** Un angle (degrés) ; absent (facultatif), 0. */
  | { readonly key: FieldKey; readonly type: "angle"; readonly optional?: boolean }
  /** Un choix parmi des valeurs ; `optional` : « par défaut » en plus. */
  | { readonly key: FieldKey; readonly type: "choice"; readonly options: readonly string[]; readonly names: ChoiceNames; readonly optional?: boolean }
  /** Oui ou non ; absent : `byDefault` (non, sauf mention). */
  | { readonly key: FieldKey; readonly type: "bool"; readonly byDefault?: boolean }
  /** Trois longueurs [x, y, z] (m). */
  | { readonly key: FieldKey; readonly type: "size"; readonly min: number; readonly max: number }
  /** Deux nombres [a, b], a ≤ b. */
  | { readonly key: FieldKey; readonly type: "range"; readonly min: number; readonly max: number; readonly step: number; readonly optional?: boolean }
  /** Un texte. */
  | { readonly key: FieldKey; readonly type: "text"; readonly max: number }
  /** Plusieurs essences d'arbres. */
  | { readonly key: FieldKey; readonly type: "trees" };

const STATIC_KINDS: readonly StaticKind[] = ["wall", "pillar", "barrier", "platform", "container", "rock", "tower", "ramp", "deck", "road", "track", "bound"];
export const BOX_LOOKS: readonly BoxLook[] = [
  "sandstone", "timber", "rail", "wagon", "wood", "basalt", "rust", "quay", "steel", "hull", "superstructure", "hatch", "funnel", "lighthouse", "lamp", "silo", "container",
];
export const PATH_SURFACES: readonly PathSurface[] = ["dirt", "grass", "sand", "road", "gravel", "ballast", "asphalt"];
const WALLS = ["brick", "concrete", "plank", "sheet"] as const;
const ROOFS = ["roof", "sheet", "concrete", "plank"] as const;
export const TREE_TYPES = ["pine", "oak", "palm", "kapok", "cactus"] as const;
/** Les arènes du jeu (palette du sol, ambiance). */
export const PRESET_ARENAS = ARENA_IDS;

const L = MAP_LIMITS;
const at: readonly FieldSpec[] = [
  { key: "x", type: "number", min: -L.reach, max: L.reach, step: 0.5 },
  { key: "z", type: "number", min: -L.reach, max: L.reach, step: 0.5 },
];
const height = (key: FieldKey): FieldSpec => ({ key, type: "number", min: L.minY, max: L.maxY, step: 0.1, optional: true });
const yaw: FieldSpec = { key: "yaw", type: "angle", optional: true };
const seed: FieldSpec = { key: "seed", type: "number", min: 0, max: 99999, step: 1, int: true, optional: true };

export const FORMS: Readonly<Record<FormId, readonly FieldSpec[]>> = {
  box: [
    { key: "kind", type: "choice", options: STATIC_KINDS, names: "boxKind" },
    { key: "look", type: "choice", options: BOX_LOOKS, names: "look", optional: true },
    ...at, height("y"),
    { key: "size", type: "size", min: 0.1, max: L.maxSize },
    yaw, { key: "pitch", type: "angle", optional: true }, { key: "roll", type: "angle", optional: true },
    { key: "round", type: "bool" }, { key: "underpass", type: "bool" },
    { key: "approach", type: "number", min: 0, max: 100, step: 0.5, optional: true },
  ],
  prop: [
    { key: "type", type: "choice", options: Object.keys(PROP_TYPES), names: "prop" },
    ...at, height("y"), yaw, { key: "pitch", type: "angle", optional: true }, { key: "roll", type: "angle", optional: true },
    { key: "size", type: "size", min: 0.05, max: L.maxSize },
    { key: "scale", type: "number", min: 0.2, max: 4, step: 0.05, optional: true },
    { key: "group", type: "number", min: 0, max: 10000, step: 1, int: true, optional: true },
  ],
  house: [
    ...at, height("y"), yaw,
    { key: "width", type: "number", min: 2, max: 40, step: 0.5 },
    { key: "depth", type: "number", min: 2, max: 30, step: 0.5 },
    { key: "height", type: "number", min: 1.5, max: 12, step: 0.1 },
    { key: "wall", type: "choice", options: WALLS, names: "prop" },
    { key: "roof", type: "choice", options: ROOFS, names: "prop" },
    { key: "roofKind", type: "choice", options: ["gable", "flat"], names: "roofKind", optional: true },
    { key: "door", type: "number", min: 0.5, max: 38, step: 0.1, optional: true },
    { key: "through", type: "bool" },
  ],
  tenement: [
    ...at, height("y"), yaw,
    { key: "width", type: "number", min: 4, max: 60, step: 0.5 },
    { key: "depth", type: "number", min: 4, max: 60, step: 0.5 },
    { key: "floors", type: "number", min: 1, max: L.floors, step: 1, int: true },
    { key: "wall", type: "choice", options: ["facade", "tenement", "brick", "concrete"], names: "prop" },
    { key: "ruin", type: "number", min: 0, max: 1, step: 0.05, optional: true },
    seed,
  ],
  fence: [
    { key: "height", type: "number", min: 0.3, max: 6, step: 0.1, optional: true },
    { key: "material", type: "choice", options: WALLS, names: "prop", optional: true },
  ],
  woods: [
    ...at,
    { key: "radius", type: "number", min: 1, max: 150, step: 0.5 },
    { key: "count", type: "number", min: 1, max: L.scatter, step: 1, int: true },
    { key: "trees", type: "trees" },
    { key: "scale", type: "range", min: 0.3, max: 2.5, step: 0.05, optional: true },
    { key: "spacing", type: "number", min: 1, max: 40, step: 0.5, optional: true },
    seed,
  ],
  rocks: [
    ...at,
    { key: "radius", type: "number", min: 1, max: 150, step: 0.5 },
    { key: "count", type: "number", min: 1, max: L.scatter, step: 1, int: true },
    { key: "size", type: "range", min: 0.3, max: 8, step: 0.1, optional: true },
    { key: "look", type: "choice", options: ["sandstone", "basalt"], names: "rockLook", optional: true },
    seed,
  ],
  ramp: [
    ...at, yaw,
    { key: "width", type: "number", min: 1, max: 40, step: 0.5 },
    { key: "length", type: "number", min: 1, max: 80, step: 0.5 },
    { key: "rise", type: "number", min: 0.1, max: 30, step: 0.1 },
    height("base"),
  ],
  bridge: [
    { key: "width", type: "number", min: 2, max: 30, step: 0.5 },
    height("y"),
    { key: "parapets", type: "bool", byDefault: true },
    { key: "piers", type: "number", min: 0, max: L.piers, step: 1, int: true, optional: true },
    { key: "look", type: "choice", options: BOX_LOOKS, names: "look", optional: true },
  ],
  containers: [
    ...at, height("y"), yaw,
    { key: "count", type: "number", min: 1, max: L.containers, step: 1, int: true, optional: true },
    { key: "levels", type: "number", min: 1, max: L.levels, step: 1, int: true, optional: true },
  ],
  zone: [
    { key: "label", type: "choice", options: ["A", "B", "C", "D", "E"], names: "letter" },
    ...at, height("y"),
    { key: "radius", type: "number", min: 2, max: 30, step: 0.5 },
  ],
  place: [{ key: "name", type: "text", max: L.place }, ...at],
  vent: [...at, height("y"), { key: "size", type: "number", min: 0.2, max: 6, step: 0.1 }, { key: "steam", type: "bool" }],
  fall: [
    ...at,
    { key: "top", type: "number", min: L.minY, max: L.maxY, step: 0.1 },
    { key: "bottom", type: "number", min: L.minY, max: L.maxY, step: 0.1 },
    { key: "width", type: "number", min: 0.2, max: 60, step: 0.1 },
    { key: "dir", type: "angle" },
  ],
  path: [
    { key: "width", type: "number", min: 0.5, max: 40, step: 0.5 },
    { key: "surface", type: "choice", options: PATH_SURFACES, names: "surface", optional: true },
  ],
  lavaFlow: [{ key: "width", type: "number", min: 0.5, max: 60, step: 0.5 }],
  lavaPool: [...at, { key: "r", type: "number", min: 0.5, max: 120, step: 0.5 }],
  spawn: [...at, { key: "facing", type: "angle" }, { key: "width", type: "number", min: L.minSpawnWidth, max: L.maxSpawnWidth, step: 1 }],
};

/** Le formulaire d'un élément de cette liste. */
export function formOf(list: ElementList, e: MapElement): FormId {
  switch (list) {
    case "boxes": return "box";
    case "props": return "prop";
    case "prefabs": return (e as MapPrefab).kind;
    case "zones": return "zone";
    case "places": return "place";
    case "vents": return "vent";
    case "falls": return "fall";
    case "paths": return "path";
    case "lava": return (e as { kind: "flow" | "pool" }).kind === "flow" ? "lavaFlow" : "lavaPool";
    case "spawns": return "spawn";
  }
}

/** Ce champ vaut-il pour cet élément ? (Les dimensions d'un accessoire : seulement une dalle ; son échelle : seulement ce qui n'en est pas une.) */
export function fieldApplies(form: FormId, field: FieldSpec, e: MapElement): boolean {
  if (form !== "prop") return true;
  const slab = propDef((e as { type: PropType }).type).shape.kind === "slab";
  if (field.key === "size") return slab;
  if (field.key === "scale") return !slab;
  return true;
}

/** La valeur d'un champ d'un élément (undefined : absent ; un oui ou non absent : sa valeur par défaut). */
export function fieldValue(e: MapElement, field: FieldSpec): unknown {
  const v = (e as unknown as Record<string, unknown>)[field.key];
  return v === undefined && field.type === "bool" ? field.byDefault ?? false : v;
}

/** L'élément, avec ce champ changé (undefined : retiré ; un angle nul, retiré aussi s'il est facultatif). */
export function withField(e: MapElement, field: FieldSpec, value: unknown): MapElement {
  const out = { ...(e as unknown as Record<string, unknown>) };
  const absent = value === undefined || (field.type === "angle" && field.optional && value === 0) || (field.type === "bool" && value === (field.byDefault ?? false));
  if (absent) delete out[field.key];
  else out[field.key] = value;
  return out as unknown as MapElement;
}
