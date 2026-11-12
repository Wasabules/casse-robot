import * as B from "../babylon";

/*
 * Les accessoires ancrés immobiles (murs, toits, arbres, lampadaires, citernes : des centaines dans
 * une ville), en lots d'instances fines par source : une passe de dessin par lot, dans l'image, dans
 * chaque cascade d'ombre et dans le halo, au lieu d'une par accessoire, et rien à recalculer d'une
 * image à l'autre (Babylon traitait chaque instance à chaque passe : dans la Cité, les cartes d'ombre
 * coûtaient la moitié de la préparation d'une image). Un accessoire qui change (il ploie, tombe,
 * fuit, est détruit) quitte son lot et redevient une instance à lui (WorldView) ; un accessoire qui
 * noircit passe au lot de sa nouvelle source.
 */

interface Batch {
  source: B.Mesh;
  /** La géométrie de la source quand le lot l'a copiée : la source qui en change (son modèle glTF arrive), le lot se refait. */
  geometry: B.Geometry | null;
  mesh: B.Mesh;
  /** Matrices des instances (16 nombres chacune), `count` utilisées. */
  matrices: Float32Array;
  count: number;
  /** L'accessoire de chaque instance, dans l'ordre des matrices. */
  ids: number[];
  dirty: boolean;
}

export class PropBatches {
  private readonly batches = new Map<B.Mesh, Batch>();
  private readonly where = new Map<number, Batch>();

  private readonly scene: B.Scene;
  private readonly shadows: B.ShadowGenerator;

  constructor(scene: B.Scene, shadows: B.ShadowGenerator) {
    this.scene = scene;
    this.shadows = shadows;
  }

  /** Nombre d'accessoires dans les lots. */
  get size(): number {
    return this.where.size;
  }

  has(id: number): boolean {
    return this.where.has(id);
  }

  /** L'accessoire `id` rejoint le lot de `source`, à cette matrice (son monde). */
  add(id: number, source: B.Mesh, matrix: B.Matrix): void {
    this.remove(id);
    const batch = this.batches.get(source) ?? this.create(source);
    if ((batch.count + 1) * 16 > batch.matrices.length) {
      const grown = new Float32Array(Math.max(16 * 16, batch.matrices.length * 2));
      grown.set(batch.matrices);
      batch.matrices = grown;
      batch.mesh.thinInstanceSetBuffer("matrix", grown, 16, false);
    }
    matrix.copyToArray(batch.matrices, batch.count * 16);
    batch.ids.push(id);
    batch.count++;
    batch.dirty = true;
    this.where.set(id, batch);
  }

  /** L'accessoire `id` quitte son lot ; sa matrice (son monde), s'il y était. */
  remove(id: number): B.Matrix | null {
    const batch = this.where.get(id);
    if (!batch) return null;
    this.where.delete(id);
    const index = batch.ids.indexOf(id);
    const matrix = B.Matrix.FromArray(batch.matrices, index * 16);
    // La dernière instance prend sa place
    const last = batch.count - 1;
    if (index !== last) {
      batch.matrices.copyWithin(index * 16, last * 16, last * 16 + 16);
      batch.ids[index] = batch.ids[last];
    }
    batch.ids.pop();
    batch.count--;
    batch.dirty = true;
    return matrix;
  }

  /** Les lots changés partent au GPU (une fois par image, avant le rendu). */
  flush(): void {
    for (const batch of this.batches.values()) {
      // La source a pris une autre géométrie (son modèle glTF est arrivé, render/propModels.ts) : le lot la reprend
      if (batch.source.geometry !== batch.geometry) this.reshape(batch);
      if (!batch.dirty) continue;
      batch.dirty = false;
      batch.mesh.thinInstanceCount = batch.count;
      batch.mesh.setEnabled(batch.count > 0);
      if (!batch.count) continue;
      batch.mesh.thinInstanceBufferUpdated("matrix");
      batch.mesh.thinInstanceRefreshBoundingInfo(false);
    }
  }

  private create(source: B.Mesh): Batch {
    const matrices = new Float32Array(16 * 16);
    const batch: Batch = { source, geometry: source.geometry, mesh: this.batchMesh(source, matrices), matrices, count: 0, ids: [], dirty: true };
    this.batches.set(source, batch);
    return batch;
  }

  /** Le mesh d'un lot : une copie de la géométrie de la source, ses parts et sa matière, ses matrices d'instances. */
  private batchMesh(source: B.Mesh, matrices: Float32Array): B.Mesh {
    const name = `props-${source.name}`;
    const mesh = new B.Mesh(name, this.scene);
    // Une géométrie à lui : Babylon range le tampon des matrices des instances fines sur la
    // géométrie (voir WorldView) ; des lots qui la partageraient s'écraseraient
    source.geometry?.copy(`${name}-geometry`).applyToMesh(mesh);
    // Ses parts (une par matière d'une source à plusieurs matières : un arbre, une voiture, un
    // modèle glTF) : la géométrie copiée n'en a qu'une, qui prendrait la première matière partout
    if (source.subMeshes.length > 1) {
      mesh.releaseSubMeshes();
      for (const sub of source.subMeshes) new B.SubMesh(sub.materialIndex, sub.verticesStart, sub.verticesCount, sub.indexStart, sub.indexCount, mesh);
    }
    mesh.material = source.material;
    mesh.receiveShadows = source.receiveShadows;
    // On vise les accessoires (la visée par la scène, en réseau) : chaque instance se vise
    mesh.isPickable = true;
    mesh.thinInstanceEnablePicking = true;
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    mesh.thinInstanceCount = 0;
    mesh.freezeWorldMatrix();
    this.shadows.addShadowCaster(mesh, false);
    return mesh;
  }

  /** Refait le mesh d'un lot d'après la nouvelle géométrie de sa source, avec ses instances. */
  private reshape(batch: Batch): void {
    batch.mesh.dispose();
    batch.geometry = batch.source.geometry;
    batch.mesh = this.batchMesh(batch.source, batch.matrices);
    batch.dirty = true;
  }

  dispose(): void {
    for (const batch of this.batches.values()) batch.mesh.dispose();
    this.batches.clear();
    this.where.clear();
  }
}
