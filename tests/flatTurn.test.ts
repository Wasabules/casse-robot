import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { groundLevel } from "../src/shared/arena/layout";
import { STEP } from "../src/shared/config";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { qrot, vec3 } from "../src/shared/math/vec";
import type { Bot } from "../src/shared/sim/entities";
import { takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * Lacet piloté, indépendant du roulis (les touches du lacet, `PlayerInput.yaw`) : l'avion vire à plat au
 * palonnier sans glisser de côté ; le drone, l'hélicoptère et l'hexacoptère pivotent sur place, à plat.
 */

interface Flight {
  /** Cap gagné (rad, > 0 : à gauche), inclinaison la plus forte (rad), dérapage horizontal le plus fort (angle entre la vitesse et le nez, vus d'en haut, rad). */
  heading: number;
  bank: number;
  slip: number;
  /** Altitude gagnée (m), déplacement horizontal (m), plus forte inclinaison du haut du robot (rad). */
  climb: number;
  drift: number;
  tilt: number;
  /** Vitesse de lacet à la fin (rad/s). */
  spin: number;
  alive: boolean;
}

let sim: Simulation | null = null;
beforeAll(async () => {
  await initPhysics();
});
afterEach(() => {
  sim?.dispose();
  sim = null;
});

/**
 * Un robot `id` piloté, posé en l'air dans la Vallée et stabilisé ; `setup` règle ses commandes,
 * puis `cmd` est tenue `seconds` s, puis relâchée `after` s.
 */
function fly(id: string, setup: Partial<PlayerInput>, cmd: Partial<PlayerInput>, seconds: number, after = 0): Flight {
  sim?.dispose();
  seedRandom(3);
  const world = new Simulation();
  sim = world;
  world.loadArena("valley");
  spawnWave(world, PRESET_BOTS.filter((p) => p.id === id));
  const bot: Bot = world.bots[0];
  const plane = bot.profile.mobility === "plane";
  const c = bot.cockpit.part.rb.translation();
  for (const part of bot.parts) {
    const t = part.rb.translation();
    // (un avion part du côté opposé à son virage et vire vers le centre de la Vallée : à sa vitesse,
    // près de la limite de l'arène, le pilote automatique le ramènerait)
    const side = plane ? -60 * Math.sign(cmd.yaw ?? 0) : 0;
    part.rb.setTranslation({ x: t.x - c.x + side, y: t.y - c.y + (plane ? 60 : 20), z: t.z - c.z - (plane ? 90 : 50) }, true);
    part.rb.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    part.rb.setLinvel({ x: 0, y: 0, z: plane ? bot.profile.speed : 0 }, true);
    part.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  Object.assign(world.input, setup);
  takeControl(bot, world.input);
  for (let i = 0; i < 300; i++) world.step();
  // Un robot volant part immobile en lacet (le décollage l'a fait tourner un peu : ce n'est pas ce qu'on
  // mesure) ; l'avion du pilote automatique (au-delà de sa limite) vise l'altitude où il est
  if (!plane) bot.cockpit.part.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  const here = bot.cockpit.part.rb.worldCom();
  if (plane) bot.ai.alt = here.y - groundLevel(world.arena, here.x, here.z);
  const out: Flight = { heading: 0, bank: 0, slip: 0, climb: 0, drift: 0, tilt: 0, spin: 0, alive: true };
  const start = bot.cockpit.part.rb.worldCom();
  let end = start;
  Object.assign(world.input, cmd);
  for (let i = 0; i < (seconds + after) * 60 && bot.cockpit.alive; i++) {
    if (i === seconds * 60) world.input.yaw = 0;
    world.step();
    // (le corps se relit à chaque pas : un robot qui se brise en libère)
    if (!bot.cockpit.alive) break;
    const rb = bot.cockpit.part.rb;
    end = rb.worldCom();
    const q = rb.rotation();
    const w = rb.angvel();
    out.heading += w.y * STEP;
    out.spin = w.y;
    const left = qrot(q, vec3(1, 0, 0));
    const up = qrot(q, vec3(0, 1, 0));
    const forward = qrot(q, vec3(0, 0, 1));
    out.bank = Math.max(out.bank, Math.abs(Math.asin(Math.max(-1, Math.min(1, left.y)))));
    out.tilt = Math.max(out.tilt, Math.acos(Math.max(-1, Math.min(1, up.y))));
    const v = rb.linvel();
    const flat = Math.hypot(v.x, v.z);
    const nose = Math.hypot(forward.x, forward.z);
    if (plane && flat > 3 && nose > 0.3) out.slip = Math.max(out.slip, Math.acos(Math.max(-1, Math.min(1, (v.x * forward.x + v.z * forward.z) / (flat * nose)))));
  }
  out.climb = end.y - start.y;
  out.drift = Math.hypot(end.x - start.x, end.z - start.z);
  out.alive = bot.cockpit.alive;
  return out;
}

const deg = (r: number): number => (r * 180) / Math.PI;

describe("lacet piloté, indépendant du roulis", () => {
  // (à la souris, sans regard pendant qu'on tient le lacet : l'avion garde sa route ; un peu plus vite que sa croisière)
  it("l'avion à la souris vire à plat au palonnier, ailes à l'horizontale, sans glisser de côté", () => {
    for (const [id, yaw] of [["plane", 1], ["plane", -1], ["bomber", 1], ["fighter", 1]] as const) {
      // (le Chasseur à sa croisière : ses turboréacteurs, lents à ralentir, le lanceraient vers la limite de la Vallée)
      const f = fly(id, { power: id === "fighter" ? 0.4 : 0.6 }, { yaw }, 4);
      const label = `${id} ${yaw > 0 ? "A" : "E"} : cap ${deg(f.heading).toFixed(0)}°, inclinaison ${deg(f.bank).toFixed(0)}°, dérapage ${deg(f.slip).toFixed(0)}°, altitude ${f.climb.toFixed(1)} m`;
      console.log(label);
      expect(f.alive, label).toBe(true);
      expect(f.heading * yaw, label).toBeGreaterThan((60 * Math.PI) / 180);
      expect(f.bank, label).toBeLessThan((15 * Math.PI) / 180);
      expect(f.slip, label).toBeLessThan((15 * Math.PI) / 180);
      expect(Math.abs(f.climb), label).toBeLessThan(8);
    }
  });

  // (rien ne bouge : la vue reste droit devant)
  it("sans palonnier, rien ne change : l'avion à la souris file droit", () => {
    const f = fly("plane", { look: vec3(0, 0, 1) }, {}, 4);
    console.log(`souris, rien : cap ${deg(f.heading).toFixed(0)}°, altitude ${f.climb.toFixed(1)} m`);
    expect(Math.abs(f.heading)).toBeLessThan((10 * Math.PI) / 180);
  });

  // (en manuel, l'altitude est l'affaire du pilote : le virage à plat fait baisser le nez, à lui de le tenir)
  it("en pilotage manuel, le palonnier fait virer l'avion sans qu'il glisse de côté", () => {
    const f = fly("plane", { manual: true, power: 0.8 }, { yaw: 1 }, 4);
    console.log(`manuel A : cap ${deg(f.heading).toFixed(0)}°, inclinaison ${deg(f.bank).toFixed(0)}°, dérapage ${deg(f.slip).toFixed(0)}°, altitude ${f.climb.toFixed(1)} m`);
    expect(f.alive).toBe(true);
    expect(f.heading).toBeGreaterThan((45 * Math.PI) / 180);
    expect(f.slip).toBeLessThan((25 * Math.PI) / 180);
  });

  it("drone, hélicoptère, hexacoptère pivotent sur place, à plat, et s'arrêtent de tourner quand on lâche", () => {
    for (const [id, yaw] of [["drone", 1], ["heli", 1], ["heli", -1], ["hexa", 1]] as const) {
      const f = fly(id, {}, { yaw }, 2.5, 1.5);
      const label = `${id} ${yaw > 0 ? "A" : "E"} : cap ${deg(f.heading).toFixed(0)}°, assiette ${deg(f.tilt).toFixed(0)}°, déplacement ${f.drift.toFixed(1)} m, lacet final ${f.spin.toFixed(2)} rad/s`;
      console.log(label);
      expect(f.heading * yaw, label).toBeGreaterThan(Math.PI * 0.75);
      expect(f.tilt, label).toBeLessThan((15 * Math.PI) / 180);
      expect(f.drift, label).toBeLessThan(3);
      expect(Math.abs(f.climb), label).toBeLessThan(4);
      expect(Math.abs(f.spin), label).toBeLessThan(0.25);
    }
  });
});
