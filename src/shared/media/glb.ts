import { utf8Text } from "./utf8";

/*
 * Ce que le jeu demande d'un modèle glTF binaire (.glb) pour le lire : l'en-tête, les morceaux, le
 * JSON, sa version, tout dans le fichier (ni tampon ni image à part), au moins un mesh, et pas
 * d'extension exigée que le lecteur du jeu n'a pas. Les mêmes contrôles servent aux modèles livrés
 * avec le jeu (`npm run models`, tools/models/glb.ts, qui les dit en français) et à ceux d'un paquet
 * de carte, qui viennent de n'importe qui (map/pack.ts : un problème est un code, que le client dit
 * dans la langue du joueur). Rien ici ne lève d'exception : un fichier abîmé est un problème.
 * Le format : https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html (« GLB File Format »).
 */

/**
 * Les extensions de glTF que lit le jeu : celles qu'un modèle (accessoire, bloc, tête, roue) peut
 * exiger. Le lecteur les charge à la demande (client/babylonGltf.ts : TypeScript y réclame chacune),
 * et un fichier qui en exige une autre est refusé. Pas la compression Draco ni meshopt, ni les
 * textures KTX2 : leurs décodeurs viendraient du CDN de Babylon (docs/models.md).
 */
export const GLTF_EXTENSIONS = [
  "KHR_mesh_quantization",
  "KHR_texture_transform",
  "KHR_materials_unlit",
  "KHR_materials_emissive_strength",
  "KHR_materials_pbrSpecularGlossiness",
  "EXT_texture_webp",
  "EXT_texture_avif",
  "EXT_mesh_gpu_instancing",
] as const;

export type GltfExtension = (typeof GLTF_EXTENSIONS)[number];

const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(GLTF_EXTENSIONS);

const MAGIC = 0x46546c67; // « glTF »
const JSON_CHUNK = 0x4e4f534a; // « JSON »
const BIN_CHUNK = 0x004e4942; // « BIN\0 »

/** Ce qui ne va pas dans un .glb : un code, et ce qu'il faut pour le dire. */
export type GlbProblem =
  /** Trop court pour un .glb. */
  | { code: "short" }
  /** Pas un .glb (un .gltf, une autre sorte de fichier). */
  | { code: "magic" }
  /** Une autre version du conteneur que la 2. */
  | { code: "container"; version: number }
  /** La longueur annoncée n'est pas celle du fichier. */
  | { code: "length"; declared: number; actual: number }
  /** Le morceau JSON manque, ou il est tronqué. */
  | { code: "jsonChunk" }
  /** Le JSON ne se lit pas. */
  | { code: "json" }
  /** Une autre version de glTF que la 2.0. */
  | { code: "version"; version: string }
  /** Le tampon est dans un fichier à part. */
  | { code: "externalBuffer" }
  /** Le tampon annonce plus d'octets que le morceau binaire n'en a. */
  | { code: "bufferSize"; buffer: number; bin: number }
  /** Une image est dans un fichier à part. */
  | { code: "externalImage" }
  /** Aucun mesh. */
  | { code: "noMesh" }
  /** Des extensions exigées que le jeu ne lit pas. */
  | { code: "extensions"; list: string[] };

export type GlbProblemCode = GlbProblem["code"];

/** Les parties du JSON d'un glTF que lisent les contrôles et les outils. */
export interface GltfJson {
  readonly asset?: { readonly version?: string; readonly generator?: string };
  readonly scene?: number;
  readonly scenes?: readonly { readonly nodes?: readonly number[] }[];
  readonly nodes?: readonly GltfNode[];
  readonly meshes?: readonly { readonly primitives?: readonly { readonly attributes?: Record<string, number>; readonly material?: number }[] }[];
  readonly materials?: readonly { readonly name?: string }[];
  readonly accessors?: readonly { readonly min?: readonly number[]; readonly max?: readonly number[] }[];
  readonly buffers?: readonly { readonly byteLength?: number; readonly uri?: string }[];
  readonly images?: readonly { readonly uri?: string }[];
  readonly extensionsRequired?: readonly string[];
}

export interface GltfNode {
  readonly mesh?: number;
  readonly children?: readonly number[];
  readonly matrix?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
}

/** Une boîte englobante (m), dans le repère du modèle. */
export interface GlbBounds {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

/** Ce qu'on lit d'un .glb : son JSON (null s'il ne se lit pas), ses problèmes (vide : il est lisible), sa boîte englobante. */
export interface GlbInspection {
  readonly json: GltfJson | null;
  readonly problems: readonly GlbProblem[];
  readonly bounds: GlbBounds | null;
}

/** Vérifie un .glb (ce que le jeu demande pour le lire), et mesure sa boîte englobante. */
export function inspectGlb(bytes: Uint8Array): GlbInspection {
  const fail = (problem: GlbProblem): GlbInspection => ({ json: null, problems: [problem], bounds: null });
  if (bytes.length < 20) return fail({ code: "short" });
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) return fail({ code: "magic" });
  if (dv.getUint32(4, true) !== 2) return fail({ code: "container", version: dv.getUint32(4, true) });
  if (dv.getUint32(8, true) !== bytes.length) return fail({ code: "length", declared: dv.getUint32(8, true), actual: bytes.length });
  const jsonLength = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > bytes.length) return fail({ code: "jsonChunk" });
  let json: GltfJson;
  try {
    const text = utf8Text(bytes.subarray(20, 20 + jsonLength));
    if (text === null) return fail({ code: "json" });
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail({ code: "json" });
    json = parsed as GltfJson;
  } catch {
    return fail({ code: "json" });
  }
  const problems: GlbProblem[] = [];
  try {
    const version = json.asset?.version;
    if (version !== "2.0") problems.push({ code: "version", version: typeof version === "string" ? version.slice(0, 16) : "?" });
    let binLength = 0;
    const bin = 20 + jsonLength;
    if (bin + 8 <= bytes.length && dv.getUint32(bin + 4, true) === BIN_CHUNK) binLength = dv.getUint32(bin, true);
    const buffer = Array.isArray(json.buffers) ? json.buffers[0] : undefined;
    if (buffer?.uri !== undefined) problems.push({ code: "externalBuffer" });
    else if (buffer && typeof buffer.byteLength === "number" && buffer.byteLength > binLength) problems.push({ code: "bufferSize", buffer: buffer.byteLength, bin: binLength });
    if (Array.isArray(json.images) && json.images.some((image) => image?.uri !== undefined)) problems.push({ code: "externalImage" });
    if (!Array.isArray(json.meshes) || !json.meshes.length) problems.push({ code: "noMesh" });
    const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
    const unsupported = required.filter((e) => !KNOWN_EXTENSIONS.has(e)).map((e) => String(e).slice(0, 64)).slice(0, 8);
    if (unsupported.length) problems.push({ code: "extensions", list: unsupported });
    return { json, problems, bounds: modelBounds(json) };
  } catch {
    // Un JSON aux formes inattendues (des nombres là où on attend des listes…) : refusé, sans lever
    return { json: null, problems: problems.length ? problems : [{ code: "json" }], bounds: null };
  }
}

/** Au plus autant de nœuds visités pour la boîte englobante : un fichier hostile ne fait pas tourner la lecture des heures. */
const MAX_VISITS = 4096;

/** La boîte englobante d'une scène glTF : les bornes de chaque position (obligatoires), passées par les nœuds qui les portent. */
function modelBounds(json: GltfJson): GlbBounds | null {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const scene = Array.isArray(json.scenes) ? json.scenes[typeof json.scene === "number" ? json.scene : 0] : undefined;
  const roots = Array.isArray(scene?.nodes) ? scene.nodes : nodes.map((_, i) => i);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let visits = 0;
  const visit = (index: number, parent: Mat4, depth: number): void => {
    const node = nodes[index];
    if (!node || depth > 64 || ++visits > MAX_VISITS) return;
    const matrix = multiply(parent, nodeMatrix(node));
    const primitives = node.mesh !== undefined ? json.meshes?.[node.mesh]?.primitives ?? [] : [];
    for (const primitive of Array.isArray(primitives) ? primitives : []) {
      const accessor = json.accessors?.[primitive?.attributes?.POSITION ?? -1];
      if (!Array.isArray(accessor?.min) || !Array.isArray(accessor.max)) continue;
      for (let corner = 0; corner < 8; corner++) {
        const p = [0, 1, 2].map((k) => Number((corner >> k) & 1 ? accessor.max![k] : accessor.min![k]));
        const q = [0, 1, 2].map((r) => matrix[r] * p[0] + matrix[4 + r] * p[1] + matrix[8 + r] * p[2] + matrix[12 + r]);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], q[k]);
          max[k] = Math.max(max[k], q[k]);
        }
      }
    }
    for (const c of Array.isArray(node.children) ? node.children : []) visit(c, matrix, depth + 1);
  };
  for (const r of roots) visit(r, IDENTITY, 0);
  return Number.isFinite(min[0]) && Number.isFinite(max[0]) ? { min, max } : null;
}

/** Une matrice 4 × 4 en colonnes, comme dans le glTF. */
type Mat4 = readonly number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]);
  return out;
}

function nodeMatrix(node: GltfNode): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
