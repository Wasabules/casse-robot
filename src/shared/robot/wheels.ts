import RAPIER from "@dimforge/rapier3d-compat";
import { springTuning, wheelDef, type SpringTuning, type WheelTypeDef } from "../catalog/wheels";
import { CASTER_SIDE_GRIP, FREEWHEEL_DRAG, GRAVITY, LOOSE_STEER_GRIP, STEP } from "../config";
import { clamp } from "../math/scalar";
import { add, axisAngle, cross, dot, norm, NO_ROTATION, qmul, qrot, qrotInv, scale, sub, vec3, type Quat, type Vec3 } from "../math/vec";
import { COLLISION_GROUPS } from "../physics/groups";
import type { Bot, Part, Wheel, WheelBody } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { vibration } from "../combat/melee";

/*
 * Roues par lancer de rayon. Une roue montée n'a ni corps ni liaison : à chaque pas, un rayon part
 * du haut de sa suspension, le long du bas du morceau qui la porte. S'il touche le sol ou le décor
 * fixe, un ressort-amortisseur réglé pour la charge nominale de la roue pousse le morceau à cet
 * endroit, et le pneu y exerce la traction du moteur dans la roue et son adhérence latérale,
 * ensemble dans la limite de son adhérence et de la charge qu'il porte (cercle d'adhérence). Le
 * braquage, le débattement et la rotation de la roue sont de simples nombres, dont on déduit sa
 * pose (`Wheel.rb`, `Wheel.hub`) pour le rendu, les tirs et le réseau. Son collider, fixé au
 * morceau à sa place de repos, porte sa masse, reçoit les tirs et pousse ce qui bouge (caisses,
 * autres robots), sans toucher le sol ni le décor fixe. Une roue arrachée redevient un vrai corps,
 * qui roule et rebondit.
 *
 * Pourquoi : chaque roue coûtait un corps et deux liaisons (deux de plus par roue directrice), et
 * les roues faisaient 87 % du coût de la physique.
 */

/** Adhérence latérale : le glissement de côté est rattrapé en 1 / LATERAL_GAIN s, si l'adhérence le permet. */
const LATERAL_GAIN = 12;
/** Force d'appui maximale, en multiple du poids nominal de la roue. */
const MAX_LOAD = 4;
/** Au-delà du débattement, la butée : un ressort bien plus raide (multiple de la raideur de la suspension). */
const BUMP_STIFFNESS = 8;
/** Un rayon qui touche à moins de cette distance (m) est parti de l'intérieur d'un obstacle. */
const INSIDE = 1e-3;
/** En l'air, la roue rejoint la vitesse de son moteur (ou s'arrête) à ce rythme (1/s). */
const SPIN_RESPONSE = 3;
/**
 * Roulette : au-dessous de cette vitesse (m/s), elle ne pivote plus ; elle ne pivote pas plus vite
 * que SWIVEL_RATE (rad/s).
 */
const SWIVEL_MIN_SPEED = 0.05;
const SWIVEL_RATE = 14;
/** Le cylindre de Rapier est vertical : on le couche pour que l'essieu suive l'axe X. */
export const WHEEL_ROTATION: Quat = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
const UP = vec3(0, 1, 0);
const AXLE = vec3(1, 0, 0);
/** Un seul rayon, réutilisé d'une roue à l'autre ; et le ressort de chaque type de roue, calculé une fois. */
const RAY = new RAPIER.Ray(vec3(0, 0, 0), vec3(0, -1, 0));
const SPRINGS = new Map<WheelTypeDef, SpringTuning>();
const springOf = (def: WheelTypeDef): SpringTuning => {
  let spring = SPRINGS.get(def);
  if (!spring) {
    spring = springTuning(def, GRAVITY);
    SPRINGS.set(def, spring);
  }
  return spring;
};

/** Pose calculée d'une roue montée (ou de son porte-moyeu) : on la lit comme celle d'un corps. */
export class WheelPose implements WheelBody {
  pos: Vec3 = vec3(0, 0, 0);
  rot: Quat = NO_ROTATION;
  vel: Vec3 = vec3(0, 0, 0);
  ang: Vec3 = vec3(0, 0, 0);

  translation(): Vec3 {
    return this.pos;
  }

  rotation(): Quat {
    return this.rot;
  }

  linvel(): Vec3 {
    return this.vel;
  }

  angvel(): Vec3 {
    return this.ang;
  }
}

/**
 * Adhérence latérale du pneu : une roulette, ou une roue directrice non alimentée (qui pivote
 * librement), glisse de côté.
 */
function lateralGrip(w: Wheel, def: WheelTypeDef): number {
  if (def.caster) return def.grip * CASTER_SIDE_GRIP;
  return w.steerable && !w.powered ? LOOSE_STEER_GRIP : def.grip;
}

/**
 * Une roulette pivote vers la vitesse `v` de son point de contact (repère du robot) : le sol ramène
 * la roue derrière son pivot, d'autant plus vite qu'elle roule vite pour sa chasse ; en marche
 * arrière, elle fait demi-tour.
 */
function swivel(w: Wheel, trail: number, v: Vec3): void {
  const speed = Math.hypot(v.x, v.z);
  if (speed < SWIVEL_MIN_SPEED) return;
  const heading = Math.atan2(v.x, v.z);
  const gap = Math.atan2(Math.sin(heading - w.steer), Math.cos(heading - w.steer));
  const step = clamp(gap * Math.min(1, (speed * STEP) / trail), -SWIVEL_RATE * STEP, SWIVEL_RATE * STEP);
  w.steer = Math.atan2(Math.sin(w.steer + step), Math.cos(w.steer + step));
}

/**
 * État d'un morceau qui porte des roues, lu une fois par pas pour toutes ses roues (chaque lecture
 * d'un corps est un appel au WebAssembly de Rapier).
 */
interface Carrier {
  q: Quat;
  pos: Vec3;
  vel: Vec3;
  ang: Vec3;
  com: Vec3;
  up: Vec3;
  /** Masse portée par chacune de ses roues (kg), pour régler l'adhérence latérale. */
  share: number;
}

/** Inverse du tenseur d'inertie d'un morceau, dans le repère du monde : m11, m12, m13, m22, m23, m33. */
type InvInertia = readonly [number, number, number, number, number, number];

/**
 * Un morceau que ses roues poussent : sa vitesse (`vel`, `ang`) suit leurs poussées l'une après
 * l'autre, et les poussées s'additionnent (`lin`, `torque`) pour être données à Rapier en une fois.
 */
interface Pushed extends Carrier {
  invMass: number;
  invInertia: InvInertia;
  lin: Vec3;
  torque: Vec3;
  /** Part de l'adhérence de ses pneus qui lui reste : le balourd d'une arme de contact le secoue (combat/melee.ts). */
  grip: number;
}

/** Une vibration entière (balourd d'une arme de contact) retire cette part de l'adhérence des roues du robot. */
const VIBRATION_GRIP = 0.3;

const mulSym = (m: InvInertia, u: Vec3): Vec3 => vec3(
  m[0] * u.x + m[1] * u.y + m[2] * u.z,
  m[1] * u.x + m[3] * u.y + m[4] * u.z,
  m[2] * u.x + m[4] * u.y + m[5] * u.z,
);

/** Inverse de la masse effective du morceau en `r` (depuis son centre de masse), dans la direction `dir`. */
function inverseMass(c: Pushed, r: Vec3, dir: Vec3): number {
  const u = cross(r, dir);
  return c.invMass + dot(u, mulSym(c.invInertia, u));
}

/** Les roues montées du monde, par morceau porteur (robots hors de `sim.bots` compris : on part des morceaux). */
function mountedWheels(sim: Simulation): Map<Part, Wheel[]> {
  const byPart = new Map<Part, Wheel[]>();
  const seen = new Set<Bot>();
  for (const part of sim.parts) {
    if (seen.has(part.bot)) continue;
    seen.add(part.bot);
    for (const w of part.bot.wheels) {
      if (!w.part) continue;
      const list = byPart.get(w.part);
      if (list) list.push(w);
      else byPart.set(w.part, [w]);
    }
  }
  return byPart;
}

function carrierOf(part: Part, wheels: number): Carrier {
  const rb = part.rb;
  const q = rb.rotation();
  return {
    q, pos: rb.translation(), vel: rb.linvel(), ang: rb.angvel(), com: rb.worldCom(), up: qrot(q, UP),
    share: rb.mass() / wheels,
  };
}

/**
 * Un pas des roues montées de tous les robots : suspension, traction, adhérence ; puis leur rotation.
 * Les roues d'un morceau sont résolues l'une après l'autre, comme les contraintes d'un solveur :
 * chacune voit la vitesse que lui ont laissée les précédentes.
 */
export function stepWheels(sim: Simulation): void {
  for (const [part, wheels] of mountedWheels(sim)) {
    const rb = part.rb;
    // Le tableau de Rapier est une vue sur la mémoire du WebAssembly, que l'appel suivant écrase : on le recopie
    const m = rb.effectiveWorldInvInertia();
    const invInertia: InvInertia = [m.m11, m.m12, m.m13, m.m22, m.m23, m.m33];
    const c: Pushed = {
      ...carrierOf(part, wheels.length),
      invInertia,
      invMass: rb.invMass(),
      lin: vec3(0, 0, 0),
      torque: vec3(0, 0, 0),
      grip: part.bot.melee.length ? 1 - VIBRATION_GRIP * vibration(part.bot) : 1,
    };
    for (const w of wheels) stepWheel(sim, w, c);
    if (c.lin.x || c.lin.y || c.lin.z) {
      rb.applyImpulse(c.lin, true);
      rb.applyTorqueImpulse(c.torque, true);
    }
  }
}

function stepWheel(sim: Simulation, w: Wheel, c: Pushed): void {
  const def = wheelDef(w.type);
  const { q, up } = c;
  const down = scale(up, -1);
  const { travelUp, travelDown } = def.suspension;
  const top = add(add(c.pos, qrot(q, w.local)), scale(up, travelUp));
  // La roue s'appuie sur le sol et le décor fixe, pas sur ce qui bouge (accessoires, débris, robots,
  // dont le sien) : elle y grimperait d'un coup ; son collider, lui, les heurte et les pousse
  RAY.origin = top;
  RAY.dir = down;
  const cast = sim.world.castRayAndGetNormal(RAY, travelUp + travelDown + def.radius, true, undefined, COLLISION_GROUPS.groundRay);
  // Un rayon parti de l'intérieur d'un obstacle (la roue, qui ne heurte rien, s'est enfoncée dans un
  // pilier ou un mur) ne porte rien : sinon la butée soulèverait le robot et le renverserait
  const hit = cast && cast.timeOfImpact > INSIDE ? cast : null;
  // Débattement : la roue descend jusqu'au sol, dans la limite de sa suspension ; plus haut, la butée
  const raw = hit ? travelUp - (hit.timeOfImpact - def.radius) : -travelDown;
  const travel = clamp(raw, -travelDown, travelUp);
  w.travel = travel;

  if (!hit) {
    w.load = 0;
    // En l'air, la roue tourne librement : son moteur l'entraîne, ou elle ralentit
    const target = w.engaged ? w.drive * def.freeSpeed : 0;
    w.spinRate += (target - w.spinRate) * (1 - Math.exp(-SPIN_RESPONSE * STEP));
  } else {
    // Vitesse du point de contact du morceau (le sol, lui, ne bouge pas)
    const contact = add(top, scale(down, hit.timeOfImpact));
    const r = sub(contact, c.com);
    const vp = add(c.vel, cross(c.ang, r));

    // Suspension : ressort-amortisseur réglé pour la charge nominale, et butée au bout du débattement.
    // La roue pèse sur le morceau (son collider y porte sa masse) : le ressort porte aussi son poids.
    // L'amortisseur suit la vitesse du morceau vers le sol (pas l'écart de débattement d'un pas à
    // l'autre, qui bondirait quand la roue touche le sol). Ressort et amortisseur sont évalués à la
    // fin du pas (implicite), d'après la masse effective du morceau au point de contact : sinon, sur
    // un morceau léger aux roues écartées (le Char), l'amortisseur renverserait le mouvement d'un pas
    // à l'autre, une chenille puis l'autre décollant du sol. Au repos, la force est la même
    const spring = springOf(def);
    const bumpStiffness = raw > travelUp ? BUMP_STIFFNESS * spring.stiffness : 0;
    const held = spring.stiffness * (travel - spring.rest) + def.mass * GRAVITY + bumpStiffness * (raw - travelUp);
    const give = (spring.stiffness + bumpStiffness) * STEP + spring.damping;
    const load = clamp(
      (held + give * dot(vp, down)) / (1 + give * STEP * inverseMass(c, r, up)),
      0, MAX_LOAD * (def.ratedLoad + def.mass) * GRAVITY,
    );
    w.load = load;

    // Une roulette suit le mouvement ; puis le pneu, dans le plan du sol : vers l'avant de la roue
    // (braquée ou pivotée), et de côté
    if (def.caster) swivel(w, def.caster.trail, qrotInv(q, vp));
    const n = norm(vec3(hit.normal.x, hit.normal.y, hit.normal.z));
    const wheelRot = qmul(q, axisAngle(UP, w.steer));
    const forward = qrot(wheelRot, vec3(0, 0, 1));
    const lateral = qrot(wheelRot, AXLE);
    const fwd = norm(sub(forward, scale(n, dot(forward, n))));
    const lat = norm(sub(lateral, scale(n, dot(lateral, n))));
    const vLong = dot(vp, fwd);
    const vLat = dot(vp, lat);

    // Moteur dans la roue : couple = stallTorque × (tension − ω / freeSpeed), borné, la roue roulant
    // sans glisser ; une roulette, sans moteur, roule librement
    const omega = vLong / def.radius;
    let torque = w.engaged && def.stallTorque > 0
      ? clamp(def.stallTorque * (w.drive - omega / def.freeSpeed), -def.stallTorque, def.stallTorque)
      : -FREEWHEEL_DRAG * omega;
    // Roue libre à cliquet (boost) : le moteur ne pousse que dans le sens commandé ; plus vite que
    // ce qu'il vise (un propulseur pousse le robot), ou sans gaz, la roue tourne librement
    if (w.overrun && !(torque * w.drive > 0)) torque = -FREEWHEEL_DRAG * omega;
    let fLong = torque / def.radius;
    // Frein : il s'oppose au roulement, jusqu'à la part `w.brake` de ce que le pneu peut porter (la
    // roue ne se bloque pas). Implicite, comme la suspension : la force qui arrêterait le point de
    // contact en un pas, d'après la masse effective du morceau, bornée ; il tient le robot à l'arrêt
    if (w.brake > 0) {
      const cap = w.brake * def.grip * load;
      fLong = clamp(-vLong / (STEP * inverseMass(c, r, fwd)), -cap, cap);
    }
    // Adhérence latérale : le pneu s'oppose au glissement de côté (implicite, comme la suspension)
    const lateralGain = c.share * LATERAL_GAIN * (lateralGrip(w, def) / def.grip);
    let fLat = -vLat * lateralGain / (1 + lateralGain * STEP * inverseMass(c, r, lat));
    // Cercle d'adhérence : ensemble, traction et tenue de côté ne dépassent pas l'adhérence du pneu.
    // Une roue qui patine (un robot qui pivote sur place) ne tient plus de côté
    const demand = Math.hypot(fLong, fLat);
    const limit = def.grip * load * c.grip;
    if (demand > limit) {
      fLong *= limit / demand;
      fLat *= limit / demand;
    }

    const impulse = scale(add(add(scale(up, load), scale(fwd, fLong)), scale(lat, fLat)), STEP);
    const torqueImpulse = cross(r, impulse);
    c.lin = add(c.lin, impulse);
    c.torque = add(c.torque, torqueImpulse);
    c.vel = add(c.vel, scale(impulse, c.invMass));
    c.ang = add(c.ang, mulSym(c.invInertia, torqueImpulse));
    w.spinRate = omega;
  }
  w.spin = (w.spin + w.spinRate * STEP) % (2 * Math.PI);
}

/**
 * Pose d'une roue montée et de son porte-moyeu, d'après la pose de son morceau (`c`, lue une fois
 * pour toutes ses roues), son débattement, son braquage et sa rotation.
 */
function placeOn(w: Wheel, c: Carrier): void {
  if (!(w.rb instanceof WheelPose) || !(w.hub instanceof WheelPose)) return;
  const { q } = c;
  const center = add(c.pos, qrot(q, add(w.local, vec3(0, w.travel, 0))));
  const hubRot = qmul(q, axisAngle(UP, w.steer));
  const vel = add(c.vel, cross(c.ang, sub(center, c.com)));
  const ang = c.ang;
  w.hub.pos = center;
  w.hub.rot = hubRot;
  w.hub.vel = vel;
  w.hub.ang = ang;
  w.rb.pos = center;
  w.rb.rot = qmul(hubRot, axisAngle(AXLE, w.spin));
  w.rb.vel = vel;
  w.rb.ang = add(ang, scale(qrot(hubRot, AXLE), w.spinRate));
}

/** Pose d'une roue qu'on vient de monter. */
export function placeWheel(w: Wheel): void {
  if (w.part) placeOn(w, carrierOf(w.part, 1));
}

/** Pose de toutes les roues montées, une fois les morceaux déplacés par la physique. */
export function placeWheels(sim: Simulation): void {
  for (const [part, wheels] of mountedWheels(sim)) {
    const carrier = carrierOf(part, wheels.length);
    for (const w of wheels) placeOn(w, carrier);
  }
}

/** Collider de la roue, couché sur l'essieu, de la masse de la roue. */
export function wheelCollider(def: WheelTypeDef, grip: number): RAPIER.ColliderDesc {
  return RAPIER.ColliderDesc.cylinder(def.width / 2, def.radius)
    .setRotation(WHEEL_ROTATION)
    .setDensity(def.mass / (Math.PI * def.radius * def.radius * def.width))
    .setFriction(grip)
    .setRestitution(0);
}
