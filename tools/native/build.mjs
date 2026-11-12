// npm run native : construit la simulation compilée (crates/casse-sim, Rust) en WebAssembly, et
// l'embarque en base64 dans src/shared/native/wasm.ts (comme Rapier « compat ») : le même module
// sert la page, le Worker de la partie solo, le serveur Node et les tests, sans fichier à servir à
// part. Il faut Rust (rustup : la version de rust-toolchain.toml, et sa cible wasm32-unknown-unknown).
//
// `npm run native -- --probe` : la sonde de la physique (Rapier 0.36 compilé ici, fonctionnalité
// `physics`) dans target/probe/, pour tests/nativePhysics.test.ts ; rien n'est embarqué.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHash } from "./source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = "wasm32-unknown-unknown";
// (les chemins de la machine n'entrent pas dans le module : le même d'une machine à l'autre)
const flags = [`--remap-path-prefix=${ROOT}=.`, process.env.RUSTFLAGS ?? ""].join(" ").trim();
const probe = process.argv.includes("--probe");
const cargo = spawnSync("cargo", ["build", "-p", "casse-sim", "--release", "--target", TARGET, ...(probe ? ["--features", "physics"] : [])], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, RUSTFLAGS: flags, ...(probe ? { CARGO_TARGET_DIR: join(ROOT, "target", "probe") } : {}) },
});
if (cargo.status !== 0) process.exit(cargo.status ?? 1);
if (probe) {
  console.log(`» ${join(ROOT, "target", "probe", TARGET, "release", "casse_sim.wasm")} : la sonde de la physique`);
  process.exit(0);
}
const wasm = readFileSync(join(ROOT, "target", TARGET, "release", "casse_sim.wasm"));
const out = join(ROOT, "src", "shared", "native", "wasm.ts");
const lines = [
  "// Fait par npm run native (tools/native/build.mjs) : ne pas modifier à la main.",
  "// La simulation compilée (crates/casse-sim), en WebAssembly, encodée en base64.",
  `export const NATIVE_SOURCE = ${JSON.stringify(sourceHash(ROOT))};`,
  // (le module en base64 n'est pas du texte affiché : tests/i18nSource.test.ts l'ignore)
  `export const NATIVE_WASM = ${JSON.stringify(wasm.toString("base64"))}; // i18n-ignore`,
  "",
];
writeFileSync(out, lines.join("\n"));
console.log(`» ${out} : ${(wasm.length / 1024).toFixed(1)} Ko de WebAssembly (${sourceHash(ROOT)})`);
