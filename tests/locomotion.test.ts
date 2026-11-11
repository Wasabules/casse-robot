import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { applyDamage } from "../src/shared/combat/damage";
import { empPulse } from "../src/shared/combat/emp";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { validateDesign, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { drive, liftToWeight } from "../src/shared/robot/propulsion";
import { liveThrusters } from "../src/shared/robot/queries";
import type { Bot } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { LETHAL } from "./helpers";
import { seedRandom } from "./seed";

const FAR = vec3(0, 30, -30);
const DOWN = vec3(0, -1, 0);

describe("chenilles, patins, pattes, rotor orientable", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(4);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  /** Robot seul au centre de l'arène (hors de `sim.bots` : l'IA ne le pilote pas, sauf `ai`). */
  function place(id: string, ai = false, y?: number): Bot {
    const profile = PRESET_BOTS.find((p) => p.id === id)!;
    const bot = spawnBot(sim, profile, vec3(0, y ?? groundHeight(profile.design) + 0.05, 0), 0, "red");
    if (ai) sim.bots.push(bot);
    return bot;
  }
  const run = (seconds: number, each?: () => void): void => {
    for (let i = 0; i < seconds * 60; i++) {
      each?.();
      sim.step();
    }
  };
  const speed = (bot: Bot): number => Math.hypot(bot.cockpit.part.rb.linvel().x, bot.cockpit.part.rb.linvel().z);

  it("le Char avance sur ses chenilles et pivote sur place en ripant", () => {
    const tank = place("tank");
    run(3, () => drive(sim, tank, 1, 0));
    expect(speed(tank)).toBeGreaterThan(2.5);
    run(2, () => drive(sim, tank, 0, 0));
    run(2, () => drive(sim, tank, 0, 1));
    expect(tank.cockpit.part.rb.angvel().y).toBeGreaterThan(0.3);
  });

  it("l'Aéroglisseur flotte sur ses patins, consomme, et retombe quand l'électronique est coupée", () => {
    const hover = place("hovercraft", true);
    sim.aiPaused = true;
    run(3);
    const pads = hover.supports;
    for (const s of pads) {
      expect(s.contact).toBeGreaterThan(0.9);
      expect(s.contact).toBeLessThan(1.4);
    }
    const energy = hover.energy;
    run(2);
    expect(hover.energy).toBeLessThan(energy);
    empPulse(sim, hover.lastPos, WEAPONS.emp.projectile.emp);
    run(1.5);
    expect(Math.max(...pads.map((s) => s.contact))).toBeLessThan(0.7);
  });

  it("l'Araignée marche sur ses pattes, sans consommer d'énergie", () => {
    const spider = place("spider");
    run(1);
    const energy = spider.energy;
    run(4, () => drive(sim, spider, 1, 0));
    expect(speed(spider)).toBeGreaterThan(2);
    for (const s of spider.supports) expect(Number.isFinite(s.contact)).toBe(true);
    expect(spider.energy).toBeGreaterThanOrEqual(energy);
  });

  it("l'Hélicoptère tient son altitude et son cap ; sans rotor de queue, il tourne sur lui-même", () => {
    const heli = place("heli", true, 6);
    expect(liftToWeight(heli)).toBeGreaterThan(1.3);
    sim.aiPaused = true;
    run(3);
    // Cap tenu malgré les rafales : vitesse de lacet moyenne sur 3 s
    let yaw = 0;
    run(3, () => (yaw += Math.abs(heli.cockpit.part.rb.angvel().y) / 180));
    expect(yaw).toBeLessThan(0.25);
    expect(Math.abs(heli.cockpit.part.rb.worldCom().y - heli.ai.alt)).toBeLessThan(1.5);
    const tail = heli.blocks.get("-1,0,-6")!;
    applyDamage(sim, heli.lastPos, DOWN, LETHAL, { kind: "block", block: tail }, FAR);
    expect(liveThrusters(heli, "trim")).toHaveLength(0);
    let spin = 0;
    run(4, () => (spin = Math.max(spin, Math.abs(heli.cockpit.part.rb.angvel().y))));
    expect(spin).toBeGreaterThan(1);
  });

  it("seul un galet de chenille s'empile, et dans ses limites", () => {
    const tank = PRESET_BOTS.find((p) => p.id === "tank")!.design;
    expect(validateDesign(tank)).toEqual([]);
    const withWheels = (change: (w: WheelMount, i: number) => WheelMount): RobotDesign => ({ ...tank, wheels: tank.wheels.map(change) });
    expect(validateDesign(withWheels((w, i) => (i === 0 ? { ...w, rise: -1 } : w)))).toEqual([]);
    expect(validateDesign(withWheels((w, i) => (i === 0 ? { ...w, rise: 3 } : w))).some((p) => p.code === "badStack")).toBe(true);
    expect(validateDesign(withWheels((w, i) => (i === 0 ? { ...w, layer: 3 } : w))).some((p) => p.code === "badStack")).toBe(true);
    expect(validateDesign(withWheels((w, i) => (i === 0 ? { ...w, type: "standard", layer: 1 } : w))).some((p) => p.code === "stackSide")).toBe(true);
  });
});
