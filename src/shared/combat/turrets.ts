import { blockDef, type TurretSpec } from "../catalog/blocks";
import { weaponDef, type WeaponId } from "../catalog/weapons";
import { BLOCK_SIZE, STEP } from "../config";
import { cellKey } from "../design/robotDesign";
import { clamp } from "../math/scalar";
import { add, cross, dot, qmul, qrot, qrotInv, scale, sub, vec3, type Quat, type Vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import type { Bot, Turret } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { canFire, stackRate, useArm } from "./arsenal";
import { spawnProjectile } from "./projectiles";

export const turretSpec = (t: Turret): TurretSpec => blockDef(t.block.type).turret!;

/** Tourelles encore reliées au cockpit : les seules alimentées. */
export function liveTurrets(bot: Bot): Turret[] {
  const ck = bot.cockpit;
  if (!ck.alive) return [];
  return bot.turrets.filter((t) => t.block.alive && t.block.part === ck.part);
}

/** Direction du canon dans le repère du bloc, d'après le lacet et le site. */
const barrelLocal = (yaw: number, pitch: number): Vec3 =>
  vec3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));

/** Direction du tir dans le repère du bloc : celle du canon, ou la sortie d'une tourelle fixe (arrière ou dessous). */
const outletLocal = (spec: TurretSpec, t: Turret): Vec3 =>
  spec.fixed === "back" ? vec3(0, 0, -1) : spec.fixed === "down" ? vec3(0, -1, 0) : barrelLocal(t.yaw, t.pitch);

export interface TurretFrame {
  /** Rotation du bloc dans le monde. */
  base: Quat;
  /** Direction du canon (monde, unitaire) et bouche du canon. */
  dir: Vec3;
  muzzle: Vec3;
}

/** Repère actuel d'une tourelle. Une tourelle fixe vise l'arrière (poseur de mines) ou le dessous (soute à bombes) de son bloc. */
export function turretFrame(t: Turret): TurretFrame {
  const spec = turretSpec(t);
  const base = qmul(t.block.part.rb.rotation(), t.block.rot);
  const pivot = add(blockWorldPos(t.block), qrot(base, vec3(0, spec.height, 0)));
  const dir = qrot(base, outletLocal(spec, t));
  return { base, dir, muzzle: add(pivot, scale(dir, spec.barrel)) };
}

/** Pas du suivi de la ligne de tir dans la grille du robot (m). */
const LINE_STEP = BLOCK_SIZE / 5;

/** Case de la grille du robot qui contient ce point (repère local, m). */
const cellOf = (p: Vec3): string => cellKey(Math.round(p.x / BLOCK_SIZE), Math.round(p.y / BLOCK_SIZE), Math.round(p.z / BLOCK_SIZE));

/** Axe de la tête d'une tourelle, dans le repère du robot (m). */
const pivotLocal = (t: Turret): Vec3 => add(t.block.local, qrot(t.block.rot, vec3(0, turretSpec(t).height, 0)));

/**
 * La ligne de tir traverse-t-elle son propre robot ? Ses projectiles l'ignorent : sans ce
 * contrôle, une arme enfouie dans des blocs tirerait à travers lui. On suit la ligne depuis l'axe
 * de la tête, dans le repère du robot (commun à tous ses morceaux), case par case, jusqu'à sortir
 * de son encombrement : un bloc de son morceau (autre que celui de la tourelle), ou la tête d'une
 * autre de ses tourelles, masque le tir.
 */
export function lineOfFireBlocked(t: Turret): boolean {
  const spec = turretSpec(t);
  const block = t.block;
  const bot = block.bot;
  const pivot = pivotLocal(t);
  const dir = qrot(block.rot, outletLocal(spec, t));
  const heads = new Set<string>();
  for (const other of bot.turrets) {
    if (other !== t && other.block.alive && other.block.part === block.part) heads.add(cellOf(pivotLocal(other)));
  }
  const reach = 2 * bot.radius + Math.max(bot.top, 1) + 1;
  for (let d = LINE_STEP / 2; d <= reach; d += LINE_STEP) {
    const key = cellOf(add(pivot, scale(dir, d)));
    if (key === block.key) continue;
    const hit = bot.blocks.get(key);
    if ((hit && hit.part === block.part) || heads.has(key)) return true;
  }
  return false;
}

/** Lacet et site (dans son débattement) que doit prendre la tête pour viser la direction monde `want`. */
function aimAngles(t: Turret, base: Quat, want: Vec3): { yaw: number; pitch: number } {
  const spec = turretSpec(t);
  const local = qrotInv(base, want);
  return {
    yaw: Math.atan2(local.x, local.z),
    pitch: clamp(Math.atan2(local.y, Math.hypot(local.x, local.z)), spec.minPitch, spec.maxPitch),
  };
}

/** Direction la plus proche de `want` que peut prendre le canon (son site est borné par son débattement). */
export function reachableDirection(t: Turret, want: Vec3): Vec3 {
  if (turretSpec(t).fixed) return turretFrame(t).dir;
  const { base } = turretFrame(t);
  const { yaw, pitch } = aimAngles(t, base, want);
  return qrot(base, barrelLocal(yaw, pitch));
}

/**
 * Tourne la tête vers la direction monde `want`, à ses vitesses de rotation et dans son
 * débattement en site. Renvoie l'angle qui reste entre le canon et `want` (rad) ; `reachable` :
 * entre le canon et la direction la plus proche qu'il peut prendre (une arme pointée par le joueur
 * tire à sa butée quand il vise plus haut ou plus bas qu'elle ne peut).
 */
export function aimTurret(t: Turret, want: Vec3, reachable = false): number {
  if (turretSpec(t).fixed) return 0;
  const { base } = turretFrame(t);
  const wanted = aimAngles(t, base, want);
  turnHead(t, wanted.yaw, wanted.pitch);
  const now = qrot(base, barrelLocal(t.yaw, t.pitch));
  const goal = reachable ? qrot(base, barrelLocal(wanted.yaw, wanted.pitch)) : want;
  return Math.acos(clamp(dot(now, goal), -1, 1));
}

/** Ramène la tête à sa position de repos (canon droit devant, à l'horizontale de son bloc), à ses vitesses de rotation. */
export function restTurret(t: Turret): void {
  const spec = turretSpec(t);
  if (!spec.fixed) turnHead(t, 0, clamp(0, spec.minPitch, spec.maxPitch));
}

/** Un pas de rotation de la tête vers ce lacet (par le plus court) et ce site, à ses vitesses de rotation. */
function turnHead(t: Turret, yaw: number, pitch: number): void {
  const spec = turretSpec(t);
  const dyaw = Math.atan2(Math.sin(yaw - t.yaw), Math.cos(yaw - t.yaw));
  t.yaw += clamp(dyaw, -spec.yawRate * STEP, spec.yawRate * STEP);
  t.pitch += clamp(pitch - t.pitch, -spec.pitchRate * STEP, spec.pitchRate * STEP);
}

/** La tourelle peut tirer : cadence, chaleur et munitions, et assez d'énergie pour une arme électrique. */
export function turretReady(t: Turret): boolean {
  const power = weaponDef(t.weapon).power;
  return canFire(t.arm) && (!power || t.block.bot.energy >= power);
}

/** Tourelle prête à tirer à ce pas, qui attend son tour (voir `fireInTurn`), et comment elle tirerait. */
export interface ShotRequest {
  turret: Turret;
  homing: Bot | null;
  spread?: number;
}

/**
 * Tir à tour de rôle des armes identiques d'un robot (voir `stackRate`, combat/arsenal.ts) : parmi
 * les tourelles d'une même arme prêtes à tirer à ce pas, celle qui a tiré le moins récemment tire,
 * si le rythme commun de l'arme le permet (`Bot.nextShot`). Au plus un tir par arme et par pas.
 */
export function fireInTurn(sim: Simulation, bot: Bot, requests: readonly ShotRequest[]): void {
  const turn = new Map<WeaponId, ShotRequest>();
  for (const r of requests) {
    const best = turn.get(r.turret.weapon);
    if (!best || r.turret.firedAt < best.turret.firedAt) turn.set(r.turret.weapon, r);
  }
  for (const [weapon, r] of turn) {
    const next = bot.nextShot.get(weapon) ?? -Infinity;
    if (sim.time < next) continue;
    const count = liveTurrets(bot).filter((t) => t.weapon === weapon).length;
    // Le retard dû au pas fixe se reporte sur le tir suivant (d'un pas au plus) : le rythme moyen est tenu
    bot.nextShot.set(weapon, Math.max(next, sim.time - STEP) + weaponDef(weapon).cooldown / stackRate(count));
    r.turret.firedAt = sim.time;
    fireTurret(sim, r.turret, r.homing, r.spread);
  }
}

/** Vitesse du robot au point `muzzle` (celle que garde un projectile qui en part). */
export function muzzleVelocity(t: Turret, muzzle: Vec3): Vec3 {
  const rb = t.block.part.rb;
  return add(rb.linvel(), cross(rb.angvel(), sub(muzzle, rb.worldCom())));
}

/**
 * Tire : le projectile part de la bouche du canon avec la vitesse du robot en ce point, et le
 * recul pousse le robot à l'opposé. `homing` : cible d'un missile à tête chercheuse ; `spread` :
 * dispersion du tir (rad ; voir combat/accuracy.ts), par défaut celle de l'arme sans viseur.
 */
export function fireTurret(sim: Simulation, t: Turret, homing: Bot | null = null, spread?: number): void {
  const weapon = weaponDef(t.weapon);
  if (weapon.power) t.block.bot.energy = Math.max(0, t.block.bot.energy - weapon.power);
  const { dir, muzzle } = turretFrame(t);
  const rb = t.block.part.rb;
  const inherit = muzzleVelocity(t, muzzle);
  spawnProjectile(sim, t.weapon, muzzle, dir, { shooter: t.block.bot, commander: t, homing, inherit, spread });
  if (weapon.recoil) rb.applyImpulseAtPoint(scale(dir, -weapon.recoil), muzzle, true);
  useArm(t.arm, weapon);
}
