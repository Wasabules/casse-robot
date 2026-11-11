import { beforeAll, describe, expect, it } from "vitest";
import { ARENAS, spawnLineOf, spawnLocal, spawnPoint, type ArenaBounds } from "../src/shared/arena/layout";
import { blankMap, checkMap, readMap, registerMap, validateMap, type MapFile, type MapIssue, type MapSpawns } from "../src/shared/map";
import { qrot, vec3 } from "../src/shared/math/vec";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import { PRESET_BOTS } from "../src/shared/design/presets";
import type { Bot } from "../src/shared/sim/entities";
import { startMatch } from "../src/shared/sim/match";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { respawnBot, spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * Lignes de départ libres d'une carte communautaire (`MapFile.spawns`) : chaque équipe part d'où
 * l'auteur l'a placée, tournée comme il l'a voulu ; sans elles, les bleus au sud et les rouges au
 * nord, exactement comme avant. La carte les vérifie (dans la zone de jeu, dégagées, sans danger,
 * assez loin l'une de l'autre), les bois les évitent, et une bataille s'y joue.
 */

const codes = (issues: readonly MapIssue[]): string[] => issues.map((i) => i.code);

/** Les bleus à l'ouest (+x), tournés vers l'est ; les rouges à l'est, tournés vers l'ouest. */
const EAST_WEST: MapSpawns = {
  blue: { x: 50, z: 0, facing: -90, width: 30 },
  red: { x: -50, z: 0, facing: 90, width: 30 },
};

/** Une carte de départ de ±70 m, avec ces lignes de départ. */
const withSpawns = (spawns: MapSpawns, changes: Partial<MapFile> = {}): MapFile => ({ ...blankMap({ name: "Lignes", author: "Tests", half: 70 }), spawns, ...changes });

/** Direction où regarde un robot (dans le plan). */
function heading(bot: Bot): { x: number; z: number } {
  const f = qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
  const n = Math.hypot(f.x, f.z) || 1;
  return { x: f.x / n, z: f.z / n };
}

beforeAll(async () => {
  await initPhysics();
});

describe("lignes de départ libres : le format", () => {
  it("se lisent, et une carte sans elles n'en a pas", () => {
    const read = readMap(withSpawns(EAST_WEST));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.map.spawns).toEqual(EAST_WEST);
    const plain = readMap(blankMap({ name: "Sans", author: "Tests" }));
    expect(plain.ok && plain.map.spawns).toBe(undefined);
  });

  it("refuse une équipe absente, une longueur hors des bornes", () => {
    const missing = readMap({ ...blankMap({ name: "x", author: "y" }), spawns: { blue: EAST_WEST.blue } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues).toContainEqual({ code: "field", path: "spawns.red" });
    const wide = readMap(withSpawns({ ...EAST_WEST, red: { ...EAST_WEST.red, width: 1000 } }));
    expect(!wide.ok && wide.issues).toContainEqual({ code: "field", path: "spawns.red.width" });
  });

  it("sans lignes libres, les points de départ sont ceux d'avant (au nord et au sud, le long de x)", () => {
    const bounds: ArenaBounds = ARENAS.depot.bounds;
    expect(spawnPoint(bounds, "blue", 7, 3)).toEqual({ x: 7, z: -(bounds.spawnLine + 3) });
    expect(spawnPoint(bounds, "red", -4)).toEqual({ x: -4, z: bounds.spawnLine });
    expect(spawnLineOf(bounds, "red")).toEqual({ x: 0, z: bounds.spawnLine, facing: Math.PI, spread: bounds.spawnSpread });
    // Devant la ligne des bleus : vers le nord
    expect(spawnLocal(bounds, "blue", 2, -bounds.spawnLine + 5)).toEqual({ along: 2, across: 5 });
  });

  it("une ligne placée : ses points, et ce qui est devant elle", () => {
    const arena = checkMap(withSpawns(EAST_WEST)).arena!;
    const line = spawnLineOf(arena.bounds, "blue");
    expect(line.x).toBe(50);
    expect(line.spread).toBe(15);
    // Les bleus regardent vers l'est (-x) : le point « devant » est à l'est, « derrière » à l'ouest
    const behind = spawnPoint(arena.bounds, "blue", 0, 4);
    expect(behind.x).toBeCloseTo(54);
    expect(behind.z).toBeCloseTo(0);
    expect(spawnLocal(arena.bounds, "blue", 45, 0).across).toBeCloseTo(5);
    // Le long de la ligne : vers la gauche de l'équipe (le nord, pour qui regarde l'est)
    const end = spawnPoint(arena.bounds, "blue", 10);
    expect(end.x).toBeCloseTo(50);
    expect(end.z).toBeCloseTo(10);
    expect(spawnLocal(arena.bounds, "blue", end.x, end.z).along).toBeCloseTo(10);
  });
});

describe("lignes de départ libres : la vérification", () => {
  it("une carte aux lignes de départ à l'est et à l'ouest se joue", () => {
    expect(validateMap(withSpawns(EAST_WEST))).toEqual([]);
  });

  it("une ligne qui sort de la zone de jeu", () => {
    const issues = validateMap(withSpawns({ ...EAST_WEST, blue: { x: 69, z: 0, facing: -90, width: 30 } }));
    expect(issues).toContainEqual({ code: "spawnOutside", team: "blue" });
  });

  it("deux lignes trop près l'une de l'autre", () => {
    const issues = validateMap(withSpawns({ blue: { x: 10, z: 0, facing: -90, width: 20 }, red: { x: -5, z: 0, facing: 90, width: 20 } }));
    expect(codes(issues)).toContain("spawnClose");
    // Les lignes du nord et du sud d'une petite carte ne le sont pas
    expect(codes(validateMap(blankMap({ name: "Petite", author: "Tests", half: 20 })))).not.toContain("spawnClose");
  });

  it("une ligne encombrée, ou un baril tout près", () => {
    const blocked = withSpawns(EAST_WEST, { boxes: [{ kind: "platform", x: 50, z: 0, size: [8, 2, 40] }] });
    expect(validateMap(blocked)).toContainEqual({ code: "spawnBlocked", team: "blue" });
    const barrel = withSpawns(EAST_WEST, { props: [{ type: "barrel", x: -44, z: 6 }] });
    expect(validateMap(barrel)).toContainEqual({ code: "spawnHazard", team: "red" });
    // Le même baril, loin devant elle (au milieu), ne gêne personne
    expect(codes(validateMap(withSpawns(EAST_WEST, { props: [{ type: "barrel", x: -20, z: 20 }] })))).not.toContain("spawnHazard");
  });

  it("un bois semé sur une ligne de départ la laisse libre", () => {
    const map = withSpawns(EAST_WEST, { prefabs: [{ kind: "woods", x: 50, z: 0, radius: 25, count: 120, seed: 4 }] });
    const check = checkMap(map);
    expect(check.issues).toEqual([]);
    const trees = check.arena!.props;
    expect(trees.length).toBeGreaterThan(10);
    for (const spot of trees) {
      const { along, across } = spawnLocal(check.arena!.bounds, "blue", spot.pos.x, spot.pos.z);
      expect(Math.abs(along) < 15 + 8 && Math.abs(across) < 8, `${spot.pos.x}, ${spot.pos.z}`).toBe(false);
    }
  });
});

describe("lignes de départ libres : dans la simulation", () => {
  it("chaque équipe apparaît sur sa ligne, tournée comme elle, réapparaît là, et une bataille s'y joue", { timeout: 120_000 }, () => {
    seedRandom(8);
    const arena = registerMap(withSpawns(EAST_WEST));
    const sim = new Simulation();
    sim.loadArena(arena.id);
    const mode = GAME_MODES.battle;
    const bots = spawnTeams(sim, matchEntries(mode, PRESET_BOTS[3]));
    let ground = 0;
    for (const bot of bots) {
      const team = bot.team;
      const p = bot.cockpit.part.rb.translation();
      if (bot.profile.mobility === "plane") {
        // Un avion part du côté de sa ligne (les bleus à l'ouest, +x)
        expect(Math.sign(p.x), bot.profile.id).toBe(team === "blue" ? 1 : -1);
        continue;
      }
      ground++;
      const { along, across } = spawnLocal(sim.arena.bounds, team, p.x, p.z);
      expect(Math.abs(along), bot.profile.id).toBeLessThan(15 + 6);
      expect(Math.abs(across), bot.profile.id).toBeLessThan(7);
      // Tourné vers l'autre camp : les bleus vers l'est (-x), les rouges vers l'ouest
      const h = heading(bot);
      expect(h.x * (team === "blue" ? -1 : 1), bot.profile.id).toBeGreaterThan(0.9);
    }
    expect(ground).toBeGreaterThan(4);
    // Une réapparition : sur la ligne de son équipe
    const again = respawnBot(sim, PRESET_BOTS[3], "red");
    sim.bots.push(again);
    const q = again.cockpit.part.rb.translation();
    expect(Math.abs(spawnLocal(sim.arena.bounds, "red", q.x, q.z).across)).toBeLessThan(7);
    // Une bataille courte : les équipes quittent leurs lignes et se rencontrent
    const match = startMatch(sim, { ...mode.match, timeLimit: 40 });
    const start = new Map(sim.bots.map((b) => [b, b.cockpit.part.rb.translation()] as const));
    for (let i = 0; i < 40 * 60 && !match.winner; i++) sim.step();
    const moved = [...start].filter(([b, p]) => {
      if (!b.cockpit.alive || b.profile.mobility === "plane") return false;
      const now = b.cockpit.part.rb.translation();
      return Math.hypot(now.x - p.x, now.z - p.z) > 10;
    });
    expect(moved.length).toBeGreaterThan(2);
    for (const bot of sim.bots) {
      if (!bot.cockpit.alive) continue;
      const p = bot.cockpit.part.rb.translation();
      expect(Math.max(Math.abs(p.x), Math.abs(p.z)), bot.profile.id).toBeLessThan(70 + 40);
    }
    sim.dispose();
  });
});
