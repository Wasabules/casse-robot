import * as B from "../babylon";
import { LoadAssetContainerAsync, type AssetContainer } from "../babylonGltf";

/*
 * Lecture d'un modèle glTF (un accessoire, public/models/props/<type>.glb ; un bloc, une tête de
 * tourelle, une roue : public/models/blocks/, heads/, wheels/ ; les conventions : docs/models.md).
 * Ce module ne se charge qu'à la demande (`import("./gltfModel")` dans render/gltfModels.ts) : le
 * lecteur glTF de Babylon ne pèse rien dans le paquet principal.
 *
 * Le fichier devient une géométrie fusionnée (toutes ses pièces, leurs nœuds appliqués, ses
 * instances GPU dépliées), dans le repère du fichier (mètres, +y en haut ; son origine dépend de
 * la famille : le milieu du bas de l'emprise d'un accessoire, le centre de la case d'un bloc), et
 * des matières du jeu, une par matière du fichier : des `StandardMaterial`, comme celles des
 * modèles faits par le code, qui s'éclairent pareil (soleil, ciel, lumières de la nuit en grappes)
 * sans compiler les shaders de la PBR. Ce qu'on en garde : la couleur de base (son facteur et sa
 * texture), l'émission (facteur, force, texture), l'opacité (mélange ou découpe), les deux faces ;
 * la rugosité et le métal deviennent un reflet. Les cartes de normales, de rugosité et
 * d'occultation, les animations, les squelettes et les cibles de déformation sont ignorés.
 */

/** Une part de la géométrie : les triangles d'une matière (indices `indexStart` à `indexStart + indexCount`). */
export interface GltfModelPart {
  readonly material: number;
  readonly indexStart: number;
  readonly indexCount: number;
}

/** Un modèle lu : sa géométrie (couleurs de sommets dans l'espace gamma, alpha 1), ses parts et ses matières. */
export interface GltfModel {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Coordonnées de texture (0 là où une pièce n'en a pas), ou rien si aucune pièce n'en a. */
  readonly uvs: Float32Array | null;
  /** Couleurs des sommets (RVBA, blanches là où une pièce n'en a pas), ou rien si aucune pièce n'en a. */
  readonly colors: Float32Array | null;
  readonly indices: Uint32Array;
  readonly parts: readonly GltfModelPart[];
  readonly materials: readonly B.StandardMaterial[];
}

/** Ce que lit ce module d'une matière PBR du lecteur glTF (sans importer sa classe). */
interface PbrLike {
  albedoColor: B.Color3;
  albedoTexture: B.BaseTexture | null;
  useAlphaFromAlbedoTexture: boolean;
  emissiveColor: B.Color3;
  emissiveIntensity: number;
  emissiveTexture: B.BaseTexture | null;
  metallic: number | null;
  roughness: number | null;
  alpha: number;
  alphaCutOff: number;
  transparencyMode: number | null;
  backFaceCulling: boolean;
  twoSidedLighting: boolean;
  unlit: boolean;
}

/** Une pièce du fichier, ses sommets dans le repère du modèle. */
interface Piece {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  /** Les triangles de chaque matière de la pièce, indices propres à la pièce. */
  triangles: Map<B.Material | null, number[]>;
}

const GAMMA = 1 / 2.2;

/** Lit un fichier .glb dans `scene` : sa géométrie fusionnée et ses matières (le fichier lui-même ne reste pas dans la scène). */
export async function readGltfModel(scene: B.Scene, bytes: ArrayBuffer, name: string): Promise<GltfModel> {
  const container = await LoadAssetContainerAsync(new Uint8Array(bytes), scene, { pluginExtension: ".glb", name });
  // Les textures que reprennent les matières du jeu (les autres sont libérées avec le fichier)
  const kept = new Set<B.BaseTexture>();
  try {
    const pieces: Piece[] = [];
    for (const mesh of container.meshes) {
      if (!(mesh instanceof B.Mesh) || !mesh.getTotalVertices() || !mesh.getIndices()?.length) continue;
      mesh.computeWorldMatrix(true);
      const world = mesh.getWorldMatrix();
      // Instances GPU (EXT_mesh_gpu_instancing) : une pièce par instance
      const instances = mesh.hasThinInstances ? mesh.thinInstanceGetWorldMatrices().map((m) => m.multiply(world)) : [world];
      for (const matrix of instances) pieces.push(piece(mesh, matrix));
    }
    if (!pieces.length) throw new Error("aucune géométrie");
    const converted = new Map<B.Material | null, B.StandardMaterial>();
    for (const p of pieces) {
      for (const material of p.triangles.keys()) {
        if (!converted.has(material)) converted.set(material, convert(scene, material, converted.size, kept));
      }
    }
    return { ...merge(pieces, [...converted.keys()]), materials: [...converted.values()] };
  } finally {
    release(scene, container, kept);
  }
}

/** Une pièce : ses sommets passés dans le repère du modèle, ses triangles par matière. */
function piece(mesh: B.Mesh, matrix: B.Matrix): Piece {
  const count = mesh.getTotalVertices();
  const source = mesh.getVerticesData(B.VertexBuffer.PositionKind)!;
  const positions = new Float32Array(count * 3);
  const p = new B.Vector3();
  for (let i = 0; i < count; i++) {
    B.Vector3.TransformCoordinatesFromFloatsToRef(source[i * 3], source[i * 3 + 1], source[i * 3 + 2], matrix, p);
    positions.set([p.x, p.y, p.z], i * 3);
  }
  // Un nœud en miroir (déterminant négatif) retourne déjà les triangles
  const mirrored = matrix.determinant() < 0;
  const indices = mesh.getIndices()!;
  const triangles = new Map<B.Material | null, number[]>();
  for (const sub of mesh.subMeshes) {
    const material = mesh.material instanceof B.MultiMaterial ? mesh.material.getSubMaterial(sub.materialIndex) : mesh.material;
    let list = triangles.get(material);
    if (!list) triangles.set(material, (list = []));
    for (let i = sub.indexStart; i + 2 < sub.indexStart + sub.indexCount; i += 3) {
      // Le glTF tourne ses faces dans l'autre sens que les meshes du jeu (scène en repère direct) :
      // on les retourne, pour qu'une source à l'orientation par défaut les montre du bon côté
      if (mirrored) list.push(indices[i], indices[i + 1], indices[i + 2]);
      else list.push(indices[i], indices[i + 2], indices[i + 1]);
    }
  }
  const sourceNormals = mesh.getVerticesData(B.VertexBuffer.NormalKind);
  const normals = new Float32Array(count * 3);
  if (sourceNormals) {
    const linear = matrix.clone();
    linear.setTranslationFromFloats(0, 0, 0);
    const normalMatrix = linear.invert().transpose();
    for (let i = 0; i < count; i++) {
      B.Vector3.TransformNormalFromFloatsToRef(sourceNormals[i * 3], sourceNormals[i * 3 + 1], sourceNormals[i * 3 + 2], normalMatrix, p);
      p.normalize();
      normals.set([p.x, p.y, p.z], i * 3);
    }
  } else {
    // Sans normales, des facettes calculées d'après les triangles (déjà retournés)
    B.VertexData.ComputeNormals(positions, [...triangles.values()].flat(), normals);
  }
  const uvSource = mesh.getVerticesData(B.VertexBuffer.UVKind);
  const uvs = uvSource ? Float32Array.from(uvSource.slice(0, count * 2)) : null;
  // Couleurs de sommets : RVB ou RVBA dans le fichier, linéaires ; le jeu les veut RVBA, en gamma, opaques
  const colorBuffer = mesh.getVertexBuffer(B.VertexBuffer.ColorKind);
  const colorSource = mesh.getVerticesData(B.VertexBuffer.ColorKind);
  let colors: Float32Array | null = null;
  if (colorBuffer && colorSource) {
    const size = colorBuffer.getSize();
    colors = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) colors[i * 4 + c] = Math.pow(Math.min(1, Math.max(0, colorSource[i * size + c])), GAMMA);
      colors[i * 4 + 3] = 1;
    }
  }
  return { positions, normals, uvs, colors, triangles };
}

/** Toutes les pièces en une géométrie, une part par matière (dans l'ordre de `materials`). */
function merge(pieces: readonly Piece[], materials: readonly (B.Material | null)[]): Omit<GltfModel, "materials"> {
  const vertexCount = pieces.reduce((n, p) => n + p.positions.length / 3, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const anyUv = pieces.some((p) => p.uvs);
  const anyColor = pieces.some((p) => p.colors);
  const uvs = anyUv ? new Float32Array(vertexCount * 2) : null;
  const colors = anyColor ? new Float32Array(vertexCount * 4).fill(1) : null;
  const starts: number[] = [];
  let at = 0;
  for (const p of pieces) {
    starts.push(at);
    positions.set(p.positions, at * 3);
    normals.set(p.normals, at * 3);
    if (uvs && p.uvs) uvs.set(p.uvs, at * 2);
    if (colors && p.colors) colors.set(p.colors, at * 4);
    at += p.positions.length / 3;
  }
  const indices: number[] = [];
  const parts: GltfModelPart[] = [];
  materials.forEach((material, index) => {
    const indexStart = indices.length;
    pieces.forEach((p, k) => {
      for (const i of p.triangles.get(material) ?? []) indices.push(i + starts[k]);
    });
    if (indices.length > indexStart) parts.push({ material: index, indexStart, indexCount: indices.length - indexStart });
  });
  return { positions, normals, uvs, colors, indices: Uint32Array.from(indices), parts };
}

/** Une matière du fichier (PBR) en matière du jeu ; `kept` reçoit les textures qu'elle reprend. */
function convert(scene: B.Scene, source: B.Material | null, index: number, kept: Set<B.BaseTexture>): B.StandardMaterial {
  const pbr = (source ?? {}) as Partial<PbrLike>;
  const mat = new B.StandardMaterial(source?.name || `material${index}`, scene);
  // Les couleurs du glTF sont linéaires ; celles d'une StandardMaterial s'affichent telles quelles (gamma)
  const base = (pbr.albedoColor ?? new B.Color3(0.8, 0.8, 0.8)).toGammaSpace();
  mat.diffuseColor = base;
  const keep = <T extends B.BaseTexture>(texture: T | null | undefined): T | null => {
    if (texture) kept.add(texture);
    return texture ?? null;
  };
  mat.diffuseTexture = keep(pbr.albedoTexture);
  mat.alpha = pbr.alpha ?? 1;
  if (pbr.transparencyMode != null) mat.transparencyMode = pbr.transparencyMode;
  if (pbr.alphaCutOff !== undefined) mat.alphaCutOff = pbr.alphaCutOff;
  if (mat.diffuseTexture && (pbr.useAlphaFromAlbedoTexture || pbr.transparencyMode === 1)) {
    mat.diffuseTexture.hasAlpha = true;
    mat.useAlphaFromDiffuseTexture = !!pbr.useAlphaFromAlbedoTexture;
  }
  const emissive = (pbr.emissiveColor ?? B.Color3.Black()).toGammaSpace().scale(pbr.emissiveIntensity ?? 1);
  mat.emissiveColor = emissive;
  mat.emissiveTexture = keep(pbr.emissiveTexture);
  // Rugosité et métal : un reflet plus ou moins net, teinté par la couleur sur du métal
  const shine = 1 - Math.min(1, Math.max(0, pbr.roughness ?? 1));
  const strength = 0.04 + 0.5 * shine * shine;
  mat.specularColor = (pbr.metallic ?? 0) > 0.5 ? base.scale(strength * 1.6) : new B.Color3(strength, strength, strength);
  mat.specularPower = 8 + 120 * shine * shine;
  mat.backFaceCulling = pbr.backFaceCulling ?? true;
  mat.twoSidedLighting = pbr.twoSidedLighting ?? false;
  if (pbr.unlit) {
    mat.disableLighting = true;
    mat.emissiveColor = base;
  }
  return mat;
}

/** Libère ce que le lecteur a fait (meshes, nœuds, matières PBR, textures non reprises). */
function release(scene: B.Scene, container: AssetContainer, kept: ReadonlySet<B.BaseTexture>): void {
  for (const group of container.animationGroups) group.dispose();
  for (const skeleton of container.skeletons) skeleton.dispose();
  for (const mesh of container.meshes) mesh.dispose(false, false);
  for (const node of container.transformNodes) node.dispose();
  for (const material of container.materials) material.dispose(true, false);
  for (const texture of container.textures) {
    // Une texture reprise par une matière du jeu passe à la scène (libérée avec elle)
    if (kept.has(texture)) scene.addTexture(texture);
    else texture.dispose();
  }
  for (const light of container.lights) light.dispose();
  for (const camera of container.cameras) camera.dispose();
}
