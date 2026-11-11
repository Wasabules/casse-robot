import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { flareCapacity, launchFlares } from "../src/shared/combat/decoys";
import { explode } from "../src/shared/combat/damage";
import { sphereHit } from "../src/shared/combat/interception";
import { spawnProjectile } from "../src/shared/combat/projectiles";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, distance, norm, sub, vec3 } from "../src/shared/math/vec";
import type { Bot, Projectile } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

describe("interception (calcul)", () => {
  it("un rayon entre dans une sphère à la bonne distance, ou la manque", () => {
    expect(sphereHit(vec3(0, 0, 0), vec3(0, 0, 1), vec3(0, 0, 10), 1)).toBeCloseTo(9, 6);
    expect(sphereHit(vec3(0, 0, 0), vec3(0, 0, 1), vec3(0, 1.5, 10), 1)).toBeNull();
    expect(sphereHit(vec3(0, 0, 0), vec3(0, 0, 1), vec3(0, 0, -10), 1)).toBeNull(); // derrière
    expect(sphereHit(vec3(0, 0, 10), vec3(0, 0, 1), vec3(0, 0, 10), 1)).toBe(0); // part de dedans
  });
});

describe("leurres et missiles abattus", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(7);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const only = (...ids: string[]): void => spawnWave(sim, PRESET_BOTS.filter((p) => ids.includes(p.id)));
  const byId = (id: string): Bot => sim.bots.find((b) => b.profile.id === id)!;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  const hitBy = (bot: Bot, weapon: string): boolean => events.some((e) => e.type === "hit" && e.victim === bot && e.cause === weapon);
  /** Un missile de la caméra libre (ennemie de tous), tiré de `range` m sur le robot. */
  const missileAt = (bot: Bot, weapon: "lockon" | "missile", range: number): Projectile => {
    const target = bot.cockpit.part.rb.worldCom();
    const origin = add(target, vec3(range, 6, 0));
    return spawnProjectile(sim, weapon, origin, norm(sub(target, origin)), { shooter: null, homing: weapon === "lockon" ? bot : null });
  };

  it("un lance-leurres éjecte une salve par charge, pas plus vite qu'une toutes les 1,5 s, et se recharge", () => {
    only("tank");
    sim.aiPaused = true;
    run(0.5);
    const tank = byId("tank");
    const { charges, reload } = BLOCK_TYPES.flareLauncher.flares;
    expect(flareCapacity(tank)).toBe(charges);
    expect(tank.flares.charges).toBe(charges);
    expect(launchFlares(sim, tank)).toBe(true);
    expect(sim.projectiles.filter((p) => p.weapon === "flare")).toHaveLength(WEAPONS.flare.projectile.pellets.count);
    expect(launchFlares(sim, tank)).toBe(false); // trop tôt
    run(1.6);
    expect(launchFlares(sim, tank)).toBe(true);
    expect(tank.flares.charges).toBe(charges - 2);
    run(reload + 0.5);
    expect(tank.flares.charges).toBe(charges - 1);
  });

  it("un missile à tête chercheuse suit les leurres au lieu de sa cible", () => {
    only("tank");
    sim.aiPaused = true;
    run(0.5);
    const tank = byId("tank");
    const missile = missileAt(tank, "lockon", 35);
    run(0.3);
    launchFlares(sim, tank);
    run(4);
    expect(missile.decoy !== null || missile.lost).toBe(true);
    expect(hitBy(tank, "lockon")).toBe(false);
  });

  it("sans leurres, le même missile touche", () => {
    only("tank");
    sim.aiPaused = true;
    run(0.5);
    const tank = byId("tank");
    missileAt(tank, "lockon", 35);
    run(4);
    expect(hitBy(tank, "lockon")).toBe(true);
  });

  it("des missiles téléguidés peuvent aussi être détournés par les leurres (moins souvent)", () => {
    only("tank");
    sim.aiPaused = true;
    run(0.5);
    const tank = byId("tank");
    sim.playerAim = tank.cockpit.part.rb.worldCom();
    // Une salve détourne un téléguidé 40 fois sur 100 : sur six, au moins un
    const missiles = [26, 30, 34, 38, 42, 46].map((range) => missileAt(tank, "missile", range));
    run(0.2);
    launchFlares(sim, tank);
    run(1.6);
    launchFlares(sim, tank);
    run(3);
    expect(missiles.some((m) => m.decoy !== null || m.lost)).toBe(true);
  });

  it("des balles abattent un missile en vol : il éclate là où il est", () => {
    only("tank");
    sim.aiPaused = true;
    run(0.5);
    const missile = spawnProjectile(sim, "missile", vec3(0, 12, -30), vec3(0, 0, 1), { shooter: null });
    run(0.3);
    // Une rafale droit sur lui, de côté
    for (let i = 0; i < 4; i++) {
      const lead = add(missile.pos, vec3(0, 0, WEAPONS.missile.projectile.speed * (8 / WEAPONS.rifle.projectile.speed)));
      const from = add(lead, vec3(-8, 0, 0));
      spawnProjectile(sim, "rifle", from, norm(sub(lead, from)), { shooter: byId("tank"), spread: 0 });
      sim.step();
    }
    run(0.3);
    expect(missile.done).toBe(true);
    expect(events.some((e) => e.type === "impact" && e.surface === "projectile")).toBe(true);
    const blast = events.find((e) => e.type === "explosion");
    expect(blast?.type === "explosion" && blast.point.y).toBeGreaterThan(8); // en l'air
  });

  it("l'ogive pilotée est une grosse cible : une balle qui passe à 0,5 m la touche", () => {
    only();
    const warhead = spawnProjectile(sim, "warhead", vec3(0, 15, 0), vec3(0, 0, 1), { shooter: null });
    run(0.1);
    // La balle met 10 / 160 s à arriver : on vise là où l'ogive sera, 0,5 m au-dessus de son axe
    const flight = 10 / WEAPONS.rifle.projectile.speed;
    const aim = add(warhead.pos, vec3(0, 0.5, WEAPONS.warhead.projectile.speed * flight));
    const from = add(aim, vec3(-10, 0, 0));
    spawnProjectile(sim, "rifle", from, norm(sub(aim, from)), { shooter: null, spread: 0 });
    run(0.15);
    expect(warhead.hp).toBeLessThan(WEAPONS.warhead.projectile.hull.hp);
  });

  it("une explosion proche détruit un missile en vol", () => {
    only();
    const missile = spawnProjectile(sim, "missile", vec3(0, 12, 0), vec3(0, 0, 1), { shooter: null });
    sim.step();
    explode(sim, add(missile.pos, vec3(0.8, 0, 0)), WEAPONS.cannon.projectile.explosion, vec3(0, -1, 0), vec3(0, 12, -10));
    run(0.1);
    expect(missile.done).toBe(true);
  });

  it("on fait sauter une mine posée en lui tirant dessus", () => {
    only();
    const mine = spawnProjectile(sim, "mine", vec3(0, 1, 20), vec3(0, -1, 0), { shooter: null });
    run(1);
    expect(mine.landed).toBe(true);
    for (let i = 0; i < 3 && !mine.done; i++) {
      const from = add(mine.pos, vec3(-6, 1.5, 0));
      spawnProjectile(sim, "rifle", from, norm(sub(mine.pos, from)), { shooter: null, spread: 0 });
      run(0.2);
    }
    expect(mine.done).toBe(true);
    expect(events.some((e) => e.type === "explosion" && distance(e.point, mine.pos) < 1)).toBe(true);
  });

  it("l'IA lance ses leurres quand un missile arrive sur elle", () => {
    only("tank");
    run(0.5);
    const tank = byId("tank");
    missileAt(tank, "lockon", 45);
    run(1.5);
    expect(tank.flares.charges).toBeLessThan(3);
    expect(sim.projectiles.some((p) => p.weapon === "flare") || events.some((e) => e.type === "shot" && e.weapon === "flare")).toBe(true);
  });

  it("une tourelle de l'IA tire sur le missile qui fonce sur son robot", () => {
    only("buggy");
    run(0.5);
    const buggy = byId("buggy");
    const missile = missileAt(buggy, "lockon", 60);
    run(4);
    expect(events.some((e) => e.type === "impact" && e.surface === "projectile")).toBe(true);
    expect(missile.done).toBe(true);
  });
});
