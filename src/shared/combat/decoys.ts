import { blockDef } from "../catalog/blocks";
import { weaponDef } from "../catalog/weapons";
import { STEP } from "../config";
import { rand } from "../math/scalar";
import { add, dot, len, norm, qrot, scale, sub, vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import type { Bot, Projectile } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { isStunned } from "./emp";
import { areEnemies, spawnProjectile } from "./projectiles";

/*
 * Leurres. Un lance-leurres (bloc à `flares`) éjecte, sur ordre du joueur (touche F) ou quand
 * l'IA voit un missile arriver sur elle, une salve de leurres (l'arme `flare`) : ils brûlent en
 * retombant lentement. Un missile ennemi guidé (tête chercheuse ou téléguidé, pas une ogive
 * pilotée) qui voit un leurre devant lui peut le prendre pour sa cible : il le suit, éclate sur
 * lui, ou file droit, perdu, quand il s'éteint (voir `steer`, combat/projectiles.ts).
 */

/** Intervalle minimal entre deux salves (s). */
const FLARE_GAP = 1.5;
/** Part de la vitesse du robot que gardent ses leurres : ils restent derrière un avion. */
const FLARE_INHERIT = 0.35;
/** Les leurres partent un peu vers l'arrière du robot (pente de leur direction). */
const FLARE_BACK = 0.4;
/** Un missile voit un leurre à moins de DECOY_RANGE m, dans un cône de DECOY_CONE rad autour de sa course. */
const DECOY_RANGE = 40;
const DECOY_CONE = 0.9;
/**
 * Chance qu'une salve de leurres détourne un missile qui la voit : tête chercheuse, téléguidé.
 * Chaque leurre de la salve tente sa chance à part : la sienne est telle que la salve entière ait celle-ci.
 */
const SALVO_CHANCE = { homing: 0.65, command: 0.4 };
const FLARES_PER_SALVO = weaponDef("flare").projectile.pellets?.count ?? 1;
const DECOY_CHANCE = {
  homing: 1 - Math.pow(1 - SALVO_CHANCE.homing, 1 / FLARES_PER_SALVO),
  command: 1 - Math.pow(1 - SALVO_CHANCE.command, 1 / FLARES_PER_SALVO),
};
/** Un missile détourné éclate à moins de cette distance de son leurre (m). */
export const DECOY_BURST = 1.5;
/** Un missile qui file vers un robot : dans ce cône autour de sa course (cosinus). */
const HEADING_COS = 0.85;
/** L'IA lance ses leurres quand un missile ennemi arrive à moins de cette distance (m). */
export const FLARE_ALERT = 35;

/** Salves que peuvent tenir ses lance-leurres encore reliés au cockpit. */
export function flareCapacity(bot: Bot): number {
  let capacity = 0;
  for (const b of bot.flareLaunchers) if (b.alive && b.part === bot.cockpit.part) capacity += blockDef(b.type).flares?.charges ?? 0;
  return capacity;
}

/**
 * Lance une salve de leurres de chacun de ses lance-leurres encore reliés au cockpit, vers le haut
 * de leur bloc, un peu vers l'arrière (s'il lui en reste une, et que la dernière est partie depuis
 * FLARE_GAP s). Sous un avion, le lance-leurres est retourné : ils partent vers le bas, et le
 * laissent derrière eux. Renvoie vrai s'il en a lancé.
 */
export function launchFlares(sim: Simulation, bot: Bot): boolean {
  const flares = bot.flares;
  if (flares.charges < 1 || sim.time < flares.readyAt || !bot.cockpit.alive || isStunned(sim, bot)) return false;
  const launchers = bot.flareLaunchers.filter((b) => b.alive && b.part === bot.cockpit.part);
  if (!launchers.length) return false;
  flares.charges--;
  flares.readyAt = sim.time + FLARE_GAP;
  for (const b of launchers) {
    const rb = b.part.rb;
    const q = rb.rotation();
    const up = qrot(q, qrot(b.rot, vec3(0, 1, 0)));
    const back = qrot(q, vec3(0, 0, -1));
    const origin = add(blockWorldPos(b), scale(up, 0.4));
    spawnProjectile(sim, "flare", origin, norm(add(up, scale(back, FLARE_BACK))), { shooter: bot, inherit: scale(rb.linvel(), FLARE_INHERIT) });
  }
  return true;
}

/** Les lance-leurres regagnent leurs salves, une à une. */
export function updateFlares(sim: Simulation): void {
  for (const bot of sim.bots) {
    if (!bot.flareLaunchers.length || !bot.cockpit.alive) continue;
    const capacity = flareCapacity(bot);
    const flares = bot.flares;
    flares.charges = Math.min(flares.charges, capacity);
    if (flares.charges >= capacity) {
      flares.restock = 0;
      continue;
    }
    const reload = blockDef(bot.flareLaunchers[0].type).flares?.reload ?? 12;
    flares.restock += STEP;
    if (flares.restock >= reload) {
      flares.restock = 0;
      flares.charges++;
    }
  }
}

/**
 * Leurres : un missile guidé qui n'est pas encore détourné regarde les leurres ennemis devant lui ;
 * chacun ne le tente qu'une fois (`Projectile.tried`), avec une chance selon son guidage.
 */
export function seduce(sim: Simulation, p: Projectile): void {
  const spec = weaponDef(p.weapon).projectile;
  const guidance = spec.guidance;
  // Les nanites, qui vont vers un allié, ne se laissent pas prendre
  if (!guidance || guidance.mode === "piloted" || spec.repair || p.decoy || p.lost) return;
  const speed = len(p.vel);
  if (speed < 1) return;
  const course = scale(p.vel, 1 / speed);
  for (const f of sim.projectiles) {
    if (f.done || !weaponDef(f.weapon).projectile.decoy || !f.shooter || !areEnemies(p.shooter, f.shooter) || p.tried.includes(f.id)) continue;
    const to = sub(f.pos, p.pos);
    const d = len(to);
    if (d > DECOY_RANGE || d < 1e-3 || Math.acos(Math.max(-1, Math.min(1, dot(course, scale(to, 1 / d))))) > DECOY_CONE) continue;
    p.tried.push(f.id);
    if (rand(0, 1) < DECOY_CHANCE[guidance.mode]) {
      p.decoy = f;
      return;
    }
  }
}

/**
 * Le missile ennemi guidé (ou la bombe, ou l'ogive) le plus proche qui file vers ce robot à moins
 * de `range` m, s'il y en a un : un missile qu'un leurre a détourné ne compte plus.
 */
export function incomingMissile(projectiles: Iterable<Projectile>, bot: Bot, range: number): Projectile | null {
  let best: Projectile | null = null;
  let bestDistance = range;
  for (const p of projectiles) {
    const spec = weaponDef(p.weapon).projectile;
    if (!spec.hull || spec.mine || p.decoy || p.lost || p.landed || !areEnemies(p.shooter, bot)) continue;
    const to = sub(bot.lastPos, p.pos);
    const d = len(to);
    if (d >= bestDistance) continue;
    const speed = len(p.vel);
    if (p.homing !== bot && (speed < 1 || dot(scale(p.vel, 1 / speed), norm(to)) < HEADING_COS)) continue;
    best = p;
    bestDistance = d;
  }
  return best;
}

/** L'IA lance ses leurres quand un missile ennemi guidé arrive sur elle. */
export function thinkFlares(sim: Simulation, bot: Bot): void {
  if (!bot.flareLaunchers.length || bot.flares.charges < 1 || sim.time < bot.flares.readyAt) return;
  const threat = incomingMissile(sim.projectiles, bot, FLARE_ALERT);
  if (threat && weaponDef(threat.weapon).projectile.guidance) launchFlares(sim, bot);
}
