// Deux bilans de batailles (BATTLE_RECORD, tests/battle.test.ts) sont-ils les mêmes, à leur date et
// au coût d'un pas près ? Les batailles de référence rejouées sur la simulation portée en Rust doivent
// donner exactement celles du TypeScript (tests/reference/battles-depot.json).
//
//   node tools/native/same-battles.mjs tests/reference/battles-depot.json rust.json
import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2).map((file) => JSON.parse(readFileSync(file, "utf8")));
if (!a || !b) throw new Error("deux bilans : node tools/native/same-battles.mjs <référence> <autre>");
for (const report of [a, b]) {
  delete report.date;
  delete report.stepMs;
}

/** Le premier chemin où les deux valeurs diffèrent, ou null. */
function difference(x, y, path) {
  if (Object.is(x, y)) return null;
  if (x && y && typeof x === "object" && typeof y === "object") {
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const d = difference(x[key], y[key], `${path}.${key}`);
      if (d) return d;
    }
    return null;
  }
  return `${path} : ${JSON.stringify(x)} contre ${JSON.stringify(y)}`;
}

const d = difference(a, b, "bilan");
if (d) {
  console.error(`Les batailles diffèrent : ${d}`);
  process.exit(1);
}
console.log("Les mêmes batailles (à la date et au coût d'un pas près).");
