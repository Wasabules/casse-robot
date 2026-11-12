import * as B from "../babylon";
import { BLOCK_TYPES, type BlockType } from "../../shared/catalog/blocks";
import type { WheelType } from "../../shared/catalog/wheels";
import type { GltfModel } from "./gltfModel";
import { adoptModel, modelMaterial, modelMesh, ModelReads } from "./gltfModels";
import { BLOCK_MODEL_FILES, HEAD_MODEL_FILES, WHEEL_MODEL_FILES } from "./modelFiles";
import type { TurretBlockType } from "./models";

/*
 * Les modèles glTF des pièces d'un robot (les conventions : docs/models.md) : un bloc
 * (public/models/blocks/<type>.glb, dans le repère de sa case : ±0,25 m, haut +y, avant +z), une
 * tête de tourelle (heads/<type>.glb : son axe de rotation à l'origine, le canon vers +z) et une
 * roue (wheels/<type>.glb : son moyeu à l'origine, l'essieu le long de x). Chacun remplace le
 * modèle fait par le code (`BLOCK_MODELS`, le cube texturé, `HEAD_MODELS`, `TURRET_LOOKS`,
 * `WHEEL_MODELS`, render/blockModels.ts, render/materials.ts) partout où la pièce est dessinée :
 * en jeu, au garage, dans les aperçus et les vignettes. Les collisions, elles, restent celles du
 * catalogue : la grille, le cube, la zone touchable d'une tête, le rayon d'une roue.
 *
 * Comme pour les accessoires (render/gltfModels.ts), le fichier se lit à la demande, une fois par
 * scène ; en attendant, la source est celle du code, qui prend sur place le modèle à son arrivée
 * (`generation` compte ces changements : les lots d'instances fines de WorldView, qui ont copié la
 * géométrie de leur source, se refont).
 *
 * Les couleurs : comme dans les modèles faits par le code (render/modelKit.ts), la couleur de
 * chaque matière éclairée passe dans les couleurs des sommets de ses triangles, et la matière
 * reste blanche (sa texture, son reflet, sa lueur, son opacité restent les siens). Babylon borne
 * la lumière reçue avant de la multiplier par la couleur des sommets et de la texture, pas par
 * celle de la matière : une couleur de matière tournait au blanc sous le soleil, à côté des blocs
 * du code. La couleur du robot aussi : la matière nommée `paint` d'un bloc qui prend la couleur du
 * robot (les blindages : `tinted` au catalogue) est multipliée par elle, dans les couleurs des
 * sommets de sa source (un tel bloc a déjà une source par couleur).
 *
 * L'usure : en jeu, chaque bloc est une instance fine d'un lot, dont la couleur (la teinte d'usure,
 * `wearColor` dans render/worldView.ts) multiplie la couleur de chaque fragment, quelle que soit la
 * matière (sa texture, les couleurs des sommets) : un modèle glTF s'use comme un bloc fait par le
 * code, sans rien de plus. Seule la lueur propre (l'émission) ne s'assombrit pas. Au garage et
 * dans les aperçus (des instances classiques), un bloc à modèle n'a pas de couleur par instance,
 * comme les modèles faits par le code : Babylon la mettrait à la place des couleurs de sommets.
 */

/** Une matière de modèle de bloc nommée `paint` (ou `paint.001`… : les copies de Blender) : elle prend la couleur du robot. */
const PAINT = /^paint(\.\d+)?$/i;

const WHITE = new B.Color3(1, 1, 1);

/** Un fichier est-il livré pour cette pièce ? (le manifeste : sans rien demander au réseau) */
export const hasBlockModel = (type: BlockType): boolean => !!BLOCK_MODEL_FILES[type];

export class PartModels {
  private readonly scene: B.Scene;
  private readonly blocks: ModelReads<BlockType>;
  private readonly heads: ModelReads<TurretBlockType>;
  private readonly wheels: ModelReads<WheelType>;
  /** La couleur d'origine des matières éclairées des modèles lus (elle passe dans les couleurs des sommets). */
  private readonly factors = new Map<B.Material, B.Color3>();
  /** Les matières d'un modèle (une seule, ou plusieurs réunies), une fois par modèle. */
  private readonly materials = new Map<GltfModel, B.Material>();
  private changes = 0;

  constructor(scene: B.Scene) {
    this.scene = scene;
    const prepare = (model: GltfModel): void => this.whiten(model);
    // (ce qu'est la pièce, dans l'avertissement d'un fichier illisible : un message de la console)
    this.blocks = new ModelReads(scene, BLOCK_MODEL_FILES, (type) => `du bloc « ${type} »`, prepare); // i18n-ignore
    this.heads = new ModelReads(scene, HEAD_MODEL_FILES, (type) => `de la tête « ${type} »`, prepare); // i18n-ignore
    this.wheels = new ModelReads(scene, WHEEL_MODEL_FILES, (type) => `de la roue « ${type} »`, prepare); // i18n-ignore
  }

  /** Nombre de sources qui ont pris leur modèle glTF depuis la création de la scène : un lot qui a copié leur géométrie se refait. */
  get generation(): number {
    return this.changes;
  }

  /** Nombre de modèles en cours de lecture (une vignette attend qu'ils soient là). */
  get pending(): number {
    return this.blocks.pending + this.heads.pending + this.wheels.pending;
  }

  /**
   * La source d'un bloc (`color` : celle du robot) : d'après son modèle glTF s'il est lu ; sinon
   * celle que fait `drawn` (le modèle du code), qui prendra le modèle glTF à son arrivée.
   */
  block(type: BlockType, color: string, name: string, drawn: () => B.Mesh): B.Mesh {
    const tint = BLOCK_TYPES[type].tinted ? B.Color3.FromHexString(color) : null;
    return this.dress(this.blocks, type, drawn, (model) => this.mesh(name, model, tint));
  }

  /** La source d'une tête de tourelle (voir `block`). */
  head(type: TurretBlockType, name: string, drawn: () => B.Mesh): B.Mesh {
    return this.dress(this.heads, type, drawn, (model) => this.mesh(name, model, null));
  }

  /** La source d'une roue (voir `block`). */
  wheel(type: WheelType, name: string, drawn: () => B.Mesh): B.Mesh {
    return this.dress(this.wheels, type, drawn, (model) => this.mesh(name, model, null));
  }

  private dress<K extends string>(reads: ModelReads<K>, key: K, drawn: () => B.Mesh, make: (model: GltfModel) => B.Mesh): B.Mesh {
    const model = reads.get(key);
    if (model) return make(model);
    const mesh = drawn();
    // Le modèle glTF est en route : cette source le prendra quand il sera lu
    if (model === undefined) {
      reads.whenRead(key, (read) => {
        if (mesh.isDisposed()) return;
        adoptModel(mesh, make(read));
        this.changes++;
      });
    }
    return mesh;
  }

  /** Une source d'après un modèle : ses couleurs de sommets (`tint` : la couleur du robot, sur `paint`), ses matières. */
  private mesh(name: string, model: GltfModel, tint: B.Color3 | null): B.Mesh {
    let material = this.materials.get(model);
    if (!material) this.materials.set(model, (material = modelMaterial(this.scene, `gltf-${name}`, model.materials)));
    return modelMesh(this.scene, name, model, material, { colors: this.colors(model, tint) });
  }

  /**
   * Les matières éclairées d'un modèle lu deviennent blanches (leur couleur passera dans les couleurs
   * des sommets, voir `colors`) ; toutes prennent la lumière ambiante de la scène, comme les blocs
   * faits par le code. Une fois par modèle et par scène : elles ne servent qu'à ses sources.
   */
  private whiten(model: GltfModel): void {
    for (const m of model.materials) {
      m.ambientColor = WHITE.clone();
      if (m.disableLighting || m.diffuseColor.equals(WHITE)) continue;
      this.factors.set(m, m.diffuseColor.clone());
      m.diffuseColor = WHITE.clone();
    }
  }

  /**
   * Les couleurs des sommets d'une source : celles du fichier (blanches s'il n'en a pas), multipliées
   * par la couleur de la matière de leurs triangles, et par `tint` pour la matière `paint` ; celles du
   * fichier telles quelles s'il n'y a rien à multiplier.
   */
  private colors(model: GltfModel, tint: B.Color3 | null): Float32Array | null {
    const scale = model.parts.map((part) => {
      const material = model.materials[part.material];
      const factor = this.factors.get(material) ?? null;
      const paint = tint && PAINT.test(material.name) ? tint : null;
      return paint ? (factor ?? WHITE).multiply(paint) : factor;
    });
    if (scale.every((c) => !c)) return model.colors;
    const count = model.positions.length / 3;
    const colors = model.colors ? Float32Array.from(model.colors) : new Float32Array(count * 4).fill(1);
    // (un sommet ne prend qu'une fois la couleur de sa part, qu'il serve à un triangle ou à dix)
    const done = new Uint8Array(count);
    model.parts.forEach((part, k) => {
      const c = scale[k];
      if (!c) return;
      for (let i = part.indexStart; i < part.indexStart + part.indexCount; i++) {
        const v = model.indices[i];
        if (done[v]) continue;
        done[v] = 1;
        colors[v * 4] *= c.r;
        colors[v * 4 + 1] *= c.g;
        colors[v * 4 + 2] *= c.b;
      }
    });
    return colors;
  }
}
