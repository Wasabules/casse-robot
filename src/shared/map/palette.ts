import type { BoxLook, StaticKind } from "../arena/layout";
import { PROP_TYPES, propDef, type PropType } from "../catalog/props";
import { freeZoneLabel, normalAngle, type ElementList, type MapElement } from "./edit";
import type { MapBox, MapFile, MapLava, MapPath, MapPoint, MapPrefab, MapProp, MapSize } from "./format";

/*
 * La palette de l'éditeur de cartes : ce qu'on pose d'un clic (un préfabriqué, un accessoire, une
 * boîte du décor, une zone, un lieu, une fumerolle, une cascade, un lac de lave) ou point par point
 * (un chemin, une clôture, une coulée de lave, un pont : `TraceKind`), avec ses valeurs par défaut.
 * Ses noms sont dans chaque langue (client/i18n/locales/<langue>/editor.ts). Un élément de plus :
 * une entrée ici, et son nom (`editor.palette.<id>`) ; il se pose, se règle et se vérifie tout seul.
 */

/** Onglets de la palette. */
export type PaletteTab = "prefabs" | "props" | "boxes" | "markers";
export const PALETTE_TABS: readonly PaletteTab[] = ["prefabs", "props", "boxes", "markers"];

/** Ce qui se trace point par point. */
export type TraceKind = "path" | "fence" | "lavaFlow" | "bridge";
export const TRACE_KINDS: readonly TraceKind[] = ["path", "fence", "lavaFlow", "bridge"];

/** Ce que sait l'éditeur de l'endroit où l'on pose : le point, l'orientation (degrés), la carte, le sol, et ce qu'on a choisi. */
export interface PlaceContext {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly map: MapFile;
  ground(x: number, z: number): number;
  /** Le nom d'un nouveau lieu (le client l'écrit dans la langue du joueur). */
  readonly placeName?: string;
  /** L'allure des boîtes qu'on pose (celle de leur sorte, sans elle). */
  readonly look?: BoxLook;
}

/** Ce qu'on ajoute : la liste, l'élément. */
export interface Placed {
  readonly list: Exclude<ElementList, "spawns">;
  readonly element: MapElement;
}

/** Sous-groupes de la palette (leur nom : `editor.group.<groupe>`). */
export type PaletteGroup = "buildings" | "nature" | "mobile" | "walls" | "fixtures" | "solid" | "ground" | "play" | "fire" | "water";
/** Les entrées qui ont leur propre nom (`editor.palette.<id>`) ; les autres prennent celui d'un accessoire ou d'une sorte de boîte. */
export type NamedPaletteId = "house" | "tenement" | "fence" | "ramp" | "bridge" | "containers" | "woods" | "rocks" | "zone" | "place" | "path" | "vent" | "lavaPool" | "lavaFlow" | "fall";

export interface PaletteEntry {
  /** Identifiant (« house », « prop.crate », « box.pillar », « zone ») : son nom est `editor.palette.<id>`. */
  readonly id: string;
  readonly tab: PaletteTab;
  /** Sous-groupe dans son onglet. */
  readonly group: PaletteGroup;
  /** Se trace point par point (un clic par point, Entrée pour finir). */
  readonly trace?: TraceKind;
  /** L'élément posé là ; null s'il ne peut plus l'être (cinq zones déjà). */
  readonly make?: (at: PlaceContext) => Placed | null;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
/** Un tirage d'après la place (un bois posé ailleurs n'a pas les mêmes arbres). */
const seedAt = (x: number, z: number): number => Math.abs(Math.round(x * 73 + z * 131)) % 100000;
const yawOf = (at: PlaceContext): number | undefined => (normalAngle(at.yaw) ? normalAngle(at.yaw) : undefined);

/** Ce qu'a un élément tourné : son lacet, sans le noter s'il est nul. */
function turned<T extends object>(e: T, at: PlaceContext): T {
  const yaw = yawOf(at);
  return yaw === undefined ? e : { ...e, yaw };
}

/** Dimensions par défaut d'une dalle posée seule (un pan de mur, un toit, un étage). */
const SLAB_SIZE: Partial<Record<PropType, MapSize>> = {
  brick: [4, 3, 0.3], concrete: [4, 3, 0.3], plank: [4, 2.5, 0.1], sheet: [4, 2.5, 0.08], roof: [5, 0.15, 4],
  facade: [6, 3.6, 0.4], tenement: [6, 3.6, 0.4],
};

/** Les dimensions par défaut d'une dalle de ce type (un pan de mur, un toit ; rien pour une voiture, qui a les siennes). */
export const slabSize = (type: PropType): MapSize | undefined => SLAB_SIZE[type];

/** Les accessoires, par groupe. */
const PROP_GROUPS: Record<PropType, PaletteGroup> = {
  crate: "mobile", barrel: "mobile", gas: "mobile", car: "mobile",
  brick: "walls", concrete: "walls", plank: "walls", sheet: "walls", roof: "walls", facade: "walls", tenement: "walls", wreck: "walls",
  pine: "nature", oak: "nature", palm: "nature", kapok: "nature", cactus: "nature",
  watertank: "fixtures", tank: "fixtures", lamppost: "fixtures", floodlight: "fixtures",
};

/** Dimensions par défaut d'une boîte de chaque sorte, et son groupe. */
const BOX_DEFAULTS: Record<StaticKind, { size: MapSize; group: PaletteGroup; pitch?: number }> = {
  wall: { size: [8, 3, 0.6], group: "solid" },
  pillar: { size: [1.2, 4, 1.2], group: "solid" },
  barrier: { size: [4, 1, 0.6], group: "solid" },
  platform: { size: [8, 2, 8], group: "solid" },
  container: { size: [2.4, 2.6, 6], group: "solid" },
  rock: { size: [3, 2, 3], group: "solid" },
  tower: { size: [10, 24, 10], group: "solid" },
  ramp: { size: [4, 0.5, 8], group: "ground", pitch: -15 },
  deck: { size: [6, 0.6, 12], group: "ground" },
  road: { size: [6, 0.1, 20], group: "ground" },
  track: { size: [3, 0.2, 20], group: "ground" },
  bound: { size: [10, 20, 1], group: "ground" },
};

/** Les préfabriqués posés d'un clic. */
function prefab(id: MapPrefab["kind"] & NamedPaletteId, make: (at: PlaceContext) => MapPrefab): PaletteEntry {
  return { id, tab: "prefabs", group: id === "woods" || id === "rocks" ? "nature" : "buildings", make: (at) => ({ list: "prefabs", element: make(at) }) };
}

export const PALETTE: readonly PaletteEntry[] = [
  // --- Préfabriqués ---
  prefab("house", (at) => turned({ kind: "house", x: at.x, z: at.z, width: 10, depth: 7, height: 3.2, wall: "brick", roof: "roof" } as const, at)),
  prefab("tenement", (at) => turned({ kind: "tenement", x: at.x, z: at.z, width: 14, depth: 10, floors: 3, wall: "facade", seed: seedAt(at.x, at.z) } as const, at)),
  { id: "fence", tab: "prefabs", group: "buildings", trace: "fence" },
  prefab("ramp", (at) => turned({ kind: "ramp", x: at.x, z: at.z, width: 6, length: 10, rise: 3 } as const, at)),
  { id: "bridge", tab: "prefabs", group: "buildings", trace: "bridge" },
  prefab("containers", (at) => turned({ kind: "containers", x: at.x, z: at.z, count: 3 } as const, at)),
  prefab("woods", (at) => ({ kind: "woods", x: at.x, z: at.z, radius: 14, count: 24, seed: seedAt(at.x, at.z) })),
  prefab("rocks", (at) => ({ kind: "rocks", x: at.x, z: at.z, radius: 10, count: 8, seed: seedAt(at.x, at.z) })),
  // --- Accessoires ---
  ...(Object.keys(PROP_TYPES) as PropType[]).map((type): PaletteEntry => ({
    id: `prop.${type}`,
    tab: "props",
    group: PROP_GROUPS[type],
    make: (at) => {
      const size = SLAB_SIZE[type];
      const prop: MapProp = turned({ type, x: r1(at.x), z: r1(at.z), ...(size && propDef(type).shape.kind === "slab" ? { size } : {}) }, at);
      return { list: "props", element: prop };
    },
  })),
  // --- Boîtes du décor ---
  ...(Object.keys(BOX_DEFAULTS) as StaticKind[]).map((kind): PaletteEntry => ({
    id: `box.${kind}`,
    tab: "boxes",
    group: BOX_DEFAULTS[kind].group,
    make: (at) => {
      const d = BOX_DEFAULTS[kind];
      const box: MapBox = turned({ kind, x: r1(at.x), z: r1(at.z), size: d.size, ...(d.pitch ? { pitch: d.pitch } : {}), ...(at.look ? { look: at.look } : {}) }, at);
      return { list: "boxes", element: box };
    },
  })),
  // --- Repères de jeu, eau et feu ---
  {
    id: "zone", tab: "markers", group: "play",
    make: (at) => {
      const label = freeZoneLabel(at.map);
      return label ? { list: "zones", element: { label, x: r1(at.x), z: r1(at.z), radius: 6 } } : null;
    },
  },
  { id: "place", tab: "markers", group: "play", make: (at) => ({ list: "places", element: { name: at.placeName || "?", x: r1(at.x), z: r1(at.z) } }) },
  { id: "path", tab: "markers", group: "ground", trace: "path" },
  { id: "vent", tab: "markers", group: "fire", make: (at) => ({ list: "vents", element: { x: r1(at.x), z: r1(at.z), size: 1.5, steam: true } }) },
  { id: "lavaPool", tab: "markers", group: "fire", make: (at) => ({ list: "lava", element: { kind: "pool", x: r1(at.x), z: r1(at.z), r: 6 } }) },
  { id: "lavaFlow", tab: "markers", group: "fire", trace: "lavaFlow" },
  {
    id: "fall", tab: "markers", group: "water",
    make: (at) => {
      const bottom = r1(at.ground(at.x, at.z));
      return { list: "falls", element: { x: r1(at.x), z: r1(at.z), top: bottom + 6, bottom, width: 4, dir: normalAngle(at.yaw) } };
    },
  },
];

export const paletteEntry = (id: string): PaletteEntry | undefined => PALETTE.find((e) => e.id === id);

/** Points qu'il faut au moins pour un tracé (un pont : ses deux bouts, pas plus). */
export const TRACE_POINTS: Record<TraceKind, { min: number; max: number }> = {
  path: { min: 2, max: 128 }, fence: { min: 2, max: 128 }, lavaFlow: { min: 2, max: 128 }, bridge: { min: 2, max: 2 },
};

/** L'élément d'un tracé fini (assez de points), ou null. */
export function traceElement(kind: TraceKind, points: readonly MapPoint[]): Placed | null {
  if (points.length < TRACE_POINTS[kind].min) return null;
  const pts = points.slice(0, TRACE_POINTS[kind].max).map(([x, z]): MapPoint => [r1(x), r1(z)]);
  switch (kind) {
    case "path": {
      const path: MapPath = { width: 4, points: pts, surface: "dirt" };
      return { list: "paths", element: path };
    }
    case "lavaFlow": {
      const flow: MapLava = { kind: "flow", width: 6, points: pts };
      return { list: "lava", element: flow };
    }
    case "fence":
      return { list: "prefabs", element: { kind: "fence", points: pts, material: "plank" } };
    case "bridge":
      return { list: "prefabs", element: { kind: "bridge", from: pts[0], to: pts[1], width: 6 } };
  }
}
