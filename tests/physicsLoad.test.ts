import { readFileSync } from "node:fs";
import RAPIER, { type Collider, type RigidBody } from "@dimforge/rapier3d-compat";
import { beforeAll, it } from "vitest";
import { isArenaId, type ArenaKey } from "../src/shared/arena/layout";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import { loadSimModule } from "../src/shared/native/simModule";
import { NativeWorld } from "../src/shared/native/world";
import { startMatch } from "../src/shared/sim/match";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { simWasmPath } from "./probe";
import { seedRandom } from "./seed";

/*
 * Ce que Rapier a à faire au fil d'une bataille (mesure, pas un essai) : `PHYSICS_REPORT=1 npx vitest
 * run tests/physicsLoad.test.ts --silent=false`. Les batailles de `npm run battle` (mode Bataille, mêmes
 * graines), et, chaque seconde : les corps par sorte (robots, morceaux arrachés, épaves, roues
 * arrachées, débris de blocs, éclats d'accessoires, accessoires mobiles et fixes, décor), ceux qui
 * dorment, les colliders, les paires du narrow phase et celles en contact ; par fenêtre de 20 s, le
 * temps du pas de Rapier côté TypeScript (`world.step` seul) et côté Rust (l'étape 4 de `Sim::stage`,
 * le même monde au bit près). PHYSICS_ARENA (le Dépôt par défaut), PHYSICS_SEEDS (1,2),
 * PHYSICS_SECONDS (240), PHYSICS_RUST=0 pour ne pas jouer le Rust, PHYSICS_WASM=<fichier> pour en jouer un
 * autre module que le plus récent (`simWasmPath`). Sur une machine chargée par d'autres travaux, ces
 * temps varient du simple au triple : PHYSICS_REPLAYS=6 rejoue aussi un pas de Rapier sur vingt six fois
 * depuis un instantané de son monde (`takeSnapshot`, le second pas du monde restauré : le premier
 * refait ses caches) et garde le plus court, moins sensible à la charge. Pour comparer deux versions,
 * mieux vaut les jouer côte à côte (tests/nativeCompare.test.ts pour deux modules Rust) : deux
 * batailles qui divergent ne coûtent pas la même chose, et la charge de la machine change d'une
 * minute à l'autre.
 */

const env = process.env;
const ARENA: ArenaKey = isArenaId(env.PHYSICS_ARENA) ? env.PHYSICS_ARENA : "depot";
const SEEDS = (env.PHYSICS_SEEDS ?? "1,2").split(",").map(Number);
const SECONDS = Number(env.PHYSICS_SECONDS ?? 240);
const WINDOW = 20;
const REPLAYS = Number(env.PHYSICS_REPLAYS ?? 0);

type Kind = "robot" | "morceau" | "épave" | "roue" | "débris" | "éclat" | "mobile" | "fixe" | "décor";
const KINDS: Kind[] = ["robot", "morceau", "épave", "roue", "débris", "éclat", "mobile", "fixe", "décor"];

interface Sample {
  t: number;
  bodies: Record<Kind, number>;
  awake: Record<Kind, number>;
  colliders: Record<Kind, number>;
  pairs: number;
  touching: number;
  /** Paires en contact, par sortes (« débris-décor »). */
  touchingBy: Record<string, number>;
  /** Débris éveillés par âge (s) : moins de 1, 1 à 2, 2 à 3, plus de 3. */
  debrisAwakeByAge: number[];
  debrisByAge: number[];
  /** Morceaux arrachés et épaves éveillés : qui portent des roues montées ; immobiles (moins de 5 cm/s). */
  wheeledAwake: number;
  stillAwake: number;
  /** Points de contact du solveur (paires dont un corps est éveillé), par sortes. */
  solverBy: Record<string, number>;
}

const zero = (): Record<Kind, number> => Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;

function kinds(sim: Simulation): Map<number, Kind> {
  const out = new Map<number, Kind>();
  const present = new Set(sim.bots);
  for (const part of sim.parts) {
    const bot = part.bot;
    const cockpit = bot.cockpit.part === part;
    out.set(part.rb.handle, !cockpit ? "morceau" : bot.cockpit.alive && present.has(bot) ? "robot" : "épave");
  }
  for (const bot of sim.bots) for (const w of bot.wheels) if (w.body) out.set(w.body.handle, "roue");
  for (const d of sim.debris) out.set(d.rb.handle, d.look.kind === "block" ? "débris" : "éclat");
  for (const p of sim.props) if (!out.has(p.rb.handle)) out.set(p.rb.handle, p.fixed ? "fixe" : "mobile");
  return out;
}

function sample(sim: Simulation): Sample {
  const kindOf = kinds(sim);
  const s: Sample = {
    t: sim.time, bodies: zero(), awake: zero(), colliders: zero(), pairs: 0, touching: 0, touchingBy: {},
    debrisAwakeByAge: [0, 0, 0, 0], debrisByAge: [0, 0, 0, 0], wheeledAwake: 0, stillAwake: 0, solverBy: {},
  };
  const world = sim.world;
  const kindOfBody = (rb: RigidBody): Kind => kindOf.get(rb.handle) ?? "décor";
  world.bodies.forEach((rb) => {
    const k = kindOfBody(rb);
    s.bodies[k]++;
    if (!rb.isFixed() && !rb.isSleeping()) s.awake[k]++;
    s.colliders[k] += rb.numColliders();
  });
  // Morceaux arrachés et épaves éveillés qui portent des roues montées (leur suspension les pousse à chaque pas)
  const carriers = new Set<number>();
  for (const bot of sim.bots) for (const w of bot.wheels) if (w.part) carriers.add(w.part.rb.handle);
  for (const part of sim.parts) {
    const k = kindOf.get(part.rb.handle);
    if ((k === "morceau" || k === "épave") && !part.rb.isSleeping()) {
      if (carriers.has(part.rb.handle)) s.wheeledAwake++;
      const v = part.rb.linvel();
      if (Math.hypot(v.x, v.y, v.z) < 0.05) s.stillAwake++;
    }
  }
  for (const d of sim.debris) {
    const age = sim.time - d.born;
    const bucket = Math.min(3, Math.floor(age));
    s.debrisByAge[bucket]++;
    if (!d.rb.isSleeping()) s.debrisAwakeByAge[bucket]++;
  }
  const seen = new Set<string>();
  world.colliders.forEach((c: Collider) => {
    const parent = c.parent();
    if (!parent || parent.isFixed()) return;
    world.contactPairsWith(c, (other) => {
      const key = c.handle < other.handle ? `${c.handle},${other.handle}` : `${other.handle},${c.handle}`;
      if (seen.has(key)) return;
      seen.add(key);
      s.pairs++;
      let touching = false;
      let solver = 0;
      world.contactPair(c, other, (m) => {
        if (m.numContacts() > 0) touching = true;
        solver += m.numSolverContacts();
      });
      if (!touching) return;
      s.touching++;
      const a = kindOfBody(parent);
      const b = other.parent() ? kindOfBody(other.parent()!) : "décor";
      const by = [a, b].sort().join("-");
      s.touchingBy[by] = (s.touchingBy[by] ?? 0) + 1;
      // Points de contact du solveur, des paires dont un corps est éveillé
      const awake = !parent.isSleeping() || (other.parent() && !other.parent()!.isFixed() && !other.parent()!.isSleeping());
      if (awake) s.solverBy[by] = (s.solverBy[by] ?? 0) + solver;
    });
  });
  return s;
}

interface Window {
  from: number;
  tsRapier: number;
  tsStep: number;
  rustRapier: number;
  rustStep: number;
  steps: number;
  /** Les pas de Rapier rejoués (un pas sur vingt, PHYSICS_REPLAYS fois chacun) : la somme des plus courts, leur nombre. */
  replayed: number;
  replays: number;
  samples: Sample[];
}

function playTs(seed: number): Window[] {
  seedRandom(seed);
  const sim = new Simulation();
  if (ARENA !== "depot") sim.loadArena(ARENA);
  const mode = GAME_MODES.battle;
  spawnTeams(sim, matchEntries(mode, PRESET_BOTS[seed % PRESET_BOTS.length]));
  const match = startMatch(sim, { ...mode.match, timeLimit: SECONDS });
  const world = sim.world;
  const step = world.step.bind(world);
  let rapier = 0;
  let replay = false;
  let w: Window | null = null;
  world.step = ((...args: Parameters<typeof world.step>) => {
    // Le même pas, rejoué depuis un instantané du monde de Rapier : le plus court de REPLAYS essais
    // (le premier pas d'un monde restauré refait ses caches : on mesure le suivant)
    if (replay) {
      const snap = world.takeSnapshot();
      let best = Infinity;
      for (let r = 0; r < REPLAYS; r++) {
        const copy = RAPIER.World.restoreSnapshot(snap);
        const queue = new RAPIER.EventQueue(true);
        copy.step(queue);
        const t = performance.now();
        copy.step(queue);
        best = Math.min(best, performance.now() - t);
        queue.free();
        copy.free();
      }
      w!.replayed += best;
      w!.replays++;
    }
    const t = performance.now();
    step(...args);
    rapier += performance.now() - t;
  }) as typeof world.step;
  const windows: Window[] = [];
  for (let i = 0; i < SECONDS * 60 && !match.winner; i++) {
    if (i % (WINDOW * 60) === 0) windows.push((w = { from: i / 60, tsRapier: 0, tsStep: 0, rustRapier: 0, rustStep: 0, steps: 0, replayed: 0, replays: 0, samples: [] }));
    const before = rapier;
    replay = REPLAYS > 0 && i % 20 === 0;
    const t0 = performance.now();
    sim.step();
    w!.tsStep += performance.now() - t0;
    w!.tsRapier += rapier - before;
    w!.steps++;
    if (i % 60 === 59) w!.samples.push(sample(sim));
  }
  sim.dispose();
  return windows;
}

async function playRust(seed: number, windows: Window[]): Promise<void> {
  const path = env.PHYSICS_WASM ?? simWasmPath();
  if (!path) return;
  const module = await loadSimModule(readFileSync(path));
  const world = new NativeWorld(module, seed);
  if (ARENA !== "depot") world.loadArena(ARENA);
  const mode = GAME_MODES.battle;
  const entries = world.draw(() => matchEntries(mode, PRESET_BOTS[seed % PRESET_BOTS.length]), seed);
  world.spawnTeams(entries);
  world.startMatch({ ...mode.match, timeLimit: SECONDS });
  const stages = world.m.x.sim_stage_count();
  let state = world.matchState();
  for (let i = 0; i < SECONDS * 60 && !state.winner; i++) {
    const w = windows[Math.floor(i / (WINDOW * 60))];
    const t0 = performance.now();
    for (let k = 0; k < stages; k++) {
      const t = performance.now();
      world.m.x.sim_stage(world.id, k);
      if (k === 4 && w) w.rustRapier += performance.now() - t;
    }
    world.drain();
    if (w) w.rustStep += performance.now() - t0;
    state = world.matchState();
  }
  world.dispose();
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const f1 = (x: number): string => x.toFixed(1);
const f3 = (x: number): string => x.toFixed(3);

function print(seed: number, windows: Window[]): void {
  const lines = [`${ARENA}, graine ${seed} (${path(env.PHYSICS_WASM ?? simWasmPath())})`];
  for (const w of windows) {
    if (!w.samples.length) continue;
    const avg = (pick: (s: Sample) => number): number => mean(w.samples.map(pick));
    const bodies = KINDS.map((k) => `${k} ${f1(avg((s) => s.bodies[k]))}/${f1(avg((s) => s.awake[k]))}`).join(", ");
    const colliders = f1(avg((s) => KINDS.reduce((n, k) => n + s.colliders[k], 0)));
    const by = new Map<string, number>();
    for (const s of w.samples) for (const [key, n] of Object.entries(s.touchingBy)) by.set(key, (by.get(key) ?? 0) + n / w.samples.length);
    const touching = [...by].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${f1(n)}`).join(", ");
    const sby = new Map<string, number>();
    for (const s of w.samples) for (const [key, n] of Object.entries(s.solverBy)) sby.set(key, (sby.get(key) ?? 0) + n / w.samples.length);
    const solver = [...sby].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${f1(n)}`).join(", ");
    const solverTotal = [...sby.values()].reduce((a, b) => a + b, 0);
    const ages = [0, 1, 2, 3].map((b) => `${f1(avg((s) => s.debrisAwakeByAge[b]))}/${f1(avg((s) => s.debrisByAge[b]))}`).join(" ");
    lines.push(
      `  ${String(w.from).padStart(3)} s : Rapier TS ${f3(w.tsRapier / w.steps)} ms (pas ${f3(w.tsStep / w.steps)}${w.replays ? `, rejoué ${f3(w.replayed / w.replays)} ms` : ""}),`
        + ` Rust ${f3(w.rustRapier / w.steps)} ms (pas ${f3(w.rustStep / w.steps)}) · corps (total/éveillés) ${bodies}`
        + ` · colliders ${colliders} · paires ${f1(avg((s) => s.pairs))}, en contact ${f1(avg((s) => s.touching))} (${touching})`
        + ` · points du solveur ${f1(solverTotal)} (${solver})`
        + ` · débris éveillés par âge ${ages}`
        + ` · morceaux et épaves éveillés : sur roues ${f1(avg((s) => s.wheeledAwake))}, immobiles ${f1(avg((s) => s.stillAwake))}`,
    );
  }
  console.log(lines.join("\n"));
}

const path = (p: string | null): string => (p ? p.replace(process.cwd(), ".") : "pas de Rust");

beforeAll(async () => {
  await initPhysics();
});

it.runIf(env.PHYSICS_REPORT)("ce que Rapier a à faire au fil des batailles", { timeout: 7_200_000 }, async () => {
  for (const seed of SEEDS) {
    const windows = playTs(seed);
    if (env.PHYSICS_RUST !== "0") await playRust(seed, windows);
    print(seed, windows);
  }
});
