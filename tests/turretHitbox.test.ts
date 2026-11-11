import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blockDef } from "../src/shared/catalog/blocks";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, qrot, scale, sub, vec3, type Vec3 } from "../src/shared/math/vec";
import { hitTargetOf } from "../src/shared/robot/colliders";
import { blockWorldPos } from "../src/shared/robot/queries";
import { turretFrame } from "../src/shared/combat/turrets";
import type { Bot, Turret } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * Zones touchables des têtes de tourelle : la tête et le canon dépassent du bloc, dont les
 * collisions ne sont que le cube ; un tir sur l'arme doit toucher l'arme.
 */
describe("têtes de tourelle touchables", () => {
  let sim: Simulation;
  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(7);
    sim = new Simulation();
    spawnWave(sim, PRESET_BOTS.filter((p) => p.id === "trike"));
    sim.aiPaused = true;
    for (let i = 0; i < 30; i++) sim.step();
  });
  afterEach(() => sim.dispose());

  const trike = (): Bot => sim.bots[0];
  const gun = (): Turret => trike().turrets.find((t) => t.weapon === "rifle")!;
  /** Axe de la tête, dans le monde. */
  const pivot = (t: Turret): Vec3 => add(blockWorldPos(t.block), qrot(turretFrame(t).base, vec3(0, blockDef(t.block.type).turret!.height, 0)));
  /** Un rayon tiré de côté, à 4 m, droit sur `at`. */
  const fromSide = (at: Vec3): { origin: Vec3; dir: Vec3 } => {
    const right = qrot(trike().cockpit.part.rb.rotation(), vec3(-1, 0, 0));
    return { origin: sub(at, scale(right, 4)), dir: right };
  };

  it("un rayon qui passe au-dessus du bloc, dans la tête, touche la tourelle", () => {
    const t = gun();
    const { origin, dir } = fromSide(pivot(t));
    const hit = sim.raycast(origin, dir, 8);
    expect(hit?.owner?.kind).toBe("head");
    expect(hitTargetOf(hit!.owner, hit!.point, dir)).toEqual({ kind: "block", block: t.block });
  });

  it("une balle tirée sur la tête abîme le bloc de la tourelle", () => {
    const t = gun();
    const before = t.block.hp;
    const { origin, dir } = fromSide(pivot(t));
    sim.fire("rifle", origin, dir);
    for (let i = 0; i < 10; i++) sim.step();
    expect(t.block.hp).toBeLessThan(before);
  });

  it("le canon se touche aussi, et sa zone suit la tête quand elle tourne", () => {
    const t = gun();
    const spec = blockDef(t.block.type).turret!;
    // Le canon droit devant : le milieu du tube est touché d'en haut
    const middle = (): Vec3 => add(pivot(t), scale(turretFrame(t).dir, spec.barrel * 0.75));
    const down = vec3(0, -1, 0);
    const above = middle();
    expect(sim.raycast(add(above, vec3(0, 3, 0)), down, 6)?.owner?.kind).toBe("head");
    // La tête tourne d'un quart de tour : là où était le canon, plus rien de la tourelle
    t.yaw = Math.PI / 2;
    sim.step();
    sim.step();
    const old = sim.raycast(add(above, vec3(0, 3, 0)), down, 6);
    expect(old?.owner?.kind).not.toBe("head");
    expect(sim.raycast(add(middle(), vec3(0, 3, 0)), down, 6)?.owner?.kind).toBe("head");
  });

  it("une zone touchable ne pèse rien et ne heurte rien", () => {
    const part = gun().block.part;
    expect(part.heads.length).toBeGreaterThan(0);
    for (const h of part.heads) {
      for (const c of [h.head, h.barrel]) {
        if (!c) continue;
        expect(c.mass()).toBe(0);
        // Groupes de Rapier : 16 bits de filtre (poids faibles) vides, elle ne heurte rien
        expect(c.collisionGroups() & 0xffff).toBe(0);
      }
    }
  });

  it("la tourelle détruite, sa zone touchable disparaît avec elle", () => {
    const t = gun();
    const { origin, dir } = fromSide(pivot(t));
    for (let i = 0; i < 8 && t.block.alive; i++) {
      sim.fire("sniper", origin, dir);
      for (let k = 0; k < 5; k++) sim.step();
    }
    expect(t.block.alive).toBe(false);
    sim.step();
    expect(t.block.part.heads.some((h) => h.turret === t)).toBe(false);
    const hit = sim.raycast(origin, dir, 8);
    expect(hit?.owner?.kind).not.toBe("head");
  });
});
