import RAPIER, { type Collider } from "@dimforge/rapier3d-compat";
import { propDef } from "../catalog/props";
import { STEP } from "../config";
import { rand } from "../math/scalar";
import { add, cross, norm, scale, vec3, type Vec3 } from "../math/vec";
import { hitTargetOf } from "../robot/colliders";
import { jetHeat, jetOf, jetRadius, ownContact, type Jet } from "../robot/exhaust";
import { liveThrusters } from "../robot/queries";
import type { Block, ColliderOwner, HitTarget, Part, Prop } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { burnable, flammability, ignite, igniteProp } from "./burning";
import { DamageBatch, inflict } from "./damage";
import { isStunned } from "./emp";
import { dcos, dsin } from "../math/det";

/*
 * Ce que brûle le jet de flamme d'un moteur (voir robot/exhaust.ts) : derrière la tuyère d'un
 * réacteur, d'un propulseur ou d'un turboréacteur qui pousse, ce qui est dans le jet chauffe.
 * - Les blocs et les roues, de n'importe quel robot, le sien compris s'il est mal construit (un
 *   bloc posé derrière la tuyère) : dégâts `fire`, qui faiblissent jusqu'au bout du jet, et une
 *   chance d'allumer le bloc. Crédités au robot du moteur (cause `exhaust`) ; sur lui-même, sur un
 *   coéquipier, pas de crédit.
 * - Le bois du décor prend feu (`igniteProp`) ; les autres accessoires chauffent (un baril saute,
 *   une bouteille fuit ; la brique, le béton, la tôle n'en ont cure, d'après leur résistance au feu).
 * - Pas de flaque de feu au sol : un jet n'est pas du combustible qui se répand (le gel du
 *   lance-flammes, le napalm), et chaque robot volant qui se pose (le Drone, la Frégate, l'Ange se
 *   posent pour recharger leurs batteries, sur leurs réacteurs) sèmerait des flaques à chaque
 *   atterrissage, que les flaques ne brûlent pas leur auteur rendrait gratuites, et qui
 *   épuiseraient le plafond des flaques (40) au détriment des lance-flammes. Le sol roussi n'est
 *   qu'un effet (client/render/fx/exhaustFx.ts).
 *
 * Son propre robot se lit dans sa grille (`ownContact` : l'axe d'un moteur suit toujours un axe de
 * la grille) ; le reste, par quelques lancers de rayon dans le cône du jet, depuis la tuyère, qui
 * ignorent le morceau du moteur (ses colliders fusionnés engloberaient la tuyère). Chaque moteur
 * est traité toutes les TICK s, à son tour (décalé d'un pas à l'autre d'après son bloc), pour
 * étaler le coût.
 */

/** Chaque moteur est traité toutes les TICK s. */
const TICK = 0.25;
const TICK_STEPS = Math.round(TICK / STEP);
/** Rayons lancés à chaque tranche : l'axe du jet, et deux sur son bord (à 80 % du rayon), qui tournent d'une tranche à l'autre. */
const RIM = 0.8;
const GOLDEN_ANGLE = 2.39996;
/** Chance par seconde qu'un bloc touché s'enflamme, par point de dégâts par seconde (fois sa sensibilité au feu). */
const IGNITE_PER_DPS = 0.012;
/** Chance par seconde que le bois touché s'enflamme, par point de dégâts par seconde. */
const PROP_IGNITE_PER_DPS = 0.04;

/** Un pas des jets de flamme : les moteurs dont c'est le tour. */
export function updateScorch(sim: Simulation): void {
  const step = Math.round(sim.time / STEP);
  for (const bot of sim.bots) {
    if (!bot.thrusters.length || !bot.cockpit.alive || isStunned(sim, bot)) continue;
    for (const t of liveThrusters(bot)) {
      if ((step + t.block.id) % TICK_STEPS !== 0) continue;
      // Les dégâts d'un jet précédent ont pu détacher ou détruire ce moteur
      if (!t.block.alive || !bot.cockpit.alive || t.block.part !== bot.cockpit.part) continue;
      const jet = jetOf(t);
      if (jet) burnJet(sim, jet, Math.floor(step / TICK_STEPS));
    }
  }
}

/** Morceau qui porte ce collider (bloc, tête de tourelle, roue montée), s'il y en a un. */
function ownerPart(owner: ColliderOwner): Part | null {
  if (owner.kind === "part") return owner.part;
  if (owner.kind === "head") return owner.turret.block.part;
  if (owner.kind === "blade") return owner.arm.block.part;
  if (owner.kind === "wheel") return owner.wheel.part;
  return null;
}

/**
 * Directions des rayons : l'axe, et deux sur le bord du cône, opposés, qui tournent d'une tranche à
 * l'autre (au fil des tranches, ils balaient tout le cône).
 */
function rayDirections(jet: Jet, turn: number): Vec3[] {
  const { dir, length } = jet;
  const side = norm(Math.abs(dir.y) < 0.9 ? cross(dir, vec3(0, 1, 0)) : cross(dir, vec3(1, 0, 0)));
  const other = cross(dir, side);
  const angle = turn * GOLDEN_ANGLE + jet.thruster.block.id;
  const offset = (jetRadius(jet, length) * RIM) / length;
  const out = [dir];
  for (const a of [angle, angle + Math.PI]) {
    const radial = add(scale(side, dcos(a)), scale(other, dsin(a)));
    out.push(norm(add(dir, scale(radial, offset))));
  }
  return out;
}

/** Un jet, une tranche : ce qu'il touche chauffe (un lot de dégâts par moteur : plusieurs jets sur une cible s'additionnent). */
function burnJet(sim: Simulation, jet: Jet, turn: number): void {
  const t = jet.thruster;
  const part = t.block.part;
  const batch = new DamageBatch();
  batch.attacker = t.block.bot;
  batch.cause = "exhaust";
  // Un bloc touché par plusieurs rayons n'a qu'une chance de s'enflammer par tranche
  const tried = new Set<Block>();
  const heat = (target: HitTarget, d: number): void => {
    const dps = jetHeat(jet, d);
    batch.add(target, dps * TICK, "fire");
    if (target.kind !== "block" || tried.has(target.block)) return;
    const b = target.block;
    tried.add(b);
    if (b.burn <= 0 && rand(0, 1) < IGNITE_PER_DPS * dps * TICK * flammability(b)) ignite(sim, b);
  };

  // Son propre robot (sa grille) : un bloc derrière la tuyère arrête aussi le jet
  const own = ownContact(jet);
  const reach = own ? own.distance : jet.length;
  if (own?.block) heat({ kind: "block", block: own.block }, own.distance);
  else if (own?.wheel) heat({ kind: "wheel", wheel: own.wheel }, own.distance);

  // Le reste du monde : quelques rayons dans le cône, qui ignorent le morceau du moteur et les débris
  if (reach > 0.05) {
    const filter = (c: Collider): boolean => {
      const owner = sim.colliders.get(c.handle);
      if (!owner) return true; // décor, sol
      return owner.kind !== "debris" && ownerPart(owner) !== part;
    };
    const lit = new Set<Prop>();
    for (const dir of rayDirections(jet, turn)) {
      const hit = sim.world.castRay(new RAPIER.Ray(jet.origin, dir), reach, true, undefined, undefined, undefined, undefined, filter);
      if (!hit) continue;
      const d = hit.timeOfImpact;
      const point = add(jet.origin, scale(dir, d));
      const target = hitTargetOf(sim.colliders.get(hit.collider.handle), point, dir);
      if (!target) continue; // le décor, le sol : rien ne brûle
      if (target.kind !== "prop") {
        heat(target, d);
        continue;
      }
      const prop = target.prop;
      if (lit.has(prop)) continue;
      lit.add(prop);
      // Le bois prend feu (son feu le ronge ensuite) ; le reste chauffe, selon sa résistance au feu
      if (burnable(prop)) {
        if (prop.burn <= 0 && rand(0, 1) < PROP_IGNITE_PER_DPS * jetHeat(jet, d) * TICK) igniteProp(sim, prop);
      } else if (propDef(prop.type).resist?.fire !== 0) {
        batch.add(target, jetHeat(jet, d) * TICK, "fire");
      }
    }
  }
  if (batch.blocks.size || batch.wheels.size || batch.props.size) inflict(sim, batch, jet.dir, null);
}
