import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { crateModel } from "./crate";
import { writeGlb } from "./glb";
import { MANIFEST_FILE, manifestText, MODELS_DIR, scanModels } from "./manifest";

/*
 * `npm run models`, depuis la racine du dépôt : vérifie les modèles glTF de public/models/ et écrit
 * leur manifeste (src/client/render/propModelFiles.ts). À relancer après avoir ajouté, changé ou
 * retiré un modèle : tests/models.test.ts refuse un manifeste qui n'est plus à jour. Un fichier
 * illisible est signalé et laissé de côté (code de sortie 1).
 * `npm run models -- example` écrit d'abord le modèle d'exemple (la caisse, tools/models/crate.ts).
 */

if (process.argv.includes("example")) {
  const file = resolve(MODELS_DIR, "props", "crate.glb");
  mkdirSync(dirname(file), { recursive: true });
  const bytes = writeGlb(crateModel());
  writeFileSync(file, bytes);
  console.log(`${MODELS_DIR}/props/crate.glb : ${(bytes.length / 1024).toFixed(1)} Ko (modèle d'exemple)`);
}

const scan = scanModels(resolve("."));
for (const note of scan.notes) console.log(note);
for (const problem of scan.problems) console.error(`✗ ${problem}`);
writeFileSync(resolve(MANIFEST_FILE), manifestText(scan.entries));
console.log(`${MANIFEST_FILE} : ${scan.entries.length} modèle(s)`);
process.exit(scan.problems.length ? 1 : 0);
