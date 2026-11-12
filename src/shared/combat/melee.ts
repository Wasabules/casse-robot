import type { RigidBody } from "@dimforge/rapier3d-compat";
import { groundLevel, inWater } from "../arena/layout";
import { rayArena } from "../arena/ray";
import { propNearest } from "../arena/structures";
import { blockDef, blockShape, BLOCK_TYPES } from "../catalog/blocks";
import {
  biteTorque, isBit, meleeAxes, meleeDef, meleeReach, MOTOR_EFFICIENCY, motorPower, spinEnergy, wielded, type MeleeId,
  type MeleeSpec, type SweptRing, type SwingSpec, type ThrustSpec,
} from "../catalog/melee";
import { shapePieces, type ShapeId } from "../catalog/shapes";
import { wheelDef } from "../catalog/wheels";
import { BLOCK_SIZE, STEP } from "../config";
import { cellKey, NEIGHBORS } from "../design/robotDesign";
import { solveLinear } from "../math/linalg";
import { clamp, rand } from "../math/scalar";
import { add, cross, distance, dot, len, norm, qmul, qrot, qrotInv, scale, sub, vec3, type Quat, type Vec3 } from "../math/vec";
import { supply } from "../robot/energy";
import { FLIPPED_UP_Y } from "../robot/righting";
import { linkKey } from "../robot/structure";
import { blockWorldPos } from "../robot/queries";
import type { Block, Bot, Gnaw, HitTarget, MeleeArm, Part } from "../sim/entities";
import type { ImpactSurface } from "../sim/events";
import type { Simulation } from "../sim/simulation";
import type { Readiness } from "./arsenal";
import { burnable, flammability, ignite, igniteProp } from "./burning";
import { DamageBatch, inflict, resistance } from "./damage";
import { organStunned, stunOrgans } from "./emp";
import { dropMechanics, stepFlail, stepFlip, stepJaw } from "./mechanics";
import { dcos, dpow, dsin } from "../math/det";

/*
 * Armes de contact (catalog/melee.ts), une étape du pas (« contact », après les chocs). Le socle
 * commun à toutes, et ce que demandent un rotor (toupie) et un bras déclenché (marteau) :
 *
 * - Régime. Un rotor garde son énergie E = ½·I·ω². Commandé (`MeleeArm.wanted`), alimenté (relié au
 *   cockpit, pas paralysé), son moteur lui donne de quoi monter au plein régime en `spinUp` s
 *   (puissance `motorPower`, prise aux batteries comme celle des réacteurs : `bot.drawn`) ; il perd
 *   en roue libre (E × e^(−2·dt/spinDown)) ; chaque coup lui prend une part de son énergie : on ne
 *   frappe pas en continu, on frappe fort. Ce que le rotor gagne ou perd en moment cinétique, le
 *   robot le reçoit en sens inverse (réaction du moteur : un robot léger pivote en lançant sa toupie).
 * - Coup. La lame n'a pas de collider : à chaque pas, on cherche ce qui entre dans le volume qu'elle
 *   balaie (un anneau autour de l'axe du rotor, `SweptRing`), sans physique, case par case dans la
 *   grille de chaque morceau proche (comme le jet des moteurs, robot/exhaust.ts) : un bloc ou une
 *   roue d'un ennemi, un accessoire (au point le plus proche du moyeu), le décor et le sol (au bord
 *   de la lame, quelques pas sur trois). On frappe ce qui est le plus près du moyeu. Le coup prend à
 *   l'arme `bite` de son énergie ; une part (`fling`) projette la cible : l'impulsion
 *   J = √(2·μ·E_fling), μ la masse réduite des deux corps au point touché (masses et inerties
 *   effectives : un petit robot à grosse toupie rebondit plus que sa cible lourde) ; elle part dans
 *   le sens propre à l'arme (`push` : le long du mouvement de la lame, vers l'extérieur, vers le
 *   haut), éprouve les liaisons faibles de la cible (`DamageBatch.shock`) et revient au robot de
 *   l'arme, au moyeu (`recoil`), où elle éprouve aussi les siennes. Les dégâts (`damage` par kJ du
 *   coup, nature `damageType`) tombent sur ce qui est touché, une part (`spread`) sur ses voisins.
 *   L'arme s'use à chaque coup (`wear`), d'autant plus que ce qu'elle frappe résiste.
 * - Ricochet. Sur un bloc de forme (biseau, coin…), la lame frappe la face qui lui fait le plus face ;
 *   si c'est une pente, l'incidence (cosinus entre la lame et la normale de la face) en dessous de
 *   cos 70° la fait glisser : `grip` va de 0 (rasant) à 1 (franc, une face du cube), et le coup
 *   prend moins d'énergie (0,35 + 0,65·grip), fait moins de dégâts (0,2 + 0,8·grip) et pousse
 *   le long de la pente plutôt que dedans. Le blindage lourd, lui, encaisse (résistance `cut`).
 * - Gyroscope. Un rotor a un moment cinétique L = I·ω le long de son axe ; le robot qui tourne (Ω)
 *   reçoit le couple L × Ω : on l'applique implicitement (Ω' = (1 − dt·I⁻¹·[L]×)⁻¹·Ω, une fois par
 *   morceau), ce qui reste stable même pour un robot léger à grosse toupie. Une toupie à plat (L
 *   vertical) ne réagit pas au lacet, mais un roulis la fait cabrer ou piquer, un tangage la fait
 *   rouler : le robot tient son assiette autrement.
 * - Balourd. Sous la moitié de ses points, le rotor se déséquilibre (excentrement de 0 à
 *   `unbalance` m à 0 point) : une force tournante m·e·ω² au moyeu, qui secoue le robot à la
 *   fréquence de rotation ; la vibration (`vibration`) dégrade sa visée et l'adhérence de ses roues,
 *   et l'use (fatigue) jusqu'à la casse.
 * - Bras déclenché. Sur ordre (`trigger`), si le vérin a de quoi frapper (batteries : `cost` kJ), le
 *   bras part de `rest` vers `end` en accélérant (en `strike` s) ; le premier contact de sa tête sur
 *   l'arc (robot, accessoire, décor, sol) est le coup, avec l'énergie qu'a la tête à cet angle ; il
 *   revient ensuite à l'armement (`recover` s). La réaction, au pivot, soulève l'avant du robot.
 * - Rotor mené par un moteur (`driven` : l'hélice tranchante). Son régime suit la poussée du moteur
 *   de son bloc (`DriveSpec`), sans rien prendre aux batteries (le moteur paie déjà) ni faire
 *   pivoter le robot (le couple de réaction d'un moteur est le sien, `torqueRatio`) ; il frappe,
 *   s'use et précesse comme un rotor.
 * - Ce qui ne bouge pas (le sol, le décor, un accessoire ancré) ne se pousse pas : il renvoie l'arme
 *   le long de sa surface (la normale, plus un frottement contre le sens de la lame). Une toupie
 *   verticale qui touche le sol par-dessous est renvoyée vers le haut : son nez se lève (le salto
 *   arrière d'une arme qui frappe trop bas) ; un marteau qui frappe le sol relève l'avant.
 * - Pointe (lance). Sur ordre, si les batteries ont `cost` kJ, elle sort droit devant son moyeu en
 *   accélérant ; le premier contact de sa pointe le long de sa course est le coup (une décharge :
 *   la même énergie où qu'elle touche) ; puis elle rentre.
 * - Champ (champ broyeur). Son énergie est celle d'un rotor (il se charge sur les batteries, perd
 *   en roue libre) ; tous les `gap` s, il frappe ce qui entre dans une marge autour des blocs de son
 *   morceau (dans la grille, sans physique) : d'abord les armes de contact ennemies qui s'y frottent
 *   (un rotor dont la lame y entre perd `drain` de son énergie, et tout est repoussé), puis les
 *   blocs et les roues les plus enfoncés. Chaque contact prend `bite` de sa charge.
 * - Armes d'énergie. Un rotor sans masse (`gyro`, `unbalance`, `reaction` à 0) ne fait ni
 *   gyroscope, ni balourd, ni réaction ; un coup sans `fling` ni `recoil` ne pousse ni ne recule.
 *   `quench` : sans commande ni courant, ou le moyeu dans l'eau, l'arme s'éteint d'un coup. Un coup
 *   peut allumer ce qu'il touche (`hit.ignite`) ou paralyser localement les organes autour du
 *   point touché (`hit.stun`, voir combat/emp.ts).
 * - Morsure continue (un rotor à `bite` : scie, foreuse). Au lieu de frapper, la lame mord à chaque
 *   pas ce qu'elle touche (le premier qu'elle rencontre en venant de son bloc : le bord de la cible
 *   pour une scie, le premier bloc sur l'axe pour une mèche) : elle prend à son rotor la puissance
 *   de coupe (couple constant × régime, moins sur une pente), le régime baisse donc sous la charge
 *   jusqu'à ce que le moteur la rende ; ce qu'elle prend devient des dégâts, accumulés (`MeleeArm.gnaw`)
 *   et infligés par tranches de BITE_TICK s (sinon soixante lots de dégâts, de retours de tir et
 *   d'événements réseau par seconde) ou dès qu'elle change de cible. Une tranche qui perce son bloc
 *   passe ce qui lui reste au suivant, dans le sens où la lame avance (`feed`), case par case dans la
 *   grille du robot (comme la perforation d'un tir, `pierceRobot`), jusqu'à `depth` m. La force de
 *   coupe (couple de l'outil / rayon, × `grab`) entraîne la cible le long de la lame et tire son
 *   robot à l'opposé, au moyeu ; une mèche (sa pointe est sur l'axe) tord la cible de son couple
 *   (× `gear`, le réducteur), et le robot reçoit le même couple en réaction : le moteur qui tient la
 *   lame contre la charge le rend déjà au robot (la réaction du moteur, ci-dessus), le réducteur y
 *   ajoute (`gear` − 1) fois la charge. `MeleeArm.bite` dit ce qu'elle mord (instantané : effets, son).
 *
 * Tous les coups d'un pas sont mesurés (poses, cibles, impulsions) avant qu'aucun ne soit infligé :
 * infliger reconstruit et libère des colliders et des corps.
 */

/** Un bloc vu comme une boule de ce rayon (m), pour savoir si la lame l'atteint (entre la face, 0,25, et le coin, 0,43). */
const BLOCK_REACH = 0.28;
/** Une roue vue comme une boule de cette part de son rayon. */
const WHEEL_REACH = 0.85;
/** Incidence (cosinus) sous laquelle une lame glisse tout à fait sur une pente (70°). */
export const RICOCHET_COS = dcos((70 * Math.PI) / 180);
/** Le décor et les accessoires se cherchent tous les SCENERY_EVERY pas, le décor sur SCENERY_RAYS rayons du moyeu au bord de la lame. */
const SCENERY_EVERY = 3;
/** Marge (m) au-delà de laquelle un robot est trop loin d'une lame pour qu'on lise ses morceaux. */
const FAR_PART = 3;
const SCENERY_RAYS = 8;
/** Un coup sur le décor prend cette part de ce que prendrait un coup franc sur un robot. */
const SCENERY_BITE = 0.4;
/** Le balourd naît sous cette part des points de structure de l'arme. */
export const UNBALANCE_FROM = 0.5;
/** Force tournante du balourd, au plus (N). */
const MAX_UNBALANCE = 6000;
/** Fatigue du balourd : part des points de structure perdue par seconde, balourd entier, à plein régime ; infligée par tranches. */
const FATIGUE = 0.05;
const FATIGUE_CHUNK = 3;
/** Pas (rad) de la recherche du premier contact de la tête d'un bras le long de son arc. */
const ARC_STEP = 0.06;
const UP = vec3(0, 1, 0);

/** Direction unitaire de `from` vers `to` (vers le haut s'ils se confondent). */
const towards = (from: Vec3, to: Vec3): Vec3 => (distance(from, to) > 1e-6 ? norm(sub(to, from)) : UP);
/** Pas (m) de la recherche du premier contact d'une pointe le long de sa course. */
const THRUST_STEP = 0.05;
/** Un contact avec une arme de contact ennemie pèse d'autant plus, dans ce que prend le champ à sa charge. */
const FIELD_WEAPON_WEIGHT = 1.5;
/** Morsure : ses dégâts tombent par tranches de BITE_TICK s (comme un laser qui tire dix fois par seconde). */
export const BITE_TICK = 0.1;
/** Pas (m) de la progression d'une morsure d'une case à la suivante, dans la grille du robot mordu. */
const GNAW_STEP = BLOCK_SIZE / 2;
/** Une mèche cherche le sol en ce nombre de points le long de sa longueur. */
const BIT_SAMPLES = 4;

/**
 * Position de repos d'un bras (son angle armé), d'une pointe (rentrée, m du moyeu), d'un plateau
 * (en coin) ou d'une mâchoire (ouverte) : `MeleeArm.swing`.
 */
export const restSwing = (spec: MeleeSpec): number => spec.swing?.rest ?? spec.thrust?.retracted ?? spec.plate?.rest ?? spec.jaw?.open ?? 0;

/** État d'une arme de contact qui apparaît : rotor à l'arrêt, bras armé, pointe rentrée, mâchoire ouverte. */
export function newMeleeArm(block: Block, weapon: MeleeId): MeleeArm {
  const rest = restSwing(meleeDef(weapon));
  return {
    block, weapon, spin: 0, angle: 0, phase: "ready", phaseT: 0, swing: rest, from: rest,
    wanted: false, trigger: false, hitAt: -Infinity, fatigue: 0, bite: null, gnaw: null, ball: null, grip: null,
  };
}

/**
 * Armes de contact maniées reliées au cockpit (les seules alimentées) : pas une hélice, que mène son
 * moteur (`wielded`) ; celles-là, seul `updateMelee` les fait tourner, d'après `bot.melee`.
 */
export function liveMelee(bot: Bot): MeleeArm[] {
  const ck = bot.cockpit;
  if (!ck.alive) return [];
  return bot.melee.filter((a) => a.block.alive && a.block.part === ck.part && wielded(meleeDef(a.weapon)));
}

/**
 * Régime d'un rotor, d'un fléau, ou charge d'un champ (0 à 1, du plein régime) ; un bras, une
 * pointe : 1 armé, sinon où en est son retour ; un flipper : la recharge de son vérin ; une
 * mâchoire : 1 ouverte, ce qui lui reste de prise quand elle tient, sa réouverture.
 */
export function meleeCharge(arm: MeleeArm): number {
  const spec = meleeDef(arm.weapon);
  if (spec.spin) return clamp(arm.spin / spec.spin.speed, 0, 1);
  if (spec.flail) return clamp(arm.spin / spec.flail.speed, 0, 1);
  if (spec.jaw) {
    const jaw = spec.jaw;
    if (arm.phase === "hold") return clamp(1 - arm.phaseT / jaw.hold, 0, 1);
    return arm.phase === "recover" ? clamp(arm.phaseT / (jaw.reopen + jaw.cooldown), 0, 1) : 1;
  }
  const recover = spec.swing?.recover ?? spec.thrust?.recover ?? spec.plate?.reload;
  if (recover !== undefined) return arm.phase === "ready" ? 1 : arm.phase === "strike" ? 0 : clamp(arm.phaseT / recover, 0, 1);
  return 0;
}

/** Part du balourd (0 à 1) d'un rotor, d'après ses points de structure : rien au-dessus de `UNBALANCE_FROM`, entier à 0. */
export function unbalanceShare(arm: MeleeArm): number {
  if (!meleeDef(arm.weapon).spin?.unbalance) return 0;
  const health = arm.block.hp / BLOCK_TYPES[arm.block.type].hp;
  return clamp((UNBALANCE_FROM - health) / UNBALANCE_FROM, 0, 1);
}

/**
 * Vibration d'un robot (0 à 1) : celle de son rotor le plus déséquilibré, selon son balourd et le
 * carré de son régime. Elle dégrade sa visée (combat/accuracy.ts) et l'adhérence de ses roues
 * (robot/wheels.ts) ; le client fait trembler le robot et la caméra. Ne lit que l'état des armes et
 * des blocs : elle se calcule aussi sur la réplique réseau.
 */
export function vibration(bot: Bot): number {
  let v = 0;
  for (const arm of bot.melee) {
    const spin = meleeDef(arm.weapon).spin;
    if (!spin || !arm.block.alive || arm.spin <= 0) continue;
    v = Math.max(v, unbalanceShare(arm) * dpow(arm.spin / spin.speed, 2));
  }
  return Math.min(1, v);
}

/**
 * Repère d'une arme de contact dans le monde : la rotation de son bloc, son moyeu, son axe, et deux
 * directions de son plan de rotation (voir `meleeAxes`, catalog/melee.ts).
 */
export interface MeleeFrame {
  q: Quat;
  hub: Vec3;
  axis: Vec3;
  e1: Vec3;
  e2: Vec3;
}

/** Repère actuel d'une arme de contact (lit la pose du morceau de son bloc : marche aussi sur la réplique). */
export function meleeFrame(arm: MeleeArm): MeleeFrame {
  const spec = meleeDef(arm.weapon);
  const rb = arm.block.part.rb;
  const pq = rb.rotation();
  const q = qmul(pq, arm.block.rot);
  const [hx, hy, hz] = spec.hub;
  const hub = add(rb.translation(), qrot(pq, add(arm.block.local, qrot(arm.block.rot, vec3(hx, hy, hz)))));
  const local = meleeAxes(spec.axis);
  return { q, hub, axis: qrot(q, local.axis), e1: qrot(q, local.e1), e2: qrot(q, local.e2) };
}

/** Direction du bras à l'angle `angle` (monde, unitaire), du pivot vers la tête. */
const armDir = (f: MeleeFrame, angle: number): Vec3 => add(scale(f.e1, dcos(angle)), scale(f.e2, -dsin(angle)));

/** Centre de la tête d'un bras à l'angle `angle` (monde). */
export function headAt(frame: MeleeFrame, swing: SwingSpec, angle: number): Vec3 {
  return add(frame.hub, scale(armDir(frame, angle), swing.reach));
}

/** Ce que touche une lame ou une tête. */
export interface Contact {
  surface: ImpactSurface;
  /** Ce qui encaisse (null : le décor, le sol). */
  target: HitTarget | null;
  /** Le corps à pousser (null : fixe). */
  body: RigidBody | null;
  point: Vec3;
  /**
   * Distance à l'axe du rotor de la surface touchée (m : le centre d'un bloc ou d'une roue, moins ce
   * qu'il a de portée) : on frappe ce qui s'avance le plus près du moyeu (un pneu qui dépasse du flanc
   * avant la caisse).
   */
  radial: number;
  /** Face touchée d'un bloc de forme (monde), pour le ricochet ; null : une face du cube. */
  normal: Vec3 | null;
  /**
   * Ce qui ne bouge pas (le sol, le décor, un accessoire ancré) : la normale de sa surface, tournée
   * vers l'arme (monde) ; elle renvoie l'arme le long d'elle. Absente : un corps qu'on pousse.
   */
  face?: Vec3;
  /** Le sol lui-même (pas un mur du décor) : un disque debout y mord (`MeleeHit.ground`). */
  floor?: boolean;
}

/** Un coup mesuré, prêt à être infligé. */
export interface PlannedHit {
  arm: MeleeArm;
  bot: Bot;
  spec: MeleeSpec;
  contact: Contact;
  /**
   * Énergie du coup (J), qualité (0 : rasant, 1 : franc), sens de l'impulsion (unitaire), sens où
   * va la lame au point touché (unitaire ; à défaut, celui de l'impulsion), moyeu (monde).
   */
  energy: number;
  grip: number;
  dir: Vec3;
  motion?: Vec3;
  hub: Vec3;
  part: Part;
  /** Sans événement `meleeHit` (les contacts secondaires d'un champ : un seul par coup suffit au rendu et au son). */
  quiet?: boolean;
  /**
   * Ce qu'une arme a déjà calculé elle-même (un champ qui repousse une arme ennemie, les frappes à
   * mécanique de combat/mechanics.ts) : l'impulsion donnée à la cible (N·s), celle que reçoit son
   * robot au moyeu, les dégâts bruts du coup. Sinon : l'impulsion √(2·μ·E·`fling`), la réaction
   * `recoil` × elle, les dégâts `damage` × E.
   */
  impulse?: number;
  reaction?: number;
  damage?: number;
}

/** Frottement d'une lame sur ce qui ne bouge pas : la part de la réaction contre son sens de passage. */
const SCRAPE = 0.5;

/**
 * Ce qu'une morsure pousse et tord à ce pas, mesuré : la force de coupe (N, monde) sur la cible au
 * point mordu et sur son propre morceau au moyeu, en sens inverse ; le couple de l'outil (N·m,
 * autour de `axis`, dans son sens de rotation) sur la cible ; le surcroît de réaction du réducteur
 * (N·m) sur son propre morceau.
 */
interface PlannedBite {
  part: Part;
  hub: Vec3;
  body: RigidBody | null;
  point: Vec3;
  axis: Vec3;
  force: Vec3;
  torque: number;
  twist: number;
}

/** Une tranche de morsure à infliger. */
interface GnawDue {
  arm: MeleeArm;
  bot: Bot;
  gnaw: Gnaw;
}

/** Ce que mesure un pas des armes de contact, avant d'infliger quoi que ce soit. */
interface MeleePlans {
  hits: PlannedHit[];
  bites: PlannedBite[];
  due: GnawDue[];
}

/**
 * Un pas des armes de contact : régime des rotors (et réaction de leur moteur), balourd, coups et
 * morsures mesurés ; puis le gyroscope de chaque morceau ; puis les poussées, puis les dégâts,
 * infligés après avoir tout mesuré ; enfin la fatigue des rotors déséquilibrés. Les commandes de ce
 * pas sont ensuite remises à zéro.
 */
export function updateMelee(sim: Simulation): void {
  const plans: MeleePlans = { hits: [], bites: [], due: [] };
  const gyros = new Map<Part, Vec3>();
  const tired: MeleeArm[] = [];
  for (const bot of sim.bots) {
    if (!bot.melee.length) continue;
    for (const arm of bot.melee) {
      arm.bite = null;
      if (!arm.block.alive) {
        arm.spin = 0;
        arm.phase = "ready";
        arm.swing = arm.from = restSwing(meleeDef(arm.weapon));
        dropMechanics(arm);
      } else {
        const spec = meleeDef(arm.weapon);
        switch (spec.motion) {
          case "spin":
          case "driven":
            stepRotor(sim, bot, arm, spec, gyros, plans);
            if (arm.fatigue >= FATIGUE_CHUNK) tired.push(arm);
            break;
          case "swing":
            stepSwing(sim, bot, arm, spec, plans.hits);
            break;
          case "thrust":
            stepThrust(sim, bot, arm, spec, plans.hits);
            break;
          case "field":
            stepField(sim, bot, arm, spec, gyros, plans.hits);
            break;
          // Frappes à mécanique (combat/mechanics.ts)
          case "flip":
            stepFlip(sim, bot, arm, spec, plans.hits);
            break;
          case "flail":
            stepFlail(sim, bot, arm, spec, gyros, plans.hits);
            break;
          case "grip":
            stepJaw(sim, bot, arm, spec, plans.hits);
            break;
          default:
            // Un mouvement de plus : TypeScript refuse qu'on l'oublie ici
            spec.motion satisfies never;
        }
      }
      // Une morsure qui cesse : ce qu'elle a accumulé tombe tout de suite
      if (arm.gnaw && !arm.bite) {
        plans.due.push({ arm, bot, gnaw: arm.gnaw });
        arm.gnaw = null;
      }
      arm.wanted = false;
      arm.trigger = false;
    }
  }
  // (pendant que le gyroscope du cockpit redresse un robot renversé, il l'emporte sur ses rotors)
  for (const [part, momentum] of gyros) if (part.bot.righting <= 0) precess(part, momentum);
  if (plans.hits.length || plans.bites.length || plans.due.length) landHits(sim, plans);
  for (const arm of tired) {
    // (un coup de ce pas a pu l'emporter)
    if (!arm.block.alive) continue;
    const batch = new DamageBatch();
    batch.add({ kind: "block", block: arm.block }, arm.fatigue, "impact");
    arm.fatigue = 0;
    inflict(sim, batch, vec3(0, 1, 0), null);
  }
}

/**
 * L'arme est-elle alimentée ? Reliée au cockpit, ni elle ni son robot paralysés, et (une arme
 * d'énergie, `quench`) son moyeu hors de l'eau. `frame` : son repère, s'il est déjà calculé.
 */
function powerOk(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, frame?: MeleeFrame): boolean {
  const ck = bot.cockpit;
  if (!ck.alive || arm.block.part !== ck.part || organStunned(sim, arm.block)) return false;
  return !spec.quench || !inWater(sim.arena, (frame ?? meleeFrame(arm)).hub);
}

/** Ce que laisse à une arme son régime d'un pas : son énergie (J), son repère, son sens de rotation. */
interface Regime {
  energy: number;
  frame: MeleeFrame;
  sense: number;
}

/**
 * Le régime d'une arme à `spin` (un rotor, une lame d'énergie, la charge d'un champ) : pertes de la
 * roue libre, moteur (dans la limite des batteries), réaction du moteur sur le robot, moment
 * cinétique (pour le gyroscope), balourd. Une arme qui s'éteint sans courant (`quench`) tombe à zéro
 * d'un coup. null : elle ne tourne pas.
 */
function stepRegime(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, gyros: Map<Part, Vec3>): Regime | null {
  const spin = spec.spin!;
  // (une arme d'énergie a besoin de son repère pour savoir si elle est dans l'eau)
  let frame = spec.quench ? meleeFrame(arm) : null;
  const before = arm.spin;
  let energy: number;
  if (spec.drive) {
    // Mené par le moteur de son bloc (une hélice) : il rejoint le régime que donne la poussée
    arm.spin = drivenSpeed(sim, bot, arm, spec);
    energy = spinEnergy(spin, arm.spin);
  } else {
    const powered = arm.wanted && powerOk(sim, bot, arm, spec, frame ?? undefined);
    const full = spinEnergy(spin, spin.speed);
    // Pertes de la roue libre, puis le moteur (dans la limite de ce que donnent les batteries)
    energy = spinEnergy(spin, before) * Math.exp((-2 * STEP) / spin.spinDown);
    // Une arme d'énergie sans courant s'éteint d'un coup : rien ne tourne qui garderait son élan
    if (spec.quench && !powered) energy = 0;
    if (powered && energy < full) {
      const power = motorPower(spin);
      const gain = Math.min(full - energy, power * 1000 * MOTOR_EFFICIENCY * supply(bot, power) * STEP);
      energy += gain;
      bot.drawn += gain / MOTOR_EFFICIENCY / STEP / 1000;
    }
    arm.spin = Math.sqrt((2 * energy) / spin.inertia);
  }
  const sense = spin.direction ?? 1;
  arm.angle = (arm.angle + sense * arm.spin * STEP) % (2 * Math.PI);
  if (arm.spin < 0.01 && before < 0.01) return null;
  frame ??= meleeFrame(arm);
  const part = arm.block.part;
  // Ce que le rotor gagne en moment cinétique, le robot le perd (réaction du moteur, frottements) ;
  // une lame d'énergie, un champ : rien ne tourne vraiment (`reaction` 0) ; un rotor mené par un
  // moteur : c'est le couple de réaction du moteur (`torqueRatio`), déjà compté
  const gained = spin.inertia * (arm.spin - before) * sense * (spec.drive ? 0 : spin.reaction ?? 1);
  if (Math.abs(gained) > 1e-6) part.rb.applyTorqueImpulse(scale(frame.axis, -gained), true);
  if (spin.gyro > 0) gyros.set(part, add(gyros.get(part) ?? vec3(0, 0, 0), scale(frame.axis, spin.inertia * arm.spin * sense * spin.gyro)));
  // Balourd : une force qui tourne avec le rotor, au moyeu ; et la fatigue qu'il impose à l'arme
  const unbalance = unbalanceShare(arm);
  if (unbalance > 0 && spin.unbalance > 0) {
    const force = Math.min(MAX_UNBALANCE, spin.mass * spin.unbalance * unbalance * dpow(arm.spin, 2));
    const out = add(scale(frame.e1, dcos(arm.angle)), scale(frame.e2, dsin(arm.angle)));
    part.rb.applyImpulseAtPoint(scale(out, force * STEP), frame.hub, true);
    arm.fatigue += FATIGUE * unbalance * dpow(arm.spin / spin.speed, 2) * BLOCK_TYPES[arm.block.type].hp * STEP;
  }
  return { energy, frame, sense };
}

/** Un rotor : régime (et ce qui l'accompagne), puis un coup de sa lame, ou sa morsure (une lame qui mord). */
function stepRotor(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, gyros: Map<Part, Vec3>, plans: MeleePlans): void {
  const regime = stepRegime(sim, bot, arm, spec, gyros);
  if (!regime) return;
  const { energy, frame, sense } = regime;
  const spin = spec.spin!;
  const part = arm.block.part;
  const scenery = (sim.time / STEP + arm.block.id) % SCENERY_EVERY < 1;
  // Une lame qui mord en continu (scie, foreuse)
  if (spec.bite) {
    if (arm.spin >= spec.hit.minSpeed * spin.speed) biteRotor(sim, bot, arm, spec, frame, energy, scenery, plans);
    return;
  }
  // Un coup, si la lame tourne assez vite et qu'elle est revenue depuis le dernier
  if (arm.spin < spec.hit.minSpeed * spin.speed || sim.time - arm.hitAt < spec.hit.gap) return;
  const contact = rotorContact(sim, bot, frame, spec.blade!, scenery);
  if (!contact) return;
  // Le sens de la lame au point touché : tangent au cercle, dans le sens de rotation
  const rel = sub(contact.point, frame.hub);
  const radialDir = norm(sub(rel, scale(frame.axis, dot(rel, frame.axis))));
  const tangent = scale(norm(cross(frame.axis, radialDir)), sense);
  if (contact.target?.kind === "block") contact.normal = shapeFace(contact.target.block, cross(frame.axis, radialDir));
  const grip = contact.normal ? incidence(contact.normal, tangent) : 1;
  // Le décor prend moins qu'un robot ; le sol, selon l'arme (un disque debout y mord)
  const fixed = contact.surface !== "scenery" ? 1 : contact.floor ? spec.hit.ground ?? SCENERY_BITE : SCENERY_BITE;
  const bite = spec.hit.bite * (0.35 + 0.65 * grip) * fixed;
  const hitEnergy = energy * bite;
  arm.spin = Math.sqrt((2 * (energy - hitEnergy)) / spin.inertia);
  arm.hitAt = sim.time;
  // Son morceau renversé (couché, à l'envers), la lame racle le sol : elle y perd son énergie sans
  // renvoyer son robot (sinon un anneau-coque à l'envers rebondissait sans fin sur le sol, à plusieurs
  // m/s, et son gyroscope ne pouvait jamais le redresser : il fallait qu'il se pose)
  if (contact.floor && qrot(part.rb.rotation(), UP).y < FLIPPED_UP_Y) return;
  const p = spec.hit.push;
  const dir = slide(norm(add(add(add(scale(tangent, p.tangent), scale(radialDir, p.radial)), scale(frame.axis, p.axial * sense)), vec3(0, p.lift, 0))), contact.normal, grip);
  plans.hits.push({ arm, bot, spec, contact, energy: hitEnergy, grip, dir, motion: tangent, hub: frame.hub, part });
}

/**
 * Régime d'un rotor mené par le moteur de son bloc (une hélice) : au ralenti dès que le moteur est
 * alimenté (relié au cockpit, robot pas paralysé), plus vite avec sa poussée, arrêté sous `stop` de
 * la poussée maximale (gaz coupés) ; il le rejoint en `spinUp` s (`spinDown` s en ralentissant).
 * Après un coup, le moteur le relance de même.
 */
function drivenSpeed(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec): number {
  const spin = spec.spin!;
  const drive = spec.drive!;
  const ck = bot.cockpit;
  const engine = blockDef(arm.block.type).thruster;
  const t = engine ? bot.thrusters.find((th) => th.block === arm.block) : undefined;
  const powered = !!t && ck.alive && arm.block.part === ck.part && !organStunned(sim, arm.block);
  const ratio = t && engine && powered ? clamp(t.thrust / engine.maxThrust, 0, 1) : 0;
  const target = ratio < drive.stop ? 0 : spin.speed * (drive.idle + (1 - drive.idle) * ratio);
  const tau = target > arm.spin ? spin.spinUp : spin.spinDown;
  return arm.spin + (target - arm.spin) * (1 - Math.exp(-STEP / tau));
}

/** Contact d'une lame qui mord avec le décor, gardé SCENERY_EVERY pas (le décor ne se cherche qu'un pas sur trois). */
const SCENERY_MEMO = new WeakMap<MeleeArm, { contact: Contact | null; time: number }>();

/**
 * Une lame qui mord (rotor à `bite`) : ce qu'elle mord à ce pas, ce qu'elle prend à son rotor (le
 * régime baisse sous la charge), la force et le couple qu'elle exerce, et les dégâts qu'elle
 * accumule (une tranche part toutes les BITE_TICK s, ou quand elle change de cible). `energy` :
 * celle du rotor après son moteur, à ce pas.
 */
function biteRotor(
  sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, frame: MeleeFrame, energy: number, scenery: boolean, plans: MeleePlans,
): void {
  const spin = spec.spin!;
  const bite = spec.bite!;
  const blade = spec.blade!;
  const axial = bite.feed === "axial";
  const base = blockWorldPos(arm.block);
  // Les robots et les accessoires à chaque pas ; le décor un pas sur trois, gardé entre-temps
  let contact = rotorContact(sim, bot, frame, blade, false, base);
  let ground: Contact | null;
  const memo = SCENERY_MEMO.get(arm);
  if (scenery || !memo || sim.time - memo.time > SCENERY_EVERY * STEP + 1e-9) {
    ground = sceneryContact(sim, frame, blade);
    SCENERY_MEMO.set(arm, { contact: ground, time: sim.time });
  } else {
    ground = memo.contact;
  }
  if (ground && (!contact || distance(ground.point, base) < distance(contact.point, base))) contact = ground;
  if (!contact) return;
  const sense = spin.direction ?? 1;
  // Le sens de la lame au point mordu : le long du bord du disque (dans le sens de rotation), ou de l'axe d'une mèche
  const rel = sub(contact.point, frame.hub);
  const flat = sub(rel, scale(frame.axis, dot(rel, frame.axis)));
  const radialDir = len(flat) > 1e-4 ? norm(flat) : frame.e1;
  const tangent = scale(norm(cross(frame.axis, radialDir)), sense);
  const tip = scale(frame.axis, Math.sign(dot(sub(frame.hub, base), frame.axis)) || 1);
  const motion = axial ? tip : tangent;
  // Le sens où elle avance dans la cible : le long de l'axe d'une mèche, ou de son bloc vers ce
  // qu'elle mord, dans le plan du disque. Une pente se juge sur lui : un glacis rasant la fait glisser
  let feed = tip;
  if (!axial) {
    const out = sub(contact.point, base);
    const inPlane = sub(out, scale(frame.axis, dot(out, frame.axis)));
    feed = len(inPlane) > 1e-3 ? norm(inPlane) : radialDir;
  }
  if (contact.target?.kind === "block") contact.normal = shapeFace(contact.target.block, feed);
  const grip = contact.normal ? incidence(contact.normal, feed) : 1;
  // Ce qu'elle prend au rotor : la puissance de coupe (couple constant × régime), moins sur une pente et sur le décor
  const omega = arm.spin;
  const torque = biteTorque(spin, bite) * (0.35 + 0.65 * grip) * (contact.surface === "scenery" ? SCENERY_BITE : 1);
  const drained = Math.min(energy, torque * omega * STEP);
  if (drained <= 0) return;
  arm.spin = Math.sqrt((2 * (energy - drained)) / spin.inertia);
  const held = drained / (omega * STEP); // le couple qu'elle a vraiment opposé (moins, si le rotor n'avait plus de quoi)
  const dir = slide(motion, contact.normal, grip);
  arm.bite = { point: contact.point, dir, surface: contact.surface, power: drained / STEP / 1000, glance: grip < 0.6 };
  // La force de coupe tire la cible le long de la lame (et son robot à l'opposé) ; le couple de l'outil tord la cible
  const tool = held * bite.gear;
  // (les dents sont au bord de la lame : la force de coupe est le couple de l'outil rapporté à son rayon)
  const radius = Math.max(0.05, blade.outer);
  plans.bites.push({
    part: arm.block.part, hub: frame.hub, body: contact.body, point: contact.point, axis: scale(frame.axis, sense),
    force: axial ? vec3(0, 0, 0) : scale(dir, (bite.grab * tool) / radius),
    torque: axial ? tool : 0,
    twist: held * (bite.gear - 1),
  });
  // Les dégâts qu'elle accumule : une tranche par cible
  const damage = contact.surface === "scenery" ? 0 : (drained / 1000) * spec.hit.damage * (0.2 + 0.8 * grip);
  if (arm.gnaw && !sameTarget(arm.gnaw.target, contact.target)) {
    plans.due.push({ arm, bot, gnaw: arm.gnaw });
    arm.gnaw = null;
  }
  const target = contact.target;
  const cell = target?.kind === "block"
    ? { bot: target.block.bot, part: target.block.part, x: target.block.x, y: target.block.y, z: target.block.z, feed: qrotInv(target.block.part.rb.rotation(), feed) }
    : null;
  const gnaw = arm.gnaw ?? (arm.gnaw = { target, damage: 0, cut: 0, cell, point: contact.point, dir, hub: frame.hub, since: sim.time });
  gnaw.damage += damage;
  gnaw.cut += drained;
  gnaw.cell = cell ?? gnaw.cell;
  gnaw.point = contact.point;
  gnaw.dir = dir;
  gnaw.hub = frame.hub;
  if (sim.time - gnaw.since + STEP / 2 >= BITE_TICK) {
    plans.due.push({ arm, bot, gnaw });
    arm.gnaw = null;
  }
}

/** Deux cibles de morsure sont-elles la même (le décor, null, compte pour une) ? */
function sameTarget(a: HitTarget | null, b: HitTarget | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "block") return b.kind === "block" && a.block === b.block;
  if (a.kind === "wheel") return b.kind === "wheel" && a.wheel === b.wheel;
  return b.kind === "prop" && a.prop === b.prop;
}

/**
 * Qualité d'un coup sur une face de normale `normal` (sortante, monde) d'une lame qui va selon `motion` :
 * 1 de face, 0 au-delà de 70° (elle glisse).
 */
function incidence(normal: Vec3, motion: Vec3): number {
  const c = -dot(normal, motion);
  return clamp((c - RICOCHET_COS) / (1 - RICOCHET_COS), 0, 1);
}

/** Sens de l'impulsion d'un coup qui glisse sur une pente : la part qui s'enfonce dans la face s'efface avec la qualité. */
function slide(dir: Vec3, normal: Vec3 | null, grip: number): Vec3 {
  if (!normal || grip >= 1) return dir;
  const into = -dot(dir, normal);
  if (into <= 0) return dir;
  return norm(add(dir, scale(normal, into * (1 - grip))));
}

/**
 * Ce que touche la lame d'un rotor : parmi les blocs et les roues des robots ennemis, les
 * accessoires, et (quand `scenery`) le décor et le sol au bord de la lame, le plus proche du moyeu ;
 * ou, pour une lame qui mord (`base` : le centre de son bloc), le plus proche de son bloc : le
 * premier qu'elle rencontre en venant de son robot (le bord de la cible pour une scie, le premier
 * bloc sur l'axe pour une mèche). La face touchée d'un bloc de forme se cherche ensuite (`shapeFace`).
 */
function rotorContact(sim: Simulation, bot: Bot, f: MeleeFrame, blade: SweptRing, scenery: boolean, base: Vec3 | null = null): Contact | null {
  let best = null as Contact | null;
  let bestKey = Infinity;
  const consider = (c: Contact, key: number): void => {
    if (key < bestKey) {
      best = c;
      bestKey = key;
    }
  };
  // Rang d'un contact : sa distance à l'axe, ou à la base d'une lame qui mord
  const keyOf = (radial: number, at: Vec3): number => (base ? distance(at, base) : radial);
  // Dans le volume balayé : à la hauteur de la lame, entre ses rayons (avec une marge `reach`)
  const inside = (rel: Vec3, axis: Vec3, reach: number): { along: number; radial: number } | null => {
    const along = dot(rel, axis);
    if (Math.abs(along) > blade.half + reach) return null;
    const radial = len(sub(rel, scale(axis, along)));
    if (radial > blade.outer + reach || radial < blade.inner - reach) return null;
    return { along, radial };
  };
  const extent = Math.max(blade.outer, blade.half);
  for (const other of sim.bots) {
    if (other === bot || other.team === bot.team || !other.blocks.size) continue;
    // (un robot loin de là : on ne lit pas ses corps ; la marge couvre un morceau qui s'en écarte)
    if (distance(other.lastPos, f.hub) > extent + 2 * (other.radius + other.top) + FAR_PART) continue;
    for (const part of other.parts) {
      const rb = part.rb;
      const t = rb.translation();
      if (distance(t, f.hub) > extent + other.radius + other.top + 1) continue;
      const q = rb.rotation();
      const hubL = qrotInv(q, sub(f.hub, t));
      const axisL = qrotInv(q, f.axis);
      const baseL = base ? qrotInv(q, sub(base, t)) : null;
      for (const b of part.blocks) {
        const rel = sub(b.local, hubL);
        const at = inside(rel, axisL, BLOCK_REACH);
        if (!at) continue;
        // Rang : la distance à l'axe de sa surface (ce qui s'avance le plus près du moyeu), ou à la base d'une lame qui mord
        const key = baseL ? len(sub(b.local, baseL)) : at.radial - BLOCK_REACH;
        if (key >= bestKey) continue;
        // Le point de la lame le plus proche du bloc ; pour une lame qui mord, là où elle y entre
        const out = at.radial > 1e-3 ? scale(sub(rel, scale(axisL, at.along)), 1 / at.radial) : qrotInv(q, f.e1);
        const pointL = baseL
          ? entryPoint(b.local, baseL, hubL, axisL, blade)
          : add(hubL, add(scale(axisL, clamp(at.along, -blade.half, blade.half)), scale(out, clamp(at.radial - BLOCK_SIZE / 2, blade.inner, blade.outer))));
        consider(
          { surface: "robot", target: { kind: "block", block: b }, body: rb, point: add(t, qrot(q, pointL)), radial: at.radial - BLOCK_REACH, normal: null },
          key,
        );
      }
    }
    for (const w of other.wheels) {
      if (!w.part) continue;
      const c = w.rb.translation();
      const reach = wheelDef(w.type).radius * WHEEL_REACH;
      const at = inside(sub(c, f.hub), f.axis, reach);
      if (!at) continue;
      // (le pneu dépasse du flanc : une lame basse le rencontre avant la caisse)
      const key = keyOf(at.radial - reach, c);
      if (key >= bestKey) continue;
      consider({ surface: "robot", target: { kind: "wheel", wheel: w }, body: w.part.rb, point: c, radial: at.radial - reach, normal: null }, key);
    }
  }
  // Les accessoires : à chaque pas pour une lame qui mord, un pas sur trois (`scenery`) pour un coup (ils ne fuient pas la lame)
  const spots = sim.arena.props;
  for (const prop of scenery || base ? sim.props : []) {
    if (prop.hp <= 0) continue;
    const size = Math.max(prop.half.x, prop.half.y, prop.half.z);
    // Un accessoire ancré ne bouge pas : sa place dans l'arène suffit pour l'écarter, sans relire son
    // corps (elle peut être à son pied : la marge est plus large)
    const spot = prop.fixed ? spots[prop.spot] : undefined;
    if (spot && distance(spot.pos, f.hub) > extent + size * 2.8 + 0.5) continue;
    if (distance(prop.rb.translation(), f.hub) > extent + size * 1.8 + 0.5) continue;
    const p = propNearest(prop, base ?? f.hub);
    const at = inside(sub(p, f.hub), f.axis, 0.02);
    if (!at) continue;
    const key = keyOf(at.radial, p);
    if (key >= bestKey) continue;
    consider(
      {
        surface: "prop", target: { kind: "prop", prop }, body: prop.fixed ? null : prop.rb, point: p, radial: at.radial, normal: null,
        face: prop.fixed ? towards(p, f.hub) : undefined,
      },
      key,
    );
  }
  if (scenery) {
    const ground = sceneryContact(sim, f, blade);
    if (ground) consider(ground, keyOf(ground.radial, ground.point));
  }
  return best;
}

/**
 * Point où une lame qui mord entre dans un bloc (repère du robot mordu, `center` : le centre du
 * bloc) : sur sa face tournée vers la base de la lame, ramené dans le volume de la lame (sur l'axe
 * d'une mèche).
 */
function entryPoint(center: Vec3, base: Vec3, hub: Vec3, axis: Vec3, blade: SweptRing): Vec3 {
  if (isBit(blade)) {
    const toward = Math.sign(dot(sub(hub, base), axis)) || 1;
    const along = clamp(dot(sub(center, hub), axis) - (toward * BLOCK_SIZE) / 2, -blade.half, blade.half);
    return add(hub, scale(axis, along));
  }
  const back = sub(base, center);
  const flat = sub(back, scale(axis, dot(back, axis)));
  const d = len(flat);
  const p = d > 1e-3 ? add(center, scale(flat, Math.min(BLOCK_SIZE / 2, d) / d)) : center;
  // Dans l'épaisseur de la lame
  const along = dot(sub(p, hub), axis);
  return sub(p, scale(axis, along - clamp(along, -blade.half, blade.half)));
}

/**
 * Le décor et le sol que touche une lame : au bord d'un disque (huit rayons du moyeu dans son plan,
 * et le sol sous son bord), ou le long d'une mèche (un rayon de sa base à sa pointe, et le sol en
 * quelques points de sa longueur). `radial` : la distance au moyeu (disque) ou à la base (mèche).
 */
function sceneryContact(sim: Simulation, f: MeleeFrame, blade: SweptRing): Contact | null {
  const arena = sim.arena;
  if (isBit(blade)) {
    // La mèche, de sa base (côté -axe) à sa pointe
    const start = sub(f.hub, scale(f.axis, blade.half));
    const length = 2 * blade.half;
    let best = rayArena(arena, start, f.axis, length);
    for (let k = 1; k <= BIT_SAMPLES; k++) {
      const s = (length * k) / BIT_SAMPLES;
      if (best !== null && s >= best) break;
      const p = add(start, scale(f.axis, s));
      if (p.y - blade.outer <= groundLevel(arena, p.x, p.z)) best = s;
    }
    if (best === null) return null;
    const p = add(start, scale(f.axis, best));
    const ground = groundLevel(arena, p.x, p.z);
    return { surface: "scenery", target: null, body: null, point: vec3(p.x, clamp(ground, p.y - blade.outer, p.y), p.z), radial: best, normal: null };
  }
  let best = null as Contact | null;
  // Les boîtes du décor à portée de la lame (une grande arène en a des centaines)
  const near = arena.boxes.filter((box) => box.kind !== "bound" && distance(box.pos, f.hub) <= blade.outer + len(box.half));
  for (let i = 0; i < SCENERY_RAYS; i++) {
    const a = (i / SCENERY_RAYS) * Math.PI * 2;
    const out = add(scale(f.e1, dcos(a)), scale(f.e2, dsin(a)));
    const hit = near.length || arena.terrain ? rayArena(arena, f.hub, out, blade.outer, near) : null;
    const reach = hit ?? blade.outer;
    const rim = add(f.hub, scale(out, reach));
    // Le sol (ou le relief) sous le bord de la lame, plus haut que son tranchant
    const ground = groundLevel(arena, rim.x, rim.z);
    const low = rim.y - blade.half * Math.abs(f.axis.y) - (1 - Math.abs(f.axis.y)) * 0.05;
    if ((hit !== null || low <= ground) && (!best || reach < best.radial)) {
      best = {
        surface: "scenery", target: null, body: null, point: hit !== null ? rim : vec3(rim.x, ground, rim.z), radial: reach, normal: null,
        // Le mur fait face au moyeu ; le sol renvoie vers le haut
        face: hit !== null ? scale(out, -1) : UP, floor: hit === null,
      };
    }
  }
  return best;
}

/**
 * Face d'un bloc de forme (biseau, coin, pente…) que frappe une lame qui va selon `motion` (monde) :
 * parmi celles qui lui font face, celle qui offre le plus de surface dans ce sens ; null pour un
 * cube, ou si c'est une face du cube (un flanc droit : coup franc).
 */
function shapeFace(block: Block, motion: Vec3): Vec3 | null {
  const shape = blockShape(block.type);
  if (!shape) return null;
  const bq = qmul(block.part.rb.rotation(), block.rot);
  const local = qrotInv(bq, norm(motion));
  let bestFace: Vec3 | null = null;
  let bestArea = 0;
  for (const face of shapeFaces(shape)) {
    const facing = -dot(face.normal, local);
    if (facing <= 0.02) continue;
    const projected = face.area * facing;
    if (projected > bestArea) {
      bestArea = projected;
      bestFace = face.normal;
    }
  }
  if (!bestFace) return null;
  const axisAligned = Math.max(Math.abs(bestFace.x), Math.abs(bestFace.y), Math.abs(bestFace.z)) > 0.999;
  return axisAligned ? null : qrot(bq, bestFace);
}

/** Faces d'une forme (normale sortante, aire, dans le cube de demi-côté 1), calculées une fois. */
const FACES = new Map<ShapeId, { normal: Vec3; area: number }[]>();

function shapeFaces(shape: ShapeId): { normal: Vec3; area: number }[] {
  let faces = FACES.get(shape);
  if (!faces) {
    faces = shapePieces(shape).flatMap((p) => p.faces.map((face) => {
      let s = vec3(0, 0, 0);
      const pts = face.points;
      for (let i = 1; i + 1 < pts.length; i++) s = add(s, cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0])));
      return { normal: face.normal, area: len(s) / 2 };
    }));
    FACES.set(shape, faces);
  }
  return faces;
}

/** Un bras déclenché : armement, frappe le long de son arc (premier contact), retour. */
function stepSwing(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, plans: PlannedHit[]): void {
  const swing = spec.swing!;
  arm.phaseT += STEP;
  const arc = swing.rest - swing.end;
  switch (arm.phase) {
    case "ready":
      arm.swing = swing.rest;
      arm.spin = 0;
      // Le vérin se charge sur les batteries (alimenté : relié au cockpit, pas paralysé ; un fouet, hors de l'eau)
      if (arm.trigger && bot.energy >= swing.cost && powerOk(sim, bot, arm, spec)) {
        bot.energy -= swing.cost;
        arm.phase = "strike";
        arm.phaseT = 0;
      }
      break;
    case "strike": {
      // La tête accélère d'un bout à l'autre de l'arc (accélération constante) : son énergie croît avec l'angle parcouru
      const t = Math.min(1, arm.phaseT / swing.strike);
      const prev = arm.swing;
      const next = swing.rest - arc * t * t;
      arm.spin = (2 * arc * t) / swing.strike;
      const frame = meleeFrame(arm);
      const found = headContact(sim, bot, frame, swing, prev, next);
      if (found) {
        const { contact, angle } = found;
        arm.swing = angle;
        const energy = swing.energy * clamp((swing.rest - angle) / arc, 0, 1);
        // Sens de la tête à cet angle (l'angle décroît : elle descend), vers l'extérieur le long du bras, le long du pivot
        const motion = norm(add(scale(frame.e1, dsin(angle)), scale(frame.e2, dcos(angle))));
        const outward = armDir(frame, angle);
        const p = spec.hit.push;
        const dir = norm(add(add(add(scale(motion, p.tangent), scale(outward, p.radial)), scale(frame.axis, p.axial)), vec3(0, p.lift, 0)));
        arm.hitAt = sim.time;
        plans.push({ arm, bot, spec, contact, energy, grip: 1, dir, motion, hub: frame.hub, part: arm.block.part });
        recover(arm);
      } else {
        arm.swing = next;
        if (t >= 1) recover(arm);
      }
      break;
    }
    case "recover": {
      const t = Math.min(1, arm.phaseT / swing.recover);
      arm.spin = 0;
      arm.swing = arm.from + (swing.rest - arm.from) * t * t * (3 - 2 * t);
      if (t >= 1) {
        arm.phase = "ready";
        arm.phaseT = 0;
        arm.swing = swing.rest;
      }
      break;
    }
  }
}

function recover(arm: MeleeArm): void {
  arm.phase = "recover";
  arm.phaseT = 0;
  arm.from = arm.swing;
}

/** Pointe d'une lance sortie de `extension` m (monde). */
export function tipAt(frame: MeleeFrame, extension: number): Vec3 {
  return add(frame.hub, scale(frame.e1, extension));
}

/**
 * Une pointe (lance) : rentrée (`ready`), elle sort sur ordre si les batteries ont de quoi, en
 * accélérant, sa pointe cherchant le premier contact le long de sa course ; touchée ou au bout,
 * elle rentre (`recover`). L'énergie du coup est celle de la décharge, où qu'elle touche.
 */
function stepThrust(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, plans: PlannedHit[]): void {
  const thrust = spec.thrust!;
  arm.phaseT += STEP;
  const course = thrust.reach - thrust.retracted;
  switch (arm.phase) {
    case "ready":
      arm.swing = thrust.retracted;
      arm.spin = 0;
      if (arm.trigger && bot.energy >= thrust.cost && powerOk(sim, bot, arm, spec)) {
        bot.energy -= thrust.cost;
        arm.phase = "strike";
        arm.phaseT = 0;
      }
      break;
    case "strike": {
      const t = Math.min(1, arm.phaseT / thrust.strike);
      const prev = arm.swing;
      const next = thrust.retracted + course * t * t;
      arm.spin = (2 * course * t) / thrust.strike;
      const frame = meleeFrame(arm);
      const found = tipContact(sim, bot, frame, thrust, prev, next);
      if (found) {
        arm.swing = found.extension;
        const p = spec.hit.push;
        const dir = norm(add(scale(frame.e1, p.tangent + p.radial), add(scale(frame.axis, p.axial), vec3(0, p.lift, 0))));
        arm.hitAt = sim.time;
        plans.push({ arm, bot, spec, contact: found.contact, energy: thrust.energy, grip: 1, dir, motion: dir, hub: frame.hub, part: arm.block.part });
        recover(arm);
      } else {
        arm.swing = next;
        if (t >= 1) recover(arm);
      }
      break;
    }
    case "recover": {
      const t = Math.min(1, arm.phaseT / thrust.recover);
      arm.spin = 0;
      arm.swing = arm.from + (thrust.retracted - arm.from) * t * t * (3 - 2 * t);
      if (t >= 1) {
        arm.phase = "ready";
        arm.phaseT = 0;
        arm.swing = thrust.retracted;
      }
      break;
    }
  }
}

/**
 * Premier contact de la pointe d'une lance le long de sa course, de la sortie `from` à `to` (m) : le
 * contact et la sortie où il a lieu, ou null. `robotsOnly` : ne compte que les robots (l'IA).
 */
export function tipContact(
  sim: Simulation, bot: Bot, f: MeleeFrame, thrust: ThrustSpec, from: number, to: number, robotsOnly = false,
): { contact: Contact; extension: number } | null {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / THRUST_STEP));
  const found = pathContact(sim, bot, f.hub, thrust.reach + thrust.radius + 1, thrust.radius, steps, (s) => tipAt(f, from + (to - from) * s), robotsOnly);
  return found && { contact: found.contact, extension: from + (to - from) * found.s };
}

/**
 * Premier contact de la tête d'un bras sur son arc, de l'angle `from` à `to` (elle descend) : un
 * bloc ou une roue d'un robot ennemi, un accessoire, le décor ou le sol. Le contact et l'angle où il
 * a lieu, ou null. `robotsOnly` : ne compte que les robots (l'IA se demande si une frappe toucherait).
 */
export function headContact(
  sim: Simulation, bot: Bot, f: MeleeFrame, swing: SwingSpec, from: number, to: number, robotsOnly = false,
): { contact: Contact; angle: number } | null {
  const steps = Math.max(1, Math.ceil(Math.abs(from - to) / ARC_STEP));
  const found = pathContact(sim, bot, f.hub, swing.reach + swing.radius + 1, swing.radius, steps, (s) => headAt(f, swing, from + (to - from) * s), robotsOnly);
  return found && { contact: found.contact, angle: from + (to - from) * found.s };
}

/**
 * Premier contact d'une tête de rayon `r` le long d'un chemin (`at(s)`, de s = 0 à 1, en `steps`
 * pas), qui ne s'éloigne pas de `reach` m de `center` : un bloc ou une roue d'un robot ennemi, un
 * accessoire, le décor (entre deux positions de la tête) ou le sol. Le contact et la part `s` du
 * chemin où il a lieu, ou null.
 */
function pathContact(
  sim: Simulation, bot: Bot, center: Vec3, reach: number, r: number, steps: number, at: (s: number) => Vec3, robotsOnly: boolean,
): { contact: Contact; s: number } | null {
  // Les morceaux ennemis à portée du chemin, et leurs roues
  const near: { part: Part; t: Vec3; q: Quat }[] = [];
  for (const other of sim.bots) {
    if (other === bot || other.team === bot.team || !other.blocks.size) continue;
    for (const part of other.parts) {
      const t = part.rb.translation();
      if (distance(t, center) < reach + other.radius + other.top) near.push({ part, t, q: part.rb.rotation() });
    }
  }
  let prevHead = at(0);
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    const head = at(s);
    let found: Contact | null = null;
    let nearest = Infinity;
    for (const { part, t, q } of near) {
      const hL = qrotInv(q, sub(head, t));
      const cx = Math.round(hL.x / BLOCK_SIZE);
      const cy = Math.round(hL.y / BLOCK_SIZE);
      const cz = Math.round(hL.z / BLOCK_SIZE);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const b = part.bot.blocks.get(cellKey(cx + dx, cy + dy, cz + dz));
            if (!b || b.part !== part) continue;
            const d = len(vec3(
              Math.max(0, Math.abs(hL.x - b.local.x) - BLOCK_SIZE / 2),
              Math.max(0, Math.abs(hL.y - b.local.y) - BLOCK_SIZE / 2),
              Math.max(0, Math.abs(hL.z - b.local.z) - BLOCK_SIZE / 2),
            ));
            if (d < r && d < nearest) {
              nearest = d;
              found = { surface: "robot", target: { kind: "block", block: b }, body: part.rb, point: head, radial: 0, normal: null };
            }
          }
        }
      }
      for (const w of part.bot.wheels) {
        if (w.part !== part) continue;
        const d = distance(w.rb.translation(), head) - wheelDef(w.type).radius * WHEEL_REACH;
        if (d < r && d < nearest) {
          nearest = d;
          found = { surface: "robot", target: { kind: "wheel", wheel: w }, body: part.rb, point: head, radial: 0, normal: null };
        }
      }
    }
    if (!found && !robotsOnly) {
      for (const prop of sim.props) {
        if (prop.hp <= 0 || distance(prop.rb.translation(), head) > Math.max(prop.half.x, prop.half.y, prop.half.z) * 1.8 + r) continue;
        const p = propNearest(prop, head);
        if (distance(p, head) < r) {
          found = {
            surface: "prop", target: { kind: "prop", prop }, body: prop.fixed ? null : prop.rb, point: p, radial: 0, normal: null,
            face: prop.fixed ? towards(p, head) : undefined,
          };
          break;
        }
      }
      // Le sol sous la tête, ou le décor entre deux positions de la tête
      const ground = groundLevel(sim.arena, head.x, head.z);
      const seg = sub(head, prevHead);
      const length = len(seg);
      const wall = length > 1e-4 ? rayArena(sim.arena, prevHead, scale(seg, 1 / length), length + r) : null;
      if (!found && (head.y - r <= ground || wall !== null)) {
        const point = wall !== null ? add(prevHead, scale(seg, Math.min(1, wall / Math.max(length, 1e-4)))) : vec3(head.x, ground, head.z);
        found = { surface: "scenery", target: null, body: null, point, radial: 0, normal: null, face: wall !== null ? scale(seg, -1 / Math.max(length, 1e-4)) : UP };
      }
    }
    if (found) return { contact: found, s };
    prevHead = head;
  }
  return null;
}

/** Un contact du champ : ce qu'il frappe (au point de sa coque le plus proche), le sens où il repousse, à quelle profondeur, et le rotor ennemi qu'il freine. */
interface FieldContact {
  contact: Contact;
  dir: Vec3;
  /** Plus il est grand, plus le contact passe tôt (une arme ennemie passe avant tout). */
  depth: number;
  rotor: MeleeArm | null;
  /** Une arme de contact ennemie (sa lame, sa tête, sa pointe) : le coup pèse davantage. */
  weapon: boolean;
}

/**
 * Un champ : sa charge (le régime d'un rotor : `stepRegime`), puis, tous les `gap` s, un coup sur
 * ce qui entre dans sa marge (`fieldContacts`), au plus `field.contacts` à la fois : chacun prend
 * `bite` de sa charge (une arme ennemie davantage) ; un rotor ennemi perd `drain` de son énergie.
 */
function stepField(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec, gyros: Map<Part, Vec3>, plans: PlannedHit[]): void {
  const regime = stepRegime(sim, bot, arm, spec, gyros);
  if (!regime) return;
  const spin = spec.spin!;
  const field = spec.field!;
  if (arm.spin < spec.hit.minSpeed * spin.speed || sim.time - arm.hitAt < spec.hit.gap) return;
  const contacts = fieldContacts(sim, bot, arm, spec);
  if (!contacts.length) return;
  arm.hitAt = sim.time;
  let energy = regime.energy;
  const charge = regime.energy;
  contacts.sort((a, b) => b.depth - a.depth);
  contacts.slice(0, field.contacts).forEach((c, i) => {
    const hitEnergy = Math.min(energy, charge * spec.hit.bite * (c.weapon ? FIELD_WEAPON_WEIGHT : 1));
    if (hitEnergy <= 0) return;
    energy -= hitEnergy;
    // Un rotor ennemi qui s'y frotte : son régime chute
    if (c.rotor) c.rotor.spin *= Math.sqrt(1 - field.drain);
    plans.push({
      arm, bot, spec, contact: c.contact, energy: hitEnergy, grip: 1, dir: c.dir, motion: c.dir, hub: c.contact.point, part: arm.block.part, quiet: i > 0,
      // Une arme ennemie est repoussée franchement (`repel`) ; ce qui touche la coque, d'après `fling`
      impulse: c.weapon ? field.repel : undefined,
    });
  });
  arm.spin = Math.sqrt((2 * Math.max(0, energy)) / spin.inertia);
}

/**
 * Ce qui entre dans la marge d'un champ, autour des blocs de son morceau à moins de `field.radius`
 * m du projecteur (case par case dans sa grille, sans physique) : les blocs et les roues montées des
 * robots ennemis proches, la lame d'un de leurs rotors qui y passe, la tête d'un bras ou la pointe
 * d'une lance qui y entre. Lit les poses des morceaux : avant d'infliger quoi que ce soit.
 */
function fieldContacts(sim: Simulation, bot: Bot, arm: MeleeArm, spec: MeleeSpec): FieldContact[] {
  const field = spec.field!;
  const part = arm.block.part;
  const t = part.rb.translation();
  const q = part.rb.rotation();
  // Les blocs couverts, et leur encombrement dans le repère du robot
  const covered = new Set<Block>();
  const lo = vec3(Infinity, Infinity, Infinity);
  const hi = vec3(-Infinity, -Infinity, -Infinity);
  for (const b of part.blocks) {
    if (distance(b.local, arm.block.local) > field.radius) continue;
    covered.add(b);
    lo.x = Math.min(lo.x, b.local.x); lo.y = Math.min(lo.y, b.local.y); lo.z = Math.min(lo.z, b.local.z);
    hi.x = Math.max(hi.x, b.local.x); hi.y = Math.max(hi.y, b.local.y); hi.z = Math.max(hi.z, b.local.z);
  }
  if (!covered.size) return [];
  const toLocal = (w: Vec3): Vec3 => qrotInv(q, sub(w, t));
  const toWorld = (l: Vec3): Vec3 => add(t, qrot(q, l));
  /**
   * Le bloc couvert le plus proche d'un point (repère du robot) à moins de `reach` m de sa surface,
   * le point de sa surface le plus proche, et sa distance ; null s'il n'y en a pas.
   */
  const hull = (l: Vec3, reach: number): { surface: Vec3; d: number } | null => {
    const pad = reach + BLOCK_SIZE / 2;
    if (l.x < lo.x - pad || l.y < lo.y - pad || l.z < lo.z - pad || l.x > hi.x + pad || l.y > hi.y + pad || l.z > hi.z + pad) return null;
    const n = Math.ceil(pad / BLOCK_SIZE);
    const cx = Math.round(l.x / BLOCK_SIZE);
    const cy = Math.round(l.y / BLOCK_SIZE);
    const cz = Math.round(l.z / BLOCK_SIZE);
    let best: { surface: Vec3; d: number } | null = null;
    for (let dx = -n; dx <= n; dx++) {
      for (let dy = -n; dy <= n; dy++) {
        for (let dz = -n; dz <= n; dz++) {
          const b = bot.blocks.get(cellKey(cx + dx, cy + dy, cz + dz));
          if (!b || !covered.has(b)) continue;
          const h = BLOCK_SIZE / 2;
          const surface = vec3(clamp(l.x, b.local.x - h, b.local.x + h), clamp(l.y, b.local.y - h, b.local.y + h), clamp(l.z, b.local.z - h, b.local.z + h));
          const d = distance(surface, l);
          if (d < reach && (!best || d < best.d)) best = { surface, d };
        }
      }
    }
    return best;
  };
  const p = spec.hit.push;
  const up = vec3(0, 1, 0);
  /** Le sens où le champ repousse ce qui est en `at` (monde), depuis le point `from` de sa coque. */
  const repel = (from: Vec3, at: Vec3): Vec3 => {
    let out = sub(at, from);
    if (len(out) < 1e-4) out = sub(at, toWorld(arm.block.local));
    return norm(add(scale(norm(out), p.radial), scale(up, p.lift)));
  };
  const out: FieldContact[] = [];
  const blockReach = BLOCK_REACH + field.margin;
  for (const other of sim.bots) {
    if (other === bot || other.team === bot.team || !other.blocks.size) continue;
    for (const op of other.parts) {
      const ot = op.rb.translation();
      if (distance(ot, t) > bot.radius + other.radius + bot.top + other.top + field.margin + 1) continue;
      const oq = op.rb.rotation();
      for (const b of op.blocks) {
        const w = add(ot, qrot(oq, b.local));
        const h = hull(toLocal(w), blockReach);
        if (!h) continue;
        const surface = toWorld(h.surface);
        out.push({
          contact: { surface: "robot", target: { kind: "block", block: b }, body: op.rb, point: surface, radial: 0, normal: null },
          dir: repel(surface, w), depth: blockReach - h.d, rotor: null, weapon: false,
        });
      }
    }
    for (const w of other.wheels) {
      if (!w.part) continue;
      const c = w.rb.translation();
      const reach = wheelDef(w.type).radius * WHEEL_REACH + field.margin;
      const h = hull(toLocal(c), reach);
      if (!h) continue;
      const surface = toWorld(h.surface);
      out.push({
        contact: { surface: "robot", target: { kind: "wheel", wheel: w }, body: w.part.rb, point: surface, radial: 0, normal: null },
        dir: repel(surface, c), depth: reach - h.d, rotor: null, weapon: false,
      });
    }
    // Leurs armes de contact qui s'y frottent : la lame d'un rotor, la tête d'un bras, une pointe
    for (const enemy of other.melee) {
      if (!enemy.block.alive) continue;
      const es = meleeDef(enemy.weapon);
      const ef = meleeFrame(enemy);
      if (distance(ef.hub, t) > bot.radius + bot.top + meleeReach(es) + field.margin + 1) continue;
      let at: Vec3 | null = null;
      let rotor: MeleeArm | null = null;
      if (es.blade && es.spin && enemy.spin >= es.hit.minSpeed * es.spin.speed) {
        // Un bloc couvert dans l'anneau que balaie la lame (élargi de la marge) : la lame passe dans le champ
        for (const b of covered) {
          const rel = sub(toWorld(b.local), ef.hub);
          const along = dot(rel, ef.axis);
          if (Math.abs(along) > es.blade.half + blockReach) continue;
          const radial = len(sub(rel, scale(ef.axis, along)));
          if (radial > es.blade.outer + blockReach || radial < es.blade.inner - blockReach) continue;
          at = toWorld(b.local);
          rotor = enemy;
          break;
        }
      } else if (es.swing && enemy.phase === "strike") {
        const head = headAt(ef, es.swing, enemy.swing);
        if (hull(toLocal(head), es.swing.radius + field.margin)) at = head;
      } else if (es.thrust && enemy.phase === "strike") {
        const tip = tipAt(ef, enemy.swing);
        if (hull(toLocal(tip), es.thrust.radius + field.margin)) at = tip;
      }
      if (!at) continue;
      // Le point de la coque face à l'arme, et le sens qui l'en écarte (vers son moyeu)
      const toward = norm(sub(ef.hub, at));
      const surface = rotor ? add(at, scale(toward, BLOCK_SIZE / 2)) : at;
      out.push({
        contact: { surface: "robot", target: { kind: "block", block: enemy.block }, body: enemy.block.part.rb, point: surface, radial: 0, normal: null },
        dir: norm(add(scale(toward, p.radial), scale(up, p.lift))), depth: 10, rotor, weapon: true,
      });
    }
  }
  // Un même bloc n'est frappé qu'une fois par coup (le contact le plus fort)
  const seen = new Set<unknown>();
  return out.sort((a, b) => b.depth - a.depth).filter((c) => {
    const target = c.contact.target;
    const key = target?.kind === "block" ? target.block : target?.kind === "wheel" ? target.wheel : c;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Gyroscope d'un morceau : son moment cinétique propre `momentum` (la somme de ceux de ses rotors)
 * le fait précesser. Couple L × Ω, intégré implicitement : Ω' = (1 − dt·I⁻¹·[L]×)⁻¹·Ω (stable,
 * même quand le rotor l'emporte sur l'inertie du morceau).
 */
function precess(part: Part, momentum: Vec3): void {
  const rb = part.rb;
  if (rb.invMass() <= 0) return;
  const w = rb.angvel();
  // (une vue sur la mémoire du WebAssembly, que l'appel suivant écraserait : recopiée aussitôt)
  const m = rb.effectiveWorldInvInertia();
  const inv = [[m.m11, m.m12, m.m13], [m.m12, m.m22, m.m23], [m.m13, m.m23, m.m33]];
  const { x: lx, y: ly, z: lz } = momentum;
  // [L]× : la matrice de v ↦ L × v
  const k = [[0, -lz, ly], [lz, 0, -lx], [-ly, lx, 0]];
  const a = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) - STEP * (inv[i][0] * k[0][j] + inv[i][1] * k[1][j] + inv[i][2] * k[2][j])));
  const solved = solveLinear(a, [w.x, w.y, w.z]);
  if (solved) rb.setAngvel(vec3(solved[0], solved[1], solved[2]), true);
}

/** Masse effective d'un corps au point `at`, dans la direction `dir` (kg) ; Infinity pour un corps fixe. */
export function effectiveMass(rb: RigidBody, at: Vec3, dir: Vec3): number {
  const inv = rb.invMass();
  if (inv <= 0) return Infinity;
  const u = cross(sub(at, rb.worldCom()), dir);
  // Le tableau de Rapier est une vue sur la mémoire du WebAssembly, que l'appel suivant écrase : on le lit aussitôt
  const m = rb.effectiveWorldInvInertia();
  const iu = vec3(m.m11 * u.x + m.m12 * u.y + m.m13 * u.z, m.m12 * u.x + m.m22 * u.y + m.m23 * u.z, m.m13 * u.x + m.m23 * u.y + m.m33 * u.z);
  return 1 / (inv + dot(u, iu));
}

/**
 * Les coups et les morsures du pas, mesurés : impulsions des coups (cible et réaction au moyeu) et
 * poussées des morsures (force de coupe, couple de l'outil, réaction du réducteur), puis dégâts et
 * liaisons éprouvées, infligés coup par coup, puis les tranches de morsure. Toutes les impulsions
 * partent avant qu'aucun dégât ne soit infligé (infliger peut libérer des corps) ; un coup dont le
 * morceau a disparu entre-temps garde ses dégâts sur les blocs encore là, sans éprouver de liaison
 * d'un morceau qui n'existe plus ; une tranche de morsure ne relit que la grille du robot mordu.
 */
function landHits(sim: Simulation, { hits: plans, bites, due }: MeleePlans): void {
  for (const b of bites) {
    if (b.body && (b.force.x || b.force.y || b.force.z)) b.body.applyImpulseAtPoint(scale(b.force, STEP), b.point, true);
    if (b.force.x || b.force.y || b.force.z) b.part.rb.applyImpulseAtPoint(scale(b.force, -STEP), b.hub, true);
    if (b.body && b.torque) b.body.applyTorqueImpulse(scale(b.axis, b.torque * STEP), true);
    if (b.twist) b.part.rb.applyTorqueImpulse(scale(b.axis, -b.twist * STEP), true);
  }
  const lots: { batch: DamageBatch; own: DamageBatch; dir: Vec3; hub: Vec3 }[] = [];
  for (const h of plans) {
    const { contact, spec, dir } = h;
    const hit = spec.hit;
    // Ce qui ne bouge pas renvoie l'arme le long de sa surface (et du frottement contre son sens de passage)
    const away = contact.face ? norm(sub(contact.face, scale(h.motion ?? dir, SCRAPE))) : scale(dir, -1);
    const theirs = contact.body ? effectiveMass(contact.body, contact.point, dir) : Infinity;
    // (une arme d'énergie ne pousse ni ne recule : `fling` et `recoil` à 0)
    let impulse = h.impulse;
    if (impulse === undefined) {
      const mine = effectiveMass(h.part.rb, h.hub, away);
      const reduced = Number.isFinite(theirs) ? 1 / (1 / mine + 1 / theirs) : mine;
      impulse = hit.fling > 0 ? Math.sqrt(2 * reduced * h.energy * hit.fling) : 0;
    }
    if (impulse > 0 && contact.body && Number.isFinite(theirs)) contact.body.applyImpulseAtPoint(scale(dir, impulse), contact.point, true);
    const back = h.reaction ?? impulse * hit.recoil;
    const kick = scale(away, back);
    if (back > 0) h.part.rb.applyImpulseAtPoint(kick, h.hub, true);

    const batch = new DamageBatch();
    batch.attacker = h.bot;
    batch.cause = h.arm.weapon;
    const damage = h.damage ?? (h.energy / 1000) * hit.damage * (0.2 + 0.8 * h.grip);
    const target = contact.target;
    let toughness = 1;
    if (target?.kind === "block") {
      const b = target.block;
      batch.add(target, damage, hit.damageType);
      // Les voisins encaissent une part du coup
      const around = neighbors(b);
      if (hit.spread > 0) for (const n of around) batch.add({ kind: "block", block: n }, damage * hit.spread, hit.damageType);
      if (impulse > 0) batch.shock(b.part, contact.point, scale(dir, impulse), b);
      toughness = resistance(target, hit.damageType);
      // Le plasma allume ce qu'il touche (et parfois ses voisins)
      if (hit.ignite) {
        if (rand(0, 1) < hit.ignite * flammability(b)) ignite(sim, b);
        for (const n of around) if (rand(0, 1) < 0.5 * hit.ignite * flammability(n)) ignite(sim, n);
      }
    } else if (target?.kind === "wheel") {
      batch.add(target, damage * (hit.wheels ?? 1), hit.damageType);
    } else if (target) {
      batch.add(target, damage, hit.damageType);
      toughness = resistance(target, hit.damageType);
      if (hit.ignite && target.kind === "prop" && burnable(target.prop) && rand(0, 1) < hit.ignite) igniteProp(sim, target.prop);
    } else {
      toughness = 0.5; // le décor
    }
    // Une décharge : les organes autour du point touché sont paralysés (lit les poses : avant d'infliger)
    const victim = target?.kind === "block" ? target.block.bot : target?.kind === "wheel" ? target.wheel.bot : null;
    if (hit.stun && victim) stunOrgans(sim, victim, contact.point, hit.stun.radius, hit.stun.duration);
    // Sa propre arme : le choc au moyeu éprouve ses liaisons, et elle s'use
    const own = new DamageBatch();
    if (back > 0) own.shock(h.part, h.hub, kick, h.arm.block);
    if (hit.wear > 0) own.add({ kind: "block", block: h.arm.block }, (h.energy / 1000) * hit.wear / Math.max(0.25, toughness), "impact");
    if (!h.quiet) {
      sim.emit({
        type: "meleeHit", block: h.arm.block, point: contact.point, dir, energy: h.energy, surface: contact.surface, glance: h.grip < 0.6,
      });
    }
    lots.push({ batch, own, dir, hub: h.hub });
  }
  for (const { batch, own, dir, hub } of lots) {
    for (const b of [batch, own]) {
      // Un morceau libéré par un coup précédent de ce pas ne se relit pas
      for (const part of [...b.cuts.keys()]) if (!sim.parts.has(part)) b.cuts.delete(part);
    }
    inflict(sim, batch, dir, hub);
    // (sans réaction de l'IA : c'est son propre coup)
    inflict(sim, own, scale(dir, -1), null);
  }
  for (const d of due) landGnaw(sim, d);
}

/**
 * Une tranche de morsure : ses dégâts sur ce qu'elle mordait ; sur un bloc, ce qui reste quand il
 * cède passe au suivant dans le sens où la lame avance, case par case dans la grille de son robot
 * (sur le même morceau), jusqu'à `depth` m ; ses voisins en reçoivent une part (`spread`, la largeur
 * du trait). La lame s'use d'autant, plus sur ce qui résiste.
 */
function landGnaw(sim: Simulation, { arm, bot, gnaw }: GnawDue): void {
  const spec = meleeDef(arm.weapon);
  const hit = spec.hit;
  const type = hit.damageType;
  const batch = new DamageBatch();
  batch.attacker = bot;
  batch.cause = arm.weapon;
  const target = gnaw.target;
  let toughness = 0.5; // le décor
  if (gnaw.cell && gnaw.damage > 0) {
    const chain = gnawChain(gnaw.cell, target?.kind === "block" ? target.block : null, spec.bite?.depth ?? 0);
    let left = gnaw.damage;
    for (const [i, b] of chain.entries()) {
      const r = resistance({ kind: "block", block: b }, type);
      if (i === 0) {
        toughness = r;
        // Les voisins du premier bloc encaissent une part de la tranche
        if (hit.spread > 0) for (const n of neighbors(b)) batch.add({ kind: "block", block: n }, gnaw.damage * hit.spread, type);
      }
      batch.add({ kind: "block", block: b }, left, type);
      if (left * r < b.hp) break;
      // Percé : le reste passe au suivant
      left -= b.hp / Math.max(r, 1e-3);
      if (left <= 1e-6) break;
    }
  } else if (target?.kind === "wheel") {
    if (target.wheel.part || target.wheel.body) batch.add(target, gnaw.damage * (hit.wheels ?? 1), type);
    toughness = 1;
  } else if (target?.kind === "prop") {
    if (target.prop.hp > 0) batch.add(target, gnaw.damage, type);
    toughness = resistance(target, type);
  }
  if (batch.blocks.size || batch.wheels.size || batch.props.size) inflict(sim, batch, gnaw.dir, gnaw.hub);
  // La lame s'use (son bloc a pu céder entre-temps)
  if (arm.block.alive && hit.wear > 0 && gnaw.cut > 0) {
    const own = new DamageBatch();
    own.add({ kind: "block", block: arm.block }, (gnaw.cut / 1000) * hit.wear / Math.max(0.25, toughness), "impact");
    inflict(sim, own, scale(gnaw.dir, -1), null);
  }
}

/**
 * Blocs que traverse une morsure, dans l'ordre : le bloc mordu (s'il est encore là), puis ceux qui
 * suivent dans le sens d'avance, sur le même morceau, jusqu'à `depth` m de la case mordue. Ne lit
 * que la grille du robot : rien d'un corps qu'un coup de ce pas aurait libéré.
 */
function gnawChain(cell: NonNullable<Gnaw["cell"]>, first: Block | null, depth: number): Block[] {
  const part = first?.alive ? first.part : cell.part;
  const out: Block[] = [];
  const { feed } = cell;
  const x0 = cell.x * BLOCK_SIZE;
  const y0 = cell.y * BLOCK_SIZE;
  const z0 = cell.z * BLOCK_SIZE;
  let last: Block | null = null;
  for (let s = 0; s <= depth + 1e-6; s += GNAW_STEP) {
    const b = cell.bot.blocks.get(cellKey(
      Math.round((x0 + feed.x * s) / BLOCK_SIZE), Math.round((y0 + feed.y * s) / BLOCK_SIZE), Math.round((z0 + feed.z * s) / BLOCK_SIZE),
    ));
    if (!b || b === last || b.part !== part) continue;
    last = b;
    out.push(b);
  }
  return out;
}

/** Voisins d'un bloc sur son morceau (liaisons intactes) : ils encaissent une part du coup. */
function neighbors(block: Block): Block[] {
  const out: Block[] = [];
  const { bot } = block;
  for (const [dx, dy, dz] of NEIGHBORS) {
    const n = bot.blocks.get(cellKey(block.x + dx, block.y + dy, block.z + dz));
    if (n && n.part === block.part && !bot.cuts.has(linkKey(block, n))) out.push(n);
  }
  return out;
}

/**
 * Une frappe de ce bras toucherait-elle un robot ennemi, depuis là où il est jusqu'au bout de son
 * arc ? (L'IA frappe alors.)
 */
export function strikeWouldHit(sim: Simulation, bot: Bot, arm: MeleeArm): boolean {
  const swing = meleeDef(arm.weapon).swing;
  if (!swing || !arm.block.alive) return false;
  return headContact(sim, bot, meleeFrame(arm), swing, arm.swing, swing.end, true) !== null;
}

/** Une pointe sortie de là où elle est jusqu'au bout de sa course toucherait-elle un robot ennemi ? (L'IA frappe alors.) */
export function thrustWouldHit(sim: Simulation, bot: Bot, arm: MeleeArm): boolean {
  const thrust = meleeDef(arm.weapon).thrust;
  if (!thrust || !arm.block.alive) return false;
  return tipContact(sim, bot, meleeFrame(arm), thrust, arm.swing, thrust.reach, true) !== null;
}

/** Régime à partir duquel un rotor compte comme lancé, pour la jauge du réticule (part du plein régime). */
const SPUN = 0.97;
/** Batteries sous lesquelles (kJ) un rotor ou un champ qui n'est pas lancé attend leur énergie (la jauge le dit, en bleu). */
const SPIN_STARVED = 1;

/**
 * Où en est une arme de contact (toutes ses armes identiques ensemble), pour la jauge du réticule,
 * comme `readiness` pour une tourelle : un rotor (ou la charge d'un champ), son régime (l'arc se
 * remplit en montant en régime, il chute à chaque coup ; batteries vides, il attend leur énergie) ;
 * un bras, une pointe, son réarmement, ou les batteries qui manquent pour frapper. Ne lit que l'état
 * des armes : marche aussi sur la réplique réseau.
 */
export function meleeReadiness(arms: readonly MeleeArm[], energy = Infinity): Readiness | null {
  if (!arms.length) return null;
  const spec = meleeDef(arms[0].weapon);
  const best = Math.max(...arms.map(meleeCharge));
  const rotor = spec.spin ?? spec.flail;
  if (rotor) {
    const cause = best >= SPUN ? null : energy < SPIN_STARVED ? "energy" : "spin";
    return { progress: best, cause, span: rotor.spinUp, magazine: null, heat: null };
  }
  // Une mâchoire qui tient sa proie : rien à attendre ; qui se rouvre : son répit
  if (spec.jaw) {
    const holding = arms.some((a) => a.phase === "hold");
    return { progress: best, cause: holding || best >= 1 ? null : "cycle", span: spec.jaw.reopen + spec.jaw.cooldown, magazine: null, heat: null };
  }
  // Un bras, une pointe, un plateau : son retour (la recharge du vérin), ou les batteries qui manquent
  const cycle = spec.swing ? { cost: spec.swing.cost, span: spec.swing.recover }
    : spec.thrust ? { cost: spec.thrust.cost, span: spec.thrust.recover }
      : spec.plate ? { cost: spec.plate.cost, span: spec.plate.reload } : null;
  if (!cycle) return null;
  let progress = best;
  let cause: Readiness["cause"] = best < 1 ? "cycle" : null;
  if (energy < cycle.cost && energy / cycle.cost < progress) {
    progress = Math.max(0, energy / cycle.cost);
    cause = "energy";
  }
  return { progress, cause, span: cycle.span, magazine: null, heat: null };
}

/** Ce que l'arme a de moment cinétique (N·m·s), le long de son axe (monde) : pour les essais. */
export function angularMomentum(arm: MeleeArm): Vec3 {
  const spin = meleeDef(arm.weapon).spin;
  if (!spin || !arm.block.alive) return vec3(0, 0, 0);
  return scale(meleeFrame(arm).axis, spin.inertia * arm.spin * (spin.direction ?? 1) * spin.gyro);
}

/** Énergie stockée par une arme de contact en ce moment (J) : un rotor, une lame d'énergie, la charge d'un champ ; un fléau (sa boule et sa manivelle). */
export function storedEnergy(arm: MeleeArm): number {
  const spec = meleeDef(arm.weapon);
  if (spec.spin) return spinEnergy(spec.spin, arm.spin);
  if (spec.flail && arm.ball) {
    const v = arm.ball.vel;
    return 0.5 * spec.flail.mass * (v.x * v.x + v.y * v.y + v.z * v.z) + 0.5 * spec.flail.inertia * arm.spin * arm.spin;
  }
  return 0;
}

