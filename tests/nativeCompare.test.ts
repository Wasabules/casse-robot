import { readFileSync } from "node:fs";
import { it } from "vitest";
import { isArenaId, type ArenaKey } from "../src/shared/arena/layout";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import { loadSimModule } from "../src/shared/native/simModule";
import { NativeWorld } from "../src/shared/native/world";

/*
 * Deux modules de la simulation Rust côte à côte (mesure, pas un essai) : `COMPARE_A=<module>
 * COMPARE_B=<module> npx vitest run tests/nativeCompare.test.ts --silent=false` (par exemple le module
 * du dépôt, src/shared/native/casse-sim.wasm, et une sonde, target/probe/wasm32-unknown-unknown/release/
 * casse_sim.wasm). Les mêmes batailles (le mode Bataille de `npm run battle`, mêmes graines, sans fin
 * de partie), jouées pas à pas l'une à côté de l'autre, en alternant laquelle avance la première : la
 * charge de la machine (d'autres travaux) pèse autant sur les deux. Le pas entier et celui de Rapier
 * (l'étape 4 de `Sim::stage`), en temps écoulé et en temps du processeur (`process.cpuUsage` : celui
 * que le processus a vraiment eu, compté par tranches de 15,6 ms sous Windows, juste sur des milliers
 * de pas), cumulés sur les graines jouées. COMPARE_ARENA (le Dépôt par défaut), COMPARE_SEEDS (1,2,3,4),
 * COMPARE_SECONDS (240). Deux modules qui jouent autrement divergent : leurs batailles ne sont pas les
 * mêmes, d'où plusieurs graines.
 */

const env = process.env;
const ARENA: ArenaKey = isArenaId(env.COMPARE_ARENA) ? env.COMPARE_ARENA : "depot";

const cpu = (): number => {
  const u = process.cpuUsage();
  return u.user + u.system;
};

it.runIf(env.COMPARE_A && env.COMPARE_B)("deux modules Rust côte à côte", { timeout: 7_200_000 }, async () => {
  const modules = await Promise.all([env.COMPARE_A!, env.COMPARE_B!].map(async (p) => loadSimModule(readFileSync(p))));
  const seeds = (env.COMPARE_SEEDS ?? "1,2,3,4").split(",").map(Number);
  const seconds = Number(env.COMPARE_SECONDS ?? 240);
  const wall = [0, 0];
  const wallRapier = [0, 0];
  const proc = [0, 0];
  const procRapier = [0, 0];
  let steps = 0;
  for (const seed of seeds) {
    const worlds = modules.map((m) => {
      const w = new NativeWorld(m, seed);
      if (ARENA !== "depot") w.loadArena(ARENA);
      const mode = GAME_MODES.battle;
      w.spawnTeams(w.draw(() => matchEntries(mode, PRESET_BOTS[seed % PRESET_BOTS.length]), seed));
      w.startMatch({ ...mode.match, timeLimit: 10_000, scoreToWin: 10_000 });
      return w;
    });
    const stages = modules[0].x.sim_stage_count();
    const one = (k: number): void => {
      const w = worlds[k];
      const t0 = performance.now();
      const c0 = cpu();
      for (let s = 0; s < stages; s++) {
        if (s !== 4) {
          w.m.x.sim_stage(w.id, s);
          continue;
        }
        const t = performance.now();
        const c = cpu();
        w.m.x.sim_stage(w.id, s);
        wallRapier[k] += performance.now() - t;
        procRapier[k] += cpu() - c;
      }
      w.drain();
      wall[k] += performance.now() - t0;
      proc[k] += cpu() - c0;
    };
    for (let i = 0; i < seconds * 60; i++) {
      if (i % 2) {
        one(0);
        one(1);
      } else {
        one(1);
        one(0);
      }
      steps++;
    }
    for (const w of worlds) w.dispose();
    const ms = (x: number): string => (x / steps).toFixed(3);
    const gap = (a: number, b: number): string => `${b < a ? "" : "+"}${((100 * (b - a)) / a).toFixed(1)} %`;
    console.log(
      `${ARENA}, jusqu'à la graine ${seed} : A pas ${ms(wall[0])} ms (Rapier ${ms(wallRapier[0])}), B pas ${ms(wall[1])} ms (Rapier ${ms(wallRapier[1])}) ;`
        + ` processeur : A pas ${ms(proc[0] / 1000)} ms (Rapier ${ms(procRapier[0] / 1000)}), B pas ${ms(proc[1] / 1000)} ms (Rapier ${ms(procRapier[1] / 1000)})`
        + ` ; B contre A : Rapier ${gap(wallRapier[0], wallRapier[1])} écoulé, ${gap(procRapier[0], procRapier[1])} processeur`,
    );
  }
});
