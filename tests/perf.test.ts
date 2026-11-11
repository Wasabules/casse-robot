import { afterAll, expect, it, vi } from "vitest";
import { BATTLE_ROSTER } from "../src/shared/design/presets";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/**
 * Budget moyen d'un pas de simulation (ms), très large : ce test ne repère que les grosses
 * régressions. Dans `npm test`, il tourne en même temps que les autres fichiers de test (dont les
 * batailles et le réseau, qui simulent eux aussi douze robots), et mesure donc bien plus que
 * `npm run bench` seul (environ 4,7 ms pour douze robots).
 */
const BUDGET_MS = 30;

afterAll(() => vi.restoreAllMocks());

/**
 * Coût d'un pas de simulation pendant 20 s de combat à 12 robots, détaillé par étape (celles de
 * Simulation.step). `npm run bench` l'affiche.
 */
it("un pas de combat à 12 robots tient dans le budget", async () => {
  await initPhysics();
  seedRandom(11);
  const sim = new Simulation();
  spawnWave(sim, BATTLE_ROSTER);
  sim.profile = { now: () => performance.now(), times: {} };
  const steps = 20 * 60;
  let colliders = 0;
  for (let i = 0; i < steps; i++) {
    sim.step();
    colliders += sim.world.colliders.len();
  }
  const time = sim.profile.times;
  // Les sous-étapes (« ia › tourelles ») sont déjà comptées dans leur étape
  const total = Object.entries(time).reduce((s, [key, x]) => (key.includes("›") ? s : s + x), 0) / steps;
  console.log(`Pas moyen : ${total.toFixed(2)} ms (${Math.round(colliders / steps)} colliders, ${sim.destroyedCount} blocs détruits)`);
  for (const [key, t] of Object.entries(time)) console.log(`  ${key.padEnd(24)} ${(t / steps).toFixed(3)} ms`);
  sim.dispose();
  expect(total).toBeLessThan(BUDGET_MS);
});
