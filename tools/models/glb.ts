import { GLTF_EXTENSIONS } from "../../src/client/gltfExtensions";

/*
 * Des fichiers glTF binaires (.glb) sans dépendance : les écrire depuis le code (le modèle d'exemple,
 * tools/models/crate.ts ; des essais), et vérifier ceux que livrent les artistes (`npm run models`,
 * tests/models.test.ts) : l'en-tête, les morceaux, le JSON, la version, la boîte englobante.
 * Le format : https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html (« GLB File Format »).
 */

/** Une matière (métal et rugosité : 0 à 1 ; couleurs en sRGB, 0 à 1, comme dans un éditeur). */
export interface GlbMaterial {
  readonly name: string;
  readonly color: readonly [number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
  readonly emissive?: readonly [number, number, number];
}

/** Des triangles d'une matière : positions et normales (3 nombres par sommet), couleurs de sommets en sRGB (3), indices. */
export interface GlbPrimitive {
  readonly positions: readonly number[];
  readonly normals?: readonly number[];
  readonly colors?: readonly number[];
  readonly indices: readonly number[];
  readonly material: number;
}

/** Un nœud qui porte un mesh, placé (`translation`, `rotation` en quaternion x, y, z, w, `scale`). */
export interface GlbNode {
  readonly mesh: number;
  readonly translation?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
}

/** Un modèle : ses meshes (chacun des triangles par matière), ses matières, ses nœuds (un par mesh, à l'origine, par défaut). */
export interface GlbModel {
  readonly meshes: readonly (readonly GlbPrimitive[])[];
  readonly materials: readonly GlbMaterial[];
  readonly nodes?: readonly GlbNode[];
  /** Ce qui a fait le fichier (`asset.generator`). */
  readonly generator: string;
  /** Les extensions que le fichier exige (et dit employer), pour des essais. */
  readonly extensionsRequired?: readonly string[];
}

const MAGIC = 0x46546c67; // « glTF »
const JSON_CHUNK = 0x4e4f534a; // « JSON »
const BIN_CHUNK = 0x004e4942; // « BIN\0 »
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** Une composante sRGB (0 à 1) en linéaire : le glTF range ses couleurs ainsi. */
export const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Arrondi à 6 décimales : un fichier reproductible, et pas de bruit d'arrondi dans le JSON. */
const round = (x: number): number => Math.round(x * 1e6) / 1e6 + 0;

/** Écrit un modèle en .glb (le même modèle donne toujours les mêmes octets). */
export function writeGlb(model: GlbModel): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  /** Range des données dans le tampon binaire (aligné sur 4 octets) et rend leur vue. */
  const view = (bytes: Uint8Array, target: number): number => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) chunks.push(new Uint8Array(pad));
    length += pad;
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target });
    chunks.push(bytes);
    length += bytes.length;
    return bufferViews.length - 1;
  };
  const floats = (values: readonly number[], type: "VEC3", bounds: boolean): number => {
    const data = Float32Array.from(values);
    const accessor: Record<string, unknown> = {
      bufferView: view(new Uint8Array(data.buffer), ARRAY_BUFFER), componentType: FLOAT, count: values.length / 3, type,
    };
    if (bounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i++) {
        min[i % 3] = Math.min(min[i % 3], data[i]);
        max[i % 3] = Math.max(max[i % 3], data[i]);
      }
      // (les bornes des positions, exactes en float32 : un lecteur les compare aux données)
      accessor.min = min.map((v) => Math.fround(v));
      accessor.max = max.map((v) => Math.fround(v));
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };
  const integers = (values: readonly number[], vertices: number): number => {
    const wide = vertices > 0xffff;
    const data = wide ? Uint32Array.from(values) : Uint16Array.from(values);
    accessors.push({
      bufferView: view(new Uint8Array(data.buffer), ELEMENT_ARRAY_BUFFER), componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, count: values.length, type: "SCALAR",
    });
    return accessors.length - 1;
  };
  const meshes = model.meshes.map((primitives, m) => ({
    name: `mesh${m}`,
    primitives: primitives.map((p) => {
      const vertices = p.positions.length / 3;
      const attributes: Record<string, number> = { POSITION: floats(p.positions.map(round), "VEC3", true) };
      if (p.normals) attributes.NORMAL = floats(p.normals.map(round), "VEC3", false);
      if (p.colors) attributes.COLOR_0 = floats(p.colors.map((c) => round(linear(c))), "VEC3", false);
      return { attributes, indices: integers(p.indices, vertices), material: p.material, mode: 4 };
    }),
  }));
  const nodes = (model.nodes ?? model.meshes.map((_, mesh): GlbNode => ({ mesh }))).map((n) => ({
    mesh: n.mesh,
    ...(n.translation ? { translation: n.translation.map(round) } : {}),
    ...(n.rotation ? { rotation: n.rotation.map(round) } : {}),
    ...(n.scale ? { scale: n.scale.map(round) } : {}),
  }));
  const materials = model.materials.map((m) => ({
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: [...m.color.map((c) => round(linear(c))), 1],
      metallicFactor: round(m.metallic ?? 0),
      roughnessFactor: round(m.roughness ?? 0.8),
    },
    ...(m.emissive ? { emissiveFactor: m.emissive.map((c) => round(linear(c))) } : {}),
  }));
  const pad = (4 - (length % 4)) % 4;
  if (pad) chunks.push(new Uint8Array(pad));
  length += pad;
  const json = {
    asset: { version: "2.0", generator: model.generator },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: length }],
    ...(model.extensionsRequired?.length ? { extensionsUsed: [...model.extensionsRequired], extensionsRequired: [...model.extensionsRequired] } : {}),
  };
  // Le JSON est complété d'espaces jusqu'à un multiple de 4 octets
  let text = JSON.stringify(json);
  while (new TextEncoder().encode(text).length % 4) text += " ";
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.length + 8 + length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, JSON_CHUNK, true);
  out.set(jsonBytes, 20);
  const bin = 20 + jsonBytes.length;
  dv.setUint32(bin, length, true);
  dv.setUint32(bin + 4, BIN_CHUNK, true);
  let at = bin + 8;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Ce qu'on lit d'un .glb : son JSON, et les problèmes trouvés (vide : il est lisible). */
export interface GlbReport {
  readonly json: GltfJson | null;
  readonly problems: readonly string[];
  /** La boîte englobante du modèle dans son repère (m), d'après les bornes de ses positions et ses nœuds ; null si inconnue. */
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] } | null;
}

/** Les parties du JSON d'un glTF que lit cet outil. */
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

interface GltfNode {
  readonly mesh?: number;
  readonly children?: readonly number[];
  readonly matrix?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
}

/** Vérifie un .glb (de quoi le jeu a besoin pour le lire), et mesure sa boîte englobante. */
export function readGlb(bytes: Uint8Array): GlbReport {
  const problems: string[] = [];
  const fail = (problem: string): GlbReport => ({ json: null, problems: [problem], bounds: null });
  if (bytes.length < 20) return fail("trop court pour un fichier glTF binaire");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) return fail("pas un fichier glTF binaire (.glb) : exporter en « glTF Binary »");
  if (dv.getUint32(4, true) !== 2) return fail(`version ${dv.getUint32(4, true)} du conteneur (le jeu lit la version 2)`);
  if (dv.getUint32(8, true) !== bytes.length) return fail(`longueur annoncée ${dv.getUint32(8, true)} octets, fichier de ${bytes.length}`);
  const jsonLength = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > bytes.length) return fail("premier morceau JSON absent ou tronqué");
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson;
  } catch {
    return fail("JSON illisible");
  }
  if (json.asset?.version !== "2.0") problems.push(`version glTF « ${json.asset?.version ?? "?"} » (le jeu lit la 2.0)`);
  let binLength = 0;
  const bin = 20 + jsonLength;
  if (bin + 8 <= bytes.length && dv.getUint32(bin + 4, true) === BIN_CHUNK) binLength = dv.getUint32(bin, true);
  const buffer = json.buffers?.[0];
  if (buffer?.uri !== undefined) problems.push("tampon dans un fichier à part : tout doit être dans le .glb");
  else if (buffer && (buffer.byteLength ?? 0) > binLength) problems.push(`tampon de ${buffer.byteLength} octets, morceau binaire de ${binLength}`);
  if (json.images?.some((image) => image.uri !== undefined)) problems.push("image dans un fichier à part : les textures doivent être dans le .glb");
  if (!json.meshes?.length) problems.push("aucun mesh");
  const unsupported = (json.extensionsRequired ?? []).filter((e) => !KNOWN_EXTENSIONS.has(e));
  if (unsupported.length) problems.push(`extensions exigées que le jeu ne lit pas : ${unsupported.join(", ")}`);
  return { json, problems, bounds: modelBounds(json) };
}

/** Les extensions qu'un fichier peut exiger : celles qu'enregistre le lecteur du jeu (client/babylonGltf.ts). */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(GLTF_EXTENSIONS);

/** La boîte englobante d'une scène glTF : les bornes de chaque position (obligatoires), passées par les nœuds qui les portent. */
function modelBounds(json: GltfJson): GlbReport["bounds"] {
  const nodes = json.nodes ?? [];
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (index: number, parent: Mat4, depth: number): void => {
    const node = nodes[index];
    if (!node || depth > 64) return;
    const matrix = multiply(parent, nodeMatrix(node));
    for (const primitive of node.mesh !== undefined ? json.meshes?.[node.mesh]?.primitives ?? [] : []) {
      const accessor = json.accessors?.[primitive.attributes?.POSITION ?? -1];
      if (!accessor?.min || !accessor.max) continue;
      for (let corner = 0; corner < 8; corner++) {
        const p = [0, 1, 2].map((k) => ((corner >> k) & 1 ? accessor.max![k] : accessor.min![k]));
        const q = [0, 1, 2].map((r) => matrix[r] * p[0] + matrix[4 + r] * p[1] + matrix[8 + r] * p[2] + matrix[12 + r]);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], q[k]);
          max[k] = Math.max(max[k], q[k]);
        }
      }
    }
    for (const c of node.children ?? []) visit(c, matrix, depth + 1);
  };
  for (const r of roots) visit(r, IDENTITY, 0);
  return Number.isFinite(min[0]) ? { min, max } : null;
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
  if (node.matrix?.length === 16) return node.matrix;
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
