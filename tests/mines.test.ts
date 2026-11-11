import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { avoidMines } from "../src/shared/ai/navigation";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { isWeaponId, weaponDef, WEAPONS, WEAPON_IDS, type WeaponId } from "../src/shared/catalog/weapons";
import { explode } from "../src/shared/combat/damage";
import { spawnProjectile } from "../src/shared/combat/projectiles";
import { repairNeed } from "../src/shared/combat/repair";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, distance, vec3, type Vec3 } from "../src/shared/math/vec";
import { blockWorldPos } from "../src/shared/robot/queries";
import type { Bot, Projectile } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { newInput, takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams, spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

const profile = (id: string) => PRESET_BOTS.find((p) => p.id === id)!;

describe("catalogue des mines", () => {
  it("une mine qui lance un projectile lance une arme du catalogue", () => {
    for (const id of WEAPON_IDS) {
      const action = weaponDef(id).projectile.mine?.action;
      if (action?.kind === "launch") expect(isWeaponId(action.weapon), id).toBe(true);
    }
  });
});

describe("mines et réparation", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(5);
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
  const count = (type: SimEvent["type"]): number => events.filter((e) => e.type === type).length;
  /** Une mine lâchée à `offset` du cockpit d'un robot immobile (la caméra libre, ennemie de tous, la pose). */
  const dropBeside = (bot: Bot, weapon: WeaponId, offset: Vec3, shooter: Bot | null = null): Projectile => {
    const at = add(add(bot.cockpit.part.rb.worldCom(), offset), vec3(0, 1.5, 0));
    return spawnProjectile(sim, weapon, at, vec3(0, -1, 0), { shooter });
  };
  const landing = (p: Projectile): void => {
    for (let i = 0; i < 120 && !p.landed; i++) sim.step();
    expect(p.landed).toBe(true);
  };

  it("une mine IEM paralyse le robot qui passe dessus, sans rien détruire", () => {
    only("ram");
    sim.aiPaused = true;
    run(0.5);
    const ram = byId("ram");
    const mine = dropBeside(ram, "empMine", vec3(2.6, 0, 0));
    landing(mine);
    run(WEAPONS.empMine.projectile.mine.armDelay + 0.5);
    expect(sim.projectiles.includes(mine)).toBe(false);
    expect(events.some((e) => e.type === "stunned" && e.bot === ram)).toBe(true);
    expect(count("explosion")).toBe(0);
  });

  it("une mine incendiaire embrase les blocs autour d'elle", () => {
    only("ram");
    sim.aiPaused = true;
    run(0.5);
    const mine = dropBeside(byId("ram"), "fireMine", vec3(2.6, 0, 0));
    landing(mine);
    run(WEAPONS.fireMine.projectile.mine.armDelay + 0.5);
    expect(events.some((e) => e.type === "explosion" && e.look === "napalm")).toBe(true);
    expect(count("fireStarted")).toBeGreaterThanOrEqual(3);
  });

  it("une mine fumigène lâche un nuage quand un robot passe", () => {
    only("ram");
    sim.aiPaused = true;
    run(0.5);
    landing(dropBeside(byId("ram"), "smokeMine", vec3(2.8, 0, 0)));
    run(1.5);
    expect(count("smokeAdded")).toBe(1);
  });

  it("une mine bondissante saute avant d'éclater, au-dessus des roues", () => {
    only("ram");
    sim.aiPaused = true;
    run(0.5);
    const mine = dropBeside(byId("ram"), "bounceMine", vec3(3, 0, 0));
    landing(mine);
    const ground = mine.pos.y;
    run(WEAPONS.bounceMine.projectile.mine.armDelay + 1.2);
    expect(events.some((e) => e.type === "mine" && e.action === "bounce")).toBe(true);
    const blast = events.find((e) => e.type === "explosion");
    expect(blast?.type === "explosion" && blast.point.y - ground).toBeGreaterThan(1.2);
  });

  it("une mine anti-aérienne tire un missile sur un robot en vol qui passe au-dessus d'elle", () => {
    only("drone");
    sim.aiPaused = true;
    run(1);
    const drone = byId("drone");
    const below = vec3(drone.lastPos.x + 3, 1, drone.lastPos.z);
    const mine = spawnProjectile(sim, "aaMine", below, vec3(0, -1, 0), { shooter: null });
    landing(mine);
    run(WEAPONS.aaMine.projectile.mine.armDelay + 0.5);
    expect(sim.projectiles.includes(mine)).toBe(false);
    expect(events.some((e) => e.type === "shot" && e.weapon === "flak")).toBe(true);
  });

  it("une mine ventouse se colle au robot, le suit, puis éclate", () => {
    only("ram");
    sim.aiPaused = true;
    run(0.5);
    const ram = byId("ram");
    const mine = dropBeside(ram, "stickyMine", vec3(2.4, 0, 0));
    landing(mine);
    run(WEAPONS.stickyMine.projectile.mine.armDelay + 0.3);
    expect(mine.stuck).not.toBeNull();
    // Le robot est poussé : la mine reste sur lui
    ram.cockpit.part.rb.setLinvel({ x: 0, y: 0, z: 6 }, true);
    run(0.5);
    expect(distance(mine.pos, blockWorldPos(mine.stuck!.block))).toBeLessThan(0.6);
    expect(count("explosion")).toBe(0);
    run(2);
    expect(sim.projectiles.includes(mine)).toBe(false);
    expect(count("explosion")).toBe(1);
  });

  it("une mine télécommandée : l'IA la fait sauter sur un ennemi, le joueur quand il le décide", () => {
    spawnTeams(sim, [{ profile: profile("ram"), team: "blue" }, { profile: profile("tank"), team: "red" }]);
    sim.aiPaused = true;
    run(0.5);
    const ram = byId("ram");
    const tank = byId("tank");
    // Posée par l'IA du Bélier à côté du Char ennemi : elle saute d'elle-même
    const own = dropBeside(tank, "remoteMine", vec3(3.2, 0, 0), ram);
    landing(own);
    run(WEAPONS.remoteMine.projectile.mine.armDelay + 0.5);
    expect(sim.projectiles.includes(own)).toBe(false);
    // Posée par le joueur : rien tant qu'il ne donne pas l'ordre
    takeControl(ram, sim.input);
    const mine = dropBeside(tank, "remoteMine", vec3(-3.2, 0, 0), ram);
    landing(mine);
    run(WEAPONS.remoteMine.projectile.mine.armDelay + 1);
    expect(sim.projectiles.includes(mine)).toBe(true);
    sim.input.detonate = true;
    run(0.3);
    expect(sim.projectiles.includes(mine)).toBe(false);
  });

  it("un capteur fait repérer à son équipe les ennemis proches, même hors de vue", () => {
    spawnTeams(sim, [{ profile: profile("scout"), team: "blue" }, { profile: profile("tank"), team: "red" }]);
    sim.aiPaused = true;
    run(0.5);
    const scout = byId("scout");
    const tank = byId("tank");
    // Le Guetteur est emmené loin, hors de vue
    for (const part of scout.parts) part.rb.setTranslation(add(part.rb.translation(), vec3(0, 0, -45)), true);
    run(1);
    expect(sim.detected.get("blue")?.has(tank)).toBe(false);
    landing(dropBeside(tank, "sensorMine", vec3(6, 0, 0), scout));
    run(WEAPONS.sensorMine.projectile.mine.armDelay + 0.6);
    expect(sim.detected.get("blue")?.has(tank)).toBe(true);
    expect(events.some((e) => e.type === "mine" && e.action === "ping")).toBe(true);
  });

  it("une explosion fait sauter les mines voisines, en chaîne", () => {
    only();
    const a = spawnProjectile(sim, "mine", vec3(0, 1, 30), vec3(0, -1, 0), { shooter: null });
    const b = spawnProjectile(sim, "mine", vec3(1.5, 1, 30), vec3(0, -1, 0), { shooter: null });
    const c = spawnProjectile(sim, "mine", vec3(3, 1, 30), vec3(0, -1, 0), { shooter: null });
    landing(a);
    landing(c);
    explode(sim, vec3(-0.5, 0.2, 30), WEAPONS.cannon.projectile.explosion, vec3(0, -1, 0), vec3(0, 5, 20));
    run(0.3);
    for (const m of [a, b, c]) expect(sim.projectiles.includes(m)).toBe(false);
    expect(count("explosion")).toBe(4);
  });

  it("l'IA repère les mines ennemies qu'elle voit, et les contourne", () => {
    spawnTeams(sim, [{ profile: profile("tank"), team: "blue" }, { profile: profile("ram"), team: "red" }]);
    sim.aiPaused = true;
    run(0.5);
    const tank = byId("tank");
    const ram = byId("ram");
    const pos = tank.lastPos;
    const goal = add(pos, vec3(0, 0, 16));
    const mine = spawnProjectile(sim, "mine", add(pos, vec3(0, 1, 8)), vec3(0, -1, 0), { shooter: ram });
    landing(mine);
    // Pas encore repérée : il y va tout droit
    expect(avoidMines(sim, tank, pos, goal)).toBe(goal);
    run(0.5);
    expect(mine.spotted).toContain("blue");
    const detour = avoidMines(sim, tank, pos, goal);
    expect(Math.abs(detour.x - pos.x)).toBeGreaterThan(WEAPONS.mine.projectile.mine.radius + tank.radius);
  });

  it("le rayon réparateur remet en état un allié ; un ennemi, il l'abîme", () => {
    spawnTeams(sim, [
      { profile: profile("mechanic"), team: "blue" }, { profile: profile("tank"), team: "blue" }, { profile: profile("ram"), team: "red" },
    ]);
    sim.aiPaused = true;
    run(0.5);
    const [mechanic, tank, ram] = [byId("mechanic"), byId("tank"), byId("ram")];
    const hurt = (bot: Bot): void => {
      for (const b of bot.blocks.values()) if (b !== bot.cockpit) b.hp = BLOCK_TYPES[b.type].hp / 4;
    };
    hurt(tank);
    hurt(ram);
    const beam = (target: Bot): void => {
      const aim = blockWorldPos([...target.blocks.values()].find((b) => b !== target.cockpit)!);
      for (let i = 0; i < 20; i++) spawnProjectile(sim, "repair", add(aim, vec3(0, 3, 0)), vec3(0, -1, 0), { shooter: mechanic });
      run(0.2);
    };
    const [tankBefore, ramBefore] = [repairNeed(tank), repairNeed(ram)];
    beam(tank);
    beam(ram);
    expect(repairNeed(tank)).toBeLessThan(tankBefore - 50);
    expect(repairNeed(ram)).toBeGreaterThan(ramBefore); // il lui vole de la vie (tests/support.test.ts)
  });

  it("le Mécano de l'IA va soigner un allié abîmé", () => {
    spawnTeams(sim, [
      { profile: profile("mechanic"), team: "blue" }, { profile: profile("tank"), team: "blue" }, { profile: profile("ram"), team: "red" },
    ]);
    const [mechanic, tank, ram] = [byId("mechanic"), byId("tank"), byId("ram")];
    takeControl(ram, newInput()); // l'ennemi reste inerte
    takeControl(tank, newInput());
    for (const b of tank.blocks.values()) if (b !== tank.cockpit) b.hp = BLOCK_TYPES[b.type].hp / 3;
    const before = repairNeed(tank);
    let supported = false;
    for (let i = 0; i < 25 * 60; i++) {
      sim.step();
      supported ||= mechanic.ai.mode === "support";
    }
    expect(supported).toBe(true);
    expect(repairNeed(tank)).toBeLessThan(before * 0.5);
  });
});
