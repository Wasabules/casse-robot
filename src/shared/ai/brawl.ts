import { allAround, meleeDef, meleeOffensive, type SpinSpec } from "../catalog/melee";
import { liveMelee, meleeCharge, strikeWouldHit, thrustWouldHit, unbalanceShare } from "../combat/melee";
import { flipWouldHit, gripping, jawWouldBite } from "../combat/mechanics";
import { areEnemies } from "../combat/projectiles";
import { clamp } from "../math/scalar";
import { distance, qrotInv, type Vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import { isDetected } from "../sim/detection";
import type { Bot, MeleeArm } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/*
 * IA des armes de contact (combat/melee.ts). Elle lance ses rotors quand un ennemi repéré approche
 * (et les laisse retomber en patrouille : ils coûtent des batteries, et le gyroscope change la
 * conduite) ; un rotor très déséquilibré ne tourne plus qu'au contact. Elle frappe du marteau ou du
 * fouet quand sa tête toucherait un robot ennemi le long de son arc, de la lance quand sa pointe en
 * toucherait un. Un champ s'arme seul quand un ennemi approche (pour le joueur aussi). La tactique
 * (ai/tactics.ts) la fait charger son adversaire, mais seulement une fois ses rotors à plein régime
 * (`meleePrimed`) : avant, elle tourne autour de lui à distance ; en chargeant, elle oriente son arme
 * vers lui (`meleeBearing`), sauf un anneau-coque, qui frappe de tous côtés. Une hélice tranchante,
 * que mène son moteur, ne compte pas ici (`liveMelee` ne la donne pas). Une lame qui mord (scie,
 * foreuse) se lance comme un rotor ; en chargeant, une foreuse vise le cockpit de sa cible
 * (`chargePoint`) et pousse droit dedans, une scie qui mord longe sa cible (`meleeSkim`) ; tant
 * qu'une lame mord un robot, la conduite ne se croit pas coincée (`meleeBiting`). Les frappes à
 * mécanique (combat/mechanics.ts) : le flipper lève quand un ennemi est sur son plateau, le fléau se
 * lance comme un rotor, la mâchoire mord ce qui est dans sa gueule, puis recule en traînant sa proie
 * (`meleeDrive`).
 */

/** Un ennemi repéré à moins de cette distance (m) : les rotors montent en régime (au plus). */
const SPIN_RANGE = 35;
/**
 * Un rotor se lance quand l'ennemi est à moins de ce qu'il couvrira pendant sa montée en régime
 * (`CLOSING` m/s), plus `SPIN_MARGIN` m : ~35 m pour une toupie (2,4 s), ~12 m pour une lame laser
 * qui s'allume en une demi-seconde (allumée, elle vide les batteries pour rien).
 */
const CLOSING = 12.5;
const SPIN_MARGIN = 6;
/** Un rotor à ce balourd ou plus (voir `unbalanceShare`) ne tourne plus qu'avec un ennemi à moins de SPIN_CLOSE m. */
const SEVERE_UNBALANCE = 0.6;
const SPIN_CLOSE = 8;
/** Un ennemi à moins de cette distance (m, entre les centres) : on regarde si une frappe le toucherait. */
const STRIKE_LOOK = 7;
/** Un ennemi repéré à moins de cette distance (m) : un champ s'arme. */
const FIELD_RANGE = 15;
/** Régime à partir duquel un rotor est prêt à charger (part du plein régime). */
export const PRIMED = 0.85;
/** Une lame qui mord n'a pas besoin de tout son élan : elle repart à la charge plus tôt (part du plein régime). */
const BITE_PRIMED = 0.6;

/** Distance du plus proche ennemi repéré (m), ou Infinity. */
function nearestFoe(sim: Simulation, bot: Bot): number {
  let best = Infinity;
  for (const other of sim.bots) {
    if (!other.cockpit.alive || !areEnemies(bot, other) || !isDetected(sim, bot.team, other)) continue;
    best = Math.min(best, distance(other.lastPos, bot.lastPos));
  }
  return best;
}

/** Distance (m) d'un ennemi à laquelle un rotor se lance : ce qu'il faut pour être à plein régime au contact. */
const spinRange = (spin: Pick<SpinSpec, "spinUp">): number => clamp(CLOSING * spin.spinUp + SPIN_MARGIN, SPIN_CLOSE, SPIN_RANGE);

/** Un champ doit-il s'armer ? Un ennemi repéré approche (l'IA comme le joueur : il se passe de commande). */
export const fieldWanted = (sim: Simulation, bot: Bot): boolean => nearestFoe(sim, bot) < FIELD_RANGE;

/** Commandes de l'IA pour ses armes de contact, à ce pas. */
export function operateMelee(sim: Simulation, bot: Bot): void {
  const arms = liveMelee(bot);
  if (!arms.length) return;
  const near = nearestFoe(sim, bot);
  const charging = bot.ai.mode === "charge";
  for (const arm of arms) {
    const spec = meleeDef(arm.weapon);
    switch (spec.motion) {
      case "spin":
        arm.wanted = unbalanceShare(arm) >= SEVERE_UNBALANCE ? near < SPIN_CLOSE : charging || near < spinRange(spec.spin!);
        break;
      case "swing":
        arm.trigger = arm.phase === "ready" && near < STRIKE_LOOK && strikeWouldHit(sim, bot, arm);
        break;
      case "thrust":
        arm.trigger = arm.phase === "ready" && near < STRIKE_LOOK && thrustWouldHit(sim, bot, arm);
        break;
      case "field":
        arm.wanted = near < FIELD_RANGE;
        break;
      // Frappes à mécanique (combat/mechanics.ts) : le flipper lève quand un ennemi est sur son
      // plateau (ou juste devant, sous son bord) ; le fléau tourne comme un rotor ; la mâchoire mord
      // ce qui est dans sa gueule et tient sa proie jusqu'à ce qu'elle lâche d'elle-même
      case "flip":
        arm.trigger = arm.phase === "ready" && near < STRIKE_LOOK && flipWouldHit(sim, bot, arm);
        break;
      case "flail":
        arm.wanted = charging || near < spinRange(spec.flail!);
        break;
      case "grip":
        arm.trigger = arm.phase === "hold" || (arm.phase === "ready" && near < STRIKE_LOOK && jawWouldBite(sim, bot, arm));
        break;
      case "driven":
        // (une hélice : son moteur la mène ; `liveMelee` ne la donne pas, mais le switch reste exhaustif)
        break;
      default:
        spec.motion satisfies never;
    }
  }
}

/** Une arme de contact peut-elle frapper ce robot ? Un robot au sol (un robot volant passe au-dessus, un avion trop vite). */
export const meleeSuits = (other: Bot): boolean => other.profile.mobility === "ground";

/** Ses armes de contact offensives (celles qu'on mène au contact : pas un champ) reliées au cockpit. */
export const offensiveMelee = (bot: Bot): MeleeArm[] => liveMelee(bot).filter((arm) => meleeOffensive(meleeDef(arm.weapon)));

/**
 * Ses rotors (et ses fléaux) sont-ils assez lancés pour charger ? (Un bras, une pointe, un plateau,
 * une mâchoire sont toujours prêts ; un champ ne compte pas ; une lame qui mord déjà reste à
 * l'ouvrage : son régime baisse sous la charge, ce n'est pas une raison de reculer.)
 */
export function meleePrimed(bot: Bot): boolean {
  return offensiveMelee(bot).every((arm) => {
    const spec = meleeDef(arm.weapon);
    if (spec.motion === "flail") return meleeCharge(arm) >= PRIMED;
    return spec.motion !== "spin" || arm.bite !== null || meleeCharge(arm) >= (spec.bite ? BITE_PRIMED : PRIMED);
  });
}

/** Gaz quand il tient une proie dans sa mâchoire : il recule, et la traîne (null : il conduit comme d'habitude). */
const DRAG_THROTTLE = -0.8;

/** Conduite imposée par une arme de contact : à reculons, en traînant la proie que tient sa mâchoire ; null sinon. */
export function meleeDrive(bot: Bot): { throttle: number; steer: number } | null {
  return gripping(bot) ? { throttle: DRAG_THROTTLE, steer: 0 } : null;
}

/**
 * Côté où est son arme de contact, vu de dessus (rad, > 0 : à gauche de l'avant) : la moyenne des
 * moyeux de ses armes offensives, depuis le cockpit. En chargeant, il tourne d'autant pour la
 * présenter à sa cible ; null s'il n'en a pas, ou qu'elle n'est pas dans sa moitié avant (il ne peut
 * pas charger de côté).
 */
export function meleeBearing(bot: Bot): number | null {
  // (un anneau-coque frappe de tous côtés : il n'a rien à présenter)
  const arms = offensiveMelee(bot).filter((arm) => !allAround(meleeDef(arm.weapon)));
  if (!arms.length) return null;
  let x = 0;
  let z = 0;
  for (const arm of arms) {
    x += arm.block.local.x - bot.cockpit.local.x;
    z += arm.block.local.z - bot.cockpit.local.z;
  }
  if (z <= 0) return null;
  return Math.atan2(x, z);
}

/** Les armes de contact offensives d'un robot, pour ses choix de placement (un champ n'y compte pas). */
export const meleeArms = (bot: Bot): MeleeArm[] => offensiveMelee(bot);

/** En longeant sa cible, une scie la garde de ce côté de son avant (rad) : il avance le long d'elle en y appuyant sa lame. */
const SKIM = 0.55;

/**
 * Une de ses lames mord-elle un robot ? Il pousse alors dedans : ce n'est pas être coincé (il ne
 * recule pas pour se dégager, le gyroscope ne le fait pas bondir).
 */
export const meleeBiting = (bot: Bot): boolean => liveMelee(bot).some((arm) => arm.bite?.surface === "robot");

/**
 * En chargeant, une scie qui mord un robot le longe : sa prise tire son robot le long de la cible
 * (à l'opposé du sens de la lame) ; il suit ce mouvement, la cible gardée de côté devant lui (SKIM),
 * pour que la lame reste appuyée en avançant. Un angle (rad, > 0 : la cible à gauche de l'avant) à
 * ajouter à celui où il présente son arme (`meleeBearing`), ou 0 (une foreuse pousse droit).
 */
export function meleeSkim(bot: Bot): number {
  const q = bot.cockpit.part.rb.rotation();
  for (const arm of liveMelee(bot)) {
    const bite = meleeDef(arm.weapon).bite;
    if (!bite || bite.grab <= 0 || arm.bite?.surface !== "robot") continue;
    // La lame va vers sa gauche (x > 0) : la prise tire le robot vers sa droite, la cible reste à gauche
    const side = qrotInv(q, arm.bite.dir).x;
    if (Math.abs(side) > 0.2) return Math.sign(side) * SKIM;
  }
  return 0;
}

/**
 * Où charger une cible : une mèche (une lame qui mord le long de son axe) vise son cockpit, pour le
 * percer à travers ce qui le couvre ; sinon, la cible elle-même (null).
 */
export function chargePoint(bot: Bot, foe: Bot): Vec3 | null {
  if (!foe.cockpit.alive) return null;
  if (!liveMelee(bot).some((arm) => meleeDef(arm.weapon).bite?.feed === "axial")) return null;
  return blockWorldPos(foe.cockpit);
}
