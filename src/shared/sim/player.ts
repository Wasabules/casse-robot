import { flyManual, flyMouse, holdPlane } from "../ai/pilot";
import { flightLevel, groundLevel } from "../arena/layout";
import { fieldWanted } from "../ai/brawl";
import { firingDirection, operateSupport } from "../ai/gunner";
import { lobbed, released, weaponDef } from "../catalog/weapons";
import { meleeDef, meleeOffensive, wielded } from "../catalog/melee";
import { aimSpread } from "../combat/accuracy";
import { tickArm } from "../combat/arsenal";
import { lobDirection } from "../combat/ballistics";
import { organStunned } from "../combat/emp";
import { isLocked, releaseLock, updateLock } from "../combat/lock";
import { launchFlares } from "../combat/decoys";
import { detonateMines } from "../combat/mines";
import { findHomingTarget, fuseNow, pilotedWarhead } from "../combat/projectiles";
import { aimTurret, fireInTurn, lineOfFireBlocked, liveTurrets, muzzleVelocity, restTurret, turretFrame, turretReady, type ShotRequest } from "../combat/turrets";
import { clamp } from "../math/scalar";
import { add, norm, qrot, scale, sub, vec3 } from "../math/vec";
import { drive, flyToward, runEngines } from "../robot/propulsion";
import { FLIPPED_UP_Y } from "../robot/righting";
import { steeringGeometry } from "../robot/steering";
import type { Bot } from "./entities";
import type { Simulation } from "./simulation";
import { dcos, dsin } from "../math/det";
import type { PlayerInput } from "./input";

/*
 * Robot piloté par le joueur. Ses commandes (`PlayerInput`) sont lues à chaque pas ; ce sont elles,
 * et elles seules, que le client enverra au serveur en multijoueur. Au sol, il conduit comme l'IA
 * (roues, chenilles, patins, pattes), en char ou vers où regarde la caméra ; en vol stationnaire, il
 * se déplace par rapport à sa caméra, règle son altitude et, à la caméra, se tourne vers où elle
 * regarde ; en avion, il va là où il regarde (à la souris, comme dans Robocraft) ou tient le manche
 * (manuel), les gaz à part (ai/pilot.ts). Ses tourelles visent le point visé et tirent quand la
 * gâchette est pressée et qu'elles sont pointées.
 */

/** Délai après le tir avant qu'un clic puisse faire exploser une ogive pilotée (s). */
const DETONATE_AFTER = 0.4;
/** Vitesse de montée et de descente d'un robot volant piloté (m/s), et altitudes permises (m). */
const CLIMB_RATE = 3;
const MIN_ALT = 2;
const MAX_ALT = 18;
/** Avance au plus de l'altitude visée sur l'altitude où il est, touche tenue (m) : de quoi monter à sa vitesse, sans trop filer une fois lâchée. */
const CLIMB_LEAD = 3;
/** Distance du point vers lequel vole un robot volant piloté (m) : assez loin pour aller à sa vitesse maximale. */
const FLY_REACH = 15;
/** Conduite relative à la caméra : au-delà de cet écart (rad), le robot recule plutôt que de faire demi-tour ; gain du braquage. */
const REVERSE_ANGLE = 2.2;
const RELATIVE_STEER = 1.6;
/**
 * Robot volant à la caméra : il se tourne vers où elle regarde, à `FACE_GAIN` rad/s par radian
 * d'écart (au plus `HOVER_YAW_RATE`) ; le gyroscope du cockpit l'y aide d'autant plus qu'il en est
 * loin (tout à `FACE_ASSIST` rad), et plus du tout une fois tourné.
 */
const FACE_GAIN = 2.5;
const FACE_ASSIST = 0.5;

// Les commandes du joueur, à part (sim/input.ts : la session de la simulation Rust n'a besoin que d'elles)
export { CRUISE_POWER, newInput, type PlayerInput } from "./input";

/** Le robot passe aux commandes `input` (d'un joueur local ou distant). */
export function takeControl(bot: Bot, input: PlayerInput): void {
  bot.controller = "player";
  bot.input = input;
}

/** Le robot repasse à l'IA (un joueur distant s'est déconnecté). */
export function releaseControl(bot: Bot): void {
  bot.controller = "ai";
  bot.input = null;
}

/**
 * Vitesse de lacet d'un robot volant piloté, touche tenue (rad/s) : un demi-tour en un peu plus de
 * 2 s ; le gyroscope du cockpit l'aide encore `HOVER_YAW_FADE` s après (le temps de s'arrêter de tourner).
 */
const HOVER_YAW_RATE = 1.4;
const HOVER_YAW_FADE = 1;

/** Un pas du robot piloté : déplacement selon sa mobilité, puis ses tourelles. */
export function thinkPlayer(sim: Simulation, bot: Bot, input: PlayerInput, dt: number): void {
  // Ogive pilotée en vol : le pilote la dirige (voir `steer`, combat/projectiles.ts) ; son robot
  // s'arrête, ses tourelles ne visent plus, et un nouveau clic fait exploser l'ogive
  // Ses mines télécommandées sautent tant qu'il tient la touche (voir combat/mines.ts)
  if (input.detonate) detonateMines(sim, bot);
  if (input.flares) launchFlares(sim, bot);
  const warhead = pilotedWarhead(sim, bot);
  if (warhead && input.trigger && !bot.triggerHeld && warhead.age > DETONATE_AFTER) fuseNow(warhead);
  bot.triggerHeld = input.trigger;
  // (un avion, qui ne peut pas s'arrêter, tourne sur le circuit, tenu par le pilote automatique : `holdPlane`)
  if (warhead) input = { ...input, throttle: 0, steer: 0, climb: 0, yaw: 0, boost: false, brake: 1, trigger: false, aim: null };
  const rb = bot.cockpit.part.rb;
  const up = qrot(rb.rotation(), vec3(0, 1, 0));
  // Un avion s'incline en virage : il n'est pas « renversé » pour autant
  if (bot.profile.mobility !== "plane") bot.ai.mode = up.y < FLIPPED_UP_Y ? "flipped" : "patrol";
  const brake = clamp(input.brake, 0, 1);
  switch (bot.profile.mobility) {
    case "ground": {
      const [throttle, steer] = input.relative ? cameraDrive(bot, input) : [input.throttle, input.steer];
      // Le boost : propulseurs à fond, moteurs des roues au sprint ; le frein prime
      drive(sim, bot, throttle, steer, { boost: input.boost, sprint: input.boost, brake });
      runEngines(bot, input.boost && brake === 0 ? 1 : 0);
      break;
    }
    case "hover": {
      const pos = rb.worldCom();
      // Monter, descendre tant qu'on tient la touche : l'altitude visée file devant lui, sans plus de
      // CLIMB_LEAD m d'avance ; relâchée, il s'arrête aussitôt (il ne rattrape pas une avance prise)
      if (Math.abs(input.climb) > 0.05) {
        const height = pos.y - groundLevel(sim.arena, pos.x, pos.z);
        const next = clamp(bot.ai.alt + input.climb * CLIMB_RATE * dt, height - CLIMB_LEAD, height + CLIMB_LEAD);
        bot.ai.alt = clamp(next, MIN_ALT, MAX_ALT);
      }
      const forward = vec3(dsin(input.heading), 0, dcos(input.heading));
      const left = vec3(forward.z, 0, -forward.x);
      // Le frein l'arrête sur place (il ne vole plus vers où on le pousse)
      const go = 1 - brake;
      const target = add(pos, scale(add(scale(forward, input.throttle * go), scale(left, input.steer * go)), FLY_REACH));
      // Le lacet (`yaw`) : il pivote sur place, à plat, sans changer son déplacement ; à la caméra,
      // sans lacet, il se tourne vers où elle regarde (le lacet tenu passe avant)
      let yaw = clamp(input.yaw, -1, 1);
      let assist = Math.abs(yaw);
      if (input.relative && assist < 0.05) {
        const nose = qrot(rb.rotation(), vec3(0, 0, 1));
        const gap = Math.atan2(dsin(input.heading - Math.atan2(nose.x, nose.z)), dcos(input.heading - Math.atan2(nose.x, nose.z)));
        yaw = clamp((gap * FACE_GAIN) / HOVER_YAW_RATE, -1, 1);
        assist = clamp(Math.abs(gap) / FACE_ASSIST, 0, 1);
      }
      bot.ai.slip = Math.max(assist, bot.ai.slip - dt / HOVER_YAW_FADE);
      flyToward(bot, vec3(target.x, flightLevel(sim.arena, pos, target, bot.ai.alt), target.z), { rate: yaw * HOVER_YAW_RATE, assist: bot.ai.slip });
      break;
    }
    case "plane":
      // Le pilote automatique, pendant le vol de l'ogive ; manuel : le manche (tangage, roulis,
      // palonnier) ; sinon, il va là où regarde le joueur. Les gaz à part
      if (warhead) holdPlane(sim, bot, dt);
      else if (input.manual) flyManual(sim, bot, { pitch: input.climb, roll: -input.steer, yaw: input.yaw, power: input.power }, dt);
      else flyMouse(sim, bot, { look: input.look, turn: input.steer, pitch: input.climb, yaw: input.yaw, power: input.power }, dt);
      break;
  }
  operatePlayerTurrets(sim, bot, input, dt);
  operatePlayerMelee(sim, bot, input);
}

/**
 * Armes de contact du joueur (combat/melee.ts). Un rotor (toupie, lame laser) tourne tant qu'il est
 * l'arme choisie (ou qu'aucune ne l'est) : il monte en régime de lui-même, la jauge du réticule le
 * montre ; une autre arme choisie, il ralentit en roue libre (une lame d'énergie s'éteint), et le
 * robot retrouve sa conduite et ses batteries. Un fléau aussi : sa manivelle tourne tant qu'il est
 * choisi. Un bras (marteau, fouet) ou une pointe (lance) frappe à la gâchette, tant qu'elle est
 * tenue, dès qu'il est réarmé ; un flipper lève de même, dès que son vérin est rechargé ; une
 * mâchoire se ferme à la gâchette et tient ce qu'elle a saisi tant qu'elle reste tenue (relâchée,
 * elle lâche). Un champ se passe du joueur : il s'arme seul quand un ennemi approche, comme pour
 * l'IA (`fieldWanted`).
 */
function operatePlayerMelee(sim: Simulation, bot: Bot, input: PlayerInput): void {
  for (const arm of bot.melee) {
    // (une hélice tranchante : son moteur la mène, personne ne la commande)
    if (!wielded(meleeDef(arm.weapon))) continue;
    if (!meleeOffensive(meleeDef(arm.weapon))) {
      arm.wanted = fieldWanted(sim, bot);
      continue;
    }
    const chosen = input.weapon === null || input.weapon === arm.weapon;
    arm.wanted = chosen;
    arm.trigger = chosen && input.trigger;
  }
}

/**
 * Conduite relative à la caméra : la direction voulue à l'écran (avant de la caméra, gauche) ; le
 * robot braque vers elle et avance, d'autant moins vite qu'il en est loin ; s'il lui tourne le dos,
 * il recule en orientant son arrière vers elle (un robot à roues directrices contre-braque).
 */
function cameraDrive(bot: Bot, input: PlayerInput): [number, number] {
  const forward = vec3(dsin(input.heading), 0, dcos(input.heading));
  const left = vec3(forward.z, 0, -forward.x);
  const want = add(scale(forward, input.throttle), scale(left, input.steer));
  const magnitude = Math.min(1, Math.hypot(want.x, want.z));
  if (magnitude < 0.1) return [0, 0];
  const nose = qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
  const wrap = (a: number): number => Math.atan2(dsin(a), dcos(a));
  // > 0 : la direction voulue est à gauche du robot
  const angle = wrap(Math.atan2(want.x, want.z) - Math.atan2(nose.x, nose.z));
  if (Math.abs(angle) > REVERSE_ANGLE) {
    const behind = wrap(angle - Math.PI);
    const steered = steeringGeometry(bot).maxCurvature > 0;
    return [-magnitude, clamp((steered ? -1 : 1) * behind * RELATIVE_STEER, -1, 1)];
  }
  return [magnitude * clamp(1 - Math.abs(angle) / 1.6, 0.25, 1), clamp(angle * RELATIVE_STEER, -1, 1)];
}

/**
 * Tourelles du joueur : celles de l'arme choisie tournent vers le point visé (avec l'angle
 * balistique de leur arme, sauf pour un tir en cloche, dont le joueur choisit la hausse : voir
 * combat/ballistics.ts), les autres reviennent au repos ; `input.weapon` à null : toutes visent.
 * Celles de l'arme choisie tirent tant que la gâchette est pressée, quand elles sont pointées et
 * prêtes (des armes identiques à tour de rôle : voir `fireInTurn`). La précision dépend du viseur, du mouvement et de la stabilité du robot (voir
 * combat/accuracy.ts) ; une arme de précision
 * (`scopeOnly`) ne tire qu'au viseur. Un poseur de mines sème, une soute à bombes largue, dès qu'on appuie ; un missile
 * anti-aérien prend pour cible le robot en vol le plus proche de la visée.
 */
function operatePlayerTurrets(sim: Simulation, bot: Bot, input: PlayerInput, dt: number): void {
  const ready: ShotRequest[] = [];
  for (const t of liveTurrets(bot)) {
    const weapon = weaponDef(t.weapon);
    tickArm(t.arm, weapon, dt);
    // Paralysée localement (lance électrique, combat/emp.ts) : elle se fige et se tait
    if (organStunned(sim, t.block)) continue;
    // Tourelle de soin automatique (nanites) : elle choisit et soigne ses alliés seule
    if (weapon.autoSupport) {
      if (!operateSupport(sim, bot, t, weapon, ready)) restTurret(t);
      continue;
    }
    const armed = input.trigger && (input.weapon === null || input.weapon === t.weapon) && (!weapon.scopeOnly || input.scope);
    if (released(weapon)) {
      if (armed && turretReady(t) && !lineOfFireBlocked(t)) ready.push({ turret: t, homing: null });
      continue;
    }
    if (!input.aim) continue;
    // Le point visé (un missile téléguidé suit, lui, l'axe de son lance-missiles : voir `steer`)
    t.aim = input.aim;
    // Les tourelles des autres armes reviennent au repos (elles ne tirent pas, ne verrouillent rien)
    if (input.weapon !== null && input.weapon !== t.weapon) {
      restTurret(t);
      if (weapon.lock) releaseLock(t);
      continue;
    }
    const frame = turretFrame(t);
    // Tir en cloche : le canon pointe droit vers le réticule, la hausse est celle du joueur (à la
    // butée de la tourelle s'il vise plus haut ou plus bas). Sinon, correction balistique ; le
    // projectile part avec la vitesse du robot : on la retranche, pour qu'il arrive au point visé
    if (lobbed(weapon)) aimTurret(t, lobDirection(frame.muzzle, input.aim, muzzleVelocity(t, frame.muzzle), weapon.projectile.speed), true);
    else aimTurret(t, firingDirection(frame.muzzle, input.aim, scale(t.block.part.rb.linvel(), -1), weapon));
    // Arme à verrouillage : l'arme choisie verrouille l'ennemi le plus proche du réticule
    // Le joueur ne verrouille qu'au viseur (clic droit) ; en le quittant, le verrou retombe
    if (weapon.lock) {
      if (input.scope) updateLock(sim, t, frame.muzzle, norm(sub(input.aim, frame.muzzle)), dt);
      else releaseLock(t);
    }
    // Le coup part de la bouche, dans l'axe où pointe vraiment le canon (la tourelle tourne à sa
    // vitesse vers le réticule : le HUD montre où il pointe) ; il n'attend pas d'être aligné. Une
    // arme masquée par son propre robot ne tire pas (ses tirs le traverseraient)
    if (armed && turretReady(t) && !lineOfFireBlocked(t) && (!weapon.lock || isLocked(t))) {
      const guidance = weapon.projectile.guidance;
      const homing = weapon.lock ? t.lockOn
        : guidance?.mode === "homing" ? findHomingTarget(sim, frame.muzzle, frame.dir, !!guidance.airOnly, bot) : null;
      ready.push({ turret: t, homing, spread: aimSpread(bot, weapon, input.scope) });
    }
  }
  // Des armes identiques tirent à tour de rôle
  fireInTurn(sim, bot, ready);
}
