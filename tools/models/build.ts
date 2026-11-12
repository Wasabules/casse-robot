import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { crateModel } from "./crate";
import { writeGlb, type GlbModel } from "./glb";
import { MANIFEST_FILE, manifestText, MODELS_DIR, scanModels, type ModelFamily } from "./manifest";
import { armorModel, cannonHeadModel, wheelModel } from "./parts";

/*
 * `npm run models`, depuis la racine du dépôt : vérifie les modèles glTF de public/models/
 * (accessoires, blocs, têtes de tourelle, roues) et écrit leur manifeste
 * (src/client/render/modelFiles.ts). À relancer après avoir ajouté, changé ou retiré un modèle :
 * tests/models.test.ts refuse un manifeste qui n'est plus à jour. Un fichier illisible est signalé
 * et laissé de côté (code de sortie 1).
 * `npm run models -- example` écrit d'abord les modèles d'exemple livrés avec le jeu (la caisse,
 * tools/models/crate.ts) ; `npm run models -- example all`, aussi ceux qui ne le sont pas (un
 * blindage, une tête de canon, une roue : tools/models/parts.ts), pour les essayer dans le jeu.
 */

/** Les modèles d'exemple faits par le code ; `shipped` : livré avec le jeu (plus beau que le modèle que dessine le code). */
const EXAMPLES: readonly { family: ModelFamily; type: string; model: () => GlbModel; shipped: boolean }[] = [
  { family: "props", type: "crate", model: crateModel, shipped: true },
  { family: "blocks", type: "armor", model: armorModel, shipped: false },
  { family: "heads", type: "cannonTurret", model: cannonHeadModel, shipped: false },
  { family: "wheels", type: "standard", model: wheelModel, shipped: false },
];

if (process.argv.includes("example")) {
  const all = process.argv.includes("all");
  for (const example of EXAMPLES) {
    if (!example.shipped && !all) continue;
    const path = `${MODELS_DIR}/${example.family}/${example.type}.glb`;
    mkdirSync(dirname(resolve(path)), { recursive: true });
    const bytes = writeGlb(example.model());
    writeFileSync(resolve(path), bytes);
    console.log(`${path} : ${(bytes.length / 1024).toFixed(1)} Ko (modèle d'exemple)`);
  }
}

const scan = scanModels(resolve("."));
for (const note of scan.notes) console.log(note);
for (const problem of scan.problems) console.error(`✗ ${problem}`);
writeFileSync(resolve(MANIFEST_FILE), manifestText(scan.entries));
console.log(`${MANIFEST_FILE} : ${scan.entries.length} modèle(s)`);
process.exit(scan.problems.length ? 1 : 0);
