import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { navigate } from "../src/shared/ai/navigation";
import { cellAt, cellCenter, clearLine, findPath, navGrid } from "../src/shared/arena/navgrid";
import { ARENAS, deepWaterAt, groundLevel } from "../src/shared/arena/layout";
import { propHalf } from "../src/shared/catalog/props";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { qrot, vec3, type Vec3 } from "../src/shared/math/vec";
import { GAME_MODES, pickRoster } from "../src/shared/modes";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * Le Port : eau profonde (on s'y noie, l'IA la contourne par sa grille de passage), cargo où l'on
 * monte par des passerelles, décor qui ne se chevauche pas, avions au-dessus des grues.
 */

const PORT = ARENAS.port;
const preset = (id: string): BotProfile => PRESET_BOTS.find((p) => p.id === id)!;

/** Emprise au sol d'une boîte (x, z), tournée ou non. */
function footprint(b: { pos: Vec3; half: Vec3; rot: { x: number; y: number; z: number; w: number } }): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const ax = qrot(b.rot, vec3(b.half.x, 0, 0));
  const ay = qrot(b.rot, vec3(0, b.half.y, 0));
  const az = qrot(b.rot, vec3(0, 0, b.half.z));
  const hx = Math.abs(ax.x) + Math.abs(ay.x) + Math.abs(az.x);
  const hz = Math.abs(ax.z) + Math.abs(ay.z) + Math.abs(az.z);
  return { minX: b.pos.x - hx, maxX: b.pos.x + hx, minZ: b.pos.z - hz, maxZ: b.pos.z + hz };
}

describe("le Port", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(7);
    sim = new Simulation();
    sim.loadArena("port");
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  const place = (id: string, x: number, z: number, y = groundLevel(PORT, x, z)): Bot => {
    const profile = preset(id);
    const bot = spawnBot(sim, profile, vec3(x, y + groundHeight(profile.design) + 0.05, z), 0, "blue");
    sim.bots.push(bot);
    return bot;
  };

  it("cinq zones, dont une sur le pont du cargo, toutes sur la grille de passage, et un chemin d'un quai à l'autre", () => {
    expect(PORT.zones.map((z) => z.label)).toEqual(["A", "B", "C", "D", "E"]);
    const grid = navGrid(PORT)!;
    for (const zone of PORT.zones) {
      expect(grid.open[cellAt(grid, zone.pos.x, zone.pos.z)], zone.label).toBe(1);
      // Au sol, ou sur le pont du cargo (au-dessus de l'eau profonde)
      if (zone.label === "C") expect(zone.pos.y - groundLevel(PORT, zone.pos.x, zone.pos.z)).toBeGreaterThan(6);
      else expect(Math.abs(zone.pos.y - groundLevel(PORT, zone.pos.x, zone.pos.z)), zone.label).toBeLessThan(0.05);
    }
    // La carte est symétrique : chaque zone du nord a sa jumelle au sud
    const [a, b, , d, e] = PORT.zones;
    expect([d.pos.x, -d.pos.z]).toEqual([b.pos.x, b.pos.z]);
    expect([e.pos.x, -e.pos.z]).toEqual([a.pos.x, a.pos.z]);
    // Le bassin est de l'eau profonde, pas le pont du cargo, ses passerelles, les quais
    expect(deepWaterAt(PORT, -40, 9)).toBe(true);
    expect(grid.open[cellAt(grid, -40, 9)]).toBe(0);
    for (const [x, z] of [[-20, 9], [-20, -9], [-30, 0], [-40, 13], [8, 0]]) expect(grid.open[cellAt(grid, x, z)], `${x}, ${z}`).toBe(1);
    // D'un terminal à l'autre, un chemin, qui passe par une passerelle, le pont ou l'ouest
    const path = findPath(grid, cellAt(grid, -30, 30), cellAt(grid, -30, -30))!;
    expect(path).not.toBeNull();
    const crossed = path.map((c) => cellCenter(grid, c)).filter((p) => Math.abs(p.z) < 4);
    expect(crossed.length).toBeGreaterThan(0);
    for (const p of crossed) expect(Math.abs(p.x - -20) < 4 || (p.x > 2 && p.x < 14) || p.x > 40, `${p.x}, ${p.z}`).toBe(true);
    expect(PORT.places?.length).toBeGreaterThan(10);
  });

  it("les lignes de départ sont dégagées et au sec, sur le quai", () => {
    const bots = spawnTeams(sim, pickRoster(GAME_MODES.battle).map((profile, i) => ({ profile, team: i % 2 ? "red" : "blue" })));
    sim.aiPaused = true;
    run(2);
    for (const bot of bots) {
      if (!bot.cockpit.alive || bot.profile.mobility === "plane") continue;
      const p = bot.cockpit.part.rb.translation();
      expect(deepWaterAt(PORT, p.x, p.z), bot.profile.name).toBe(false);
      expect(p.y, bot.profile.name).toBeGreaterThan(groundLevel(PORT, p.x, p.z));
      if (bot.profile.mobility === "ground") expect(p.y - groundLevel(PORT, p.x, p.z), bot.profile.name).toBeLessThan(3);
    }
    // Rien ne barre les lignes de départ (une piste ou des rails à fleur, oui)
    const { spawnLine, spawnSpread } = PORT.bounds;
    for (const box of PORT.boxes) {
      if (box.kind === "road" || box.kind === "deck" || box.kind === "bound") continue;
      const f = footprint(box);
      const crosses = f.maxX > -spawnSpread - 6 && f.minX < spawnSpread + 6 && f.maxZ > spawnLine - 5 && f.minZ < spawnLine + 7;
      expect(crosses || (f.maxZ > -spawnLine - 7 && f.minZ < -spawnLine + 5 && f.maxX > -spawnSpread - 6 && f.minX < spawnSpread + 6), `${box.kind} ${box.look ?? ""}`).toBe(false);
    }
  });

  it("le décor ne se chevauche pas : bâtiments, citernes et arbres sont hors des obstacles fixes et de l'eau", () => {
    const grid = navGrid(PORT)!;
    const blocking = PORT.boxes.filter((b) => ["pillar", "barrier", "container", "platform", "rock"].includes(b.kind)
      || (b.kind === "wall" && b.pos.y - b.half.y < groundLevel(PORT, b.pos.x, b.pos.z) + 3));
    for (const spot of PORT.props) {
      const half = propHalf(spot.type, spot);
      const f = footprint({ pos: spot.pos, half, rot: spot.rot ?? { x: 0, y: 0, z: 0, w: 1 } });
      // Pas dans l'eau (au-dessus du fond : sur un quai ou une jetée, qui sont sur la grille de passage)
      const wet = deepWaterAt(PORT, spot.pos.x, spot.pos.z) && !grid.open[cellAt(grid, spot.pos.x, spot.pos.z)];
      expect(wet, `${spot.type} en (${spot.pos.x}, ${spot.pos.z})`).toBe(false);
      for (const box of blocking) {
        const g = footprint(box);
        const overlap = Math.min(f.maxX, g.maxX) - Math.max(f.minX, g.minX) > 0.05 && Math.min(f.maxZ, g.maxZ) - Math.max(f.minZ, g.minZ) > 0.05;
        expect(overlap, `${spot.type} en (${spot.pos.x.toFixed(1)}, ${spot.pos.z.toFixed(1)}) et ${box.kind} ${box.look ?? ""} en (${box.pos.x}, ${box.pos.z})`).toBe(false);
      }
    }
    expect(sim.props.length).toBe(PORT.props.length);
  });

  it("les avions de l'IA, à leur altitude plancher, passent au-dessus des portiques, des grues et des phares", () => {
    const floor = PORT.bounds.airFloor!;
    for (const box of PORT.boxes) {
      if (box.kind === "bound") continue;
      const f = footprint(box);
      // Le relief le plus bas sous la boîte (une flèche de grue au-dessus de l'eau)
      const under = Math.min(...[[f.minX, f.minZ], [f.minX, f.maxZ], [f.maxX, f.minZ], [f.maxX, f.maxZ], [box.pos.x, box.pos.z]].map(([x, z]) => groundLevel(PORT, x, z)));
      expect(box.pos.y + box.half.y, `${box.kind} ${box.look ?? ""} en (${box.pos.x}, ${box.pos.z})`).toBeLessThan(under + floor - 0.5);
    }
  });
  it("un robot tombé dans le bassin se noie ; sur le quai, non", () => {
    const wet = place("trike", -40, 9, 0.2);
    const dry = place("trike", -40, 20);
    run(7);
    expect(wet.cockpit.alive).toBe(false);
    expect(events.some((e) => e.type === "botKilled" && e.bot === wet && e.cause === "drown")).toBe(true);
    expect(dry.cockpit.alive).toBe(true);
  });

  it("pour passer de l'autre côté du bassin, l'IA suit la grille de passage, jamais l'eau", () => {
    const grid = navGrid(PORT)!;
    const bot = place("buggy", -30, 30);
    // Du terminal nord au terminal sud : la ligne droite traverse le bassin, il vise un point de son chemin
    const goal = navigate(sim, bot, vec3(-30, 7, 30), vec3(-30, 0, -30));
    expect(goal.z).toBeGreaterThan(0);
    expect(clearLine(grid, vec3(-30, 7, 30), goal)).toBe(true);
    // Une destination dans l'eau : il va au plus près, sur le quai
    const shore = navigate(sim, bot, vec3(-30, 7, 30), vec3(-40, 0, 8));
    expect(deepWaterAt(PORT, shore.x, shore.z) && grid.open[cellAt(grid, shore.x, shore.z)] === 0).toBe(false);
  });

});
