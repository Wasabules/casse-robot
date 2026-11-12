import { weaponDef } from "../catalog/weapons";
import { dot, norm, sub, type Vec3 } from "../math/vec";
import { isDetected } from "../sim/detection";
import type { Bot, Turret } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { areEnemies } from "./projectiles";
import { sightBlocked } from "./sight";
import { dcos } from "../math/det";

/*
 * Verrouillage (arme à `lock`) : il faut garder un ennemi dans le viseur un moment avant de
 * pouvoir tirer ; les missiles poursuivent ensuite la cible verrouillée. Joueur et IA suivent la
 * même règle : seule change la direction dans laquelle vise la tourelle.
 */

/** Une fois la cible prise, elle reste tenue dans un cône un peu plus large : elle peut bouger dans le viseur. */
const HOLD_CONE = 1.8;
/**
 * Verrou acquis : il tient tant que la cible reste à moins de cet angle de la visée (rad, ~43°), pour
 * tirer en cloche (viser plus haut, ou à côté d'un obstacle) sans le perdre.
 */
const LOCKED_HOLD = 0.75;
/** Cible sortie du cône : le verrou retombe à cette vitesse (secondes de verrouillage perdues par seconde). */
const DECAY = 2;
/**
 * Cible cachée par le décor, un accessoire (mur, arbre) ou la fumée : le verrou ne progresse plus, et
 * il est perdu au bout de ce temps (s). Un poteau qui passe ne le fait pas lâcher, et une cible qui
 * vient de passer derrière une colline reste verrouillée le temps de tirer en cloche.
 */
export const LOCK_GRACE = 1;
/** Peut-on verrouiller ce robot ? Ennemi vivant, repéré par son équipe, à portée de l'arme. */
function lockable(sim: Simulation, t: Turret, target: Bot, from: Vec3): boolean {
  const bot = t.block.bot;
  if (!target.cockpit.alive || !areEnemies(bot, target) || !isDetected(sim, bot.team, target)) return false;
  const com = target.cockpit.part.rb.worldCom();
  return Math.hypot(com.x - from.x, com.y - from.y, com.z - from.z) <= weaponDef(t.weapon).range;
}

/** Cosinus de l'angle entre `dir` et la direction de `from` vers le cockpit de `target`. */
const cosTo = (from: Vec3, dir: Vec3, target: Bot): number => dot(norm(sub(target.cockpit.part.rb.worldCom(), from)), dir);

/**
 * Un pas du verrouillage de la tourelle `t`, qui vise dans la direction unitaire `dir` depuis
 * `from`. La cible déjà prise, tant qu'elle reste dans le cône et en vue, fait progresser le
 * verrou ; cachée par le décor ou la fumée, il ne progresse plus, et il est perdu au bout de
 * `LOCK_GRACE` ; sortie du cône, il retombe, puis passe à l'ennemi en vue le plus proche de la
 * visée, dans le cône de l'arme.
 */
export function updateLock(sim: Simulation, t: Turret, from: Vec3, dir: Vec3, dt: number): void {
  const lock = weaponDef(t.weapon).lock;
  if (!lock) return;
  const held = t.lockOn;
  const hold = isLocked(t) ? LOCKED_HOLD : lock.cone * HOLD_CONE;
  if (held && lockable(sim, t, held, from) && cosTo(from, dir, held) > dcos(hold)) {
    if (!sightBlocked(sim, from, held)) {
      t.lockHidden = 0;
      t.lockTime = Math.min(lock.time, t.lockTime + dt);
      return;
    }
    t.lockHidden += dt;
    if (t.lockHidden < LOCK_GRACE) return;
    // Cachée trop longtemps : la cible est perdue, on en cherche une autre en vue
    releaseLock(t);
  } else {
    t.lockTime = Math.max(0, t.lockTime - DECAY * dt);
    if (t.lockTime > 0) return;
  }
  // Les ennemis dans le cône, du plus proche de la visée au plus loin : le premier en vue
  const minCos = dcos(lock.cone);
  const candidates: { bot: Bot; cos: number }[] = [];
  for (const bot of sim.bots) {
    if (!lockable(sim, t, bot, from)) continue;
    const c = cosTo(from, dir, bot);
    if (c > minCos) candidates.push({ bot, cos: c });
  }
  candidates.sort((a, b) => b.cos - a.cos);
  t.lockOn = candidates.find((c) => !sightBlocked(sim, from, c.bot))?.bot ?? null;
  t.lockHidden = 0;
}

/** Part du verrouillage acquise (0 à 1) ; 1 : la tourelle peut tirer. */
export function lockProgress(t: Turret): number {
  const lock = weaponDef(t.weapon).lock;
  return lock && t.lockOn ? Math.min(1, t.lockTime / lock.time) : 0;
}

/** La tourelle a verrouillé sa cible : elle peut tirer, et ses missiles la poursuivront. */
export const isLocked = (t: Turret): boolean => t.lockOn !== null && lockProgress(t) >= 1;

/** Verrou à montrer au pilote : la première tourelle de son robot qui verrouille un ennemi encore en vie. */
export function pilotLock(bot: Bot): Turret | null {
  return bot.turrets.find((t) => t.block.alive && t.lockOn?.cockpit.alive) ?? null;
}

/** Oublie le verrou (la tourelle ne vise plus, ou change d'arme). */
export function releaseLock(t: Turret): void {
  t.lockOn = null;
  t.lockTime = 0;
  t.lockHidden = 0;
}
