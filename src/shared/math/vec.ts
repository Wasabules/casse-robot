import { dcos, dsin } from "./det";
/** Vecteur 3D, compatible avec les vecteurs de Rapier ({ x, y, z }). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Quaternion, compatible avec les rotations de Rapier ({ x, y, z, w }). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Distance dans le plan horizontal (on ignore y). */
export const flatDistance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return scale(a, 1 / l);
};

export const NO_ROTATION: Readonly<Quat> = { x: 0, y: 0, z: 0, w: 1 };

/** Quaternion de la rotation qui envoie les axes X, Y, Z sur les vecteurs unitaires orthogonaux `x`, `y`, `z`. */
export function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const trace = x.x + y.y + z.z;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return { w: 0.25 * s, x: (y.z - z.y) / s, y: (z.x - x.z) / s, z: (x.y - y.x) / s };
  }
  if (x.x > y.y && x.x > z.z) {
    const s = Math.sqrt(1 + x.x - y.y - z.z) * 2;
    return { w: (y.z - z.y) / s, x: 0.25 * s, y: (y.x + x.y) / s, z: (z.x + x.z) / s };
  }
  if (y.y > z.z) {
    const s = Math.sqrt(1 + y.y - x.x - z.z) * 2;
    return { w: (z.x - x.z) / s, x: (y.x + x.y) / s, y: 0.25 * s, z: (z.y + y.z) / s };
  }
  const s = Math.sqrt(1 + z.z - x.x - y.y) * 2;
  return { w: (x.y - y.x) / s, x: (z.x + x.z) / s, y: (z.y + y.z) / s, z: 0.25 * s };
}

/** Produit de quaternions : la rotation `b`, puis la rotation `a`. */
export function qmul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** Rotation d'angle `angle` autour de l'axe unitaire `axis`. */
export function axisAngle(axis: Vec3, angle: number): Quat {
  const s = dsin(angle / 2);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: dcos(angle / 2) };
}

/** Applique la rotation inverse de `q` au vecteur `v` (passage du repère monde au repère local). */
export const qrotInv = (q: Quat, v: Vec3): Vec3 => qrot({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);

/** Applique la rotation `q` au vecteur `v`. */
export function qrot(q: Quat, v: Vec3): Vec3 {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  };
}
