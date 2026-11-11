import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { applyDamage } from "../src/shared/combat/damage";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid } from "../src/shared/design/robotDesign";
import { add, vec3 } from "../src/shared/math/vec";
import { setBotVelocity, spawnBot } from "../src/shared/robot/lifecycle";
import { blockWorldPos } from "../src/shared/robot/queries";
import { weakLinks } from "../src/shared/robot/structure";
import type { Block, Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

const UP = vec3(0, 1, 0);
const DOWN = vec3(0, -1, 0);
const FAR = vec3(0, 30, -30);

describe("chocs, résistances et liaisons", () => {
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

  const count = (type: SimEvent["type"]): number => events.filter((e) => e.type === type).length;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  const preset = (id: string): BotProfile => PRESET_BOTS.find((p) => p.id === id)!;

  /** Brique sans roues : 3 × 3 × 2 blocs, un cockpit au centre, du blindage léger devant. */
  function brick(): BotProfile {
    const g = new DesignGrid().box(-1, 1, 0, 1, -1, 0, "frame").box(-1, 1, 0, 1, 1, 1, "armorLight").put(0, 1, 0, "cockpit");
    return { ...preset("scarab"), id: "brique", design: { blocks: g.blocks(), wheels: [] } };
  }

  /**
   * Lance la brique à `speed` m/s contre le mur nord (face à z = 35,5), depuis 3 m, sans gravité :
   * seul compte le choc contre le mur, pas la chute.
   */
  function crash(speed: number, z: number): Bot {
    const bot = spawnBot(sim, brick(), vec3(0, 0.5, z), 0);
    for (const part of bot.parts) part.rb.setGravityScale(0, true);
    setBotVelocity(bot, vec3(0, 0, speed));
    run(2);
    return bot;
  }

  it("un blindage lourd amortit les balles, un blindage réactif les explosions", () => {
    const g = new DesignGrid().box(0, 3, 0, 0, 0, 0, "frame").put(0, 1, 0, "cockpit").put(2, 1, 0, "armorHeavy").put(4, 1, 0, "armorReactive");
    g.put(4, 0, 0, "frame").put(3, 0, 0, "frame");
    const bot = spawnBot(sim, { ...brick(), design: { blocks: g.blocks(), wheels: [] } }, vec3(0, 3, 0), 0);
    const heavy = bot.blocks.get("2,1,0")!;
    const reactive = bot.blocks.get("4,1,0")!;
    applyDamage(sim, blockWorldPos(heavy), DOWN, WEAPONS.rifle, { kind: "block", block: heavy }, FAR);
    expect(BLOCK_TYPES.armorHeavy.hp - heavy.hp).toBeCloseTo(WEAPONS.rifle.projectile.damage * 0.7, 3);
    const shell = WEAPONS.missile.projectile;
    applyDamage(sim, add(blockWorldPos(reactive), vec3(0, 0.25, 0)), DOWN, WEAPONS.missile, { kind: "block", block: reactive }, FAR);
    expect(reactive.alive).toBe(true); // 100 + 230 dégâts explosifs, réduits à 35 %
    expect(BLOCK_TYPES.armorReactive.hp - reactive.hp).toBeLessThan((shell.damage + shell.explosion.damage) * 0.4);
  });

  it("un choc violent contre un mur casse des blocs ; un choc lent, rien", () => {
    const slow = crash(2, 32);
    expect(count("collision")).toBe(0);
    expect([...slow.blocks.values()].every((b: Block) => b.hp === BLOCK_TYPES[b.type].hp)).toBe(true);

    const fast = crash(12, 32);
    expect(count("collision")).toBeGreaterThan(0);
    expect(fast.blocks.size).toBeLessThan(fast.total); // le blindage léger de l'avant a cédé
  });

  it("un avion qui s'écrase perd des blocs", () => {
    const plane = spawnBot(sim, preset("plane"), vec3(0, 12, 0), 0);
    setBotVelocity(plane, vec3(0, -14, 8));
    run(2);
    expect(count("collision")).toBeGreaterThan(0);
    expect(plane.blocks.size).toBeLessThan(plane.total);
  });

  it("les cols fins et les bras d'un bloc de large sont des liaisons faibles", () => {
    const centi = spawnBot(sim, preset("centi"), vec3(0, 2, 0), 0);
    const necks = weakLinks(centi.cockpit.part).filter((l) => l.beyond.size > 10);
    expect(necks.length).toBeGreaterThanOrEqual(2); // les deux cols, vers les segments du milieu et de queue
    const drone = spawnBot(sim, preset("drone"), vec3(20, 5, 0), 0);
    const arms = weakLinks(drone.cockpit.part).filter((l) => l.beyond.size <= 3 && [...l.beyond].some((b) => b.type === "thruster"));
    expect(arms.length).toBeGreaterThanOrEqual(4);
  });

  it("un obus qui frappe le rotor du Drone arrache tout son bras, sans le détruire", () => {
    const drone = spawnBot(sim, preset("drone"), vec3(0, 4, 0), 0);
    const rotor = drone.blocks.get("4,0,0")!;
    // L'impulsion de l'obus seule : ni dégâts, ni explosion
    const dud = { ...WEAPONS.cannon, projectile: { ...WEAPONS.cannon.projectile, damage: 0, explosion: undefined } };
    applyDamage(sim, blockWorldPos(rotor), UP, dud, { kind: "block", block: rotor }, FAR);
    expect(count("linkBroken")).toBe(1);
    expect(rotor.alive).toBe(true);
    expect(rotor.part).not.toBe(drone.cockpit.part);
    expect(drone.blocks.get("2,0,0")!.part).toBe(rotor.part); // le bras part d'un seul tenant
  });

  it("une balle de fusil n'arrache rien", () => {
    const drone = spawnBot(sim, preset("drone"), vec3(0, 4, 0), 0);
    const rotor = drone.blocks.get("4,0,0")!;
    const dud = { ...WEAPONS.rifle, projectile: { ...WEAPONS.rifle.projectile, damage: 0 } };
    applyDamage(sim, blockWorldPos(rotor), UP, dud, { kind: "block", block: rotor }, FAR);
    expect(count("linkBroken")).toBe(0);
  });

  it("au repos, aucun robot de la vague ne se casse tout seul", () => {
    spawnWave(sim, PRESET_BOTS);
    sim.aiPaused = true;
    run(4);
    expect(count("linkBroken")).toBe(0);
    expect(count("blockDestroyed")).toBe(0);
  });
});
