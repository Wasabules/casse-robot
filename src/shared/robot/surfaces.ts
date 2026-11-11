import { blockDef, type BlockType } from "../catalog/blocks";
import { BLOCK_SIZE, PLATE_THICKNESS } from "../config";
import { AXES, cellKey, DEFAULT_FACING, type BlockPlacement } from "../design/robotDesign";
import { cross, type Vec3 } from "../math/vec";
import type { AeroSurface, Block, Bot } from "../sim/entities";
import { linkKey } from "./structure";

/*
 * Ailes et gouvernes en rangs. Des gouvernes posées bout à bout le long de leur envergure (même
 * type, même haut, même avant, liées entre elles : même morceau, liaison intacte) forment une seule
 * gouverne : elle braque d'un seul angle (le mélangeur, robot/aero.ts, raisonne par rang, avec
 * l'effet cumulé de ses blocs) et le rendu la dessine d'une pièce, qui pivote autour d'une seule
 * charnière. Deux rangs l'un derrière l'autre restent deux gouvernes (le second est articulé
 * derrière le premier, comme un volet derrière un aileron) : le mélangeur se sert de leur écart
 * de bras de levier, et sans lui l'Avion ne tenait plus son altitude dans un virage serré.
 * Les ailes, immobiles, n'ont pas besoin de rangs : chaque côté d'une case est façonné selon ce
 * qui la touche (`surfaceSides`), et des ailes voisines font une aile continue, dans les deux sens.
 * Un bloc détruit au milieu coupe le rang en deux, un morceau arraché emporte les siens : tout se
 * déduit des blocs vivants et de leurs morceaux, en local comme sur la réplique réseau.
 */

/**
 * Côtés d'une case de surface, dans son plan : gauche et droite (envergure, ±x du bloc), avant et
 * arrière (corde, ±z du bloc). Un bit `SIDE_*` : ce côté est façonné (voir `surfaceSides`).
 */
export const SIDE_LEFT = 1;
export const SIDE_RIGHT = 2;
export const SIDE_FRONT = 4;
export const SIDE_REAR = 8;
/** L'aile continue d'une pièce par l'avant (ou l'arrière) : une aile du même plan, rien à dessiner entre elles. */
export const SEAMLESS_FRONT = 16;
export const SEAMLESS_REAR = 32;
/**
 * Bout d'envergure fermé d'une face droite : contre un bloc, contre une surface qui bouge à part
 * (une gouverne à côté d'une aile), ou contre une case d'un autre profil (le jour entre elles se
 * verrait). Sans ce bit ni le saumon, la case continue dans sa voisine, et rien n'est dessiné.
 */
export const CLOSED_LEFT = 64;
export const CLOSED_RIGHT = 128;
/** Tous les côtés façonnés : une case seule (débris, vignettes, aperçu de la pièce à poser). */
export const SIDES_ALONE = SIDE_LEFT | SIDE_RIGHT | SIDE_FRONT | SIDE_REAR;

/** Ce qu'on sait d'une case : sa place sur la grille, son type et son orientation (bloc en jeu, ou bloc d'un plan). */
export interface SurfaceCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly type: BlockType;
  readonly up: Vec3;
  readonly forward: Vec3;
}

/** Ce qui occupe la case voisine décalée de (dx, dy, dz), s'il y est lié ; null : rien. */
export type Neighbor<T extends SurfaceCell> = (cell: T, dx: number, dy: number, dz: number) => T | null;

/** Surface portante (aile ou gouverne) ? */
export const isSurface = (type: BlockType): boolean => !!blockDef(type).aero;

/** Gouverne (surface mobile) ? */
export const isFlap = (type: BlockType): boolean => !!blockDef(type).aero?.maxDeflection;

const same = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** Deux cases de surface de la même sorte : même type, même haut, même avant. */
export const joinable = (a: SurfaceCell, b: SurfaceCell): boolean =>
  a.type === b.type && isSurface(a.type) && same(a.up, b.up) && same(a.forward, b.forward);

/** Décalages de grille des quatre côtés d'une case, dans l'ordre des bits : gauche, droite, avant, arrière. */
export function sideOffsets(cell: SurfaceCell): [number, number, number][] {
  const l = cross(cell.up, cell.forward);
  const f = cell.forward;
  // (+ 0 : pas de -0 dans les clés de grille)
  return [
    [l.x + 0, l.y + 0, l.z + 0], [-l.x + 0, -l.y + 0, -l.z + 0],
    [f.x + 0, f.y + 0, f.z + 0], [-f.x + 0, -f.y + 0, -f.z + 0],
  ];
}

/**
 * Rangs de surfaces : les cases joignables (voir `joinable`) qui se suivent le long de leur
 * envergure, d'un bout à l'autre. `neighbor` ne rend que ce qui est lié à la case (en jeu : même
 * morceau, liaison intacte). Chaque rang garde l'ordre de `cells`.
 */
export function surfaceGroups<T extends SurfaceCell>(cells: Iterable<T>, neighbor: Neighbor<T>): T[][] {
  const list = [...cells].filter((c) => isSurface(c.type));
  const index = new Map(list.map((c, i) => [c, i]));
  const seen = new Uint8Array(list.length);
  const groups: T[][] = [];
  for (let i = 0; i < list.length; i++) {
    if (seen[i]) continue;
    seen[i] = 1;
    const members = [i];
    for (let k = 0; k < members.length; k++) {
      const cell = list[members[k]];
      const [left, right] = sideOffsets(cell);
      for (const [dx, dy, dz] of [left, right]) {
        const n = neighbor(cell, dx, dy, dz);
        const j = n ? index.get(n) : undefined;
        if (j === undefined || seen[j] || !joinable(cell, n!)) continue;
        seen[j] = 1;
        members.push(j);
      }
    }
    groups.push(members.sort((a, b) => a - b).map((m) => list[m]));
  }
  return groups;
}

/**
 * Profil d'une case selon ce qui la touche (bits `SIDE_*` et `SEAMLESS_*`). Un côté qui ne touche
 * rien est façonné (bord d'attaque arrondi devant, bord de fuite effilé derrière, saumon arrondi au
 * bout de l'envergure) ; contre une autre surface ou contre un bloc, il reste droit, et l'aile
 * continue. Le bord d'attaque d'une gouverne est toujours arrondi : c'est sa charnière, autour de
 * laquelle elle pivote sans heurter ce qui la précède. Deux ailes du même plan l'une derrière
 * l'autre (immobiles) ne font qu'une : rien n'est dessiné entre elles. Le long de l'envergure, une
 * case continue dans sa voisine du même ensemble et du même profil ; sinon, une face droite la ferme
 * (`CLOSED_*`). Rien n'est dessiné entre deux cases qui continuent l'une dans l'autre : une face
 * cachée au ras de la peau la rayait d'un pointillé, où le tampon de profondeur hésitait entre elles.
 */
export function surfaceSides<T extends SurfaceCell>(cell: T, neighbor: Neighbor<T>): number {
  const sides = chordSides(cell, neighbor);
  const [left, right] = sideOffsets(cell);
  let out = sides;
  for (const [[dx, dy, dz], tip, closed] of [[left, SIDE_LEFT, CLOSED_LEFT], [right, SIDE_RIGHT, CLOSED_RIGHT]] as const) {
    const n = neighbor(cell, dx, dy, dz);
    if (!n) out |= tip;
    else if (!joinable(cell, n) || chordSides(n, neighbor) !== sides) out |= closed;
  }
  return out;
}

/** Profil le long de la corde (bits `SIDE_FRONT`, `SIDE_REAR`, `SEAMLESS_*`) : voir `surfaceSides`. */
function chordSides<T extends SurfaceCell>(cell: T, neighbor: Neighbor<T>): number {
  const flap = isFlap(cell.type);
  const plane = (n: T | null): boolean => !!n && !flap && isSurface(n.type) && !isFlap(n.type) && same(n.up, cell.up) && same(n.forward, cell.forward);
  const [, , [fx, fy, fz], [rx, ry, rz]] = sideOffsets(cell);
  const front = neighbor(cell, fx, fy, fz);
  const rear = neighbor(cell, rx, ry, rz);
  let sides = 0;
  if (flap || !front) sides |= SIDE_FRONT;
  else if (plane(front)) sides |= SEAMLESS_FRONT;
  if (!rear) sides |= SIDE_REAR;
  else if (plane(rear)) sides |= SEAMLESS_REAR;
  return sides;
}

/** Position d'une case le long d'un axe de grille (en cases). */
const along = (cell: SurfaceCell, axis: Vec3): number => cell.x * axis.x + cell.y * axis.y + cell.z * axis.z;

/**
 * Charnière d'un rang de gouvernes (dessin seulement : la physique n'en dépend pas). Si un bloc le
 * précède (une aile, l'empennage, le fuselage, un autre rang de gouvernes), elle est à son bord
 * d'attaque, au centre de son arrondi : la gouverne pivote derrière ce qui la porte, comme une
 * profondeur. Sinon (gouverne monobloc, en bout d'aile), au milieu de sa corde. Rend sa position
 * le long de l'avant des blocs (m, dans le repère du robot : produit scalaire avec `forward`).
 */
export function hingeChord<T extends SurfaceCell>(group: readonly T[], neighbor: Neighbor<T>): number {
  const chord = along(group[0], group[0].forward);
  const [, , [dx, dy, dz]] = sideOffsets(group[0]);
  const held = group.some((c) => neighbor(c, dx, dy, dz) !== null);
  return held ? (chord + 0.5) * BLOCK_SIZE - PLATE_THICKNESS / 2 : chord * BLOCK_SIZE;
}

/**
 * Le rang de gouvernes qui en porte un autre : une gouverne de la même sorte juste devant lui (un
 * volet derrière un aileron). Le rendu articule le second derrière le premier. Null : aucun.
 */
export function carrierCell<T extends SurfaceCell>(group: readonly T[], neighbor: Neighbor<T>): T | null {
  const [, , [dx, dy, dz]] = sideOffsets(group[0]);
  for (const c of group) {
    const n = neighbor(c, dx, dy, dz);
    if (n && joinable(c, n)) return n;
  }
  return null;
}

/** Voisin lié d'un bloc en jeu : le bloc vivant de la case décalée, sur le même morceau, liaison intacte. */
export function linkedAt(block: Block, dx: number, dy: number, dz: number): Block | null {
  const n = block.bot.blocks.get(cellKey(block.x + dx, block.y + dy, block.z + dz));
  const cuts = block.bot.cuts;
  return n && n.alive && n.part === block.part && (cuts.size === 0 || !cuts.has(linkKey(block, n))) ? n : null;
}

/**
 * Rangs de gouvernes d'un robot (voir `surfaceGroups`) parmi `flaps` : par défaut toutes ses
 * gouvernes vivantes, sur tous ses morceaux.
 */
export function flapRuns(bot: Bot, flaps: readonly AeroSurface[] = bot.surfaces.filter((s) => s.block.alive && isFlap(s.block.type))): AeroSurface[][] {
  const of = new Map(flaps.map((s) => [s.block, s]));
  return surfaceGroups(of.keys(), (b, dx, dy, dz) => {
    const n = linkedAt(b, dx, dy, dz);
    return n && of.has(n) ? n : null;
  }).map((run) => run.map((b) => of.get(b)!));
}

/**
 * Façonnage des côtés de chaque aile et gouverne d'un plan (garage, aperçus : tout y est lié),
 * par clé de grille ; voir `surfaceSides`.
 */
export function designSurfaceSides(blocks: readonly BlockPlacement[]): Map<string, number> {
  const cells = new Map<string, SurfaceCell>();
  for (const b of blocks) {
    const f = b.facing ?? DEFAULT_FACING;
    cells.set(cellKey(b.x, b.y, b.z), { x: b.x, y: b.y, z: b.z, type: b.type, up: AXES[f.up], forward: AXES[f.forward] });
  }
  const neighbor: Neighbor<SurfaceCell> = (c, dx, dy, dz) => cells.get(cellKey(c.x + dx, c.y + dy, c.z + dz)) ?? null;
  const out = new Map<string, number>();
  for (const [key, cell] of cells) if (isSurface(cell.type)) out.set(key, surfaceSides(cell, neighbor));
  return out;
}
