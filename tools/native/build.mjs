// npm run native : construit la simulation compilée (crates/casse-sim, Rust) en WebAssembly, deux fois.
//
// - Le module embarqué (sans Rapier, ~54 Ko : les maths, le relief, la grille de passage), en base64
//   dans src/shared/native/wasm.ts (comme Rapier « compat ») : le même module sert la page, le Worker
//   de la partie solo, le serveur Node et les tests, sans fichier à servir à part.
// - La simulation entière (fonctionnalité `sim` : Rapier compris, ~3 Mo), dans un fichier à part,
//   src/shared/native/casse-sim.wasm : seuls le Worker de la partie solo et le serveur la chargent,
//   quand on choisit la simulation Rust (`?sim=rust`, `SIM=rust`) ; la page n'en a pas besoin, et ne la
//   télécharge pas. wasm.ts garde son empreinte (SHA-256) : tests/native.test.ts refuse un fichier qui
//   n'est pas celui que ces sources construisent.
//
// Il faut Rust (rustup : la version de rust-toolchain.toml, et sa cible wasm32-unknown-unknown).
//
// `npm run native -- --probe` : seulement la simulation entière (la sonde), dans target/probe/, pour
// tests/nativePhysics.test.ts, tests/nativeSim.test.ts et tests/nativeSession.test.ts ; rien n'est
// recopié. `--dev` : la même, construite vite (profil `probe-dev` : sans LTO, mêmes calculs flottants),
// pour itérer ; les tests prennent la plus récente des sondes et du fichier du dépôt (tests/probe.ts).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHash } from "./source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = "wasm32-unknown-unknown";
/** Le dossier de cargo, où sont les sources des dépendances (Rapier, parry…). */
const CARGO_HOME = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
// Les chemins de la machine n'entrent pas dans le module (le même d'une machine à l'autre, et rien de
// personnel dans un fichier publié) : ni celui du dépôt, ni celui des sources des dépendances, que les
// messages d'erreur de Rapier citent (« C:\Users\<nom>\.cargo\registry\src\… ») ; passés par
// CARGO_ENCODED_RUSTFLAGS (séparés par 0x1f), un chemin qui contient une espace reste entier
const flags = [`--remap-path-prefix=${ROOT}=.`, `--remap-path-prefix=${CARGO_HOME}=cargo`, ...(process.env.RUSTFLAGS ?? "").split(" ").filter(Boolean)];
const probe = process.argv.includes("--probe");
const dev = probe && process.argv.includes("--dev");

/** L'environnement sans une variable (RUSTFLAGS : ses options sont déjà dans `flags`). */
function omit(env, key) {
  const copy = { ...env };
  delete copy[key];
  return copy;
}

/** Construit le crate : la simulation entière (`sim`, dans target/probe/) ou le module embarqué ; le fichier fait. */
function build(full, profile) {
  const cargo = spawnSync("cargo", ["build", "-p", "casse-sim", ...(profile === "release" ? ["--release"] : ["--profile", profile]), "--target", TARGET, ...(full ? ["--features", "sim"] : [])], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...omit(process.env, "RUSTFLAGS"), CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"), ...(full ? { CARGO_TARGET_DIR: join(ROOT, "target", "probe") } : {}) },
  });
  if (cargo.status !== 0) process.exit(cargo.status ?? 1);
  return full ? join(ROOT, "target", "probe", TARGET, profile, "casse_sim.wasm") : join(ROOT, "target", TARGET, "release", "casse_sim.wasm");
}

const kb = (bytes) => `${(bytes.length / 1024).toFixed(1)} Ko`;

if (probe) {
  const built = build(true, dev ? "probe-dev" : "release");
  console.log(`» ${built} : la sonde (${kb(readFileSync(built))})`);
  process.exit(0);
}

const hash = sourceHash(ROOT);
const wasm = readFileSync(build(false, "release"));
const full = build(true, "release");
const sim = join(ROOT, "src", "shared", "native", "casse-sim.wasm");
copyFileSync(full, sim);
const simBytes = readFileSync(sim);
const digest = createHash("sha256").update(simBytes).digest("hex");
const out = join(ROOT, "src", "shared", "native", "wasm.ts");
const lines = [
  "// Fait par npm run native (tools/native/build.mjs) : ne pas modifier à la main.",
  "// La simulation compilée (crates/casse-sim), en WebAssembly, encodée en base64 ; et l'empreinte (SHA-256)",
  "// de la simulation entière, à part dans src/shared/native/casse-sim.wasm.",
  `export const NATIVE_SOURCE = ${JSON.stringify(hash)};`,
  `export const NATIVE_SIM_DIGEST = ${JSON.stringify(digest)};`,
  // (le module en base64 n'est pas du texte affiché : tests/i18nSource.test.ts l'ignore)
  `export const NATIVE_WASM = ${JSON.stringify(wasm.toString("base64"))}; // i18n-ignore`,
  "",
];
writeFileSync(out, lines.join("\n"));
console.log(`» ${out} : ${kb(wasm)} de WebAssembly (${hash})`);
console.log(`» ${sim} : la simulation entière (${kb(simBytes)}, ${digest.slice(0, 16)})`);
