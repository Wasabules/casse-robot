//! Les formes de blocs autres que le cube (src/shared/catalog/shapes.ts) : biseau, coins, arrondis,
//! pentes, demi-bloc ; chacune l'intersection du cube de demi-côté 1 et de demi-espaces (n·p ≤ d),
//! en un ou deux morceaux convexes, dont la physique fait des enveloppes convexes (robot.rs,
//! `addShape`). Recalculées ici comme le fait le TypeScript, opération par opération : le catalogue
//! (content/catalog.json) n'en donne que des sommets arrondis, et l'enveloppe d'un sommet qui diffère
//! d'un bit n'est plus la même.

use super::vec::{V3, add, cross, dot, len, norm, scale, sub, v3};
use crate::det::{dcos, dsin};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Demi-espace n·p ≤ d.
#[derive(Clone, Copy)]
struct HalfSpace {
    n: V3,
    d: f64,
}

/// Une face : son contour (sens trigonométrique vu de dehors) et sa normale sortante.
#[derive(Clone)]
struct Face {
    normal: V3,
    points: Vec<V3>,
}

/// Un morceau convexe d'une forme : ses sommets, son volume (cube de demi-côté 1 : 8), et ses faces
/// (normale sortante, aire : `shapeFaces`, combat/melee.ts).
#[derive(Clone)]
pub struct Piece {
    pub points: Vec<V3>,
    pub volume: f64,
    pub faces: Vec<(V3, f64)>,
}

const ROUND_FACETS: usize = 6;
const EPS: f64 = 1e-7;

/// Plans tangents au cylindre qui arrondit l'arête du haut (`roundPlanes`).
fn round_planes(axis_x: bool) -> Vec<HalfSpace> {
    let mut planes = Vec::new();
    for k in 0..ROUND_FACETS {
        let t = ((k as f64 + 0.5) * std::f64::consts::PI) / 2.0 / ROUND_FACETS as f64;
        let n = if axis_x { v3(0.0, dsin(t), dcos(t)) } else { v3(dcos(t), dsin(t), 0.0) };
        planes.push(HalfSpace { n, d: 2.0 - dsin(t) - dcos(t) });
    }
    planes
}

const SLOPE_FRONT: HalfSpace = HalfSpace { n: v3(0.0, 1.0, 1.0), d: 0.0 };
const SLOPE_LEFT: HalfSpace = HalfSpace { n: v3(1.0, 1.0, 0.0), d: 0.0 };

/// Les morceaux de chaque forme (`SHAPE_SPECS`), en demi-espaces.
fn specs(shape: &str) -> Option<Vec<Vec<HalfSpace>>> {
    Some(match shape {
        "wedge" => vec![vec![SLOPE_FRONT]],
        "corner" => vec![vec![SLOPE_FRONT, SLOPE_LEFT]],
        "innerCorner" => vec![vec![SLOPE_FRONT], vec![SLOPE_LEFT]],
        "round" => vec![round_planes(true)],
        "roundCorner" => vec![[round_planes(true), round_planes(false)].concat()],
        "slopeLow" => vec![vec![HalfSpace { n: v3(0.0, 1.0, 0.5), d: -0.5 }]],
        "slopeHigh" => vec![vec![HalfSpace { n: v3(0.0, 1.0, 0.5), d: 0.5 }]],
        "slab" => vec![vec![HalfSpace { n: v3(0.0, 1.0, 0.0), d: 0.0 }]],
        _ => return None,
    })
}

/// Contour ordonné dans le sens trigonométrique autour de `normal` (`around`) : le tri du
/// TypeScript (`Array.prototype.sort`, stable) sur l'angle de chaque point.
fn around(points: &[V3], normal: V3) -> Vec<V3> {
    let c = scale(points.iter().fold(v3(0.0, 0.0, 0.0), |s, p| add(s, *p)), 1.0 / points.len() as f64);
    let u = norm(if normal.x.abs() < 0.9 { cross(v3(1.0, 0.0, 0.0), normal) } else { cross(v3(0.0, 1.0, 0.0), normal) });
    let v = cross(normal, u);
    let angle = |p: &V3| dot(sub(*p, c), v).atan2(dot(sub(*p, c), u));
    let mut sorted = points.to_vec();
    // (le comparateur du TypeScript rend angle(a) - angle(b) ; NaN y vaut « égaux »)
    sorted.sort_by(|a, b| {
        let diff = angle(a) - angle(b);
        if diff < 0.0 {
            std::cmp::Ordering::Less
        } else if diff > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    sorted
}

/// Sans les points en double (`unique`).
fn unique(points: &[V3]) -> Vec<V3> {
    let mut out: Vec<V3> = Vec::new();
    for p in points {
        if !out.iter().any(|q| len(sub(*p, *q)) < 1e-6) {
            out.push(*p);
        }
    }
    out
}

/// Aire d'un contour plan (`area`).
fn area(points: &[V3]) -> f64 {
    let mut s = v3(0.0, 0.0, 0.0);
    let mut i = 1;
    while i + 1 < points.len() {
        s = add(s, cross(sub(points[i], points[0]), sub(points[i + 1], points[0])));
        i += 1;
    }
    len(s) / 2.0
}

/// Le cube de demi-côté 1, face par face (`cube`).
fn cube() -> Vec<Face> {
    let mut faces = Vec::new();
    for axis in 0..3 {
        for s in [-1.0, 1.0] {
            let normal = v3(if axis == 0 { s } else { 0.0 }, if axis == 1 { s } else { 0.0 }, if axis == 2 { s } else { 0.0 });
            let mut points = Vec::new();
            for a in [-1.0, 1.0] {
                for b in [-1.0, 1.0] {
                    points.push(match axis {
                        0 => v3(s, a, b),
                        1 => v3(a, s, b),
                        _ => v3(a, b, s),
                    });
                }
            }
            faces.push(Face { normal, points: around(&points, normal) });
        }
    }
    faces
}

/// Coupe un polyèdre convexe par le demi-espace, et le referme par la face de coupe (`clip`).
fn clip(faces: &[Face], h: HalfSpace) -> Vec<Face> {
    let n = norm(h.n);
    let d = h.d / len(h.n);
    let mut out: Vec<Face> = Vec::new();
    let mut cut: Vec<V3> = Vec::new();
    for face in faces {
        let mut kept: Vec<V3> = Vec::new();
        let pts = &face.points;
        for i in 0..pts.len() {
            let a = pts[i];
            let b = pts[(i + 1) % pts.len()];
            let da = dot(n, a) - d;
            let db = dot(n, b) - d;
            if da <= EPS {
                kept.push(a);
            }
            if da.abs() <= EPS {
                cut.push(a);
            }
            if (da < -EPS && db > EPS) || (da > EPS && db < -EPS) {
                let p = add(a, scale(sub(b, a), da / (da - db)));
                kept.push(p);
                cut.push(p);
            }
        }
        let poly = unique(&kept);
        if poly.len() >= 3 && area(&poly) > 1e-6 {
            out.push(Face { normal: face.normal, points: poly });
        }
    }
    let cap = unique(&cut);
    let flush = out.iter().any(|f| dot(f.normal, n) > 1.0 - 1e-9);
    if !flush && cap.len() >= 3 {
        let points = around(&cap, n);
        if area(&points) > 1e-6 {
            out.push(Face { normal: n, points });
        }
    }
    out
}

/// Volume d'un polyèdre fermé (`volume`).
fn volume(faces: &[Face]) -> f64 {
    let mut v = 0.0;
    for f in faces {
        let points = &f.points;
        let mut i = 1;
        while i + 1 < points.len() {
            v += dot(points[0], cross(points[i], points[i + 1])) / 6.0;
            i += 1;
        }
    }
    v
}

fn piece(planes: &[HalfSpace]) -> Piece {
    let mut faces = cube();
    for h in planes {
        faces = clip(&faces, *h);
    }
    let all: Vec<V3> = faces.iter().flat_map(|f| f.points.iter().copied()).collect();
    Piece { points: unique(&all), volume: volume(&faces), faces: faces.iter().map(|f| (f.normal, area(&f.points))).collect() }
}

/// Les morceaux convexes d'une forme, dans un cube de demi-côté 1 (`shapePieces`, calculés une fois).
pub fn shape_pieces(shape: &str) -> Option<&'static [Piece]> {
    static CACHE: OnceLock<HashMap<&'static str, Vec<Piece>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| {
        let mut map = HashMap::new();
        for id in ["wedge", "corner", "innerCorner", "round", "roundCorner", "slopeLow", "slopeHigh", "slab"] {
            let pieces = specs(id).unwrap_or_default().iter().map(|p| piece(p)).collect();
            map.insert(id, pieces);
        }
        map
    });
    cache.get(shape).map(Vec::as_slice)
}

/// Les faces de tous les morceaux d'une forme (`shapeFaces`, combat/melee.ts : une lame qui frappe un
/// bloc de forme cherche la face qui lui fait face).
pub fn shape_faces(shape: &str) -> Vec<(V3, f64)> {
    shape_pieces(shape).map_or_else(Vec::new, |pieces| pieces.iter().flat_map(|p| p.faces.iter().copied()).collect())
}

/// Part du cube qu'occupe une forme (`shapeFraction`) : deux morceaux qui se recouvrent comptent
/// une fois ce qu'ils ont en commun.
pub fn shape_fraction(shape: &str) -> Option<f64> {
    let specs = specs(shape)?;
    let pieces = shape_pieces(shape)?;
    let total = if pieces.len() == 2 { pieces[0].volume + pieces[1].volume - piece(&[specs[0].clone(), specs[1].clone()].concat()).volume } else { pieces[0].volume };
    Some(total / 8.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volumes_des_formes() {
        // Le biseau : la moitié du cube ; le demi-bloc aussi ; le coin, un tiers ; le coin rentrant, deux morceaux
        let half = |id: &str| shape_pieces(id).unwrap()[0].volume / 8.0;
        assert!((half("wedge") - 0.5).abs() < 1e-12);
        assert!((half("slab") - 0.5).abs() < 1e-12);
        assert!((half("corner") - 1.0 / 3.0).abs() < 1e-12);
        assert_eq!(shape_pieces("innerCorner").unwrap().len(), 2);
        assert_eq!(shape_pieces("wedge").unwrap()[0].points.len(), 6);
        assert!(shape_pieces("sphere").is_none());
    }
}
