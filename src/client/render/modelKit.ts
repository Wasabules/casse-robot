import * as B from "../babylon";
import type { WheelTypeDef } from "../../shared/catalog/wheels";

/*
 * Petit atelier de modèles 3D pour les blocs (moteurs, supports d'armes…) et les têtes de tourelle :
 * des primitives Babylon peintes par sommet, fusionnées en un seul mesh à un seul matériau. Les
 * blocs d'un morceau sont dessinés par lots d'instances fines (render/worldView.ts), qui n'ont
 * qu'un matériau : les couleurs d'un modèle sont donc des couleurs de sommets, que multiplie la
 * teinte de chaque instance (un bloc abîmé s'assombrit).
 *
 * Repère d'un modèle de bloc : centré sur le bloc (une case de 0,5 m, de -0,25 à 0,25 m sur chaque
 * axe), son haut vers +y et son avant vers +z (un moteur pousse vers +y, une tourelle regarde vers
 * +z). Il peut déborder un peu de sa case, mais les collisions, elles, restent celles du cube.
 */

export type V3 = readonly [number, number, number];

/** Peint tous les sommets du mesh de cette couleur (hexadécimale). */
export function paint(mesh: B.Mesh, color: string): B.Mesh {
  const c = B.Color4.FromColor3(B.Color3.FromHexString(color), 1);
  const count = mesh.getTotalVertices();
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b, 1], i * 4);
  mesh.setVerticesData(B.VertexBuffer.ColorKind, colors);
  return mesh;
}

/** Place, tourne (angles d'Euler, rad) et fige la transformation dans les sommets. */
function place(mesh: B.Mesh, at: V3, rot: V3 = [0, 0, 0]): B.Mesh {
  mesh.position.set(at[0], at[1], at[2]);
  mesh.rotation.set(rot[0], rot[1], rot[2]);
  mesh.bakeCurrentTransformIntoVertices();
  return mesh;
}

/** Axe d'un cylindre ou d'un cône : +y par défaut, ou couché le long de x ou de z. */
export type Axis = "x" | "y" | "z";
const AXIS_ROT: Record<Axis, V3> = { y: [0, 0, 0], x: [0, 0, Math.PI / 2], z: [Math.PI / 2, 0, 0] };

/** Les primitives de l'atelier, toutes dans une scène donnée. */
export class ModelKit {
  private readonly scene: B.Scene;

  constructor(scene: B.Scene) {
    this.scene = scene;
  }

  /** Pavé de dimensions `size` (largeur x, hauteur y, profondeur z), centré en `at`. */
  box(color: string, size: V3, at: V3 = [0, 0, 0], rot?: V3): B.Mesh {
    const m = B.MeshBuilder.CreateBox("kit-box", { width: size[0], height: size[1], depth: size[2] }, this.scene);
    return paint(place(m, at, rot), color);
  }

  /**
   * Cylindre (ou tronc de cône) de hauteur `height` le long de `axis`, centré en `at` ; `top` et
   * `bottom` : diamètres aux deux bouts (le « haut » est du côté +axe).
   */
  cylinder(color: string, height: number, bottom: number, top: number = bottom, at: V3 = [0, 0, 0], axis: Axis = "y", tessellation = 16): B.Mesh {
    const m = B.MeshBuilder.CreateCylinder("kit-cyl", { height, diameterTop: top, diameterBottom: bottom, tessellation }, this.scene);
    // Couché le long de z, un cylindre dressé selon y a son haut vers +z ; le long de x, vers -x : on le retourne
    const rot: V3 = axis === "x" ? [0, 0, -Math.PI / 2] : AXIS_ROT[axis];
    return paint(place(m, at, rot), color);
  }

  /** Anneau (tore) de diamètre `diameter` et d'épaisseur `thickness`, dans le plan perpendiculaire à `axis`. */
  ring(color: string, diameter: number, thickness: number, at: V3 = [0, 0, 0], axis: Axis = "y", tessellation = 24): B.Mesh {
    const m = B.MeshBuilder.CreateTorus("kit-ring", { diameter, thickness, tessellation }, this.scene);
    return paint(place(m, at, AXIS_ROT[axis]), color);
  }

  /** Sphère (ou ellipsoïde : `scale` par axe), centrée en `at`. */
  sphere(color: string, diameter: number, at: V3 = [0, 0, 0], scale: V3 = [1, 1, 1], segments = 12): B.Mesh {
    const m = B.MeshBuilder.CreateSphere("kit-sphere", { diameter, segments }, this.scene);
    m.scaling.set(scale[0], scale[1], scale[2]);
    return paint(place(m, at), color);
  }

  /**
   * Fusionne les pièces en un seul mesh source (invisible, prêt à instancier), aux couleurs de
   * sommets, avec son matériau : `specular` (0 à 1) pour la brillance, `emissive` pour un léger
   * éclat propre (un moteur qui rougeoie).
   */
  fuse(parts: B.Mesh[], name: string, options: { specular?: number; emissive?: string } = {}): B.Mesh {
    const merged = B.Mesh.MergeMeshes(parts, true, true);
    if (!merged) throw new Error(`Impossible de construire le modèle ${name}`);
    merged.name = name;
    const mat = new B.StandardMaterial(`${name}-mat`, this.scene);
    mat.diffuseColor = B.Color3.White();
    const s = options.specular ?? 0.25;
    mat.specularColor = new B.Color3(s, s, s);
    mat.specularPower = 40;
    mat.ambientColor = new B.Color3(1, 1, 1);
    if (options.emissive) mat.emissiveColor = B.Color3.FromHexString(options.emissive);
    merged.material = mat;
    merged.isVisible = false;
    merged.isPickable = false;
    merged.receiveShadows = true;
    return merged;
  }
}

/** Modèle d'un type de bloc : ses pièces fusionnées (voir `ModelKit.fuse`) ; `color` : la couleur du robot. */
export type BlockModel = (kit: ModelKit, color: string, name: string) => B.Mesh;
/** Modèle d'une tête de tourelle (son repère : l'axe de la tête à l'origine, le canon vers +z). */
export type HeadModel = (kit: ModelKit, name: string) => B.Mesh;

/**
 * Munitions visibles d'une tête (missiles dans leurs tubes, roquettes, ogive, bombes, capsules) :
 * un coup (`mesh`, fusionné, dans son propre repère : il sera posé à chaque place) et ses places
 * dans le repère de la tête (`slots`), dans l'ordre où ils partent. La tête, elle, est dessinée
 * sans eux : le rendu n'en montre que ce qui reste dans le chargeur (voir render/rounds.ts).
 */
export interface Rounds {
  mesh: B.Mesh;
  slots: readonly V3[];
}
export type RoundsModel = (kit: ModelKit, name: string) => Rounds;

/**
 * Modèle d'une roue (ou d'un galet de chenille) : centrée sur son moyeu, essieu le long de x (elle
 * tourne autour de x), de rayon `def.radius` et de largeur `def.width` (catalogue des roues). Une
 * seule source par type, montée à gauche comme à droite : on la fait symétrique (jante et moyeu des
 * deux côtés).
 */
export type WheelModel = (kit: ModelKit, def: WheelTypeDef, name: string) => B.Mesh;
