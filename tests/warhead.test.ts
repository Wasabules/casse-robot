import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pilotedWarhead } from "../src/shared/combat/projectiles";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { add, dot, flatDistance, norm, qrot, vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/** Un char : chenilles, caisse blindée, un lance-ogive et un fusil sur le dessus. */
function design(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -4, 4, "frame");
  g.box(-2, 2, 1, 1, -4, 3, "armor");
  g.put(0, 2, -1, "cockpit").put(0, 2, 1, "warheadLauncher").put(0, 2, -3, "gunTurret");
  const wheels: WheelMount[] = [];
  for (let z = -4; z <= 4; z += 2) for (const s of [-1, 1]) wheels.push({ x: 2 * s, y: 0, z, dx: s, dz: 0, type: "track" });
  return { blocks: g.blocks(), wheels };
}
const profileOf = (d: RobotDesign): BotProfile => ({ ...PRESET_BOTS.find((p) => p.id === "tank")!, id: "essai", name: "Essai", design: d });

describe("ogive pilotée", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(9);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  /** Le joueur au sud du Dépôt, qui vise vers l'ouest et le ciel (rien sur le chemin), l'ogive choisie. */
  const pilot = (): Bot => {
    const d = design();
    expect(validateDesign(d)).toEqual([]);
    const bot = spawnBot(sim, profileOf(d), vec3(0, groundHeight(d) + 0.03, -30), 0, "blue");
    sim.bots.push(bot);
    bot.controller = "player";
    sim.player = bot;
    sim.input.weapon = "warhead";
    sim.input.aim = vec3(-100, 60, -30);
    run(2);
    return bot;
  };
  /** On tire : un clic bref. */
  const launch = (bot: Bot): void => {
    sim.input.trigger = true;
    run(0.2);
    sim.input.trigger = false;
    run(0.3);
    expect(pilotedWarhead(sim, bot)).not.toBeNull();
  };

  it("en pilotant l'ogive, le robot s'arrête et ses autres armes se taisent", () => {
    const bot = pilot();
    // La gâchette reste pressée depuis le tir : pas de nouveau clic, l'ogive vole
    sim.input.trigger = true;
    run(0.5);
    expect(pilotedWarhead(sim, bot)).not.toBeNull();
    const start = bot.lastPos;
    const shots = events.filter((e) => e.type === "shot").length;
    sim.input.throttle = 1;
    sim.input.weapon = null; // toutes les armes : le fusil tirerait
    run(2);
    expect(pilotedWarhead(sim, bot)).not.toBeNull();
    expect(flatDistance(bot.lastPos, start)).toBeLessThan(0.5);
    expect(events.filter((e) => e.type === "shot").length).toBe(shots);
  });

  it("l'ogive va où regarde le pilote, et un nouveau clic la fait exploser", () => {
    const bot = pilot();
    launch(bot);
    const warhead = pilotedWarhead(sim, bot)!;
    // Le pilote regarde vers le nord-ouest : l'ogive vire
    sim.input.aim = add(warhead.pos, vec3(-200, 0, 300));
    run(2);
    const want = norm(vec3(-20, 0, 30));
    expect(dot(norm(warhead.vel), want)).toBeGreaterThan(0.95);
    // Un clic : elle explose là où elle est
    const where = warhead.pos;
    sim.input.trigger = true;
    run(0.1);
    sim.input.trigger = false;
    expect(pilotedWarhead(sim, bot)).toBeNull();
    const boom = events.filter((e): e is Extract<SimEvent, { type: "explosion" }> => e.type === "explosion").at(-1);
    expect(boom).toBeDefined();
    expect(flatDistance(boom!.point, where)).toBeLessThan(4);
    expect(boom!.radius).toBe(5);
  });

  it("un avion qui pilote son ogive continue de voler : le pilote automatique le tient", () => {
    // L'Avion, son lance-ogive sous le fuselage à la place de la tourelle ventrale
    const preset = PRESET_BOTS.find((p) => p.id === "plane")!;
    const bomber: BotProfile = {
      ...preset, id: "bombardier", name: "Bombardier",
      design: { ...preset.design, blocks: preset.design.blocks.map((b) => (b.type === "gunTurret" ? { ...b, type: "warheadLauncher" } : b)) },
    };
    expect(validateDesign(bomber.design)).toEqual([]);
    spawnWave(sim, [bomber]);
    const plane = sim.bots[0];
    takeControl(plane, sim.input);
    sim.input.weapon = "warhead";
    run(1);
    // On vise le sol, très loin devant : l'ogive vole longtemps
    const nose = qrot(plane.cockpit.part.rb.rotation(), vec3(0, 0, 1));
    const ahead = plane.cockpit.part.rb.worldCom();
    sim.input.aim = vec3(ahead.x + nose.x * 150, 0, ahead.z + nose.z * 150);
    sim.input.trigger = true;
    let piloting = 0;
    let lowest = Infinity;
    for (let i = 0; i < 6 * 60; i++) {
      sim.step();
      if (pilotedWarhead(sim, plane)) {
        piloting++;
        lowest = Math.min(lowest, plane.cockpit.part.rb.worldCom().y);
      }
    }
    // Pendant qu'on pilote l'ogive, l'avion vole à plat, à l'altitude que visait son pilote automatique
    expect(piloting).toBeGreaterThan(3 * 60);
    expect(plane.cockpit.alive).toBe(true);
    expect(lowest).toBeGreaterThan(4);
  });

  it("un seul coup par vie : l'ogive ne se recharge pas", () => {
    const bot = pilot();
    launch(bot);
    const t = bot.turrets.find((x) => x.weapon === "warhead")!;
    expect(t.arm.ammo).toBe(0);
    run(20);
    expect(t.arm.ammo).toBe(0);
    // Une fois l'ogive partie (explosée ou en fin de course), le robot répond de nouveau
    expect(pilotedWarhead(sim, bot)).toBeNull();
    const start = bot.lastPos;
    sim.input.throttle = 1;
    run(2);
    expect(flatDistance(bot.lastPos, start)).toBeGreaterThan(2);
  });
});
