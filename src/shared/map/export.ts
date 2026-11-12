import { isArenaId, PLAIN_SKY, type ArenaLayout, type PropSpot, type StaticBox } from "../arena/layout";
import { propDef, propHalf } from "../catalog/props";
import { clamp } from "../math/scalar";
import { vec3, type Quat } from "../math/vec";
import { turnQuat } from "./build";
import { encodeTerrain } from "./codec";
import { readMap } from "./read";
import {
  MAP_FORMAT, type MapBox, type MapFile, type MapMeta, type MapPlace, type MapProp, type MapQuat, type MapSpawn, type MapTurn,
} from "./format";

/*
 * Une arène en carte (`MapFile`) : l'inverse de `arenaFromMap` (build.ts). Les arènes du jeu
 * (`ARENAS`) sont faites par du code ; exportées, elles se lisent, se vérifient et se rejouent comme
 * une carte communautaire. L'aller-retour est exact : la carte, relue et reconstruite, redonne au bit
 * près les mêmes boîtes, accessoires, zones, chemins, bornes… (le relief, à la précision de son
 * encodage sur 16 bits). Pour cela, tout est écrit explicitement (la hauteur de chaque élément, les
 * murs d'enceinte et les limites invisibles en boîtes, `limits.bound: 0`), et chaque nombre que la
 * construction recalcule (un angle en degrés, la base d'un accessoire) est choisi pour redonner
 * exactement celui de l'arène ; une orientation que des degrés ne redonnent pas au bit près (une
 * rotation composée par le code) s'écrit en quaternion (`quat`).
 */

const DEG = Math.PI / 180;

/** Ce que dit d'une arène du jeu sa carte, faute de mieux : son identifiant, le jeu, sa licence (l'outil des cartes donne ses noms traduits : tools/maps/arenas.ts). */
const GAME_META = { author: "Casse-Robot", license: "AGPL-3.0-or-later" } as const;

// Les nombres flottants voisins : un nombre et le suivant, vers +∞ ou vers -∞
const F64 = new Float64Array(1);
const I64 = new BigInt64Array(F64.buffer);
function nextAfter(x: number, up: boolean): number {
  if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  F64[0] = x;
  I64[0] += (x > 0) === up ? 1n : -1n;
  return F64[0];
}

/**
 * Des valeurs proches de `guess`, des plus lisibles aux plus précises : arrondies à 0, 1, … 12
 * décimales, puis `guess` et ses voisins flottants (`spread` de chaque côté).
 */
function candidates(guess: number, spread = 8): number[] {
  const out = new Set<number>();
  // (10ᵏ par multiplications : exactes jusqu'à 10²², sans dépendre du `**` du moteur)
  for (let k = 0, p = 1; k <= 12; k++, p *= 10) out.add(Math.round(guess * p) / p);
  out.add(guess);
  let up = guess;
  let down = guess;
  for (let i = 0; i < spread; i++) {
    up = nextAfter(up, true);
    down = nextAfter(down, false);
    out.add(up).add(down);
  }
  return [...out];
}

/** La valeur la plus lisible proche de `guess` qui satisfait `ok` ; à défaut, `guess`. */
function solve(guess: number, ok: (v: number) => boolean): number {
  return candidates(guess).find(ok) ?? guess;
}

/** Des degrés qui redonnent exactement cet angle (rad) une fois relus (`degrés × π/180`, comme map/build.ts). */
export function exactDegrees(rad: number): number {
  if (rad === 0) return 0;
  return solve(rad / DEG, (d) => Math.abs(d) < 360 && d * DEG === rad);
}

/** Deux quaternions égaux au bit près, signe des zéros compris. */
const sameQuat = (a: Readonly<Quat>, b: Readonly<Quat>): boolean => Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.z, b.z) && Object.is(a.w, b.w);
/** L'orientation droite, celle que reçoit une boîte de la carte sans angle (`NO_ROTATION`, ses zéros positifs). */
const isIdentity = (q: Readonly<Quat>): boolean => sameQuat(q, { x: 0, y: 0, z: 0, w: 1 });

/** Lacet, tangage, roulis (rad) d'une rotation q = Y(lacet)·X(tangage)·Z(roulis), l'ordre de `turnQuat`. */
function anglesOf(q: Readonly<Quat>): [number, number, number] {
  const { x, y, z, w } = q;
  const r02 = 2 * (x * z + w * y);
  const r12 = 2 * (y * z - w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  return [Math.atan2(r02, r22), Math.asin(clamp(-r12, -1, 1)), Math.atan2(r10, r11)];
}

/** Une orientation en degrés : chaque angle donné (même nul : `turnQuat` le compose), ou absent. */
const turnOf = (yaw: number | undefined, pitch: number | undefined, roll: number | undefined): MapTurn => ({
  ...(yaw !== undefined ? { yaw } : {}), ...(pitch !== undefined ? { pitch } : {}), ...(roll !== undefined ? { roll } : {}),
});

/**
 * Un lacet, un tangage et un roulis (degrés) dont `turnQuat` redonne exactement ce quaternion, au
 * bit près, signe des zéros compris ; null s'il n'y en a pas (une rotation composée autrement, un
 * angle que des degrés ne redonnent pas).
 */
export function exactTurn(q: Readonly<Quat>): MapTurn | null {
  const angles = anglesOf(q).map((a) => (Math.abs(a) < 1e-12 ? 0 : a / DEG));
  // Le quaternion et son opposé sont la même rotation : un tour de plus sur un angle passe de l'un à l'autre
  const near = turnQuat(turnOf(angles[0] || undefined, angles[1] || undefined, angles[2] || undefined));
  if (near.x * q.x + near.y * q.y + near.z * q.z + near.w * q.w < 0) {
    const k = angles.findIndex((a) => a !== 0);
    if (k < 0) return null;
    angles[k] += angles[k] > 0 ? -360 : 360;
  }
  // Un angle nul : absent, ou donné (un lacet nul composé avec un tangage, comme le code des maisons)
  const lists: (number | undefined)[][] = angles.map((a) => (a === 0 ? [undefined, 0] : candidates(a).filter((d) => Math.abs(d) < 360)));
  for (const yaw of lists[0]) {
    for (const pitch of lists[1]) {
      for (const roll of lists[2]) {
        const t = turnOf(yaw, pitch, roll);
        if (sameQuat(turnQuat(t), q)) return t;
      }
    }
  }
  return null;
}

/**
 * L'orientation d'un élément en carte : en degrés s'ils la redonnent exactement, sinon en quaternion.
 * `kept` : une orientation droite reste écrite (un accessoire qui en a une, même droite, n'est pas
 * traité comme un accessoire qui n'en a pas : voir sim/wave.ts).
 */
function turnFields(rot: Readonly<Quat> | undefined, kept: boolean): MapTurn {
  if (!rot) return {};
  if (isIdentity(rot)) return kept ? { quat: [0, 0, 0, 1] } : {};
  return exactTurn(rot) ?? { quat: [rot.x, rot.y, rot.z, rot.w] satisfies MapQuat };
}

/** Une boîte du décor en carte : sa hauteur, toujours écrite (pas de pose sur le sol à refaire). */
function boxOf(b: StaticBox): MapBox {
  return {
    kind: b.kind,
    x: b.pos.x,
    z: b.pos.z,
    y: b.pos.y,
    size: [2 * b.half.x, 2 * b.half.y, 2 * b.half.z],
    ...turnFields(b.rot, false),
    ...(b.look ? { look: b.look } : {}),
    ...(b.round ? { round: true } : {}),
    ...(b.underpass ? { underpass: true } : {}),
    ...(b.approach !== undefined ? { approach: b.approach } : {}),
  };
}

/** Un accessoire en carte : sa base, choisie pour que la construction (base + demi-hauteur) redonne exactement son centre. */
function propOf(s: PropSpot): MapProp {
  const def = propDef(s.type);
  const slab = def.shape.kind === "slab";
  // Une dalle a toujours ses dimensions, celles que le jeu lui donne (une voiture aussi : sans elles,
  // la construction lui donnerait `CAR_HALF`)
  const half = slab ? propHalf(s.type, s) : undefined;
  const scale = !slab ? s.scale : undefined;
  // La demi-hauteur que prendra la construction (map/build.ts) ; une base qui la redonne exactement,
  // sinon le centre (base + demi-hauteur s'arrondit au pair : il arrive qu'aucune base n'y mène)
  const h = propHalf(s.type, { half: half && vec3(half.x, half.y, half.z), scale });
  const base = solve(s.pos.y - h.y, (y) => y + h.y === s.pos.y);
  const exact = base + h.y === s.pos.y;
  return {
    type: s.type,
    x: s.pos.x,
    z: s.pos.z,
    y: exact ? base : s.pos.y,
    ...turnFields(s.rot, true),
    ...(half ? { size: [2 * half.x, 2 * half.y, 2 * half.z] as const } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(s.rests?.length ? { rests: [...s.rests] } : {}),
    ...(s.building !== undefined ? { group: s.building } : {}),
    ...(s.diamond ? { diamond: true } : {}),
    ...(exact ? {} : { centered: true }),
  };
}

const spawnOf = (s: { x: number; z: number; facing: number; spread: number }): MapSpawn =>
  ({ x: s.x, z: s.z, facing: exactDegrees(s.facing), width: 2 * s.spread });

/** Un objet sans ses champs indéfinis (la carte n'écrit pas ce qu'elle n'a pas). */
function defined<T extends object>(o: T): T {
  const fields = o as Record<string, unknown>;
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  return o;
}

/**
 * L'arène en carte. `meta` : ce qu'en dit la carte (son nom, son auteur, sa licence) ; par défaut,
 * celle d'une carte communautaire, sinon l'identifiant de l'arène (l'outil des cartes donne les noms
 * traduits des arènes du jeu : tools/maps/arenas.ts). Ce que la construction mettrait par défaut et
 * que l'arène n'a pas est écrit : le ciel des petites arènes (`PLAIN_SKY`), leur ambiance (la leur),
 * pas de grille de passage (`nav: false`), pas de limite invisible ajoutée (`limits.bound: 0`).
 */
export function mapFromArena(arena: ArenaLayout, meta: MapMeta = arena.community ?? { name: arena.id, ...GAME_META }): MapFile {
  // La carte telle que la lecture la donne (l'ordre de ses champs : relue puis réécrite, elle redonne
  // le même texte) ; une carte que la lecture refuserait reste telle quelle (`checkMap` le dira)
  const map = rawMap(arena, meta);
  const read = readMap(map);
  return read.ok ? read.map : map;
}

function rawMap(arena: ArenaLayout, meta: MapMeta): MapFile {
  const b = arena.bounds;
  const t = arena.terrain;
  const ambience = arena.ambience ?? (isArenaId(arena.id) ? arena.id : undefined);
  // Sans grille de passage, mais avec ce qui en ferait une par défaut (map/build.ts) : on dit qu'il n'y en a pas
  const gridByDefault = !arena.nav && (!!t || !!arena.lava?.length || arena.deepWater !== undefined);
  const places: MapPlace[] | undefined = arena.places?.map((p) =>
    "place" in p ? { place: p.place, x: p.x, z: p.z } : defined({ name: p.name, names: p.names, x: p.x, z: p.z }));
  return defined({
    format: MAP_FORMAT,
    meta,
    bounds: defined({
      half: b.half, roam: b.roam, spawnLine: b.spawnLine, spawnSpread: b.spawnSpread, circuit: b.circuit,
      // (sans altitude plancher, l'arène n'en a pas : 0, plutôt que celle que la construction calculerait)
      airFloor: b.airFloor ?? 0, hoverFloor: b.hoverFloor,
    }),
    limits: { bound: 0 },
    sky: { ...(arena.sky ?? PLAIN_SKY) },
    ground: arena.ground ? { ...arena.ground } : undefined,
    ambience,
    water: arena.water !== undefined ? defined({ level: arena.water, deep: arena.deepWater, color: arena.waterColor }) : undefined,
    lava: arena.lava?.map((l) => (l.kind === "pool" ? { kind: "pool" as const, x: l.x, z: l.z, r: l.r } : { kind: "flow" as const, width: l.width, points: l.points.map(([x, z]) => [x, z] as const) })),
    vents: arena.vents?.map((v) => defined({ x: v.x, z: v.z, y: v.y, size: v.size, steam: v.steam || undefined })),
    falls: arena.falls?.map((f) => ({ x: f.x, z: f.z, top: f.top, bottom: f.bottom, width: f.width, dir: exactDegrees(f.dir) })),
    paths: arena.paths?.map((p) => defined({ width: p.width, points: p.points.map(([x, z]) => [x, z] as const), surface: p.surface })),
    urban: arena.urban || undefined,
    nav: arena.navGrid ? { cell: arena.navGrid.cell, maxSlope: exactDegrees(arena.navGrid.maxSlope) } : gridByDefault ? false : undefined,
    navGraph: arena.nav
      ? { points: arena.nav.points.map(([x, z]) => [x, z] as const), links: arena.nav.links.map(([i, j]) => [i, j] as const) }
      : undefined,
    zones: arena.zones.map((z) => ({ label: z.label, x: z.pos.x, z: z.pos.z, y: z.pos.y, radius: z.radius })),
    places: places?.length ? places : undefined,
    spawns: b.spawns ? { blue: spawnOf(b.spawns.blue), red: spawnOf(b.spawns.red) } : undefined,
    boxes: arena.boxes.length ? arena.boxes.map(boxOf) : undefined,
    props: arena.props.length ? arena.props.map(propOf) : undefined,
    terrain: t ? encodeTerrain(t.heights, t.cells, t.size / t.cells) : undefined,
  } satisfies MapFile);
}
