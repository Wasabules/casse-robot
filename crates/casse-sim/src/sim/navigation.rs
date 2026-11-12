//! La navigation d'un robot au sol autour du décor fixe (src/shared/ai/navigation.ts). L'évitement
//! local (trois rayons, brain.rs) écarte le robot de ce qu'il a devant lui, mais ne sait pas
//! contourner un muret ni trouver une rampe. Ici, on regarde le trajet en ligne droite vers la
//! destination :
//! - si le premier obstacle qu'il traverse est un pilier, un muret ou une plateforme, le robot vise
//!   d'abord le coin de cet obstacle qui fait le trajet le plus court (au large de son rayon) ;
//! - si la destination est sur une plateforme, il va au pied de la rampe la plus commode, la monte
//!   dans son axe jusqu'au bord de la plateforme, puis va à sa destination.
//!
//! Les calculs se font dans le plan (x, z), sur l'emprise au sol des boîtes du décor (un rectangle)
//! et des accessoires ancrés (un arbre, une citerne), comme le TypeScript, opération par opération.
//!
//! Ce que les petites arènes n'ont pas n'est pas encore porté : la grille de passage et le réseau de
//! passage (pas de relief), la ville (`urban` : sortir d'un bâtiment, longer un mur), les ponts et
//! les hautes rampes (`bridgeGoal`, `besideRamp`, `withRamps`), les bâtiments faits d'accessoires
//! (`PropSpot.building`). Une arène qui a un pont ou une haute rampe compte, à chaque fois que la
//! navigation y sert, ce qui n'est pas porté (`Stats.unported`).

use super::props::{present, prop};
use super::vec::{Q, V3, add, qrot, scale, sub, v3};
use super::world::{SceneryBox, Sim};
use crate::jsmath;

/// Ce qu'on contourne : ce qui arrête un robot au sol (`OBSTACLES`).
const OBSTACLE_KINDS: [&str; 6] = ["pillar", "barrier", "platform", "rock", "container", "tower"];
/// Un accessoire ancré dont le bas est à plus de cette hauteur au-dessus du sol ne gêne pas (un toit) (m).
const OVERHEAD: f64 = 1.2;
/// Un accessoire ancré dont l'emprise est plus étroite que cela (demi-côté, m) ne se contourne pas.
const SLENDER: f64 = 0.15;
/// Marge autour d'un obstacle, en plus du rayon du robot (m).
const CLEARANCE: f64 = 0.8;
/// Distance au pied d'une rampe à laquelle on monte droit vers la destination (m).
const FOOT_REACHED: f64 = 2.5;
/// Le pied d'une rampe est pris un peu en avant de son bas (m), et son haut un peu sur la plateforme (m).
const FOOT_APPROACH: f64 = 1.5;
const TOP_INSIDE: f64 = 1.5;
/// Un obstacle dont le haut est à plus de LOWER m sous le centre de masse du robot est sous lui (m).
const LOWER: f64 = 0.4;
/// Ce qui est à plus de BEYOND m au-delà du bord de l'arène (`bounds.half`) ne compte pas (m).
const BEYOND: f64 = 5.0;
/// Une rampe qui monte de plus que cela (m) est une haute rampe (pas encore portée).
const TALL_RAMP: f64 = 2.0;
/// Sur une haute rampe, il vise un point de son axe à cette distance devant lui (m).
const RAMP_LEAD: f64 = 4.0;

/// Un rectangle du plan (x, z) (`Rect`).
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub min_x: f64,
    pub max_x: f64,
    pub min_z: f64,
    pub max_z: f64,
}

/// Un obstacle au sol (`Obstacle`) : son emprise, la boîte du décor s'il en est une (son rang dans
/// `Sim.boxes`), s'il est assez haut et large pour qu'on s'abrite derrière, ses hauteurs.
pub struct Obstacle {
    pub rect: Rect,
    pub boxed: Option<usize>,
    pub shelter: bool,
    pub bottom: f64,
    pub top: f64,
}

pub fn flat_distance(a: V3, b: V3) -> f64 {
    jsmath::hypot2(a.x - b.x, a.z - b.z)
}

/// Demi-emprise au sol (x, z) d'une boîte orientée, et sa demi-hauteur (y) (`footprint`).
fn footprint(half: V3, rot: Q) -> V3 {
    let ax = qrot(rot, v3(half.x, 0.0, 0.0));
    let ay = qrot(rot, v3(0.0, half.y, 0.0));
    let az = qrot(rot, v3(0.0, 0.0, half.z));
    v3(ax.x.abs() + ay.x.abs() + az.x.abs(), ax.y.abs() + ay.y.abs() + az.y.abs(), ax.z.abs() + ay.z.abs() + az.z.abs())
}

/// L'emprise d'une boîte du décor, agrandie de `grow` (`rectOf`).
fn rect_of(b: &SceneryBox, grow: f64) -> Rect {
    let f = footprint(b.half, b.rot);
    Rect { min_x: b.pos.x - f.x - grow, max_x: b.pos.x + f.x + grow, min_z: b.pos.z - f.z - grow, max_z: b.pos.z + f.z + grow }
}

fn grown(r: Rect, grow: f64) -> Rect {
    Rect { min_x: r.min_x - grow, max_x: r.max_x + grow, min_z: r.min_z - grow, max_z: r.max_z + grow }
}

fn inside(p: V3, r: Rect) -> bool {
    p.x > r.min_x && p.x < r.max_x && p.z > r.min_z && p.z < r.max_z
}

/// Part (0 à 1) du segment a → b à laquelle il entre dans le rectangle, ou rien s'il ne le traverse pas (`entry`).
fn entry(a: V3, b: V3, r: Rect) -> Option<f64> {
    let mut span = (0.0, 1.0);
    if !clip(a.x, b.x - a.x, r.min_x, r.max_x, &mut span) || !clip(a.z, b.z - a.z, r.min_z, r.max_z, &mut span) {
        return None;
    }
    Some(span.0)
}

/// Restreint `span` à la part du segment (départ `p`, déplacement `d`) comprise entre `lo` et `hi` ;
/// faux s'il n'en reste rien (`clip`).
fn clip(p: f64, d: f64, lo: f64, hi: f64, span: &mut (f64, f64)) -> bool {
    if d.abs() < 1e-9 {
        return !(p <= lo || p >= hi);
    }
    let mut near = (lo - p) / d;
    let mut far = (hi - p) / d;
    if near > far {
        std::mem::swap(&mut near, &mut far);
    }
    span.0 = jsmath::max(span.0, near);
    span.1 = jsmath::min(span.1, far);
    span.0 < span.1
}

/// Un tablier de pont (`isBridge`).
fn is_bridge(b: &SceneryBox) -> bool {
    b.kind == "deck" && jsmath::min(b.half.x, b.half.z) >= 1.0
}

/// Les deux bouts d'une rampe, le long de sa plus grande longueur : le bas, puis le haut.
fn ramp_ends(b: &SceneryBox) -> (V3, V3) {
    let along = if b.half.x > b.half.z { v3(b.half.x, 0.0, 0.0) } else { v3(0.0, 0.0, b.half.z) };
    let ends = [add(b.pos, qrot(b.rot, along)), sub(b.pos, qrot(b.rot, along))];
    if ends[0].y < ends[1].y { (ends[0], ends[1]) } else { (ends[1], ends[0]) }
}

/// Ce que la navigation ne sait pas encore faire dans ce décor : ses ponts et ses hautes rampes.
pub fn nav_gaps(boxes: &[SceneryBox]) -> u32 {
    let mut gaps = 0;
    for b in boxes {
        if is_bridge(b) {
            gaps += 1;
        } else if b.kind == "ramp" {
            let (low, high) = ramp_ends(b);
            if high.y - low.y >= TALL_RAMP {
                gaps += 1;
            }
        }
    }
    gaps
}

/// Ce qui arrête un robot au sol (`obstacles`) : piliers, murets, plateformes, rochers, conteneurs,
/// immeubles ; chaque accessoire ancré debout, assez bas et large (un arbre, une citerne ; son
/// emprise d'après la pose de son corps, que rien ne bouge tant qu'il est ancré : `footingOf`).
pub fn obstacles(sim: &Sim) -> Vec<Obstacle> {
    let mut list = Vec::new();
    // Au-delà du bord de l'arène, rien ne gêne personne
    let edge = sim.bounds.half + BEYOND;
    let within = |r: &Rect| r.max_x > -edge && r.min_x < edge && r.max_z > -edge && r.min_z < edge;
    for (i, b) in sim.boxes.iter().enumerate() {
        if !OBSTACLE_KINDS.contains(&b.kind.as_str()) {
            continue;
        }
        // (une plateforme et ses hautes rampes : un seul obstacle ; il n'y a pas de haute rampe ici, `nav_gaps`)
        let rect = rect_of(b, 0.0);
        let dy = footprint(b.half, b.rot).y;
        if within(&rect) {
            list.push(Obstacle { rect, boxed: Some(i), shelter: b.kind != "platform", bottom: b.pos.y - dy, top: b.pos.y + dy });
        }
    }
    for i in present(sim) {
        let p = prop(sim, i);
        if !p.fixed {
            continue;
        }
        let pos = sim.phys.translation(p.rb);
        let rot = sim.phys.rotation(p.rb);
        let f = footprint(p.half, rot);
        let bottom = pos.y - qrot(rot, v3(0.0, p.half.y, 0.0)).y.abs();
        // (sans relief, le sol est à 0 : `groundLevel`)
        let blocks = bottom <= 0.0 + OVERHEAD && jsmath::max(f.x, f.z) >= SLENDER;
        if !blocks {
            continue;
        }
        let rect = Rect { min_x: pos.x - f.x, max_x: pos.x + f.x, min_z: pos.z - f.z, max_z: pos.z + f.z };
        list.push(Obstacle { rect, boxed: None, shelter: jsmath::min(f.x, f.z) > 1.0, bottom, top: pos.y + f.y });
    }
    list
}

/// La rampe d'une plateforme à prendre (`RampPath`) : son rang, devant son bas, un peu au-delà de son
/// haut (sur la plateforme), et si c'est une haute rampe.
struct RampPath {
    ramp: usize,
    foot: V3,
    top: V3,
    tall: bool,
}

/// Le point de l'axe d'une rampe (du pied au haut) à RAMP_LEAD m devant la projection de `pos` (`alongRamp`).
fn along_ramp(path: &RampPath, pos: V3) -> V3 {
    let dx = path.top.x - path.foot.x;
    let dz = path.top.z - path.foot.z;
    let length = or_one(jsmath::hypot2(dx, dz));
    let t = ((pos.x - path.foot.x) * dx + (pos.z - path.foot.z) * dz) / length;
    let k = jsmath::min(length, jsmath::max(0.0, t) + RAMP_LEAD) / length;
    v3(path.foot.x + dx * k, path.top.y, path.foot.z + dz * k)
}

/// `x || 1` : 0, -0 et NaN sont « faux » en JavaScript.
fn or_one(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 1.0 } else { x }
}

/// La rampe de cette plateforme la plus commode pour aller de `from` à `to` (`rampPath`) ; le pied
/// d'une haute rampe se prend plus loin (de `reach` m de plus).
fn ramp_path(sim: &Sim, platform: usize, from: V3, to: V3, reach: f64) -> Option<RampPath> {
    let top = rect_of(&sim.boxes[platform], 1.0);
    let mut best = None;
    let mut best_cost = f64::INFINITY;
    for (i, b) in sim.boxes.iter().enumerate() {
        if b.kind != "ramp" {
            continue;
        }
        let (low, high) = ramp_ends(b);
        if !inside(high, top) {
            continue;
        }
        let out = sub(low, high);
        let length = or_one(jsmath::hypot2(out.x, out.z));
        let lead = if high.y - low.y >= TALL_RAMP { FOOT_APPROACH + reach } else { FOOT_APPROACH };
        let foot = add(v3(low.x, 0.0, low.z), scale(v3(out.x, 0.0, out.z), lead / length));
        let upper = add(v3(high.x, 0.0, high.z), scale(v3(out.x, 0.0, out.z), -TOP_INSIDE / length));
        let cost = flat_distance(from, foot) + flat_distance(foot, to);
        if cost < best_cost {
            best_cost = cost;
            best = Some(RampPath { ramp: i, foot, top: upper, tall: high.y - low.y >= TALL_RAMP });
        }
    }
    best
}

/// Le robot est sur une rampe (dans son emprise au sol) (`onRamp`).
fn on_ramp(sim: &Sim, pos: V3) -> bool {
    sim.boxes.iter().any(|b| b.kind == "ramp" && inside(pos, rect_of(b, 0.0)))
}

/// Point vers lequel rouler pour aller à `target` depuis `pos` (`navigate`) : la destination
/// elle-même si la voie est libre ; sinon le pied d'une rampe ou le coin d'un obstacle.
pub fn navigate(sim: &mut Sim, b: usize, pos: V3, target: V3) -> V3 {
    // (un pont, une haute rampe : pas encore portés)
    if sim.nav_gaps > 0 {
        sim.stats.unported += 1;
    }
    let sim = &*sim;
    let radius = sim.bots[b].radius;
    // (sans grille de passage, ni pont, ni réseau : la destination reste celle qu'on monte rejoindre)
    let final_ = target;
    let mut goal = target;
    // Destination sur une plateforme : par une rampe, sauf s'il y est déjà ou qu'il en est au pied
    let mut aboard: Option<usize> = None;
    let mut climbing: Option<usize> = None;
    for (i, bx) in sim.boxes.iter().enumerate() {
        if bx.kind != "platform" {
            continue;
        }
        let top = rect_of(bx, 0.0);
        if inside(pos, rect_of(bx, 0.3)) {
            aboard = Some(i);
        }
        if !inside(final_, top) || aboard == Some(i) {
            continue;
        }
        let Some(path) = ramp_path(sim, i, pos, final_, radius) else { break };
        // Au pied ou déjà sur la rampe : il la monte dans son axe, sans déborder sur ses côtés
        if inside(pos, rect_of(&sim.boxes[path.ramp], 0.3)) || flat_distance(pos, path.foot) <= FOOT_REACHED {
            climbing = Some(path.ramp);
        }
        goal = match climbing {
            None => path.foot,
            Some(_) if path.tall => along_ramp(&path, pos),
            Some(_) => path.top,
        };
        break;
    }

    let grow = radius + CLEARANCE;
    // Premier obstacle sur le trajet : on vise son coin le plus commode
    let mut first: Option<Rect> = None;
    let mut first_t = f64::INFINITY;
    // Ce qui est loin du trajet (au-delà de la marge) ne peut pas le couper : écarté sans calcul
    let reach = grown(
        Rect { min_x: jsmath::min(pos.x, goal.x), max_x: jsmath::max(pos.x, goal.x), min_z: jsmath::min(pos.z, goal.z), max_z: jsmath::max(pos.z, goal.z) },
        grow,
    );
    for o in obstacles(sim) {
        let rect = o.rect;
        if rect.min_x >= reach.max_x || rect.max_x <= reach.min_x || rect.min_z >= reach.max_z || rect.max_z <= reach.min_z {
            continue;
        }
        if o.boxed.is_some() && o.boxed == aboard {
            continue;
        }
        let bx = o.boxed.map(|i| &sim.boxes[i]);
        // Plus bas que lui : rien à contourner
        if let Some(bx) = bx
            && bx.pos.y + bx.half.y < pos.y - LOWER
        {
            continue;
        }
        if bx.is_some_and(|bx| bx.kind == "platform") && (inside(goal, rect) || on_ramp(sim, pos)) {
            continue;
        }
        // Destination dans l'emprise (au pied d'un mur) : il y va tout droit, l'évitement local fait le reste
        if bx.is_none() && inside(goal, rect) {
            continue;
        }
        let r = grown(rect, grow);
        // Déjà contre lui : l'évitement local s'en charge
        if inside(pos, r) {
            continue;
        }
        if let Some(t) = entry(pos, goal, r)
            && t < first_t
        {
            first_t = t;
            first = Some(r);
        }
    }
    let Some(r) = first else { return goal };
    let corners = [v3(r.min_x, 0.0, r.min_z), v3(r.min_x, 0.0, r.max_z), v3(r.max_x, 0.0, r.min_z), v3(r.max_x, 0.0, r.max_z)];
    // Un coin est derrière l'obstacle si on le traverse pour l'atteindre (dans sa marge : l'obstacle lui-même)
    let shrunk = Rect { min_x: r.min_x + 0.05, max_x: r.max_x - 0.05, min_z: r.min_z + 0.05, max_z: r.max_z - 0.05 };
    let mut best = goal;
    let mut best_cost = f64::INFINITY;
    for c in corners {
        if entry(pos, c, shrunk).is_some() {
            continue;
        }
        // (hors ville et sans réseau de passage : ni coin gardé, ni coin injoignable ; `+ 0 - 0`)
        let cost = flat_distance(pos, c) + flat_distance(c, goal);
        if cost < best_cost {
            best_cost = cost;
            best = c;
        }
    }
    best
}
