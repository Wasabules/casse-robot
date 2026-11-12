import * as B from "../babylon";
import type { GltfModel } from "./gltfModel";
import type { ModelFile } from "./modelFiles";

/*
 * Ce qu'ont en commun les pièces qui peuvent avoir un modèle glTF (les accessoires,
 * render/propModels.ts ; les blocs, les têtes de tourelle et les roues, render/partModels.ts) : le
 * fichier se lit à la demande, une fois par scène, la première fois qu'on demande sa pièce ; le
 * lecteur (render/gltfModel.ts, et celui de Babylon) ne se charge qu'alors, hors du paquet
 * principal. En attendant, la pièce garde la source faite par le code, qui prend ensuite sur place
 * la géométrie et les matières du modèle (`adoptModel`) : ses instances suivent, et les lots
 * d'instances fines qui en ont copié la géométrie voient qu'elle a changé et se refont. Un fichier
 * illisible laisse le modèle du code (un avertissement dans la console). Les modèles du jeu se
 * téléchargent (public/models/, d'après le manifeste) ; ceux d'une carte venue d'un paquet viennent de
 * ses ressources (`ModelReads` reçoit alors d'où viennent les octets : render/propModels.ts).
 */

/** Le lecteur glTF (render/gltfModel.ts), chargé à la première demande : il n'est pas dans le paquet principal. */
let reader: Promise<typeof import("./gltfModel")> | null = null;
const gltfReader = (): Promise<typeof import("./gltfModel")> => (reader ??= import("./gltfModel"));

/** Les octets de chaque fichier de modèle, téléchargés une fois pour toutes les scènes (le jeu, le garage, l'éditeur de cartes…). */
const downloads = new Map<string, Promise<ArrayBuffer>>();
function modelBytes(entry: ModelFile): Promise<ArrayBuffer> {
  let bytes = downloads.get(entry.file);
  if (!bytes) {
    // (l'empreinte dans l'adresse : un fichier changé ne vient pas du cache du navigateur)
    bytes = fetch(`${import.meta.env.BASE_URL}${entry.file}?v=${entry.hash}`).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.arrayBuffer();
    });
    // Un échec n'est pas gardé : une autre scène réessaiera
    bytes.catch(() => downloads.delete(entry.file));
    downloads.set(entry.file, bytes);
  }
  return bytes;
}

/** Les octets d'un fichier de modèle : ceux du jeu se téléchargent (`modelBytes`) ; ceux d'une carte viennent de ses ressources. */
export type ModelBytes = (entry: ModelFile) => Promise<ArrayBuffer>;

/**
 * Les modèles glTF d'une famille de pièces, lus dans une scène : chacun une fois, à la première
 * demande ; ce qui l'attend le reçoit quand il est lu. `files` : le fichier de chaque pièce (le
 * manifeste des modèles du jeu, ou une fonction : les modèles d'une carte, connus en chemin) ;
 * `bytes` : d'où viennent leurs octets.
 */
export class ModelReads<K extends string> {
  private readonly scene: B.Scene;
  private readonly entry: (key: K) => ModelFile | undefined;
  /** Ce qu'est la pièce, pour l'avertissement d'un fichier illisible (« de l'accessoire « crate » »). */
  private readonly label: (key: K) => string;
  /** Lu, ou illisible (null) ; absent : pas encore lu. */
  private readonly models = new Map<K, GltfModel | null>();
  /** Ce qui attend un modèle dont la lecture est en cours. */
  private readonly waiting = new Map<K, ((model: GltfModel) => void)[]>();
  /** Ce qu'on fait d'un modèle lu, avant de le donner (des matières à régler), une fois par modèle. */
  private readonly prepare: (model: GltfModel) => void;
  private readonly bytes: ModelBytes;

  constructor(
    scene: B.Scene,
    files: { readonly [key in K]?: ModelFile } | ((key: K) => ModelFile | undefined),
    label: (key: K) => string,
    prepare: (model: GltfModel) => void = () => {},
    bytes: ModelBytes = modelBytes,
  ) {
    this.scene = scene;
    this.entry = typeof files === "function" ? files : (key) => files[key];
    this.label = label;
    this.prepare = prepare;
    this.bytes = bytes;
  }

  /** Un fichier est-il livré pour cette pièce ? */
  has(key: K): boolean {
    return !!this.entry(key);
  }

  /**
   * Le modèle de cette pièce : lu, en route (undefined : sa lecture commence, si elle n'est pas
   * déjà en cours), ou aucun (null : pas de fichier, ou illisible).
   */
  get(key: K): GltfModel | null | undefined {
    const model = this.models.get(key);
    if (model !== undefined) return model;
    const entry = this.entry(key);
    if (!entry) return null;
    if (!this.waiting.has(key)) {
      this.waiting.set(key, []);
      void this.load(key, entry);
    }
    return undefined;
  }

  /** `ready` recevra le modèle quand il sera lu (rien s'il est illisible) ; pour une pièce dont `get` a dit qu'il était en route. */
  whenRead(key: K, ready: (model: GltfModel) => void): void {
    this.waiting.get(key)?.push(ready);
  }

  /** Nombre de lectures en cours. */
  get pending(): number {
    return this.waiting.size;
  }

  private async load(key: K, entry: ModelFile): Promise<void> {
    let model: GltfModel | null = null;
    try {
      const [gltf, bytes] = await Promise.all([gltfReader(), this.bytes(entry)]);
      if (this.scene.isDisposed) return;
      model = await gltf.readGltfModel(this.scene, bytes, `${key}.glb`);
      this.prepare(model);
    } catch (e) {
      console.warn(`Modèle glTF ${this.label(key)} illisible (${entry.file}) : on garde celui du code.`, e);
      model = null;
    }
    if (this.scene.isDisposed) return;
    this.models.set(key, model);
    const waiting = this.waiting.get(key) ?? [];
    this.waiting.delete(key);
    if (model) for (const ready of waiting) ready(model);
  }
}

/**
 * Un mesh source d'après un modèle lu : sa géométrie (ses positions, normales et couleurs de
 * sommets, ou celles qu'on donne : un modèle reposé, étiré, recoloré), une part par matière,
 * invisible (à instancier), qui reçoit les ombres.
 */
export function modelMesh(
  scene: B.Scene,
  name: string,
  model: GltfModel,
  material: B.Material,
  { positions = model.positions, normals = model.normals, colors = model.colors }: { positions?: Float32Array; normals?: Float32Array; colors?: Float32Array | null } = {},
): B.Mesh {
  const mesh = new B.Mesh(name, scene);
  const data = new B.VertexData();
  data.positions = positions;
  data.normals = normals;
  if (model.uvs) data.uvs = model.uvs;
  if (colors) data.colors = colors;
  data.indices = model.indices;
  data.applyToMesh(mesh);
  mesh.hasVertexAlpha = false;
  mesh.releaseSubMeshes();
  for (const part of model.parts) new B.SubMesh(part.material, 0, mesh.getTotalVertices(), part.indexStart, part.indexCount, mesh);
  mesh.material = material;
  mesh.isVisible = false;
  mesh.receiveShadows = true;
  mesh.refreshBoundingInfo();
  return mesh;
}

/** Les matières d'un modèle en une seule (une matière multiple s'il en a plusieurs : une par part). */
export function modelMaterial(scene: B.Scene, name: string, list: readonly B.Material[]): B.Material {
  if (list.length === 1) return list[0];
  const multi = new B.MultiMaterial(name, scene);
  multi.subMaterials = [...list];
  return multi;
}

/**
 * La source `target` (faite par le code, déjà instanciée, peut-être dans des lots) prend sur place
 * la géométrie, les parts et les matières de `from`, qui disparaît. Ses instances la suivent (leur
 * boîte englobante est refaite) ; un lot d'instances fines voit que la géométrie de sa source a
 * changé et se refait (render/propBatches.ts, render/worldView.ts).
 */
export function adoptModel(target: B.Mesh, from: B.Mesh): void {
  const old = target.geometry;
  from.geometry!.applyToMesh(target);
  if (old && !old.meshes.length) old.dispose();
  target.releaseSubMeshes();
  for (const sub of from.subMeshes) new B.SubMesh(sub.materialIndex, sub.verticesStart, sub.verticesCount, sub.indexStart, sub.indexCount, target);
  target.material = from.material;
  target.hasVertexAlpha = false;
  target.refreshBoundingInfo();
  from.dispose(false, false);
  for (const instance of target.instances) instance.refreshBoundingInfo();
}
