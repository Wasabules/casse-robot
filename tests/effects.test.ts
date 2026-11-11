import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { BURN_TIME, ignite } from "../src/shared/combat/burning";
import { empPulse, isStunned } from "../src/shared/combat/emp";
import { releaseSmoke, smokeBlocks } from "../src/shared/combat/smoke";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, norm, sub, vec3 } from "../src/shared/math/vec";
import { blockWorldPos } from "../src/shared/robot/queries";
import type { Bot } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

describe("feu, impulsion électromagnétique, fumée", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(5);
    sim = new Simulation();
    spawnWave(sim, PRESET_BOTS);
    sim.aiPaused = true;
    sim.combat = false;
    run(1);
  });
  afterEach(() => sim.dispose());

  function run(seconds: number): void {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  }
  const bot = (id: string): Bot => sim.bots.find((b) => b.profile.id === id)!;

  it("un bloc en feu perd des points de structure, puis s'éteint", () => {
    const frame = bot("scarab").blocks.get("0,0,0")!;
    ignite(sim, frame);
    expect(sim.fires.has(frame)).toBe(true);
    run(2);
    expect(frame.hp).toBeLessThan(BLOCK_TYPES.frame.hp - 20);
    run(BURN_TIME);
    expect(frame.alive).toBe(true); // 80 points : un feu seul ne le détruit pas
    expect(frame.burn).toBe(0);
    expect(sim.fires.has(frame)).toBe(false);
  });

  it("le blindage léger brûle vite, le blindage lourd résiste", () => {
    const light = bot("trike").blocks.get("-1,1,-3")!;
    const heavy = bot("scarab").blocks.get("0,3,0")!;
    ignite(sim, light);
    ignite(sim, heavy);
    run(4);
    expect(light.alive).toBe(false);
    expect(heavy.alive).toBe(true);
    expect(BLOCK_TYPES.armorHeavy.hp - heavy.hp).toBeLessThan(45);
  });

  it("le lance-flammes met le feu à ce qu'il arrose", () => {
    const target = bot("ram");
    const block = target.blocks.get("0,2,-1")!;
    const aim = blockWorldPos(block);
    const from = add(aim, vec3(0, 2, -5));
    for (let i = 0; i < 120 && !sim.fires.size; i++) {
      sim.fire("flamer", from, norm(sub(aim, from)));
      sim.step();
    }
    expect(sim.fires.size).toBeGreaterThan(0);
  });

  it("une impulsion électromagnétique fait tomber le Drone, qui repart ensuite", () => {
    sim.aiPaused = false;
    const drone = bot("drone");
    run(2);
    const alt = drone.cockpit.part.rb.worldCom().y;
    empPulse(sim, drone.lastPos, WEAPONS.emp.projectile.emp);
    expect(isStunned(sim, drone)).toBe(true);
    run(1.2);
    expect(drone.ai.mode).toBe("stunned");
    expect(drone.cockpit.part.rb.worldCom().y).toBeLessThan(alt - 1.5);
    run(4);
    expect(isStunned(sim, drone)).toBe(false);
    expect(drone.ai.mode).not.toBe("stunned");
  });

  it("paralysé, un robot à roues n'entraîne plus ses roues", () => {
    sim.aiPaused = false;
    const ram = bot("ram");
    run(1);
    empPulse(sim, ram.lastPos, WEAPONS.emp.projectile.emp);
    run(0.2);
    expect(ram.wheels.every((w) => w.drive === 0)).toBe(true);
  });

  it("un nuage de fumée cache ce qui est derrière lui, puis se dissipe", () => {
    const a = vec3(-10, 1, 0);
    const b = vec3(10, 1, 0);
    expect(smokeBlocks(sim, a, b)).toBe(false);
    releaseSmoke(sim, vec3(0, 1, 0), WEAPONS.smoke.projectile.smoke);
    run(1.5);
    expect(smokeBlocks(sim, a, b)).toBe(true);
    expect(smokeBlocks(sim, vec3(-10, 1, 20), vec3(10, 1, 20))).toBe(false);
    run(WEAPONS.smoke.projectile.smoke.duration);
    expect(sim.smokes.length).toBe(0);
    expect(smokeBlocks(sim, a, b)).toBe(false);
  });

  it("un obus fumigène libère son nuage à l'impact", () => {
    sim.fire("smoke", vec3(0, 2, 0), norm(vec3(1, -0.3, 0)));
    run(1.5);
    expect(sim.smokes.length).toBe(1);
  });
});
