import { inspectGlb, type GlbBounds, type GlbProblem, type GltfJson } from "../../src/shared/media/glb";

export type { GltfJson } from "../../src/shared/media/glb";

/*
 * Des fichiers glTF binaires (.glb) sans dépendance : les écrire depuis le code (le modèle d'exemple,
 * tools/models/crate.ts ; des essais), et vérifier ceux que livrent les artistes (`npm run models`,
 * tests/models.test.ts) : l'en-tête, les morceaux, le JSON, la version, la boîte englobante. Les
 * contrôles sont ceux du jeu (src/shared/media/glb.ts, qui vérifie aussi les modèles d'un paquet de
 * carte) ; ici, leurs messages en français.
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

/** Ce qu'on lit d'un .glb : son JSON, et les problèmes trouvés (vide : il est lisible), dits en français. */
export interface GlbReport {
  readonly json: GltfJson | null;
  readonly problems: readonly string[];
  /** La boîte englobante du modèle dans son repère (m), d'après les bornes de ses positions et ses nœuds ; null si inconnue. */
  readonly bounds: GlbBounds | null;
}

/** Un problème d'un .glb, en français (les messages de l'outil, comme ceux du serveur). */
export function glbProblemText(problem: GlbProblem): string {
  switch (problem.code) {
    case "short": return "trop court pour un fichier glTF binaire";
    case "magic": return "pas un fichier glTF binaire (.glb) : exporter en « glTF Binary »";
    case "container": return `version ${problem.version} du conteneur (le jeu lit la version 2)`;
    case "length": return `longueur annoncée ${problem.declared} octets, fichier de ${problem.actual}`;
    case "jsonChunk": return "premier morceau JSON absent ou tronqué";
    case "json": return "JSON illisible";
    case "version": return `version glTF « ${problem.version} » (le jeu lit la 2.0)`;
    case "externalBuffer": return "tampon dans un fichier à part : tout doit être dans le .glb";
    case "bufferSize": return `tampon de ${problem.buffer} octets, morceau binaire de ${problem.bin}`;
    case "externalImage": return "image dans un fichier à part : les textures doivent être dans le .glb";
    case "noMesh": return "aucun mesh";
    case "extensions": return `extensions exigées que le jeu ne lit pas : ${problem.list.join(", ")}`;
  }
}

/** Vérifie un .glb (ce que le jeu demande pour le lire : src/shared/media/glb.ts), et mesure sa boîte englobante. */
export function readGlb(bytes: Uint8Array): GlbReport {
  const report = inspectGlb(bytes);
  return { json: report.json, problems: report.problems.map(glbProblemText), bounds: report.bounds };
}
