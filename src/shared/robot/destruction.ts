import { BLOCK_TYPES } from "../catalog/blocks";
import { cellKey, NEIGHBORS } from "../design/robotDesign";
import { add, cross, qrot, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { Block, Bot, Part } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { attachBlock, detachBlock, makePart, moveWheel, releaseWheel, removePart } from "./lifecycle";
import { linkKey } from "./structure";

/** Mouvement d'un morceau relevé avant d'y retirer des blocs (le retrait change sa masse et son centre de masse). */
export interface PartMotion {
  com: Vec3;
  linvel: Vec3;
  angvel: Vec3;
}

export function capturePartMotion(part: Part): PartMotion {
  return { com: part.rb.worldCom(), linvel: part.rb.linvel(), angvel: part.rb.angvel() };
}

/** Vitesse du point `p`, supposé solidaire du morceau relevé. */
export function pointVelocity(motion: PartMotion, p: Vec3): Vec3 {
  return add(motion.linvel, cross(motion.angvel, sub(p, motion.com)));
}

/**
 * Après une destruction de blocs ou la rupture d'une liaison, découpe le morceau en composantes
 * connexes (voisinage 6, sans passer par les liaisons rompues).
 * La composante qui contient le cockpit garde le corps (sinon la plus grosse). Chaque autre
 * composante devient un nouveau corps à la même pose, lancé à la vitesse qu'avait le
 * morceau d'origine au centre de masse de la composante.
 */
export function splitPart(sim: Simulation, part: Part, before: PartMotion): void {
  const bot = part.bot;
  if (part.blocks.size === 0) {
    removePart(sim, part);
    return;
  }

  const remaining = new Set(part.blocks);
  const comps: Block[][] = [];
  for (const start of part.blocks) {
    if (!remaining.delete(start)) continue;
    const comp = [start];
    for (let i = 0; i < comp.length; i++) {
      const b = comp[i];
      for (const [dx, dy, dz] of NEIGHBORS) {
        const n = bot.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz));
        if (n && !bot.cuts.has(linkKey(b, n)) && remaining.delete(n)) comp.push(n);
      }
    }
    comps.push(comp);
  }
  if (comps.length === 1) return;

  const ck = bot.cockpit;
  const keep =
    comps.find((c) => ck.alive && c.includes(ck)) ??
    comps.reduce((best, c) => (c.length > best.length ? c : best));

  const t = part.rb.translation();
  const r = part.rb.rotation();
  for (const comp of comps) {
    if (comp === keep) continue;
    const np = makePart(sim, bot, t, r);
    let weighted = vec3(0, 0, 0);
    let mass = 0;
    for (const b of comp) {
      detachBlock(b);
      attachBlock(sim, b, np);
      const m = BLOCK_TYPES[b.type].mass;
      weighted = add(weighted, scale(b.local, m));
      mass += m;
    }
    const comWorld = add(t, qrot(r, scale(weighted, 1 / mass)));
    np.rb.setLinvel(pointVelocity(before, comWorld), true);
    np.rb.setAngvel(before.angvel, true);
  }
}

/** Une roue suit le morceau de son bloc support, et tombe si ce bloc est détruit. */
export function refreshWheels(sim: Simulation, bot: Bot): void {
  for (const w of bot.wheels) {
    if (!w.part) continue;
    const support = bot.blocks.get(w.mountKey);
    if (!support) releaseWheel(sim, w);
    else if (support.part !== w.part) moveWheel(sim, w, support.part);
  }
}
