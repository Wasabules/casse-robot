import { initNative } from "../../shared/native/native";
import { NativeSession } from "../../shared/native/session";
import { loadSimModule, type SimModule } from "../../shared/native/simModule";
import type { SessionLike } from "../../shared/net/session";

/*
 * La session solo sur la simulation portée en Rust (`NativeSession`) : un morceau du Worker
 * (client/sim/simWorker.ts) chargé à la demande, sans la simulation du TypeScript ni Rapier pour le
 * JavaScript (tests/architecture.test.ts y veille). Il télécharge la simulation compilée entière
 * (`url` : casse-sim.wasm, un fichier à part) ; le petit module embarqué (src/shared/native/wasm.ts :
 * les recherches de chemin de la grille de navigation, que le TypeScript fait pour donner l'arène au
 * module) s'initialise sans Rapier. Rend aussi quand le module a été téléchargé, puis instancié (`now`).
 */
export async function startRustSession(url: string, now: () => number): Promise<{ session: SessionLike; module: SimModule; fetched: number; instantiated: number }> {
  const [bytes] = await Promise.all([
    fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`simulation Rust introuvable (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    }),
    initNative(),
  ]);
  const fetched = now();
  const module = await loadSimModule(bytes);
  const instantiated = now();
  return { session: new NativeSession(module, now), module, fetched, instantiated };
}
