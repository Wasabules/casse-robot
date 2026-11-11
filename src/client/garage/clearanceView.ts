import * as B from "../babylon";
import type { Solid } from "../../shared/design/clearance";
import { cross, norm, quatFromBasis, sub, vec3, len, type Vec3 } from "../../shared/math/vec";

/** Volumes à montrer : ce que réserve une pièce, en vert (libre) ou en rouge (en conflit). */
export interface ZoneShow {
  solids: readonly Solid[];
  clash: boolean;
}

/**
 * Encombrement montré au garage, en transparence et par-dessus les blocs (on le voit à travers
 * eux) : ce que réserve la pièce qu'on va poser (le canon d'une tourelle, le disque d'une hélice,
 * une roue…), en vert si elle passe, en rouge sinon, et en rouge ce qu'elle gênerait. Les volumes
 * sont ceux de shared/design/clearance.ts : ce que le garage montre est ce qu'il vérifie.
 */
export class ClearanceView {
  private readonly scene: B.Scene;
  private readonly free: B.StandardMaterial;
  private readonly clash: B.StandardMaterial;
  private meshes: B.Mesh[] = [];
  /** Ce qui est montré (pour ne pas refaire les mêmes meshes à chaque mouvement du pointeur). */
  private key = "";

  constructor(scene: B.Scene) {
    this.scene = scene;
    const material = (name: string, color: string, alpha: number): B.StandardMaterial => {
      const m = new B.StandardMaterial(name, scene);
      m.emissiveColor = B.Color3.FromHexString(color);
      m.disableLighting = true;
      m.alpha = alpha;
      m.backFaceCulling = false;
      return m;
    };
    this.free = material("clearance-free", "#57d38c", 0.16);
    this.clash = material("clearance-clash", "#ff5a4a", 0.32);
  }

  /** Montre ces volumes ; `key` les désigne (même clé : rien à refaire). */
  show(key: string, zones: readonly ZoneShow[]): void {
    if (key === this.key) return;
    this.hide();
    this.key = key;
    for (const zone of zones) for (const s of zone.solids) this.meshes.push(this.mesh(s, zone.clash ? this.clash : this.free));
  }

  hide(): void {
    for (const m of this.meshes) m.dispose();
    this.meshes = [];
    this.key = "";
  }

  private mesh(s: Solid, material: B.StandardMaterial): B.Mesh {
    let m: B.Mesh;
    if (s.kind === "box") {
      m = B.MeshBuilder.CreateBox("clearance", { size: 1 }, this.scene);
      m.position.set(s.center.x, s.center.y, s.center.z);
      m.scaling.set(2 * s.half.x, 2 * s.half.y, 2 * s.half.z);
    } else if (s.kind === "cylinder") {
      m = B.MeshBuilder.CreateCylinder("clearance", { height: 1, diameter: 1, tessellation: 40 }, this.scene);
      m.position.set(s.center.x, s.center.y, s.center.z);
      m.scaling.set(2 * s.radius, 2 * s.half, 2 * s.radius);
      // Le cylindre est dressé selon y : on le couche selon son axe
      if (s.axis === "x") m.rotation.z = Math.PI / 2;
      else if (s.axis === "z") m.rotation.x = Math.PI / 2;
    } else {
      m = segment(this.scene, s.a, s.b, s.radius);
    }
    m.material = material;
    m.isPickable = false;
    // Par-dessus les blocs, comme le centre de masse : on voit ce que la pièce traverserait
    m.renderingGroupId = 1;
    return m;
  }
}

/** Un tube de rayon `r` entre `a` et `b` (une capsule, sans ses bouts arrondis). */
function segment(scene: B.Scene, a: Vec3, b: Vec3, r: number): B.Mesh {
  const m = B.MeshBuilder.CreateCylinder("clearance", { height: 1, diameter: 1, tessellation: 16 }, scene);
  const d = sub(b, a);
  const length = Math.max(len(d), 1e-6);
  const y = norm(d);
  const x = norm(Math.abs(y.y) < 0.95 ? cross(y, vec3(0, 1, 0)) : cross(y, vec3(1, 0, 0)));
  const q = quatFromBasis(x, y, cross(x, y));
  m.rotationQuaternion = new B.Quaternion(q.x, q.y, q.z, q.w);
  m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  m.scaling.set(2 * r, length + 2 * r, 2 * r);
  return m;
}
