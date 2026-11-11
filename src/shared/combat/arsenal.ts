import { RESUME_HEAT, type Weapon } from "../catalog/weapons";
import { clamp } from "../math/scalar";
import type { ArmState } from "../sim/entities";

/*
 * Ressources d'une arme : sa cadence (`cooldown`), sa chaleur pour les armes automatiques, ses
 * munitions pour les autres. Une arme en surchauffe se tait jusqu'à ce qu'elle ait refroidi ; un
 * chargeur vide se recharge un coup à la fois. Le même état sert aux tourelles et au joueur.
 */

/** État d'une arme prête à tirer, chargeur plein. */
export function newArmState(weapon: Weapon): ArmState {
  return { cooldown: 0, heat: 0, overheated: false, ammo: weapon.ammo?.capacity ?? Infinity, restock: 0 };
}

/** Le temps passe : cadence, refroidissement, rechargement. */
export function tickArm(state: ArmState, weapon: Weapon, dt: number): void {
  state.cooldown = Math.max(0, state.cooldown - dt);
  if (weapon.heat) {
    state.heat = Math.max(0, state.heat - weapon.heat.cooling * dt);
    if (state.overheated && state.heat <= RESUME_HEAT) state.overheated = false;
  }
  if (weapon.ammo && state.ammo < weapon.ammo.capacity) {
    state.restock += dt;
    if (state.restock >= weapon.ammo.reload) {
      state.restock = 0;
      state.ammo++;
    }
  }
}

/**
 * Armes identiques d'un robot : elles tirent à tour de rôle, sur un rythme commun (voir
 * `fireInTurn`, combat/turrets.ts). n armes tirent `stackRate(n)` fois plus vite qu'une seule, avec
 * un rendement décroissant : chaque arme de plus ajoute STACK_FALLOFF fois ce qu'ajoutait la
 * précédente (2 armes : ×1,8 ; 4 : ×2,95 ; 8 : ×4,16 ; jamais plus de ×5). Chacune tire donc moins
 * souvent que seule : ses munitions et sa chaleur durent d'autant.
 */
export const STACK_FALLOFF = 0.8;
export const stackRate = (count: number): number => (1 - STACK_FALLOFF ** count) / (1 - STACK_FALLOFF);

/**
 * L'arme est-elle prête ? Sa cadence se décompte au pas fixe : 0,05 − 3 × 1/60 laisse un reste
 * infime au lieu de zéro ; sans tolérance, l'arme attendait un pas de plus (le laser tirait
 * 8,6 fois par seconde au lieu de 10).
 */
export const canFire = (state: ArmState): boolean => state.cooldown <= 1e-9 && !state.overheated && state.ammo >= 1;

/** Un tir : l'arme attend sa cadence, chauffe, et consomme une munition. */
export function useArm(state: ArmState, weapon: Weapon): void {
  state.cooldown = weapon.cooldown;
  if (weapon.heat) {
    state.heat = Math.min(1, state.heat + weapon.heat.perShot);
    if (state.heat >= 1) state.overheated = true;
  }
  if (weapon.ammo) state.ammo--;
}

/**
 * Ce qu'attend une arme pour tirer : sa cadence, un coup qui se recharge, de refroidir, de l'énergie ;
 * ou plus rien à tirer ; ou, une arme de contact, que son rotor monte en régime (`spin`, combat/melee.ts).
 */
export type WaitCause = "cycle" | "reload" | "overheat" | "energy" | "spent" | "spin";

/**
 * Où en est une arme (toutes ses tourelles identiques ensemble), pour la jauge du réticule : son
 * avancement vers le prochain tir et ce qu'elle attend, son chargeur, sa chaleur.
 */
export interface Readiness {
  /** Avancement vers le prochain tir, de 0 à 1 (1 : prête). */
  progress: number;
  /** Ce qu'elle attend (null : elle est prête). */
  cause: WaitCause | null;
  /** Durée totale de l'attente en cours (s) : la cadence d'une arme automatique est trop brève pour s'afficher. */
  span: number;
  /** Chargeur de toutes ses tourelles : coups prêts, capacité, part du coup suivant déjà rechargée (0 à 1). */
  magazine: { rounds: number; capacity: number; next: number } | null;
  /** Chaleur de la tourelle la moins chaude (0 à 1), en surchauffe ou non. */
  heat: { level: number; overheated: boolean } | null;
}

interface Wait {
  wait: number;
  span: number;
  cause: WaitCause;
}

/** Ce qu'attend une tourelle seule : le plus long de sa cadence, de son rechargement (chargeur vide), de son refroidissement. */
function armWait(arm: ArmState, weapon: Weapon): Wait {
  let worst: Wait = { wait: arm.cooldown, span: weapon.cooldown, cause: "cycle" };
  if (weapon.ammo && arm.ammo < 1) {
    // Un coup unique qui ne se recharge pas (l'ogive) : plus rien à tirer de cette vie
    const reload = Number.isFinite(weapon.ammo.reload)
      ? { wait: weapon.ammo.reload - arm.restock, span: weapon.ammo.reload, cause: "reload" as const }
      : { wait: Infinity, span: Infinity, cause: "spent" as const };
    if (reload.wait > worst.wait) worst = reload;
  }
  if (weapon.heat && arm.overheated) {
    const cool = { wait: (arm.heat - RESUME_HEAT) / weapon.heat.cooling, span: (1 - RESUME_HEAT) / weapon.heat.cooling, cause: "overheat" as const };
    if (cool.wait > worst.wait) worst = cool;
  }
  return worst;
}

const progressOf = (w: Wait): number => (w.wait <= 1e-9 ? 1 : Number.isFinite(w.span) ? clamp(1 - w.wait / w.span, 0, 1) : 0);

/**
 * Où en est une arme, d'après l'état de ses tourelles (`arms`, toutes de la même arme) et
 * l'énergie du robot. Les tourelles identiques tirent à tour de rôle, sur un rythme commun (voir
 * `fireInTurn`) : le prochain tir part un intervalle `cooldown / stackRate(n)` après le dernier,
 * dont on retrouve l'heure par la tourelle qui a tiré le plus récemment (son délai restant est le
 * plus long). Il faut aussi qu'une tourelle soit prête (munitions, chaleur), et, pour une arme
 * électrique, assez d'énergie. Ne lit que l'état des armes : marche aussi sur la réplique réseau.
 */
export function readiness(arms: readonly ArmState[], weapon: Weapon, energy = Infinity): Readiness {
  const interval = weapon.cooldown / stackRate(arms.length);
  const latest = Math.max(0, ...arms.map((a) => a.cooldown));
  let wait: Wait = { wait: Math.max(0, latest - (weapon.cooldown - interval)), span: interval, cause: "cycle" };
  // La tourelle la plus tôt prête
  let soonest: Wait | null = null;
  for (const arm of arms) {
    const w = armWait(arm, weapon);
    if (!soonest || w.wait < soonest.wait) soonest = w;
  }
  if (soonest && soonest.wait > wait.wait) wait = soonest;
  let progress = progressOf(wait);
  let cause: WaitCause | null = progress < 1 ? wait.cause : null;
  // Arme électrique : les batteries lui tiennent lieu de chargeur
  if (weapon.power && energy < weapon.power && energy / weapon.power < progress) {
    progress = Math.max(0, energy / weapon.power);
    cause = "energy";
  }
  let magazine: Readiness["magazine"] = null;
  if (weapon.ammo) {
    const { capacity, reload } = weapon.ammo;
    let rounds = 0;
    let next = 0;
    for (const a of arms) {
      rounds += Math.floor(a.ammo);
      if (a.ammo < capacity && Number.isFinite(reload)) next = Math.max(next, clamp(a.restock / reload, 0, 1));
    }
    magazine = { rounds, capacity: capacity * arms.length, next };
  }
  let heat: Readiness["heat"] = null;
  if (weapon.heat && arms.length > 0) {
    const coolest = arms.reduce((best, a) => (a.heat < best.heat ? a : best));
    heat = { level: coolest.heat, overheated: arms.every((a) => a.overheated) };
  }
  return { progress, cause, span: wait.span, magazine, heat };
}
