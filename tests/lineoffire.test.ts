import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lineOfFireBlocked } from "../src/shared/combat/turrets";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { buriedTurrets, DesignGrid, validateDesign, type RobotDesign } from "../src/shared/design/robotDesign";
import { vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { seedRandom } from "./seed";

/** Un plateau de 3 × 3 cases, le cockpit derrière, un fusil devant ; `extra` : d'autres blocs. */
function design(extra: (g: DesignGrid) => void = () => {}): RobotDesign {
  const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, -1, "cockpit").put(0, 1, 1, "gunTurret");
  extra(g);
  return { blocks: g.blocks(), wheels: [] };
}
const profileOf = (d: RobotDesign): BotProfile => ({ ...PRESET_BOTS[0], id: "essai", name: "Essai", design: d });

describe("une arme ne tire pas à travers son propre robot", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(4);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const place = (d: RobotDesign): Bot => {
    expect(validateDesign(d)).toEqual([]);
    const bot = spawnBot(sim, profileOf(d), vec3(0, groundHeight(d) + 0.03, 0), 0, "blue");
    sim.bots.push(bot);
    return bot;
  };

  it("au garage, une tourelle sous un bloc est signalée comme enfouie", () => {
    expect(buriedTurrets(design())).toEqual([]);
    expect(buriedTurrets(design((g) => g.put(0, 2, 1, "armor"))).map((b) => b.type)).toEqual(["gunTurret"]);
    // Un bloc à côté ne l'enfouit pas : sa tête dépasse
    expect(buriedTurrets(design((g) => g.put(1, 1, 1, "armor")))).toEqual([]);
  });

  it("la ligne de tir est coupée par un bloc du robot ou la tête d'une autre tourelle, pas ailleurs", () => {
    const open = place(design((g) => g.put(1, 1, 1, "gunTurret")));
    const [gun, neighbour] = open.turrets;
    gun.yaw = 0; // droit devant, à l'horizontale
    gun.pitch = 0;
    expect(lineOfFireBlocked(gun)).toBe(false);
    gun.yaw = Math.PI / 2; // vers sa voisine, à gauche : sa tête est sur le chemin
    expect(neighbour.block.x).toBe(1);
    expect(lineOfFireBlocked(gun)).toBe(true);
    gun.yaw = Math.PI; // en arrière, en rasant le robot : le cockpit est sur le chemin
    gun.pitch = -0.3;
    expect(lineOfFireBlocked(gun)).toBe(true);
    // Enfouie : masquée dans toutes les directions
    const buried = place(design((g) => g.put(0, 2, 1, "armor")));
    const hidden = buried.turrets[0];
    for (let k = 0; k < 12; k++) {
      hidden.yaw = (k / 12) * Math.PI * 2;
      hidden.pitch = 0.3;
      expect(lineOfFireBlocked(hidden)).toBe(true);
    }
  });

  it("le joueur ne tire pas avec une arme enfouie ; dégagée, elle tire", () => {
    for (const [buried, expected] of [[true, 0], [false, 1]] as const) {
      const bot = place(design((g) => (buried ? g.put(0, 2, 1, "armor") : g)));
      bot.controller = "player";
      sim.player = bot;
      sim.input.aim = vec3(0, 1.5, 20);
      sim.input.trigger = true;
      events.length = 0;
      for (let i = 0; i < 120; i++) sim.step();
      const shots = events.filter((e) => e.type === "shot").length;
      if (expected === 0) expect(shots).toBe(0);
      else expect(shots).toBeGreaterThan(0);
      sim.bots = [];
    }
  });
});
