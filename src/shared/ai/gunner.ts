import RAPIER from "@dimforge/rapier3d-compat";
import { blockDef, BLOCK_TYPES } from "../catalog/blocks";
import { weaponDef, type DamageType, type Weapon } from "../catalog/weapons";
import { areEnemies } from "../combat/projectiles";
import { aimTurret, fireInTurn, lineOfFireBlocked, liveTurrets, muzzleVelocity, restTurret, turretFrame, turretReady, type ShotRequest } from "../combat/turrets";
import { damagedBlocks, repairNeed } from "../combat/repair";
import { incomingMissile } from "../combat/decoys";
import { strikesProjectiles } from "../combat/interception";
import { ballisticPoint, fallTime } from "../combat/ballistics";
import { GRAVITY } from "../config";
import { tickArm } from "../combat/arsenal";
import { organStunned } from "../combat/emp";
import { isLocked, releaseLock, updateLock } from "../combat/lock";
import { smokeBlocks } from "../combat/smoke";
import { isDetected } from "../sim/detection";
import { ownerBot } from "../robot/colliders";
import { blockWorldPos, integrity } from "../robot/queries";
import { rand } from "../math/scalar";
import { add, distance, dot, len, norm, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { Block, Bot, Projectile, Turret } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { dcos, dsin } from "../math/det";

/** Intervalle entre deux choix de cible (s). */
const RETARGET = 0.6;
/**
 * Préférences du choix de cible, à retrancher de la distance rapportée à la portée : une cible
 * détruite à moitié compte comme FINISH_BONUS / 2 de portée plus près ; une cible sur laquelle
 * l'arme fait 30 % de dégâts en moins, 0,3 × WEAKNESS_BONUS plus loin ; celle que le robot engage
 * déjà, FOCUS_BONUS plus près.
 */
const FINISH_BONUS = 0.5;
const WEAKNESS_BONUS = 0.6;
const FOCUS_BONUS = 0.15;
/**
 * Erreur de visée de l'IA (rad) : AIM_BASE sur une cible immobile, plus AIM_TRACKING par m/s de
 * vitesse relative en travers de la ligne de tir. Une cible qui manœuvre, ou un tireur qui
 * roule vite, se manquent plus souvent ; à 45 m, une cible qui croise à 8 m/s voit ses balles
 * s'écarter jusqu'à 2,5 m.
 */
const AIM_BASE = 0.012;
const AIM_TRACKING = 0.0055;
/**
 * Écart de visée toléré pour tirer (rad) : serré pour les balles, large pour les missiles ; une
 * arme dispersée (lance-flammes) tire dès qu'elle est à peu près pointée.
 */
const TOLERANCE = { direct: 0.04, guided: 0.35 };
export const toleranceOf = (weapon: Weapon): number =>
  weapon.projectile.guidance ? TOLERANCE.guided : Math.max(TOLERANCE.direct, weapon.spread * 2);

/**
 * Le robot manœuvre ses tourelles : chacune choisit un ennemi à sa portée, calcule où viser
 * (anticipation, balistique), tourne vers lui et tire quand elle est pointée et que la voie est
 * libre ; des armes identiques, à tour de rôle (voir `fireInTurn`).
 */
export function operateTurrets(sim: Simulation, bot: Bot, dt: number): void {
  const ready: ShotRequest[] = [];
  for (const t of liveTurrets(bot)) {
    const weapon = weaponDef(t.weapon);
    tickArm(t.arm, weapon, dt);
    // Paralysée localement (lance électrique, combat/emp.ts) : elle se fige et se tait
    if (organStunned(sim, t.block)) continue;
    // Rayon réparateur, nanites : leurs cibles sont des alliés. Sans patient, le rayon qui vole la
    // vie se bat comme une autre arme ; les nanites attendent
    if (weapon.projectile.repair) {
      if (operateSupport(sim, bot, t, weapon, ready)) continue;
      if (!weapon.projectile.repair.drain) {
        t.aim = null;
        restTurret(t);
        continue;
      }
    }
    // Défense rapprochée : une arme automatique rapide suit le missile qui fonce sur son robot, et
    // tire dessus dès qu'il est à sa portée ; elle le vise avec l'erreur de l'IA (facile de face,
    // bien plus dur quand il croise)
    const missile = pointDefense(weapon) ? incomingMissile(sim.projectiles, bot, POINT_DEFENSE_TRACK) : null;
    if (missile) {
      const frame = turretFrame(t);
      const where = add(missile.pos, interceptError(t, frame.muzzle, bot, missile));
      t.aim = where;
      const error = aimTurret(t, firingDirection(frame.muzzle, where, missile.vel, weapon));
      const inRange = distance(missile.pos, frame.muzzle) <= weapon.range;
      if (inRange && turretReady(t) && error < toleranceOf(weapon) && !lineOfFireBlocked(t)) ready.push({ turret: t, homing: null });
      continue;
    }
    t.retarget -= dt;
    if (t.retarget <= 0 || !isValidTarget(sim, bot, t.target, weapon)) {
      t.target = pickTarget(sim, bot, t, weapon);
      t.retarget = RETARGET;
      t.wobble = randomInBall();
    }
    const target = t.target;
    if (!target) {
      t.aim = null;
      releaseLock(t);
      continue;
    }
    const frame = turretFrame(t);
    const where = add(target.cockpit.part.rb.worldCom(), aimError(t, frame.muzzle, bot, target));
    t.aim = where;

    // Poseur de mines : il sème derrière lui quand un ennemi qu'elles peuvent prendre est à proximité
    if (weapon.projectile.mine) {
      if (turretReady(t) && !lineOfFireBlocked(t) && mineUseful(sim, bot, t, weapon)) ready.push({ turret: t, homing: null });
      continue;
    }
    // Soute à bombes : elle largue quand ses bombes tomberaient sur la cible
    if (weapon.dropped) {
      if (turretReady(t) && !lineOfFireBlocked(t) && bombsOnTarget(sim, bot, t, weapon, target)) ready.push({ turret: t, homing: null });
      continue;
    }

    const want = firingDirection(frame.muzzle, where, target.cockpit.part.rb.linvel(), weapon);
    const error = aimTurret(t, want);
    // Arme à verrouillage : elle verrouille ce qu'elle vise, et ne tire que sur sa cible verrouillée
    if (weapon.lock) updateLock(sim, t, frame.muzzle, norm(sub(where, frame.muzzle)), dt);
    const locked = !weapon.lock || (isLocked(t) && t.lockOn === target);
    // Un fumigène sert à couvrir une fuite ou un repli : on ne le lance qu'en fuyant ou en allant se mettre à couvert
    const useful = !weapon.projectile.smoke || bot.ai.mode === "flee" || bot.ai.mode === "cover";
    // Un mur d'énergie : quand on le prend pour cible, entre lui et nous (il n'a pas besoin de voir la cible)
    if (weapon.projectile.barrier) {
      if (turretReady(t) && error < toleranceOf(weapon) && !lineOfFireBlocked(t) && barrierUseful(sim, bot, target)) ready.push({ turret: t, homing: null });
      continue;
    }
    if (useful && locked && turretReady(t) && error < toleranceOf(weapon) && !lineOfFireBlocked(t) && clearShot(sim, bot, frame.muzzle, where, target)) {
      ready.push({ turret: t, homing: weapon.projectile.guidance?.mode === "homing" ? target : null });
    }
  }
  fireInTurn(sim, bot, ready);
}

/**
 * Poser une mine maintenant sert-il à quelque chose (un ennemi qu'elle peut prendre est déjà à
 * portée) ? Une mine fumigène couvre une fuite ou un repli ; un capteur ne se pose pas là où son
 * équipe en a déjà un.
 */
function mineUseful(sim: Simulation, bot: Bot, t: Turret, weapon: Weapon): boolean {
  const p = weapon.projectile;
  if (p.smoke) return bot.ai.mode === "flee" || bot.ai.mode === "cover";
  const sense = p.mine?.sense;
  if (!sense) return true;
  const at = turretFrame(t).muzzle;
  return !sim.projectiles.some((q) => q.landed && q.shooter?.team === bot.team && weaponDef(q.weapon).projectile.mine?.sense && distance(q.pos, at) < sense);
}

/**
 * Déployer un mur d'énergie vers `target` sert-il maintenant ? Le robot vient d'être touché, la
 * cible n'est pas collée à lui, et son équipe n'a pas déjà un mur tout près de lui.
 */
function barrierUseful(sim: Simulation, bot: Bot, target: Bot): boolean {
  if (sim.time - bot.lastHit > BARRIER_ALERT || distance(target.lastPos, bot.lastPos) < BARRIER_MIN_RANGE) return false;
  return !sim.barriers.some((b) => b.team === bot.team && distance(b.center, bot.lastPos) < BARRIER_SPACING);
}
/** L'IA déploie un mur dans les BARRIER_ALERT s qui suivent un coup reçu, pas contre un ennemi à moins de BARRIER_MIN_RANGE m, ni à moins de BARRIER_SPACING m d'un mur de son équipe. */
const BARRIER_ALERT = 2;
const BARRIER_MIN_RANGE = 8;
const BARRIER_SPACING = 9;

/**
 * Défense rapprochée : une tourelle se tourne vers un missile qui fonce sur son robot dès qu'il est
 * à moins de cette distance (m) ; elle tire quand il entre dans la portée de son arme.
 */
const POINT_DEFENSE_TRACK = 45;

/** L'arme peut-elle abattre un missile en vol ? Une arme automatique à projectile rapide et direct (fusil, laser). */
function pointDefense(weapon: Weapon): boolean {
  const p = weapon.projectile;
  return weapon.automatic && strikesProjectiles(p) && p.speed >= 100 && !p.explosion;
}

/** Un allié ne se soigne au rayon qu'à partir de ce que ses blocs ont perdu (points de structure). */
const PATIENT_NEED = 20;
/** Blocs abîmés qu'un rayon réparateur essaie d'atteindre, les plus abîmés d'abord. */
const REPAIR_TRIES = 12;
/** Bloc que vise chaque rayon réparateur, choisi avec son patient (voir `repairAim`), et instant du prochain choix de patient. */
const repairAims = new WeakMap<Turret, Block>();
const patientAt = new WeakMap<Turret, number>();

/**
 * Tourelle de soin (rayon réparateur, nanites) : elle choisit l'allié le plus abîmé à sa portée
 * (moins s'il est loin). Le rayon vise son bloc le plus abîmé qu'il atteint vraiment et tire quand
 * il est pointé et que rien ne s'interpose ; les nanites, qui le poursuivent et se répandent sur
 * lui, partent dès que la tourelle est tournée vers lui. Renvoie faux sans patient (la tourelle
 * est libre). Sert aussi aux tourelles de soin automatiques du joueur (`Weapon.autoSupport`).
 */
export function operateSupport(sim: Simulation, bot: Bot, t: Turret, weapon: Weapon, ready: ShotRequest[]): boolean {
  const guided = !!weapon.projectile.guidance;
  const current = t.target && !areEnemies(bot, t.target) ? t.target : null;
  const aimed = repairAims.get(t);
  const done = !current || !current.cockpit.alive
    || (!guided && (!aimed?.alive || aimed.bot !== current || aimed.hp >= BLOCK_TYPES[aimed.type].hp));
  if ((patientAt.get(t) ?? -Infinity) <= sim.time || (current && done)) {
    patientAt.set(t, sim.time + RETARGET);
    const patient = pickPatient(sim, bot, t, weapon);
    if (patient) t.target = patient;
    else if (current) t.target = null;
    const block = patient && !guided ? repairAim(sim, bot, t, patient, weapon.projectile.repair?.radius ?? 1) : null;
    if (block) repairAims.set(t, block);
    else repairAims.delete(t);
  }
  const target = t.target && !areEnemies(bot, t.target) ? t.target : null;
  if (!target) return false;
  const frame = turretFrame(t);
  if (guided) {
    const where = target.cockpit.part.rb.worldCom();
    t.aim = where;
    const error = aimTurret(t, norm(sub(where, frame.muzzle)));
    if (turretReady(t) && error < toleranceOf(weapon) && !lineOfFireBlocked(t)) ready.push({ turret: t, homing: target });
    return true;
  }
  const block = repairAims.get(t);
  if (!block) {
    // Rien d'atteignable de là : il reste avec son patient (son robot tourne autour, voir ai/tactics.ts)
    t.aim = null;
    restTurret(t);
    return true;
  }
  const where = blockWorldPos(block);
  t.aim = where;
  const error = aimTurret(t, firingDirection(frame.muzzle, where, target.cockpit.part.rb.linvel(), weapon));
  if (turretReady(t) && error < toleranceOf(weapon) && !lineOfFireBlocked(t) && clearShot(sim, bot, frame.muzzle, where, target)) {
    ready.push({ turret: t, homing: null });
  }
  return true;
}

/**
 * Bloc à viser sur le patient : le plus abîmé que le rayon atteint vraiment (son point d'impact à
 * portée de réparation de ce bloc), ou null. Un bloc enfoui sous d'autres ne se vise pas : le
 * rayon réparerait la surface, déjà neuve, sans l'atteindre ; il se répare en visant ses voisins.
 */
function repairAim(sim: Simulation, bot: Bot, t: Turret, patient: Bot, radius: number): Block | null {
  const muzzle = turretFrame(t).muzzle;
  const damaged = damagedBlocks(patient);
  for (const b of damaged.slice(0, REPAIR_TRIES)) {
    const at = blockWorldPos(b);
    const to = sub(at, muzzle);
    const dist = len(to);
    if (dist < 1e-3) continue;
    const hit = sim.world.castRay(
      new RAPIER.Ray(muzzle, scale(to, 1 / dist)), dist + 1, true, undefined, undefined, undefined, undefined,
      (c) => {
        const owner = sim.colliders.get(c.handle);
        return owner?.kind !== "debris" && ownerBot(owner) !== bot;
      },
    );
    if (hit && distance(add(muzzle, scale(to, hit.timeOfImpact / dist)), at) < radius) return b;
  }
  // Rien d'atteignable de là : il ne tire pas pour rien (son robot tourne autour du patient, voir ai/tactics.ts)
  return null;
}

/** Allié à soigner : le plus abîmé à portée du rayon, préféré proche. */
function pickPatient(sim: Simulation, bot: Bot, t: Turret, weapon: Weapon): Bot | null {
  const from = turretFrame(t).muzzle;
  let best: Bot | null = null;
  let bestScore = 0;
  for (const other of sim.bots) {
    if (other === bot || !other.cockpit.alive || areEnemies(bot, other)) continue;
    const d = distance(other.lastPos, from);
    const need = repairNeed(other);
    if (d > weapon.range || need < PATIENT_NEED) continue;
    const score = need / (1 + d / 20);
    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

/**
 * Une bombe lâchée maintenant tomberait-elle sur la cible ? Elle part avec la vitesse du robot ; on
 * suit sa chute jusqu'à la hauteur de la cible, et on la compare à l'endroit où celle-ci sera
 * alors (à sa vitesse actuelle). Pas si un coéquipier est dans la zone de l'explosion.
 */
function bombsOnTarget(sim: Simulation, bot: Bot, t: Turret, weapon: Weapon, target: Bot): boolean {
  const p = weapon.projectile;
  const { dir, muzzle } = turretFrame(t);
  const vel = add(muzzleVelocity(t, muzzle), scale(dir, p.speed));
  const rb = target.cockpit.part.rb;
  const goal = rb.worldCom();
  const time = fallTime(muzzle.y - goal.y, vel.y, p.gravity);
  if (time === null) return false;
  const impact = ballisticPoint(muzzle, vel, p.gravity, time);
  const ahead = add(goal, scale(rb.linvel(), time));
  const radius = p.explosion?.radius ?? 1;
  if (Math.hypot(impact.x - ahead.x, impact.z - ahead.z) > radius + target.radius) return false;
  return !sim.bots.some((b) => b !== bot && b.cockpit.alive && !areEnemies(bot, b)
    && Math.hypot(b.lastPos.x - impact.x, b.lastPos.z - impact.z) < radius + b.radius);
}

/** Décalage du point visé (m) : l'erreur de visée à cette distance, selon le mouvement relatif. */
function aimError(t: Turret, muzzle: Vec3, bot: Bot, target: Bot): Vec3 {
  const los = sub(target.lastPos, muzzle);
  const range = len(los);
  if (range < 1e-3) return vec3(0, 0, 0);
  const u = scale(los, 1 / range);
  const rel = sub(target.cockpit.part.rb.linvel(), bot.cockpit.part.rb.linvel());
  const across = len(sub(rel, scale(u, dot(rel, u))));
  return scale(t.wobble, range * (AIM_BASE + AIM_TRACKING * across));
}

/** Erreur de visée sur un missile (m), comme sur un robot (voir `aimError`) : sa vitesse en travers de la ligne de tir la grossit. */
function interceptError(t: Turret, muzzle: Vec3, bot: Bot, missile: Projectile): Vec3 {
  const los = sub(missile.pos, muzzle);
  const range = len(los);
  if (range < 1e-3) return vec3(0, 0, 0);
  const u = scale(los, 1 / range);
  const rel = sub(missile.vel, bot.cockpit.part.rb.linvel());
  const across = len(sub(rel, scale(u, dot(rel, u))));
  return scale(t.wobble, range * (AIM_BASE + AIM_TRACKING * across));
}

/** Point tiré au hasard dans la boule unité. */
function randomInBall(): Vec3 {
  for (;;) {
    const v = vec3(rand(-1, 1), rand(-1, 1), rand(-1, 1));
    if (len(v) <= 1) return v;
  }
}

/** Une cible reste valable tant qu'elle vit, reste repérée, à portée (ni trop près, pour une ogive), et convient à l'arme. */
function isValidTarget(sim: Simulation, bot: Bot, target: Bot | null, weapon: Weapon): target is Bot {
  if (!target || !target.cockpit.alive || !suits(weapon, target) || !isDetected(sim, bot.team, target)) return false;
  const d = distance(target.lastPos, bot.lastPos);
  return d <= weapon.range && d >= (weapon.minRange ?? 0);
}

/** L'arme convient-elle à ce genre de cible ? */
export function suits(weapon: Weapon, target: Bot): boolean {
  const flying = target.profile.mobility !== "ground";
  const p = weapon.projectile;
  if (p.guidance?.airOnly || p.mine?.trigger === "air") return flying; // anti-aérien : robots en vol seulement
  if (p.mine?.trigger === "none") return true; // capteur : tout ce qui passe
  if (p.mine || weapon.dropped) return !flying; // mines et bombes : robots au sol
  if (p.gravity && p.explosion) return target.profile.mobility !== "plane"; // un obus ne rattrape pas un avion
  return true;
}

/**
 * Cible d'une tourelle, parmi les ennemis repérés à portée qui conviennent à l'arme : la plus
 * proche, de préférence abîmée (pour l'achever), vulnérable à l'arme (selon les résistances de ses
 * blocs) et déjà engagée par le robot (ses tourelles et ses manœuvres visent le même).
 */
function pickTarget(sim: Simulation, bot: Bot, t: Turret, weapon: Weapon): Bot | null {
  let best: Bot | null = null;
  let bestScore = Infinity;
  const from = turretFrame(t).muzzle;
  for (const other of sim.bots) {
    if (!other.cockpit.alive || !areEnemies(bot, other) || !suits(weapon, other) || !isDetected(sim, bot.team, other)) continue;
    const d = distance(other.lastPos, from);
    if (d > weapon.range || d < (weapon.minRange ?? 0)) continue;
    const score = targetScore(bot, other, weapon, d);
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

/** Note d'une cible à la distance `d` pour cette arme : plus elle est basse, plus la cible est intéressante. */
export function targetScore(bot: Bot, other: Bot, weapon: Weapon, d: number): number {
  return d / weapon.range
    - FINISH_BONUS * (1 - integrity(other))
    - WEAKNESS_BONUS * (vulnerability(other, weapon.projectile.damageType) - 1)
    - (other === bot.ai.tactics.foe ? FOCUS_BONUS : 0);
}

/** Vulnérabilité moyenne des blocs du morceau du cockpit à une nature de dégâts, par robot (recalculée quand il perd des blocs). */
const vulnerabilities = new WeakMap<Bot, { blocks: number; byType: Map<DamageType, number> }>();

/** Facteur moyen des dégâts de nature `type` sur les blocs du morceau du cockpit de `bot` (1 : sans résistance). */
export function vulnerability(bot: Bot, type: DamageType): number {
  const blocks = bot.cockpit.part.blocks;
  let cache = vulnerabilities.get(bot);
  if (!cache || cache.blocks !== blocks.size) vulnerabilities.set(bot, (cache = { blocks: blocks.size, byType: new Map() }));
  let v = cache.byType.get(type);
  if (v === undefined) {
    let sum = 0;
    for (const b of blocks) sum += blockDef(b.type).resist?.[type] ?? 1;
    v = blocks.size ? sum / blocks.size : 1;
    cache.byType.set(type, v);
  }
  return v;
}

/**
 * Direction de tir vers une cible en `target` qui se déplace à `vel` : on vise là où elle sera
 * à l'arrivée du projectile, et, s'il retombe, on relève le canon (tir tendu de la balistique).
 * Un missile guidé part simplement vers la cible, un peu relevé.
 */
export function firingDirection(muzzle: Vec3, target: Vec3, vel: Vec3, weapon: Weapon): Vec3 {
  const p = weapon.projectile;
  // Un téléguidé suit l'axe du canon (combat/projectiles.ts, `steer`) : on le pointe droit sur la
  // cible ; une tête chercheuse ou une ogive partent un peu en l'air, leur guidage les ramène
  if (p.guidance) return p.guidance.mode === "command" ? norm(sub(target, muzzle)) : norm(add(norm(sub(target, muzzle)), vec3(0, 0.15, 0)));
  let aim = target;
  let dir = norm(sub(aim, muzzle));
  for (let i = 0; i < 3; i++) {
    const d = sub(aim, muzzle);
    const horizontal = Math.hypot(d.x, d.z);
    let flight = Math.hypot(horizontal, d.y) / p.speed;
    dir = norm(d);
    if (p.gravity && horizontal > 0.1) {
      const g = GRAVITY * p.gravity;
      const v2 = p.speed * p.speed;
      const root = v2 * v2 - g * (g * horizontal * horizontal + 2 * d.y * v2);
      const angle = root >= 0 ? Math.atan((v2 - Math.sqrt(root)) / (g * horizontal)) : Math.PI / 4;
      const flat = vec3(d.x / horizontal, 0, d.z / horizontal);
      dir = add(scale(flat, dcos(angle)), vec3(0, dsin(angle), 0));
      flight = horizontal / (p.speed * dcos(angle));
    }
    aim = add(target, scale(vel, flight));
  }
  return dir;
}

/**
 * La voie est-elle libre ? Un rayon de la bouche vers la cible ne doit rencontrer ni un
 * coéquipier, ni le décor avant elle (on ignore son propre robot et les débris), et la cible ne
 * doit pas être cachée par la fumée.
 */
/** Rien entre la bouche et la cible (ni fumée, ni décor, ni coéquipier) : `enemy` est le robot visé (un allié pour le rayon réparateur). */
function clearShot(sim: Simulation, bot: Bot, muzzle: Vec3, target: Vec3, enemy: Bot): boolean {
  if (smokeBlocks(sim, muzzle, target)) return false;
  const to = sub(target, muzzle);
  const dist = Math.hypot(to.x, to.y, to.z);
  const hit = sim.world.castRay(
    new RAPIER.Ray(muzzle, scale(to, 1 / dist)), dist, true, undefined, undefined, undefined, undefined,
    (c) => {
      const owner = sim.colliders.get(c.handle);
      if (owner?.kind === "debris") return false;
      return ownerBot(owner) !== bot;
    },
  );
  if (!hit) return true;
  const other = ownerBot(sim.colliders.get(hit.collider.handle));
  if (other) return other === enemy || areEnemies(bot, other);
  // Décor ou accessoire : on tire s'il est tout près de la cible (on la touchera par l'explosion ou par-dessus)
  return hit.timeOfImpact > dist - 1.5;
}
