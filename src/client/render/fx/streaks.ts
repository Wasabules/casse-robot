import * as B from "../../babylon";
import type { Vec3 } from "../../../shared/math/vec";
import type { FxLook } from "../../settings";
import { InstanceLayer, rgb } from "./layer";
import type { PuffKind } from "./particles";
import { sprite, SpriteLayer, type Sprite } from "./sprites";

/**
 * Un trait : un segment de droite qui reste dans l'air, s'élargit et s'efface (sillage de
 * condensation d'un tir de sniper, trait ionisé, traçante, tourbillon de bout d'aile). Une traînée
 * qui tourne se fait de segments bout à bout, un par image.
 */
export interface StreakSpec {
  color: string;
  /** Sorte : fumée, vapeur ou lueur (le feu n'a pas de traits). */
  kind: Exclude<PuffKind, "fire">;
  /** Épaisseur au départ (m). */
  width: number;
  /** Épaisseur à la fin (m) ; par défaut, `width`. */
  widen?: number;
  /** Durée de vie (s). */
  life: number;
  /** Opacité au départ (1 par défaut). */
  alpha?: number;
}

type StreakKind = StreakSpec["kind"];
const KINDS: readonly StreakKind[] = ["smoke", "vapor", "glow"];
const CAPACITY: Record<StreakKind, number> = { smoke: 600, vapor: 1200, glow: 800 };
const REDUCED_SHARE = 0.4;

interface Streak {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  age: number; life: number;
  /** Né pendant cette image : il est dessiné tel qu'il naît avant de vieillir. */
  fresh: boolean;
  width: number; widen: number; alpha: number;
  r: number; g: number; b: number;
}

/**
 * Champ de traits : trois couches (fumée, vapeur, lueurs), comme les particules (voir
 * `ParticleField`) : des tubes à six pans (effets simples), ou des rubans face à la caméra, au
 * profil doux et effilochés (effets réalistes).
 */
export class StreakField {
  private readonly scene: B.Scene;
  private readonly layers: Record<StreakKind, InstanceLayer>;
  private ribbons: Record<StreakKind, SpriteLayer> | null = null;
  private look: FxLook = "simple";
  private readonly live: Record<StreakKind, Streak[]> = { smoke: [], vapor: [], glow: [] };
  private readonly pool: Streak[] = [];
  private limit: Record<StreakKind, number> = { ...CAPACITY };
  private readonly out: Sprite = sprite();

  constructor(scene: B.Scene) {
    this.scene = scene;
    // Un tube à six pans, de longueur 1 le long de z, centré sur l'origine
    const tube = (name: string): B.Mesh => {
      const m = B.MeshBuilder.CreateCylinder(name, { height: 1, diameter: 1, tessellation: 6, cap: 0 }, scene);
      m.rotation.x = Math.PI / 2;
      m.bakeCurrentTransformIntoVertices();
      return m;
    };
    this.layers = {
      smoke: new InstanceLayer(scene, "fx-streak-smoke", tube("fx-streak-smoke"), { blend: "blend", lit: true, capacity: CAPACITY.smoke, selfLight: 0.3 }),
      vapor: new InstanceLayer(scene, "fx-streak-vapor", tube("fx-streak-vapor"), { blend: "blend", lit: false, capacity: CAPACITY.vapor }),
      glow: new InstanceLayer(scene, "fx-streak-glow", tube("fx-streak-glow"), { blend: "blend", lit: false, capacity: CAPACITY.glow }),
    };
    for (const layer of Object.values(this.layers)) (layer.mesh.material as B.StandardMaterial).backFaceCulling = false;
  }

  /** Allure des traits : tubes (simples) ou rubans (réalistes). */
  setLook(look: FxLook): void {
    this.look = look;
    if (look === "realistic" && !this.ribbons) {
      const scene = this.scene;
      // (un ruban fait toute la largeur du trait : son profil doux s'efface vers les bords)
      this.ribbons = {
        smoke: new SpriteLayer(scene, "fx-ribbon-smoke", { look: "smoke", ribbon: true, capacity: CAPACITY.smoke, sizeScale: 1.6, selfLight: 0.35, softness: 0.1, alphaIndex: 9 }),
        vapor: new SpriteLayer(scene, "fx-ribbon-vapor", { look: "vapor", ribbon: true, capacity: CAPACITY.vapor, sizeScale: 1.6, selfLight: 1, softness: 0.1, alphaIndex: 9 }),
        glow: new SpriteLayer(scene, "fx-ribbon-glow", { look: "glow", ribbon: true, capacity: CAPACITY.glow, sizeScale: 2, softness: 0.05, alphaIndex: 14 }),
      };
    }
  }

  /** Un trait de `a` à `b`. */
  line(a: Vec3, b: Vec3, spec: StreakSpec): void {
    const list = this.live[spec.kind];
    if (list.length >= this.limit[spec.kind]) return;
    const s = this.pool.pop() ?? ({} as Streak);
    const [r, g, bl] = rgb(spec.color);
    s.ax = a.x; s.ay = a.y; s.az = a.z;
    s.bx = b.x; s.by = b.y; s.bz = b.z;
    s.age = 0; s.life = spec.life; s.fresh = true;
    s.width = spec.width; s.widen = spec.widen ?? spec.width;
    s.alpha = spec.alpha ?? 1;
    s.r = r; s.g = g; s.b = bl;
    list.push(s);
  }

  /** Le mesh des traits lumineux (voir `ParticleField.glowMesh`). */
  get glowMesh(): B.Mesh {
    return this.layers.glow.mesh;
  }

  setReduced(on: boolean): void {
    for (const kind of KINDS) this.limit[kind] = Math.round(CAPACITY[kind] * (on ? REDUCED_SHARE : 1));
  }

  clear(): void {
    for (const kind of KINDS) {
      for (const s of this.live[kind]) this.pool.push(s);
      this.live[kind].length = 0;
    }
  }

  update(dt: number): void {
    const realistic = this.look === "realistic" && this.ribbons !== null;
    for (const kind of KINDS) {
      const tubes = this.layers[kind];
      const ribbons = this.ribbons?.[kind] ?? null;
      const list = this.live[kind];
      tubes.begin();
      ribbons?.begin();
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        // (dessiné au moins une fois : à peu d'images par seconde, un trait bref ne serait jamais vu)
        if (!s.fresh) s.age += dt;
        s.fresh = false;
        if (s.age >= s.life) {
          list[i] = list[list.length - 1];
          list.pop();
          this.pool.push(s);
          continue;
        }
        const t = s.age / s.life;
        const w = s.width + (s.widen - s.width) * Math.sqrt(t);
        const dx = s.bx - s.ax, dy = s.by - s.ay, dz = s.bz - s.az;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-4) continue;
        const zx = dx / len, zy = dy / len, zz = dz / len;
        // (chaque segment déborde d'une demi-épaisseur : pas de trou entre deux segments d'une traînée qui tourne)
        const length = len + w;
        if (realistic && ribbons) {
          const o = this.out;
          o.x = (s.ax + s.bx) / 2; o.y = (s.ay + s.by) / 2; o.z = (s.az + s.bz) / 2;
          o.size = w;
          o.ax = zx * length; o.ay = zy * length; o.az = zz * length;
          o.r = s.r; o.g = s.g; o.b = s.b; o.a = s.alpha * (1 - t);
          ribbons.put(o);
          continue;
        }
        let xx = zz, xz = -zx;
        let n = Math.hypot(xx, xz);
        if (n < 1e-3) { xx = 1; xz = 0; n = 1; }
        xx /= n; xz /= n;
        const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;
        tubes.writeBasis((s.ax + s.bx) / 2, (s.ay + s.by) / 2, (s.az + s.bz) / 2, xx * w, 0, xz * w, yx * w, yy * w, yz * w, zx * length, zy * length, zz * length, s.r, s.g, s.b, s.alpha * (1 - t));
      }
      tubes.end();
      ribbons?.end();
    }
  }

  dispose(): void {
    for (const layer of Object.values(this.layers)) layer.dispose();
    if (this.ribbons) for (const layer of Object.values(this.ribbons)) layer.dispose();
  }
}
