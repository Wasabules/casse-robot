import { qrot, vec3 } from "../math/vec";
import type { ArenaLayout, StaticBox } from "./layout";
import { terrainHeight, type Terrain } from "./terrain";

/*
 * Réseau de passage de l'IA au sol (voir `NavGraph`, layout.ts) : ce qui ne dépend que du relief,
 * sans physique. Une ligne droite est praticable si le sol n'y monte ni n'y descend nulle part plus
 * raide que MAX_GRADE (une falaise, la paroi d'un canyon ne le sont pas, un sentier l'est) ; les
 * points d'un réseau sont reliés quand la ligne qui les joint l'est (`linkNav`). Le décor (boîtes,
 * bâtiments) n'y compte pas : la navigation le contourne en chemin (ai/navigation.ts).
 */

/** Pente la plus raide qu'un robot au sol monte ou descend (dénivelé par mètre : ~32°). */
export const MAX_GRADE = 0.62;
/** Pas des échantillons le long d'une ligne (m). */
const SAMPLE = 1;
/** Liaisons de plus de cette longueur : on ne les cherche pas (m). */
export const LINK_REACH = 34;
/**
 * Marge de côté des liaisons du réseau (m) : la demi-largeur des plus larges robots au sol (leurs
 * roues ou leurs chenilles, au bord extérieur : 1,6 à 2,2 m). Un robot qui les suit garde ses roues
 * sur un sentier ; à 1 m, une liaison pouvait longer le bord d'un sentier, et un robot large qui la
 * suivait roulait d'une chenille sur le remblai.
 */
export const LINK_MARGIN = 2;

/** Dévers le plus fort qu'on suit en ligne droite (dénivelé par mètre en travers : ~22°) : au-delà, on longe un talus. */
export const MAX_CROSS = 0.4;

/** Hauteurs de la rangée précédente de `walkable` (une par ligne parallèle), gardées d'un appel à l'autre. */
let lanesBuffer = new Float64Array(8);

/**
 * La ligne droite de (ax, az) à (bx, bz) est praticable sur le relief. Avec une marge (`margin` m),
 * toute la bande de cette demi-largeur l'est (un robot a sa largeur : au bord d'un sentier, ses
 * roues de côté tomberaient) : des lignes parallèles de -margin à margin, à SAMPLE m au plus l'une
 * de l'autre, chacune praticable, et le sol ne penche nulle part trop en travers entre deux voisines
 * (elle ne longe pas un talus, ni l'arête d'un remblai, où un robot à cheval reste posé sur le
 * ventre). Deux lignes au bord seulement ne voyaient pas l'arête entre elles : un robot qui coupait
 * vers un sentier en roulant le long de son remblai s'y calait.
 */
export function walkable(t: Terrain, ax: number, az: number, bx: number, bz: number, margin = 0): boolean {
  const length = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(length / SAMPLE));
  const limit = MAX_GRADE * (length / n);
  // Lignes de chaque côté de la ligne droite (la gauche de (dx, dz) est (dz, -dx)), `gap` m l'une de l'autre
  const lanes = margin > 0 && length > 1e-6 ? Math.ceil(margin / SAMPLE) : 0;
  if (lanes === 0) {
    let last = terrainHeight(t, ax, az);
    for (let i = 1; i <= n; i++) {
      const h = terrainHeight(t, ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n);
      if (Math.abs(h - last) > limit) return false;
      last = h;
    }
    return true;
  }
  const gap = margin / lanes;
  const sx = ((bz - az) / length) * gap;
  const sz = (-(bx - ax) / length) * gap;
  const tilt = MAX_CROSS * gap;
  const width = 2 * lanes + 1;
  if (lanesBuffer.length < width) lanesBuffer = new Float64Array(width);
  const last = lanesBuffer;
  for (let k = 0; k < width; k++) last[k] = terrainHeight(t, ax + sx * (k - lanes), az + sz * (k - lanes));
  for (let i = 1; i <= n; i++) {
    const x = ax + ((bx - ax) * i) / n;
    const z = az + ((bz - az) * i) / n;
    let beside = 0;
    for (let k = 0; k < width; k++) {
      const h = terrainHeight(t, x + sx * (k - lanes), z + sz * (k - lanes));
      if (Math.abs(h - last[k]) > limit || (k > 0 && Math.abs(h - beside) > tilt)) return false;
      last[k] = h;
      beside = h;
    }
  }
  return true;
}

/** Tabliers de pont de chaque arène (ni parapets ni poutres), relevés une fois. */
const bridges = new WeakMap<ArenaLayout, StaticBox[]>();

/**
 * Hauteur de ce sur quoi l'on roule en (x, z), pour un robot qui roule à la hauteur `level` : le
 * tablier d'un pont s'il passe là à sa hauteur (à 2 m près), sinon le relief.
 */
export function surfaceHeight(arena: ArenaLayout, x: number, z: number, level: number): number {
  const ground = arena.terrain ? terrainHeight(arena.terrain, x, z) : 0;
  let decks = bridges.get(arena);
  if (!decks) bridges.set(arena, (decks = arena.boxes.filter((b) => b.kind === "deck" && Math.min(b.half.x, b.half.z) >= 1)));
  for (const b of decks) {
    const top = b.pos.y + b.half.y;
    if (Math.abs(top - level) > 2 || top < ground) continue;
    // Dans le repère du tablier (tourné autour de la verticale)
    const inverse = { x: -b.rot.x, y: -b.rot.y, z: -b.rot.z, w: b.rot.w };
    const p = qrot(inverse, vec3(x - b.pos.x, 0, z - b.pos.z));
    if (Math.abs(p.x) <= b.half.x && Math.abs(p.z) <= b.half.z) return top;
  }
  return ground;
}

/**
 * Distance, de (x, z) dans la direction (dx, dz) (unitaire), jusqu'au premier pas trop raide
 * (falaise qui monte, ou bord d'où l'on tomberait) de ce sur quoi il roule (`height`), au plus
 * `reach` m ; Infinity s'il n'y en a pas. L'évitement local de l'IA (ai/brain.ts) la prend comme un
 * obstacle : ses rayons ne voient pas le vide.
 */
export function edgeAhead(height: (x: number, z: number) => number, x: number, z: number, dx: number, dz: number, reach: number): number {
  let last = height(x, z);
  for (let d = SAMPLE; d <= reach; d += SAMPLE) {
    const h = height(x + dx * d, z + dz * d);
    if (Math.abs(h - last) > MAX_GRADE * SAMPLE) return d - SAMPLE;
    last = h;
  }
  return Infinity;
}

/**
 * Liaisons d'un réseau : chaque paire de points à moins de LINK_REACH m dont la ligne est
 * praticable, plus celles qu'on déclare (`extra` : un pont, une arche, où la ligne passe au-dessus
 * du vide).
 */
export function linkNav(t: Terrain, points: readonly (readonly [number, number])[], extra: readonly (readonly [number, number])[] = []): [number, number][] {
  const links: [number, number][] = extra.map(([a, b]) => [a, b]);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[j];
      if (Math.hypot(bx - ax, bz - az) > LINK_REACH) continue;
      if (walkable(t, ax, az, bx, bz, LINK_MARGIN)) links.push([i, j]);
    }
  }
  return links;
}

/**
 * Le point (x, z) se rejoint par le réseau : un de ses points le voit en ligne droite praticable
 * (pas le haut d'une butte, ni un replat de falaise).
 */
export function onNav(t: Terrain, points: readonly (readonly [number, number])[], x: number, z: number): boolean {
  return points.some(([px, pz]) => Math.hypot(px - x, pz - z) <= LINK_REACH * 0.7 && walkable(t, px, pz, x, z));
}

/** Voisins de chaque point d'un réseau, d'après ses liaisons. */
export function neighbours(points: readonly unknown[], links: readonly (readonly [number, number])[]): number[][] {
  const list: number[][] = points.map(() => []);
  for (const [a, b] of links) {
    list[a].push(b);
    list[b].push(a);
  }
  return list;
}
