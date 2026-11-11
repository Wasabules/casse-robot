import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { WHEEL_TYPES } from "../src/shared/catalog/wheels";
import { applyDamage } from "../src/shared/combat/damage";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { AXES, DesignGrid, validateDesign } from "../src/shared/design/robotDesign";
import { STEP } from "../src/shared/config";
import { cross, qrot, quatFromBasis, vec3 } from "../src/shared/math/vec";
import { aeroCoefficients } from "../src/shared/robot/aero";
import { liveThrusters } from "../src/shared/robot/queries";
import type { Bot } from "../src/shared/sim/entities";
import { takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { LETHAL } from "./helpers";
import { seedRandom } from "./seed";

const DOWN = vec3(0, -1, 0);
const FAR = vec3(0, 60, 0);

describe("orientation des blocs", () => {
  it("la rotation d'un bloc envoie ses axes sur son haut et son avant", () => {
    for (const [up, forward] of [["+z", "+y"], ["+x", "+z"], ["-y", "-x"]] as const) {
      const u = AXES[up];
      const f = AXES[forward];
      const q = quatFromBasis(cross(u, f), u, f);
      const y = qrot(q, vec3(0, 1, 0));
      const z = qrot(q, vec3(0, 0, 1));
      expect([y.x, y.y, y.z].map((c) => Math.round(c) || 0)).toEqual([u.x, u.y, u.z]);
      expect([z.x, z.y, z.z].map((c) => Math.round(c) || 0)).toEqual([f.x, f.y, f.z]);
    }
  });

  it("refuse un haut et un avant qui ne sont pas perpendiculaires", () => {
    const design = { blocks: new DesignGrid().put(0, 0, 0, "cockpit").put(1, 0, 0, "wing", { up: "+y", forward: "-y" }).blocks(), wheels: [] };
    expect(validateDesign(design)).toContainEqual({ code: "badFacing", at: "1,0,0" });
  });
});

describe("aérodynamique d'une surface", () => {
  const wing = BLOCK_TYPES.wing.aero;

  it("la portance croît avec l'incidence jusqu'au décrochage, puis s'effondre", () => {
    const at = (deg: number) => aeroCoefficients(wing, (deg * Math.PI) / 180);
    expect(at(0).cl).toBe(0);
    expect(at(5).cl).toBeCloseTo(wing.liftSlope * ((5 * Math.PI) / 180), 6);
    expect(at(-5).cl).toBeLessThan(0);
    expect(at(14).cl).toBeGreaterThan(at(10).cl);
    expect(at(20).cl).toBeLessThan(at(14).cl * 0.7);
    expect(at(20).cd).toBeGreaterThan(at(10).cd * 2);
  });
});

describe("engins", () => {
  let sim: Simulation;
  const byId = (id: string): Bot => sim.bots.find((b) => b.profile.id === id)!;
  const altitude = (b: Bot): number => b.cockpit.part.rb.worldCom().y;
  const kill = (bot: Bot, ...keys: string[]): void => {
    for (const key of keys) applyDamage(sim, bot.lastPos, DOWN, LETHAL, { kind: "block", block: bot.blocks.get(key)! }, FAR);
  };

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(3);
    sim = new Simulation();
  });
  /** Ces essais portent sur le vol et la propulsion : le robot est seul, sans combat. */
  const alone = (id: string): Bot => {
    spawnWave(sim, PRESET_BOTS.filter((p) => p.id === id));
    return byId(id);
  };
  afterEach(() => {
    sim.dispose();
    vi.restoreAllMocks();
  });

  it("à la souris, l'avion piloté vire du côté où l'on regarde, et monte quand on regarde vers le haut", () => {
    // Il apparaît sur le circuit, le centre de l'arène à sa droite : on regarde à droite, vers l'intérieur
    const plane = alone("plane");
    takeControl(plane, sim.input);
    const heading = (): number => {
      const v = plane.cockpit.part.rb.linvel();
      return Math.atan2(v.x, v.z);
    };
    for (let i = 0; i < 30; i++) sim.step();
    const h0 = heading();
    // À droite du robot (-x local) : le cap diminue
    sim.input.look = vec3(Math.sin(h0 - 1.2), 0, Math.cos(h0 - 1.2));
    for (let i = 0; i < 180; i++) sim.step();
    const turned = Math.atan2(Math.sin(heading() - h0), Math.cos(heading() - h0));
    expect(turned).toBeLessThan(-0.5);
    // Vers le haut, devant lui, plein gaz
    const h1 = heading();
    sim.input.look = vec3(Math.sin(h1) * Math.cos(0.35), Math.sin(0.35), Math.cos(h1) * Math.cos(0.35));
    sim.input.power = 1;
    const y0 = altitude(plane);
    for (let i = 0; i < 150; i++) sim.step();
    expect(altitude(plane)).toBeGreaterThan(y0 + 3);
    expect(plane.cockpit.alive).toBe(true);
  });

  it("l'avion piloté qui file tout droit est ramené vers l'arène par le pilote automatique", () => {
    const plane = alone("plane");
    takeControl(plane, sim.input);
    let far = 0;
    for (let i = 0; i < 20 * 60; i++) {
      sim.step();
      const p = plane.cockpit.part.rb.worldCom();
      far = Math.max(far, Math.hypot(p.x, p.z));
    }
    expect(plane.cockpit.alive).toBe(true);
    expect(far).toBeLessThan(85);
  });

  it("l'avion vole seul : il tient son altitude et tourne autour de l'arène", () => {
    const plane = alone("plane");
    let low = Infinity;
    let high = -Infinity;
    let far = 0;
    for (let i = 0; i < 30 * 60; i++) {
      sim.step();
      const p = plane.cockpit.part.rb.worldCom();
      low = Math.min(low, p.y);
      high = Math.max(high, p.y);
      far = Math.max(far, Math.hypot(p.x, p.z));
    }
    expect(low).toBeGreaterThan(6);
    expect(high).toBeLessThan(18);
    expect(far).toBeLessThan(85);
  });

  it("sans moteur, l'avion plane et descend", () => {
    const plane = alone("plane");
    for (let i = 0; i < 60; i++) sim.step();
    kill(plane, "0,0,3");
    expect(liveThrusters(plane, "cruise")).toHaveLength(0);
    const start = altitude(plane);
    for (let i = 0; i < 5 * 60; i++) sim.step();
    expect(plane.ai.mode).toBe("gliding");
    expect(altitude(plane)).toBeLessThan(start - 2);
  });

  it("en pilotage manuel, l'avion boucle, fait des tonneaux, vire au palonnier et plane moteur coupé", () => {
    /** Vol de `seconds` s, commandes `cmd` tenues, dans la Vallée à 60 m : tours faits sur chaque axe (rad). */
    const fly = (cmd: Partial<{ climb: number; steer: number; yaw: number; power: number }>, seconds: number) => {
      const world = new Simulation();
      world.loadArena("valley");
      spawnWave(world, PRESET_BOTS.filter((p) => p.id === "plane"));
      const plane = world.bots[0];
      const c = plane.cockpit.part.rb.translation();
      for (const part of plane.parts) {
        const t = part.rb.translation();
        part.rb.setTranslation({ x: t.x - c.x, y: t.y - c.y + 60, z: t.z - c.z - 50 }, true);
        part.rb.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        part.rb.setLinvel({ x: 0, y: 0, z: 13 }, true);
        part.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      Object.assign(world.input, { manual: true, power: 0.8 });
      takeControl(plane, world.input);
      for (let i = 0; i < 60; i++) world.step();
      Object.assign(world.input, cmd);
      const rb = plane.cockpit.part.rb;
      const turn = { pitch: 0, roll: 0, yaw: 0 };
      let slowest = Infinity;
      for (let i = 0; i < seconds * 60 && plane.cockpit.alive; i++) {
        world.step();
        const q = rb.rotation();
        const w = rb.angvel();
        const about = (x: number, y: number, z: number): number => {
          const a = qrot(q, vec3(x, y, z));
          return (w.x * a.x + w.y * a.y + w.z * a.z) * STEP;
        };
        turn.pitch += about(-1, 0, 0);
        turn.roll += about(0, 0, 1);
        turn.yaw += about(0, 1, 0);
        const v = rb.linvel();
        slowest = Math.min(slowest, Math.hypot(v.x, v.y, v.z));
      }
      const result = { ...turn, slowest, alive: plane.cockpit.alive, regime: plane.cockpit.alive ? Math.max(...plane.thrusters.map((t) => t.thrust)) : 0 };
      world.dispose();
      return result;
    };
    // Manche tiré, plein gaz : une boucle entière (et plus)
    const loop = fly({ climb: 1, power: 1 }, 8);
    expect(loop.alive).toBe(true);
    expect(loop.pitch).toBeGreaterThan(2 * Math.PI);
    // Manche à droite : un tonneau
    const roll = fly({ steer: -1, power: 1 }, 4);
    expect(roll.roll).toBeGreaterThan(1.8 * Math.PI);
    // Palonnier seul, à gauche : l'avion tourne sur lui-même sans s'incliner beaucoup
    const rudder = fly({ yaw: 1, power: 0.8 }, 6);
    expect(rudder.yaw).toBeGreaterThan(0.4);
    expect(Math.abs(rudder.roll)).toBeLessThan(rudder.yaw);
    // Gaz coupés : le moteur s'arrête, l'avion plane sans décrocher
    const glide = fly({ power: 0 }, 8);
    expect(glide.alive).toBe(true);
    expect(glide.regime).toBeLessThan(3);
    expect(glide.slowest).toBeGreaterThan(10);
    // Manche lâché : l'avion garde son attitude
    const hands = fly({ power: 0.8 }, 6);
    expect(Math.abs(hands.pitch)).toBeLessThan(0.3);
    expect(Math.abs(hands.roll)).toBeLessThan(0.3);
  });

  it("l'Hexacoptère continue de voler après la perte d'un rotor", () => {
    const hexa = alone("hexa");
    sim.aiPaused = true;
    for (let i = 0; i < 120; i++) sim.step();
    kill(hexa, "4,0,0");
    sim.aiPaused = true;
    let low = Infinity;
    for (let i = 0; i < 10 * 60; i++) {
      sim.step();
      low = Math.min(low, altitude(hexa));
    }
    expect(liveThrusters(hexa, "lift")).toHaveLength(5);
    expect(low).toBeGreaterThan(2.5);
  });

  it("en fuite, la Fusée allume son propulseur et dépasse la vitesse de ses roues", () => {
    const rocket = alone("rocket");
    for (let i = 0; i < 120; i++) sim.step();
    // Touchée de derrière : elle fuit droit devant
    const back = rocket.cockpit.part.rb.worldCom();
    const facing = qrot(rocket.cockpit.part.rb.rotation(), vec3(0, 0, 1));
    kill(rocket, "1,1,2");
    rocket.ai.target = vec3(back.x + facing.x * 30, 0, back.z + facing.z * 30);
    let top = 0;
    for (let i = 0; i < 4 * 60; i++) {
      sim.step();
      const v = rocket.cockpit.part.rb.linvel();
      top = Math.max(top, Math.hypot(v.x, v.z));
    }
    const wheel = WHEEL_TYPES.standard;
    expect(top).toBeGreaterThan(wheel.freeSpeed * wheel.radius);
  });
});
