import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WHEEL_TYPES, wheelKind } from "../src/shared/catalog/wheels";
import { applyDamage } from "../src/shared/combat/damage";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, type WheelMount } from "../src/shared/design/robotDesign";
import { qrot, qrotInv, vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { driveWheels } from "../src/shared/robot/propulsion";
import { rolloverAccel, steerAngle, steeringGeometry } from "../src/shared/robot/steering";
import type { Bot, Wheel } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { LETHAL } from "./helpers";
import { seedRandom } from "./seed";

const MAX_ANGLE = WHEEL_TYPES.steered.steering.maxAngle;

/** Braquage d'une roue par rapport au châssis (rad, > 0 : vers la gauche), d'après l'axe de son essieu. */
function heading(w: Wheel): number {
  const axle = qrotInv(w.bot.cockpit.part.rb.rotation(), qrot(w.rb.rotation(), vec3(1, 0, 0)));
  return Math.atan2(-axle.z, axle.x);
}

const yawRate = (b: Bot): number => b.cockpit.part.rb.angvel().y;

describe("roues directrices", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(1);
    sim = new Simulation();
  });
  afterEach(() => {
    sim.dispose();
    vi.restoreAllMocks();
  });

  /**
   * Voiture : plateau de 3 × 7 blocs, avec une paire de roues à chaque rangée `rows` (z) ; celles
   * de devant (z = 3) sont directrices si `steer`.
   */
  function car(steer: boolean, rows = [-3, 3]): BotProfile {
    const g = new DesignGrid().box(-1, 1, 0, 0, -3, 3, "frame").put(0, 1, 0, "cockpit");
    const wheels: WheelMount[] = rows.flatMap((z) => [-1, 1].map((x) => (
      { x, y: 0, z, dx: x, dz: 0, type: steer && z === 3 ? "steered" as const : "standard" as const }
    )));
    return { ...PRESET_BOTS[0], id: steer ? "voiture" : "char", speed: 4, turn: 3, design: { blocks: g.blocks(), wheels } };
  }

  /** Pose un robot au sol, hors de la vague : l'IA ne le pilote pas. */
  function place(profile: BotProfile, x: number): Bot {
    return spawnBot(sim, profile, vec3(x, groundHeight(profile.design) + 0.03, 0), 0);
  }

  function run(seconds: number, drive: () => void): void {
    for (let i = 0; i < seconds * 60; i++) {
      drive();
      sim.step();
    }
  }

  it("braque vers le virage, la roue intérieure plus que l'extérieure (épure d'Ackermann)", () => {
    const bot = place(car(true), 0);
    run(0.5, () => driveWheels(bot, 0, 0));
    run(1.5, () => driveWheels(bot, 0.3, 1));
    const [inner, outer] = bot.wheels.filter((w) => w.steerable).sort((a, b) => b.local.x - a.local.x);
    const geo = steeringGeometry(bot);
    expect(heading(inner)).toBeGreaterThan(heading(outer) + 0.05);
    expect(heading(outer)).toBeGreaterThan(0.2);
    expect(heading(inner)).toBeLessThan(MAX_ANGLE + 0.03);
    for (const w of [inner, outer]) expect(heading(w)).toBeCloseTo(steerAngle(w, geo.maxCurvature, geo.pivotZ), 1);
    // Les roues fixes ne braquent pas
    for (const w of bot.wheels.filter((x) => !x.steerable)) expect(Math.abs(heading(w))).toBeLessThan(0.03);
  });

  it("tourne autour du centre de rotation prévu, à gauche comme à droite", () => {
    for (const side of [1, -1]) {
      const bot = place(car(true), side * 15);
      run(0.5, () => driveWheels(bot, 0, 0));
      run(4, () => driveWheels(bot, 0.5, side));
      const v = bot.cockpit.part.rb.linvel();
      const curvature = yawRate(bot) / Math.hypot(v.x, v.z);
      const expected = side * steeringGeometry(bot).maxCurvature;
      expect(Math.sign(curvature)).toBe(side);
      expect(Math.abs(curvature - expected)).toBeLessThan(Math.abs(expected) * 0.3);
    }
  });

  it("ne pivote pas sur place, contrairement à la conduite différentielle", () => {
    const steered = place(car(true), -10);
    const tank = place(car(false), 10);
    run(0.5, () => {
      driveWheels(steered, 0, 0);
      driveWheels(tank, 0, 0);
    });
    run(2, () => {
      driveWheels(steered, 0, 1);
      driveWheels(tank, 0, 1);
    });
    expect(Math.abs(yawRate(steered))).toBeLessThan(0.15);
    expect(yawRate(tank)).toBeGreaterThan(0.4);
  });

  it("sans ses roues directrices, il repasse en conduite différentielle", () => {
    const bot = place(car(true, [-3, 0, 3]), 0);
    run(0.5, () => driveWheels(bot, 0, 0));
    const bodies = sim.world.bodies.len();
    for (const w of bot.wheels.filter((x) => x.steerable)) {
      applyDamage(sim, w.rb.translation(), vec3(0, -1, 0), LETHAL, { kind: "wheel", wheel: w }, vec3(0, 50, 0));
      expect(w.hub).toBeNull();
    }
    // Chaque roue arrachée devient un corps libre (une roue montée n'en a pas)
    expect(sim.world.bodies.len()).toBe(bodies + 2);
    expect(steeringGeometry(bot).maxCurvature).toBe(0);
    run(2, () => driveWheels(bot, 0, 1));
    expect(yawRate(bot)).toBeGreaterThan(0.4);
  });

  it("sans roue fixe, les roues avant et arrière braquent en sens opposés", () => {
    const centipede = PRESET_BOTS.find((p) => p.id === "centi")!;
    const bot = place(centipede, 0);
    const geo = steeringGeometry(bot);
    const [front, rear] = [8, -6].map((z) => bot.wheels.find((w) => w.steerable && w.mountKey === `1,0,${z}`)!);
    expect(geo.maxCurvature).toBeGreaterThan(0);
    expect(steerAngle(front, geo.maxCurvature, geo.pivotZ)).toBeGreaterThan(0.1);
    expect(steerAngle(rear, geo.maxCurvature, geo.pivotZ)).toBeLessThan(-0.1);
  });

  it("en patrouille, les robots à roues directrices ne restent pas bloqués (demi-tours, manœuvres)", () => {
    spawnWave(sim, PRESET_BOTS.filter((p) => p.design.wheels.some((w) => wheelKind(WHEEL_TYPES[w.type]) === "steered")));
    sim.combat = false;
    const still = new Map<Bot, number>();
    const longest = new Map<Bot, number>();
    for (let i = 0; i < 60 * 60; i++) {
      sim.step();
      for (const bot of sim.bots) {
        // Un robot détruit (un baril qu'un autre a heurté) ne compte plus ; son corps n'existe plus
        if (!bot.cockpit.alive) continue;
        const v = bot.cockpit.part.rb.linvel();
        const t = Math.hypot(v.x, v.z) < 0.2 && bot.ai.mode !== "flipped" ? (still.get(bot) ?? 0) + 1 / 60 : 0;
        still.set(bot, t);
        longest.set(bot, Math.max(longest.get(bot) ?? 0, t));
      }
    }
    for (const [bot, t] of longest) expect(t, bot.profile.name).toBeLessThan(8);
  });

  it("le Tricycle, haut sur trois roues, se renverse plus tôt qu'une voiture basse et large", () => {
    const trike = place(PRESET_BOTS.find((p) => p.id === "trike")!, -10);
    const wide = place(car(true), 10);
    run(0.5, () => {
      driveWheels(trike, 0, 0);
      driveWheels(wide, 0, 0);
    });
    expect(rolloverAccel(trike)).toBeLessThan(rolloverAccel(wide));
    expect(rolloverAccel(trike)).toBeGreaterThan(2);
  });
});
