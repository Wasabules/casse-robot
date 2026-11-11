import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WHEEL_TYPES } from "../src/shared/catalog/wheels";
import { applyDamage } from "../src/shared/combat/damage";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, type RobotDesign } from "../src/shared/design/robotDesign";
import { boundedLeastSquares } from "../src/shared/math/linalg";
import { qrotInv, sub, vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { driveWheels, liftToWeight } from "../src/shared/robot/propulsion";
import { liveThrusters, wheelLoad } from "../src/shared/robot/queries";
import type { Bot, Wheel } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { LETHAL } from "./helpers";
import { seedRandom } from "./seed";

const WHEEL = WHEEL_TYPES.standard;

/** Enfoncement de la suspension (m) : position de la roue dans le repère du châssis, moins sa position de repos. */
function compression(w: Wheel): number {
  const rb = w.part!.rb;
  return qrotInv(rb.rotation(), sub(w.rb.translation(), rb.translation())).y - w.local.y;
}

describe("répartition bornée (moindres carrés)", () => {
  it("résout exactement un système faisable", () => {
    const x = boundedLeastSquares([[1, 1], [1, -1]], [10, 2], [1, 1], [0, 0], [100, 100]);
    expect(x[0]).toBeCloseTo(6, 3);
    expect(x[1]).toBeCloseTo(4, 3);
  });

  it("respecte les bornes et reporte l'effort sur les autres variables", () => {
    const x = boundedLeastSquares([[1, 1, 1]], [30], [1], [0, 0, 0], [5, 100, 100]);
    expect(x[0]).toBeLessThanOrEqual(5);
    expect(x[0] + x[1] + x[2]).toBeCloseTo(30, 3);
  });
});

describe("véhicules à roues", () => {
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

  /** Plateau à 4 roues ; `heavy` ajoute une pile de blindage lourd au-dessus du cockpit. */
  function platform(heavy: boolean): BotProfile {
    const g = new DesignGrid().box(-1, 1, 0, 0, -2, 2, "frame").put(0, 1, 0, "cockpit");
    if (heavy) g.box(-1, 1, 2, 5, -2, 2, "armorHeavy");
    const design: RobotDesign = {
      blocks: g.blocks(),
      wheels: [[-1, -2, -1], [1, -2, 1], [-1, 2, -1], [1, 2, 1]].map(([x, z, dx]) => ({ x, y: 0, z, dx, dz: 0, type: "standard" as const })),
    };
    return { ...PRESET_BOTS[0], id: heavy ? "lourd" : "leger", design };
  }

  /** Pose un robot au sol, hors de la vague : l'IA ne le pilote pas. */
  function place(profile: BotProfile, x: number): Bot {
    return spawnBot(sim, profile, vec3(x, groundHeight(profile.design) + 0.03, 0), 0);
  }

  it("au repos, aucune roue des robots de la vague n'est en butée", () => {
    spawnWave(sim, PRESET_BOTS);
    sim.aiPaused = true;
    for (let i = 0; i < 120; i++) sim.step();
    const { travelUp, travelDown } = WHEEL.suspension;
    for (const bot of sim.bots.filter((b) => b.profile.mobility === "ground")) {
      for (const w of bot.wheels) {
        expect(compression(w)).toBeLessThan(travelUp - 0.05);
        expect(compression(w)).toBeGreaterThan(-travelDown + 0.03);
      }
    }
  });

  it("un robot trop lourd pour ses roues écrase ses suspensions", () => {
    const light = place(platform(false), -10);
    const heavy = place(platform(true), 10);
    for (let i = 0; i < 120; i++) sim.step();
    expect(wheelLoad(light)).toBeLessThan(0.3);
    expect(wheelLoad(heavy)).toBeGreaterThan(1.1);
    const mean = (b: Bot): number => b.wheels.reduce((s, w) => s + compression(w), 0) / b.wheels.length;
    expect(mean(light)).toBeLessThan(-0.02); // peu chargé : ressorts détendus
    expect(mean(heavy) - mean(light)).toBeGreaterThan(0.03);
  });

  it("plus un robot est lourd pour ses roues, moins il pivote sur place", () => {
    const light = place(platform(false), -10);
    const heavy = place(platform(true), 10);
    for (let i = 0; i < 60; i++) sim.step();
    for (let i = 0; i < 120; i++) {
      driveWheels(light, 0, 1);
      driveWheels(heavy, 0, 1);
      sim.step();
    }
    const yawRate = (b: Bot): number => Math.abs(b.cockpit.part.rb.angvel().y);
    expect(yawRate(light)).toBeGreaterThan(1);
    expect(yawRate(heavy)).toBeLessThan(yawRate(light) * 0.6);
  });

  it("un moteur ne dépasse pas sa vitesse à vide", () => {
    const light = place(platform(false), 0);
    for (let i = 0; i < 360; i++) {
      driveWheels(light, 1, 0);
      sim.step();
    }
    const v = light.cockpit.part.rb.linvel();
    expect(Math.hypot(v.x, v.z)).toBeLessThan(WHEEL.freeSpeed * WHEEL.radius * 1.05);
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(1);
  });
});

describe("vol du drone", () => {
  let sim: Simulation;
  let drone: Bot;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(7);
    sim = new Simulation();
    // Le drone seul : ces essais portent sur son vol, pas sur ses voisins
    spawnWave(sim, PRESET_BOTS.filter((p) => p.id === "drone"));
    sim.aiPaused = true;
    drone = sim.bots.find((b) => b.profile.id === "drone")!;
    for (let i = 0; i < 180; i++) sim.step();
  });
  afterEach(() => {
    sim.dispose();
    vi.restoreAllMocks();
  });

  function killThrusters(...keys: string[]): void {
    for (const key of keys) {
      const block = drone.blocks.get(key)!;
      applyDamage(sim, drone.lastPos, vec3(0, -1, 0), LETHAL, { kind: "block", block }, vec3(0, 50, 0));
    }
    sim.aiPaused = true;
  }

  /** Simule `seconds` s ; renvoie l'altitude la plus basse et la vitesse de lacet la plus forte. */
  function fly(seconds: number) {
    let minY = Infinity;
    let maxYaw = 0;
    for (let i = 0; i < seconds * 60; i++) {
      sim.step();
      const rb = drone.cockpit.part.rb;
      minY = Math.min(minY, rb.worldCom().y);
      maxYaw = Math.max(maxYaw, Math.abs(rb.angvel().y));
    }
    return { minY, maxYaw };
  }

  it("avec 4 réacteurs, il tient son altitude malgré les rafales", () => {
    expect(liftToWeight(drone)).toBeGreaterThan(1.5); // armé : sa mitrailleuse pèse 3 kg
    const alt = drone.ai.alt;
    const { minY } = fly(10);
    expect(minY).toBeGreaterThan(alt - 1);
    expect(Math.abs(drone.cockpit.part.rb.worldCom().y - alt)).toBeLessThan(0.7);
  });

  it("avec 3 réacteurs, sa portance utile tombe vers 1 et il tourne sur lui-même", () => {
    killThrusters("4,0,0");
    expect(liveThrusters(drone)).toHaveLength(3);
    const ratio = liftToWeight(drone);
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(1.2);
    const { maxYaw } = fly(10);
    expect(maxYaw).toBeGreaterThan(0.8);
  });

  it("avec 2 réacteurs opposés, il ne tient plus son assiette et tombe", () => {
    killThrusters("4,0,0", "-4,0,0");
    const { minY } = fly(10);
    expect(minY).toBeLessThan(1.3);
  });
});
