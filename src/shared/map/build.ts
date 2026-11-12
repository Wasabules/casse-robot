import { box } from "../arena/builders";
import { VALLEY_GROUND, type GroundStyle, type LavaShape } from "../arena/features";
import {
  ARENAS, GROUND_HALF, type ArenaBounds, type ArenaLayout, type ArenaPlace, type CaptureZone, type MapKey, type SpawnLine, type StaticBox,
} from "../arena/layout";
import { terrainHeight, type Terrain } from "../arena/terrain";
import { PropList } from "../arena/valley";
import { CAR_HALF, propDef, propHalf } from "../catalog/props";
import { axisAngle, NO_ROTATION, qmul, vec3, type Quat, type Vec3 } from "../math/vec";
import { decodeTerrain } from "./codec";
import { MAP_LIMITS, type MapFile, type MapGround, type MapQuat, type MapSpawn, type MapTurn } from "./format";
import { mapKey } from "./key";
import { expandPrefab, lowestUnder, spawnGuard, type Site } from "./prefabs";

/*
 * Une carte communautaire devient une arène (`ArenaLayout`) : son relief décodé, ses boîtes et ses
 * accessoires posés sur le sol (quand l'auteur n'a pas donné leur hauteur), ses préfabriqués
 * dépliés, ses limites ajoutées, et ce qui manque complété par des valeurs par défaut. Ensuite, rien
 * ne la distingue d'une arène du jeu : la simulation, la grille de passage de l'IA (calculée à la
 * première demande), le rendu, la mini-carte et le réseau la lisent de la même façon.
 */

const DEG = Math.PI / 180;

/** Le ciel par défaut : celui de la Vallée. */
const DEFAULT_SKY = { color: "#bfd0db", fog: 0.0045 } as const;
/** Grille de passage par défaut : cases de 2,5 m, pentes jusqu'à 26° (entre l'Île, 22°, et le Port, 26°). */
const DEFAULT_NAV_CELL = 2.5;
const DEFAULT_MAX_SLOPE = 26;
/** La limite invisible, par défaut à cette distance au-delà de la zone de jeu (m) ; sa hauteur au moins (m). */
const BOUND_MARGIN = 35;
const BOUND_TOP = 110;
/** Murs d'enceinte : par tronçons (m), de cette hauteur au-dessus du sol (m). */
const WALL_RUN = 8;
const WALL_HEIGHT = 1.2;
/** Un accessoire mobile est posé un peu au-dessus du sol : il s'y pose de lui-même. */
const DROP = 0.03;

/**
 * Rotation d'après un lacet, un tangage et un roulis (degrés), dans cet ordre ; avec un quaternion
 * (`quat`), celui-ci tourné ensuite d'autant. Sans angle non nul : le quaternion, ou `NO_ROTATION`
 * (l'objet même : un accessoire qui le reçoit n'a pas d'orientation).
 */
export function turnQuat(t: MapTurn): Readonly<Quat> {
  const base = t.quat ? quatOf(t.quat) : null;
  if (!t.yaw && !t.pitch && !t.roll) return base ?? NO_ROTATION;
  // Chaque angle donné (même nul), composé avec les précédents ; un seul : tel que `axisAngle` le
  // donne. La même rotation, quel que soit l'écrit ; au bit près (au signe de ses zéros près), celle
  // que le code des arènes compose de même (un pignon : `yaw(0)·pitch` ; une rampe : `pitch` seul)
  let q: Quat | null = null;
  for (const [axis, deg] of [[UP, t.yaw], [ACROSS, t.pitch], [ALONG, t.roll]] as const) {
    if (deg === undefined) continue;
    const r = axisAngle(axis, deg * DEG);
    q = q ? qmul(q, r) : r;
  }
  if (!q) return base ?? NO_ROTATION;
  return base ? qmul(q, base) : q;
}

/** Les axes du lacet, du tangage et du roulis. */
const UP: Vec3 = vec3(0, 1, 0);
const ACROSS: Vec3 = vec3(1, 0, 0);
const ALONG: Vec3 = vec3(0, 0, 1);

/** Un quaternion de carte, tel quel s'il est unitaire (au bit près : celui de l'export), sinon normalisé. */
function quatOf([x, y, z, w]: MapQuat): Quat {
  const n2 = x * x + y * y + z * z + w * w;
  if (Math.abs(n2 - 1) < 1e-12) return { x, y, z, w };
  const n = Math.sqrt(n2);
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

/** La palette du sol : celle d'une arène du jeu (la Vallée par défaut), et ce que la carte en change. */
export function groundStyle(g: MapGround | undefined): GroundStyle {
  if (!g) return VALLEY_GROUND;
  const { preset, ...changes } = g;
  const base = (preset && ARENAS[preset].ground) || VALLEY_GROUND;
  const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
  return { ...base, ...set } as GroundStyle;
}

/** Une ligne de départ libre, dans les unités du jeu (radians, demi-longueur). */
const spawnLine = (s: MapSpawn): SpawnLine => ({ x: s.x, z: s.z, facing: s.facing * DEG, spread: s.width / 2 });

/** Les dimensions de jeu, complétées (voir `MapBounds`), avec les lignes de départ libres s'il y en a. */
export function mapBounds(map: MapFile, airFloor: number): ArenaBounds {
  const b = map.bounds;
  const half = b.half;
  const bounds: ArenaBounds = {
    half,
    roam: b.roam ?? Math.round(half * 0.86),
    spawnLine: b.spawnLine ?? Math.round(half * 0.8),
    spawnSpread: b.spawnSpread ?? Math.min(30, Math.round(half * 0.3)),
    circuit: b.circuit ?? Math.round(half * 0.7),
    airFloor: b.airFloor ?? airFloor,
    hoverFloor: b.hoverFloor,
  };
  return map.spawns ? { ...bounds, spawns: { blue: spawnLine(map.spawns.blue), red: spawnLine(map.spawns.red) } } : bounds;
}

/** Où est la limite invisible (m du centre), ou null s'il n'y en a pas. */
export function boundAt(map: MapFile): number | null {
  const bound = map.limits?.bound;
  if (bound === 0) return null;
  const side = map.terrain ? map.terrain.cells * map.terrain.step : 2 * GROUND_HALF;
  return bound ?? Math.min(map.bounds.half + BOUND_MARGIN, side / 2 - 1);
}

/** L'élément de la carte d'où vient une boîte ou un accessoire de l'arène : sa liste et son rang. */
export interface ElementOrigin {
  readonly list: "boxes" | "props" | "prefabs";
  readonly index: number;
}

/**
 * D'où vient chaque boîte et chaque accessoire de l'arène (l'éditeur de cartes : un clic sur un pan
 * de mur choisit sa maison) ; null : ajouté par la carte elle-même (murs d'enceinte, limite invisible).
 */
export interface ArenaOrigins {
  readonly boxes: (ElementOrigin | null)[];
  readonly props: (ElementOrigin | null)[];
}

/**
 * La carte, en arène. `key` : son identifiant (celui de son contenu par défaut). Une carte dont le
 * relief est illisible (ce que `readMap` refuse) est construite à plat. Les préfabriqués s'arrêtent
 * de se déplier au-delà du nombre d'accessoires permis : `validateMap` le signale. `origins`, s'il est
 * donné, reçoit d'où vient chaque boîte et chaque accessoire.
 */
export function arenaFromMap(map: MapFile, key: MapKey = mapKey(map), origins?: ArenaOrigins): ArenaLayout {
  const terrain: Terrain | undefined = (map.terrain && decodeTerrain(map.terrain)) || undefined;
  const ground = (x: number, z: number): number => (terrain ? Math.max(0, terrainHeight(terrain, x, z)) : 0);
  const side = terrain ? terrain.size : 2 * GROUND_HALF;
  const half = map.bounds.half;
  const spawn = mapBounds(map, 0);

  // Les boîtes de la carte
  const boxes: StaticBox[] = (map.boxes ?? []).map((b) => {
    const rot = turnQuat(b);
    const h = vec3(b.size[0] / 2, b.size[1] / 2, b.size[2] / 2);
    let y = b.y;
    if (y === undefined) {
      if (b.kind === "rock") y = ground(b.x, b.z) + h.y * 0.55;
      // Une piste, une voie : au ras du sol
      else if (b.kind === "road" || b.kind === "track") y = ground(b.x, b.z) + 0.04 - h.y;
      else y = lowestUnder({ ground }, b.x, b.z, h.x, h.z, b.yaw ?? 0) + h.y;
    }
    const out: StaticBox = { kind: b.kind, pos: vec3(b.x, y, b.z), half: h, rot };
    return { ...out, ...(b.look ? { look: b.look } : {}), ...(b.round ? { round: true } : {}), ...(b.underpass ? { underpass: true } : {}), ...(b.approach !== undefined ? { approach: b.approach } : {}) };
  });

  // Les accessoires de la carte, à leurs rangs (ce sur quoi ils reposent les désigne ainsi), puis les préfabriqués
  const P = new PropList();
  const groups = new Map<number, number>();
  for (const p of map.props ?? []) {
    if (p.group !== undefined && !groups.has(p.group)) groups.set(p.group, P.newBuilding());
  }
  for (const p of map.props ?? []) {
    const def = propDef(p.type);
    const slab = def.shape.kind === "slab";
    const size = p.size ? vec3(p.size[0] / 2, p.size[1] / 2, p.size[2] / 2) : p.type === "car" || p.type === "wreck" ? CAR_HALF : undefined;
    const h = propHalf(p.type, { half: slab ? size : undefined, scale: p.scale });
    const base = p.y ?? (def.anchored
      ? def.shape.kind === "cylinder" ? ground(p.x, p.z) : lowestUnder({ ground }, p.x, p.z, h.x, h.z, p.yaw ?? 0)
      : ground(p.x, p.z) + DROP);
    const rot = turnQuat(p);
    P.add({
      type: p.type,
      // (`centered` : `y` est la hauteur de son centre)
      pos: vec3(p.x, p.centered && p.y !== undefined ? p.y : base + h.y, p.z),
      ...(rot !== NO_ROTATION ? { rot } : {}),
      ...(slab ? { half: h } : {}),
      ...(p.scale !== undefined && !slab ? { scale: p.scale } : {}),
      ...(p.rests?.length ? { rests: [...p.rests] } : {}),
      ...(p.group !== undefined ? { building: groups.get(p.group) } : {}),
      ...(p.diamond ? { diamond: true } : {}),
    });
  }
  const site: Site = {
    ground, half, reach: Math.min(MAP_LIMITS.reach, side / 2 - 2),
    onSpawnLine: spawnGuard(spawn),
    zones: map.zones, paths: map.paths ?? [], water: map.water?.level, lava: map.lava as readonly LavaShape[] | undefined,
    boxes, props: P,
  };
  if (origins) {
    origins.boxes.length = 0;
    origins.props.length = 0;
    boxes.forEach((_, index) => origins.boxes.push({ list: "boxes", index }));
    P.spots.forEach((_, index) => origins.props.push({ list: "props", index }));
  }
  (map.prefabs ?? []).every((prefab, index) => {
    if (P.spots.length > MAP_LIMITS.props || boxes.length > MAP_LIMITS.boxes) return false;
    expandPrefab(site, prefab);
    if (origins) {
      while (origins.boxes.length < boxes.length) origins.boxes.push({ list: "prefabs", index });
      while (origins.props.length < P.spots.length) origins.props.push({ list: "prefabs", index });
    }
    return true;
  });

  // Le plus haut du décor au-dessus du sol : l'altitude plancher des avions de l'IA, par défaut
  let tallest = 0;
  for (const b of boxes) tallest = Math.max(tallest, b.pos.y + b.half.y - ground(b.pos.x, b.pos.z));
  for (const s of P.spots) if (propDef(s.type).anchored) tallest = Math.max(tallest, s.pos.y + propHalf(s.type, s).y - ground(s.pos.x, s.pos.z));
  const airFloor = Math.min(40, Math.max(0, Math.ceil(tallest + 4)));

  // Les limites : des murs d'enceinte, une limite invisible au-delà
  let peak = 0;
  if (terrain) for (const h of terrain.heights) peak = Math.max(peak, h);
  if (map.limits?.walls) boxes.push(...enclosureOn(ground, half));
  // (les limites n'ont pas d'élément d'origine : `origins` s'arrête aux préfabriqués)
  const at = boundAt(map);
  if (at !== null) {
    const top = Math.max(BOUND_TOP, peak + 80);
    const t = 2;
    for (const s of [-1, 1]) {
      boxes.push(box("bound", 0, top / 2, s * (at + t), at + 2 * t, top / 2, t));
      boxes.push(box("bound", s * (at + t), top / 2, 0, t, top / 2, at + 2 * t));
    }
  }

  const zones: CaptureZone[] = [...map.zones]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((z) => ({ label: z.label, pos: vec3(z.x, z.y ?? ground(z.x, z.z), z.z), radius: z.radius }));
  const places: ArenaPlace[] = (map.places ?? []).map((p) => {
    if (p.place) return { place: p.place, x: p.x, z: p.z };
    const name = p.name ?? "";
    return p.names ? { name, names: p.names, x: p.x, z: p.z } : { name, x: p.x, z: p.z };
  });
  const water = map.water;
  // La grille de passage, par défaut là où le relief, l'eau profonde ou la lave coupent les routes ; pas
  // avec un réseau de passage (l'un ou l'autre), sauf si la carte la demande
  const wantsNav = map.nav !== false && (map.nav !== undefined || (!map.navGraph && (!!terrain || !!map.lava?.length || water?.deep !== undefined)));
  const nav = map.nav || {};

  const arena: ArenaLayout = {
    id: key,
    community: map.meta,
    ambience: map.ambience ?? "valley",
    bounds: mapBounds(map, airFloor),
    boxes,
    props: P.spots,
    zones,
    terrain,
    water: water?.level,
    deepWater: water?.deep,
    waterColor: water?.color,
    paths: map.paths?.map((p) => ({ width: p.width, points: p.points, surface: p.surface })),
    urban: map.urban,
    sky: map.sky ?? DEFAULT_SKY,
    places: places.length ? places : undefined,
    lava: map.lava as readonly LavaShape[] | undefined,
    navGrid: wantsNav ? { cell: nav.cell ?? DEFAULT_NAV_CELL, maxSlope: (nav.maxSlope ?? DEFAULT_MAX_SLOPE) * DEG } : undefined,
    nav: map.navGraph ? { points: map.navGraph.points, links: map.navGraph.links } : undefined,
    ground: groundStyle(map.ground),
    vents: map.vents?.map((v) => ({ x: v.x, y: v.y ?? ground(v.x, v.z), z: v.z, size: v.size, steam: v.steam })),
    falls: map.falls?.map((f) => ({ x: f.x, z: f.z, top: f.top, bottom: f.bottom, width: f.width, dir: f.dir * DEG })),
  };
  // Sans les champs indéfinis : une arène du jeu ne les a pas non plus
  const fields = arena as unknown as Record<string, unknown>;
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  return arena;
}

/** Tronçons de mur par côté d'une enceinte à ±`half` m. */
const wallRuns = (half: number): number => Math.max(1, Math.ceil((2 * half) / WALL_RUN));
/** Boîtes qu'ajoutent les murs d'enceinte (elles ne comptent pas dans les boîtes de la carte). */
export const wallCount = (half: number): number => 4 * wallRuns(half);

/** Murs d'enceinte à ±`half` m, par tronçons qui suivent le relief (du sol jusqu'à WALL_HEIGHT au-dessus du plus haut). */
function enclosureOn(ground: (x: number, z: number) => number, half: number): StaticBox[] {
  const walls: StaticBox[] = [];
  const n = wallRuns(half);
  const run = (2 * half) / n;
  for (const s of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const u = -half + run * (i + 0.5);
      for (const along of ["x", "z"] as const) {
        const x = along === "x" ? u : s * half;
        const z = along === "x" ? s * half : u;
        const samples = [-0.5, -0.25, 0, 0.25, 0.5].map((t) => (along === "x" ? ground(x + t * run, z) : ground(x, z + t * run)));
        const low = Math.min(...samples) - 1;
        const top = Math.max(...samples) + WALL_HEIGHT;
        const hl = run / 2 + 0.5;
        walls.push(along === "x" ? box("wall", x, (low + top) / 2, z, hl, (top - low) / 2, 0.5) : box("wall", x, (low + top) / 2, z, 0.5, (top - low) / 2, hl));
      }
    }
  }
  return walls;
}
