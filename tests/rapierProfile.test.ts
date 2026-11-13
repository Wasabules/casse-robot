import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { it } from "vitest";
import { isArenaId, type ArenaKey } from "../src/shared/arena/layout";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import { loadSimModule } from "../src/shared/native/simModule";
import { NativeWorld } from "../src/shared/native/world";

/*
 * Où va le pas de la simulation Rust, Rapier compris, fonction par fonction (mesure, pas un essai) :
 * une bataille (le mode Bataille de `npm run battle`), jouée sous le profileur de V8 (`node:inspector`),
 * sur une sonde qui garde les noms de ses fonctions (le profil `release` les retire, `strip`) :
 *
 *   CARGO_PROFILE_RELEASE_STRIP=none CARGO_TARGET_DIR=<dossier> cargo build -p casse-sim --release \
 *     --target wasm32-unknown-unknown --features sim
 *   PROFILE_WASM=<dossier>/wasm32-unknown-unknown/release/casse_sim.wasm npx vitest run \
 *     tests/rapierProfile.test.ts --silent=false
 *
 * (mêmes calculs que le module du dépôt : seuls les noms restent). PROFILE_ARENA, PROFILE_SEED,
 * PROFILE_SECONDS (120, après 10 s de bataille), PROFILE_TOP, PROFILE_OUT=<fichier.cpuprofile> (pour les
 * outils de développement de Chrome). Le temps inclusif (une fonction et ce qu'elle appelle) et le
 * temps propre, en ms par pas.
 */

const env = process.env;

interface Node {
  id: number;
  callFrame: { functionName: string; url: string };
  hitCount: number;
  children?: number[];
}

it.runIf(env.PROFILE_WASM)("profil du pas de Rapier", { timeout: 3_600_000 }, async () => {
  const module = await loadSimModule(readFileSync(env.PROFILE_WASM!));
  const arena: ArenaKey = isArenaId(env.PROFILE_ARENA) ? env.PROFILE_ARENA : "depot";
  const seed = Number(env.PROFILE_SEED ?? 1);
  const seconds = Number(env.PROFILE_SECONDS ?? 120);
  const world = new NativeWorld(module, seed);
  if (arena !== "depot") world.loadArena(arena);
  const mode = GAME_MODES.battle;
  world.spawnTeams(world.draw(() => matchEntries(mode, PRESET_BOTS[seed % PRESET_BOTS.length]), seed));
  world.startMatch({ ...mode.match, timeLimit: 1000 });
  world.step(600);
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 100 });
  await session.post("Profiler.start");
  const t0 = performance.now();
  for (let i = 0; i < seconds * 60; i++) world.step();
  const elapsed = performance.now() - t0;
  const { profile } = await session.post("Profiler.stop");
  session.disconnect();
  world.dispose();
  if (env.PROFILE_OUT) writeFileSync(env.PROFILE_OUT, JSON.stringify(profile));

  const nodes = new Map<number, Node>((profile.nodes as Node[]).map((n) => [n.id, n]));
  const total = [...nodes.values()].reduce((s, n) => s + n.hitCount, 0);
  const steps = seconds * 60;
  const ms = (hits: number): string => ((elapsed * hits) / total / steps).toFixed(4);
  // Les noms de Rust (« v0 » : _RNvMs_…8rapier3d8pipeline…16step_with_events) : leurs identifiants,
  // chacun précédé de sa longueur ; on garde les quatre derniers
  const short = (name: string): string => {
    if (!name.startsWith("_R")) return name;
    const parts: string[] = [];
    for (let i = 0; i < name.length;) {
      // (le discriminant d'une caisse, « Cs3mRYYI4pwJH_ », n'est pas un identifiant)
      const crate = /^Cs[0-9A-Za-z]+_/.exec(name.slice(i));
      if (crate) {
        i += crate[0].length;
        continue;
      }
      const m = /^(\d+)_?/.exec(name.slice(i));
      if (!m) {
        i++;
        continue;
      }
      const n = Number(m[1]);
      const id = name.slice(i + m[0].length, i + m[0].length + n);
      if (n > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
        parts.push(id);
        i += m[0].length + n;
      } else i += m[0].length;
    }
    return parts.length ? parts.slice(-4).join("::") : name;
  };
  const self = new Map<string, number>();
  for (const n of nodes.values()) self.set(short(n.callFrame.functionName), (self.get(short(n.callFrame.functionName)) ?? 0) + n.hitCount);
  // Inclusif : chaque nœud compte pour les noms de ses ancêtres (un nom une seule fois par chemin)
  const inclusive = new Map<string, number>();
  const root = (profile.nodes as Node[])[0];
  const walk = (n: Node, names: Set<string>): number => {
    let hits = n.hitCount;
    const name = short(n.callFrame.functionName);
    const fresh = !names.has(name);
    if (fresh) names.add(name);
    for (const c of n.children ?? []) hits += walk(nodes.get(c)!, names);
    if (fresh) {
      names.delete(name);
      inclusive.set(name, (inclusive.get(name) ?? 0) + hits);
    }
    return hits;
  };
  walk(root, new Set());
  const lines = [`${arena}, graine ${seed}, ${seconds} s : ${(elapsed / steps).toFixed(3)} ms par pas (avec le profileur)`];
  lines.push("temps inclusif (ms par pas) :");
  for (const [name, hits] of [...inclusive].sort((a, b) => b[1] - a[1]).slice(0, Number(env.PROFILE_TOP ?? 70))) lines.push(`  ${ms(hits).padStart(8)}  ${name}`);
  lines.push("temps propre (ms par pas) :");
  for (const [name, hits] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 50)) lines.push(`  ${ms(hits).padStart(8)}  ${name}`);
  console.log(lines.join("\n"));
});
