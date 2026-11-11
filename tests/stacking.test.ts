import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { stackRate } from "../src/shared/combat/arsenal";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type RobotDesign } from "../src/shared/design/robotDesign";
import { vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { seedRandom } from "./seed";

/** Un plateau, le cockpit derrière, `count` fusils côte à côte devant (leurs tirs ne se gênent pas vers l'avant). */
function design(count: number): RobotDesign {
  const g = new DesignGrid().box(-2, 2, 0, 0, -1, 1, "frame").put(0, 1, -1, "cockpit");
  for (let i = 0; i < count; i++) g.put(i - 2, 1, 1, "gunTurret");
  return { blocks: g.blocks(), wheels: [] };
}
const profileOf = (d: RobotDesign): BotProfile => ({ ...PRESET_BOTS[0], id: "essai", name: "Essai", design: d });

describe("armes identiques : à tour de rôle, cadence à rendement décroissant", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(5);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  const pilot = (count: number): Bot => {
    const d = design(count);
    expect(validateDesign(d)).toEqual([]);
    const bot = spawnBot(sim, profileOf(d), vec3(0, groundHeight(d) + 0.03, 0), 0, "blue");
    sim.bots.push(bot);
    bot.controller = "player";
    sim.player = bot;
    sim.input.aim = vec3(0, 1.5, 40);
    sim.input.weapon = "rifle";
    return bot;
  };

  /** Les tourelles se pointent pendant 1 s, puis on presse la gâchette. */
  const pull = (): void => {
    for (let i = 0; i < 60; i++) sim.step();
    sim.input.trigger = true;
  };

  it("chaque arme de plus accélère moins la cadence que la précédente", () => {
    expect(stackRate(1)).toBe(1);
    expect(stackRate(2)).toBeCloseTo(1.8, 5);
    let gain = Infinity;
    for (let n = 2; n <= 10; n++) {
      const more = stackRate(n) - stackRate(n - 1);
      expect(more).toBeGreaterThan(0);
      expect(more).toBeLessThan(gain);
      gain = more;
    }
    expect(stackRate(50)).toBeLessThan(5);
  });

  it("quatre fusils tirent chacun leur tour, au rythme commun", () => {
    const bot = pilot(4);
    let shots = 0;
    const order: number[] = [];
    const last = new Map<object, number>();
    pull();
    for (let i = 0; i < 120; i++) {
      sim.step();
      const now = bot.turrets.filter((t) => t.firedAt !== (last.get(t) ?? -Infinity));
      // Jamais deux fusils au même pas
      expect(now.length).toBeLessThanOrEqual(1);
      for (const t of now) {
        last.set(t, t.firedAt);
        order.push(bot.turrets.indexOf(t));
        shots++;
      }
    }
    // 2 s de tir : stackRate(4) fois la cadence d'un fusil
    const expected = (2 * stackRate(4)) / WEAPONS.rifle.cooldown;
    expect(shots).toBeGreaterThan(expected * 0.9);
    expect(shots).toBeLessThan(expected * 1.1);
    // À tour de rôle : sur quatre tirs de suite, chacun des quatre fusils
    for (let i = 0; i + 4 <= order.length; i += 4) expect(new Set(order.slice(i, i + 4)).size).toBe(4);
  });

  it("un fusil seul garde sa cadence", () => {
    const bot = pilot(1);
    const [gun] = bot.turrets;
    let shots = 0;
    let last = gun.firedAt;
    pull();
    for (let i = 0; i < 120; i++) {
      sim.step();
      if (gun.firedAt !== last) {
        last = gun.firedAt;
        shots++;
      }
    }
    // Au pas fixe, 0,16 s se tire en 10 pas : 12 tirs en 2 s
    expect(shots).toBeGreaterThanOrEqual(11);
    expect(shots).toBeLessThanOrEqual(13);
  });
});
