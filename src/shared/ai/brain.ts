import RAPIER from "@dimforge/rapier3d-compat";
import { lavaAt } from "../arena/features";
import { deepWaterAt, flightLevel, type ArenaLayout } from "../arena/layout";
import { edgeAhead, onNav, surfaceHeight } from "../arena/navGraph";
import { nearestPassable, onBridge, passable } from "../arena/navgrid";
import { wheelDef } from "../catalog/wheels";
import { areEnemies } from "../combat/projectiles";
import type { BotProfile } from "../design/presets";
import { clamp, rand, randSign } from "../math/scalar";
import { add, flatDistance, norm, qrot, scale, vec3, type Vec3 } from "../math/vec";
import { isStunned } from "../combat/emp";
import { cutPower, drive, flyToward, idleThrusters, runEngines } from "../robot/propulsion";
import { groundedSupports, liveSupports } from "../robot/supports";
import { energyFraction } from "../robot/energy";
import { foeInJet, scorchesItself } from "../robot/exhaust";
import { ownerBot } from "../robot/colliders";
import { blockWorldPos, drivenWheelCount, drivenWheels, liveThrusters } from "../robot/queries";
import { FLIPPED_UP_Y, unstick, updateRighting } from "../robot/righting";
import { rolloverAccel, steeringGeometry } from "../robot/steering";
import type { AiMode, AiState, Bot } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { thinkFlares } from "../combat/decoys";
import { operateTurrets } from "./gunner";
import { meleeBearing, meleeBiting, meleeDrive, meleeSkim, operateMelee } from "./brawl";
import { avoidMines, insideObstacle, navigate } from "./navigation";
import { thinkPlane } from "./pilot";
import { thinkPlayer } from "../sim/player";
import { clampToRoam, coverSpot, createTactics, objectiveZone, planCombat } from "./tactics";
import { dcos, dsin } from "../math/det";

/** Modes où le robot ne peut plus rien faire. */
const DISABLED_MODES: ReadonlySet<AiMode> = new Set(["flipped", "stranded", "falling", "dead"]);

/** Distance à laquelle une destination est considérée comme atteinte (m). */
const ARRIVED = 3;
/** Altitude d'un robot volant qui se cache derrière un pilier, ou qui va s'y poser (m). */
const COVER_ALT = 1.8;
/** Au-dessus des toits (`ArenaBounds.hoverFloor`), il ne descend qu'à moins de cette distance de sa destination (m). */
const DESCENT = 6;
/**
 * Distance du point vers lequel fuit un avion (m) : bien au-delà de son rayon de virage ; mais ce
 * point reste à PLANE_FLEE_REACH m du centre au plus, pour que l'avion ne quitte pas le combat.
 */
const PLANE_FLEE_DISTANCE = 80;
const PLANE_FLEE_REACH = 1.25;
/** Vitesse au-delà de laquelle un robot à roues n'allume plus son propulseur (m/s). */
const BOOST_MAX_SPEED = 11;
/** Tension moyenne des moteurs au-delà de laquelle un robot immobile est considéré comme coincé. */
const STUCK_DRIVE = 0.12;
/** Temps coincé malgré les manœuvres avant que le gyroscope ne le fasse bondir (s). */
const UNSTICK_DELAY = 6;
/**
 * Gaz quand la cible est derrière : en conduite différentielle, le robot pivote presque sur place ;
 * avec des roues directrices, il lui faut de l'élan pour faire demi-tour.
 */
const PIVOT_THROTTLE = 0.25;
const U_TURN_THROTTLE = 0.5;
/** Sous cette charge, un robot volant se pose pour recharger ; il repart au-dessus de RECHARGED. */
const LOW_ENERGY = 0.15;
const RECHARGED = 0.9;
/** Posé : hauteur (m) et vitesse (m/s) sous lesquelles il coupe ses moteurs pour finir de se poser. */
const TOUCHDOWN_HEIGHT = 1.3;
const TOUCHDOWN_SPEED = 1.5;
/** Part de l'accélération latérale de renversement que le pilote s'autorise en virage. */
const CORNER_SAFETY = 0.5;
/**
 * Anticipation des obstacles : durée de trajet regardée devant (s), portée minimale au-delà du
 * robot (m), écart des rayons de côté (rad), et hauteur des rayons au-dessus du sol (m) : assez
 * bas pour voir une caisse, assez haut pour passer au-dessus d'une bordure.
 */
const LOOKAHEAD = 1.3;
const LOOKAHEAD_MIN = 3;
const PROBE_SPREAD = 0.5;
const PROBE_HEIGHT = 0.6;
/** Les rayons d'évitement se relancent à cet intervalle (s) : entre deux, le robot garde leurs distances. */
const PROBE_PERIOD = 0.05;
/** Distances mesurées par les rayons d'évitement (devant, à gauche, à droite), et jusqu'à quand elles valent. */
const probes = new WeakMap<Bot, { ahead: number; left: number; right: number; until: number }>();
/** Au-dessus de ce cosinus, une surface touchée est une pente praticable (rampe), pas un obstacle. */
const SLOPE_UP_Y = 0.6;
/** La lave et l'eau profonde comptent comme un obstacle à moins de HAZARD_MARGIN m de leur bord ; on les cherche par pas de HAZARD_STEP m. */
const HAZARD_MARGIN = 1.5;
const HAZARD_STEP = 1;

/**
 * Distance (m) le long de `dir` (horizontal, unitaire) à laquelle on entre dans la lave ou l'eau
 * profonde (avec une marge), au plus `reach` ; Infinity s'il n'y en a pas, ou si l'arène n'a ni
 * l'une ni l'autre. Le robot qui y est déjà n'en est pas empêché d'en sortir.
 */
function hazardDistance(arena: ArenaLayout, from: Vec3, dir: Vec3, reach: number): number {
  if (!arena.lava && arena.deepWater === undefined) return Infinity;
  // Un pont passe au-dessus de l'eau : ce n'est pas un danger
  const danger = (x: number, z: number): boolean =>
    (lavaAt(arena.lava, x, z, HAZARD_MARGIN) > -HAZARD_MARGIN || deepWaterAt(arena, x, z)) && !onBridge(arena, x, z);
  if (danger(from.x, from.z)) return Infinity;
  for (let d = HAZARD_STEP; d <= reach; d += HAZARD_STEP) {
    if (danger(from.x + dir.x * d, from.z + dir.z * d)) return d;
  }
  return Infinity;
}

/** Tension moyenne appliquée aux moteurs des roues motrices (0 à 1). */
function averageDrive(bot: Bot): number {
  const wheels = drivenWheels(bot);
  return wheels.length ? wheels.reduce((s, w) => s + Math.abs(w.drive), 0) / wheels.length : 0;
}

export function createAiState(profile: BotProfile, pos: Vec3): AiState {
  const ai: AiState = {
    mode: "patrol",
    target: pos,
    timer: 0,
    modeT: 0,
    stuckT: 0,
    blockedT: 0,
    flip: 1,
    alt: profile.mobility === "hover" ? rand(4.5, 6.5) : profile.mobility === "plane" ? rand(10, 14) : 0,
    trim: 0,
    slip: 0,
    bombRun: null,
    tactics: createTactics(),
  };
  // Pas encore de destination : il en choisit une à sa première décision (pickPatrolTarget)
  return ai;
}

/** Le robot peut encore se déplacer (cockpit intact, pas renversé ni immobilisé). */
export function isOperational(bot: Bot): boolean {
  return bot.cockpit.alive && !DISABLED_MODES.has(bot.ai.mode);
}

/**
 * Choisit une destination de patrouille : en capture de zones, un point de la zone à prendre ou à
 * tenir (il y tourne tant qu'elle n'est pas à son équipe), à sa hauteur (une zone sur une voie
 * surélevée y fait monter, voir ai/navigation.ts) ; sinon, un point au hasard.
 */
function pickPatrolTarget(sim: Simulation, bot: Bot, from: Vec3): void {
  const objective = objectiveZone(sim, bot, from);
  if (!objective) {
    wander(sim, bot, from);
    return;
  }
  const { pos, radius } = objective.zone;
  const a = rand(0, Math.PI * 2);
  const r = rand(0, radius * 0.6);
  bot.ai.target = vec3(pos.x + dcos(a) * r, pos.y, pos.z + dsin(a) * r);
  bot.ai.timer = rand(6, 10);
}

/**
 * Une destination au hasard dans la zone où rôde l'IA, à plus de 10 m de `from`, là où l'on peut
 * aller : ni dans la mer, la lave ou sur un flanc trop raide (arena/navgrid.ts), ni sur une butte
 * qu'aucun sentier ne relie (arena/navGraph.ts) ; en ville, dans la rue (pas dans un bâtiment, où
 * un robot au sol n'arriverait jamais).
 */
function wander(sim: Simulation, bot: Bot, from: Vec3): void {
  const ai = bot.ai;
  const roam = sim.arena.bounds.roam - 3;
  const { nav, terrain } = sim.arena;
  const street = sim.arena.urban && bot.profile.mobility !== "hover" && bot.profile.mobility !== "plane";
  for (let i = 0; i < 12; i++) {
    const t = vec3(rand(-roam, roam), 0, rand(-roam, roam));
    if (
      flatDistance(t, from) > 10 && passable(sim.arena, t.x, t.z) && (!nav || !terrain || onNav(terrain, nav.points, t.x, t.z)) &&
      !(street && insideObstacle(sim, t, bot.radius + 1))
    ) {
      ai.target = t;
      break;
    }
  }
  ai.timer = rand(10, 16);
}

/**
 * Altitude de croisière d'un robot volant de l'IA au-dessus du relief : la sienne, mais au-dessus
 * des toits d'une ville (`ArenaBounds.hoverFloor`).
 */
function cruiseAlt(sim: Simulation, ai: AiState): number {
  return Math.max(ai.alt, sim.arena.bounds.hoverFloor ?? 0);
}

/**
 * Altitude où un robot volant de l'IA descend pour s'abriter ou se poser : COVER_ALT, mais
 * seulement une fois arrivé au-dessus de sa destination quand il y a des toits à survoler.
 */
function lowAlt(sim: Simulation, ai: AiState, pos: Vec3): number {
  return sim.arena.bounds.hoverFloor && flatDistance(ai.target, pos) > DESCENT ? cruiseAlt(sim, ai) : COVER_ALT;
}

/**
 * Réaction à un tir venu de `shooter`. En plein combat ou à couvert, il ne rompt pas : il tourne
 * déjà autour de son adversaire, ce qui le rend dur à toucher ; en capture de zones, il continue
 * vers sa zone. Sinon, il fuit, ou charge s'il est fait pour ça.
 */
export function onHit(sim: Simulation, bot: Bot, shooter: Vec3): void {
  if (!bot.cockpit.alive) return;
  const ai = bot.ai;
  const pos = bot.lastPos;
  if (ai.mode === "engage" || ai.mode === "cover" || ai.mode === "support" || ai.tactics.holding) return;
  if (bot.profile.behavior === "charge") {
    ai.mode = "charge";
    ai.target = clampToRoam(sim, shooter);
    ai.modeT = 5;
  } else {
    const away = norm(vec3(pos.x - shooter.x, 0, pos.z - shooter.z));
    ai.mode = "flee";
    ai.modeT = 4;
    if (bot.profile.mobility === "plane") {
      // Un avion vire large : un point proche le ferait tourner en rond en perdant de l'altitude
      const flee = add(pos, scale(away, PLANE_FLEE_DISTANCE));
      const reach = Math.hypot(flee.x, flee.z);
      const limit = sim.arena.bounds.half * PLANE_FLEE_REACH;
      ai.target = reach > limit ? scale(flee, limit / reach) : flee;
      ai.alt = Math.min(ai.alt + 3, 20);
    } else {
      ai.target = clampToRoam(sim, add(pos, scale(away, 22)));
      if (bot.profile.mobility === "hover") ai.alt = Math.min(ai.alt + 1.5, 9);
    }
  }
}

/** Un pas de décision : choisit le mode, commande les roues, les rotors ou les gouvernes, puis les tourelles. */
export function thinkBot(sim: Simulation, bot: Bot, dt: number, paused: boolean): void {
  const ai = bot.ai;
  const ck = bot.cockpit;
  if (!ck.alive) {
    ai.mode = "dead";
    drive(sim, bot, 0, 0);
    return;
  }
  const pos = ck.part.rb.worldCom();
  bot.lastPos = pos;
  if (isStunned(sim, bot)) {
    ai.mode = "stunned";
    cutPower(sim, bot);
    return;
  }
  if (ai.mode === "stunned") ai.mode = "patrol";
  // Renversé : le gyroscope du cockpit le redresse (un avion, lui, n'en a pas)
  if (bot.profile.mobility !== "plane" && updateRighting(bot, dt)) {
    ai.mode = "flipped";
    drive(sim, bot, 0, 0);
    idleThrusters(bot);
    return;
  }
  if (bot.controller === "player") {
    thinkPlayer(sim, bot, bot.input ?? sim.input, dt);
    return;
  }
  // Un missile ennemi arrive : leurres
  if (!paused) thinkFlares(sim, bot);
  switch (bot.profile.mobility) {
    case "hover":
      sim.measure("ia › vol", () => thinkFlying(sim, bot, dt, paused, pos));
      break;
    case "plane":
      sim.measure("ia › vol", () => thinkPlane(sim, bot, dt)); // un avion ne peut pas s'arrêter en l'air : il ignore la pause
      break;
    case "ground":
      sim.measure("ia › conduite", () => runEngines(bot, thinkGround(sim, bot, dt, paused, pos)));
      break;
  }
  if (!paused && sim.combat && bot.turrets.length) sim.measure("ia › tourelles", () => operateTurrets(sim, bot, dt));
  // Armes de contact : lancer les rotors, frapper du marteau (ai/brawl.ts)
  if (!paused && sim.combat && bot.melee.length) operateMelee(sim, bot);
}

/**
 * Conduite au sol. Renvoie les gaz des propulseurs éventuels : à fond en fuite ou en charge,
 * quand le robot est bien aligné sur sa cible.
 */
function thinkGround(sim: Simulation, bot: Bot, dt: number, paused: boolean, pos: Vec3): number {
  const ai = bot.ai;
  const rb = bot.cockpit.part.rb;
  const q = rb.rotation();
  const up = qrot(q, vec3(0, 1, 0));
  if (up.y < FLIPPED_UP_Y) {
    ai.mode = "flipped";
    drive(sim, bot, 0, 0);
    return 0;
  }
  if (drivenWheelCount(bot) === 0 && !liveSupports(bot).length) {
    ai.mode = "stranded";
    return 0;
  }
  if (paused) {
    ai.mode = "paused";
    drive(sim, bot, 0, 0);
    return 0;
  }
  if (ai.mode === "flipped" || ai.mode === "stranded" || ai.mode === "paused") ai.mode = "patrol";

  ai.modeT -= dt;
  ai.timer -= dt;
  if ((ai.mode === "flee" || ai.mode === "charge" || ai.mode === "reverse") && ai.modeT <= 0) {
    ai.mode = "patrol";
    pickPatrolTarget(sim, bot, pos);
  }
  // En combat : engager, se mettre à couvert, charger (sauf pendant une fuite ou un dégagement)
  if (sim.combat && ai.mode !== "flee" && ai.mode !== "reverse") planCombat(sim, bot, pos, dt);
  if (ai.mode === "patrol" && (ai.timer <= 0 || flatDistance(ai.target, pos) < ARRIVED)) pickPatrolTarget(sim, bot, pos);

  const fwd = qrot(q, vec3(0, 0, 1));
  const f = norm(vec3(fwd.x, 0, fwd.z));
  // Autour du décor : le coin d'un muret, le pied d'une rampe (navigation.ts)
  const goal = avoidMines(sim, bot, pos, navigate(sim, bot, pos, ai.target));
  const d = norm(vec3(goal.x - pos.x, 0, goal.z - pos.z));
  let ang = Math.atan2(f.z * d.x - f.x * d.z, f.x * d.x + f.z * d.z); // > 0 : la cible est à gauche
  // En chargeant, il présente son arme de contact à sa cible (montée sur un côté de l'avant)
  if (ai.mode === "charge") {
    // (une scie qui mord longe sa cible : `meleeSkim`, ai/brawl.ts)
    const bearing = (meleeBearing(bot) ?? 0) + meleeSkim(bot);
    if (bearing !== 0) ang = Math.atan2(dsin(ang - bearing), dcos(ang - bearing));
  }

  const { maxCurvature } = steeringGeometry(bot);
  const steered = maxCurvature > 0;
  let throttle: number;
  let steer: number;
  if (ai.mode === "reverse") {
    throttle = -0.7;
    steer = ai.flip;
  } else {
    steer = clamp(ang * 1.6, -1, 1);
    throttle = Math.abs(ang) > 1.3 ? (steered ? U_TURN_THROTTLE : PIVOT_THROTTLE) : 1 - 0.45 * Math.abs(ang);
    if (ai.mode === "flee" || ai.mode === "charge") throttle = Math.min(1, throttle * 1.25);
  }
  // Sa mâchoire tient une proie : il recule en la traînant (ai/brawl.ts) ; ni coincé, ni à dégager
  const held = bot.melee.length ? meleeDrive(bot) : null;
  if (held) {
    drive(sim, bot, held.throttle, held.steer);
    ai.stuckT = 0;
    ai.blockedT = 0;
    return 0;
  }

  // Coincé contre un mur ou un obstacle (les moteurs poussent mais le robot n'avance ni ne tourne) :
  // marche arrière en braquant. Avec des roues directrices, il recule en contre-braquant pour que
  // son nez pivote vers la cible (manœuvre en trois temps) ; en conduite différentielle, le sens
  // importe peu
  const v = rb.linvel();
  const speed = Math.hypot(v.x, v.z);
  const spin = Math.abs(rb.angvel().y);
  // (une lame qui mord un robot : il pousse dedans, il n'est pas coincé)
  const pushing = averageDrive(bot) > STUCK_DRIVE && !(bot.melee.length && meleeBiting(bot));
  if (ai.mode !== "reverse" && pushing && speed < 0.5 && spin < 0.35) ai.stuckT += dt;
  else ai.stuckT = Math.max(0, ai.stuckT - dt);
  if (ai.stuckT > 1.6) {
    ai.mode = "reverse";
    ai.modeT = 1.3;
    ai.flip = steered ? (ang > 0 ? -1 : 1) : randSign();
    ai.stuckT = 0;
  }
  // Ni l'avant ni l'arrière ne le sortent de là : le gyroscope le fait bondir
  if (pushing && speed < 0.5) ai.blockedT += dt;
  else if (speed > 1) ai.blockedT = 0;
  if (ai.blockedT > UNSTICK_DELAY) {
    unstick(bot);
    ai.blockedT = 0;
  }

  if (throttle > 0) [throttle, steer] = avoidObstacles(sim, bot, pos, f, speed, throttle, steer);
  if (steered && throttle > 0) [throttle, steer] = limitCornering(bot, maxCurvature, throttle, steer, speed);

  // Propulseur éventuel : à fond en fuite ou en charge, bien aligné et sous la vitesse limite ;
  // les roues aident alors sans jamais retenir (roue libre à cliquet : voir `DriveOptions`). Un
  // ennemi collé à son arrière, dans le jet de ses propulseurs : il les allume aussi, le jet le brûle
  // (robot/exhaust.ts). Jamais s'ils brûleraient son propre robot (un plan du garage avec un bloc
  // derrière une tuyère)
  const engines = liveThrusters(bot, "cruise").length > 0;
  const rushing = (ai.mode === "flee" || ai.mode === "charge") && Math.abs(ang) < 0.35 && speed < BOOST_MAX_SPEED;
  const scorching = engines && !rushing && ai.mode !== "reverse" && throttle > 0 && foeInJet(sim, bot, "cruise");
  const boost = engines && (rushing || scorching) && !scorchesItself(bot, "cruise");
  drive(sim, bot, throttle, steer, { boost });
  return boost ? 1 : 0;
}

/**
 * Évitement des obstacles : trois rayons horizontaux partent du robot, droit devant et de biais,
 * aussi loin qu'il roulera dans LOOKAHEAD s. Un obstacle droit devant (décor, accessoire, autre
 * robot) le fait ralentir et braquer du côté le plus dégagé, d'autant plus qu'il est proche ; un
 * obstacle de biais l'en écarte un peu. En charge, il ne s'écarte pas des ennemis : il les percute.
 */
function avoidObstacles(
  sim: Simulation, bot: Bot, pos: Vec3, forward: Vec3, speed: number, throttle: number, steer: number,
): [number, number] {
  const reach = bot.radius + Math.max(LOOKAHEAD_MIN, speed * LOOKAHEAD);
  const from = vec3(pos.x, groundUnder(bot, pos) + PROBE_HEIGHT, pos.z);
  const ramming = bot.ai.mode === "charge";
  const probe = (angle: number): number => {
    const c = dcos(angle);
    const s = dsin(angle);
    const dir = vec3(forward.x * c + forward.z * s, 0, -forward.x * s + forward.z * c);
    const hit = sim.world.castRayAndGetNormal(
      new RAPIER.Ray(from, dir), reach, true, undefined, undefined, undefined, undefined,
      (collider) => {
        const owner = sim.colliders.get(collider.handle);
        if (owner?.kind === "debris") return false;
        const other = ownerBot(owner);
        return other !== bot && !(ramming && other && areEnemies(bot, other));
      },
    );
    // La lave et la mer arrêtent aussi le robot, sans qu'aucun rayon ne les voie
    const at = Math.min(!hit || hit.normal.y > SLOPE_UP_Y ? Infinity : hit.timeOfImpact, hazardDistance(sim.arena, from, dir, reach));
    // Là où le relief a des falaises (arène à réseau de passage), le bord d'où il tomberait, ou la
    // pente qu'il ne monterait pas, compte comme un obstacle : les rayons ne voient pas le vide
    return surface ? Math.min(at, edgeAhead(surface, pos.x, pos.z, dir.x, dir.z, reach)) : at;
  };
  const arena = sim.arena;
  const level = from.y - PROBE_HEIGHT;
  const surface = arena.nav && arena.terrain ? (x: number, z: number): number => surfaceHeight(arena, x, z, level) : null;
  let seen = probes.get(bot);
  if (!seen || sim.time >= seen.until) {
    const fresh = { ahead: 0, left: 0, right: 0, until: sim.time + PROBE_PERIOD };
    sim.measure("ia › rayons", () => {
      fresh.ahead = probe(0);
      fresh.left = probe(PROBE_SPREAD);
      fresh.right = probe(-PROBE_SPREAD);
    });
    probes.set(bot, (seen = fresh));
  }
  const { ahead, left, right } = seen;
  const side = left >= right ? 1 : -1; // > 0 : le côté gauche est plus dégagé
  if (ahead < reach) {
    const closeness = 1 - ahead / reach; // 0 au bout de la portée, 1 au contact
    return [Math.min(throttle, Math.max(0.2, 1 - closeness)), clamp(steer + side * (0.5 + closeness), -1, 1)];
  }
  if (Math.min(left, right) < reach * 0.6) return [throttle, clamp(steer + side * 0.4, -1, 1)];
  return [throttle, steer];
}

/** Hauteur du sol sous le robot : sous ses roues, ou sous ses appuis, sinon sous son centre de masse. */
function groundUnder(bot: Bot, pos: Vec3): number {
  let ground = Infinity;
  for (const w of drivenWheels(bot)) ground = Math.min(ground, w.rb.translation().y - wheelDef(w.type).radius);
  for (const s of groundedSupports(bot)) ground = Math.min(ground, blockWorldPos(s.block).y - s.contact);
  return Number.isFinite(ground) ? ground : pos.y - 1;
}

/** Descend à la verticale jusqu'au sol, puis coupe les moteurs. */
function land(sim: Simulation, bot: Bot, pos: Vec3): void {
  const hit = sim.world.castRay(
    new RAPIER.Ray(pos, vec3(0, -1, 0)), 50, true, undefined, undefined, undefined, undefined,
    (c) => {
      const owner = sim.colliders.get(c.handle);
      return owner?.kind !== "debris" && ownerBot(owner) !== bot;
    },
  );
  const height = hit ? hit.timeOfImpact : pos.y;
  const v = bot.cockpit.part.rb.linvel();
  if (height < TOUCHDOWN_HEIGHT && Math.hypot(v.x, v.y, v.z) < TOUCHDOWN_SPEED) idleThrusters(bot);
  else flyToward(bot, vec3(pos.x, pos.y - height + TOUCHDOWN_HEIGHT * 0.6, pos.z));
}

/**
 * Virages d'un robot à roues directrices : le pilote n'en prend pas de plus serré que ce que la
 * stabilité du robot permet à sa vitesse (il l'élargit), et ralentit pour pouvoir le serrer
 * ensuite. `maxCurvature` : celle de sa géométrie de direction (voir `steeringGeometry`).
 */
function limitCornering(bot: Bot, maxCurvature: number, throttle: number, steer: number, speed: number): [number, number] {
  const lateral = CORNER_SAFETY * rolloverAccel(bot);
  const wanted = Math.abs(steer) * maxCurvature;
  if (wanted === 0 || !Number.isFinite(lateral)) return [throttle, steer];
  const safeSpeed = Math.sqrt(lateral / wanted);
  const allowed = lateral / Math.max(speed * speed, 1e-6) / maxCurvature;
  return [Math.min(throttle, safeSpeed / bot.profile.speed), clamp(steer, -allowed, allowed)];
}

function thinkFlying(sim: Simulation, bot: Bot, dt: number, paused: boolean, pos: Vec3): void {
  const ai = bot.ai;
  if (!liveThrusters(bot).length) {
    ai.mode = "falling";
    return;
  }
  if (paused) {
    ai.mode = "hover";
    flyToward(bot, vec3(pos.x, flightLevel(sim.arena, pos, pos, cruiseAlt(sim, ai)), pos.z));
    return;
  }
  // Batteries presque vides : il se pose (à l'abri s'il est en combat), recharge, puis repart
  const charge = energyFraction(bot);
  if (ai.mode === "landing" ? charge < RECHARGED : charge < LOW_ENERGY) {
    if (ai.mode !== "landing") ai.target = nearestPassable(sim.arena, ai.tactics.foe ? coverSpot(sim, bot, pos, ai.tactics.foe.lastPos) : pos);
    ai.mode = "landing";
    if (flatDistance(ai.target, pos) > ARRIVED) flyToward(bot, vec3(ai.target.x, flightLevel(sim.arena, pos, ai.target, lowAlt(sim, ai, pos)), ai.target.z));
    else land(sim, bot, pos);
    return;
  }
  if (ai.mode === "landing") {
    ai.mode = "patrol";
    pickPatrolTarget(sim, bot, pos);
  }
  ai.modeT -= dt;
  ai.timer -= dt;
  if (ai.mode === "flee" && ai.modeT <= 0) {
    ai.mode = "patrol";
    pickPatrolTarget(sim, bot, pos);
    ai.alt = Math.max(4.5, ai.alt - 1.5);
  }
  if (sim.combat && ai.mode !== "flee") planCombat(sim, bot, pos, dt);
  if (ai.mode === "patrol" && (ai.timer <= 0 || flatDistance(ai.target, pos) < ARRIVED)) pickPatrolTarget(sim, bot, pos);
  // À couvert, il descend derrière le pilier (en ville, une fois au-dessus de lui)
  flyToward(bot, vec3(ai.target.x, flightLevel(sim.arena, pos, ai.target, ai.mode === "cover" ? lowAlt(sim, ai, pos) : cruiseAlt(sim, ai)), ai.target.z));
}
