import RAPIER, { type Collider, type RigidBody } from "@dimforge/rapier3d-compat";
import { groundLevel } from "../arena/layout";
import { propNearest } from "../arena/structures";
import { flailPower, meleeDef, MOTOR_EFFICIENCY, type FlailSpec, type JawSpec, type MeleeSpec, type PlateSpec } from "../catalog/melee";
import { wheelDef } from "../catalog/wheels";
import { BLOCK_SIZE, STEP } from "../config";
import { cellKey } from "../design/robotDesign";
import { solveLinear } from "../math/linalg";
import { clamp } from "../math/scalar";
import { add, cross, distance, dot, len, norm, qrot, qrotInv, scale, sub, vec3, type Quat, type Vec3 } from "../math/vec";
import { supply } from "../robot/energy";
import { FLIPPED_UP_Y } from "../robot/righting";
import { groundedSupports } from "../robot/supports";
import type { Block, Bot, FlailBall, HitTarget, JawGrip, MeleeArm, Part } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { organStunned } from "./emp";
import { effectiveMass, meleeFrame, type Contact, type MeleeFrame, type PlannedHit } from "./melee";

/*
 * Frappes à mécanique (catalog/melee.ts) : le flipper, le fléau et la mâchoire broyeuse, trois
 * mouvements de plus de l'étape « contact » (`updateMelee`, combat/melee.ts, qui les appelle depuis
 * son `switch`). Comme les autres armes de contact, ils mesurent tout avant d'infliger : leurs coups
 * passent par les mêmes coups planifiés (`PlannedHit`), infligés après que toutes les armes ont joué.
 *
 * - Flipper (`flip`). Un plateau en coin devant son bloc ; sur ordre (et s'il a de quoi : `cost` kJ),
 *   le vérin le relève de `rest` à `end` en `strike` s. Le premier robot (ou accessoire mobile) que
 *   le plateau rencontre en montant, au-dessus de lui, est soulevé : le vérin lui donne ce qui lui
 *   reste de travail (`energy` × la part de course qui reste), l'impulsion J = √(2·μ·E·`fling`), μ la
 *   masse réduite au point touché, sans dépasser la vitesse du plateau à cet endroit. Le sol retient
 *   le robot qui soulève : posé, il bascule autour de ses appuis les plus en avant (`frontContact`),
 *   que le sol ne laisse pas s'enfoncer ; sa masse effective au pivot est celle de ce corps tenu là
 *   (une contrainte unilatérale, `launch`), et la réaction l'enfonce au plus à REACTION_MAX m/s (le
 *   sol encaisse le reste) en soulevant son arrière. Un robot léger sous un lourd reçoit donc presque
 *   toute la réaction (il pique du nez, l'arrière décolle, le lourd se lève à peine) ; un lourd sous
 *   un léger l'envoie en l'air. La cible est marquée projetée (`Bot.thrownBy`) : sa chute lui fait des dégâts de choc
 *   (combat/collisions.ts), crédités au flipper. Puis le plateau redescend et le vérin se recharge
 *   (`reload` s).
 * - Fléau (`flail`). Une manivelle (rayon `crank`, inertie `inertia`) que le moteur fait tourner ;
 *   la boule est un point de masse `mass` au bout d'une chaîne inextensible (elle peut être lâche),
 *   intégré au pas fixe : pesanteur, freinage de l'air, rebonds sur le décor (rayons de Rapier sur
 *   ce qui est fixe) et sur les robots (dans leur grille, sans physique), puis la chaîne, qui ne fait
 *   que la retenir. La tension de la chaîne est une impulsion entre la boule et le bout de la
 *   manivelle (masse effective du robot là, et la manivelle qui cède en tournant) : le robot la
 *   reçoit en ce point, la manivelle aussi (le moteur rend ce qu'elle perd ; le robot reçoit la
 *   réaction du moteur). C'est ce qui le déstabilise : la boule tire à chaque tour, et en virage elle
 *   ne suit pas. Un coup de la boule a l'énergie ½·μ·v² (v, sa vitesse par rapport à ce qu'elle frappe,
 *   μ la masse réduite) : ses dégâts suivent le carré de sa vitesse. Si la chaîne passe à travers un
 *   obstacle fixe dressé (poteau, tronc, mur), elle s'y enroule : la boule tourne autour du point
 *   d'appui avec ce qui reste de chaîne, la manivelle se bloque, et la chaîne retient le robot à ce
 *   point, jusqu'à ce qu'elle se déroule (la boule repasse de l'autre côté), qu'il tire trop fort, ou
 *   au bout de WRAP_MAX s. La manivelle a l'effet gyroscopique d'un volant ; la boule, libre au bout
 *   de sa chaîne, n'en transmet pas.
 * - Mâchoire (`grip`). Sur ordre, les mâchoires se ferment (`close` s) ; le premier bloc ennemi qui se
 *   trouve dans la gueule est saisi : une morsure (`bite` dégâts), puis la prise : un point du robot
 *   de la mâchoire et un point du robot saisi tenus ensemble par des impulsions à chaque pas (une
 *   contrainte de point, résolue avec les masses et les inerties effectives des deux corps, et une
 *   part de leur rotation relative amortie). C'est donc le plus lourd qui ne bouge pas : un robot
 *   lourd attrapé par un léger devient l'ancre. Tant qu'elle tient, elle écrase le bloc saisi
 *   (`crush` par seconde, par tranches) ; détruit, elle mord le bloc suivant dans sa gueule.
 *   Pourquoi des impulsions et pas une liaison de Rapier : la prise n'est qu'un état (deux blocs, deux
 *   points), vérifié au début de chaque pas avant de lire un corps ; elle ne laisse rien dans Rapier
 *   qu'il faudrait retirer avant chaque libération d'un corps (morceau détruit, robot retiré, morceau
 *   qui se sépare) : rien ne peut survivre à un corps libéré. Et la force qu'il faut pour tenir est
 *   connue à chaque pas : au-delà de `strength`, la prise glisse, puis lâche (une liaison de Rapier,
 *   elle, ne cède jamais, et ne dit pas ce qu'elle tient). Elle lâche aussi sur ordre (gâchette
 *   relâchée), au bout de `hold` s, quand la mâchoire n'est plus alimentée (détruite, arrachée,
 *   paralysée), quand la proie est détruite, ou quand les deux points s'écartent de `tear` m.
 */

/** Pas (rad) de la recherche du premier contact du plateau le long de sa levée. */
const ARC_STEP = 0.06;
/** Rayon (m) des points qui sondent le plateau : ce qui en approche à moins de cela le touche. */
const PLATE_PROBE = 0.14;
/** Points du plateau qui sondent, en part de sa longueur et de sa demi-largeur. */
const PLATE_ALONG = [0.3, 0.55, 0.8, 1] as const;
const PLATE_ACROSS = [-0.85, 0, 0.85] as const;
/** Le plateau ne lance pas plus vite que cette part de sa vitesse au point touché (au moins à PLATE_CARRY de sa longueur). */
const PLATE_SPEED_SHARE = 1.2;
const PLATE_CARRY = 0.75;
/** Une cible soulevée reste « projetée » (sa chute est créditée au flipper) ce temps (s). */
const THROWN_FOR = 3;
/**
 * Un flipper posé ne s'enfonce pas plus vite que cela (m/s, au pivot) sous la réaction : le sol
 * encaisse le reste (sous la vitesse où un choc fait des dégâts, combat/collisions.ts).
 */
const REACTION_MAX = 2.5;
/** Les appuis au sol à moins de cela (m) du plus en avant forment la rangée autour de laquelle bascule un flipper. */
const FRONT_ROW = 0.3;

/** Une roue vue comme une boule de cette part de son rayon (comme pour les lames). */
const WHEEL_REACH = 0.85;
/** Pesanteur (m/s²). */
const GRAVITY = 9.81;
/** La manivelle d'un fléau passe de l'arrêt au plein régime (et inversement) en ce temps (s) : son motoréducteur la tient. */
const CRANK_RAMP = 0.4;
/**
 * Chaîne d'un fléau dont la manivelle tourne plus vite que la boule (de plus de WIND_LAG de son
 * régime) : elle s'enroule autour du moyeu (de cette part de la course du bout de la manivelle) ;
 * sinon elle se déroule (de même, plus UNWIND_RATE m/s).
 */
const WIND_RATE = 0.5;
const WIND_LAG = 0.3;
const UNWIND_RATE = 0.4;
/** Une chaîne enroulée se déroule d'elle-même au bout de ce temps (s), ou si le robot tire plus fort que cela (N). */
const WRAP_MAX = 4;
const WRAP_PULL = 4000;
/** Une chaîne ne s'enroule que sur une face assez dressée (composante verticale de sa normale, au plus). */
const WRAP_UPRIGHT = 0.6;
/** Ce qui reste de chaîne au-delà du point d'appui, au moins (m), pour qu'elle s'enroule. */
const WRAP_MIN_FREE = 0.3;
/** Le décor se sonde au plus avec cette restitution (un mur ne rend pas plus). */
const SCENERY_RESTITUTION = 0.35;
/** Posée (sur le sol, le dessus du décor, son robot), la boule roule : ce frottement-là est faible. */
const ROLLING = 0.05;

/** Part de la rotation relative des deux robots qu'une prise de mâchoire amortit à chaque pas. */
const GRIP_SPIN = 0.6;
/** Bras de levier (m) du couple que tient une prise, au plus : strength × GRIP_ARM. */
const GRIP_ARM = 0.35;
/** Correction de l'écart entre les deux points d'une prise, par pas (part de l'écart). */
const GRIP_BIAS = 0.25;
/** Le bloc saisi détruit, la mâchoire mord le bloc de la proie le plus proche de la prise, à moins de cela (m). */
const REBITE = 0.8;
/** L'écrasement s'inflige par tranches de ce temps (s). */
const CRUSH_TICK = 0.25;
/** Énergie (J) annoncée avec une tranche d'écrasement (pour les effets et le son : un coup modeste). */
const CRUSH_ENERGY = 350;

// --- Outils communs ---

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const angleDelta = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Vitesse d'un point d'un corps (monde). */
function velocityAt(rb: RigidBody, p: Vec3): Vec3 {
  const v = rb.linvel();
  const w = rb.angvel();
  return add(v, cross(w, sub(p, rb.worldCom())));
}

/** Les morceaux des robots ennemis de `bot` dont le centre est à moins de `reach` m de `at`. */
function enemyParts(sim: Simulation, bot: Bot, at: Vec3, reach: number): { part: Part; t: Vec3; q: Quat }[] {
  const near: { part: Part; t: Vec3; q: Quat }[] = [];
  for (const other of sim.bots) {
    if (other === bot || other.team === bot.team || !other.blocks.size || !other.cockpit.alive) continue;
    for (const part of other.parts) {
      const t = part.rb.translation();
      if (distance(t, at) < reach + other.radius + other.top) near.push({ part, t, q: part.rb.rotation() });
    }
  }
  return near;
}

/** Point d'un bloc (sa case) le plus proche de `p`, dans le repère de son morceau. */
function nearestOnBlock(b: Block, local: Vec3): Vec3 {
  const h = BLOCK_SIZE / 2;
  return vec3(clamp(local.x, b.local.x - h, b.local.x + h), clamp(local.y, b.local.y - h, b.local.y + h), clamp(local.z, b.local.z - h, b.local.z + h));
}

/**
 * Ce qui touche une boule de rayon `r` en `p` sur un morceau (`part`, de pose t, q) : le bloc le plus
 * proche dans sa grille, ou une de ses roues ; avec la distance et le point le plus proche (monde).
 */
function probePart(part: Part, t: Vec3, q: Quat, p: Vec3, r: number): { target: HitTarget; point: Vec3; d: number } | null {
  const local = qrotInv(q, sub(p, t));
  const cx = Math.round(local.x / BLOCK_SIZE);
  const cy = Math.round(local.y / BLOCK_SIZE);
  const cz = Math.round(local.z / BLOCK_SIZE);
  let best: { target: HitTarget; point: Vec3; d: number } | null = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = part.bot.blocks.get(cellKey(cx + dx, cy + dy, cz + dz));
        if (!b || b.part !== part) continue;
        const near = nearestOnBlock(b, local);
        const d = len(sub(local, near));
        if (d < r && (!best || d < best.d)) best = { target: { kind: "block", block: b }, point: add(t, qrot(q, near)), d };
      }
    }
  }
  for (const w of part.bot.wheels) {
    if (w.part !== part) continue;
    const c = w.rb.translation();
    const rw = wheelDef(w.type).radius * WHEEL_REACH;
    const d = distance(c, p) - rw;
    if (d < r && (!best || d < best.d)) {
      const out = norm(sub(p, c));
      best = { target: { kind: "wheel", wheel: w }, point: add(c, scale(out, rw)), d };
    }
  }
  return best;
}

/**
 * Appui au sol d'un robot posé le plus près du pivot d'une arme (le long de `forward`, depuis `hub`) :
 * la moyenne des points de contact de ses roues qui portent (ou de ses appuis au sol) les plus en
 * avant, à FRONT_ROW m près (un essieu, le premier galet de chaque chenille) ; null s'il est en l'air.
 */
function frontContact(bot: Bot, hub: Vec3, forward: Vec3): Vec3 | null {
  const ck = bot.cockpit;
  if (!ck.alive) return null;
  const contacts: Vec3[] = [];
  for (const w of bot.wheels) {
    if (w.part !== ck.part || w.load <= 0) continue;
    const c = w.rb.translation();
    contacts.push(vec3(c.x, c.y - wheelDef(w.type).radius, c.z));
  }
  for (const s of groundedSupports(bot)) {
    const c = add(ck.part.rb.translation(), qrot(ck.part.rb.rotation(), s.block.local));
    contacts.push(vec3(c.x, c.y - s.contact, c.z));
  }
  if (!contacts.length) return null;
  const along = (p: Vec3): number => dot(sub(p, hub), forward);
  const front = Math.max(...contacts.map(along));
  const row = contacts.filter((p) => along(p) > front - FRONT_ROW);
  return scale(row.reduce((s, p) => add(s, p), vec3(0, 0, 0)), 1 / row.length);
}

/** La mâchoire, le flipper : alimentés (reliés au cockpit, pas paralysés). */
function poweredArm(sim: Simulation, bot: Bot, arm: MeleeArm): boolean {
  const ck = bot.cockpit;
  return ck.alive && arm.block.alive && arm.block.part === ck.part && !organStunned(sim, arm.block);
}

/** Robot renversé, ou que son gyroscope redresse (cockpit vivant : après `poweredArm`). */
const capsized = (bot: Bot): boolean => bot.righting > 0 || qrot(bot.cockpit.part.rb.rotation(), vec3(0, 1, 0)).y < FLIPPED_UP_Y;

// --- Flipper ---

/** Point du plateau à l'angle `angle` : `along` (part de sa longueur), `across` (part de sa demi-largeur). */
function platePoint(f: MeleeFrame, plate: PlateSpec, angle: number, along: number, across: number): Vec3 {
  const dir = add(scale(f.e1, Math.cos(angle)), scale(f.e2, -Math.sin(angle)));
  return add(f.hub, add(scale(dir, plate.length * along), scale(f.axis, plate.half * across)));
}

/** Sens où va le plateau à l'angle `angle` (il monte : l'angle croît). */
const plateMotion = (f: MeleeFrame, angle: number): Vec3 => norm(add(scale(f.e1, -Math.sin(angle)), scale(f.e2, -Math.cos(angle))));

/**
 * Premier contact du plateau en montant de `from` à `to` : un bloc ou une roue d'un robot ennemi
 * au-dessus de lui (et, sauf `robotsOnly`, un accessoire mobile). Pas le sol ni le décor : le plateau
 * s'en éloigne. Le contact, l'angle où il a lieu et la part de longueur du plateau qui le touche.
 */
function plateContact(
  sim: Simulation, bot: Bot, f: MeleeFrame, plate: PlateSpec, from: number, to: number, robotsOnly: boolean, step = ARC_STEP,
): { contact: Contact; angle: number } | null {
  const near = enemyParts(sim, bot, f.hub, plate.length + 1);
  const props = robotsOnly ? [] : sim.props.filter((p) => !p.fixed && p.hp > 0 && distance(p.rb.translation(), f.hub) < plate.length + 2);
  if (!near.length && !props.length) return null;
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / step));
  for (let i = 1; i <= steps; i++) {
    const angle = from + ((to - from) * i) / steps;
    let best: Contact | null = null;
    let nearest = Infinity;
    for (const along of PLATE_ALONG) {
      for (const across of PLATE_ACROSS) {
        const p = platePoint(f, plate, angle, along, across);
        for (const { part, t, q } of near) {
          const hit = probePart(part, t, q, p, PLATE_PROBE);
          if (hit && hit.d < nearest) {
            nearest = hit.d;
            best = { surface: "robot", target: hit.target, body: part.rb, point: hit.point, radial: along * plate.length, normal: null };
          }
        }
        for (const prop of props) {
          const c = propNearest(prop, p);
          const d = distance(c, p);
          if (d < PLATE_PROBE && d < nearest) {
            nearest = d;
            best = { surface: "prop", target: { kind: "prop", prop }, body: prop.rb, point: c, radial: along * plate.length, normal: null };
          }
        }
      }
    }
    if (best) return { contact: best, angle };
  }
  return null;
}

/** Un plateau de flipper : armé, levée (premier contact au-dessus de lui), redescente et recharge du vérin. */
export function stepFlip(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, plans: PlannedHit[]): void {
  const plate = spec.plate!;
  arm.phaseT += STEP;
  const arc = plate.end - plate.rest;
  switch (arm.phase) {
    case "ready":
    case "hold":
      arm.phase = "ready";
      arm.swing = plate.rest;
      arm.spin = 0;
      // Le vérin se vide d'un coup : il faut de quoi le recharger
      if (arm.trigger && poweredArm(sim, bot, arm) && bot.energy >= plate.cost) {
        bot.energy -= plate.cost;
        arm.phase = "strike";
        arm.phaseT = 0;
      }
      break;
    case "strike": {
      const t = Math.min(1, arm.phaseT / plate.strike);
      const prev = arm.swing;
      const next = plate.rest + arc * t * t;
      arm.spin = (2 * arc * t) / plate.strike;
      // Une seule cible par levée : la première que le plateau rencontre
      const struck = arm.hitAt >= sim.time - arm.phaseT - 1e-9;
      if (!struck) {
        const frame = meleeFrame(arm);
        const found = plateContact(sim, bot, frame, plate, prev, next, false);
        if (found) launch(sim, bot, arm, spec, frame, found.contact, found.angle, plans);
      }
      arm.swing = next;
      if (t >= 1) {
        arm.phase = "recover";
        arm.phaseT = 0;
        arm.from = arm.swing;
      }
      break;
    }
    case "recover": {
      // Il redescend, puis le vérin se recharge
      const t = Math.min(1, arm.phaseT / plate.lower);
      arm.spin = 0;
      arm.swing = arm.from + (plate.rest - arm.from) * t * t * (3 - 2 * t);
      if (arm.phaseT >= plate.reload) {
        arm.phase = "ready";
        arm.phaseT = 0;
        arm.swing = plate.rest;
      }
      break;
    }
  }
}

/** Le plateau soulève ce qu'il touche : l'impulsion (masse réduite, appui du sol, vitesse du plateau), la réaction au pivot. */
function launch(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, f: MeleeFrame, contact: Contact, angle: number, plans: PlannedHit[]): void {
  const plate = spec.plate!;
  const arc = plate.end - plate.rest;
  const energy = plate.energy * clamp((plate.end - angle) / arc, 0, 1);
  const p = spec.hit.push;
  const dir = norm(add(scale(plateMotion(f, angle), p.tangent), vec3(0, p.lift, 0)));
  const part = arm.block.part;
  const rb = part.rb;
  // Le robot qui soulève, au pivot : sa masse effective, et s'il est posé, son appui au sol le plus
  // en avant (il bascule autour de lui : il faut le soulever par l'arrière pour enfoncer le pivot)
  const pivot = frontContact(bot, f.hub, f.e1);
  const com = rb.worldCom();
  const inv = invInertia(rb);
  const invMass = rb.invMass();
  const rh = sub(f.hub, com);
  const up = vec3(0, 1, 0);
  /** Vitesse le long de `n` du point `rx` pour une impulsion unité le long de `m` au point `ry` (bras depuis le centre de masse). */
  const k = (rx: Vec3, n: Vec3, ry: Vec3, m: Vec3): number => dot(n, add(scale(m, invMass), cross(mulMV(inv, cross(ry, m)), rx)));
  const khh = k(rh, dir, rh, dir);
  let braced = khh;
  let ground: { at: Vec3; along: number; cross: number } | null = null;
  if (pivot) {
    const rc = sub(pivot, com);
    const kcc = k(rc, up, rc, up);
    const kch = k(rc, up, rh, dir);
    // Une impulsion vers le bas au pivot n'appuie sur le sol que si elle y enfonce l'appui
    if (kcc > 1e-9 && kch > 0) {
      braced = khh - (kch * kch) / kcc;
      ground = { at: pivot, along: kcc, cross: kch };
    }
  }
  const mine = 1 / Math.max(braced, 1e-6);
  const theirs = contact.body ? effectiveMass(contact.body, contact.point, dir) : Infinity;
  const reduced = Number.isFinite(theirs) ? 1 / (1 / mine + 1 / theirs) : mine;
  let impulse = Math.sqrt(2 * reduced * energy * spec.hit.fling);
  // Pas plus vite que le plateau ne va en fin de levée, là où elle porte (la cible glisse vers son bord en montant)
  const plateSpeed = ((2 * arc) / plate.strike) * Math.max(contact.radial, PLATE_CARRY * plate.length);
  if (Number.isFinite(theirs)) impulse = Math.min(impulse, theirs * plateSpeed * PLATE_SPEED_SHARE);
  arm.hitAt = sim.time;
  const target = contact.target;
  const victim = target?.kind === "block" ? target.block.bot : target?.kind === "wheel" ? target.wheel.bot : null;
  if (victim) victim.thrownBy = { by: bot, cause: arm.weapon, until: sim.time + THROWN_FOR };
  // La réaction au pivot ; posé, il ne s'y enfonce pas plus vite que REACTION_MAX (le sol encaisse le
  // reste), et son appui au sol le retient : il bascule autour de lui, l'arrière se lève
  let reaction = impulse * spec.hit.recoil;
  if (ground) {
    reaction = Math.min(reaction, REACTION_MAX / braced);
    rb.applyImpulseAtPoint(scale(up, (ground.cross * reaction) / ground.along), ground.at, true);
  }
  plans.push({ arm, bot, spec, contact, energy, grip: 1, dir, hub: f.hub, part, impulse, reaction });
}

/**
 * Une levée de ce flipper soulèverait-elle un robot ennemi, là où il est ? (L'IA lève alors : la
 * cible est au-dessus du plateau, ou juste devant, sous son bord qui monte.)
 */
export function flipWouldHit(sim: Simulation, bot: Bot, arm: MeleeArm): boolean {
  const plate = meleeDef(arm.weapon).plate;
  if (!plate || !arm.block.alive) return false;
  // Il faut qu'il reste assez de course pour soulever (la moitié de la levée)
  const hit = plateContact(sim, bot, meleeFrame(arm), plate, plate.rest, (plate.rest + plate.end) / 2, true, ARC_STEP * 2);
  return hit !== null;
}

// --- Fléau ---

/** Bout de la manivelle d'un fléau à l'angle `angle` (monde). */
export function crankTip(f: MeleeFrame, flail: FlailSpec, angle: number): Vec3 {
  return add(f.hub, scale(add(scale(f.e1, Math.cos(angle)), scale(f.e2, Math.sin(angle))), flail.crank));
}

/** Filtre des rayons de la boule et de sa chaîne : ce qui est fixe (décor, sol, accessoires ancrés). */
function fixedOnly(sim: Simulation): (c: Collider) => boolean {
  return (c) => {
    const owner = sim.colliders.get(c.handle);
    if (!owner) return true;
    return owner.kind === "prop" && owner.prop.fixed;
  };
}

/** Un fléau : manivelle (moteur ou frein), boule (pesanteur, rebonds, coups), chaîne (tension, enroulement). */
export function stepFlail(
  sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, gyros: Map<Part, Vec3>, plans: PlannedHit[],
): void {
  const fl = spec.flail!;
  const part = arm.block.part;
  const rb = part.rb;
  const f = meleeFrame(arm);
  let ball = arm.ball;
  if (!ball) {
    // Elle part couchée au bout de sa chaîne, à hauteur du moyeu, devant lui : elle tombe sur son
    // robot (ou pend à côté de lui), jamais dessous
    const tip = crankTip(f, fl, arm.angle);
    const at = add(tip, scale(f.e1, fl.chain * 0.9));
    ball = arm.ball = { pos: at, vel: velocityAt(rb, at), wrap: null, wound: 0 };
  }
  // Renversé (ou en train de se redresser), le moteur se coupe : la boule se pose, le robot cesse
  // d'être secoué et son gyroscope peut le remettre d'aplomb (il attend qu'il soit presque immobile)
  const powered = arm.wanted && poweredArm(sim, bot, arm) && !capsized(bot);

  // La manivelle : son motoréducteur la mène à son régime en CRANK_RAMP s (la boule, elle, met plus
  // longtemps : la chaîne l'entraîne) et la tient, quoi que tire la chaîne ; batteries vides, moins
  // vite ; arrêté, il la freine ; enroulée autour d'un obstacle, la chaîne la bloque
  const power = flailPower(fl);
  const share = powered ? supply(bot, power) : 0;
  const goal = ball.wrap ? 0 : fl.speed * share;
  const ramp = (fl.speed / CRANK_RAMP) * STEP;
  const omega = ball.wrap ? 0 : arm.spin + clamp(goal - arm.spin, -ramp, ramp);
  const used = (omega - arm.spin) * fl.inertia;
  arm.angle = (arm.angle + omega * STEP) % (Math.PI * 2);
  const tip = crankTip(f, fl, arm.angle);
  const arm0 = sub(tip, f.hub);
  const tipVel = add(velocityAt(rb, tip), scale(cross(f.axis, arm0), omega));

  // La boule : pesanteur, air, puis le décor sur son trajet
  let v = scale(add(ball.vel, vec3(0, -GRAVITY * STEP, 0)), Math.exp(-fl.drag * STEP));
  const prev = ball.pos;
  let pos = add(prev, scale(v, STEP));
  const filter = fixedOnly(sim);
  const move = sub(pos, prev);
  const moved = len(move);
  if (moved > 1e-6) {
    const dir = scale(move, 1 / moved);
    const hit = sim.world.castRayAndGetNormal(new RAPIER.Ray(prev, dir), moved + fl.radius, true, undefined, undefined, undefined, undefined, filter);
    if (hit) {
      const n = vec3(hit.normal.x, hit.normal.y, hit.normal.z);
      const owner = sim.colliders.get(hit.collider.handle);
      pos = add(prev, scale(dir, Math.max(0, hit.timeOfImpact - fl.radius)));
      const into = -dot(v, n);
      if (into > 0 && len(n) > 0.5) {
        v = bounce(v, n, into, Math.min(fl.restitution, SCENERY_RESTITUTION), fl.friction);
        const point = add(prev, scale(dir, hit.timeOfImpact));
        if (into > spec.hit.minSpeed && sim.time - arm.hitAt >= spec.hit.gap) {
          arm.hitAt = sim.time;
          const prop = owner?.kind === "prop" ? owner.prop : null;
          plans.push({
            arm, bot, spec, part, hub: f.hub, grip: 1, dir: scale(n, -1), impulse: 0, reaction: 0,
            energy: 0.5 * fl.mass * into * into,
            contact: { surface: prop ? "prop" : "scenery", target: prop ? { kind: "prop", prop } : null, body: null, point, radial: 0, normal: null },
          });
        }
      }
    }
  }
  // Le dessus d'un décor sous elle (une plateforme), quand elle descend
  if (v.y < 0) {
    const down = sim.world.castRay(new RAPIER.Ray(pos, vec3(0, -1, 0)), fl.radius + 0.02, true, undefined, undefined, undefined, undefined, filter);
    if (down) {
      pos = vec3(pos.x, pos.y + fl.radius - down.timeOfImpact, pos.z);
      v = bounce(v, vec3(0, 1, 0), -v.y, 0.1, ROLLING);
    }
  }

  // La chaîne : elle retient la boule (du bout de la manivelle, moins ce qui s'est enroulé autour du
  // moyeu ; ou de là où elle s'est enroulée autour d'un obstacle). Tant que la manivelle tourne plus
  // vite que la boule autour de l'axe, elle enroule la chaîne autour du moyeu : la chaîne se tend et
  // entraîne la boule ; quand la boule la suit, la chaîne se déroule, et la boule part au bout
  const wrap = ball.wrap;
  if (!wrap) {
    const out = sub(pos, f.hub);
    const radial = sub(out, scale(f.axis, dot(out, f.axis)));
    const r2 = dot(radial, radial);
    const around = r2 > 0.01 ? dot(f.axis, cross(radial, sub(v, velocityAt(rb, pos)))) / r2 : 0;
    const winding = Math.abs(omega) * fl.crank * WIND_RATE * STEP;
    if (omega > 0.5 && around < omega * (1 - WIND_LAG)) ball.wound = Math.min(fl.chain - WRAP_MIN_FREE, ball.wound + winding);
    else ball.wound = Math.max(0, ball.wound - winding - UNWIND_RATE * STEP);
  }
  const anchor = wrap ? wrap.point : tip;
  const free = wrap ? fl.chain - wrap.length : fl.chain - ball.wound;
  const rel = sub(pos, anchor);
  const d = len(rel);
  let chainImpulse = vec3(0, 0, 0);
  if (d > free && d > 1e-6) {
    const n = scale(rel, 1 / d);
    pos = add(anchor, scale(n, free));
    const away = dot(sub(v, wrap ? vec3(0, 0, 0) : tipVel), n);
    if (away > 0) {
      // Au bout de la chaîne : le robot (masse effective en ce point ; la manivelle, tenue par son moteur, ne cède pas)
      const inv = wrap ? 0 : 1 / effectiveMass(rb, tip, n);
      const lambda = away / (1 / fl.mass + inv);
      v = sub(v, scale(n, lambda / fl.mass));
      if (!wrap) chainImpulse = scale(n, lambda);
    }
  }

  // Les robots : ses coups sur les ennemis (masse réduite, rebond) ; son propre robot la repousse
  // sans dégâts (elle se pose sur lui : il a le dernier mot sur la chaîne)
  ({ pos, v } = ballOnRobots(sim, bot, arm, spec, f, fl, pos, v, plans));
  // Pas sous le sol (ni le relief)
  const floor = groundLevel(sim.arena, pos.x, pos.z) + fl.radius;
  if (pos.y < floor) {
    pos = vec3(pos.x, floor, pos.z);
    if (v.y < 0) v = bounce(v, vec3(0, 1, 0), -v.y, 0.15, ROLLING);
  }

  // Ce que la chaîne tire, le robot le reçoit tout au bout de la manivelle (le motoréducteur la
  // tient), plus la réaction de ce qui l'a accélérée ; le moteur fournit le travail
  const turned = dot(f.axis, cross(arm0, chainImpulse));
  if (len(chainImpulse) > 1e-9) rb.applyImpulseAtPoint(chainImpulse, tip, true);
  if (Math.abs(used) > 1e-9) rb.applyTorqueImpulse(scale(f.axis, -used), true);
  const work = (used - turned) * omega;
  if (powered && work > 0) bot.drawn += work / STEP / 1000 / MOTOR_EFFICIENCY;
  arm.spin = omega;
  // Gyroscope : le volant de la manivelle (la boule, libre au bout de sa chaîne, n'en transmet pas)
  if (Math.abs(omega) > 0.01) gyros.set(part, add(gyros.get(part) ?? vec3(0, 0, 0), scale(f.axis, fl.inertia * omega)));

  ball.pos = pos;
  ball.vel = v;
  updateWrap(sim, arm, fl, tip, filter);
}

/**
 * Rebond sur une surface de normale `n` (`into` : vitesse d'arrivée, > 0) : restitution, et
 * frottement de Coulomb le long de la surface (la vitesse tangente perd au plus `friction` fois ce
 * que gagne la vitesse normale).
 */
function bounce(v: Vec3, n: Vec3, into: number, restitution: number, friction: number): Vec3 {
  const tangent = add(v, scale(n, -dot(v, n)));
  const slide = len(tangent);
  const kept = slide > 1e-9 ? Math.max(0, 1 - (friction * into * (1 + restitution)) / slide) : 0;
  return add(scale(tangent, kept), scale(n, into * restitution));
}

/**
 * La boule et les robots : sur un ennemi, un coup (impulsion de rebond d'après la masse réduite,
 * énergie ½·μ·v² au-delà de `minSpeed`) ; un accessoire mobile de même ; son propre robot la
 * repousse sans dégâts (elle se pose sur lui, à l'arrêt). Les coéquipiers : rien (comme les lames).
 */
function ballOnRobots(
  sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, f: MeleeFrame, fl: FlailSpec, pos: Vec3, v: Vec3, plans: PlannedHit[],
): { pos: Vec3; v: Vec3 } {
  const r = fl.radius;
  // Son propre robot
  for (const part of bot.parts) {
    const t = part.rb.translation();
    if (distance(t, pos) > bot.radius + bot.top + 2) continue;
    const touch = probePart(part, t, part.rb.rotation(), pos, r);
    if (!touch || touch.target.kind !== "block") continue;
    const n = touch.d > 1e-4 ? norm(sub(pos, touch.point)) : vec3(0, 1, 0);
    pos = add(touch.point, scale(n, r));
    const vp = velocityAt(part.rb, touch.point);
    const into = -dot(sub(v, vp), n);
    if (into > 0) {
      const reduced = 1 / (1 / fl.mass + 1 / effectiveMass(part.rb, touch.point, n));
      const lambda = (1 + 0.1) * reduced * into;
      v = add(vp, bounce(sub(v, vp), n, into, 0.1, ROLLING));
      part.rb.applyImpulseAtPoint(scale(n, -lambda), touch.point, true);
    }
  }
  // Les ennemis
  if (sim.time - arm.hitAt < spec.hit.gap) return { pos, v };
  let best: { target: HitTarget; point: Vec3; d: number; body: RigidBody; surface: "robot" | "prop" } | null = null;
  for (const { part, t, q } of enemyParts(sim, bot, pos, r + 1)) {
    const touch = probePart(part, t, q, pos, r);
    if (touch && (!best || touch.d < best.d)) best = { ...touch, body: part.rb, surface: "robot" };
  }
  for (const prop of sim.props) {
    if (prop.fixed || prop.hp <= 0 || distance(prop.rb.translation(), pos) > Math.max(prop.half.x, prop.half.y, prop.half.z) * 1.8 + r) continue;
    const c = propNearest(prop, pos);
    const d = distance(c, pos);
    if (d < r && (!best || d < best.d)) best = { target: { kind: "prop", prop }, point: c, d, body: prop.rb, surface: "prop" };
  }
  if (!best) return { pos, v };
  const n = best.d > 1e-4 ? norm(sub(pos, best.point)) : norm(scale(v, -1));
  pos = add(best.point, scale(n, r));
  const vt = velocityAt(best.body, best.point);
  const vrel = sub(v, vt);
  const into = -dot(vrel, n);
  if (into <= 0) return { pos, v };
  const theirs = effectiveMass(best.body, best.point, n);
  const reduced = 1 / (1 / fl.mass + 1 / theirs);
  const impulse = (1 + fl.restitution) * reduced * into;
  v = add(vt, bounce(vrel, n, into, fl.restitution, fl.friction));
  const speed = len(vrel);
  if (speed < spec.hit.minSpeed) {
    // Elle ne fait que le toucher : il est poussé, rien de plus
    best.body.applyImpulseAtPoint(scale(n, -impulse), best.point, true);
    return { pos, v };
  }
  arm.hitAt = sim.time;
  plans.push({
    arm, bot, spec, part: arm.block.part, hub: f.hub, grip: 1, dir: scale(n, -1), impulse, reaction: 0,
    energy: 0.5 * reduced * speed * speed,
    contact: { surface: best.surface, target: best.target, body: best.body, point: best.point, radial: 0, normal: null },
  });
  return { pos, v };
}

/**
 * Enroulement de la chaîne d'un fléau. Libre, elle s'enroule si elle traverse un obstacle fixe dressé
 * entre la manivelle et la boule. Enroulée, elle retient le robot à son point d'appui (s'il tire
 * trop fort, elle glisse et se déroule) et se déroule quand la boule repasse de l'autre côté
 * (l'angle au point d'appui s'ouvre), ou au bout de WRAP_MAX s.
 */
function updateWrap(sim: Simulation, arm: MeleeArm, fl: FlailSpec, tip: Vec3, filter: (c: Collider) => boolean): void {
  const ball = arm.ball!;
  const wrap = ball.wrap;
  if (!wrap) {
    const span = sub(ball.pos, tip);
    const d = len(span);
    if (d < 0.3) return;
    const dir = scale(span, 1 / d);
    const hit = sim.world.castRayAndGetNormal(new RAPIER.Ray(tip, dir), d - fl.radius * 1.2, true, undefined, undefined, undefined, undefined, filter);
    if (!hit || Math.abs(hit.normal.y) > WRAP_UPRIGHT || hit.timeOfImpact < 0.05) return;
    const n = vec3(hit.normal.x, hit.normal.y, hit.normal.z);
    const point = add(add(tip, scale(dir, hit.timeOfImpact)), scale(n, 0.06));
    const length = distance(point, tip);
    if (fl.chain - length < WRAP_MIN_FREE) return;
    const axis = cross(sub(point, tip), sub(ball.pos, point));
    if (len(axis) < 1e-4) return;
    ball.wrap = { point, length, axis: norm(axis), since: sim.time };
    return;
  }
  // Déroulée : la boule est repassée de l'autre côté du point d'appui, ou c'est trop long
  const turn = dot(cross(sub(wrap.point, tip), sub(ball.pos, wrap.point)), wrap.axis);
  if (turn < 0 || sim.time - wrap.since > WRAP_MAX) {
    ball.wrap = null;
    return;
  }
  // La chaîne retient le robot à son point d'appui (fixe) : on retire ce qui l'en éloigne
  const rb = arm.block.part.rb;
  const out = sub(tip, wrap.point);
  const d = len(out);
  if (d <= wrap.length || d < 1e-6) return;
  const n = scale(out, 1 / d);
  const away = dot(velocityAt(rb, tip), n) + (GRIP_BIAS * (d - wrap.length)) / STEP;
  if (away <= 0) return;
  const lambda = away * effectiveMass(rb, tip, n);
  if (lambda > WRAP_PULL * STEP) {
    // Il tire trop fort : la chaîne glisse de l'obstacle
    ball.wrap = null;
    return;
  }
  rb.applyImpulseAtPoint(scale(n, -lambda), tip, true);
}

// --- Mâchoire ---

/** Direction d'une mâchoire (monde) à la demi-ouverture `angle` : celle du haut (`side` 1) ou du bas (-1). */
export const jawDir = (f: MeleeFrame, angle: number, side: 1 | -1): Vec3 => add(scale(f.e1, Math.cos(angle)), scale(f.e2, -side * Math.sin(angle)));

/**
 * Le bloc ennemi qui est dans la gueule, entre les mâchoires ouvertes de `opening` (rad) : le plus
 * proche de l'axe de la gueule. Sa distance au pivot le long de e1 (m).
 */
function inMouth(sim: Simulation, bot: Bot, f: MeleeFrame, jaw: JawSpec, opening: number): { block: Block; along: number } | null {
  const [near, far] = jaw.mouth;
  const h = BLOCK_SIZE / 2;
  let best: { block: Block; along: number; score: number } | null = null;
  for (const { part, t, q } of enemyParts(sim, bot, f.hub, far + 1)) {
    for (const b of part.blocks) {
      const c = sub(add(t, qrot(q, b.local)), f.hub);
      const along = dot(c, f.e1);
      if (along < near - h || along > far + h * 0.5) continue;
      const side = dot(c, f.axis);
      if (Math.abs(side) > jaw.half + h) continue;
      // Entre les mâchoires : sous la mâchoire du haut, au-dessus de celle du bas, à cette distance
      const up = -dot(c, f.e2);
      const gap = Math.max(0.05, clamp(along, near, far) * Math.tan(opening));
      if (Math.abs(up) > gap + h * 0.6) continue;
      const score = Math.abs(up) + Math.abs(side) * 0.5 + Math.abs(along - (near + far) / 2) * 0.3;
      if (!best || score < best.score) best = { block: b, along: clamp(along, near, far), score };
    }
  }
  return best;
}

/** Point du repère d'un robot (celui de ses morceaux) où se trouve le point monde `p`, d'après le corps `rb` d'un de ses morceaux. */
const toLocal = (rb: RigidBody, p: Vec3): Vec3 => qrotInv(rb.rotation(), sub(p, rb.translation()));
const toWorld = (rb: RigidBody, p: Vec3): Vec3 => add(rb.translation(), qrot(rb.rotation(), p));

/** Une mâchoire : fermeture (saisie), prise (tenue, écrasement), réouverture. */
export function stepJaw(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, plans: PlannedHit[]): void {
  const jaw = spec.jaw!;
  arm.phaseT += STEP;
  arm.spin = 0;
  const powered = poweredArm(sim, bot, arm);
  // La prise d'abord : avant de lire un corps, on vérifie que tout est encore là
  if (arm.grip && !holdable(sim, arm, powered)) {
    letGo(arm);
  }
  switch (arm.phase) {
    case "ready":
      arm.swing = jaw.open;
      if (arm.trigger && powered) {
        arm.phase = "strike";
        arm.phaseT = 0;
      }
      break;
    case "strike": {
      // Elle se ferme ; ce qui est dans la gueule ouverte de l'angle courant est saisi
      const t = Math.min(1, arm.phaseT / jaw.close);
      arm.swing = jaw.open + (jaw.shut - jaw.open) * t;
      const f = meleeFrame(arm);
      const prey = inMouth(sim, bot, f, jaw, arm.swing);
      if (prey) bite(sim, bot, arm, spec, f, prey.block, prey.along, plans);
      else if (t >= 1) letGo(arm);
      break;
    }
    case "hold": {
      if (!arm.grip) {
        letGo(arm);
        break;
      }
      if (!arm.trigger || arm.phaseT >= jaw.hold) {
        letGo(arm);
        break;
      }
      holdGrip(bot, arm, spec, plans);
      break;
    }
    case "recover": {
      const t = Math.min(1, arm.phaseT / jaw.reopen);
      arm.swing = arm.from + (jaw.open - arm.from) * t * t * (3 - 2 * t);
      if (arm.phaseT >= jaw.reopen + jaw.cooldown) {
        arm.phase = "ready";
        arm.phaseT = 0;
        arm.swing = jaw.open;
      }
      break;
    }
  }
}

/**
 * La prise tient-elle encore ? La mâchoire alimentée, le bloc saisi vivant sur un morceau encore là,
 * son robot pas hors de combat. Un bloc saisi détruit : elle mord le suivant dans sa gueule.
 * Ne lit un corps qu'une fois tout cela vérifié.
 */
function holdable(sim: Simulation, arm: MeleeArm, powered: boolean): boolean {
  const grip = arm.grip!;
  if (!powered || !sim.parts.has(arm.block.part)) return false;
  const prey = grip.block.bot;
  if (!prey.cockpit.alive || !sim.bots.includes(prey)) return false;
  if (grip.block.alive && sim.parts.has(grip.block.part)) return true;
  // Le bloc saisi est tombé : elle mord le plus proche de la prise, plus profond (tous les morceaux
  // d'un robot partagent son repère : le point de la prise y reste le même)
  let next: Block | null = null;
  let nearest = REBITE;
  for (const b of prey.blocks.values()) {
    if (!sim.parts.has(b.part)) continue;
    const d = distance(nearestOnBlock(b, grip.local), grip.local);
    if (d < nearest) {
      nearest = d;
      next = b;
    }
  }
  if (!next) return false;
  grip.block = next;
  return true;
}

/** Elle lâche (ou se rouvre à vide) : réouverture, puis répit. */
function letGo(arm: MeleeArm): void {
  arm.grip = null;
  arm.phase = "recover";
  arm.phaseT = 0;
  arm.from = arm.swing;
}

/** La morsure : elle saisit `block`, au point de sa gueule à `along` m du pivot, et y mord. */
function bite(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, f: MeleeFrame, block: Block, along: number, plans: PlannedHit[]): void {
  const jaw = spec.jaw!;
  const point = add(f.hub, scale(f.e1, along));
  arm.grip = { block, local: toLocal(block.part.rb, point), own: toLocal(arm.block.part.rb, point), since: sim.time, slip: 0, crush: 0 };
  arm.phase = "hold";
  arm.phaseT = 0;
  arm.hitAt = sim.time;
  // Les mâchoires se referment sur le bloc
  arm.swing = clamp(Math.atan((BLOCK_SIZE / 2) / Math.max(0.2, along)), jaw.shut, jaw.open);
  plans.push({
    arm, bot, spec, part: arm.block.part, hub: f.hub, grip: 1, dir: f.e1, impulse: 0, reaction: 0, energy: 1000, damage: jaw.bite,
    contact: { surface: "robot", target: { kind: "block", block }, body: block.part.rb, point, radial: along, normal: null },
  });
}

/** Matrice d'inertie inverse (monde) d'un corps, lue aussitôt (une vue sur la mémoire du WebAssembly). */
function invInertia(rb: RigidBody): number[][] {
  const m = rb.effectiveWorldInvInertia();
  return [[m.m11, m.m12, m.m13], [m.m12, m.m22, m.m23], [m.m13, m.m23, m.m33]];
}

const mulMV = (m: number[][], v: Vec3): Vec3 =>
  vec3(m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z, m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z, m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z);

/**
 * Matrice de masse inverse d'un corps en un point (bras `r` depuis son centre de masse) : ce que vaut
 * en vitesse du point une impulsion qui y est appliquée, 1/m·I − [r]×·I⁻¹·[r]×.
 */
function pointCompliance(invMass: number, inv: number[][], r: Vec3): number[][] {
  const out: number[][] = [];
  const axes = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  for (let j = 0; j < 3; j++) {
    // Colonne j : la vitesse du point pour une impulsion unité le long de l'axe j
    const e = axes[j];
    const col = add(scale(e, invMass), cross(mulMV(inv, cross(r, e)), r));
    out.push([col.x, col.y, col.z]);
  }
  // (rangées et colonnes : la matrice est symétrique)
  return [[out[0][0], out[1][0], out[2][0]], [out[0][1], out[1][1], out[2][1]], [out[0][2], out[1][2], out[2][2]]];
}

/**
 * La prise : le point de la mâchoire et le point de la proie, tenus ensemble par une impulsion entre
 * leurs deux corps (contrainte de point, avec une correction de l'écart), puis une part de leur
 * rotation relative amortie ; au-delà de ce que tient la mâchoire, elle glisse (puis lâche) ; trop
 * écartés, ils s'arrachent. L'écrasement s'accumule et part par tranches (un coup planifié).
 */
function holdGrip(bot: Bot, arm: MeleeArm, spec: MeleeSpec, plans: PlannedHit[]): void {
  const jaw = spec.jaw!;
  const grip = arm.grip!;
  const a = arm.block.part.rb;
  const b = grip.block.part.rb;
  const pa = toWorld(a, grip.own);
  const pb = toWorld(b, grip.local);
  const gap = sub(pa, pb);
  if (len(gap) > jaw.tear) {
    letGo(arm);
    return;
  }
  // Le vérin serre (sur les batteries) ; s'il manque d'énergie, il tient moins
  const share = supply(bot, jaw.power);
  bot.drawn += jaw.power * share;
  const strength = jaw.strength * share;
  const ra = sub(pa, a.worldCom());
  const rb = sub(pb, b.worldCom());
  const ia = invInertia(a);
  const ib = invInertia(b);
  const ka = pointCompliance(a.invMass(), ia, ra);
  const kb = pointCompliance(b.invMass(), ib, rb);
  const k = ka.map((row, i) => row.map((x, j) => x + kb[i][j]));
  const vrel = sub(velocityAt(a, pa), velocityAt(b, pb));
  const target = add(vrel, scale(gap, GRIP_BIAS / STEP));
  const solved = solveLinear(k, [-target.x, -target.y, -target.z]);
  if (!solved) return;
  let impulse = vec3(solved[0], solved[1], solved[2]);
  const cap = strength * STEP;
  const size = len(impulse);
  if (size > cap) {
    // Elle ne tient pas tout : elle glisse ; trop longtemps, elle lâche
    impulse = scale(impulse, cap / size);
    grip.slip += STEP;
    if (grip.slip >= jaw.slip) {
      letGo(arm);
      return;
    }
  } else {
    grip.slip = Math.max(0, grip.slip - STEP * 0.5);
  }
  a.applyImpulseAtPoint(impulse, pa, true);
  b.applyImpulseAtPoint(scale(impulse, -1), pb, true);
  // Leur rotation relative : une part amortie, dans la limite du couple que tient la prise
  const spin = sub(a.angvel(), b.angvel());
  const kAng = ia.map((row, i) => row.map((x, j) => x + ib[i][j]));
  const turn = solveLinear(kAng, [-spin.x * GRIP_SPIN, -spin.y * GRIP_SPIN, -spin.z * GRIP_SPIN]);
  if (turn) {
    let torque = vec3(turn[0], turn[1], turn[2]);
    const most = strength * GRIP_ARM * STEP;
    if (len(torque) > most) torque = scale(torque, most / len(torque));
    a.applyTorqueImpulse(torque, true);
    b.applyTorqueImpulse(scale(torque, -1), true);
  }
  // L'écrasement, par tranches
  grip.crush += jaw.crush * STEP;
  if (grip.crush >= jaw.crush * CRUSH_TICK) {
    const damage = grip.crush;
    grip.crush = 0;
    const f = meleeFrame(arm);
    plans.push({
      arm, bot, spec, part: arm.block.part, hub: f.hub, grip: 1, dir: f.e1, impulse: 0, reaction: 0, energy: CRUSH_ENERGY, damage,
      contact: { surface: "robot", target: { kind: "block", block: grip.block }, body: b, point: pb, radial: 0, normal: null },
    });
  }
}

/** Un bloc ennemi est-il dans la gueule ouverte de cette mâchoire ? (L'IA mord alors.) */
export function jawWouldBite(sim: Simulation, bot: Bot, arm: MeleeArm): boolean {
  const jaw = meleeDef(arm.weapon).jaw;
  if (!jaw || !arm.block.alive) return false;
  return inMouth(sim, bot, meleeFrame(arm), jaw, jaw.open) !== null;
}

/** La mâchoire de ce robot qui tient une proie, s'il en a une. */
export function gripping(bot: Bot): MeleeArm | null {
  return bot.melee.find((a) => a.grip !== null && a.block.alive) ?? null;
}

/** Une arme détruite : sa boule disparaît avec elle, sa prise lâche. */
export function dropMechanics(arm: MeleeArm): void {
  arm.ball = null;
  arm.grip = null;
}

// --- Réseau ---

/**
 * État d'une frappe à mécanique pour l'instantané réseau, en plus du régime, de la phase et de
 * l'angle (communs à toutes les armes de contact) : `link`, l'identifiant du bloc que tient une
 * mâchoire (0 : rien) ; `values`, pour un fléau, l'angle de la manivelle, la boule (depuis le moyeu,
 * axes du monde) et, enroulée, le point d'appui de sa chaîne (de même).
 */
export function mechanicsState(arm: MeleeArm): { link: number; values: number[] } {
  const spec = meleeDef(arm.weapon);
  const link = arm.grip?.block.alive ? arm.grip.block.id : 0;
  if (spec.motion !== "flail" || !arm.ball || !arm.block.alive) return { link, values: [] };
  const hub = meleeFrame(arm).hub;
  const ball = sub(arm.ball.pos, hub);
  const values = [arm.angle, ball.x, ball.y, ball.z, arm.ball.wound];
  if (arm.ball.wrap) {
    const w = sub(arm.ball.wrap.point, hub);
    values.push(w.x, w.y, w.z);
  }
  return { link, values };
}

/**
 * La réplique : la prise d'une mâchoire (`block`, le bloc tenu, ou null), la boule d'un fléau,
 * interpolée entre deux images (`a`, `b`, t de 0 à 1), placée depuis le moyeu tel qu'il est
 * maintenant (le morceau a déjà pris sa pose interpolée).
 */
export function applyMechanics(arm: MeleeArm, block: Block | null, a: readonly number[], b: readonly number[], t: number): void {
  if (block) {
    if (arm.grip?.block !== block) arm.grip = { block, local: vec3(0, 0, 0), own: vec3(0, 0, 0), since: 0, slip: 0, crush: 0 };
  } else {
    arm.grip = null;
  }
  if (meleeDef(arm.weapon).motion !== "flail" || !arm.block.alive) return;
  if (a.length < 5) {
    arm.ball = null;
    return;
  }
  const to = b.length >= 5 ? b : a;
  const hub = meleeFrame(arm).hub;
  arm.angle = a[0] + angleDelta(a[0], to[0]) * t;
  const rel = vec3(lerp(a[1], to[1], t), lerp(a[2], to[2], t), lerp(a[3], to[3], t));
  const pos = add(hub, rel);
  const wound = lerp(a[4], to[4], t);
  const wrapped = a.length >= 8 ? a : to.length >= 8 ? to : null;
  const wrap = wrapped ? { point: add(hub, vec3(wrapped[5], wrapped[6], wrapped[7])), length: 0, axis: vec3(0, 1, 0), since: 0 } : null;
  if (arm.ball) {
    arm.ball.pos = pos;
    arm.ball.wound = wound;
    arm.ball.wrap = wrap;
  } else {
    arm.ball = { pos, vel: vec3(0, 0, 0), wound, wrap };
  }
}

/** (Pour la vue et les essais) la boule d'un fléau, en ce moment. */
export const flailBall = (arm: MeleeArm): FlailBall | null => arm.ball;

/** (Pour la vue) la prise d'une mâchoire, en ce moment. */
export const jawGrip = (arm: MeleeArm): JawGrip | null => arm.grip;
