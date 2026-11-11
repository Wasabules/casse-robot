import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { steeredVariant, WHEEL_TYPES, wheelDef, wheelKind, type WheelType } from "../src/shared/catalog/wheels";
import { BLOCK_SIZE } from "../src/shared/config";
import { designCost } from "../src/shared/design/budget";
import { cruiseSpeed } from "../src/shared/design/custom";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { upgradeUnlocked, WHEEL_PRICES } from "../src/shared/design/progression";
import { DesignGrid, upgradeDesign, validateDesign, wheelLocalPos, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { dot, qrot, vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { drive } from "../src/shared/robot/propulsion";
import type { Bot } from "../src/shared/sim/entities";
import { takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import {
  beltShape, placeShoes, shoeHorns, shoeLoop, SHOE_PITCH, sprocketRollers, trackGroups,
} from "../src/client/render/trackShape";
import { seedRandom } from "./seed";

const TYPES = Object.keys(WHEEL_TYPES) as WheelType[];

describe("trois sortes de roues", () => {
  it("chaque roue fixe a sa roue directrice, plus chère à poser et à débloquer ; la roulette n'a pas de moteur", () => {
    for (const fixed of TYPES.filter((t) => wheelKind(wheelDef(t)) === "fixed")) {
      const steered = steeredVariant(fixed)!;
      expect(wheelKind(wheelDef(steered))).toBe("steered");
      expect(wheelDef(steered).radius).toBe(wheelDef(fixed).radius);
      expect(wheelDef(steered).cost).toBeGreaterThan(wheelDef(fixed).cost);
      expect(WHEEL_PRICES[steered]).toBeGreaterThan(WHEEL_PRICES[fixed]);
    }
    expect(wheelKind(WHEEL_TYPES.caster)).toBe("caster");
    expect(WHEEL_TYPES.caster.stallTorque).toBe(0);
    expect(wheelKind(WHEEL_TYPES.track)).toBe("track");
  });

  it("un plan d'avant (case « directrice ») se relit : ses roues directrices deviennent le type à part", () => {
    const old = { blocks: [], wheels: [{ x: 1, y: 0, z: 2, dx: 1, dz: 0, type: "heavy", steer: true }, { x: 1, y: 0, z: -2, dx: 1, dz: 0, type: "heavy", steer: false }] } as unknown as RobotDesign;
    expect(validateDesign(old).some((p) => p.code === "oldSteer")).toBe(true);
    expect(upgradeDesign(old).wheels).toEqual([
      { x: 1, y: 0, z: 2, dx: 1, dz: 0, type: "heavySteered" },
      { x: 1, y: 0, z: -2, dx: 1, dz: 0, type: "heavy" },
    ]);
    // Qui avait débloqué la roue lourde a aussi sa directrice (elle n'était qu'une option)
    expect(upgradeUnlocked(["wheel:heavy"])).toContain("wheel:heavySteered");
  });

  it("une roue se pose aussi sous un bloc, si la case du dessous est libre", () => {
    const g = new DesignGrid().box(-1, 1, 0, 0, -2, 2, "frame").put(0, 1, 0, "cockpit");
    const under: WheelMount = { x: 0, y: 0, z: 2, dx: 0, dz: 0, dy: -1, type: "caster" };
    const p = wheelLocalPos(under);
    expect(p.x).toBe(0);
    expect(p.z).toBeCloseTo(2 * BLOCK_SIZE);
    // Le bas d'une roulette posée dessous est au niveau du bas d'une roue lourde posée sur le flanc
    expect(p.y - WHEEL_TYPES.caster.radius).toBeCloseTo(-WHEEL_TYPES.heavy.radius, 2);
    expect(validateDesign({ blocks: g.blocks(), wheels: [under] })).toEqual([]);
    g.put(0, -1, 2, "frame");
    expect(validateDesign({ blocks: g.blocks(), wheels: [under] }).some((p) => p.code === "underOccupied")).toBe(true);
  });

  it("la vitesse de croisière ne compte pas les roulettes, qui n'ont pas de moteur", () => {
    const design: RobotDesign = { blocks: [], wheels: [{ x: 0, y: 0, z: 0, dx: 1, dz: 0, type: "standard" }, { x: 0, y: 0, z: 2, dx: 0, dz: 0, dy: -1, type: "caster" }] };
    expect(cruiseSpeed(design, "ground")).toBeCloseTo(0.85 * WHEEL_TYPES.standard.freeSpeed * WHEEL_TYPES.standard.radius);
  });
});

describe("roulettes et chenilles en marche", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(4);
    sim = new Simulation();
    sim.combat = false;
  });
  afterEach(() => {
    sim.dispose();
    vi.restoreAllMocks();
  });

  /** Deux roues lourdes motrices au milieu, une roulette sous l'avant et une sous l'arrière. */
  const DIFF: BotProfile = (() => {
    const g = new DesignGrid().box(-1, 1, 0, 0, -2, 2, "frame").put(0, 1, 0, "cockpit");
    const wheels: WheelMount[] = [
      { x: -1, y: 0, z: 0, dx: -1, dz: 0, type: "heavy" }, { x: 1, y: 0, z: 0, dx: 1, dz: 0, type: "heavy" },
      { x: 0, y: 0, z: 2, dx: 0, dz: 0, dy: -1, type: "caster" }, { x: 0, y: 0, z: -2, dx: 0, dz: 0, dy: -1, type: "caster" },
    ];
    return { ...PRESET_BOTS[0], id: "diff", name: "Diff", speed: 4, turn: 2, design: { blocks: g.blocks(), wheels } };
  })();

  function run(bot: Bot, seconds: number, throttle: number, steer: number): void {
    for (let i = 0; i < seconds * 60; i++) {
      drive(sim, bot, throttle, steer);
      sim.step();
    }
  }

  const casters = (bot: Bot): Bot["wheels"] => bot.wheels.filter((w) => w.type === "caster");
  const turned = (a: number): number => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));

  it("des roulettes suivent le mouvement : le robot avance droit, pivote sur place, recule", () => {
    const bot = spawnBot(sim, DIFF, vec3(0, groundHeight(DIFF.design) + 0.05, 0), 0);
    run(bot, 2, 1, 0);
    const rb = bot.cockpit.part.rb;
    expect(rb.linvel().z).toBeGreaterThan(3);
    expect(Math.abs(rb.angvel().y)).toBeLessThan(0.1);
    for (const w of casters(bot)) expect(turned(w.steer)).toBeLessThan(0.2);
    // Sur place : les deux roulettes, en travers, suivent la rotation
    run(bot, 2, 0, 1);
    expect(rb.angvel().y).toBeGreaterThan(1);
    for (const w of casters(bot)) expect(Math.abs(turned(w.steer) - Math.PI / 2)).toBeLessThan(0.3);
    // En marche arrière, elles font demi-tour
    run(bot, 3, -1, 0);
    const forward = qrot(rb.rotation(), vec3(0, 0, 1));
    expect(dot(rb.linvel(), forward)).toBeLessThan(-3);
    for (const w of casters(bot)) expect(turned(w.steer)).toBeGreaterThan(Math.PI - 0.4);
  });

  it("l'IA et le joueur conduisent un robot à roulettes", () => {
    spawnWave(sim, [DIFF]);
    const ai = sim.bots[0];
    const start = ai.cockpit.part.rb.translation();
    for (let i = 0; i < 10 * 60; i++) sim.step();
    const end = ai.cockpit.part.rb.translation();
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeGreaterThan(8);
    // Le joueur : Z pour avancer, D pour tourner
    takeControl(ai, sim.input);
    sim.input.throttle = 1;
    for (let i = 0; i < 120; i++) sim.step();
    const rb = ai.cockpit.part.rb;
    expect(Math.hypot(rb.linvel().x, rb.linvel().z)).toBeGreaterThan(2.5);
    sim.input.throttle = 0;
    sim.input.steer = -1;
    for (let i = 0; i < 90; i++) sim.step();
    expect(rb.angvel().y).toBeLessThan(-0.8);
  });

  it("une chenille plus haute rehausse le robot et ne porte que sur ses galets du bas ; plus large, elle a deux fois plus de galets", () => {
    const tank = PRESET_BOTS.find((p) => p.id === "tank")!;
    const tall: RobotDesign = { ...tank.design, wheels: [...tank.design.wheels, ...tank.design.wheels.map((w) => ({ ...w, rise: -1 }))] };
    const wide: RobotDesign = { ...tank.design, wheels: [...tank.design.wheels, ...tank.design.wheels.map((w) => ({ ...w, layer: 1 }))] };
    expect(validateDesign(tall)).toEqual([]);
    expect(validateDesign(wide)).toEqual([]);
    expect(designCost(wide)).toBeGreaterThan(designCost(tank.design));
    // Côte à côte, loin des piliers du Dépôt
    const low = spawnBot(sim, tank, vec3(-6, groundHeight(tank.design) + 0.05, -10), 0);
    const high = spawnBot(sim, { ...tank, design: tall }, vec3(0, groundHeight(tall) + 0.05, -10), 0);
    const broad = spawnBot(sim, { ...tank, design: wide }, vec3(6, groundHeight(wide) + 0.05, -10), 0);
    for (let i = 0; i < 3 * 60; i++) {
      for (const bot of [low, high, broad]) drive(sim, bot, 1, 0);
      sim.step();
    }
    expect(high.cockpit.part.rb.translation().y - low.cockpit.part.rb.translation().y).toBeCloseTo(BLOCK_SIZE, 1);
    const upper = high.wheels.filter((w) => w.local.y > -0.2);
    expect(upper.every((w) => w.load === 0)).toBe(true);
    expect(high.wheels.filter((w) => w.local.y < -0.2).every((w) => w.load > 0)).toBe(true);
    for (const bot of [low, high, broad]) expect(bot.cockpit.part.rb.linvel().z).toBeGreaterThan(3);
    expect(broad.wheels.filter((w) => w.load > 0)).toHaveLength(2 * low.wheels.length);
  });
});

describe("bandes des chenilles", () => {
  const tank = PRESET_BOTS.find((p) => p.id === "tank")!.design;
  const def = WHEEL_TYPES.track;

  it("une bande par flanc ; empilés, les galets ne font qu'une bande, plus haute ou plus large", () => {
    const groups = trackGroups(tank.wheels, wheelLocalPos, def);
    expect(groups).toHaveLength(2);
    const flat = beltShape(groups[0].map(wheelLocalPos), def);
    expect(flat.hull).toHaveLength(2); // une file de galets : deux demi-tours et deux droites

    const tall = [...tank.wheels, ...tank.wheels.map((w) => ({ ...w, rise: -1 }))];
    const tallGroups = trackGroups(tall, wheelLocalPos, def);
    expect(tallGroups).toHaveLength(2);
    const box = beltShape(tallGroups[0].map(wheelLocalPos), def);
    expect(box.hull).toHaveLength(4); // un rectangle de galets
    expect(box.width).toBeCloseTo(flat.width);

    const wide = [...tank.wheels, ...tank.wheels.map((w) => ({ ...w, layer: 1 }))];
    const wideGroups = trackGroups(wide, wheelLocalPos, def);
    expect(wideGroups).toHaveLength(2);
    expect(beltShape(wideGroups[0].map(wheelLocalPos), def).width).toBeCloseTo(flat.width + def.width);
  });

  it("patins : tout autour de la bande, crampon dehors, et ils défilent le long du parcours", () => {
    const group = trackGroups(tank.wheels, wheelLocalPos, def)[0];
    const centers = group.map(wheelLocalPos);
    const shape = beltShape(centers, def);
    const loop = shoeLoop(shape);
    expect(loop.count).toBe(Math.round(loop.length / SHOE_PITCH));
    const out = new Float32Array(loop.count * 16);
    placeShoes(loop, 0, out);
    const zs = centers.map((c) => c.z);
    const [rear, front] = [Math.min(...zs), Math.max(...zs)];
    const y0 = centers[0].y;
    const at = (i: number): { z: number; y: number; nz: number; ny: number } =>
      ({ y: out[i * 16 + 13], z: out[i * 16 + 14], ny: out[i * 16 + 5], nz: out[i * 16 + 6] });
    for (let i = 0; i < loop.count; i++) {
      const p = at(i);
      // Sur le parcours : à `radius` du segment des centres (à la corde des arcs près), la normale vers le dehors
      const cz = Math.min(Math.max(p.z, rear), front);
      expect(Math.hypot(p.z - cz, p.y - y0)).toBeCloseTo(shape.radius, 2);
      expect(Math.hypot(p.nz, p.ny)).toBeCloseTo(1, 5);
      expect(p.nz * (p.z - cz) + p.ny * (p.y - y0)).toBeGreaterThan(0);
    }
    // Un patin du dessous, à mi-chemin : il regarde le sol ; faire croître le décalage l'avance vers l'avant
    const half = Math.PI * shape.radius + (front - rear) / 2;
    placeShoes(loop, half, out);
    expect(at(0).ny).toBeCloseTo(-1, 5);
    expect(at(0).z).toBeCloseTo((rear + front) / 2, 2);
    placeShoes(loop, half + 0.1, out);
    expect(at(0).z).toBeCloseTo((rear + front) / 2 + 0.1, 2);
    // Un guide par rangée de galets ; le barbotin sur le galet arrière (le plus haut, si la chenille est plus haute)
    expect(shoeHorns(shape, centers)).toEqual([0]);
    const wide = [...group, ...group.map((w) => ({ ...w, layer: 1 }))];
    const wideShape = beltShape(wide.map(wheelLocalPos), def);
    expect(shoeHorns(wideShape, wide.map(wheelLocalPos))).toEqual([-def.width / 2, def.width / 2]);
    expect(sprocketRollers(wide, wheelLocalPos)).toHaveLength(2);
    const tall = [...group, ...group.map((w) => ({ ...w, rise: -1 }))];
    const sprockets = sprocketRollers(tall, wheelLocalPos);
    expect(sprockets).toHaveLength(1);
    expect(wheelLocalPos(sprockets[0]).z).toBeCloseTo(rear);
    expect(wheelLocalPos(sprockets[0]).y).toBeCloseTo(y0);
  });
});
