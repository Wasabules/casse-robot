import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ARENAS } from "../src/shared/arena/layout";
import { targetScore, vulnerability } from "../src/shared/ai/gunner";
import { preferredRange, repairWork } from "../src/shared/ai/tactics";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { DamageBatch, inflict } from "../src/shared/combat/damage";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { distance, dot, flatDistance, sub, vec3 } from "../src/shared/math/vec";
import { integrity } from "../src/shared/robot/queries";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Block, Bot, Team } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

const preset = (id: string): BotProfile => PRESET_BOTS.find((p) => p.id === id)!;

describe("IA de combat", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(5);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number, each?: () => void): void => {
    for (let i = 0; i < seconds * 60; i++) {
      sim.step();
      each?.();
    }
  };
  /** Un robot posé en (x, z), dans le couloir dégagé de l'est de l'arène (x = 24 : ni pilier ni rampe). */
  const place = (id: string, z: number, team: Team): Bot => {
    const p = preset(id);
    const bot = spawnBot(sim, p, vec3(24, groundHeight(p.design) + 0.03, z), team === "blue" ? 0 : Math.PI, team);
    sim.bots.push(bot);
    return bot;
  };
  /** Une cible qui ne bouge ni ne tire : un robot « piloté » sans commandes. */
  const idle = (bot: Bot): void => {
    bot.controller = "player";
  };

  it("la portée préférée dépend des armes : le sniper de loin, le fusil à mi-distance, le lance-flammes au contact", () => {
    const [stilt, trike, ram, target] = spawnTeams(sim, [
      { profile: preset("stilt"), team: "blue" },
      { profile: preset("trike"), team: "blue" },
      { profile: preset("ram"), team: "blue" },
      { profile: preset("scarab"), team: "red" },
    ]);
    const sniper = preferredRange(stilt, target)!;
    const rifle = preferredRange(trike, target)!;
    const flamer = preferredRange(ram, target)!;
    expect(sniper).toBeGreaterThan(rifle);
    expect(rifle).toBeGreaterThan(flamer);
    // Le Bélier garde toutes ses armes à portée, lance-flammes compris
    expect(flamer).toBeLessThanOrEqual(WEAPONS.flamer.range);
  });

  it("un robot engage son adversaire à sa portée préférée, et tourne autour de lui", () => {
    const trike = place("trike", -20, "blue");
    const target = place("scarab", 15, "red");
    idle(target);
    const range = preferredRange(trike, target)!;
    run(10);
    expect(trike.ai.tactics.foe).toBe(target);
    const gaps: number[] = [];
    const bearings: number[] = [];
    run(8, () => {
      gaps.push(flatDistance(trike.lastPos, target.lastPos));
      bearings.push(Math.atan2(trike.lastPos.z - target.lastPos.z, trike.lastPos.x - target.lastPos.x));
    });
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(Math.abs(mean - range)).toBeLessThan(8);
    // Il ne reste pas planté : il a tourné autour de sa cible
    let turned = 0;
    for (let i = 1; i < bearings.length; i++) turned += Math.abs(Math.atan2(Math.sin(bearings[i] - bearings[i - 1]), Math.cos(bearings[i] - bearings[i - 1])));
    expect(turned).toBeGreaterThan(0.3);
  });

  it("un robot abîmé qui porte un module de réparation se met à l'abri derrière un pilier", () => {
    const truck = place("truck", -20, "blue");
    const enemy = place("scarab", 15, "red");
    idle(enemy);
    run(0.5);
    // Les blocs autour du module de réparation perdent la moitié de leurs points de structure
    for (const b of truck.blocks.values()) b.hp = BLOCK_TYPES[b.type].hp / 2;
    expect(repairWork(truck)).toBeGreaterThan(150);
    run(1);
    expect(truck.ai.mode).toBe("cover");
    const spot = truck.ai.target;
    const threat = enemy.lastPos;
    const pillar = ARENAS.depot.boxes.filter((b) => b.kind === "pillar").find((b) => flatDistance(b.pos, spot) < b.half.x + truck.radius + 1.5);
    expect(pillar).toBeDefined();
    // L'abri est du côté du pilier opposé à la menace
    expect(dot(sub(spot, pillar!.pos), sub(pillar!.pos, threat))).toBeGreaterThan(0);
  });

  it("les tourelles préfèrent achever une cible abîmée, et celle que leur arme blesse bien", () => {
    const [trike, a, b, heavy] = spawnTeams(sim, [
      { profile: preset("trike"), team: "blue" },
      { profile: preset("buggy"), team: "red" },
      { profile: preset("buggy"), team: "red" },
      { profile: preset("scarab"), team: "red" },
    ]);
    // Le second Buggy perd les blocs les plus éloignés de son cockpit, jusqu'à la moitié de sa structure
    const gap = (x: Block): number => Math.hypot(x.x - b.cockpit.x, x.y - b.cockpit.y, x.z - b.cockpit.z);
    const far = [...b.blocks.values()].filter((x) => x !== b.cockpit).sort((p, q) => gap(q) - gap(p));
    const batch = new DamageBatch();
    for (const x of far.slice(0, Math.floor(b.total / 2) - 1)) batch.add({ kind: "block", block: x }, 1e9, "kinetic");
    inflict(sim, batch, vec3(0, -1, 0), null);
    expect(integrity(b)).toBeLessThan(0.7);
    expect(integrity(b)).toBeGreaterThan(0.25);
    const rifle = WEAPONS.rifle;
    expect(targetScore(trike, b, rifle, 30)).toBeLessThan(targetScore(trike, a, rifle, 30));
    // Le dôme lourd du Scarabée encaisse mieux les balles que la coque légère du Buggy
    expect(vulnerability(heavy, "kinetic")).toBeLessThan(vulnerability(a, "kinetic"));
    expect(targetScore(trike, heavy, rifle, 30)).toBeGreaterThan(targetScore(trike, a, rifle, 30));
  });

  it("en plein combat, un robot touché ne s'enfuit pas : il continue de tourner autour de son adversaire", () => {
    const trike = place("trike", -20, "blue");
    const target = place("scarab", 15, "red");
    idle(target);
    run(10);
    expect(trike.ai.mode).toBe("engage");
    const orbit = trike.ai.tactics.orbit;
    const block = [...trike.blocks.values()].find((x) => x !== trike.cockpit)!;
    const batch = new DamageBatch();
    batch.add({ kind: "block", block }, 1, "kinetic");
    inflict(sim, batch, vec3(0, -1, 0), target.lastPos);
    expect(trike.ai.mode).toBe("engage");
    expect(trike.ai.tactics.orbit).toBe(orbit);
    run(2);
    expect(trike.ai.mode).toBe("engage");
    expect(distance(trike.lastPos, target.lastPos)).toBeLessThan(35);
  });
});
