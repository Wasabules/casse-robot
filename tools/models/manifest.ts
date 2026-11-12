import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CAR_HALF, propDef, PROP_TYPES, type PropType } from "../../src/shared/catalog/props";
import { readGlb } from "./glb";

/*
 * Le manifeste des modèles glTF : la liste des fichiers de public/models/ que le jeu doit lire, pour
 * qu'il sache sans rien demander au réseau quels accessoires ont un modèle (un fichier absent : le
 * modèle fait par le code). `npm run models` (tools/models/build.ts) l'écrit dans
 * src/client/render/propModelFiles.ts après avoir vérifié chaque fichier ; tests/models.test.ts
 * refuse un manifeste qui n'est plus celui que ferait cet outil. Les conventions : docs/models.md.
 */

/** Le dossier des modèles (servi tel quel), et le manifeste qu'en fait cet outil (depuis la racine du dépôt). */
export const MODELS_DIR = "public/models";
export const MANIFEST_FILE = "src/client/render/propModelFiles.ts";

/** Un modèle d'accessoire : son type, son chemin dans la page, une empreinte de son contenu, sa boîte englobante. */
export interface ModelEntry {
  readonly type: PropType;
  readonly file: string;
  readonly hash: string;
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] } | null;
}

/** Ce que l'outil a trouvé : les modèles lisibles, les problèmes (un fichier refusé), des remarques (ses mesures). */
export interface ModelScan {
  readonly entries: readonly ModelEntry[];
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

/** Des fichiers qu'on peut laisser à côté des modèles (crédits, licences) : ignorés. */
const NOTES = /\.(md|txt)$/i;

/** Parcourt public/models/ depuis la racine du dépôt `root`. */
export function scanModels(root: string): ModelScan {
  const entries: ModelEntry[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const dir = join(root, MODELS_DIR);
  if (!existsSync(dir)) return { entries, problems, notes };
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (NOTES.test(name) && statSync(path).isFile()) continue;
    if (name !== "props" || !statSync(path).isDirectory()) {
      problems.push(`${MODELS_DIR}/${name} : le jeu ne lit que ${MODELS_DIR}/props/<type>.glb`);
      continue;
    }
    for (const file of readdirSync(path).sort()) {
      const where = `${MODELS_DIR}/props/${file}`;
      if (NOTES.test(file)) continue;
      const match = /^(.+)\.glb$/.exec(file);
      if (!match || statSync(join(path, file)).isDirectory()) {
        problems.push(`${where} : un modèle est un fichier .glb (glTF binaire, tout en un fichier)`);
        continue;
      }
      const type = match[1];
      if (!Object.hasOwn(PROP_TYPES, type)) {
        problems.push(`${where} : « ${type} » n'est pas un type d'accessoire (types : ${Object.keys(PROP_TYPES).join(", ")})`);
        continue;
      }
      const bytes = new Uint8Array(readFileSync(join(path, file)));
      const report = readGlb(bytes);
      if (report.problems.length) {
        problems.push(...report.problems.map((p) => `${where} : ${p}`));
        continue;
      }
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
      entries.push({ type: type as PropType, file: `models/props/${file}`, hash, bounds: report.bounds });
      notes.push(`${where} : ${measure(type as PropType, report.bounds)}`);
    }
  }
  return { entries, problems, notes };
}

const cm = (x: number): string => `${(x * 100).toFixed(0)} cm`;
const size = (min: readonly number[], max: readonly number[]): string => [0, 1, 2].map((k) => (max[k] - min[k]).toFixed(2)).join(" × ") + " m";

/** Ses dimensions, comparées à la forme de l'accessoire (sa collision). */
function measure(type: PropType, bounds: ModelEntry["bounds"]): string {
  if (!bounds) return "boîte englobante inconnue";
  const shape = propDef(type).shape;
  const model = `${size(bounds.min, bounds.max)} (x, y, z)`;
  if (shape.kind === "slab") {
    const half = type === "car" || type === "wreck" ? CAR_HALF : null;
    const spot = half ? `, ${size([-half.x, -half.y, -half.z], [half.x, half.y, half.z])} pour une voiture` : "";
    return `${model} ; étiré aux dimensions de chaque emplacement${spot}`;
  }
  const [rx, h, rz] = shape.kind === "box" ? [shape.half, shape.half * 2, shape.half] : [shape.radius, shape.halfHeight * 2, shape.radius];
  return `${model}, base à y = ${cm(bounds.min[1])} ; collision : ${size([-rx, 0, -rz], [rx, h, rz])}`;
}

/** Le texte du manifeste (src/client/render/propModelFiles.ts). */
export function manifestText(entries: readonly ModelEntry[]): string {
  const lines = entries.map((e) => `  ${e.type}: { file: "${e.file}", hash: "${e.hash}" },`);
  return `import type { PropType } from "../../shared/catalog/props";

/*
 * Les modèles glTF des accessoires livrés avec le jeu (public/models/props/<type>.glb), et une
 * empreinte de chacun : elle change avec le fichier, et le navigateur ne garde pas l'ancien. Fait
 * par \`npm run models\` (tools/models/) d'après le dossier : ne pas modifier à la main ;
 * tests/models.test.ts vérifie qu'il est à jour. Sans fichier pour son type, un accessoire garde le
 * modèle fait par le code (render/propModels.ts). Les conventions : docs/models.md.
 */
export const PROP_MODEL_FILES: { readonly [T in PropType]?: { readonly file: string; readonly hash: string } } = {${lines.length ? `\n${lines.join("\n")}\n` : ""}};
`;
}
