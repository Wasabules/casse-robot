import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reportNote, robotReport } from "../src/client/menu/plates";
import { setLocale } from "../src/client/i18n/state";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { vec3 } from "../src/shared/math/vec";
import { groundHeight, releaseWheel, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";

/*
 * Le constat de la pause (client/menu/plates.ts) : il ne dit du robot du joueur que ce que le monde
 * affiché sait déjà (la structure du HUD, les roues encore sur le morceau du cockpit, les
 * destructions), et sa note au marqueur n'écrit qu'un fait (une roue arrachée, et où).
 */
describe("menus : le constat du robot, à la pause", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });

  beforeEach(() => {
    sim = new Simulation();
  });

  afterEach(() => setLocale("fr"));

  const spawn = (id: string): Bot => {
    const profile = PRESET_BOTS.find((p) => p.id === id)!;
    return spawnBot(sim, profile, vec3(0, groundHeight(profile.design) + 0.05, 0), 0, "blue");
  };

  it("un robot intact : toute sa structure, ses blocs et ses roues, aucune note", () => {
    const bot = spawn("buggy");
    const report = robotReport(bot, 2);
    expect(report.alive).toBe(true);
    expect(report.integrity).toBe(1);
    expect(report.blocks).toEqual([bot.total, bot.total]);
    expect(report.wheels).toEqual({ mounted: bot.wheels.length, total: bot.wheels.length, rollers: false });
    expect(report.kills).toBe(2);
    expect(report.note).toBeNull();
    // Hors d'une partie, pas de destructions
    expect(robotReport(bot, null).kills).toBeNull();
  });

  it("une roue arrachée : la note dit laquelle (l'avant vers +z, la gauche vers +x)", () => {
    const bot = spawn("buggy");
    const front = Math.max(...bot.wheels.map((w) => w.local.z));
    const wheel = bot.wheels.find((w) => w.local.z === front && w.side > 0)!;
    releaseWheel(sim, wheel);
    const report = robotReport(bot, 0);
    expect(report.wheels).toEqual({ mounted: bot.wheels.length - 1, total: bot.wheels.length, rollers: false });
    expect(report.note).toEqual({ kind: "wheel", spot: "frontLeft" });
    expect(reportNote(report.note!)).toBe("roue avant gauche arrachée !");
    setLocale("en");
    expect(reportNote(report.note!)).toBe("front left wheel torn off!");
  });

  it("plusieurs roues, ou des galets de chenille : leur nombre", () => {
    const buggy = spawn("buggy");
    for (const w of buggy.wheels.slice(0, 2)) releaseWheel(sim, w);
    expect(robotReport(buggy, 0).note).toEqual({ kind: "wheels", n: 2 });
    const tank = spawn("tank");
    releaseWheel(sim, tank.wheels[0]);
    const report = robotReport(tank, 0);
    expect(report.wheels?.rollers).toBe(true);
    expect(report.note).toEqual({ kind: "rollers", n: 1 });
    expect(reportNote(report.note!)).toBe("1 galet arraché !");
  });

  it("un robot sans roue n'a pas de ligne de roues", () => {
    const report = robotReport(spawn("drone"), 0);
    expect(report.wheels).toBeNull();
    // (un robot volant puise dans ses batteries : le constat les montre, comme le HUD)
    expect(report.battery).not.toBeNull();
  });
});
