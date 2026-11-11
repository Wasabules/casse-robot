import { newInput, takeControl } from "../src/shared/sim/player";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { designCost, ROBOT_BUDGET } from "../src/shared/design/budget";
import { cruiseSpeed, inferMobility, profileFromDesign } from "../src/shared/design/custom";
import { designCenterOfMass, flightStats } from "../src/shared/design/flight";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, wheelLocalPos, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { drive, liftToWeight } from "../src/shared/robot/propulsion";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";

const preset = (id: string): RobotDesign => PRESET_BOTS.find((p) => p.id === id)!.design;

describe("pose fine des roues et centre de masse", () => {
  const plate = (): DesignGrid => new DesignGrid().box(-1, 1, 0, 0, -3, 3, "frame").put(0, 1, 0, "cockpit");
  const side = (z: number, shift?: number): WheelMount => ({ x: 1, y: 0, z, dx: 1, dz: 0, type: "standard", ...(shift ? { shift } : {}) });

  it("une roue décalée glisse d'un quart de mètre le long de son flanc", () => {
    expect(wheelLocalPos(side(0, 1)).z - wheelLocalPos(side(0)).z).toBeCloseTo(0.25, 6);
    expect(wheelLocalPos(side(0, -1)).z - wheelLocalPos(side(0)).z).toBeCloseTo(-0.25, 6);
    // Sur un flanc avant, le décalage va de côté
    const front: WheelMount = { x: 0, y: 0, z: 3, dx: 0, dz: 1, type: "standard", shift: 1 };
    expect(wheelLocalPos(front).x - wheelLocalPos({ ...front, shift: 0 }).x).toBeCloseTo(0.25, 6);
  });

  it("le décalage permet d'espacer des roues de deux cases et demie sans qu'elles se chevauchent", () => {
    // Deux cases d'écart : les roues standard (1,1 m) se chevauchent ; décalées d'une demi-case vers l'extérieur, plus
    const close = { blocks: plate().blocks(), wheels: [side(-1), side(1)] };
    expect(validateDesign(close).some((p) => p.code === "wheelsOverlap")).toBe(true);
    const spaced = { blocks: plate().blocks(), wheels: [side(-1, -1), side(1, 1)] };
    expect(validateDesign(spaced)).toEqual([]);
    // Un décalage hors de -1, 0, 1 est refusé
    expect(validateDesign({ blocks: plate().blocks(), wheels: [side(0, 2)] }).some((p) => p.code === "badShift")).toBe(true);
  });

  it("le centre de masse suit les blocs lourds", () => {
    const g = plate();
    const even = designCenterOfMass({ blocks: g.blocks(), wheels: [] });
    expect(Math.abs(even.x)).toBeLessThan(1e-9);
    expect(Math.abs(even.z)).toBeLessThan(1e-9);
    // Un blindage lourd à l'avant tire le centre de masse vers l'avant, et vers le haut
    const heavy = designCenterOfMass({ blocks: g.put(0, 1, 3, "armorHeavy").blocks(), wheels: [] });
    expect(heavy.z).toBeGreaterThan(0.1);
    expect(heavy.y).toBeGreaterThan(even.y);
  });

  it("un robot aux roues décalées roule", async () => {
    await initPhysics();
    const sim = new Simulation();
    const design = { blocks: plate().blocks(), wheels: [side(-3, -1), side(3, 1), { ...side(-3, -1), x: -1, dx: -1 }, { ...side(3, 1), x: -1, dx: -1 }] };
    expect(validateDesign(design)).toEqual([]);
    const bot = spawnBot(sim, profileFromDesign("Décalé", "#888888", design), vec3(0, groundHeight(design) + 0.05, 0), 0, "blue");
    sim.bots.push(bot);
    // Piloté comme par un joueur, pleins gaz : l'IA, elle, irait vers une destination tirée au hasard
    const input = newInput();
    takeControl(bot, input);
    for (let i = 0; i < 60; i++) sim.step();
    input.throttle = 1;
    for (let i = 0; i < 120; i++) sim.step();
    const v = bot.cockpit.part.rb.linvel();
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(1.5);
    sim.dispose();
  });
});

describe("budget et robots du garage", () => {
  it("tous les robots prédéfinis tiennent dans le budget", () => {
    for (const p of PRESET_BOTS) expect(designCost(p.design), p.id).toBeLessThanOrEqual(ROBOT_BUDGET);
  });

  it("un plan qui dépasse le budget est refusé", () => {
    const g = new DesignGrid().box(-4, 4, 0, 4, -4, 4, "armorHeavy").put(0, 5, 0, "cockpit");
    const design: RobotDesign = { blocks: g.blocks(), wheels: [] };
    expect(designCost(design)).toBeGreaterThan(ROBOT_BUDGET);
    expect(validateDesign(design).some((p) => p.code === "overBudget")).toBe(true);
  });

  it("la mobilité se déduit des organes du robot", () => {
    expect(inferMobility(preset("drone"))).toBe("hover");
    expect(inferMobility(preset("heli"))).toBe("hover");
    expect(inferMobility(preset("plane"))).toBe("plane");
    for (const id of ["tank", "spider", "hovercraft", "buggy"]) expect(inferMobility(preset(id)), id).toBe("ground");
  });

  it("la vitesse de croisière suit les roues les plus lentes, ou les appuis", () => {
    expect(cruiseSpeed(preset("truck"), "ground")).toBeLessThan(cruiseSpeed(preset("buggy"), "ground"));
    expect(cruiseSpeed(preset("spider"), "ground")).toBeLessThan(cruiseSpeed(preset("hovercraft"), "ground"));
    expect(cruiseSpeed(preset("tank"), "ground")).toBeGreaterThan(1);
  });

  it("un robot sans rotor ne décolle pas ; un avion a de la poussée", () => {
    expect(flightStats(preset("buggy")).hoverTime).toBeNull();
    expect(flightStats(preset("buggy")).liftRatio).toBe(0);
    expect(flightStats(preset("plane")).thrustRatio).toBeGreaterThan(0.2);
    const drone = flightStats(preset("drone"));
    expect(drone.hoverTime).toBeGreaterThan(30);
    expect(drone.hoverTime).toBeLessThan(600);
  });

  describe("un robot du garage se pilote", () => {
    let sim: Simulation;
    beforeAll(async () => {
      await initPhysics();
    });
    beforeEach(() => {
      sim = new Simulation();
    });
    afterEach(() => sim.dispose());

    it("la portance estimée au garage est celle que mesure le jeu", () => {
      for (const id of ["drone", "hexa", "heli"]) {
        const profile = PRESET_BOTS.find((p) => p.id === id)!;
        const bot = spawnBot(sim, profile, vec3(0, 5, 0), 0);
        expect(flightStats(profile.design).liftRatio, id).toBeCloseTo(liftToWeight(bot), 1);
        expect(flightStats(profile.design).mass, id).toBeCloseTo(bot.cockpit.part.rb.mass(), 3);
      }
    });

    it("un plateau à quatre roues construit au garage roule", () => {
      const g = new DesignGrid().box(-1, 1, 0, 0, -2, 2, "frame").put(0, 1, 0, "cockpit");
      const design: RobotDesign = {
        blocks: g.blocks(),
        wheels: [[-1, -2, -1], [1, -2, 1], [-1, 2, -1], [1, 2, 1]].map(([x, z, dx]) => ({ x, y: 0, z, dx, dz: 0, type: "standard" as const })),
      };
      const profile = profileFromDesign("Essai", "#888888", design);
      expect(profile.mobility).toBe("ground");
      const bot = spawnBot(sim, profile, vec3(0, groundHeight(design) + 0.05, 0), 0);
      for (let i = 0; i < 180; i++) {
        drive(sim, bot, 1, 0);
        sim.step();
      }
      const v = bot.cockpit.part.rb.linvel();
      expect(Math.hypot(v.x, v.z)).toBeGreaterThan(2);
    });
  });
});
