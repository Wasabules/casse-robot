
import { nearestPassable } from "../arena/navgrid";
import { groundLevel } from "../arena/layout";
import { blockDef, BLOCK_TYPES } from "../catalog/blocks";
import { weaponDef } from "../catalog/weapons";
import { areEnemies } from "../combat/projectiles";
import { repairNeed } from "../combat/repair";
import { liveTurrets } from "../combat/turrets";
import { meleeDef } from "../catalog/melee";
import { chargePoint, meleePrimed, meleeSuits, offensiveMelee } from "./brawl";
import { clamp } from "../math/scalar";
import { add, distance, flatDistance, len, norm, qrot, scale, vec3, type Vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import { isDetected } from "../sim/detection";
import type { Bot, TacticsState, Turret } from "../sim/entities";
import type { ZoneState } from "../sim/match";
import type { Simulation } from "../sim/simulation";
import { atLevel, obstacles } from "./navigation";
import { suits } from "./gunner";

/*
 * Tactique de l'IA en combat : où aller. Le robot choisit un adversaire (celui que visent ses
 * tourelles, sinon l'ennemi repéré le plus proche contre lequel une de ses armes porte), puis :
 * - il l'engage à sa portée préférée, qui dépend de ses armes (`Weapon.engage` : le lance-flammes
 *   au contact, le sniper de loin) ; trop loin il approche, trop près il recule, à bonne distance
 *   il tourne autour de lui, ce qui le rend plus dur à toucher (voir l'erreur de visée, gunner.ts) ;
 * - un robot fait pour charger, armé pour le contact, le percute ;
 * - il se met à couvert derrière un pilier ou un muret quand il a besoin d'un répit : chargeurs
 *   vides, ou module de réparation qui a de quoi faire (il ne répare qu'à l'abri des tirs) ;
 * - en capture de zones, tant qu'une zone reste à prendre, il y va et y reste plutôt que de
 *   poursuivre l'adversaire (ses tourelles tirent quand même) ;
 * - sans adversaire, il patrouille (en capture de zones, vers une zone).
 * Les avions n'en ont pas : ils tournent sur leur circuit (ai/pilot.ts).
 */

/** Intervalle entre deux révisions du plan (s). */
const PLAN_PERIOD = 0.4;
/** Distance maximale à laquelle il cherche un adversaire (m). */
const FOE_SEARCH = 100;
/** Temps pendant lequel il garde un adversaire qu'il ne voit plus (caché derrière un pilier) (s). */
const FOE_MEMORY = 4;
/** Distance devant lui du point vers lequel il roule en combat (m) : assez loin pour braquer en douceur. */
const LEAD = 12;
/** Écart à la portée préférée (m) pour lequel il s'en rapproche ou s'en écarte autant qu'il tourne autour. */
const RANGE_SOFT = 6;
/** La portée préférée ne dépasse pas cette part de la portée de l'arme la plus courte. */
const RANGE_MARGIN = 0.85;
/** Portée préférée sous laquelle un robot fait pour charger percute son adversaire (m). */
const RAM_RANGE = 10;
/** Distance à laquelle un robot à toupie tourne autour de sa cible en attendant le plein régime (m). */
const STANDOFF = 7;
/** Points de structure à réparer (dans le rayon de ses modules) qui valent qu'il se mette à couvert, et en deçà desquels il en ressort. */
const REPAIR_WORTH = 150;
const REPAIR_DONE = 20;
/** Durée maximale à couvert (s), puis temps pendant lequel il ne s'y remet pas (s). */
const MAX_COVER = 14;
const COVER_REST = 10;
/** Distance maximale d'un abri (m) ; écart entre l'abri et le robot caché derrière (m). */
const COVER_SEARCH = 30;
const COVER_GAP = 0.8;
/** Sans abri à portée, il recule d'autant (m). */
const RETREAT_DISTANCE = 20;
/** Capture de zones : un coéquipier qui va déjà vers une zone l'allonge d'autant (m), pour que l'équipe se répartisse. */
const CROWD_COST = 12;
/**
 * Soutien : un robot qui porte un rayon réparateur va soigner un allié qui a perdu au moins
 * SUPPORT_NEED points, à moins de SUPPORT_SEARCH m ; il tourne autour de lui à SUPPORT_DISTANCE m
 * (son rayon n'atteint qu'un côté à la fois).
 */
const SUPPORT_NEED = 60;
const SUPPORT_SEARCH = 70;
const SUPPORT_DISTANCE = 9;
/** Point ramené dans la zone où circulent les robots. */
export function clampToRoam(sim: Simulation, p: Vec3): Vec3 {
  const roam = sim.arena.bounds.roam;
  // Et pas dans la mer, la lave, ni sur un flanc trop raide (arena/navgrid.ts)
  return nearestPassable(sim.arena, vec3(clamp(p.x, -roam, roam), 0, clamp(p.z, -roam, roam)));
}

/** État tactique d'un robot qui apparaît. */
export function createTactics(): TacticsState {
  return { foe: null, seenAt: -Infinity, orbit: 1, planT: 0, coverT: 0, coverBan: -Infinity, holding: false };
}

/**
 * Révise le plan de combat (toutes les PLAN_PERIOD s) : mode (`engage`, `cover`, `charge` ou
 * `patrol`) et destination (`ai.target`). À appeler à chaque pas, sauf en fuite ou en dégagement.
 */
export function planCombat(sim: Simulation, bot: Bot, pos: Vec3, dt: number): void {
  const ai = bot.ai;
  const tac = ai.tactics;
  if (ai.mode === "cover") tac.coverT += dt;
  tac.planT -= dt;
  if (tac.planT > 0) return;
  tac.planT = PLAN_PERIOD;

  const foe = chooseFoe(sim, bot);
  tac.foe = foe;
  // Soutien : un allié abîmé passe avant tout, sauf un répit pour recharger
  const patient = supportTarget(sim, bot);
  if (patient && !(ai.mode === "cover" && needsRespite(bot, true))) {
    if (ai.mode !== "support") tac.orbit = orbitSide(bot, pos, patient.lastPos);
    ai.mode = "support";
    ai.target = engagePoint(sim, pos, patient.lastPos, SUPPORT_DISTANCE, tac);
    return;
  }
  const objective = bot.profile.mobility === "plane" ? null : objectiveZone(sim, bot, pos);
  tac.holding = objective !== null;
  // Capture de zones : une patrouille qui ne mène pas à la zone visée se redirige
  if (objective && ai.mode === "patrol" && flatDistance(ai.target, objective.zone.pos) > objective.zone.radius) ai.timer = 0;
  if (!foe) {
    if (ai.mode === "engage" || ai.mode === "cover" || ai.mode === "charge" || ai.mode === "support") {
      ai.mode = "patrol";
      ai.timer = 0; // nouvelle destination de patrouille
    }
    return;
  }
  const threat = foe.lastPos;

  // Un répit derrière un pilier : chargeurs vides, ou réparations à faire
  const covering = ai.mode === "cover";
  if (sim.time >= tac.coverBan && needsRespite(bot, covering)) {
    if (!covering) {
      ai.mode = "cover";
      tac.coverT = 0;
    }
    if (tac.coverT < MAX_COVER) {
      ai.target = coverSpot(sim, bot, pos, threat);
      return;
    }
    tac.coverBan = sim.time + COVER_REST;
  }

  // Capture de zones : une zone à prendre passe avant la poursuite (la patrouille l'y mène)
  if (objective && (objective.owner !== bot.team || objective.contested)) {
    if (ai.mode !== "patrol") {
      ai.mode = "patrol";
      ai.timer = 0;
    }
    return;
  }

  let range = preferredRange(bot, foe);
  if (range === null) {
    // Aucune de ses armes ne porte sur lui : il continue sa patrouille
    if (ai.mode !== "patrol") {
      ai.mode = "patrol";
      ai.timer = 0;
    }
    return;
  }
  if (bot.profile.behavior === "charge" && range <= RAM_RANGE) {
    // Une toupie ne charge qu'à plein régime : avant, il tourne autour de sa cible, à distance
    if (meleePrimed(bot)) {
      ai.mode = "charge";
      ai.modeT = PLAN_PERIOD * 2;
      // (une foreuse vise le cockpit de sa cible : `chargePoint`)
      ai.target = clampToRoam(sim, chargePoint(bot, foe) ?? threat);
      return;
    }
    range = Math.max(range, STANDOFF);
  }
  if (ai.mode !== "engage") {
    // Nouvel engagement (ou fin d'un soutien) : il tourne du côté où il penche déjà (un demi-tour coûte cher)
    ai.mode = "engage";
    tac.orbit = orbitSide(bot, pos, threat);
  }
  ai.target = engagePoint(sim, pos, threat, range, tac);
}

/**
 * Adversaire : celui que visent le plus de ses tourelles ; sinon celui qu'il combattait déjà,
 * s'il le voit encore ; sinon l'ennemi repéré le plus proche contre lequel une de ses armes porte.
 * Un adversaire qui disparaît derrière un pilier reste le sien FOE_MEMORY s. Pas un avion : il
 * passe trop vite pour qu'on le poursuive.
 */
function chooseFoe(sim: Simulation, bot: Bot): Bot | null {
  const tac = bot.ai.tactics;
  const turrets = liveTurrets(bot);
  const aimedAt = new Map<Bot, number>();
  for (const t of turrets) {
    const target = t.target;
    // (un rayon réparateur vise un allié : ce n'est pas un adversaire)
    if (target?.cockpit.alive && target.profile.mobility !== "plane" && areEnemies(bot, target)) aimedAt.set(target, (aimedAt.get(target) ?? 0) + 1);
  }
  if (aimedAt.size) {
    tac.seenAt = sim.time;
    return [...aimedAt].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  }
  // (un champ défend sa coque : il ne mène pas au contact)
  const melee = offensiveMelee(bot).length > 0;
  const fair = (other: Bot): boolean => other.cockpit.alive && other.profile.mobility !== "plane" && areEnemies(bot, other)
    && (turrets.some((t) => suits(weaponDef(t.weapon), other)) || (melee && meleeSuits(other)));
  const last = tac.foe;
  if (last && fair(last) && isDetected(sim, bot.team, last) && distance(last.lastPos, bot.lastPos) < FOE_SEARCH) {
    tac.seenAt = sim.time;
    return last;
  }

  let best: Bot | null = null;
  let bestDist = FOE_SEARCH;
  for (const other of sim.bots) {
    if (!fair(other) || !isDetected(sim, bot.team, other)) continue;
    const d = distance(other.lastPos, bot.lastPos);
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  if (best) {
    tac.seenAt = sim.time;
    return best;
  }
  return last && fair(last) && sim.time - tac.seenAt < FOE_MEMORY ? last : null;
}

/**
 * Allié à aller soigner, s'il porte un rayon réparateur : le plus abîmé, préféré proche ; pas un
 * avion, trop rapide. Les nanites, qui poursuivent leur patient de loin, n'y obligent pas.
 */
function supportTarget(sim: Simulation, bot: Bot): Bot | null {
  if (!liveTurrets(bot).some((t) => { const p = weaponDef(t.weapon).projectile; return p.repair && !p.guidance; })) return null;
  let best: Bot | null = null;
  let bestScore = 0;
  for (const other of sim.bots) {
    if (other === bot || !other.cockpit.alive || areEnemies(bot, other) || other.profile.mobility === "plane") continue;
    const d = distance(other.lastPos, bot.lastPos);
    const need = repairNeed(other);
    if (d > SUPPORT_SEARCH || need < SUPPORT_NEED) continue;
    const score = need / (1 + d / 30);
    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

/**
 * Distance à laquelle il combat cet adversaire : la moyenne des portées préférées de ses armes
 * qui portent sur lui, sans dépasser la portée de la plus courte (toutes doivent pouvoir tirer).
 * null : aucune arme ne porte.
 */
export function preferredRange(bot: Bot, foe: Bot): number | null {
  let sum = 0;
  let count = 0;
  let shortest = Infinity;
  for (const t of liveTurrets(bot)) {
    const weapon = weaponDef(t.weapon);
    if (weapon.engage === undefined || !suits(weapon, foe)) continue;
    sum += weapon.engage;
    count++;
    shortest = Math.min(shortest, weapon.range);
  }
  // Ses armes de contact : au contact (la portée de la plus courte de ses armes, aussi)
  if (meleeSuits(foe)) {
    for (const arm of offensiveMelee(bot)) {
      const engage = meleeDef(arm.weapon).engage;
      sum += engage;
      count++;
      shortest = Math.min(shortest, engage / RANGE_MARGIN);
    }
  }
  return count ? Math.min(sum / count, shortest * RANGE_MARGIN) : null;
}

/**
 * Besoin d'un répit : toutes ses armes à chargeur sont vides (une arme sans chargeur, qui ne fait
 * que chauffer, suffit pour rester au combat), ou ses modules de réparation ont de quoi faire.
 * À couvert, il y reste tant que ses chargeurs ne sont pas à moitié pleins ou que les
 * réparations ne sont pas presque finies.
 */
function needsRespite(bot: Bot, covering: boolean): boolean {
  const offensive = liveTurrets(bot).filter((t) => weaponDef(t.weapon).engage !== undefined);
  if (offensive.length) {
    // Une arme électrique sans assez d'énergie compte comme un chargeur vide
    const drained = (t: Turret, shots: number): boolean => {
      const power = weaponDef(t.weapon).power;
      return !!power && bot.energy < power * shots;
    };
    const reloading = covering
      ? offensive.every((t) => {
        const ammo = weaponDef(t.weapon).ammo;
        return (ammo && t.arm.ammo < Math.ceil(ammo.capacity / 2)) || drained(t, 2);
      })
      : offensive.every((t) => (weaponDef(t.weapon).ammo && t.arm.ammo < 1) || drained(t, 1));
    if (reloading) return true;
  }
  const work = repairWork(bot);
  return covering ? work > REPAIR_DONE : work > REPAIR_WORTH;
}

/** Points de structure qui manquent aux blocs à portée de ses modules de réparation. */
export function repairWork(bot: Bot): number {
  const ck = bot.cockpit;
  if (!ck.alive) return 0;
  let work = 0;
  for (const module of ck.part.blocks) {
    const spec = blockDef(module.type).repair;
    if (!spec) continue;
    const center = blockWorldPos(module);
    for (const b of bot.blocks.values()) {
      const missing = BLOCK_TYPES[b.type].hp - b.hp;
      if (missing > 0 && distance(blockWorldPos(b), center) <= spec.radius) work += missing;
    }
  }
  return work;
}

/**
 * Capture de zones : la zone où aller. D'abord celles que son équipe ne tient pas (ou qu'on lui
 * dispute), la plus proche, chaque coéquipier qui y va déjà l'éloignant un peu (l'équipe se
 * répartit) ; s'il les tient toutes, la même règle entre toutes (il les garde). null : pas de zones.
 */
export function objectiveZone(sim: Simulation, bot: Bot, pos: Vec3): ZoneState | null {
  // Au roi de la colline, seule la colline est en jeu
  const zones = sim.match?.zones.filter((z) => z.active);
  if (!zones?.length) return null;
  const open = zones.filter((z) => z.owner !== bot.team || z.contested);
  let best: ZoneState | null = null;
  let bestCost = Infinity;
  for (const z of open.length ? open : zones) {
    let cost = flatDistance(z.zone.pos, pos);
    for (const mate of sim.bots) {
      if (mate !== bot && mate.team === bot.team && mate.cockpit.alive && flatDistance(mate.ai.target, z.zone.pos) <= z.zone.radius) cost += CROWD_COST;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = z;
    }
  }
  return best;
}

/**
 * Abri contre une menace en `threat` : derrière le pilier, le muret, le rocher, le conteneur ou le
 * bâtiment le plus proche (du côté opposé à la menace, juste au-delà de sa face). Sans abri à
 * portée, un point plus loin de la menace.
 */
export function coverSpot(sim: Simulation, bot: Bot, pos: Vec3, threat: Vec3): Vec3 {
  let best: Vec3 | null = null;
  let bestDist = COVER_SEARCH;
  const roam = sim.arena.bounds.roam;
  for (const o of obstacles(sim)) {
    const { rect, shelter } = o;
    if (!shelter) continue;
    // Là où les niveaux se superposent, un abri à sa hauteur (pas au fond du canyon qu'il surplombe) ;
    // un robot volant, à celle du sol sous lui, où il va se poser
    if (sim.arena.nav && !atLevel(o, bot.profile.mobility === "ground" ? pos.y : groundLevel(sim.arena, pos.x, pos.z) + 1)) continue;
    const cx = (rect.minX + rect.maxX) / 2;
    const cz = (rect.minZ + rect.maxZ) / 2;
    const hx = (rect.maxX - rect.minX) / 2;
    const hz = (rect.maxZ - rect.minZ) / 2;
    const away = vec3(cx - threat.x, 0, cz - threat.z);
    const gap = len(away);
    if (gap < 1) continue;
    // Distance du centre à la face de sortie, dans la direction opposée à la menace
    const exit = Math.min(Math.abs(away.x) > 1e-6 ? hx / Math.abs(away.x / gap) : Infinity, Math.abs(away.z) > 1e-6 ? hz / Math.abs(away.z / gap) : Infinity);
    const spot = add(vec3(cx, 0, cz), scale(away, (exit + bot.radius + COVER_GAP) / gap));
    const d = flatDistance(spot, pos);
    if (d < bestDist && Math.abs(spot.x) <= roam && Math.abs(spot.z) <= roam) {
      bestDist = d;
      best = spot;
    }
  }
  if (best) return best;
  const away = vec3(pos.x - threat.x, 0, pos.z - threat.z);
  return clampToRoam(sim, add(pos, scale(away, RETREAT_DISTANCE / (len(away) || 1))));
}

/** Sens de rotation autour de la menace le plus proche de son cap actuel (1 : sens trigonométrique vu du dessus). */
function orbitSide(bot: Bot, pos: Vec3, threat: Vec3): number {
  const heading = qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
  // Composante verticale de (menace → robot) × cap : > 0 si le cap tourne dans le sens trigonométrique
  const turn = (pos.z - threat.z) * heading.x - (pos.x - threat.x) * heading.z;
  return turn >= 0 ? 1 : -1;
}

/**
 * Point vers lequel rouler pour combattre à la distance `range` d'une menace en `threat`, LEAD m
 * devant lui : il tourne autour d'elle dans le sens `tac.orbit`, en s'en rapprochant s'il est trop
 * loin (presque droit sur elle quand il en est loin) et en s'en écartant s'il est trop près. Les
 * trajectoires convergent vers le cercle de rayon `range`.
 */
function engagePoint(sim: Simulation, pos: Vec3, threat: Vec3, range: number, tac: TacticsState): Vec3 {
  const off = vec3(pos.x - threat.x, 0, pos.z - threat.z);
  const d = len(off) || 1;
  const u = scale(off, 1 / d); // de la menace vers lui
  const ahead = (sign: number): Vec3 => {
    const tangent = vec3(-u.z * sign, 0, u.x * sign);
    const radial = clamp((range - d) / RANGE_SOFT, -3, 1.5); // > 0 : trop près, il s'écarte
    return add(pos, scale(norm(add(tangent, scale(u, radial))), LEAD));
  };
  // Contre un mur, il le longe ; acculé dans un coin, il repart dans l'autre sens
  let p = clampToRoam(sim, ahead(tac.orbit));
  if (flatDistance(p, pos) < LEAD / 3) {
    tac.orbit = -tac.orbit;
    p = clampToRoam(sim, ahead(tac.orbit));
  }
  return p;
}
