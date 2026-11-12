import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * La sonde de la simulation compilée (crates/casse-sim, fonctionnalités `physics` et `sim`), si elle
 * est construite : `npm run native -- --probe` (profil release) ou `npm run native -- --probe --dev`
 * (profil probe-dev, construit vite pour itérer, mêmes calculs flottants). La plus récente des deux
 * qui exporte `needs` (une sonde construite avant la fonctionnalité `sim` n'a que la physique) ; null
 * s'il n'y en a pas (les tests qui s'en servent sont alors sautés : il faut Rust).
 */
export function probePath(needs?: string): string | null {
  const dir = join(process.cwd(), "target", "probe", "wasm32-unknown-unknown");
  const builds = ["release", "probe-dev"].map((profile) => join(dir, profile, "casse_sim.wasm")).filter((path) => existsSync(path));
  builds.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return builds.find((path) => !needs || WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(path))).some((e) => e.name === needs)) ?? null;
}
