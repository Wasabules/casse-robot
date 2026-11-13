import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { SimModule, type SimExports } from "../src/shared/native/simModule";
import { initPhysics } from "../src/shared/sim/simulation";
import { caseSeed, readDump, roomCase, sessionCase, type CaseResult } from "./parity";
import { simWasmPath } from "./probe";

/*
 * Parité longue et aléatoire (tests/parity.ts) : des sessions solo et des salles du serveur tirées
 * au hasard, jouées côte à côte sur la simulation du TypeScript et sur celle portée en Rust, qui
 * doivent rendre les mêmes images, octet pour octet. Une version courte tourne dans `npm test` ; la
 * longue chaque nuit (.github/workflows/nightly.yml) :
 *
 *   PARITY_CASES=40 PARITY_SECONDS=60 PARITY_MINUTES=50 PARITY_SEED=123 npx vitest run tests/nativeParity.test.ts --silent=false
 *
 * PARITY_SEED : la graine de la série (un nombre fixe par défaut ; la nuit, la date) ;
 * PARITY_CASES : le nombre de cas (un sur quatre est une salle) ; PARITY_SECONDS : la durée d'une
 * session (une salle dure le double) ; PARITY_MINUTES : pas de nouveau cas au-delà ; PARITY_CASE :
 * rejouer ce seul cas de la série ; PARITY_REPLAY : rejouer les commandes écrites d'un cas qui a
 * échoué (artifacts/parity/<cas>.json). Un cas qui échoue dit la première image qui diffère (le
 * premier événement, ou le premier champ de l'instantané) et de quoi le rejouer. Sauté sans la
 * simulation compilée entière.
 */

const WASM = simWasmPath();
const env = process.env;
const SEED = Number(env.PARITY_SEED ?? 20261113) >>> 0;
const CASES = Number(env.PARITY_CASES ?? 5);
const SECONDS = Number(env.PARITY_SECONDS ?? 12);
const MINUTES = Number(env.PARITY_MINUTES ?? Infinity);
const ONLY = env.PARITY_CASE === undefined ? null : Number(env.PARITY_CASE);
const LONG = env.PARITY_CASES !== undefined || env.PARITY_SECONDS !== undefined || env.PARITY_REPORT !== undefined;

let module: SimModule;

/** Un module neuf (après un cas qui a échoué : une panique laisse le sien dans un état quelconque). */
async function freshModule(): Promise<SimModule> {
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM!), {});
  return new SimModule(instance.exports as unknown as SimExports);
}

beforeAll(async () => {
  await initPhysics();
  if (WASM) module = await freshModule();
});

/** Un cas sur quatre est une salle du serveur (le quatrième, le huitième…). */
const isRoom = (k: number): boolean => k % 4 === 3;

function runCase(k: number): CaseResult {
  const seed = caseSeed(SEED, k);
  return isRoom(k) ? roomCase(module, seed, SECONDS * 2) : sessionCase(module, seed, SECONDS);
}

describe.skipIf(!WASM)("Parité aléatoire : la simulation portée en Rust rend les mêmes images que celle du TypeScript", () => {
  it.runIf(env.PARITY_REPLAY)("un cas écrit, rejoué", { timeout: 3_600_000 }, () => {
    const dump = readDump(env.PARITY_REPLAY!);
    const r = dump.kind === "session" ? sessionCase(module, dump.seed, 0, dump.cmds) : roomCase(module, dump.seed, 0, dump);
    console.log(`${r.title} : ${r.seconds.toFixed(1)} s, ${r.frames} images`);
    expect(r.difference, `${r.title}, commande ${r.at}`).toBeNull();
  });

  it.skipIf(env.PARITY_REPLAY)(`${ONLY !== null ? `le cas ${ONLY}` : `${CASES} cas`} de la série ${SEED} : sessions solo (modes, arènes, cartes, robots du garage, commandes du pilote) et salles qui enchaînent les parties`, { timeout: 4 * 3_600_000 }, async () => {
    const started = performance.now();
    const failures: string[] = [];
    const seen: Record<string, number> = {};
    let seconds = 0;
    let frames = 0;
    let played = 0;
    const indices = ONLY !== null ? [ONLY] : Array.from({ length: CASES }, (_, k) => k);
    for (const k of indices) {
      if ((performance.now() - started) / 60_000 > MINUTES) break;
      const t0 = performance.now();
      const r = runCase(k);
      played++;
      seconds += r.seconds;
      frames += r.frames;
      for (const [e, n] of Object.entries(r.seen)) seen[e] = (seen[e] ?? 0) + n;
      if (LONG) console.log(`cas ${k} (${((performance.now() - t0) / 1000).toFixed(1)} s) : ${r.title} — ${r.seconds.toFixed(1)} s de jeu, ${r.frames} images${r.difference ? " : ÉCART" : ""}`);
      if (r.difference) {
        module = await freshModule();
        failures.push(
          `cas ${k} de la série ${SEED} (${r.title}), commande ${r.at} : ${r.difference}\n` +
          `  rejouer : PARITY_SEED=${SEED} PARITY_CASE=${k} npx vitest run tests/nativeParity.test.ts --silent=false` +
          (r.dump ? `\n  ou ses commandes : PARITY_REPLAY=${r.dump} npx vitest run tests/nativeParity.test.ts --silent=false` : ""),
        );
      }
    }
    if (LONG) {
      console.log(`${played} cas, ${seconds.toFixed(0)} s de jeu, ${frames} images, en ${((performance.now() - started) / 60_000).toFixed(1)} min`);
      console.log(`vu : ${Object.entries(seen).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(", ")}`);
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
    // Les cas ont vraiment joué : des robots détruits, des tirs, des parties
    expect(frames).toBeGreaterThan(100 * played);
    if (ONLY === null && played >= 4) {
      expect(seen.shot ?? 0).toBeGreaterThan(0);
      expect(seen.bot ?? 0).toBeGreaterThan(0);
    }
  });
});
