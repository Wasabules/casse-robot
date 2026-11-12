// L'empreinte des sources de la simulation compilée (crates/, Cargo.toml, Cargo.lock,
// rust-toolchain.toml) : le module WebAssembly embarqué (src/shared/native/wasm.ts) la garde, et
// tests/native.test.ts refuse un module construit sur d'autres sources (npm run native).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function sourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(rs|toml)$/.test(name)) files.push(path);
    }
  };
  walk(join(root, "crates"));
  for (const name of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) if (existsSync(join(root, name))) files.push(join(root, name));
  return files;
}

/** Empreinte (SHA-256, 16 chiffres) des sources, fins de ligne ramenées à `\n` (un dépôt cloné sous Windows). */
export function sourceHash(root) {
  const hash = createHash("sha256");
  for (const file of sourceFiles(root)) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
