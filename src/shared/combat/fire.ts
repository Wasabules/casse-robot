import { propDef } from "../catalog/props";
import { propDistance, propNearest } from "../arena/structures";
import { STEP } from "../config";
import { rand } from "../math/scalar";
import { distance, len, vec3, type Vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import { linkedNeighbors } from "../robot/structure";
import type { GroundFire, Prop } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { burnable, extinguish, extinguishProp, flammability, ignite, igniteProp, removeGroundFire } from "./burning";
import { DamageBatch, inflict } from "./damage";
import { dcos, dsin } from "../math/det";

/*
 * Feu. Un bloc en feu perd des points de structure (dégâts `fire`, que les blindages lourds
 * encaissent mieux et que les ailes craignent) et peut gagner ses voisins. Il s'éteint au bout
 * de quelques secondes s'il n'est pas ravivé. On l'allume au lance-flammes, par une explosion
 * (voir `Explosion.ignite`), ou quand une batterie est détruite.
 *
 * Le bois du décor brûle aussi (`PropTypeDef.burns` : caisses, planches, toits, arbres) : il perd
 * des points, noircit, gagne les accessoires en bois voisins et les robots qui le frôlent. Et le
 * lance-flammes et le napalm laissent au sol des flaques de feu (`GroundFire`), qui brûlent ce qui
 * s'y tient.
 */

/** Dégâts d'un feu (points par seconde, avant résistance). */
const FIRE_DPS = 12;
/**
 * Probabilité, par seconde, qu'un feu gagne chaque voisin (multipliée par la sensibilité du voisin).
 * Un feu sur du châssis allume en moyenne moins d'un autre feu avant de s'éteindre : il reste
 * local. Les blocs sensibles (blindage léger, ailes) brûlent plus longtemps et le propagent.
 */
const SPREAD_RATE = 0.03;
/** Le feu est traité par tranches de cette durée (s). */
const TICK = 0.25;
const UP = vec3(0, 1, 0);

/** Dégâts d'un accessoire en feu (points par seconde, avant sa résistance au feu). */
const PROP_FIRE_DPS = 10;
/** Temps de feu (s) pour qu'un accessoire soit tout noir ; il noircit par crans (`CHAR_STEPS`), chacun annoncé. */
export const CHAR_TIME = 8;
export const CHAR_STEPS = 4;
/**
 * Probabilité, par seconde, qu'un accessoire en feu gagne un voisin en bois à portée (ses flammes
 * et celles du voisin, `burns.reach`, plus `PROP_GAP`) : dans un bois, un arbre en allume parfois
 * un ou deux autres ; une cabane brûle de mur en mur. La forêt ne brûle pas d'un coup.
 */
const PROP_SPREAD = 0.035;
const PROP_GAP = 1.5;
/** Un bloc à moins de cette distance (m) d'un accessoire en feu peut s'enflammer (chance par seconde). */
const PROP_SCORCH = 0.5;
const PROP_SCORCH_CHANCE = 0.6;

/** Dégâts d'une flaque de feu (points par seconde, avant résistance) ; hauteur (m) au-dessus d'elle qu'elle atteint. */
const GROUND_FIRE_DPS = 9;
const GROUND_FIRE_HEIGHT = 1.1;
/** Chance, par seconde, qu'une flaque enflamme un bloc qui s'y tient, ou un accessoire en bois qu'elle touche. */
const GROUND_IGNITE = 0.5;
const GROUND_PROP_IGNITE = 1.2;

/** Un pas de vie des feux : dégâts, propagation, extinction, par tranches de TICK. */
export function updateFires(sim: Simulation): void {
  if (Math.floor(sim.time / TICK) === Math.floor((sim.time - STEP) / TICK)) return;
  if (!sim.fires.size && !sim.propFires.size && !sim.groundFires.length) return;
  const batch = new DamageBatch();
  batch.cause = "fire";
  for (const block of [...sim.fires]) {
    if (!block.alive) {
      sim.fires.delete(block);
      continue;
    }
    batch.add({ kind: "block", block }, FIRE_DPS * TICK, "fire");
    for (const n of linkedNeighbors(block)) {
      if (n.burn <= 0 && rand(0, 1) < SPREAD_RATE * TICK * flammability(n)) ignite(sim, n);
    }
    block.burn -= TICK;
    if (block.burn <= 0) extinguish(sim, block);
  }
  // Tout ce qui se lit sur les corps se lit avant d'infliger quoi que ce soit (des corps peuvent disparaître)
  const props = burnProps(sim);
  const puddles = burnGround(sim);
  if (batch.blocks.size) inflict(sim, batch, UP, null);
  for (const b of puddles) inflict(sim, b, UP, null);
  for (const { batch: b, dir } of props) inflict(sim, b, dir, null);
}

/**
 * Les accessoires en feu : dégâts (chacun son lot : un arbre qui cède bascule d'un côté au
 * hasard), noircissement, propagation au bois voisin et aux robots qui les frôlent, extinction.
 */
function burnProps(sim: Simulation): { batch: DamageBatch; dir: Vec3 }[] {
  const out: { batch: DamageBatch; dir: Vec3 }[] = [];
  for (const prop of [...sim.propFires]) {
    const batch = new DamageBatch();
    batch.cause = "fire";
    batch.add({ kind: "prop", prop }, PROP_FIRE_DPS * TICK, "fire");
    const angle = rand(0, Math.PI * 2);
    out.push({ batch, dir: vec3(dcos(angle), 0, dsin(angle)) });
    const step = Math.floor(prop.charred * CHAR_STEPS);
    prop.charred = Math.min(1, prop.charred + TICK / CHAR_TIME);
    if (Math.floor(prop.charred * CHAR_STEPS) !== step) sim.emit({ type: "propFire", prop });
    spreadToProps(sim, prop);
    scorchRobots(sim, prop);
    prop.burn -= TICK;
    if (prop.burn <= 0) extinguishProp(sim, prop);
  }
  return out;
}

/** Portée des flammes d'un accessoire en bois au-delà de sa surface (m) : un arbre brûle jusque dans son feuillage. */
const flameReach = (prop: Prop): number => (propDef(prop.type).burns?.reach ?? 0) * (propDef(prop.type).shape.kind === "cylinder" ? prop.half.y / cylinderHalf(prop) : 1);
const cylinderHalf = (prop: Prop): number => {
  const shape = propDef(prop.type).shape;
  return shape.kind === "cylinder" ? shape.halfHeight : 1;
};
/** Plus grand demi-côté d'un accessoire (m), pour écarter vite ceux qui sont loin. */
const extent = (prop: Prop): number => Math.max(prop.half.x, prop.half.y, prop.half.z);

function spreadToProps(sim: Simulation, prop: Prop): void {
  const center = prop.rb.translation();
  const reach = flameReach(prop);
  for (const other of sim.props) {
    if (other === prop || other.burn > 0 || !burnable(other)) continue;
    const at = other.rb.translation();
    const span = reach + flameReach(other) + PROP_GAP;
    if (distance(center, at) - extent(prop) - extent(other) > span) continue;
    const gap = propDistance(other, propNearest(prop, at));
    if (gap < span && rand(0, 1) < PROP_SPREAD * TICK) igniteProp(sim, other);
  }
}

function scorchRobots(sim: Simulation, prop: Prop): void {
  const center = prop.rb.translation();
  const size = extent(prop) + 4;
  for (const bot of sim.bots) {
    if (!bot.cockpit.alive || distance(bot.cockpit.part.rb.translation(), center) > size) continue;
    for (const block of bot.blocks.values()) {
      if (block.burn > 0) continue;
      if (propDistance(prop, blockWorldPos(block)) < PROP_SCORCH && rand(0, 1) < PROP_SCORCH_CHANCE * TICK * flammability(block)) ignite(sim, block);
    }
  }
}

/**
 * Les flaques de feu : celles qui ont fait leur temps s'éteignent ; les autres brûlent les blocs
 * et les roues qui s'y tiennent (sauf ceux du robot qui les a allumées), les enflamment parfois,
 * et allument le bois qu'elles touchent. Un lot par flaque (chacune a son auteur).
 */
function burnGround(sim: Simulation): DamageBatch[] {
  for (const fire of [...sim.groundFires]) if (sim.time >= fire.until) removeGroundFire(sim, fire);
  const out: DamageBatch[] = [];
  for (const fire of sim.groundFires) {
    const batch = new DamageBatch();
    batch.cause = "fire";
    batch.attacker = fire.owner;
    for (const bot of sim.bots) {
      if (bot === fire.owner || !bot.cockpit.alive) continue;
      if (distance(bot.cockpit.part.rb.translation(), fire.pos) > fire.radius + 6) continue;
      for (const block of bot.blocks.values()) {
        if (!inPuddle(fire, blockWorldPos(block), GROUND_FIRE_HEIGHT)) continue;
        batch.add({ kind: "block", block }, GROUND_FIRE_DPS * TICK, "fire");
        if (block.burn <= 0 && rand(0, 1) < GROUND_IGNITE * TICK * flammability(block)) ignite(sim, block);
      }
      for (const w of bot.wheels) {
        if (w.part && inPuddle(fire, w.rb.translation(), GROUND_FIRE_HEIGHT)) batch.add({ kind: "wheel", wheel: w }, GROUND_FIRE_DPS * TICK, "fire");
      }
    }
    for (const prop of sim.props) {
      if (prop.burn > 0 || !burnable(prop)) continue;
      if (propDistance(prop, fire.pos) < fire.radius && rand(0, 1) < GROUND_PROP_IGNITE * TICK) igniteProp(sim, prop);
    }
    if (batch.blocks.size || batch.wheels.size) out.push(batch);
  }
  return out;
}

/** Ce point est-il dans la flaque : à moins de son rayon (dans le plan), et au plus `height` m au-dessus d'elle ? */
function inPuddle(fire: GroundFire, p: Vec3, height: number): boolean {
  const dy = p.y - fire.pos.y;
  return dy > -0.3 && dy < height && len(vec3(p.x - fire.pos.x, 0, p.z - fire.pos.z)) < fire.radius;
}
