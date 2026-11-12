//! Vecteurs et quaternions, comme src/shared/math/vec.ts (et `clamp` de src/shared/math/scalar.ts) :
//! les mêmes opérations dans le même ordre, en nombres de 8 octets, pour rendre les mêmes bits. Les
//! expressions sont recopiées telles quelles : `a + b * c + d` se groupe en Rust comme en
//! JavaScript, `((a + (b * c)) + d)`.

use crate::det::{dcos, dsin};
use crate::jsmath;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct V3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Q {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub w: f64,
}

pub const fn v3(x: f64, y: f64, z: f64) -> V3 {
    V3 { x, y, z }
}

pub const NO_ROTATION: Q = Q { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };

pub fn add(a: V3, b: V3) -> V3 {
    v3(a.x + b.x, a.y + b.y, a.z + b.z)
}

pub fn sub(a: V3, b: V3) -> V3 {
    v3(a.x - b.x, a.y - b.y, a.z - b.z)
}

pub fn scale(a: V3, s: f64) -> V3 {
    v3(a.x * s, a.y * s, a.z * s)
}

pub fn dot(a: V3, b: V3) -> f64 {
    a.x * b.x + a.y * b.y + a.z * b.z
}

pub fn cross(a: V3, b: V3) -> V3 {
    v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
}

/// `len` : `Math.hypot(a.x, a.y, a.z)`, comme V8.
pub fn len(a: V3) -> f64 {
    jsmath::hypot3(a.x, a.y, a.z)
}

/// `norm` : `len(a) || 1` (0, -0 et NaN sont « faux » en JavaScript).
pub fn norm(a: V3) -> V3 {
    let l = len(a);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    scale(a, 1.0 / l)
}

/// Quaternion de la rotation qui envoie X, Y, Z sur les vecteurs unitaires orthogonaux `x`, `y`, `z`.
pub fn quat_from_basis(x: V3, y: V3, z: V3) -> Q {
    let trace = x.x + y.y + z.z;
    if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        return Q { w: 0.25 * s, x: (y.z - z.y) / s, y: (z.x - x.z) / s, z: (x.y - y.x) / s };
    }
    if x.x > y.y && x.x > z.z {
        let s = (1.0 + x.x - y.y - z.z).sqrt() * 2.0;
        return Q { w: (y.z - z.y) / s, x: 0.25 * s, y: (y.x + x.y) / s, z: (z.x + x.z) / s };
    }
    if y.y > z.z {
        let s = (1.0 + y.y - x.x - z.z).sqrt() * 2.0;
        return Q { w: (z.x - x.z) / s, x: (y.x + x.y) / s, y: 0.25 * s, z: (z.y + y.z) / s };
    }
    let s = (1.0 + z.z - x.x - y.y).sqrt() * 2.0;
    Q { w: (x.y - y.x) / s, x: (z.x + x.z) / s, y: (z.y + y.z) / s, z: 0.25 * s }
}

/// La rotation `b`, puis la rotation `a`.
pub fn qmul(a: Q, b: Q) -> Q {
    Q {
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    }
}

/// Rotation d'angle `angle` autour de l'axe unitaire `axis` (`dsin`, `dcos` : les fonctions
/// déterministes, comme le TypeScript).
pub fn axis_angle(axis: V3, angle: f64) -> Q {
    let s = dsin(angle / 2.0);
    Q { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: dcos(angle / 2.0) }
}

pub fn qrot(q: Q, v: V3) -> V3 {
    let (qx, qy, qz, qw) = (q.x, q.y, q.z, q.w);
    let tx = 2.0 * (qy * v.z - qz * v.y);
    let ty = 2.0 * (qz * v.x - qx * v.z);
    let tz = 2.0 * (qx * v.y - qy * v.x);
    v3(
        v.x + qw * tx + (qy * tz - qz * ty),
        v.y + qw * ty + (qz * tx - qx * tz),
        v.z + qw * tz + (qx * ty - qy * tx),
    )
}

pub fn qrot_inv(q: Q, v: V3) -> V3 {
    qrot(Q { x: -q.x, y: -q.y, z: -q.z, w: q.w }, v)
}

/// `clamp` : `Math.max(lo, Math.min(hi, v))`, avec la sémantique de JavaScript (NaN, zéros signés).
pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    jsmath::max(lo, jsmath::min(hi, v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_d_un_quart_de_tour() {
        let q = axis_angle(v3(0.0, 1.0, 0.0), std::f64::consts::FRAC_PI_2);
        let p = qrot(q, v3(0.0, 0.0, 1.0));
        assert!((p.x - 1.0).abs() < 1e-12 && p.z.abs() < 1e-12);
        let back = qrot_inv(q, p);
        assert!((back.z - 1.0).abs() < 1e-12);
    }

    #[test]
    fn base_identite() {
        let q = quat_from_basis(v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0));
        assert_eq!(q, NO_ROTATION);
    }
}
