import RAPIER from "@dimforge/rapier3d-compat";
import { blockDef } from "../catalog/blocks";
import { isStunned } from "../combat/emp";
import { areEnemies } from "../combat/projectiles";
import { smokeBlocks } from "../combat/smoke";
import { SIGHT_RANGE, STEP } from "../config";
import { weaponDef } from "../catalog/weapons";
import { add, distance, len, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { Bot, Projectile, Team } from "./entities";
import type { Simulation } from "./simulation";
import type { World } from "./world";

/*
 * Détection : ce que chaque équipe sait de l'ennemi. Un robot ennemi est repéré s'il est à portée
 * de vue d'un robot de l'équipe, sans mur ni fumée entre eux, ou à portée de l'un de ses radars
 * (qui voient à travers). Un brouilleur réduit la portée des radars ennemis sur lui. Les tourelles
 * de l'IA ne choisissent que des cibles repérées ; plus tard, le serveur n'enverra à chaque joueur
 * que ce que son équipe a repéré.
 */

/** La détection est mise à jour par tranches de cette durée (s). */
const TICK = 0.25;
/** Un robot repère une mine ennemie à moins de cette distance (m), s'il la voit. */
const MINE_SPOT = 10;
const TEAMS: readonly Team[] = ["red", "blue"];

export function updateDetection(sim: Simulation): void {
  if (sim.detected.size && Math.floor(sim.time / TICK) === Math.floor((sim.time - STEP) / TICK)) return;
  for (const team of TEAMS) {
    const observers = sim.bots.filter((b) => b.team === team && b.cockpit.alive);
    const sensors = sim.projectiles.filter((p) => p.landed && p.shooter?.team === team && sensorRange(p) > 0);
    const seen = new Set<Bot>();
    for (const enemy of sim.bots) {
      if (enemy.team === team || !enemy.cockpit.alive) continue;
      if (observers.some((o) => spots(sim, o, enemy)) || sensors.some((p) => distance(p.pos, enemy.lastPos) < sensorRange(p))) seen.add(enemy);
    }
    sim.detected.set(team, seen);
    spotMines(sim, team, observers);
  }
}

/** Portée d'un capteur posé et armé (voir `MineSpec.sense`) : il repère à travers tout ; 0 pour une autre mine. */
function sensorRange(p: Projectile): number {
  const mine = weaponDef(p.weapon).projectile.mine;
  return mine?.sense && p.age >= mine.armDelay ? mine.sense : 0;
}

/** Les robots de `team` repèrent les mines ennemies posées qu'ils voient à moins de MINE_SPOT m (leur IA les évitera). */
function spotMines(sim: Simulation, team: Team, observers: readonly Bot[]): void {
  for (const p of sim.projectiles) {
    if (!p.landed || p.spotted.includes(team) || p.shooter?.team === team || !weaponDef(p.weapon).projectile.mine) continue;
    const top = add(p.pos, vec3(0, 0.3, 0));
    if (observers.some((o) => distance(o.lastPos, p.pos) < MINE_SPOT && inSight(sim, o.lastPos, top))) p.spotted.push(team);
  }
}

/** L'équipe `team` a-t-elle repéré ce robot ? (Oui tant que la détection n'a pas tourné.) */
export function isDetected(sim: Pick<World, "detected">, team: Team, bot: Bot): boolean {
  return sim.detected.get(team)?.has(bot) ?? true;
}

/** `observer` repère-t-il `enemy`, de ses yeux ou de son radar ? */
function spots(sim: Simulation, observer: Bot, enemy: Bot): boolean {
  if (!areEnemies(observer, enemy)) return false;
  const eye = observer.lastPos;
  const d = distance(eye, enemy.lastPos);
  const radar = radarRange(sim, observer);
  if (radar > 0 && d <= Math.min(radar, jammerRange(enemy))) return true;
  return d <= SIGHT_RANGE && inSight(sim, eye, enemy.lastPos);
}

/** Portée du meilleur radar alimenté d'un robot (0 s'il n'en a pas, ou s'il est paralysé). */
function radarRange(sim: Simulation, bot: Bot): number {
  if (isStunned(sim, bot)) return 0;
  let range = 0;
  for (const b of bot.cockpit.part.blocks) range = Math.max(range, blockDef(b.type).radar?.range ?? 0);
  return range;
}

/** Portée au-delà de laquelle les radars ennemis ne repèrent plus ce robot (brouilleur alimenté). */
function jammerRange(bot: Bot): number {
  let range = Infinity;
  for (const b of bot.cockpit.part.blocks) range = Math.min(range, blockDef(b.type).jammer?.range ?? Infinity);
  return range;
}

/** Ligne de vue : ni décor ni accessoire (les robots ne cachent pas) entre les deux, ni fumée. */
function inSight(sim: Simulation, from: Vec3, to: Vec3): boolean {
  if (smokeBlocks(sim, from, to)) return false;
  const seg = sub(to, from);
  const length = len(seg);
  if (length < 1e-3) return true;
  const hit = sim.world.castRay(
    new RAPIER.Ray(from, scale(seg, 1 / length)), length, true, undefined, undefined, undefined, undefined,
    (c) => {
      const owner = sim.colliders.get(c.handle);
      return !owner || owner.kind === "prop";
    },
  );
  return !hit;
}
