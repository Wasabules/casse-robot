import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import type { ArenaKey } from "../src/shared/arena/layout";
import { navGrid } from "../src/shared/arena/navgrid";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { canonicalJson, checkMapText, mapKey, registerMap } from "../src/shared/map";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import { startMatch } from "../src/shared/sim/match";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { exampleMap } from "../tools/maps/example";
import { seedRandom } from "./seed";

/*
 * Les cartes livrées avec le jeu (maps/) : chacune se lit et se valide comme le feraient le jeu et
 * le serveur ; la carte d'exemple est bien celle que fait son outil (tools/maps/example.ts : un
 * relief en PNG 16 bits importé, puis des éléments de jeu) ; une bataille et une capture de zones
 * entre IA s'y déroulent sans erreur. `MAP_PERF=1 npx vitest run tests/communityMaps.test.ts
 * --silent=false` : le coût d'un pas de combat sur chaque carte, comparé au Dépôt et à la Vallée.
 */

const BUNDLED = import.meta.glob<string>("../maps/*.casse-map.json", { query: "?raw", import: "default", eager: true });
/** Les cartes de maps/, par nom de fichier (sans `.casse-map.json`). */
const NAMES = Object.keys(BUNDLED).map((p) => p.split("/").pop()!.replace(".casse-map.json", ""));
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/** L'arène d'une carte du dossier maps/, d'après son nom de fichier. */
function bundled(name: string): ArenaKey {
  const text = Object.entries(BUNDLED).find(([path]) => path.endsWith(`/${name}.casse-map.json`))?.[1];
  const check = checkMapText(text ?? "");
  if (!check.map || check.issues.length) throw new Error(`Carte ${name} invalide : ${JSON.stringify(check.issues)}`);
  return registerMap(check.map).id;
}

beforeAll(async () => {
  await initPhysics();
});

describe("cartes livrées avec le jeu", () => {
  it("chaque carte de maps/ se lit et se joue", () => {
    expect(Object.keys(BUNDLED).length).toBeGreaterThan(0);
    for (const [path, text] of Object.entries(BUNDLED)) {
      const check = checkMapText(text);
      expect(check.issues, path).toEqual([]);
      expect(check.map?.meta.license, path).toBeTruthy();
      expect(navGrid(check.arena!), path).not.toBeNull();
    }
  });

  it("la carte d'exemple est celle que fait son outil, à partir de son relief en PNG 16 bits", async () => {
    const { map, png } = await exampleMap((d) => new Uint8Array(deflateSync(d, { level: 9 })), (d) => new Uint8Array(inflateSync(d)));
    const file = checkMapText(readFileSync(new URL("../maps/val-du-lac.casse-map.json", import.meta.url), "utf8"));
    expect(file.map && canonicalJson(file.map)).toBe(canonicalJson(map));
    expect(file.key).toBe(mapKey(map));
    // Le relief source livré est bien une image 16 bits de 257 pixels de côté
    const source = new Uint8Array(readFileSync(new URL("../tools/maps/val-du-lac.png", import.meta.url)));
    expect(source.subarray(0, 4)).toEqual(png.subarray(0, 4));
    expect(new DataView(source.buffer, source.byteOffset).getUint32(16)).toBe(257);
    expect(source[24]).toBe(16);
  });

  // Une bataille sur chaque carte livrée : c'est ainsi qu'on attrape les accès à des corps déjà libérés
  it.each(NAMES)("dans la carte %s, une bataille entre IA se déroule sans erreur, et des robots y sont détruits", { timeout: 120_000 }, (name) => {
    seedRandom(3);
    const sim = new Simulation();
    sim.loadArena(bundled(name));
    const mode = GAME_MODES.battle;
    spawnTeams(sim, matchEntries(mode, PRESET_BOTS[3]));
    const match = startMatch(sim, { ...mode.match, timeLimit: 45 });
    let kills = 0;
    sim.on((e) => e.type === "botKilled" && kills++);
    for (let i = 0; i < 45 * 60 && !match.winner; i++) sim.step();
    const half = sim.arena.bounds.half;
    for (const bot of sim.bots) {
      if (!bot.cockpit.alive) continue;
      const p = bot.cockpit.part.rb.translation();
      expect(Math.max(Math.abs(p.x), Math.abs(p.z)), bot.profile.id).toBeLessThan(half + 45);
    }
    expect(kills).toBeGreaterThan(0);
    sim.dispose();
  });

  it("dans le Val du Lac, l'IA va prendre les zones (capture de zones)", { timeout: 120_000 }, () => {
    seedRandom(4);
    const sim = new Simulation();
    sim.loadArena(bundled("val-du-lac"));
    const mode = GAME_MODES.capture;
    spawnTeams(sim, matchEntries(mode, PRESET_BOTS[5]));
    const match = startMatch(sim, { ...mode.match, timeLimit: 60 });
    const taken = new Set<number>();
    sim.on((e) => e.type === "zoneChanged" && e.owner && taken.add(e.zone));
    for (let i = 0; i < 60 * 60 && !match.winner; i++) sim.step();
    // Les zones des deux camps (le village au nord, la ferme au sud) et au moins une autre
    expect(taken.size).toBeGreaterThanOrEqual(3);
    sim.dispose();
  });

  it.runIf(env.MAP_PERF)("coût d'un pas de combat : chaque carte, comparée au Dépôt et à la Vallée", { timeout: 600_000 }, () => {
    const arenas: ArenaKey[] = ["depot", "valley", ...NAMES.map(bundled)];
    for (const arena of arenas) {
      seedRandom(11);
      const sim = new Simulation();
      sim.loadArena(arena);
      spawnTeams(sim, matchEntries(GAME_MODES.battle, PRESET_BOTS[0]));
      startMatch(sim, { ...GAME_MODES.battle.match, timeLimit: 60 });
      sim.profile = { now: () => performance.now(), times: {} };
      const steps = 20 * 60;
      for (let i = 0; i < steps; i++) sim.step();
      const times = sim.profile.times;
      const total = Object.entries(times).reduce((s, [k, t]) => (k.includes("›") ? s : s + t), 0) / steps;
      const part = (k: string): string => ((times[k] ?? 0) / steps).toFixed(2);
      console.log(`${String(sim.arena.community?.name ?? arena).padEnd(14)} pas moyen ${total.toFixed(2)} ms (physique ${part("physique")}, ia ${part("ia")}, roues ${part("roues")})`);
      sim.dispose();
    }
  });
});
