import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { groundLevel } from "../src/shared/arena/layout";
import { STEP } from "../src/shared/config";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, qrot, scale, vec3, type Vec3 } from "../src/shared/math/vec";
import type { Bot } from "../src/shared/sim/entities";
import { takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * Commandes de vol à la manière de Robocraft (sim/player.ts, ai/pilot.ts) : l'avion piloté à la
 * souris va là où l'on regarde (`PlayerInput.look`), boucle quand on garde la vue vers le haut, et
 * ses gaz (`power`), à part, ne changent que sa vitesse ; le robot volant monte, descend, pivote, se
 * déplace par rapport à la caméra et, à la caméra, se tourne vers où elle regarde.
 */

let sim: Simulation | null = null;
beforeAll(async () => {
  await initPhysics();
});
afterEach(() => {
  sim?.dispose();
  sim = null;
});

/** Un robot `id` piloté, posé en `at` dans la Vallée (un avion à sa vitesse de croisière, cap au nord), commandes `setup`, stabilisé 2 s. */
function launch(id: string, at: Vec3, setup: Partial<PlayerInput> = {}): { world: Simulation; bot: Bot } {
  sim?.dispose();
  seedRandom(5);
  const world = new Simulation();
  sim = world;
  world.loadArena("valley");
  spawnWave(world, PRESET_BOTS.filter((p) => p.id === id));
  const bot = world.bots[0];
  const plane = bot.profile.mobility === "plane";
  const c = bot.cockpit.part.rb.translation();
  for (const part of bot.parts) {
    const t = part.rb.translation();
    part.rb.setTranslation({ x: t.x - c.x + at.x, y: t.y - c.y + at.y, z: t.z - c.z + at.z }, true);
    part.rb.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    part.rb.setLinvel({ x: 0, y: 0, z: plane ? bot.profile.speed : 0 }, true);
    part.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  Object.assign(world.input, { look: plane ? vec3(0, 0, 1) : null }, setup);
  takeControl(bot, world.input);
  for (let i = 0; i < 120; i++) world.step();
  return { world, bot };
}

/** Le repère du cockpit : avant, haut, gauche, et la vitesse. */
function frame(bot: Bot): { forward: Vec3; up: Vec3; left: Vec3; v: Vec3; pos: Vec3 } {
  const rb = bot.cockpit.part.rb;
  const q = rb.rotation();
  return { forward: qrot(q, vec3(0, 0, 1)), up: qrot(q, vec3(0, 1, 0)), left: qrot(q, vec3(1, 0, 0)), v: rb.linvel(), pos: rb.worldCom() };
}

const heading = (v: Vec3): number => Math.atan2(v.x, v.z);
const elevation = (v: Vec3): number => Math.atan2(v.y, Math.hypot(v.x, v.z));
const gap = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const deg = (r: number): string => `${((r * 180) / Math.PI).toFixed(0)}°`;

describe("avion piloté à la souris", () => {
  it("il va là où l'on regarde : cap et tangage vers le point visé, d'un côté comme de l'autre", () => {
    for (const [yaw, pitch] of [[1.2, 0.2], [-1.2, -0.12]] as const) {
      const { world, bot } = launch("plane", vec3(-50 * Math.sign(yaw), 60, -60), { power: 0.6 });
      // Regarder à `yaw` rad de son cap (> 0 : à gauche), `pitch` au-dessus de l'horizon
      const look = vec3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      world.input.look = look;
      for (let i = 0; i < 7 * 60 && bot.cockpit.alive; i++) world.step();
      const { v } = frame(bot);
      const label = `regard ${deg(yaw)}, ${deg(pitch)} : route ${deg(heading(v))}, pente ${deg(elevation(v))}`;
      console.log(label);
      expect(bot.cockpit.alive, label).toBe(true);
      expect(gap(heading(v), yaw), label).toBeLessThan(0.2);
      expect(Math.abs(elevation(v) - pitch), label).toBeLessThan(0.12);
    }
  });

  it("la vue gardée vers le haut, plein gaz : il boucle, passe sur le dos et revient, sans s'écraser", () => {
    const { world, bot } = launch("plane", vec3(0, 70, -90), { power: 1 });
    let pitched = 0;
    let lowest = Infinity;
    let inverted = false;
    // Le joueur continue de lever la vue : elle reste 60° au-dessus du nez, dans le plan de l'avion
    for (let i = 0; i < 14 * 60 && pitched < 2 * Math.PI && bot.cockpit.alive; i++) {
      const f = frame(bot);
      world.input.look = add(scale(f.forward, Math.cos(1.05)), scale(f.up, Math.sin(1.05)));
      world.step();
      const after = frame(bot);
      const w = bot.cockpit.part.rb.angvel();
      pitched += -(w.x * after.left.x + w.y * after.left.y + w.z * after.left.z) * STEP;
      lowest = Math.min(lowest, after.pos.y - groundLevel(world.arena, after.pos.x, after.pos.z));
      if (after.up.y < -0.5) inverted = true;
    }
    console.log(`boucle : ${deg(pitched)} de tangage, sur le dos : ${inverted}, au plus bas à ${lowest.toFixed(1)} m du sol`);
    expect(bot.cockpit.alive).toBe(true);
    expect(pitched).toBeGreaterThan(2 * Math.PI);
    expect(inverted).toBe(true);
    expect(lowest).toBeGreaterThan(10);
    // La vue revient à l'horizontale, vers le centre de la Vallée, les gaz à la croisière : il se remet à plat
    const { pos } = frame(bot);
    const back = Math.hypot(pos.x, pos.z) || 1;
    world.input.look = vec3(-pos.x / back, 0, -pos.z / back);
    world.input.power = 0.4;
    for (let i = 0; i < 6 * 60 && bot.cockpit.alive; i++) world.step();
    const end = frame(bot);
    console.log(`remis à plat : haut y ${end.up.y.toFixed(2)}, pente ${deg(elevation(end.v))}, à ${Math.hypot(end.pos.x, end.pos.z).toFixed(0)} m du centre`);
    expect(bot.cockpit.alive).toBe(true);
    expect(end.up.y).toBeGreaterThan(0.85);
    expect(Math.abs(elevation(end.v))).toBeLessThan(0.25);
  });

  it("au clavier, cabrer tenu le fait boucler aussi ; virer le fait tourner, incliné", () => {
    const loop = launch("plane", vec3(0, 70, -40), { power: 1, look: null });
    loop.world.input.climb = 1;
    let pitched = 0;
    for (let i = 0; i < 18 * 60 && pitched < 2 * Math.PI && loop.bot.cockpit.alive; i++) {
      loop.world.step();
      const f = frame(loop.bot);
      const w = loop.bot.cockpit.part.rb.angvel();
      pitched += -(w.x * f.left.x + w.y * f.left.y + w.z * f.left.z) * STEP;
    }
    console.log(`clavier, cabrer : ${deg(pitched)} de tangage`);
    expect(loop.bot.cockpit.alive).toBe(true);
    expect(pitched).toBeGreaterThan(2 * Math.PI);
    const turn = launch("plane", vec3(50, 60, -60), { power: 0.6, look: null });
    const h0 = heading(frame(turn.bot).v);
    turn.world.input.steer = 1; // à gauche
    let bank = 0;
    for (let i = 0; i < 4 * 60 && turn.bot.cockpit.alive; i++) {
      turn.world.step();
      const f = frame(turn.bot);
      bank = Math.max(bank, -Math.atan2(f.left.y, f.up.y));
    }
    const turned = Math.atan2(Math.sin(heading(frame(turn.bot).v) - h0), Math.cos(heading(frame(turn.bot).v) - h0));
    console.log(`clavier, virer à gauche : ${deg(turned)} en 4 s, incliné jusqu'à ${deg(bank)}`);
    expect(turn.bot.cockpit.alive).toBe(true);
    expect(turned).toBeGreaterThan(1);
    expect(bank).toBeGreaterThan(0.3);
  });

  // (sa trajectoire reste celle qu'il suit ; seul le nez se lève un peu au ralenti : l'aile porte moins)
  it("les gaz, à part de la direction : il accélère et ralentit sans changer de trajectoire", () => {
    const { world, bot } = launch("plane", vec3(-30, 60, -100), { power: 1 });
    let highest = -Infinity;
    let lowest = Infinity;
    let nose = { low: Infinity, high: -Infinity };
    const start = frame(bot).pos.y;
    const track = (): void => {
      world.step();
      const f = frame(bot);
      highest = Math.max(highest, elevation(f.v));
      lowest = Math.min(lowest, elevation(f.v));
      const p = Math.asin(f.forward.y);
      nose = { low: Math.min(nose.low, p), high: Math.max(nose.high, p) };
    };
    for (let i = 0; i < 4 * 60; i++) track();
    const fast = Math.hypot(frame(bot).v.x, frame(bot).v.y, frame(bot).v.z);
    world.input.power = 0.1;
    for (let i = 0; i < 5 * 60; i++) track();
    const end = frame(bot);
    const slow = Math.hypot(end.v.x, end.v.y, end.v.z);
    console.log(`gaz : ${fast.toFixed(1)} m/s plein gaz, ${slow.toFixed(1)} m/s au ralenti ; pente de ${deg(lowest)} à ${deg(highest)}, nez de ${deg(nose.low)} à ${deg(nose.high)} ; altitude ${(end.pos.y - start).toFixed(1)} m`);
    expect(fast).toBeGreaterThan(slow + 5);
    expect(highest - lowest).toBeLessThan(0.25);
    expect(nose.high - nose.low).toBeLessThan(0.35);
    expect(Math.abs(end.pos.y - start)).toBeLessThan(10);
    expect(gap(heading(end.v), 0)).toBeLessThan(0.2);
  });
});

describe("robot volant piloté", () => {
  it("il monte, descend, pivote et se déplace par rapport à la caméra", () => {
    const { world, bot } = launch("drone", vec3(0, 12, 0));
    const altitude = (): number => frame(bot).pos.y;
    const y0 = altitude();
    world.input.climb = 1;
    for (let i = 0; i < 3 * 60; i++) world.step();
    const y1 = altitude();
    world.input.climb = -1;
    for (let i = 0; i < 3 * 60; i++) world.step();
    const y2 = altitude();
    world.input.climb = 0;
    console.log(`drone : ${y0.toFixed(1)} → ${y1.toFixed(1)} → ${y2.toFixed(1)} m`);
    expect(y1).toBeGreaterThan(y0 + 3);
    expect(y2).toBeLessThan(y1 - 2);
    // Avancer : vers où regarde la caméra (cap 90° : vers +x), quel que soit son nez
    world.input.heading = Math.PI / 2;
    world.input.throttle = 1;
    const p0 = frame(bot).pos;
    for (let i = 0; i < 3 * 60; i++) world.step();
    const p1 = frame(bot).pos;
    world.input.throttle = 0;
    console.log(`drone, avancer vers +x : ${(p1.x - p0.x).toFixed(1)} m en x, ${(p1.z - p0.z).toFixed(1)} m en z`);
    expect(p1.x - p0.x).toBeGreaterThan(5);
    expect(Math.abs(p1.z - p0.z)).toBeLessThan((p1.x - p0.x) / 3);
  });

  it("à la caméra, il se tourne vers où elle regarde ; au clavier, il ne pivote qu'au lacet", () => {
    for (const relative of [true, false]) {
      const { world, bot } = launch("heli", vec3(0, 14, 0), { relative, heading: 0 });
      world.input.heading = 1.5;
      for (let i = 0; i < 3 * 60; i++) world.step();
      const nose = heading(frame(bot).forward);
      console.log(`hélicoptère, ${relative ? "à la caméra" : "au clavier"} : cap ${deg(nose)} (caméra : ${deg(1.5)})`);
      if (relative) expect(gap(nose, 1.5)).toBeLessThan(0.2);
      else expect(gap(nose, 0)).toBeLessThan(0.3);
    }
  });
});
