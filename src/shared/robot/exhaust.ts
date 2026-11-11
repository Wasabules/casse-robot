import { propDistance } from "../arena/structures";
import { groundLevel } from "../arena/layout";
import { rayArena } from "../arena/ray";
import { blockDef, type BlockType, type ExhaustSpec } from "../catalog/blocks";
import { wheelDef } from "../catalog/wheels";
import { BLOCK_SIZE } from "../config";
import { AXES, cellKey, DEFAULT_FACING, type BlockPlacement, type RobotDesign } from "../design/robotDesign";
import { clamp } from "../math/scalar";
import { add, distance, dot, len, qrot, qrotInv, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { Block, Bot, Part, Thruster, Wheel } from "../sim/entities";
import type { World } from "../sim/world";
import { blockWorldPos, liveThrusters } from "./queries";

/*
 * Le jet de flamme des moteurs à flamme (réacteur, propulseur, turboréacteur ; voir
 * `ThrusterSpec.exhaust`) : derrière la tuyère, à l'opposé de la poussée, un cône chaud dont la
 * longueur et la chaleur suivent le régime. Ce module ne fait que de la géométrie, sans physique :
 * il se lit aussi bien sur la simulation que sur la réplique d'un client (la poussée des moteurs
 * passe par le réseau). Ce que le jet brûle est dans combat/scorch.ts ; ce qu'on en voit, dans
 * client/render/fx/exhaustFx.ts et la suie de WorldView.
 */

/** Régime (part de la poussée maximale) sous lequel un moteur n'a pas de jet : sa flamme n'est qu'une veilleuse. */
export const JET_MIN = 0.05;
/** Au ralenti, le jet n'a que cette part de sa longueur à plein régime. */
const IDLE_LENGTH = 0.25;
/** Au bout du jet, il ne reste que cette part de sa chaleur au ras de la tuyère. */
const TIP_HEAT = 0.3;
/** Postcombustion (turboréacteur) : le jet s'allonge de moitié et chauffe d'un tiers de plus. */
const BOOST_LENGTH = 0.5;
const BOOST_HEAT = 0.35;

/** Rôle d'un moteur d'après le haut de son bloc (comme `addThrusters`, robot/lifecycle.ts). */
export const thrusterRole = (up: Vec3): Thruster["role"] => (up.y > 0.7 ? "lift" : up.z > 0.7 ? "cruise" : "trim");

/**
 * Le jet de flamme d'un moteur de ce type et de ce rôle, s'il en a un : un moteur à flamme, pas un
 * rotor, une hélice, ni un réacteur couché de côté (il est dessiné avec une hélice de rotor de
 * queue, voir `hasBlades`, client/render/locomotionView.ts).
 */
export function exhaustSpec(type: BlockType, role: Thruster["role"]): ExhaustSpec | null {
  const spec = blockDef(type).thruster;
  if (!spec?.exhaust) return null;
  if (spec.look === undefined && role === "trim") return null;
  return spec.exhaust;
}

/** Le moteur crache-t-il une flamme (plutôt que de faire tourner des pales) ? */
export const hasFlame = (t: Thruster): boolean => exhaustSpec(t.block.type, t.role) !== null;

/** Longueur (m, au-delà de la tuyère) et chaleur (dégâts par seconde à la tuyère) d'un jet à ce régime (0 à 1). */
export function jetSize(spec: ExhaustSpec, ratio: number): { length: number; dps: number; boost: number } {
  const boost = spec.afterburner && ratio > spec.afterburner ? (ratio - spec.afterburner) / (1 - spec.afterburner) : 0;
  return {
    length: spec.reach * (IDLE_LENGTH + (1 - IDLE_LENGTH) * ratio) * (1 + BOOST_LENGTH * boost),
    dps: spec.dps * ratio * (1 + BOOST_HEAT * boost),
    boost,
  };
}

/** Longueur du jet à plein régime (postcombustion comprise) : la fiche du garage, ses avertissements. */
export const fullJetLength = (spec: ExhaustSpec): number => jetSize(spec, 1).length;

/** Le jet d'un moteur en ce moment. */
export interface Jet {
  readonly thruster: Thruster;
  readonly spec: ExhaustSpec;
  /** Bout de la tuyère (monde), et direction du jet (unitaire : à l'opposé de la poussée). */
  readonly origin: Vec3;
  readonly dir: Vec3;
  /** Longueur du jet au-delà de la tuyère (m). */
  readonly length: number;
  /** Dégâts par seconde (nature `fire`, avant résistance) au ras de la tuyère. */
  readonly dps: number;
  /** Régime (0 à 1) et postcombustion (0 à 1). */
  readonly power: number;
  readonly boost: number;
}

/**
 * Le jet d'un moteur, d'après son régime (`Thruster.thrust`) ; null s'il n'a pas de flamme ou
 * tourne au ralenti. L'appelant s'assure qu'il est alimenté (voir `botJets`).
 */
export function jetOf(t: Thruster): Jet | null {
  const ratio = clamp(t.thrust / blockDef(t.block.type).thruster!.maxThrust, 0, 1);
  return ratio < JET_MIN ? null : jetAt(t, ratio);
}

/** Le jet du moteur à ce régime (0 à 1), ou null s'il n'a pas de flamme. */
function jetAt(t: Thruster, ratio: number): Jet | null {
  const spec = exhaustSpec(t.block.type, t.role);
  if (!spec || !t.block.alive) return null;
  const dir = qrot(t.block.part.rb.rotation(), scale(t.block.up, -1));
  const origin = add(blockWorldPos(t.block), scale(dir, spec.nozzle));
  const { length, dps, boost } = jetSize(spec, ratio);
  return { thruster: t, spec, origin, dir, length, dps, power: ratio, boost };
}

/** Les jets d'un robot : ceux de ses moteurs à flamme reliés au cockpit (les seuls alimentés), s'il n'est pas paralysé. */
export function botJets(world: { readonly time: number }, bot: Bot): Jet[] {
  if (!bot.thrusters.length || bot.stunnedUntil > world.time) return [];
  const out: Jet[] = [];
  for (const t of liveThrusters(bot)) {
    const jet = jetOf(t);
    if (jet) out.push(jet);
  }
  return out;
}

/** Le jet qu'aurait ce moteur à plein régime (postcombustion comprise), ou null s'il n'a pas de flamme. */
const fullJet = (t: Thruster): Jet | null => jetAt(t, 1);

/**
 * Un de ses moteurs de ce rôle brûlerait-il son propre robot à plein régime (un bloc, une tête de
 * tourelle ou une roue derrière sa tuyère) ? L'IA n'allume pas de tels propulseurs.
 */
export function scorchesItself(bot: Bot, role: Thruster["role"]): boolean {
  for (const t of liveThrusters(bot, role)) {
    const jet = fullJet(t);
    if (jet && ownContact(jet)) return true;
  }
  return false;
}

/**
 * Un ennemi est-il dans le jet à plein régime d'un de ses moteurs de ce rôle (son centre à moins
 * de son rayon du cône) ? L'IA d'un robot à propulseurs les allume alors : un ennemi collé à son
 * arrière y brûle.
 */
export function foeInJet(world: Pick<World, "bots">, bot: Bot, role: Thruster["role"]): boolean {
  const jets: Jet[] = [];
  for (const t of liveThrusters(bot, role)) {
    const jet = fullJet(t);
    if (jet) jets.push(jet);
  }
  if (!jets.length) return false;
  for (const other of world.bots) {
    if (other.team === bot.team || !other.cockpit.alive) continue;
    const at = blockWorldPos(other.cockpit);
    const r = Math.min(other.radius, 1.5);
    for (const jet of jets) {
      const rel = sub(at, jet.origin);
      const along = dot(rel, jet.dir);
      if (along < -r || along - r > jet.length) continue;
      if (len(sub(rel, scale(jet.dir, along))) < r + jetRadius(jet, Math.max(0, along))) return true;
    }
  }
  return false;
}

/** Rayon du jet (m) à `d` m de la tuyère. */
export const jetRadius = (jet: Jet, d: number): number => jet.spec.radius + jet.spec.flare * d;

/** Chaleur du jet à `d` m de la tuyère : dégâts par seconde (avant résistance), qui faiblissent jusqu'au bout. */
export const jetHeat = (jet: Jet, d: number): number => jet.dps * (1 - (1 - TIP_HEAT) * clamp(d / jet.length, 0, 1));

/** Ce que le jet touche de son propre robot. */
export interface OwnContact {
  block: Block | null;
  wheel: Wheel | null;
  /** Distance à la tuyère (m). */
  distance: number;
}

/**
 * Ce que le jet touche de son propre morceau : le premier bloc (ou la tête d'une de ses tourelles)
 * dans l'axe de la tuyère, case par case dans la grille du robot (l'axe d'un moteur suit toujours
 * un axe de la grille), ou une de ses roues ; null si rien. Un robot bien construit n'a rien
 * derrière ses tuyères : c'est le cas de tous les robots prédéfinis.
 */
export function ownContact(jet: Jet): OwnContact | null {
  const block = jet.thruster.block;
  const part = block.part;
  const bot = block.bot;
  const back = { x: -Math.round(block.up.x), y: -Math.round(block.up.y), z: -Math.round(block.up.z) };
  const heads = headCells(bot, part);
  let found: OwnContact | null = null;
  for (let k = 1; ; k++) {
    // Distance de la tuyère au bord de la case : une case contre la nacelle d'un turboréacteur est à 0
    const near = k * BLOCK_SIZE - BLOCK_SIZE / 2 - jet.spec.nozzle;
    if (near > jet.length) break;
    const key = cellKey(block.x + k * back.x, block.y + k * back.y, block.z + k * back.z);
    const hit = bot.blocks.get(key);
    const target = hit && hit.part === part ? hit : heads.get(key);
    if (target) {
      found = { block: target, wheel: null, distance: Math.max(0, near) };
      break;
    }
  }
  // Ses roues : une sphère un peu plus petite que la roue, contre le cône du jet (dans le repère du robot)
  const reach = found ? found.distance : jet.length;
  const origin = add(block.local, scale(vec3(back.x, back.y, back.z), jet.spec.nozzle));
  for (const w of bot.wheels) {
    if (w.part !== part) continue;
    const rel = sub(w.local, origin);
    const along = dot(rel, back);
    const r = wheelDef(w.type).radius * 0.8;
    if (along < -r || along - r > reach) continue;
    const lateral = len(sub(rel, scale(vec3(back.x, back.y, back.z), along)));
    if (lateral > r + jetRadius(jet, Math.max(0, along))) continue;
    const d = Math.max(0, along - r);
    if (!found || d < found.distance) found = { block: null, wheel: w, distance: d };
  }
  return found;
}

/** Cases des têtes des tourelles de ce morceau (leur axe), et la tourelle de chacune. */
function headCells(bot: Bot, part: Part): Map<string, Block> {
  const out = new Map<string, Block>();
  for (const t of bot.turrets) {
    const b = t.block;
    if (!b.alive || b.part !== part) continue;
    const pivot = add(b.local, qrot(b.rot, vec3(0, blockDef(b.type).turret!.height, 0)));
    out.set(cellKey(Math.round(pivot.x / BLOCK_SIZE), Math.round(pivot.y / BLOCK_SIZE), Math.round(pivot.z / BLOCK_SIZE)), b);
  }
  return out;
}

/** Un bloc d'un plan dans le jet d'un de ses moteurs : le moteur, et le bloc (ou la tourelle dont la tête y est). */
export interface JetObstruction {
  engine: BlockPlacement;
  block: BlockPlacement;
}

/**
 * Blocs d'un plan posés dans le jet d'un de ses moteurs à flamme, à plein régime : ils brûleront
 * dès que le moteur poussera. Comme `ownContact`, case par case dans l'axe de la tuyère (pour le
 * garage, qui avertit comme pour une tourelle enfouie).
 */
export function jetObstructions(design: RobotDesign): JetObstruction[] {
  const cells = new Map<string, BlockPlacement>();
  for (const b of design.blocks) cells.set(cellKey(b.x, b.y, b.z), b);
  // La tête d'une tourelle orientable occupe la case au-dessus d'elle (dans le sens de son haut)
  for (const b of design.blocks) {
    const turret = blockDef(b.type).turret;
    if (!turret || turret.fixed) continue;
    const up = AXES[(b.facing ?? DEFAULT_FACING).up];
    const key = cellKey(b.x + up.x, b.y + up.y, b.z + up.z);
    if (!cells.has(key)) cells.set(key, b);
  }
  const out: JetObstruction[] = [];
  for (const engine of design.blocks) {
    const up = AXES[(engine.facing ?? DEFAULT_FACING).up];
    const spec = exhaustSpec(engine.type, thrusterRole(up));
    if (!spec) continue;
    const length = fullJetLength(spec);
    for (let k = 1; k * BLOCK_SIZE - BLOCK_SIZE / 2 - spec.nozzle <= length; k++) {
      const hit = cells.get(cellKey(engine.x - k * up.x, engine.y - k * up.y, engine.z - k * up.z));
      if (hit && hit !== engine) {
        out.push({ engine, block: hit });
        break;
      }
    }
  }
  return out;
}

/** Ce que touche un jet dans le monde affiché (voir `jetContact`). */
export interface JetContact {
  /** Distance à la tuyère (m). */
  distance: number;
  /** Un bloc d'un robot (le sien ou un autre), une roue, un accessoire, ou le décor et le sol. */
  kind: "block" | "wheel" | "prop" | "ground";
  block: Block | null;
}

/** Pas (m) du suivi du jet dans la grille des robots et contre les accessoires. */
const PROBE_STEP = 0.1;

/**
 * Le premier obstacle d'un jet, sans physique (pour l'affichage, en réseau aussi) : un bloc ou une
 * roue de son propre morceau (`ownContact`), un bloc d'un autre robot proche (case par case le
 * long de l'axe, dans la grille de chacun de ses morceaux), un accessoire, le décor fixe ou le sol
 * (le bas du cône qui lèche le sol compte). Null si le jet se perd dans l'air. Ne lit que des poses.
 */
export function jetContact(world: World, jet: Jet): JetContact | null {
  const own = ownContact(jet);
  let best: JetContact | null = own ? { distance: own.distance, kind: own.block ? "block" : "wheel", block: own.block } : null;
  let reach = best ? best.distance : jet.length;
  const { origin, dir } = jet;
  // Le décor fixe et le relief, puis le sol : le bas du cône qui le touche
  const scenery = rayArena(world.arena, origin, dir, reach);
  if (scenery !== null) {
    best = { distance: scenery, kind: "ground", block: null };
    reach = scenery;
  }
  for (let d = 0; d <= reach; d += PROBE_STEP * 2) {
    const p = add(origin, scale(dir, d));
    if (p.y - jetRadius(jet, d) * 0.7 <= groundLevel(world.arena, p.x, p.z)) {
      best = { distance: d, kind: "ground", block: null };
      reach = d;
      break;
    }
  }
  // Les autres robots (et les autres morceaux du sien)
  const mid = add(origin, scale(dir, reach / 2));
  const ownPart = jet.thruster.block.part;
  for (const bot of world.bots) {
    if (!bot.blocks.size) continue;
    for (const part of bot.parts) {
      if (part === ownPart) continue;
      const rb = part.rb;
      const at = rb.translation();
      if (distance(at, mid) > reach / 2 + Math.max(bot.radius, bot.top) + 1) continue;
      const q = rb.rotation();
      const o = qrotInv(q, sub(origin, at));
      const v = qrotInv(q, dir);
      for (let d = 0; d < reach; d += PROBE_STEP) {
        const key = cellKey(Math.round((o.x + v.x * d) / BLOCK_SIZE), Math.round((o.y + v.y * d) / BLOCK_SIZE), Math.round((o.z + v.z * d) / BLOCK_SIZE));
        const b = bot.blocks.get(key);
        if (b && b.part === part) {
          best = { distance: d, kind: "block", block: b };
          reach = d;
          break;
        }
      }
    }
  }
  // Les accessoires proches
  for (const prop of world.props) {
    const at = prop.rb.translation();
    if (distance(at, mid) > reach / 2 + Math.max(prop.half.x, prop.half.y, prop.half.z) + 0.5) continue;
    for (let d = 0; d < reach; d += PROBE_STEP) {
      if (propDistance(prop, add(origin, scale(dir, d))) < PROBE_STEP) {
        best = { distance: d, kind: "prop", block: null };
        reach = d;
        break;
      }
    }
  }
  return best;
}
