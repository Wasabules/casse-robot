import { blockDef, blockShape, isBlockType, type BlockType } from "../catalog/blocks";
import { shapeSwaps } from "../catalog/shapes";
import { isWheelType, steerClearance, steeredVariant, wheelDef, type WheelType } from "../catalog/wheels";
import { BLOCK_SIZE, WHEEL_GAP } from "../config";
import { cross, dot, vec3, type Vec3 } from "../math/vec";
import { designCost, ROBOT_BUDGET } from "./budget";

/** Un des six axes du repère du robot. */
export type Axis = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

export const AXES: Readonly<Record<Axis, Vec3>> = {
  "+x": vec3(1, 0, 0), "-x": vec3(-1, 0, 0),
  "+y": vec3(0, 1, 0), "-y": vec3(0, -1, 0),
  "+z": vec3(0, 0, 1), "-z": vec3(0, 0, -1),
};

/**
 * Orientation d'un bloc : vers où pointent son haut et son avant, dans le repère du robot.
 * Un réacteur pousse vers son haut ; une aile porte vers son haut, et l'air l'attaque par son avant.
 */
export interface Facing {
  up: Axis;
  forward: Axis;
}

/** Orientation par défaut : le haut du bloc est le haut du robot, son avant est l'avant du robot. */
export const DEFAULT_FACING: Readonly<Facing> = { up: "+y", forward: "+z" };

/** L'axe du robot le plus proche de ce vecteur. */
export function axisOf(v: Vec3): Axis {
  const [ax, ay, az] = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  if (ay >= ax && ay >= az) return v.y >= 0 ? "+y" : "-y";
  if (ax >= az) return v.x >= 0 ? "+x" : "-x";
  return v.z >= 0 ? "+z" : "-z";
}

/** L'axe opposé. */
export const oppositeAxis = (a: Axis): Axis => ((a[0] === "+" ? "-" : "+") + a[1]) as Axis;

/** Gauche d'un bloc orienté ainsi (le produit de son haut par son avant). */
export const leftOf = (f: Facing): Axis => axisOf(cross(AXES[f.up], AXES[f.forward]));

/**
 * Orientation du bloc symétrique par rapport au plan x = 0 (symétrie du garage). Un bloc symétrique
 * de gauche à droite garde son haut et son avant, reflétés ; une forme dont la symétrie échange sa
 * gauche et son avant (un coin) prend pour avant le reflet de sa gauche : sans cela, le coin
 * symétrique serait le même coin tourné, pas son image dans le miroir.
 */
export function mirrorFacing(type: BlockType, f: Facing): Facing {
  const m = (a: Axis): Axis => (a === "+x" ? "-x" : a === "-x" ? "+x" : a);
  const shape = isBlockType(type) ? blockShape(type) : null;
  return shape && shapeSwaps(shape) ? { up: m(f.up), forward: m(leftOf(f)) } : { up: m(f.up), forward: m(f.forward) };
}

/** Bloc placé sur la grille d'un plan. Coordonnées entières, une case = BLOCK_SIZE. */
export interface BlockPlacement {
  x: number;
  y: number;
  z: number;
  type: BlockType;
  /** Absente : orientation par défaut. */
  facing?: Facing;
}

/**
 * Roue fixée sur une face du bloc support (x, y, z) : (dx, dz) = (±1, 0) à gauche ou à droite,
 * (0, ±1) devant ou derrière, ou `dy` = -1 (et dx = dz = 0) dessous. Son essieu suit toujours
 * l'axe x du robot. Une roue qui pivote (directrice, roulette) montée à gauche ou à droite est
 * écartée du bloc pour avoir la place de pivoter (`steerClearance`).
 */
export interface WheelMount {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  /** -1 : sous le bloc. Absent : sur un flanc. */
  dy?: number;
  type: WheelType;
  /**
   * Décalage le long du flanc, en demi-cases (-1, 0 ou 1 : un quart de mètre vers l'arrière ou
   * l'avant d'un flanc gauche ou droit ou du dessous, vers la droite ou la gauche d'un flanc avant
   * ou arrière). Il permet d'espacer des roues de deux cases et demie, ou d'en centrer une entre
   * deux blocs.
   */
  shift?: number;
  /**
   * Galet de chenille sur un flanc gauche ou droit : `rise` le monte ou le descend d'autant de cases
   * (de -2 à 2 : une chenille plus haute, sans bloc derrière chaque galet), `layer` le pose sur
   * autant de galets vers l'extérieur (0 à 2 : une chenille plus large). Voir `TRACK_RISE`, `TRACK_LAYERS`.
   */
  rise?: number;
  layer?: number;
}

/** Hauteur (en cases, de part et d'autre de son bloc) et épaisseur (galets posés l'un sur l'autre) d'une chenille. */
export const TRACK_RISE = 2;
export const TRACK_LAYERS = 2;

/**
 * Plan d'un robot : des données pures, sérialisables en JSON (futur éditeur, réseau).
 * Repère : l'avant est +z, la gauche est +x, le haut est +y.
 */
export interface RobotDesign {
  blocks: BlockPlacement[];
  wheels: WheelMount[];
}

export const cellKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Position du centre d'une roue au repos, dans le repère local du robot. */
export function wheelLocalPos(m: WheelMount): Vec3 {
  const def = wheelDef(m.type);
  const along = (m.shift ?? 0) * (BLOCK_SIZE / 2);
  // Sous le bloc : la roue pend sous sa face du dessous
  if (m.dy) return vec3(m.x * BLOCK_SIZE, m.y * BLOCK_SIZE - (BLOCK_SIZE / 2 + WHEEL_GAP + def.radius), m.z * BLOCK_SIZE + along);
  const lateral = BLOCK_SIZE / 2 + WHEEL_GAP + def.width / 2 + steerClearance(def) + (m.layer ?? 0) * def.width;
  return vec3(
    m.x * BLOCK_SIZE + m.dx * lateral + (m.dz !== 0 ? along : 0),
    m.y * BLOCK_SIZE - (def.drop ?? 0) + (m.rise ?? 0) * BLOCK_SIZE,
    m.z * BLOCK_SIZE + m.dz * (BLOCK_SIZE / 2 + WHEEL_GAP + def.radius) + (m.dx !== 0 ? along : 0),
  );
}

/** Nombre de faces qu'indique un montage de roue (1 pour un montage valide). */
const mountFaces = (w: WheelMount): number => Math.abs(w.dx) + Math.abs(w.dz) + Math.abs(w.dy ?? 0);

/**
 * Plan d'une version précédente, remis au format du jour : une roue directrice était une roue fixe
 * avec une case cochée (`steer`) ; c'est maintenant un type de roue à part (`steeredVariant`).
 */
export function upgradeDesign(design: RobotDesign): RobotDesign {
  if (!Array.isArray(design.wheels)) return design;
  return {
    ...design,
    wheels: design.wheels.map((w) => {
      const { steer, ...mount } = w as WheelMount & { steer?: unknown };
      if (steer !== true || typeof mount.type !== "string" || !isWheelType(mount.type)) return mount;
      return { ...mount, type: steeredVariant(mount.type) ?? mount.type };
    }),
  };
}

/** Deux roues peuvent se toucher d'autant (m) sans se gêner. */
const WHEEL_OVERLAP = 0.01;

/**
 * Deux roues se chevauchent-elles ? Elles se repousseraient : l'une resterait soulevée, sa
 * suspension écrasée. Toutes tournent autour d'un axe parallèle à x : leurs disques sont dans le
 * plan (y, z), et ne se gênent que s'ils se recouvrent aussi en x.
 */
export function wheelsOverlap(a: WheelMount, b: WheelMount): boolean {
  const [da, db] = [wheelDef(a.type), wheelDef(b.type)];
  const [pa, pb] = [wheelLocalPos(a), wheelLocalPos(b)];
  const side = Math.abs(pa.x - pb.x) < (da.width + db.width) / 2;
  return side && Math.hypot(pa.y - pb.y, pa.z - pb.z) < da.radius + db.radius - WHEEL_OVERLAP;
}

/** Les six voisins d'une case : deux blocs sont liés s'ils partagent une face. */
export const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** Aide pour écrire un plan bloc par bloc. Poser un bloc sur une case occupée le remplace. */
export class DesignGrid {
  private readonly cells = new Map<string, BlockPlacement>();

  put(x: number, y: number, z: number, type: BlockType = "armor", facing?: Facing): this {
    this.cells.set(cellKey(x, y, z), facing ? { x, y, z, type, facing } : { x, y, z, type });
    return this;
  }

  /** Remplit le pavé entre (x0, y0, z0) et (x1, y1, z1), bornes incluses et dans n'importe quel ordre. */
  box(
    x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
    type: BlockType = "armor", facing?: Facing,
  ): this {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) this.put(x, y, z, type, facing);
      }
    }
    return this;
  }

  /** Pose le bloc et son symétrique par rapport au plan x = 0 (orientation reflétée : `mirrorFacing`). */
  pair(x: number, y: number, z: number, type: BlockType, facing: Facing = DEFAULT_FACING): this {
    this.put(x, y, z, type, facing === DEFAULT_FACING ? undefined : facing);
    const twin = mirrorFacing(type, facing);
    const plain = twin.up === DEFAULT_FACING.up && twin.forward === DEFAULT_FACING.forward;
    return this.put(-x, y, z, type, plain ? undefined : twin);
  }

  remove(x: number, y: number, z: number): this {
    this.cells.delete(cellKey(x, y, z));
    return this;
  }

  blocks(): BlockPlacement[] {
    return [...this.cells.values()];
  }
}

/**
 * Tourelles enfouies : la case de leur tête (juste au-dessus d'elles, dans le sens de leur haut ;
 * derrière un poseur de mines, par où tombent ses mines ; sous une soute à bombes) est occupée par un bloc. Elles ne
 * pourront jamais tirer : un robot ne tire pas à travers lui-même (voir combat/turrets.ts).
 */
export function buriedTurrets(design: RobotDesign): BlockPlacement[] {
  const cells = new Set(design.blocks.map((b) => cellKey(b.x, b.y, b.z)));
  return design.blocks.filter((b) => {
    const turret = isBlockType(b.type) ? blockDef(b.type).turret : undefined;
    if (!turret) return false;
    const facing = b.facing ?? DEFAULT_FACING;
    const out = turret.fixed === "back" ? AXES[facing.forward] : AXES[facing.up];
    const s = turret.fixed ? -1 : 1;
    return cells.has(cellKey(b.x + s * out.x, b.y + s * out.y, b.z + s * out.z));
  });
}

/**
 * Un défaut d'un plan : son code, et ce qu'il faut pour le dire (`at` : la case en cause, « x,y,z »).
 * Le client le dit dans la langue du joueur (`designIssue.<code>`, client/i18n/names.ts).
 */
export type DesignIssue =
  | { code: "fractional"; at: string }
  | { code: "unknownBlock"; at: string; type: string }
  | { code: "doubleBlock"; at: string }
  | { code: "badFacing"; at: string }
  | { code: "cockpits"; n: number }
  | { code: "detached"; n: number }
  | { code: "noSupport"; at: string }
  | { code: "badSide"; at: string }
  | { code: "underOccupied"; at: string }
  | { code: "badShift"; at: string }
  | { code: "unknownWheel"; at: string; type: string }
  | { code: "oldSteer"; at: string }
  | { code: "stackSide"; at: string }
  | { code: "badStack"; at: string }
  | { code: "wheelsOverlap"; at: string; other: string }
  | { code: "overBudget"; cost: number; budget: number };

/** Un défaut en une ligne, pour les journaux des développeurs (le joueur le lit traduit). */
export const issueSummary = (issue: DesignIssue): string => JSON.stringify(issue);

/** Liste les défauts d'un plan. Une liste vide veut dire que le plan est jouable. */
export function validateDesign(design: RobotDesign): DesignIssue[] {
  const problems: DesignIssue[] = [];
  const cells = new Map<string, BlockPlacement>();
  let cockpits = 0;

  for (const b of design.blocks) {
    const key = cellKey(b.x, b.y, b.z);
    if (![b.x, b.y, b.z].every(Number.isInteger)) problems.push({ code: "fractional", at: key });
    if (!isBlockType(b.type)) problems.push({ code: "unknownBlock", at: key, type: String(b.type) });
    if (cells.has(key)) problems.push({ code: "doubleBlock", at: key });
    if (b.facing) {
      const { up, forward } = b.facing;
      if (!(up in AXES) || !(forward in AXES) || dot(AXES[up], AXES[forward]) !== 0) {
        problems.push({ code: "badFacing", at: key });
      }
    }
    if (b.type === "cockpit") cockpits++;
    cells.set(key, b);
  }
  if (cockpits !== 1) problems.push({ code: "cockpits", n: cockpits });

  // Tous les blocs doivent former un seul morceau
  const first = cells.keys().next();
  if (!first.done) {
    const seen = new Set([first.value]);
    const stack = [first.value];
    while (stack.length) {
      const b = cells.get(stack.pop()!)!;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const key = cellKey(b.x + dx, b.y + dy, b.z + dz);
        if (cells.has(key) && !seen.has(key)) {
          seen.add(key);
          stack.push(key);
        }
      }
    }
    if (seen.size !== cells.size) problems.push({ code: "detached", n: cells.size - seen.size });
  }

  for (const w of design.wheels) {
    const key = cellKey(w.x, w.y, w.z);
    if (!cells.has(key)) problems.push({ code: "noSupport", at: key });
    const under = w.dy !== undefined && w.dy !== 0;
    if (mountFaces(w) !== 1 || (under && w.dy !== -1)) problems.push({ code: "badSide", at: key });
    if (under && cells.has(cellKey(w.x, w.y - 1, w.z))) problems.push({ code: "underOccupied", at: key });
    if (w.shift !== undefined && (!Number.isInteger(w.shift) || Math.abs(w.shift) > 1)) problems.push({ code: "badShift", at: key });
    if (!isWheelType(w.type)) problems.push({ code: "unknownWheel", at: key, type: String(w.type) });
    // Une case « directrice » d'un ancien plan (voir upgradeDesign)
    if ("steer" in w) problems.push({ code: "oldSteer", at: key });
    if (w.rise !== undefined || w.layer !== undefined) {
      const track = isWheelType(w.type) && wheelDef(w.type).track;
      const rise = w.rise ?? 0;
      const layer = w.layer ?? 0;
      // Seul un galet de chenille, sur un flanc gauche ou droit, s'empile
      if (!track || w.dx === 0) problems.push({ code: "stackSide", at: key });
      if (!Number.isInteger(rise) || Math.abs(rise) > TRACK_RISE || !Number.isInteger(layer) || layer < 0 || layer > TRACK_LAYERS) {
        problems.push({ code: "badStack", at: key });
      }
    }
  }
  // Deux roues qui se chevauchent se repoussent : l'une reste soulevée, sa suspension écrasée
  const wheels = design.wheels.filter((w) => isWheelType(w.type) && mountFaces(w) === 1);
  for (let i = 0; i < wheels.length; i++) {
    for (let j = i + 1; j < wheels.length; j++) {
      const [a, b] = [wheels[i], wheels[j]];
      if (wheelsOverlap(a, b)) problems.push({ code: "wheelsOverlap", at: cellKey(a.x, a.y, a.z), other: cellKey(b.x, b.y, b.z) });
    }
  }
  if (!problems.length) {
    const cost = designCost(design);
    if (cost > ROBOT_BUDGET) problems.push({ code: "overBudget", cost, budget: ROBOT_BUDGET });
  }
  return problems;
}
