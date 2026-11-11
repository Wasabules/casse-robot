import RAPIER from "@dimforge/rapier3d-compat";
import { blockDef, BLOCK_TYPES } from "../catalog/blocks";
import type { KillCause, RepairShot } from "../catalog/weapons";
import { wheelDef } from "../catalog/wheels";
import { BLOCK_SIZE, STEP } from "../config";
import { cellKey, NEIGHBORS } from "../design/robotDesign";
import { add, distance, qrot, type Vec3 } from "../math/vec";
import { ownerBot, rebuildDirtyParts } from "../robot/colliders";
import { capturePartMotion, refreshWheels, splitPart } from "../robot/destruction";
import { blockWorldPos } from "../robot/queries";
import type { Block, Bot, Part, Wheel } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { strike } from "./damage";
import { isStunned } from "./emp";

/*
 * Réparation. Un module de réparation relié au cockpit remet en état les blocs abîmés de son
 * robot autour de lui (et ses roues), quand le robot n'a pas été touché depuis un moment, puis
 * fait repousser ses blocs perdus. Le rayon réparateur et les nanites font de même sur un allié.
 *
 * Un bloc perdu repousse à sa place dans le plan, sur le morceau du cockpit, s'il touche un bloc
 * de ce morceau : un bloc détruit (`Bot.lost`), ou un bloc emporté par un morceau qui s'est
 * détaché (une aile tranchée) : il quitte alors ce morceau, qui se désagrège bloc à bloc.
 */

/** Part de ses points de structure avec laquelle un bloc repousse (la réparation fait le reste). */
const REBUILD_SHARE = 0.3;
/** Un robot ne regagne pas plus d'un bloc tous les REBUILD_GAP s (module ou tirs réparateurs). */
const REBUILD_GAP = 0.35;

/** Les réparations sont traitées par tranches de cette durée (s). */
const TICK = 0.25;

type Damaged = { block: Block; ratio: number } | { wheel: Wheel; ratio: number };

/**
 * Tir réparateur (arme à `repair`, combat/projectiles.ts) sur un allié : chaque bloc et chaque roue
 * de `bot` à moins de `radius` m de `point` regagne `amount` points de structure, sans dépasser son
 * maximum, et un de ses blocs perdus voisins repousse.
 */
export function repairAt(sim: Simulation, bot: Bot, point: Vec3, spec: RepairShot): void {
  if (spec.swarm) {
    swarmOver(sim, bot, point, spec.amount, spec.swarm);
    return;
  }
  for (const b of bot.blocks.values()) {
    const max = BLOCK_TYPES[b.type].hp;
    if (b.hp >= max || distance(blockWorldPos(b), point) > spec.radius) continue;
    b.hp = Math.min(max, b.hp + spec.amount);
    sim.emit({ type: "blockRepaired", block: b });
  }
  for (const w of bot.wheels) {
    const max = wheelDef(w.type).hp;
    if (w.part && w.hp < max && distance(w.rb.translation(), point) <= spec.radius) w.hp = Math.min(max, w.hp + spec.amount);
  }
  if (sim.time < bot.rebuildAt) return;
  const lost = regrowable(sim, bot, point, spec.radius + 0.5);
  if (!lost) return;
  rebuildBlock(sim, lost, BLOCK_TYPES[lost.type].hp * REBUILD_SHARE);
  bot.rebuildAt = sim.time + REBUILD_GAP;
}

/** Nanites (`RepairShot.swarm`) : les `count` blocs les plus abîmés du robot regagnent `amount` points, et un bloc perdu repousse, où qu'ils soient. */
function swarmOver(sim: Simulation, bot: Bot, point: Vec3, amount: number, count: number): void {
  for (const b of damagedBlocks(bot).slice(0, count)) {
    b.hp = Math.min(BLOCK_TYPES[b.type].hp, b.hp + amount);
    sim.emit({ type: "blockRepaired", block: b });
  }
  const lost = sim.time >= bot.rebuildAt ? regrowable(sim, bot, point, Infinity) : null;
  if (!lost) return;
  rebuildBlock(sim, lost, BLOCK_TYPES[lost.type].hp * REBUILD_SHARE);
  bot.rebuildAt = sim.time + REBUILD_GAP;
}

/**
 * Tir réparateur sur un ennemi (vol de vie) : `drain` dégâts au bloc touché, dont la part `steal`
 * de ce qu'il a vraiment perdu répare le tireur, ses blocs les plus abîmés d'abord.
 */
export function drainAt(
  sim: Simulation, block: Block, point: Vec3, dir: Vec3, spec: RepairShot, shooter: Bot, origin: Vec3, cause: KillCause,
): void {
  if (!spec.drain) return;
  const before = block.hp;
  strike(sim, { kind: "block", block }, spec.drain, "energy", point, dir, 0, origin, shooter, cause);
  const taken = block.alive ? before - block.hp : before;
  heal(sim, shooter, taken * (spec.steal ?? 0));
}

/** Rend `amount` points au robot, à ses blocs les plus abîmés d'abord. */
function heal(sim: Simulation, bot: Bot, amount: number): void {
  if (!bot.cockpit.alive) return;
  for (const b of damagedBlocks(bot)) {
    if (amount <= 0) return;
    const gain = Math.min(amount, BLOCK_TYPES[b.type].hp - b.hp);
    b.hp += gain;
    amount -= gain;
    sim.emit({ type: "blockRepaired", block: b });
  }
}

/** Position dans le monde d'un point du repère du robot, porté par le morceau `part`. */
const onPart = (part: Part, local: Vec3): Vec3 => add(part.rb.translation(), qrot(part.rb.rotation(), local));

/**
 * Bloc perdu de `bot` qui peut repousser à moins de `radius` m de `point` : à sa place dans le
 * plan, contre un bloc du morceau du cockpit, dans une case libre (ni décor, ni accessoire, ni
 * autre robot : la physique l'en chasserait d'un coup, et le robot avec) ; le plus proche. Jamais
 * le cockpit. Un bloc détruit n'a plus de corps sûr : on le place d'après le morceau du cockpit,
 * jamais d'après le sien.
 */
export function regrowable(sim: Simulation, bot: Bot, point: Vec3, radius: number): Block | null {
  if (!bot.cockpit.alive) return null;
  const core = bot.cockpit.part;
  const candidates: { block: Block; d: number }[] = [];
  for (const { x, y, z } of bot.profile.design.blocks) {
    const key = cellKey(x, y, z);
    const here = bot.blocks.get(key);
    const block = here ? (here.part !== core ? here : null) : bot.lost.get(key) ?? null;
    if (!block || block.type === "cockpit") continue;
    const d = distance(onPart(core, block.local), point);
    if (d >= radius) continue;
    if (!NEIGHBORS.some(([dx, dy, dz]) => bot.blocks.get(cellKey(x + dx, y + dy, z + dz))?.part === core)) continue;
    candidates.push({ block, d });
  }
  candidates.sort((a, b) => a.d - b.d);
  return candidates.find((c) => cellFree(sim, bot, onPart(core, c.block.local)))?.block ?? null;
}

/** Cube de la taille d'une case, un peu réduit (des voisins qui se touchent ne comptent pas). */
const CELL = new RAPIER.Cuboid(BLOCK_SIZE * 0.45, BLOCK_SIZE * 0.45, BLOCK_SIZE * 0.45);

/** La case du robot centrée en `at` est-elle libre de tout ce qui n'est pas lui (ni débris) ? */
function cellFree(sim: Simulation, bot: Bot, at: Vec3): boolean {
  const rot = bot.cockpit.part.rb.rotation();
  return !sim.world.intersectionWithShape(at, rot, CELL, undefined, undefined, undefined, undefined, (c) => {
    const owner = sim.colliders.get(c.handle);
    return owner?.kind !== "debris" && ownerBot(owner) !== bot;
  });
}

/**
 * Fait repousser un bloc perdu sur le morceau du cockpit, avec `hp` points : un bloc détruit
 * revient, ses organes (tourelle, moteur…) avec lui ; un bloc resté sur un morceau arraché le
 * quitte. Ses liaisons rompues se refont ; une roue qu'il portait sur le morceau arraché revient avec lui.
 */
export function rebuildBlock(sim: Simulation, block: Block, hp: number): void {
  const bot = block.bot;
  const core = bot.cockpit.part;
  if (block.alive) {
    // Le morceau arraché qui le portait se sépare, ou disparaît s'il n'en reste rien
    const from = block.part;
    const motion = capturePartMotion(from);
    from.blocks.delete(block);
    from.dirty = true;
    from.links = null;
    splitPart(sim, from, motion);
  } else {
    bot.lost.delete(block.key);
    block.alive = true;
    block.burn = 0;
    bot.blocks.set(block.key, block);
  }
  block.hp = Math.max(1, Math.min(BLOCK_TYPES[block.type].hp, hp));
  for (const key of [...bot.cuts]) if (key.split("|").includes(block.key)) bot.cuts.delete(key);
  block.part = core;
  core.blocks.add(block);
  core.dirty = true;
  core.links = null;
  sim.emit({ type: "blockRebuilt", block });
  refreshWheels(sim, bot);
  rebuildDirtyParts(sim, bot);
}

/** Ce qu'il manque à un robot pour être remis à neuf : les points perdus par ses blocs (détruits compris) et ses roues montées. */
export function repairNeed(bot: Bot): number {
  let need = 0;
  for (const b of bot.blocks.values()) need += BLOCK_TYPES[b.type].hp - b.hp;
  for (const b of bot.lost.values()) need += BLOCK_TYPES[b.type].hp;
  for (const w of bot.wheels) if (w.part) need += wheelDef(w.type).hp - w.hp;
  return need;
}

/** Ses blocs abîmés, les plus abîmés d'abord (le plus de points à regagner). */
export function damagedBlocks(bot: Bot): Block[] {
  const missing = (b: Block): number => BLOCK_TYPES[b.type].hp - b.hp;
  return [...bot.blocks.values()].filter((b) => missing(b) > 0).sort((a, b) => missing(b) - missing(a));
}

export function updateRepairs(sim: Simulation): void {
  if (Math.floor(sim.time / TICK) === Math.floor((sim.time - STEP) / TICK)) return;
  for (const bot of sim.bots) {
    const ck = bot.cockpit;
    if (!ck.alive || isStunned(sim, bot)) continue;
    for (const module of ck.part.blocks) {
      const spec = blockDef(module.type).repair;
      if (!spec || sim.time - bot.lastHit < spec.delay) continue;
      const center = blockWorldPos(module);
      const damaged: Damaged[] = [];
      for (const b of bot.blocks.values()) {
        const max = BLOCK_TYPES[b.type].hp;
        if (b.hp < max && distance(blockWorldPos(b), center) <= spec.radius) damaged.push({ block: b, ratio: b.hp / max });
      }
      for (const w of bot.wheels) {
        const max = wheelDef(w.type).hp;
        if (w.part && w.hp < max && distance(w.rb.translation(), center) <= spec.radius) damaged.push({ wheel: w, ratio: w.hp / max });
      }
      // Les plus abîmés d'abord, jusqu'à épuiser la réparation de cette tranche
      damaged.sort((a, b) => a.ratio - b.ratio);
      let budget = spec.rate * TICK;
      for (const d of damaged) {
        if (budget <= 0) break;
        if ("block" in d) {
          const max = BLOCK_TYPES[d.block.type].hp;
          const gain = Math.min(budget, max - d.block.hp);
          d.block.hp += gain;
          budget -= gain;
          sim.emit({ type: "blockRepaired", block: d.block });
        } else {
          const max = wheelDef(d.wheel.type).hp;
          const gain = Math.min(budget, max - d.wheel.hp);
          d.wheel.hp += gain;
          budget -= gain;
        }
      }
      // Et il fait repousser ses blocs perdus autour de lui, un à la fois (ils se réparent ensuite)
      if (sim.time >= bot.rebuildAt) {
        const lost = regrowable(sim, bot, center, spec.radius);
        if (lost) {
          rebuildBlock(sim, lost, BLOCK_TYPES[lost.type].hp * REBUILD_SHARE);
          bot.rebuildAt = sim.time + REBUILD_GAP;
        }
      }
    }
  }
}
