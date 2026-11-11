import { mapBounds } from "./build";
import {
  MAP_LIMITS, type MapBox, type MapFall, type MapFile, type MapIssue, type MapLava, type MapPath, type MapPlace, type MapPoint, type MapPrefab,
  type MapProp, type MapSpawn, type MapSpawns, type MapVent, type MapZone,
} from "./format";

/*
 * Opérations d'édition sur une carte (l'éditeur de cartes) : désigner un élément (`ElementRef` :
 * sa liste et son rang), l'ajouter, le remplacer, le déplacer, le tourner, le dupliquer, le
 * supprimer. Chacune rend une nouvelle carte et laisse l'ancienne intacte (ce qui ne change pas est
 * partagé : le relief, les autres listes) : l'historique d'annulation garde les cartes telles
 * quelles (map/history.ts). Les rangs des accessoires sur lesquels un autre repose (`rests`) et les
 * bâtiments (`group`) suivent. Des fonctions pures : tests/mapEditor.test.ts.
 */

/** Les listes d'éléments d'une carte ; `spawns` : les deux lignes de départ (0, les bleus ; 1, les rouges). */
export type ElementList = "boxes" | "props" | "prefabs" | "zones" | "places" | "vents" | "falls" | "paths" | "lava" | "spawns";
export const ELEMENT_LISTS: readonly ElementList[] = ["boxes", "props", "prefabs", "zones", "places", "vents", "falls", "paths", "lava", "spawns"];

/** Un élément de la carte : sa liste, son rang. */
export interface ElementRef {
  readonly list: ElementList;
  readonly index: number;
}

export type MapElement = MapBox | MapProp | MapPrefab | MapZone | MapPlace | MapVent | MapFall | MapPath | MapLava | MapSpawn;

/** Ce que contient chaque liste. */
export interface ElementOf {
  boxes: MapBox;
  props: MapProp;
  prefabs: MapPrefab;
  zones: MapZone;
  places: MapPlace;
  vents: MapVent;
  falls: MapFall;
  paths: MapPath;
  lava: MapLava;
  spawns: MapSpawn;
}

/** Clé d'un élément (« props:3 ») : pour un ensemble, une table. */
export const refKey = (r: ElementRef): string => `${r.list}:${r.index}`;
export const sameRef = (a: ElementRef, b: ElementRef): boolean => a.list === b.list && a.index === b.index;

const TEAMS = ["blue", "red"] as const;

/** Les lignes de départ de la carte : les siennes, ou celles de ses dimensions de jeu (au nord et au sud). */
export function spawnsOf(map: MapFile): MapSpawns {
  if (map.spawns) return map.spawns;
  const b = mapBounds(map, 0);
  const width = Math.min(MAP_LIMITS.maxSpawnWidth, Math.max(MAP_LIMITS.minSpawnWidth, 2 * b.spawnSpread));
  return { blue: { x: 0, z: -b.spawnLine, facing: 0, width }, red: { x: 0, z: b.spawnLine, facing: 180, width } };
}

/** Les éléments d'une liste. */
export function elementsOf<L extends ElementList>(map: MapFile, list: L): readonly ElementOf[L][] {
  if (list === "spawns") {
    const s = spawnsOf(map);
    return [s.blue, s.red] as unknown as readonly ElementOf[L][];
  }
  return ((map as unknown as Record<string, unknown>)[list] ?? []) as readonly ElementOf[L][];
}

export function getElement(map: MapFile, ref: ElementRef): MapElement | undefined {
  return elementsOf(map, ref.list)[ref.index];
}

/** La carte, avec cette liste remplacée (vide : retirée, sauf les zones). */
function withList(map: MapFile, list: ElementList, items: readonly MapElement[]): MapFile {
  if (list === "spawns") return { ...map, spawns: { blue: items[0] as MapSpawn, red: items[1] as MapSpawn } };
  const out = { ...map } as Record<string, unknown>;
  if (items.length || list === "zones") out[list] = items;
  else delete out[list];
  return out as unknown as MapFile;
}

/** Remplace un élément. */
export function setElement(map: MapFile, ref: ElementRef, element: MapElement): MapFile {
  const items = [...elementsOf(map, ref.list)] as MapElement[];
  if (ref.index < 0 || ref.index >= items.length) return map;
  items[ref.index] = element;
  return withList(map, ref.list, items);
}

/** Ajoute un élément au bout de sa liste ; rend la carte et l'élément. */
export function addElement(map: MapFile, list: Exclude<ElementList, "spawns">, element: MapElement): { map: MapFile; ref: ElementRef } {
  const items = [...elementsOf(map, list), element] as MapElement[];
  return { map: withList(map, list, items), ref: { list, index: items.length - 1 } };
}

/** Les points d'un élément tracé (clôture, chemin, coulée, pont : ses deux bouts), ou null. */
export function elementPoints(e: MapElement): readonly MapPoint[] | null {
  if ("points" in e) return e.points;
  if ("kind" in e && e.kind === "bridge") return [e.from, e.to];
  return null;
}

/** Centre d'un élément dans le plan [x, z]. */
export function elementCenter(e: MapElement): MapPoint {
  const points = elementPoints(e);
  if (points?.length) {
    let x = 0;
    let z = 0;
    for (const [px, pz] of points) {
      x += px;
      z += pz;
    }
    return [x / points.length, z / points.length];
  }
  const p = e as { x: number; z: number };
  return [p.x, p.z];
}

/** Le centre de plusieurs éléments. */
export function centerOf(map: MapFile, refs: readonly ElementRef[]): MapPoint | null {
  const centers = refs.map((r) => getElement(map, r)).filter((e): e is MapElement => !!e).map(elementCenter);
  if (!centers.length) return null;
  return [centers.reduce((s, c) => s + c[0], 0) / centers.length, centers.reduce((s, c) => s + c[1], 0) / centers.length];
}

/** Un nombre arrondi au centimètre (les coordonnées d'une carte n'ont pas besoin de plus), dans les bornes du plan. */
const coord = (v: number): number => Math.max(-MAP_LIMITS.reach, Math.min(MAP_LIMITS.reach, Math.round(v * 100) / 100));
/** Un angle (degrés) ramené à ]-180, 180], arrondi au dixième. */
export const normalAngle = (deg: number): number => {
  const a = Math.round((((deg % 360) + 540) % 360 - 180) * 10) / 10;
  return a === -180 ? 180 : a;
};

/** Un point tourné de `deg` degrés autour de (cx, cz), dans le sens du lacet (90 tourne le nord vers l'ouest). */
export function turnPoint([x, z]: MapPoint, deg: number, cx: number, cz: number): MapPoint {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - cx;
  const dz = z - cz;
  // Rotation autour de y : (x, z) → (x cos + z sin, -x sin + z cos)
  return [coord(cx + dx * c + dz * s), coord(cz - dx * s + dz * c)];
}

/** Un élément déplacé, puis tourné de `deg` degrés autour de (cx, cz) (sa propre orientation tourne d'autant). */
export function transformElement(e: MapElement, dx: number, dz: number, deg = 0, cx = 0, cz = 0): MapElement {
  const move = ([x, z]: MapPoint): MapPoint => (deg ? turnPoint([x + dx, z + dz], deg, cx, cz) : [coord(x + dx), coord(z + dz)]);
  if ("kind" in e && e.kind === "bridge") return { ...e, from: move(e.from), to: move(e.to) };
  if ("points" in e) return { ...e, points: e.points.map(move) };
  const p = e as MapElement & { x: number; z: number };
  const [x, z] = move([p.x, p.z]);
  const out: Record<string, unknown> = { ...p, x, z };
  if (deg) {
    if ("facing" in p) out.facing = normalAngle(p.facing + deg);
    else if ("dir" in p) out.dir = normalAngle(p.dir + deg);
    // Ce qui s'oriente (une boîte, un accessoire, un bâtiment, une rampe) ; pas un bois, une zone, un lieu
    else if (turns(p)) out.yaw = normalAngle(((p as { yaw?: number }).yaw ?? 0) + deg);
  }
  return out as unknown as MapElement;
}

/** Cet élément a-t-il une orientation (`yaw`) ? */
function turns(e: MapElement): boolean {
  if ("type" in e) return true; // un accessoire
  if ("kind" in e) {
    if ("size" in e && Array.isArray(e.size) && e.size.length === 3) return true; // une boîte
    return e.kind === "house" || e.kind === "tenement" || e.kind === "ramp" || e.kind === "containers";
  }
  return false;
}

/** Applique `change` à chaque élément désigné. */
function mapEach(map: MapFile, refs: readonly ElementRef[], change: (e: MapElement) => MapElement): MapFile {
  let out = map;
  const byList = new Map<ElementList, Set<number>>();
  for (const r of refs) byList.set(r.list, (byList.get(r.list) ?? new Set()).add(r.index));
  for (const [list, indices] of byList) {
    const items = elementsOf(out, list).map((e, i) => (indices.has(i) ? change(e) : e));
    out = withList(out, list, items);
  }
  return out;
}

/** Déplace des éléments de (dx, dz) m. */
export function moveElements(map: MapFile, refs: readonly ElementRef[], dx: number, dz: number): MapFile {
  if (!refs.length || (!dx && !dz)) return map;
  return mapEach(map, refs, (e) => transformElement(e, dx, dz));
}

/**
 * Tourne des éléments de `deg` degrés : un seul, sur lui-même ; plusieurs, ensemble autour de leur
 * centre (`pivot`, sinon le centre de la sélection).
 */
export function rotateElements(map: MapFile, refs: readonly ElementRef[], deg: number, pivot?: MapPoint): MapFile {
  if (!refs.length || !deg) return map;
  const center = pivot ?? centerOf(map, refs) ?? [0, 0];
  return mapEach(map, refs, (e) => {
    const [cx, cz] = refs.length === 1 && !pivot ? elementCenter(e) : center;
    return transformElement(e, 0, 0, deg, cx, cz);
  });
}

/** Déplace un point d'un élément tracé (un pont : 0, son départ ; 1, son arrivée). */
export function movePoint(map: MapFile, ref: ElementRef, point: number, x: number, z: number): MapFile {
  const e = getElement(map, ref);
  if (!e) return map;
  const at: MapPoint = [coord(x), coord(z)];
  if ("kind" in e && e.kind === "bridge") return setElement(map, ref, point === 0 ? { ...e, from: at } : { ...e, to: at });
  if (!("points" in e) || point < 0 || point >= e.points.length) return map;
  return setElement(map, ref, { ...e, points: e.points.map((p, i) => (i === point ? at : p)) } as MapElement);
}

/** Les éléments désignés d'une liste, rangs croissants. */
const indicesIn = (refs: readonly ElementRef[], list: ElementList): number[] =>
  [...new Set(refs.filter((r) => r.list === list).map((r) => r.index))].sort((a, b) => a - b);

/**
 * Supprime des éléments. Les lignes de départ ne se suppriment pas (sans elles, une équipe ne
 * partirait de nulle part). Les accessoires restants gardent ce sur quoi ils reposent (leurs rangs
 * suivent ; un appui supprimé est oublié).
 */
export function removeElements(map: MapFile, refs: readonly ElementRef[]): MapFile {
  let out = map;
  for (const list of ELEMENT_LISTS) {
    if (list === "spawns") continue;
    const gone = new Set(indicesIn(refs, list));
    if (!gone.size) continue;
    const items = elementsOf(out, list);
    if (list === "props") {
      // Nouveau rang de chaque accessoire gardé
      const rank = new Map<number, number>();
      let k = 0;
      items.forEach((_, i) => !gone.has(i) && rank.set(i, k++));
      const kept = (items as readonly MapProp[]).filter((_, i) => !gone.has(i)).map((p) => remapRests(p, rank));
      out = withList(out, list, kept);
    } else out = withList(out, list, items.filter((_, i) => !gone.has(i)));
  }
  return out;
}

/** Un accessoire dont les appuis changent de rang (`rank` : ancien → nouveau ; absent : oublié). */
function remapRests(p: MapProp, rank: ReadonlyMap<number, number>): MapProp {
  if (!p.rests) return p;
  const rests = p.rests.map((r) => rank.get(r)).filter((r): r is number => r !== undefined);
  const out: { -readonly [K in keyof MapProp]: MapProp[K] } = { ...p, rests };
  if (!rests.length) delete out.rests;
  return out;
}

/**
 * Duplique des éléments, décalés de (dx, dz) m ; rend la carte et les copies (dans l'ordre des
 * originaux). Une copie d'un accessoire repose sur les copies de ses appuis (s'ils sont copiés aussi),
 * et les copies d'un bâtiment forment un nouveau bâtiment. Les lignes de départ ne se dupliquent pas.
 */
export function duplicateElements(map: MapFile, refs: readonly ElementRef[], dx: number, dz: number): { map: MapFile; refs: ElementRef[] } {
  let out = map;
  const copies: ElementRef[] = [];
  for (const list of ELEMENT_LISTS) {
    if (list === "spawns") continue;
    const picked = indicesIn(refs, list);
    if (!picked.length) continue;
    const items = elementsOf(out, list);
    const start = items.length;
    let added: MapElement[];
    if (list === "props") {
      const props = items as readonly MapProp[];
      // Rang de chaque copie, et nouveau numéro de chaque bâtiment copié
      const rank = new Map(picked.map((i, k) => [i, start + k] as const));
      let group = props.reduce((m, p) => Math.max(m, p.group ?? -1), -1);
      const groups = new Map<number, number>();
      for (const i of picked) {
        const g = props[i].group;
        if (g !== undefined && !groups.has(g)) groups.set(g, ++group);
      }
      added = picked.map((i) => {
        const p = remapRests(transformElement(props[i], dx, dz) as MapProp, rank);
        return p.group !== undefined ? { ...p, group: groups.get(p.group)! } : p;
      });
    } else added = picked.map((i) => transformElement(items[i], dx, dz));
    out = withList(out, list, [...items, ...added]);
    added.forEach((_, k) => copies.push({ list, index: start + k }));
  }
  return { map: out, refs: copies };
}

/** Rangs que prend un élément d'une liste quand on supprime d'autres éléments de la même liste (null s'il est supprimé). */
export function refAfterRemoval(ref: ElementRef, removed: readonly ElementRef[]): ElementRef | null {
  const gone = removed.filter((r) => r.list === ref.list);
  if (ref.list === "spawns") return ref;
  if (gone.some((r) => r.index === ref.index)) return null;
  return { list: ref.list, index: ref.index - gone.filter((r) => r.index < ref.index).length };
}

/** Le nombre d'éléments de chaque liste (pour borner ce qu'on ajoute). */
export const countOf = (map: MapFile, list: ElementList): number => elementsOf(map, list).length;

/** La prochaine lettre libre pour une zone (A à E), ou null s'il y en a déjà cinq. */
export function freeZoneLabel(map: MapFile): string | null {
  const used = new Set(map.zones.map((z) => z.label));
  return ["A", "B", "C", "D", "E"].find((l) => !used.has(l)) ?? null;
}

/** Le chemin d'un champ fautif (« props[3].size ») : l'élément qu'il désigne. */
export function refOfPath(path: string): ElementRef | null {
  const m = /^(boxes|props|prefabs|zones|places|vents|falls|paths|lava)\[(\d+)\]/.exec(path);
  if (m) return { list: m[1] as ElementList, index: Number(m[2]) };
  const s = /^spawns\.(blue|red)/.exec(path);
  return s ? { list: "spawns", index: s[1] === "blue" ? 0 : 1 } : null;
}

/** Où est le problème d'une carte : l'élément en cause s'il y en a un, et un point du plan où regarder (null : nulle part en particulier). */
export function issueTarget(map: MapFile, issue: MapIssue): { ref: ElementRef | null; at: MapPoint } | null {
  const spawn = (team: "blue" | "red"): { ref: ElementRef; at: MapPoint } => {
    const s = spawnsOf(map)[team];
    return { ref: { list: "spawns", index: TEAMS.indexOf(team) }, at: [s.x, s.z] };
  };
  switch (issue.code) {
    case "field":
    case "text":
    case "outside":
    case "bounds": {
      if (issue.path === "bounds.spawnLine" || issue.path === "bounds.spawnSpread") return spawn("blue");
      const ref = refOfPath(issue.path);
      const e = ref && getElement(map, ref);
      return ref && e ? { ref, at: elementCenter(e) } : null;
    }
    case "zoneUnreachable": {
      const index = map.zones.findIndex((z) => z.label === issue.zone);
      return index >= 0 ? { ref: { list: "zones", index }, at: [map.zones[index].x, map.zones[index].z] } : null;
    }
    case "spawnBlocked":
    case "spawnHazard":
    case "spawnOutside":
      return spawn(issue.team);
    case "spawnClose": {
      const s = spawnsOf(map);
      return { ref: null, at: [(s.blue.x + s.red.x) / 2, (s.blue.z + s.red.z) / 2] };
    }
    default:
      return null;
  }
}
