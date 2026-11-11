import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lavaAt } from "../src/shared/arena/features";
import { ISLAND_LANDMARKS } from "../src/shared/arena/island";
import { ARENA_IDS, ARENAS, deepWaterAt, groundLevel } from "../src/shared/arena/layout";
import { cellAt, findPath, isOpen, navGrid, passable } from "../src/shared/arena/navgrid";
import { propHalf } from "../src/shared/catalog/props";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { vec3, type Vec3 } from "../src/shared/math/vec";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { startMatch } from "../src/shared/sim/match";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * L'Île volcanique : la grille de passage de l'IA (le volcan, la lave, la mer), les dangers du
 * terrain (la lave brûle, l'eau profonde noie), des trajets de l'IA à travers l'île (la route du
 * cratère, un pont, un gué) et une bataille. `ISLAND_REPORT=1 npx vitest run tests/island.test.ts
 * --silent=false` joue en plus quatre batailles et en affiche le bilan (durée, coût d'un pas,
 * temps où les robots sont coincés, causes des destructions).
 */

const ISLAND = ARENAS.island;
const L = ISLAND_LANDMARKS;

describe("l'Île volcanique", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(7);
    sim = new Simulation();
    sim.loadArena("island");
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number, each?: () => void): void => {
    for (let i = 0; i < seconds * 60; i++) {
      sim.step();
      each?.();
    }
  };
  /** Un robot prédéfini posé au sol (ou sur l'eau) en (x, z), tourné de `yaw`. */
  const place = (id: string, x: number, z: number, yaw = 0, team: "blue" | "red" = "blue"): Bot => {
    const profile = PRESET_BOTS.find((p) => p.id === id)!;
    const bot = spawnBot(sim, profile, vec3(x, groundLevel(ISLAND, x, z) + groundHeight(profile.design) + 0.05, z), yaw, team);
    sim.bots.push(bot);
    return bot;
  };
  const flat = (p: Vec3, q: { x: number; z: number }): number => Math.hypot(p.x - q.x, p.z - q.z);
  /**
   * Le robot va seul vers `target` (en patrouille, sans ennemi) pendant au plus `seconds` s ; renvoie
   * ses positions, quatre par seconde, jusqu'à ce qu'il arrive à moins de `arrive` m.
   */
  const drive = (bot: Bot, target: Vec3, seconds: number, arrive = 4): Vec3[] => {
    const track: Vec3[] = [];
    for (let i = 0; i < seconds * 60; i++) {
      bot.ai.target = target;
      bot.ai.timer = 1e6;
      sim.step();
      if (i % 15 || !bot.cockpit.alive) continue;
      const p = bot.cockpit.part.rb.translation();
      track.push(vec3(p.x, p.y, p.z));
      if (flat(p, target) < arrive) break;
    }
    return track;
  };
  const inLava = (p: Vec3): boolean => lavaAt(ISLAND.lava, p.x, p.z) > 0;

  it("la grille de passage ferme le flanc du volcan, la lave et la mer, et ouvre les routes et les ponts", () => {
    const grid = navGrid(ISLAND)!;
    expect(grid).not.toBeNull();
    // À l'ouest du volcan, la route du sud passe à 39 m du centre ; plus haut et plus bas, le flanc
    expect(passable(ISLAND, 39.3, 0)).toBe(true);
    expect(passable(ISLAND, 28, 0)).toBe(false);
    // Le fond du cratère, et la zone A
    expect(passable(ISLAND, L.crater.x, L.crater.z)).toBe(true);
    expect(passable(ISLAND, L.pool.x, L.pool.z)).toBe(false);
    // Les coulées, la mer ; les gués
    expect(passable(ISLAND, 106, -39)).toBe(false);
    expect(passable(ISLAND, 0, 135)).toBe(false);
    for (const [x, z] of L.fords) expect(passable(ISLAND, x, z)).toBe(true);
    // Le pont de bois au-dessus de la gorge ; à côté de lui, la gorge
    for (const b of L.bridges) {
      expect(passable(ISLAND, b.x, b.z)).toBe(true);
      expect(passable(ISLAND, b.x + 6 * Math.sign(b.x), b.z)).toBe(false);
    }
    // Des deux plages de départ, un chemin mène à chaque zone
    for (const z of [ISLAND.bounds.spawnLine, -ISLAND.bounds.spawnLine]) {
      for (const zone of ISLAND.zones) {
        expect(isOpen(grid, zone.pos.x, zone.pos.z), zone.label).toBe(true);
        expect(findPath(grid, cellAt(grid, 0, z), cellAt(grid, zone.pos.x, zone.pos.z)), zone.label).not.toBeNull();
      }
    }
    // Les autres arènes (sauf le Port, et son eau profonde) n'ont pas de grille : leur IA va comme avant
    for (const id of ARENA_IDS) if (id !== "island" && id !== "port") expect(navGrid(ARENAS[id])).toBeNull();
    expect(passable(ARENAS.valley, 0, 0)).toBe(true);
  });

  it("les lignes de départ sont sur la plage, au sec et dégagées ; les zones sont au sol ; le décor ne se chevauche pas", () => {
    const { spawnLine, spawnSpread } = ISLAND.bounds;
    for (const side of [1, -1]) {
      for (let x = -spawnSpread; x <= spawnSpread; x += 2) {
        const g = groundLevel(ISLAND, x, side * spawnLine);
        expect(g).toBeGreaterThan(ISLAND.water! + 0.4);
        expect(g).toBeLessThan(ISLAND.water! + 1.5);
        expect(passable(ISLAND, x, side * spawnLine)).toBe(true);
      }
      for (const spot of ISLAND.props) expect(Math.abs(spot.pos.z - side * spawnLine) < 6 && Math.abs(spot.pos.x) < spawnSpread + 4).toBe(false);
    }
    for (const zone of ISLAND.zones) expect(Math.abs(zone.pos.y - groundLevel(ISLAND, zone.pos.x, zone.pos.z)), zone.label).toBeLessThan(0.1);
    // Caisses, barils, bouteilles, citerne : dehors, pas dans un bâtiment
    const buildings = new Map<number, { minX: number; maxX: number; minZ: number; maxZ: number }>();
    for (const s of ISLAND.props) {
      if (s.building === undefined) continue;
      const h = propHalf(s.type, s);
      const r = Math.max(h.x, h.z);
      const b = buildings.get(s.building) ?? { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      buildings.set(s.building, { minX: Math.min(b.minX, s.pos.x - r), maxX: Math.max(b.maxX, s.pos.x + r), minZ: Math.min(b.minZ, s.pos.z - r), maxZ: Math.max(b.maxZ, s.pos.z + r) });
    }
    for (const s of ISLAND.props.filter((p) => ["crate", "barrel", "gas", "tank"].includes(p.type))) {
      for (const b of buildings.values()) {
        expect(s.pos.x > b.minX + 0.3 && s.pos.x < b.maxX - 0.3 && s.pos.z > b.minZ + 0.3 && s.pos.z < b.maxZ - 0.3, `${s.type} (${s.pos.x}, ${s.pos.z})`).toBe(false);
      }
    }
    // Les arbres : au sec, hors de la lave, chacun à sa place
    const trees = ISLAND.props.filter((s) => s.type === "palm" || s.type === "kapok");
    expect(trees.length).toBeGreaterThan(110);
    for (const t of trees) {
      expect(groundLevel(ISLAND, t.pos.x, t.pos.z)).toBeGreaterThan(ISLAND.water!);
      expect(lavaAt(ISLAND.lava, t.pos.x, t.pos.z, 4)).toBeLessThan(-4);
      for (const o of trees) {
        if (o !== t) expect(Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z)).toBeGreaterThan(propHalf(t.type, t).x + propHalf(o.type, o).x + 2);
      }
      for (const b of ISLAND.boxes) {
        if (b.kind !== "bound") expect(Math.hypot(b.pos.x - t.pos.x, b.pos.z - t.pos.z) > Math.max(b.half.x, b.half.z) + 1, `${t.type} ${b.kind}`).toBe(true);
      }
    }
  });

  it("la lave brûle un robot qui s'y arrête, jusqu'à le détruire", () => {
    const bot = place("buggy", 106, -39);
    sim.aiPaused = true;
    expect(inLava(bot.cockpit.part.rb.translation())).toBe(true);
    run(30);
    expect(events.some((e) => e.type === "fireStarted")).toBe(true);
    const killed = events.find((e) => e.type === "botKilled");
    expect(killed?.type === "botKilled" && killed.cause).toBe("lava");
  });

  it("la mer noie un robot au sol, pas un aéroglisseur qui glisse dessus", () => {
    const sunk = place("buggy", 0, 136);
    const floating = place("hovercraft", 20, 136);
    sim.aiPaused = true;
    run(10);
    const killed = events.filter((e) => e.type === "botKilled");
    expect(killed.length).toBe(1);
    expect(killed[0].type === "botKilled" && killed[0].bot === sunk && killed[0].cause).toBe("drown");
    expect(floating.cockpit.alive).toBe(true);
    expect(deepWaterAt(ISLAND, 20, 136)).toBe(true);
    expect(floating.cockpit.part.rb.translation().y).toBeGreaterThan(ISLAND.water!);
  });

  it("l'IA monte au cratère par la route en lacets", () => {
    const [x, z] = L.roadFoot.north;
    const bot = place("buggy", x, z + 6, Math.PI);
    const track = drive(bot, vec3(L.crater.x, 0, L.crater.z), 75);
    expect(flat(track[track.length - 1], L.crater)).toBeLessThan(4);
    expect(track.some(inLava)).toBe(false);
  });

  it("l'IA passe la coulée au gué de basalte, et la gorge sur le pont", () => {
    // Au nord de la coulée de l'ouest, vers la piste, au sud : la ligne droite traverse la lave
    const bot = place("buggy", 104, -22, Math.PI);
    const goal = vec3(98, 0, -58);
    const track = drive(bot, goal, 70);
    expect(flat(track[track.length - 1], goal)).toBeLessThan(4);
    expect(track.some(inLava)).toBe(false);
    expect(track.some((p) => flat(p, { x: L.fords[0][0], z: L.fords[0][1] }) < 8)).toBe(true);
    // Du village, au nord de la gorge, vers la plaine de l'ouest, au sud : par le pont
    const other = place("buggy", 92, 44, Math.PI);
    const plain = vec3(96, 0, 12);
    const crossing = drive(other, plain, 70);
    expect(flat(crossing[crossing.length - 1], plain)).toBeLessThan(4);
    // Au-dessus de la gorge, il est sur le tablier, pas dans l'eau
    expect(crossing.some((p) => deepWaterAt(ISLAND, p.x, p.z) && p.y < ISLAND.water! + 1)).toBe(false);
    expect(crossing.some((p) => flat(p, L.bridges[0]) < 5)).toBe(true);
  });

  it("une bataille se joue sur l'île sans erreur", { timeout: 120_000 }, () => {
    const mode = GAME_MODES.battle;
    spawnTeams(sim, matchEntries(mode, PRESET_BOTS[3]));
    const match = startMatch(sim, { ...mode.match, timeLimit: 40 });
    run(40);
    expect(match.elapsed).toBeGreaterThan(30);
    expect(sim.bots.length).toBeGreaterThan(8);
  });
});

/** `ISLAND_REPORT=1` : bilan de quatre batailles et de quatre parties de capture sur l'île. */
const report = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.ISLAND_REPORT;

it.runIf(report)("bilan de batailles sur l'île", { timeout: 3_600_000 }, async () => {
  await initPhysics();
  const lines: string[] = [];
  for (const [modeId, seeds] of [["battle", [1, 2, 3, 4]], ["capture", [5, 6]]] as const) {
    for (const seed of seeds) {
      seedRandom(seed);
      const sim = new Simulation();
      sim.loadArena("island");
      const mode = GAME_MODES[modeId];
      spawnTeams(sim, matchEntries(mode, PRESET_BOTS[seed % PRESET_BOTS.length]));
      const match = startMatch(sim, { ...mode.match, timeLimit: 600 });
      const causes = new Map<string, number>();
      sim.on((e) => {
        if (e.type === "botKilled") causes.set(e.cause ?? "?", (causes.get(e.cause ?? "?") ?? 0) + 1);
      });
      sim.profile = { now: () => performance.now(), times: {} };
      let ground = 0;
      let stuck = 0;
      let reversing = 0;
      let steps = 0;
      for (; steps < 600 * 60 && !match.winner; steps++) {
        sim.step();
        if (steps % 30) continue;
        for (const b of sim.bots) {
          if (!b.cockpit.alive || b.profile.mobility !== "ground") continue;
          ground++;
          const v = b.cockpit.part.rb.linvel();
          if (b.ai.mode === "reverse") reversing++;
          if (Math.hypot(v.x, v.z) < 0.5 && b.ai.stuckT + b.ai.blockedT > 0.5) stuck++;
        }
      }
      const total = Object.entries(sim.profile.times).reduce((s, [k, t]) => (k.includes("›") ? s : s + t), 0) / steps;
      lines.push(
        `${modeId} graine ${seed} : ${match.winner ?? "en cours"} ${match.score.blue.toFixed(0)}-${match.score.red.toFixed(0)} en ${match.elapsed.toFixed(0)} s`
        + ` · pas ${total.toFixed(2)} ms (ia ${((sim.profile.times["ia"] ?? 0) / steps).toFixed(2)})`
        + ` · coincés ${((100 * stuck) / Math.max(1, ground)).toFixed(1)} % · en marche arrière ${((100 * reversing) / Math.max(1, ground)).toFixed(1)} %`
        + ` · causes ${[...causes].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")}`,
      );
      console.log(lines[lines.length - 1]);
      sim.dispose();
    }
  }
  console.log(lines.join("\n"));
});
