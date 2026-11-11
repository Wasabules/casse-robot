import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BlockType } from "../src/shared/catalog/blocks";
import { WEAPONS, type WeaponId } from "../src/shared/catalog/weapons";
import { hipSpread } from "../src/shared/combat/accuracy";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type RobotDesign } from "../src/shared/design/robotDesign";
import { add, distance, dot, len, norm, scale, sub, vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { turretFrame } from "../src/shared/combat/turrets";
import { seedRandom } from "./seed";

const profileOf = (d: RobotDesign): BotProfile => ({ ...PRESET_BOTS[0], id: "essai", name: "Essai", design: d });

describe("armes : fusil à pompe, roquettes, plasma", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(6);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };

  /** Le joueur pilote un plateau armé de `turret`, en `pos`, tourné vers +z ; `extra` : d'autres blocs. */
  const pilot = (turret: BlockType, pos = vec3(0, 0, 0), extra: (g: DesignGrid) => void = () => {}): Bot => {
    const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, -1, "cockpit").put(0, 1, 1, turret);
    extra(g);
    const d: RobotDesign = { blocks: g.blocks(), wheels: [] };
    expect(validateDesign(d)).toEqual([]);
    const bot = spawnBot(sim, profileOf(d), add(pos, vec3(0, groundHeight(d) + 0.03, 0)), 0, "blue");
    sim.bots.push(bot);
    bot.controller = "player";
    sim.player = bot;
    sim.input.weapon = bot.turrets[0].weapon;
    return bot;
  };
  const shots = (weapon: WeaponId): number => events.filter((e) => e.type === "shot" && e.weapon === weapon).length;
  const hpOf = (bot: Bot): number => [...bot.blocks.values()].reduce((sum, b) => sum + b.hp, 0);

  it("un coup de fusil à pompe lance une gerbe de plombs, pour un seul tir", () => {
    const dir = vec3(0, 0, 1);
    sim.fire("shotgun", vec3(0, 10, 0), dir);
    const added = events.filter((e): e is Extract<SimEvent, { type: "projectileAdded" }> => e.type === "projectileAdded");
    expect(added.length).toBe(WEAPONS.shotgun.projectile.pellets.count);
    expect(shots("shotgun")).toBe(1);
    // Chaque plomb dans le cône de la gerbe, autour d'une direction elle-même dispersée
    const cone = WEAPONS.shotgun.projectile.pellets.spread + hipSpread(WEAPONS.shotgun);
    for (const { projectile } of added) expect(Math.acos(dot(norm(projectile.vel), dir))).toBeLessThanOrEqual(cone + 1e-6);
    // Et ils s'écartent les uns des autres
    const spreadOut = new Set(added.map(({ projectile }) => projectile.vel.x.toFixed(3)));
    expect(spreadOut.size).toBeGreaterThan(5);
  });

  it("le fusil à pompe ravage au contact et s'éparpille au loin", () => {
    const damageAt = (range: number): number => {
      sim.bots = [];
      const target = spawnBot(sim, PRESET_BOTS.find((p) => p.id === "scarab")!, vec3(0, 1, range), 0, "red");
      sim.bots.push(target);
      run(0.5);
      const before = hpOf(target);
      const aim = target.cockpit.part.rb.worldCom();
      const from = vec3(0, aim.y, 0);
      for (let i = 0; i < 3; i++) {
        sim.fire("shotgun", from, norm(sub(aim, from)));
        run(0.5);
      }
      return before - hpOf(target);
    };
    const close = damageAt(5);
    const far = damageAt(40);
    expect(close).toBeGreaterThan(250);
    expect(far).toBeLessThan(close / 2);
  });

  it("le joueur tire dans l'axe où pointe vraiment le canon, sans attendre qu'il soit aligné", () => {
    pilot("gunTurret", vec3(0, 0, 0));
    sim.input.aim = vec3(0, 1, 30); // droit devant
    run(1);
    // On vise brusquement à droite : la tourelle tourne à sa vitesse, et les balles suivent son canon
    sim.input.aim = vec3(-30, 1, 0);
    sim.input.trigger = true;
    run(0.05);
    const first = events.find((e): e is Extract<SimEvent, { type: "shot" }> => e.type === "shot" && e.weapon === "rifle");
    expect(first).toBeDefined();
    expect(first!.dir.z).toBeGreaterThan(0.8); // encore presque droit devant, pas vers le point visé
    run(1.5);
    const last = [...events].reverse().find((e): e is Extract<SimEvent, { type: "shot" }> => e.type === "shot" && e.weapon === "rifle");
    expect(last!.dir.x).toBeLessThan(-0.8); // la tourelle y est arrivée
  });

  it("un missile téléguidé suit l'axe de son lance-missiles : tourner la tourelle le ramène sur la nouvelle ligne", () => {
    const bot = pilot("missileLauncher", vec3(0, 0, -30));
    sim.input.aim = vec3(0, 1.5, 0); // devant
    run(1);
    bot.turrets[0].arm.cooldown = 0; // (une tourelle apparaît avec un délai de cadence tiré au hasard)
    sim.input.trigger = true;
    run(0.05);
    sim.input.trigger = false;
    const missile = sim.projectiles.find((p) => p.weapon === "missile");
    expect(missile).toBeDefined();
    // On tourne vers la gauche (+x) : la tourelle pivote, le missile rejoint sa nouvelle ligne
    sim.input.aim = vec3(20, 1.5, -20);
    const across = (): number => {
      const { muzzle, dir } = turretFrame(bot.turrets[0]);
      const off = sub(missile!.pos, muzzle);
      return len(sub(off, scale(dir, dot(off, dir))));
    };
    run(0.5);
    const early = across();
    run(1);
    expect(missile!.done).toBe(false);
    expect(missile!.pos.x).toBeGreaterThan(3);
    expect(across()).toBeLessThan(early * 0.5);
  });

  it("une salve de roquettes part en éventail et converge sur le point visé", () => {
    // Au sud du Dépôt, vers l'ouest : rien sur le chemin
    pilot("rocketPod", vec3(0, 0, -30));
    const aim = vec3(-28, 0, -30);
    sim.input.aim = aim;
    // Cap de chaque roquette au lancement (son guidage le corrige ensuite)
    const headings: number[] = [];
    sim.on((e) => {
      if (e.type === "projectileAdded" && e.projectile.weapon === "rockets") headings.push(Math.atan2(e.projectile.vel.z, -e.projectile.vel.x));
    });
    run(1);
    sim.input.trigger = true;
    run(1.2);
    sim.input.trigger = false;
    // Le panier se vide d'un coup (8 roquettes en un peu plus d'une seconde, à la cadence de l'arme)
    expect(shots("rockets")).toBeGreaterThanOrEqual(WEAPONS.rockets.ammo.capacity);
    // En éventail au départ
    expect(Math.max(...headings) - Math.min(...headings)).toBeGreaterThan(0.1);
    run(2.5);
    const booms = events.filter((e): e is Extract<SimEvent, { type: "explosion" }> => e.type === "explosion");
    expect(booms.length).toBeGreaterThanOrEqual(WEAPONS.rockets.ammo.capacity);
    const near = booms.filter((e) => distance(e.point, aim) < 3).length;
    expect(near / booms.length).toBeGreaterThan(0.7);
  });

  it("le plasma tire un jet continu, puise dans les batteries et surchauffe", () => {
    const bot = pilot("plasmaTurret", vec3(0, 0, 0), (g) => g.put(-1, 1, -1, "battery").put(1, 1, -1, "battery"));
    sim.input.aim = vec3(0, 1, 20);
    run(1);
    const energy = bot.energy;
    sim.input.trigger = true;
    run(1);
    // Une vingtaine de tirs par seconde : un jet
    expect(shots("plasma")).toBeGreaterThan(15);
    expect(bot.energy).toBeLessThan(energy);
    const [t] = bot.turrets;
    expect(t.arm.heat).toBeGreaterThan(0.1);
    run(4);
    // Au-delà de trois secondes et demie, il surchauffe et se tait un moment
    const before = shots("plasma");
    expect(t.arm.overheated || t.arm.heat > 0.8).toBe(true);
    run(0.5);
    expect(shots("plasma") - before).toBeLessThan(8);
  });

});
