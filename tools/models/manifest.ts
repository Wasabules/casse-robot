import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { blockDef, BLOCK_TYPES } from "../../src/shared/catalog/blocks";
import { CAR_HALF, propDef, PROP_TYPES, type PropType } from "../../src/shared/catalog/props";
import { wheelDef, WHEEL_TYPES, type WheelType } from "../../src/shared/catalog/wheels";
import { BLOCK_SIZE } from "../../src/shared/config";
import { headLift } from "../../src/shared/design/clearance";
import { readGlb } from "./glb";

/*
 * Le manifeste des modèles glTF : la liste des fichiers de public/models/ que le jeu doit lire
 * (accessoires, blocs, têtes de tourelle, roues), pour qu'il sache sans rien demander au réseau
 * quelles pièces ont un modèle (un fichier absent : le modèle fait par le code). `npm run models`
 * (tools/models/build.ts) l'écrit dans src/client/render/modelFiles.ts après avoir vérifié chaque
 * fichier ; tests/models.test.ts refuse un manifeste qui n'est plus celui que ferait cet outil. Les
 * conventions : docs/models.md.
 */

/** Le dossier des modèles (servi tel quel), et le manifeste qu'en fait cet outil (depuis la racine du dépôt). */
export const MODELS_DIR = "public/models";
export const MANIFEST_FILE = "src/client/render/modelFiles.ts";

/** Les familles de modèles : chacune son dossier (public/models/<famille>/<type>.glb). */
export const FAMILIES = ["props", "blocks", "heads", "wheels"] as const;
export type ModelFamily = (typeof FAMILIES)[number];

/** Un modèle : sa famille, son type, son chemin dans la page, une empreinte de son contenu, sa boîte englobante. */
export interface ModelEntry {
  readonly family: ModelFamily;
  readonly type: string;
  readonly file: string;
  readonly hash: string;
  readonly bounds: Bounds | null;
}

type Bounds = { readonly min: readonly number[]; readonly max: readonly number[] };

/** Ce que l'outil a trouvé : les modèles lisibles, les problèmes (un fichier refusé), des remarques (ses mesures). */
export interface ModelScan {
  readonly entries: readonly ModelEntry[];
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

/** Ce que l'outil sait d'une famille : ses types, ceux qui ne peuvent pas avoir de modèle, ce qu'il mesure d'un modèle. */
interface Family {
  /** Ce qu'est une pièce de la famille, pour les messages (« un type d'accessoire »). */
  readonly what: string;
  readonly types: readonly string[];
  /** Pourquoi ce type (de la famille) ne prend pas de modèle, ou null. */
  readonly refuse: (type: string) => string | null;
  /** Ses dimensions, comparées à ce qu'en attend le jeu. */
  readonly measure: (type: string, bounds: Bounds) => string;
}

const TURRETS = Object.keys(BLOCK_TYPES).filter((type) => blockDef(type as keyof typeof BLOCK_TYPES).turret);

const FAMILY: Record<ModelFamily, Family> = {
  props: { what: "un type d'accessoire", types: Object.keys(PROP_TYPES), refuse: () => null, measure: (type, b) => measureProp(type as PropType, b) },
  blocks: {
    what: "un type de bloc",
    types: Object.keys(BLOCK_TYPES),
    refuse: (type) => (blockDef(type as keyof typeof BLOCK_TYPES).aero ? "une aile ou une gouverne est dessinée par le jeu d'après ses voisines (son profil) : pas de modèle" : null),
    measure: (_, b) => measureBlock(b),
  },
  heads: { what: "une tourelle", types: TURRETS, refuse: () => null, measure: (type, b) => measureHead(type, b) },
  wheels: {
    what: "un type de roue",
    types: Object.keys(WHEEL_TYPES),
    refuse: (type) => (wheelDef(type as WheelType).track ? "un galet de chenille garde son modèle (la bande et ses patins s'accordent à lui)" : null),
    measure: (type, b) => measureWheel(type as WheelType, b),
  },
};

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
    const family = (FAMILIES as readonly string[]).includes(name) ? (name as ModelFamily) : null;
    if (!family || !statSync(path).isDirectory()) {
      problems.push(`${MODELS_DIR}/${name} : le jeu ne lit que ${MODELS_DIR}/<famille>/<type>.glb (familles : ${FAMILIES.join(", ")})`);
      continue;
    }
    const rules = FAMILY[family];
    for (const file of readdirSync(path).sort()) {
      const where = `${MODELS_DIR}/${family}/${file}`;
      if (NOTES.test(file)) continue;
      const match = /^(.+)\.glb$/.exec(file);
      if (!match || statSync(join(path, file)).isDirectory()) {
        problems.push(`${where} : un modèle est un fichier .glb (glTF binaire, tout en un fichier)`);
        continue;
      }
      const type = match[1];
      if (!rules.types.includes(type)) {
        problems.push(`${where} : « ${type} » n'est pas ${rules.what} (types : ${rules.types.join(", ")})`);
        continue;
      }
      const refused = rules.refuse(type);
      if (refused) {
        problems.push(`${where} : ${refused}`);
        continue;
      }
      const bytes = new Uint8Array(readFileSync(join(path, file)));
      const report = readGlb(bytes);
      if (report.problems.length) {
        problems.push(...report.problems.map((p) => `${where} : ${p}`));
        continue;
      }
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
      entries.push({ family, type, file: `models/${family}/${file}`, hash, bounds: report.bounds });
      notes.push(`${where} : ${report.bounds ? rules.measure(type, report.bounds) : "boîte englobante inconnue"}`);
    }
  }
  return { entries, problems, notes };
}

const cm = (x: number): string => `${(x * 100).toFixed(0)} cm`;
const m = (x: number): string => `${x.toFixed(2)} m`;
const size = (min: readonly number[], max: readonly number[]): string => [0, 1, 2].map((k) => (max[k] - min[k]).toFixed(2)).join(" × ") + " m";

/** Les dimensions d'un accessoire, comparées à sa forme (sa collision). */
function measureProp(type: PropType, bounds: Bounds): string {
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

/** Les dimensions d'un bloc, comparées à sa case (±0,25 m autour de l'origine). */
function measureBlock(bounds: Bounds): string {
  const half = BLOCK_SIZE / 2;
  const over = Math.max(0, ...bounds.max.map((v) => v - half), ...bounds.min.map((v) => -half - v));
  const fit = over > 0.005 ? `dépasse de sa case de ${cm(over)} au plus` : "dans sa case";
  return `${size(bounds.min, bounds.max)} (x, y, z) ; ${fit} (la case : ±${cm(half)} autour de l'origine)`;
}

/** Les dimensions d'une tête, comparées à celle du jeu (sa zone touchable) et à la bouche de son canon. */
function measureHead(type: string, bounds: Bounds): string {
  const turret = blockDef(type as keyof typeof BLOCK_TYPES).turret!;
  const [w, h, d] = turret.head;
  const barrel = turret.fixed === "down" ? "" : ` ; va jusqu'à z = ${m(bounds.max[2])}, bouche du canon attendue à z = ${m(turret.barrel)}`;
  return `${size(bounds.min, bounds.max)} (x, y, z)${barrel} ; la tête du jeu : ${size([-w / 2, -h / 2, -d / 2], [w / 2, h / 2, d / 2])}, son axe à ${m(headLift(turret))} au-dessus du centre du bloc`;
}

/** Les dimensions d'une roue, comparées à celles du catalogue ; elle doit être symétrique (montée à gauche comme à droite). */
function measureWheel(type: WheelType, bounds: Bounds): string {
  const def = wheelDef(type);
  const radius = Math.max(...[1, 2].flatMap((k) => [Math.abs(bounds.min[k]), Math.abs(bounds.max[k])]));
  const width = bounds.max[0] - bounds.min[0];
  const symmetric = Math.abs(bounds.min[0] + bounds.max[0]) < 0.01 ? "symétrique" : `pas symétrique autour du moyeu (x de ${m(bounds.min[0])} à ${m(bounds.max[0])}) : la même roue se monte à gauche et à droite`;
  return `rayon ${m(radius)} (le jeu : ${m(def.radius)}), largeur ${m(width)} (le jeu : ${m(def.width)}), ${symmetric}`;
}

/** Les types de chaque famille dans le manifeste. */
const KEY_TYPES: Record<ModelFamily, { constant: string; type: string }> = {
  props: { constant: "PROP_MODEL_FILES", type: "PropType" },
  blocks: { constant: "BLOCK_MODEL_FILES", type: "BlockType" },
  heads: { constant: "HEAD_MODEL_FILES", type: "TurretBlockType" },
  wheels: { constant: "WHEEL_MODEL_FILES", type: "WheelType" },
};

/** Le texte du manifeste (src/client/render/modelFiles.ts). */
export function manifestText(entries: readonly ModelEntry[]): string {
  const constants = FAMILIES.map((family) => {
    const { constant, type } = KEY_TYPES[family];
    const lines = entries.filter((e) => e.family === family).map((e) => `  ${e.type}: { file: "${e.file}", hash: "${e.hash}" },`);
    return `export const ${constant}: { readonly [T in ${type}]?: ModelFile } = {${lines.length ? `\n${lines.join("\n")}\n` : ""}};`;
  });
  return `import type { BlockType } from "../../shared/catalog/blocks";
import type { PropType } from "../../shared/catalog/props";
import type { WheelType } from "../../shared/catalog/wheels";
import type { TurretBlockType } from "./models";

/*
 * Les modèles glTF livrés avec le jeu (public/models/<famille>/<type>.glb : accessoires, blocs,
 * têtes de tourelle, roues), et une empreinte de chacun : elle change avec le fichier, et le
 * navigateur ne garde pas l'ancien. Fait par \`npm run models\` (tools/models/) d'après le dossier :
 * ne pas modifier à la main ; tests/models.test.ts vérifie qu'il est à jour. Sans fichier pour son
 * type, une pièce garde le modèle fait par le code (render/propModels.ts, render/partModels.ts).
 * Les conventions : docs/models.md.
 */

/** Un fichier de modèle : son chemin dans la page, une empreinte de son contenu. */
export interface ModelFile {
  readonly file: string;
  readonly hash: string;
}

${constants.join("\n\n")}
`;
}
