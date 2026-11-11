import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blockDef } from "../src/shared/catalog/blocks";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { applyDamage } from "../src/shared/combat/damage";
import { spawnProjectile } from "../src/shared/combat/projectiles";
import { fireTurret, turretReady } from "../src/shared/combat/turrets";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type RobotDesign } from "../src/shared/design/robotDesign";
import { vec3 } from "../src/shared/math/vec";
import { energyCapacity } from "../src/shared/robot/energy";
import { spawnBot } from "../src/shared/robot/lifecycle";
import { blockWorldPos } from "../src/shared/robot/queries";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { seedRandom } from "./seed";

/** Un robot posé sur des blocs (sans roues), fait de ce plan. */
const profileOf = (design: RobotDesign): BotProfile => ({ ...PRESET_BOTS[0], id: "essai", name: "Essai", design });

describe("armes électriques et bouclier", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(3);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const place = (design: RobotDesign, z = 0): Bot => {
    expect(validateDesign(design)).toEqual([]);
    const bot = spawnBot(sim, profileOf(design), vec3(0, 0.3, z), 0, "red");
    sim.bots.push(bot);
    return bot;
  };
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };

  it("le laser passe le blindage lourd comme un autre : c'est l'arme contre les robots cuirassés", () => {
    expect(blockDef("armorHeavy").resist?.energy ?? 1).toBe(1);
    expect(blockDef("armorHeavy").resist?.kinetic).toBeLessThan(1);
    const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, 0, "cockpit").put(0, 1, 1, "armorHeavy");
    const bot = place({ blocks: g.blocks(), wheels: [] });
    sim.aiPaused = true;
    const heavy = bot.blocks.get("0,1,1")!;
    const at = blockWorldPos(heavy);
    applyDamage(sim, at, vec3(0, 0, -1), WEAPONS.laser, { kind: "block", block: heavy }, vec3(0, 1, 10));
    expect(blockDef("armorHeavy").hp - heavy.hp).toBeCloseTo(WEAPONS.laser.projectile.damage, 5);
    applyDamage(sim, at, vec3(0, 0, -1), WEAPONS.rifle, { kind: "block", block: heavy }, vec3(0, 1, 10));
    const rifleDamage = blockDef("armorHeavy").hp - heavy.hp - WEAPONS.laser.projectile.damage;
    expect(rifleDamage).toBeCloseTo(WEAPONS.rifle.projectile.damage * blockDef("armorHeavy").resist!.kinetic!, 5);
  });

  it("le canon électrique traverse plusieurs blocs d'un coup", () => {
    // Une poutre de blindage alignée avec le tir
    const g = new DesignGrid().box(0, 0, 0, 0, -6, 6, "armor").put(0, 1, -6, "cockpit");
    const bot = place({ blocks: g.blocks(), wheels: [] });
    sim.aiPaused = true;
    run(0.5);
    const before = bot.blocks.size;
    spawnProjectile(sim, "rail", vec3(0, 0.3, 8), vec3(0, 0, -1), { shooter: null });
    run(0.3);
    // Il perce autant de blindages que ses dégâts le permettent (3 blindages de 100 PS pour 380)
    const pierced = Math.floor(WEAPONS.rail.projectile.damage / blockDef("armor").hp);
    expect(pierced).toBeGreaterThanOrEqual(3);
    expect(before - bot.blocks.size).toBe(pierced);
  });

  it("une arme électrique ne tire que si les batteries ont de quoi, et chaque tir les vide d'autant", () => {
    const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, 0, "cockpit").put(0, 1, 1, "railTurret");
    const bot = place({ blocks: g.blocks(), wheels: [] });
    const rail = bot.turrets[0];
    rail.arm.cooldown = 0;
    expect(bot.energy).toBe(energyCapacity(bot));
    bot.energy = WEAPONS.rail.power - 1;
    expect(turretReady(rail)).toBe(false);
    bot.energy = WEAPONS.rail.power + 2;
    expect(turretReady(rail)).toBe(true);
    fireTurret(sim, rail);
    expect(bot.energy).toBeCloseTo(2, 5);
  });

  it("le bouclier absorbe une part des dégâts autour de lui et la paie en énergie ; batteries vides, il ne protège plus", () => {
    const spec = blockDef("shield").shield!;
    const g = new DesignGrid().box(-1, 1, 0, 0, -1, 6, "frame").put(0, 1, 0, "cockpit").put(1, 1, 0, "shield")
      .put(-1, 1, 0, "armor").put(0, 1, 6, "armor");
    const bot = place({ blocks: g.blocks(), wheels: [] });
    sim.aiPaused = true;
    const near = bot.blocks.get("-1,1,0")!;
    const far = bot.blocks.get("0,1,6")!; // à 3 m du générateur : hors de portée
    const hit = (block: typeof near, damage: number): number => {
      const hp = block.hp;
      applyDamage(sim, blockWorldPos(block), vec3(0, -1, 0), { ...WEAPONS.rifle, projectile: { ...WEAPONS.rifle.projectile, damage } }, { kind: "block", block }, vec3(0, 10, 0));
      return hp - block.hp;
    };
    const energy = bot.energy;
    expect(hit(near, 50)).toBeCloseTo(50 * (1 - spec.absorb), 5);
    expect(bot.energy).toBeCloseTo(energy - 50 * spec.absorb * spec.cost, 5);
    expect(events.some((e) => e.type === "shieldHit" && e.block.type === "shield")).toBe(true);
    expect(hit(far, 30)).toBeCloseTo(30, 5);
    bot.energy = 0;
    expect(hit(near, 20)).toBeCloseTo(20, 5);
  });

  it("les deux nouveaux robots prédéfinis sont valides et tiennent debout", () => {
    for (const id of ["bulwark", "lancer"]) {
      const profile = PRESET_BOTS.find((p) => p.id === id)!;
      expect(validateDesign(profile.design)).toEqual([]);
    }
  });
});
