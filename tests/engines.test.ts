import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ARENAS } from "../src/shared/arena/layout";
import { blockDef, BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { cruiseSpeed, inferMobility } from "../src/shared/design/custom";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { DesignGrid } from "../src/shared/design/robotDesign";
import { clamp } from "../src/shared/math/scalar";
import { dot, qrot, vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { propellerFactor } from "../src/shared/robot/propulsion";
import type { Bot } from "../src/shared/sim/entities";
import { takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

describe("hélices et turboréacteurs (plans)", () => {
  it("une hélice perd sa poussée avec la vitesse, un turboréacteur non", () => {
    const top = BLOCK_TYPES.propeller.thruster.topSpeed;
    expect(propellerFactor(top, 0)).toBe(1);
    expect(propellerFactor(top, top / 2)).toBeCloseTo(0.5, 6);
    expect(propellerFactor(top, top * 2)).toBe(0);
    expect(blockDef("jet").thruster?.topSpeed).toBeUndefined();
    expect(BLOCK_TYPES.jet.thruster.maxThrust).toBeGreaterThan(4 * BLOCK_TYPES.engine.thruster.maxThrust);
  });

  it("un turboréacteur tourné vers le haut fait décoller à la verticale ; vers l'avant avec des ailes, c'est un avion", () => {
    const vtol = new DesignGrid().put(0, 0, 0, "cockpit").put(1, 0, 0, "jet").put(-1, 0, 0, "jet");
    expect(inferMobility({ blocks: vtol.blocks(), wheels: [] })).toBe("hover");
    const plane = PRESET_BOTS.find((p) => p.id === "fighter")!.design;
    expect(inferMobility(plane)).toBe("plane");
    // Un avion du garage vole d'autant plus vite qu'il pousse fort : l'Avion (hélice) moins vite que le Chasseur (turboréacteurs)
    const propPlane = PRESET_BOTS.find((p) => p.id === "plane")!.design;
    expect(cruiseSpeed(propPlane, "plane")).toBeGreaterThan(10);
    expect(cruiseSpeed(plane, "plane")).toBeGreaterThan(cruiseSpeed(propPlane, "plane") + 4);
  });
});

describe("hélices et turboréacteurs (en vol, au sol)", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(4);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  const alone = (id: string): Bot => {
    spawnWave(sim, PRESET_BOTS.filter((p) => p.id === id));
    return sim.bots[0];
  };
  const speedOf = (bot: Bot): number => {
    const v = bot.cockpit.part.rb.linvel();
    return Math.hypot(v.x, v.z);
  };

  it("le Chasseur vole seul, vite, en tenant son altitude", () => {
    const fighter = alone("fighter");
    let low = Infinity;
    let fast = 0;
    for (let i = 0; i < 30 * 60; i++) {
      sim.step();
      low = Math.min(low, fighter.cockpit.part.rb.worldCom().y);
      if (i > 10 * 60) fast = Math.max(fast, speedOf(fighter));
    }
    expect(fighter.cockpit.alive).toBe(true);
    expect(low).toBeGreaterThan(5);
    expect(fast).toBeGreaterThan(15);
  });

  it("au sprint, les turboréacteurs du Bolide l'emmènent bien plus vite que ses roues", () => {
    const bolide = alone("dragster");
    sim.aiPaused = true;
    for (let i = 0; i < 60; i++) sim.step();
    takeControl(bolide, sim.input);
    sim.input.throttle = 1;
    let wheels = 0;
    for (let i = 0; i < 90; i++) {
      sim.step();
      wheels = Math.max(wheels, speedOf(bolide));
    }
    sim.input.boost = true;
    let jets = 0;
    for (let i = 0; i < 90; i++) {
      sim.step();
      jets = Math.max(jets, speedOf(bolide));
    }
    expect(wheels).toBeLessThan(9);
    expect(jets).toBeGreaterThan(wheels + 8);
  });
});

/*
 * Le Bolide : ses turboréacteurs (24 kg) sont une case derrière le châssis, pour que l'entrée d'air
 * de leur nacelle n'y entre pas ; la seconde rangée de son étrave fait contrepoids. Il doit se
 * conduire au moins aussi bien qu'avec ses réacteurs contre le châssis. Mesuré (avant → après) :
 * l'avant porte 39,2 → 40,2 % du poids à l'arrêt ; lancé au sprint, ses roues avant quittaient le
 * sol deux pas de suite, plus du tout (au moins 10 % du poids sur elles), le nez se levant de
 * 0,21 → 0,22° en 2 s ; 26,5 → 24,7 m/s au bout de 2 s de sprint (il pèse 100 → 109 kg) ; 5,6 m/s
 * sans sprint, et 106° de virage en 3 s, braquage à fond, dans les deux cas.
 */
describe("le Bolide : réacteurs reculés, étrave en contrepoids", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(3);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  /** Seul sur le sol plat du Dépôt, sans son décor (la place de lancer le sprint), posé, aux commandes du joueur. */
  const piloted = (): Bot => {
    const profile = PRESET_BOTS.find((p) => p.id === "dragster")!;
    sim.combat = false;
    sim.loadArena({ ...ARENAS.depot, boxes: [], props: [], zones: [] });
    const bot = spawnBot(sim, profile, vec3(0, groundHeight(profile.design) + 0.03, -150), 0);
    sim.bots.push(bot);
    takeControl(bot, sim.input);
    for (let i = 0; i < 2 * 60; i++) sim.step();
    return bot;
  };
  const nose = (bot: Bot) => qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
  const forwardSpeed = (bot: Bot): number => dot(bot.cockpit.part.rb.linvel(), nose(bot));
  /** Tangage (rad, > 0 : nez levé) et cap (rad). */
  const pitch = (bot: Bot): number => Math.asin(clamp(nose(bot).y, -1, 1));
  const heading = (bot: Bot): number => Math.atan2(nose(bot).x, nose(bot).z);
  /** Part du poids sur les roues avant (null : aucune ne touche le sol). */
  const frontShare = (bot: Bot): number | null => {
    const all = bot.wheels.reduce((s, w) => s + w.load, 0);
    return all > 0 ? bot.wheels.reduce((s, w) => s + (w.local.z > 0 ? w.load : 0), 0) / all : null;
  };

  it("l'avant porte autant à l'arrêt, ne se lève pas en partant au sprint, et il file", () => {
    const bot = piloted();
    let rest = 0;
    for (let i = 0; i < 30; i++) {
      sim.step();
      rest += frontShare(bot)! / 30;
    }
    const level = pitch(bot);
    sim.input.throttle = 1;
    sim.input.boost = true;
    let lift = 0;
    let lightest = 1;
    for (let i = 0; i < 2 * 60; i++) {
      sim.step();
      lift = Math.max(lift, pitch(bot) - level);
      lightest = Math.min(lightest, frontShare(bot) ?? 0);
    }
    expect(rest).toBeGreaterThan(0.39);
    // Les roues avant restent au sol (avant : elles le quittaient un instant) ; le nez se lève à peine
    expect(lightest).toBeGreaterThan(0.05);
    expect(lift).toBeLessThan(0.02);
    expect(forwardSpeed(bot)).toBeGreaterThan(22);
  });

  it("sans sprint, il braque : plus d'un quart de tour en 3 s, sans pencher", () => {
    const bot = piloted();
    sim.input.throttle = 1;
    for (let i = 0; i < 4 * 60; i++) sim.step();
    expect(forwardSpeed(bot)).toBeGreaterThan(5);
    sim.input.steer = 1;
    let turned = 0;
    let last = heading(bot);
    let upright = 1;
    for (let i = 0; i < 3 * 60; i++) {
      sim.step();
      const h = heading(bot);
      turned += Math.atan2(Math.sin(h - last), Math.cos(h - last));
      last = h;
      upright = Math.min(upright, qrot(bot.cockpit.part.rb.rotation(), vec3(0, 1, 0)).y);
    }
    expect(turned).toBeGreaterThan(1.6);
    expect(upright).toBeGreaterThan(0.95);
  });
});
