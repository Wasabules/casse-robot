import * as B from "../babylon";
import { wheelDef, type WheelTypeDef } from "../../shared/catalog/wheels";
import { wheelLocalPos, type WheelMount } from "../../shared/design/robotDesign";
import type { Assets } from "./materials";
import { BAND_INSET, BAND_THICKNESS } from "./models/tracks";
import { BELT_MARGIN, beltPath, beltShape, placeShoes, shoeHorns, shoeLoop, sprocketRollers, trackGroups, type BeltShape, type ShoeLoop } from "./trackShape";

export { beltShape, shoeHorns, sprocketRollers, trackGroups, type BeltShape } from "./trackShape";

/** Longueur d'un motif de la bande (m), pour faire défiler sa texture. */
export const TREAD = 0.25;
/** Épaisseur de la bande vue de loin, sans ses patins (m) : elle s'arrête juste avant les roues des galets. */
const FAR_THICKNESS = 0.05;

/**
 * Bande d'une chenille (voir render/trackShape.ts), tout autour du contour des galets, ouverte sur
 * les flancs. Détaillée (`detailed`), c'est la bande de dessous : mince, sous la plaque de ses
 * patins (`BeltShoes`) ; on la voit entre eux (surtout dans les arcs, où ils s'écartent) et de
 * l'intérieur, entre les galets. Sinon, c'est la chenille vue de loin, sans patins : une bande
 * épaisse sur le parcours même, dont on voit l'épaisseur sur les flancs. Sa texture court le long de
 * la boucle et se répète sur la largeur de chaque rangée de galets : en la faisant défiler, le
 * dessous recule et le dessus avance quand le robot roule. Le mesh est dans le repère du robot,
 * centré en x sur la bande (`shape.x`).
 */
export function beltMesh(name: string, scene: B.Scene, shape: BeltShape, def: WheelTypeDef, detailed = true): B.Mesh {
  const inset = detailed ? BAND_INSET : 0;
  const thickness = detailed ? BAND_THICKNESS : FAR_THICKNESS;
  const path = beltPath(shape);
  const half = shape.width / 2;
  const repeat = shape.width / (def.width + 2 * BELT_MARGIN);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number): void => {
    indices.push(a, b, c, a, c, d);
  };
  let s = 0;
  path.forEach(([pz, py, nz, ny], k) => {
    if (k > 0) s += Math.hypot(pz - path[k - 1][0], py - path[k - 1][1]);
    const v = s / TREAD;
    const z = pz - nz * inset;
    const y = py - ny * inset;
    // Face extérieure, d'un flanc à l'autre
    for (const x of [-half, half]) {
      positions.push(x, y, z);
      normals.push(0, ny, nz);
      uvs.push(x < 0 ? 0 : repeat, v);
    }
    // Épaisseur de la bande sur chaque flanc : l'arête extérieure et l'arête intérieure
    for (const side of [-1, 1]) {
      for (const depth of [0, thickness]) {
        positions.push(side * half, y - ny * depth, z - nz * depth);
        normals.push(side, 0, 0);
        uvs.push(0.03, v);
      }
    }
  });
  const stride = 6;
  for (let k = 0; k + 1 < path.length; k++) {
    const i = k * stride;
    const j = i + stride;
    quad(i, i + 1, j + 1, j);
    quad(i + 2, j + 2, j + 3, i + 3);
    quad(i + 4, i + 5, j + 5, j + 4);
  }
  const mesh = new B.Mesh(name, scene);
  const data = new B.VertexData();
  Object.assign(data, { positions, normals, uvs, indices });
  data.applyToMesh(mesh);
  return mesh;
}

/**
 * Patins d'une chenille : une instance fine par patin (`source`, render/models/tracks.ts), posés
 * tout le long de la bande, crampon dehors, chacun tourné selon la normale du parcours : dans les
 * arcs, ils pivotent autour des galets comme des maillons qui s'articulent (`placeShoes`).
 * `advance` les fait défiler ensemble : leurs matrices sont récrites dans le même tampon, renvoyé tel
 * quel au GPU, sans mesh à refaire, et seulement quand ils sont dessinés. Le mesh est un enfant de
 * la bande (`band`) : il la suit, est masqué et libéré avec elle (mais pas le matériau de `source`,
 * qu'il partage). Il ne projette pas d'ombre : celle de la bande a la même silhouette.
 */
export class BeltShoes {
  readonly mesh: B.Mesh;
  private readonly loop: ShoeLoop;
  private readonly matrices: Float32Array;
  /** Où en est le premier patin le long de la boucle (m). */
  private offset = 0;
  /** Ils ont défilé depuis qu'on les a posés. */
  private stale = false;

  constructor(name: string, band: B.Mesh, source: B.Mesh, shape: BeltShape) {
    this.loop = shoeLoop(shape);
    this.matrices = new Float32Array(this.loop.count * 16);
    placeShoes(this.loop, 0, this.matrices);
    const mesh = new B.Mesh(name, band.getScene());
    // Une géométrie à lui : Babylon range le tampon des matrices des instances fines sur la
    // géométrie (voir WorldView) ; des chenilles qui la partageraient s'écraseraient
    source.geometry?.copy(`${name}-geometry`).applyToMesh(mesh);
    mesh.material = source.material;
    mesh.parent = band;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    // Les patins défilent sans sortir de la boucle : leur volume (pour la visibilité) ne change pas
    mesh.thinInstanceRefreshBoundingInfo(false);
    this.mesh = mesh;
  }

  /** Nombre de patins. */
  get count(): number {
    return this.loop.count;
  }

  /**
   * Fait défiler les patins de `distance` m dans le sens du parcours (le dessous vers l'avant, le
   * dessus vers l'arrière). `shown` : ils sont dessinés ; sinon, ils ne sont reposés qu'à leur retour.
   */
  advance(distance: number, shown = true): void {
    if (distance) {
      this.offset = (this.offset + distance) % this.loop.length;
      this.stale = true;
    }
    this.mesh.setEnabled(shown);
    if (!shown || !this.stale) return;
    this.stale = false;
    placeShoes(this.loop, this.offset, this.matrices);
    this.mesh.thinInstanceBufferUpdated("matrix");
  }
}

/** Une chenille immobile d'un plan : sa bande (ses patins en sont les enfants : masqués et libérés avec elle), ses barbotins et ses galets. */
export interface StillBelt<T extends WheelMount> {
  band: B.Mesh;
  sprockets: B.InstancedMesh[];
  rollers: T[];
}

/**
 * Chenilles immobiles d'un plan (garage, aperçu du choix du robot) : autour de chaque groupe de
 * galets voisins, une bande et ses patins, et un barbotin sur le galet arrière, comme en jeu. Les
 * meshes sont dans le repère du robot et ne sont pas visables (on vise les galets à travers).
 */
export function stillBelts<T extends WheelMount>(name: string, scene: B.Scene, assets: Assets, wheels: readonly T[]): StillBelt<T>[] {
  const rollers = wheels.filter((w) => wheelDef(w.type).track);
  if (!rollers.length) return [];
  const def = wheelDef(rollers[0].type);
  return trackGroups(rollers, wheelLocalPos, def).map((group) => {
    const centers = group.map(wheelLocalPos);
    const shape = beltShape(centers, def);
    const band = beltMesh(name, scene, shape, def);
    band.material = assets.stillBeltMaterial();
    band.position.x = shape.x;
    band.isPickable = false;
    new BeltShoes(`${name}-shoes`, band, assets.trackShoeSource(shape.width, shoeHorns(shape, centers)), shape);
    const sprockets = sprocketRollers(group, wheelLocalPos).map((w) => {
      const p = wheelLocalPos(w);
      const sprocket = assets.sprocketSource(w.type).createInstance(`${name}-sprocket`);
      sprocket.position.set(p.x, p.y, p.z);
      sprocket.isPickable = false;
      return sprocket;
    });
    return { band, sprockets, rollers: group };
  });
}
