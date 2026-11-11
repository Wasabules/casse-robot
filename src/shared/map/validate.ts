import { lavaAt } from "../arena/features";
import { deepWaterAt, GROUND_HALF, groundLevel, spawnLineOf, spawnLocal, spawnPoint, type ArenaLayout, type MapKey, type StaticBox } from "../arena/layout";
import { isOpen, navGrid } from "../arena/navgrid";
import { propDef, propHalf } from "../catalog/props";
import { qrot, vec3 } from "../math/vec";
import { arenaFromMap, boundAt, mapBounds, wallCount } from "./build";
import { MAP_LIMITS, type MapFile, type MapIssue, type MapTeam } from "./format";
import { mapKey } from "./key";
import { isDynamicProp } from "./prefabs";
import { readMap, readMapText } from "./read";

/*
 * Validation d'une carte, la même dans le navigateur et sur le serveur : sa forme et ses bornes
 * (`readMap`), puis ce que seule l'arène construite dit : le nombre de ce que déplient les
 * préfabriqués, le relief qui couvre la zone de jeu, des lignes de départ dégagées sur du terrain
 * franchissable et sans danger, des zones que l'IA atteint. Une carte sans problème se joue.
 */

/** Au plus autant de problèmes signalés. */
const MAX_ISSUES = 24;
/** Part des places d'une ligne de départ qui doivent être libres. */
const SPAWN_FREE = 0.5;
/** Écart entre deux places essayées d'une ligne de départ (m), et le dégagement autour de chacune (m). */
const SPAWN_STEP = 2;
const SPAWN_ROOM = 1.5;
/** Ce qui est dangereux à moins de cette distance de la ligne de départ (m) : un baril, une citerne, la lave. */
const SPAWN_DANGER = 8;
/** Pente au-delà de laquelle une place de départ ne va pas, sur une carte sans grille de passage (rad). */
const SPAWN_SLOPE = 0.55;
/**
 * Lignes de départ libres : au moins cette distance entre elles (m, d'une place à l'autre ; les
 * petites arènes en ont 58, une carte de ±20 m une trentaine), et à cette marge du bord de la zone de
 * jeu (m, comme `spawnLine`).
 */
export const SPAWN_APART = 24;
const SPAWN_EDGE = 2;

/** Ce que donne la vérification d'une carte : la carte lue, son arène et son identifiant (si elle est lisible), et ses problèmes. */
export interface MapCheck {
  readonly map: MapFile | null;
  readonly arena: ArenaLayout | null;
  readonly key: MapKey | null;
  readonly issues: readonly MapIssue[];
}

/**
 * Vérifie une carte (n'importe quelle entrée : un fichier lu, un message reçu, la carte d'un
 * éditeur) : `issues` vide, elle se joue. L'arène rendue est celle à jouer (sa grille de passage est
 * déjà calculée).
 */
export function checkMap(input: unknown): MapCheck {
  const read = readMap(input);
  if (!read.ok) return { map: null, arena: null, key: null, issues: read.issues };
  try {
    const key = mapKey(read.map);
    const arena = arenaFromMap(read.map, key);
    return { map: read.map, arena, key, issues: validateArena(read.map, arena) };
  } catch {
    // Rien ne devrait lever ici : une carte qui y parviendrait est refusée, sans faire tomber le serveur
    return { map: read.map, arena: null, key: null, issues: [{ code: "json" }] };
  }
}

/** Les problèmes d'une carte (vide : elle se joue). */
export const validateMap = (input: unknown): readonly MapIssue[] => checkMap(input).issues;

/** Vérifie une carte d'après le texte de son fichier (taille bornée, JSON, puis `checkMap`). */
export function checkMapText(text: string): MapCheck {
  const read = readMapText(text);
  return read.ok ? checkMap(read.map) : { map: null, arena: null, key: null, issues: read.issues };
}

/** Demi-emprise au sol (x, z) d'une boîte orientée. */
function footprint(b: StaticBox): { x: number; z: number } {
  const ax = qrot(b.rot, vec3(b.half.x, 0, 0));
  const ay = qrot(b.rot, vec3(0, b.half.y, 0));
  const az = qrot(b.rot, vec3(0, 0, b.half.z));
  return { x: Math.abs(ax.x) + Math.abs(ay.x) + Math.abs(az.x), z: Math.abs(ax.z) + Math.abs(ay.z) + Math.abs(az.z) };
}

/** Ce qu'on ne traverse pas au sol (pas une piste, un pont, une voie, une limite). */
const solid = (b: StaticBox): boolean => b.kind !== "road" && b.kind !== "deck" && b.kind !== "track" && b.kind !== "bound" && b.kind !== "ramp";

/** Ce que seule l'arène construite permet de vérifier (voir plus haut). */
export function validateArena(map: MapFile, arena: ArenaLayout): MapIssue[] {
  const issues: MapIssue[] = [];
  const fail = (issue: MapIssue): void => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };
  const L = MAP_LIMITS;
  const bounds = mapBounds(map, 0);
  const half = bounds.half;

  // Ce que déplient les préfabriqués compte avec le reste
  const boxCount = arena.boxes.filter((b) => b.kind !== "bound").length - (map.limits?.walls ? wallCount(half) : 0);
  if (boxCount > L.boxes) fail({ code: "tooMany", what: "boxes", count: boxCount, max: L.boxes });
  if (arena.props.length > L.props) fail({ code: "tooMany", what: "props", count: arena.props.length, max: L.props });
  const dynamic = arena.props.filter((p) => isDynamicProp(p.type)).length;
  if (dynamic > L.dynamicProps) fail({ code: "tooMany", what: "dynamicProps", count: dynamic, max: L.dynamicProps });
  // Une dalle (pan de mur, toit) a ses dimensions ; une voiture a les siennes par défaut
  (map.props ?? []).forEach((p, i) => {
    if (propDef(p.type).shape.kind === "slab" && !p.size && p.type !== "car" && p.type !== "wreck") fail({ code: "field", path: `props[${i}].size` });
  });

  // Le relief couvre la zone de jeu et la limite invisible
  const side = map.terrain ? map.terrain.cells * map.terrain.step : 2 * GROUND_HALF;
  const bound = boundAt(map);
  const need = Math.max(half + 2, bound ?? 0);
  if (map.terrain && side / 2 < need) fail({ code: "terrainSmall", side, need: Math.ceil(2 * need) });
  if (bound !== null && bound < half + 2) fail({ code: "bounds", path: "limits.bound" });

  // Dimensions de jeu cohérentes
  if (bounds.roam > half) fail({ code: "bounds", path: "bounds.roam" });
  // (des lignes de départ libres remplacent celles du nord et du sud : elles se vérifient plus bas)
  if (!map.spawns && (bounds.spawnLine < 10 || bounds.spawnLine > half - 2)) fail({ code: "bounds", path: "bounds.spawnLine" });
  if (!map.spawns && bounds.spawnSpread > half - 2) fail({ code: "bounds", path: "bounds.spawnSpread" });
  if (bounds.circuit > half + 30) fail({ code: "bounds", path: "bounds.circuit" });

  // Rien hors de la carte
  const edge = side / 2;
  const inside = (x: number, z: number, margin = 0): boolean => Math.abs(x) <= edge - margin && Math.abs(z) <= edge - margin;
  (map.boxes ?? []).forEach((b, i) => !inside(b.x, b.z) && fail({ code: "outside", path: `boxes[${i}]` }));
  (map.props ?? []).forEach((p, i) => !inside(p.x, p.z) && fail({ code: "outside", path: `props[${i}]` }));
  (map.prefabs ?? []).forEach((p, i) => {
    const points: readonly (readonly [number, number])[] = "points" in p ? p.points : p.kind === "bridge" ? [p.from, p.to] : [[p.x, p.z]];
    if (points.some(([x, z]) => !inside(x, z))) fail({ code: "outside", path: `prefabs[${i}]` });
  });
  (map.places ?? []).forEach((p, i) => !inside(p.x, p.z) && fail({ code: "outside", path: `places[${i}]` }));
  (map.vents ?? []).forEach((v, i) => !inside(v.x, v.z) && fail({ code: "outside", path: `vents[${i}]` }));

  // Les zones : une à cinq, des lettres différentes, dans la zone de jeu, que l'IA atteint
  const labels = new Set(map.zones.map((z) => z.label));
  if (!map.zones.length || labels.size !== map.zones.length) fail({ code: "zones" });
  map.zones.forEach((z, i) => {
    if (Math.abs(z.x) > half || Math.abs(z.z) > half) fail({ code: "outside", path: `zones[${i}]` });
  });
  const grid = navGrid(arena);
  for (const zone of arena.zones) {
    const { x, z } = zone.pos;
    const reachable = grid
      ? ring(x, z, zone.radius).some(([px, pz]) => isOpen(grid, px, pz))
      // Sans grille : il suffit qu'elle ne soit pas enfermée dans une boîte du décor
      : !arena.boxes.some((b) => solid(b) && b.pos.y + b.half.y > zone.pos.y + 0.5 && b.pos.y - b.half.y < zone.pos.y + 1
        && Math.abs(x - b.pos.x) < footprint(b).x && Math.abs(z - b.pos.z) < footprint(b).z);
    if (!reachable) fail({ code: "zoneUnreachable", zone: zone.label });
  }

  // Les lignes de départ : dégagées, franchissables, sans danger tout près
  const blockers = arena.boxes.filter(solid).map((b) => ({ b, f: footprint(b) }));
  const dangers = arena.props.filter((p) => propDef(p.type).explosion);
  const lineSpots: Record<MapTeam, [number, number][]> = { red: [], blue: [] };
  for (const team of ["red", "blue"] as const satisfies readonly MapTeam[]) {
    const { spread } = spawnLineOf(bounds, team);
    const spots = lineSpots[team];
    for (let a = -spread; a <= spread + 1e-6; a += SPAWN_STEP) {
      const p = spawnPoint(bounds, team, a);
      spots.push([p.x, p.z]);
    }
    if (map.spawns && spots.some(([x, z]) => Math.abs(x) > half - SPAWN_EDGE || Math.abs(z) > half - SPAWN_EDGE)) fail({ code: "spawnOutside", team });
    const free = spots.filter(([x, z]) => {
      if (grid ? !isOpen(grid, x, z) : steep(arena, x, z)) return false;
      if (deepWaterAt(arena, x, z) || lavaAt(arena.lava, x, z, 2) > -2) return false;
      if (blockers.some(({ b, f }) => Math.abs(x - b.pos.x) < f.x + SPAWN_ROOM && Math.abs(z - b.pos.z) < f.z + SPAWN_ROOM)) return false;
      return !arena.props.some((p) => {
        const h = propHalf(p.type, p);
        const r = p.rot ? Math.hypot(h.x, h.z) : Math.max(h.x, h.z);
        return Math.hypot(x - p.pos.x, z - p.pos.z) < r + SPAWN_ROOM;
      });
    });
    if (free.length < Math.max(1, spots.length * SPAWN_FREE)) fail({ code: "spawnBlocked", team });
    const near = (x: number, z: number): boolean => {
      const { along, across } = spawnLocal(bounds, team, x, z);
      return Math.abs(along) <= spread + SPAWN_DANGER && Math.abs(across) <= SPAWN_DANGER;
    };
    const lava = spots.some(([x, z]) => lavaAt(arena.lava, x, z, SPAWN_DANGER) > -SPAWN_DANGER);
    if (lava || dangers.some((p) => near(p.pos.x, p.pos.z))) fail({ code: "spawnHazard", team });
  }
  // Deux lignes libres : assez loin l'une de l'autre (les équipes ne partent pas au contact)
  if (map.spawns) {
    let closest = Infinity;
    for (const [bx, bz] of lineSpots.blue) for (const [rx, rz] of lineSpots.red) closest = Math.min(closest, Math.hypot(bx - rx, bz - rz));
    if (closest < SPAWN_APART) fail({ code: "spawnClose", distance: Math.floor(closest), min: SPAWN_APART });
  }
  return issues;
}

/** Le centre d'un disque et des points de son bord et de sa moitié. */
function ring(x: number, z: number, r: number): [number, number][] {
  const out: [number, number][] = [[x, z]];
  for (const k of [0.5, 1]) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      out.push([x + Math.cos(a) * r * k, z + Math.sin(a) * r * k]);
    }
  }
  return out;
}

/** Trop raide pour y poser un robot (carte sans grille de passage). */
function steep(arena: ArenaLayout, x: number, z: number): boolean {
  const d = 0.8;
  const sx = (groundLevel(arena, x + d, z) - groundLevel(arena, x - d, z)) / (2 * d);
  const sz = (groundLevel(arena, x, z + d) - groundLevel(arena, x, z - d)) / (2 * d);
  return Math.hypot(sx, sz) > Math.tan(SPAWN_SLOPE);
}
