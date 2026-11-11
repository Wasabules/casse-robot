import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { applyDamage, explode } from "../src/shared/combat/damage";
import { spawnProjectile } from "../src/shared/combat/projectiles";
import { repairNeed } from "../src/shared/combat/repair";
import { liveTurrets } from "../src/shared/combat/turrets";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, qrot, scale, vec3, type Vec3 } from "../src/shared/math/vec";
import { blockWorldPos } from "../src/shared/robot/queries";
import type { Barrier, Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { newInput, takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams, spawnWave } from "../src/shared/sim/wave";
import { LETHAL } from "./helpers";
import { seedRandom } from "./seed";

const profile = (id: string) => PRESET_BOTS.find((p) => p.id === id)!;
const DOWN = vec3(0, -1, 0);

describe("armes de soutien", () => {
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

  const byId = (id: string): Bot => sim.bots.find((b) => b.profile.id === id)!;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  /** Détruit un bloc précis, comme un tir direct. */
  const destroy = (bot: Bot, key: string): void => {
    const block = bot.blocks.get(key);
    if (!block) throw new Error(`pas de bloc en ${key}`);
    applyDamage(sim, bot.lastPos, DOWN, LETHAL, { kind: "block", block }, add(bot.lastPos, vec3(0, 30, 0)));
  };

  it("le module de réparation fait repousser les blocs détruits, une tourelle avec ses munitions", () => {
    spawnWave(sim, [profile("guardian")]);
    sim.aiPaused = true;
    run(0.5);
    const bot = byId("guardian");
    const turret = bot.turrets.find((t) => t.weapon === "barrier")!;
    turret.arm.cooldown = 7; // un tir récent : il repousse sans rien regagner
    destroy(bot, "2,1,-2");
    destroy(bot, "0,2,1"); // le projecteur de bouclier
    expect(bot.lost.has("2,1,-2") && bot.lost.has("0,2,1")).toBe(true);
    expect(liveTurrets(bot).some((t) => t.weapon === "barrier")).toBe(false);
    run(6);
    for (const key of ["2,1,-2", "0,2,1"]) {
      const block = bot.blocks.get(key)!;
      expect(block?.alive, key).toBe(true);
      expect(block.part).toBe(bot.cockpit.part);
      expect(bot.lost.has(key)).toBe(false);
    }
    expect(events.filter((e) => e.type === "blockRebuilt")).toHaveLength(2);
    expect(liveTurrets(bot)).toContain(turret);
    expect(turret.arm.cooldown).toBeGreaterThan(0);
    // Les colliders ont suivi : un tir sur le bloc revenu le touche
    const hit = sim.raycast(add(blockWorldPos(bot.blocks.get("2,1,-2")!), vec3(0, 3, 0)), DOWN, 5, null);
    expect(hit?.point.y).toBeGreaterThan(blockWorldPos(bot.blocks.get("2,1,-2")!).y);
  });

  it("le rayon réparateur vole la vie d'un ennemi : il soigne son tireur", () => {
    spawnTeams(sim, [{ profile: profile("mechanic"), team: "blue" }, { profile: profile("ram"), team: "red" }]);
    sim.aiPaused = true;
    run(0.5);
    const [mechanic, ram] = [byId("mechanic"), byId("ram")];
    for (const b of mechanic.blocks.values()) if (b !== mechanic.cockpit) b.hp = BLOCK_TYPES[b.type].hp / 2;
    mechanic.lastHit = sim.time + 10; // son module de réparation attend : seul le vol de vie le soigne
    const [mechanicBefore, ramBefore] = [repairNeed(mechanic), repairNeed(ram)];
    const aim = blockWorldPos([...ram.blocks.values()].find((b) => b !== ram.cockpit && b.y === 2)!);
    for (let i = 0; i < 20; i++) spawnProjectile(sim, "repair", add(aim, vec3(0, 3, 0)), DOWN, { shooter: mechanic });
    run(0.2);
    const drained = repairNeed(ram) - ramBefore;
    expect(drained).toBeGreaterThan(60);
    expect(mechanicBefore - repairNeed(mechanic)).toBeCloseTo(drained * (WEAPONS.repair.projectile.repair.steal ?? 0), 0);
  });

  it("les nanites d'un robot piloté soignent seules un allié et font repousser ses blocs, sans qu'il vise", () => {
    spawnTeams(sim, [
      { profile: profile("angel"), team: "blue" }, { profile: profile("tank"), team: "blue" }, { profile: profile("ram"), team: "red" },
    ]);
    const [angel, tank, ram] = [byId("angel"), byId("tank"), byId("ram")];
    takeControl(angel, newInput()); // le joueur ne vise ni n'appuie
    takeControl(tank, newInput());
    takeControl(ram, newInput());
    run(1);
    for (const key of ["2,1,-4", "-2,1,-4", "2,1,3"]) destroy(tank, key);
    for (const b of tank.blocks.values()) if (b !== tank.cockpit) b.hp = BLOCK_TYPES[b.type].hp / 2;
    const before = repairNeed(tank);
    run(10);
    expect(events.some((e) => e.type === "shot" && e.weapon === "nanites")).toBe(true);
    expect(repairNeed(tank)).toBeLessThan(before - 1000);
    expect(["2,1,-4", "-2,1,-4", "2,1,3"].filter((key) => tank.blocks.get(key)?.alive).length).toBeGreaterThan(0);
  });

  it("un mur d'énergie arrête les tirs et le souffle des ennemis, pas ceux de son équipe", () => {
    spawnTeams(sim, [{ profile: profile("guardian"), team: "blue" }, { profile: profile("ram"), team: "red" }]);
    sim.aiPaused = true;
    run(0.5);
    const [guardian, ram] = [byId("guardian"), byId("ram")];
    // Le Gardien déploie son mur : à quelques mètres devant sa tourelle, face à lui
    const turret = guardian.turrets.find((t) => t.weapon === "barrier")!;
    const forward = qrot(guardian.cockpit.part.rb.rotation(), vec3(0, 0, 1));
    const muzzle = add(blockWorldPos(turret.block), vec3(0, 0.3, 0));
    spawnProjectile(sim, "barrier", muzzle, forward, { shooter: guardian });
    run(0.5);
    expect(sim.barriers).toHaveLength(1);
    const wall: Barrier = sim.barriers[0];
    expect(wall.team).toBe("blue");
    const ahead = Math.hypot(wall.center.x - muzzle.x, wall.center.z - muzzle.z);
    expect(ahead).toBeGreaterThan(3);
    expect(ahead).toBeLessThan(7);

    // Un tir ennemi, de l'autre côté : il s'écrase sur le mur
    const far = add(wall.center, scale(forward, 12));
    const back = scale(forward, -1);
    const full = wall.hp;
    spawnProjectile(sim, "rifle", far, back, { shooter: ram });
    run(0.3);
    expect(wall.hp).toBeCloseTo(full - WEAPONS.rifle.projectile.damage, 3);
    // Un tir allié le traverse
    spawnProjectile(sim, "rifle", add(wall.center, scale(forward, -3)), forward, { shooter: guardian });
    run(0.3);
    expect(wall.hp).toBeCloseTo(full - WEAPONS.rifle.projectile.damage, 3);

    // Une explosion ennemie juste devant le mur n'atteint pas ce qui est derrière
    const behind = [...guardian.blocks.values()].reduce((a, b) => (dist(blockWorldPos(b), wall.center) < dist(blockWorldPos(a), wall.center) ? b : a));
    const gap = dist(blockWorldPos(behind), wall.center);
    const blast = { ...WEAPONS.cannon.projectile.explosion, radius: gap + 2, damage: 400 };
    const hp = behind.hp;
    explode(sim, add(wall.center, scale(forward, 0.5)), blast, back, far, ram);
    expect(behind.hp).toBe(hp);

    // Il s'éteint au bout de sa durée
    run(WEAPONS.barrier.projectile.barrier.life);
    expect(sim.barriers).toHaveLength(0);
    expect(events.some((e) => e.type === "barrierRemoved" && !e.broken)).toBe(true);
  });

  it("l'IA déploie son mur quand on lui tire dessus", () => {
    spawnTeams(sim, [{ profile: profile("guardian"), team: "blue" }, { profile: profile("tank"), team: "red" }]);
    let deployed = false;
    for (let i = 0; i < 30 * 60 && !deployed; i++) {
      sim.step();
      deployed = sim.barriers.some((b) => b.team === "blue");
    }
    expect(deployed).toBe(true);
  });
});

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
