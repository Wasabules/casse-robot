import type { SdpMatrix3 } from "@dimforge/rapier3d-compat";
import { blockDef, type ThrusterSpec } from "../catalog/blocks";
import { wheelDef } from "../catalog/wheels";
import { DRIVE_RAMP, GRAVITY, STEP } from "../config";
import { boundedLeastSquares } from "../math/linalg";
import { clamp, rand } from "../math/scalar";
import { add, cross, dot, len, norm, qrot, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { Bot, Thruster } from "../sim/entities";
import { blockWorldPos, liveThrusters } from "./queries";
import { supply } from "./energy";
import { driveSupports } from "./supports";
import type { Simulation } from "../sim/simulation";
import { aimWheel, cornerSpeedRatio, pitchoverAccel, steerAngle, steeringGeometry } from "./steering";

/**
 * Temps de réponse de l'inclinaison d'un rotor orientable (s) : le plateau cyclique réagit bien
 * plus vite que le régime du rotor, sans quoi l'assiette oscille.
 */
const TILT_TIME = 0.06;
/** Inclinaison maximale en vol (rad), environ 25°. */
const MAX_TILT = 0.42;
/** Pilote automatique : raideur et amortissement de l'assiette (1/s² et 1/s), amortissement du lacet (1/s). */
const ATTITUDE_KP = 30;
const ATTITUDE_KD = 9;
/** Le lacet ne se contrôle qu'avec les couples de réaction des hélices, faibles : on l'amortit sans insister. */
const YAW_KD = 1;
/**
 * Avec un rotor de queue (réacteur de côté), le lacet se contrôle franchement : amortissement
 * plus fort, et il n'est plus sacrifié le premier dans la répartition.
 */
const YAW_KD_TAIL = 4;
const WEIGHT_YAW_TAIL = 0.5;
/** Part de la poussée totale que le contrôle du lacet peut déséquilibrer entre les hélices. */
const YAW_SHARE = 0.12;
/**
 * Priorités de la répartition de poussée quand les réacteurs ne peuvent pas tout faire :
 * garder l'assiette d'abord, puis la poussée ; le contrôle du lacet est sacrifié en premier.
 */
const WEIGHT_ATTITUDE = 10;
const WEIGHT_THRUST = 1;
const WEIGHT_YAW = 0.001;
/**
 * Lacet piloté par le joueur (voir `flyToward`) : il tient sa vitesse de lacet franchement (raideur
 * `YAW_KP_PILOT`, 1/s), les hélices peuvent se déséquilibrer davantage pour lui (`YAW_SHARE_PILOT`)
 * et il passe avant la poussée verticale, mais pas avant l'assiette. Sans cela, un Drone pivotait à
 * peine et dérivait de lui-même d'une trentaine de degrés en 3 s. L'IA garde le réglage d'avant.
 */
const YAW_KP_PILOT = 3;
const YAW_SHARE_PILOT = 0.35;
const WEIGHT_YAW_PILOT = 0.5;
/**
 * Gyroscope de lacet du cockpit (robot volant piloté) : tant que le joueur tient A ou E, et un moment
 * après (`yaw.assist`, de 1 à 0), il pousse le robot vers la vitesse de lacet voulue (raideur
 * `GYRO_KP`, 1/s), sans dépasser l'accélération angulaire `GYRO_ACCEL` (rad/s²). Les couples de
 * réaction des hélices d'un Drone n'y suffisent pas (~0,2 rad/s² au plus : il lui fallait 7 s pour
 * s'arrêter de tourner). Hors de ces moments, il ne fait rien : un hélicoptère qui perd son rotor de
 * queue tourne encore sur lui-même.
 */
const GYRO_KP = 4;
const GYRO_ACCEL = 3;

/**
 * Sprint des moteurs (boost du joueur) : la vitesse voulue est multipliée par SPRINT, et la
 * tension des moteurs des roues peut monter jusqu'à SPRINT (surtension : une roue va alors jusqu'à
 * SPRINT fois sa vitesse à vide) ; patins et pattes visent aussi SPRINT fois leur vitesse. La
 * surtension puise SPRINT_POWER kW, plus que ne produit le générateur : batteries vides, le sprint
 * retombe à la part que le générateur peut fournir.
 */
export const SPRINT = 1.3;
const SPRINT_POWER = 1.5;
/**
 * Frein : chaque roue freine jusqu'à BRAKE_GRIP de ce que son pneu peut porter (elle ne se bloque
 * pas, et tient encore de côté), et pas plus fort que ne le permet la stabilité du robot :
 * PITCH_MARGIN de la décélération qui le ferait basculer par-dessus ses roues de devant (de
 * derrière en marche arrière).
 */
const BRAKE_GRIP = 0.85;
const PITCH_MARGIN = 0.85;

/** Consignes de conduite, en plus des gaz et de la direction. */
export interface DriveOptions {
  /**
   * Boost : les propulseurs poussent (voir `runEngines`) ; les roues et les appuis aident sans
   * jamais retenir le robot (roue libre à cliquet : au-delà de la vitesse que vise leur moteur,
   * elles tournent librement).
   */
  boost?: boolean;
  /** Sprint des moteurs des roues et des appuis (voir SPRINT) : le boost du joueur. */
  sprint?: boolean;
  /** Frein, de 0 à 1 : il prime sur le reste (gaz, boost, sprint). */
  brake?: number;
}

/**
 * Conduite : `throttle` et `steer` vont de -1 à 1 (steer > 0 : à gauche). Seules les roues du
 * morceau du cockpit sont motorisées et dirigées ; les autres sont en roue libre, et leur fusée
 * pivote librement.
 *
 * Avec des roues directrices, `steer` fixe la courbure du virage (1 : le plus serré possible) :
 * elles braquent selon l'épure d'Ackermann, et chaque roue motrice tourne à la vitesse de sa
 * propre trajectoire autour du centre de rotation (différentiel). Sans roue directrice, ou quand
 * elles ont été arrachées, le robot tourne en conduite différentielle : les roues d'un côté
 * ralentissent, celles de l'autre accélèrent, et les pneus ripent.
 *
 * Chaque roue a son moteur électrique : la tension appliquée (de -1 à 1, avec une rampe) fixe
 * la vitesse visée, et le couple vaut stallTorque × (tension − vitesse / freeSpeed), borné à
 * stallTorque. Plus le robot est lourd pour ses roues, plus il accélère, grimpe et tourne mal.
 * Relâcher les gaz, c'est donc déjà freiner par le moteur ; plus vite que ce que vise le moteur
 * (un propulseur pousse le robot), il retient.
 *
 * `boost` : le moteur ne pousse que dans le sens commandé, jamais à contresens (roue libre à
 * cliquet) ; `sprint` : multiplie la vitesse voulue et la tension permise (surtension) ; `brake` :
 * le moteur est débrayé (sa tension suit toujours la commande, pour repartir sans attendre) et la
 * roue freine (robot/wheels.ts), dans la limite de son adhérence et de la stabilité du robot. Une
 * roulette n'a ni moteur ni frein. La direction reste commandée dans tous les cas.
 */
export function driveWheels(bot: Bot, throttle: number, steer: number, boost = false, sprint = 1, brake = 0): void {
  const ck = bot.cockpit;
  const { speed, turn } = bot.profile;
  const maxStep = DRIVE_RAMP * STEP;
  const geo = steeringGeometry(bot);
  const curvature = steer * geo.maxCurvature;
  // Frein : jusqu'où peut-on décélérer sans basculer, dans le sens où roule le robot
  let tip = Infinity;
  if (brake > 0 && ck.alive) {
    const rb = ck.part.rb;
    tip = pitchoverAccel(bot, dot(rb.linvel(), qrot(rb.rotation(), vec3(0, 0, 1))) >= 0);
  }
  for (const w of bot.wheels) {
    if (!w.part) continue;
    const def = wheelDef(w.type);
    const powered = ck.alive && w.part === ck.part;
    w.powered = powered;
    // Une roulette n'a pas de moteur : elle roule librement
    const motor = powered && def.stallTorque > 0;
    w.engaged = motor && brake === 0;
    w.overrun = boost;
    w.brake = motor ? brake * BRAKE_GRIP * Math.min(1, (PITCH_MARGIN * tip) / (BRAKE_GRIP * def.grip * GRAVITY)) : 0;
    aimWheel(w, powered ? steerAngle(w, curvature, geo.pivotZ) : null);
    if (motor) {
      // Vitesse voulue au sol (m/s), rapportée à la vitesse à vide de la roue
      const ground = geo.maxCurvature > 0
        ? throttle * speed * sprint * cornerSpeedRatio(w, curvature, geo.pivotZ)
        : throttle * speed * sprint - w.side * steer * turn;
      const wanted = clamp(ground / (def.freeSpeed * def.radius), -sprint, sprint);
      w.drive += clamp(wanted - w.drive, -maxStep, maxStep);
    } else {
      w.drive = 0;
    }
  }
}

/**
 * Part de vitesse en plus que donne le sprint (1 : rien) : SPRINT, ou moins si les batteries sont
 * vides ; la surtension est décomptée de l'énergie du robot.
 */
function sprintFactor(bot: Bot): number {
  const k = supply(bot, SPRINT_POWER);
  bot.drawn += SPRINT_POWER * k;
  return 1 + (SPRINT - 1) * k;
}

/**
 * Conduite au sol, tous organes confondus : roues (et chenilles) et appuis (patins, pattes).
 * Mêmes consignes que `driveWheels` ; `options` : boost, sprint, frein (voir `DriveOptions`).
 */
export function drive(sim: Simulation, bot: Bot, throttle: number, steer: number, options: DriveOptions = {}): void {
  const brake = clamp(options.brake ?? 0, 0, 1);
  const boost = !!options.boost && brake === 0;
  const sprint = options.sprint && brake === 0 && throttle !== 0 && bot.cockpit.alive ? sprintFactor(bot) : 1;
  driveWheels(bot, throttle, steer, boost, sprint, brake);
  driveSupports(sim, bot, throttle, steer, true, { overrun: boost, speedFactor: sprint, brake });
}

/**
 * Électronique coupée (impulsion électromagnétique) : les moteurs des roues passent en roue
 * libre (sans frein), la direction flotte, les réacteurs et les propulseurs s'éteignent (leur
 * poussée retombe à leur rythme), les patins retombent et les pattes se figent.
 */
export function cutPower(sim: Simulation, bot: Bot): void {
  driveSupports(sim, bot, 0, 0, false);
  for (const w of bot.wheels) {
    w.drive = 0;
    w.powered = false;
    w.engaged = false;
    w.overrun = false;
    w.brake = 0;
  }
  idleThrusters(bot);
}

/** Produit de la matrice d'inertie (symétrique, repère monde) par un vecteur. */
export function inertiaTimes(I: SdpMatrix3, v: Vec3): Vec3 {
  return vec3(
    I.m11 * v.x + I.m12 * v.y + I.m13 * v.z,
    I.m12 * v.x + I.m22 * v.y + I.m23 * v.z,
    I.m13 * v.x + I.m23 * v.y + I.m33 * v.z,
  );
}

const specOf = (t: Thruster): ThrusterSpec => blockDef(t.block.type).thruster!;

/**
 * Un axe de poussée : l'axe du bloc (de 0 à maxThrust) ou, pour un rotor orientable, l'un de ses
 * deux axes d'inclinaison (± maxThrust·sin(gimbal)).
 */
interface ThrustAxis {
  /** Direction (monde, unitaire) et bornes de la poussée sur cet axe (N). */
  dir: Vec3;
  lo: number;
  hi: number;
  /** Couple autour du centre de masse par newton de poussée sur cet axe, réaction de l'hélice comprise. */
  torque: Vec3;
}

/** Un réacteur vu depuis le centre de masse : sa position et ses axes de poussée. */
interface ThrusterArm {
  t: Thruster;
  spec: ThrusterSpec;
  p: Vec3;
  axes: ThrustAxis[];
}

function thrusterArms(thrusters: Thruster[], com: Vec3): ThrusterArm[] {
  return thrusters.map((t) => {
    const spec = specOf(t);
    const p = blockWorldPos(t.block);
    const q = t.block.part.rb.rotation();
    const r = sub(p, com);
    const axis = (local: Vec3, lo: number, hi: number, reaction: number): ThrustAxis => {
      const dir = qrot(q, local);
      return { dir, lo, hi, torque: add(cross(r, dir), scale(dir, reaction)) };
    };
    // Un moteur abîmé ne donne qu'une part de sa pleine poussée (rien pendant un raté) : le pilote le sait
    const max = spec.maxThrust * t.output;
    const axes = [axis(t.block.up, 0, max, -t.spin * spec.torqueRatio)];
    if (spec.gimbal) {
      const side = max * Math.sin(spec.gimbal);
      axes.push(axis(cross(t.block.up, t.block.forward), -side, side, 0), axis(t.block.forward, -side, side, 0));
    }
    return { t, spec, p, axes };
  });
}

/**
 * Le moteur rattrape sa consigne (N, par axe) avec son temps de réponse, puis pousse le corps ;
 * son hélice renvoie un couple opposé. Un rotor orientable ne s'incline pas au-delà de son cône.
 * Une hélice d'avion (`topSpeed`) pousse d'autant moins que l'air arrive vite le long de son axe :
 * `t.thrust` reste le régime du moteur (celui que montrent les pales), la force en est une part.
 */
function runMotor(a: ThrusterArm, command: readonly number[]): void {
  const { t, spec, axes } = a;
  const k = 1 - Math.exp(-STEP / spec.spoolTime);
  t.thrust += ((command[0] ?? 0) - t.thrust) * k;
  let force = scale(axes[0].dir, t.thrust * propellerEfficiency(a));
  if (axes.length > 1) {
    const cone = Math.max(0, t.thrust) * Math.tan(spec.gimbal ?? 0);
    const kt = 1 - Math.exp(-STEP / TILT_TIME);
    t.tiltA += (clamp(command[1] ?? 0, -cone, cone) - t.tiltA) * kt;
    t.tiltB += (clamp(command[2] ?? 0, -cone, cone) - t.tiltB) * kt;
    force = add(force, add(scale(axes[1].dir, t.tiltA), scale(axes[2].dir, t.tiltB)));
  }
  const rb = t.block.part.rb;
  t.block.bot.drawn += (spec.power * len(force)) / spec.maxThrust;
  rb.applyImpulseAtPoint(scale(force, STEP), a.p, true);
  if (spec.torqueRatio) rb.applyTorqueImpulse(scale(axes[0].dir, -t.spin * spec.torqueRatio * t.thrust * STEP), true);
}

/** Part de sa poussée que garde une hélice, selon la vitesse de l'air le long de son axe (1 pour un autre moteur). */
function propellerEfficiency(a: ThrusterArm): number {
  const top = a.spec.topSpeed;
  if (!top) return 1;
  const rb = a.t.block.part.rb;
  const v = add(rb.linvel(), cross(rb.angvel(), sub(a.p, rb.worldCom())));
  return propellerFactor(top, dot(v, a.axes[0].dir));
}

/** Part de sa poussée que garde une hélice quand l'air arrive à `axial` m/s le long de son axe : toute à l'arrêt, rien à `topSpeed`. */
export const propellerFactor = (topSpeed: number, axial: number): number => clamp(1 - axial / topSpeed, 0, 1);

/** Gaz des propulseurs (de 0 à 1), dans la limite de l'énergie disponible. */
export function runEngines(bot: Bot, throttle: number): void {
  const engines = liveThrusters(bot, "cruise");
  if (!engines.length) return;
  const arms = thrusterArms(engines, bot.cockpit.part.rb.worldCom());
  const gas = clamp(throttle, 0, 1);
  const k = supply(bot, arms.reduce((s, a) => s + a.spec.power * gas, 0));
  for (const a of arms) runMotor(a, [gas * k * a.axes[0].hi]);
}

/**
 * Usure d'un moteur : sous `ENGINE_WORN` de ses points de structure, il perd de sa poussée, jusqu'à
 * `WORN_OUTPUT` de sa pleine poussée à bout, et il a des ratés : il se coupe un bref instant, au
 * hasard, d'autant plus souvent qu'il est abîmé (son régime retombe, on voit sa flamme tousser).
 */
export const ENGINE_WORN = 0.5;
const WORN_OUTPUT = 0.6;
/** Ratés par seconde d'un moteur à bout (moins, à mesure qu'il est moins abîmé), et leur durée (s). */
const MISFIRE_RATE = 0.8;
const MISFIRE_MIN = 0.18;
const MISFIRE_MAX = 0.5;

/** État d'un bloc moteur : part de ses points de structure qui lui reste (1 intact). */
export const engineHealth = (t: Thruster): number => clamp(t.block.hp / blockDef(t.block.type).hp, 0, 1);

/** Une fois par pas et par robot : la poussée que peut donner chacun de ses moteurs, ses ratés. */
export function wearEngines(sim: Simulation, bot: Bot): void {
  for (const t of bot.thrusters) {
    // Paralysé localement (lance électrique, combat/emp.ts) : il ne pousse plus, comme pendant un raté
    if (t.block.stunnedUntil > sim.time) {
      t.output = 0;
      continue;
    }
    const health = engineHealth(t);
    if (!t.block.alive || health >= ENGINE_WORN) {
      t.output = 1;
      continue;
    }
    const wear = (ENGINE_WORN - health) / ENGINE_WORN;
    if (sim.time >= t.misfireUntil && rand(0, 1) < MISFIRE_RATE * wear * STEP) t.misfireUntil = sim.time + rand(MISFIRE_MIN, MISFIRE_MAX);
    t.output = sim.time < t.misfireUntil ? 0 : WORN_OUTPUT + (1 - WORN_OUTPUT) * (1 - wear);
  }
}

/** Réacteurs et propulseurs coupés : leur poussée retombe à leur rythme. */
export function idleThrusters(bot: Bot): void {
  const engines = liveThrusters(bot);
  if (engines.length) for (const a of thrusterArms(engines, bot.cockpit.part.rb.worldCom())) runMotor(a, []);
}

/** Réacteurs que pilote le vol stationnaire : sustentation, et rotors de queue ou de côté. */
const hoverThrusters = (bot: Bot): Thruster[] => liveThrusters(bot).filter((t) => t.role !== "cruise");

/**
 * Répartit une poussée totale `thrust` et un couple `tau` entre les axes de poussée des
 * réacteurs, dans leurs limites, par moindres carrés pondérés. Lignes : poussée totale, couple
 * sur deux axes horizontaux (divisé par la longueur des bras pour être en newtons), couple de
 * lacet (divisé par le couple de réaction moyen). Renvoie la consigne de chaque axe de chaque
 * réacteur (N).
 */
function allocateThrust(arms: ThrusterArm[], up: Vec3, thrust: number, tau: Vec3, piloted = false): number[][] {
  const tail = arms.some((a) => a.t.role === "trim");
  const e1 = norm(cross(up, Math.abs(up.x) < 0.9 ? vec3(1, 0, 0) : vec3(0, 0, 1)));
  const e2 = cross(up, e1);
  const cols = arms.flatMap((a) => a.axes);
  const reach = Math.max(0.5, Math.sqrt(arms.reduce((s, a) => s + len(a.axes[0].torque) ** 2, 0) / arms.length));
  const kappa = Math.max(0.01, arms.reduce((s, a) => s + a.spec.torqueRatio, 0) / arms.length);
  const totalMax = arms.reduce((s, a) => s + a.axes[0].hi, 0);
  // Sans rotor de queue, le lacet ne peut déséquilibrer qu'un peu les hélices ; avec, il a toute la poussée
  const yawLimit = (tail ? 1 : piloted ? YAW_SHARE_PILOT : YAW_SHARE) * totalMax;
  const yawTarget = clamp(dot(tau, up) / kappa, -yawLimit, yawLimit);
  const x = boundedLeastSquares(
    [
      cols.map((c) => dot(c.dir, up)),
      cols.map((c) => dot(c.torque, e1) / reach),
      cols.map((c) => dot(c.torque, e2) / reach),
      cols.map((c) => dot(c.torque, up) / kappa),
    ],
    [thrust, dot(tau, e1) / reach, dot(tau, e2) / reach, yawTarget],
    [WEIGHT_THRUST, WEIGHT_ATTITUDE, WEIGHT_ATTITUDE, tail ? WEIGHT_YAW_TAIL : piloted ? WEIGHT_YAW_PILOT : WEIGHT_YAW],
    cols.map((c) => c.lo),
    cols.map((c) => c.hi),
  );
  let i = 0;
  return arms.map((a) => a.axes.map(() => x[i++]));
}

/**
 * Portance utile : la plus forte poussée que les réacteurs alimentés peuvent fournir sans faire
 * basculer le robot, rapportée à son poids. Il faut plus de 1 pour voler ; ce n'est pas la somme
 * des poussées, car un réacteur mal placé ne peut pas pousser à fond sans déséquilibrer le robot.
 */
export function liftToWeight(bot: Bot): number {
  const powered = hoverThrusters(bot);
  if (!powered.some((t) => t.role === "lift")) return 0;
  const rb = bot.cockpit.part.rb;
  const up = qrot(rb.rotation(), vec3(0, 1, 0));
  const arms = thrusterArms(powered, rb.worldCom());
  const max = arms.reduce((s, a) => s + (a.t.role === "lift" ? a.axes[0].hi : 0), 0);
  const command = allocateThrust(arms, up, max, vec3(0, 0, 0));
  const lift = arms.reduce((s, a, i) => s + a.axes.reduce((u, axis, j) => u + dot(axis.dir, up) * command[i][j], 0), 0);
  return lift / (rb.mass() * GRAVITY);
}

/**
 * Pilote automatique de vol vers `target` (x, z), à l'altitude `target.y`.
 *
 * 1. Il calcule la force voulue, puis l'inclinaison et le couple nécessaires (inertie réelle du corps).
 * 2. Il répartit la poussée entre les réacteurs alimentés, dans leurs limites (0 à maxThrust),
 *    par moindres carrés pondérés. Quand c'est impossible, l'assiette passe avant l'altitude,
 *    et l'altitude avant le lacet.
 * 3. Chaque moteur rattrape sa consigne avec un retard (spoolTime) ; la poussée s'applique au bloc,
 *    avec le couple de réaction de l'hélice.
 *
 * Il n'y a aucune aide : avec 3 réacteurs, le Drone vole à la limite et tourne sur lui-même ;
 * avec 2, il ne peut plus tenir son assiette et tombe.
 *
 * `yaw` (robot piloté par le joueur, touches A et E) : vitesse de lacet voulue (`rate`, rad/s,
 * autour de son haut ; > 0 : vers la gauche), tenue activement (0 : il garde son cap), avec l'aide
 * du gyroscope du cockpit (`assist`, voir `GYRO_ACCEL`) ; il pivote à plat, sans toucher à
 * l'assiette ni au déplacement. Sans (l'IA), le lacet n'est qu'amorti.
 */
export function flyToward(bot: Bot, target: Vec3, yaw?: { rate: number; assist: number }): void {
  const powered = hoverThrusters(bot);
  if (!powered.some((t) => t.role === "lift")) return;
  const rb = bot.cockpit.part.rb;
  const m = rb.mass();
  const com = rb.worldCom();
  const v = rb.linvel();
  const w = rb.angvel();
  const up = qrot(rb.rotation(), vec3(0, 1, 0));

  // Force voulue : aller vers la cible, à l'altitude voulue
  let vDes = scale(vec3(target.x - com.x, 0, target.z - com.z), 0.45);
  const vl = Math.hypot(vDes.x, vDes.z);
  if (vl > bot.profile.speed) vDes = scale(vDes, bot.profile.speed / vl);
  const ah = vec3(clamp((vDes.x - v.x) * 1.2, -3, 3), 0, clamp((vDes.z - v.z) * 1.2, -3, 3));
  const ay = clamp((target.y - com.y) * 2.2 - v.y * 2.4, -5, 6);
  const F = vec3(m * ah.x, m * (GRAVITY + ay), m * ah.z);

  // Direction de poussée voulue, inclinaison limitée
  let uDes = norm(F);
  if (uDes.y < Math.cos(MAX_TILT)) {
    const h = norm(vec3(uDes.x, 0, uDes.z));
    uDes = vec3(h.x * Math.sin(MAX_TILT), Math.cos(MAX_TILT), h.z * Math.sin(MAX_TILT));
  }
  const thrust = Math.max(0, dot(F, up));

  // Couple voulu : redresser vers uDes et amortir les rotations, avec l'inertie réelle du corps
  const wUp = dot(w, up);
  const wTilt = sub(w, scale(up, wUp));
  const yawKd = powered.some((t) => t.role === "trim") ? YAW_KD_TAIL : YAW_KD;
  const piloted = yaw !== undefined;
  const yawRate = yaw?.rate ?? 0;
  const yawGain = piloted ? Math.max(yawKd, YAW_KP_PILOT) : yawKd;
  const alpha = add(sub(scale(cross(up, uDes), ATTITUDE_KP), scale(wTilt, ATTITUDE_KD)), scale(up, yawGain * (yawRate - wUp)));
  const inertia = rb.effectiveAngularInertia();
  const tau = inertiaTimes(inertia, alpha);
  // Le gyroscope du cockpit fait pivoter le robot (voir GYRO_ACCEL)
  if (yaw && yaw.assist > 0) {
    const spin = clamp(GYRO_KP * (yawRate - wUp), -GYRO_ACCEL, GYRO_ACCEL) * yaw.assist;
    rb.applyTorqueImpulse(scale(inertiaTimes(inertia, scale(up, spin)), STEP), true);
  }

  // Répartition de la poussée, puis moteurs : la poussée rattrape la consigne avec retard ;
  // l'hélice renvoie un couple opposé à sa rotation
  const arms = thrusterArms(powered, com);
  const command = allocateThrust(arms, up, thrust, tau, piloted);
  // Batteries vides : les moteurs n'ont plus que ce que produit le générateur
  const demand = arms.reduce((s, a, i) => s + (a.spec.power * command[i].reduce((u, f) => u + Math.abs(f), 0)) / a.spec.maxThrust, 0);
  const k = supply(bot, demand);
  arms.forEach((a, i) => runMotor(a, command[i].map((f) => f * k)));
}
