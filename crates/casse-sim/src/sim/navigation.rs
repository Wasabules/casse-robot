//! La navigation d'un robot au sol autour du décor fixe (src/shared/ai/navigation.ts). L'évitement
//! local (trois rayons, brain.rs) écarte le robot de ce qu'il a devant lui, mais ne sait pas
//! contourner un muret ni trouver une rampe. Ici, on regarde le trajet en ligne droite vers la
//! destination :
//! - si le premier obstacle qu'il traverse est un pilier, un muret, une plateforme, un bâtiment fait
//!   d'accessoires, un arbre, le robot vise d'abord le coin de cet obstacle qui fait le trajet le plus
//!   court (au large de son rayon) ;
//! - si la destination est sur une plateforme, il va au pied de la rampe la plus commode, la monte
//!   dans son axe jusqu'au bord de la plateforme, puis va à sa destination ; le long du flanc d'une
//!   haute rampe, il la longe jusqu'à son bas ;
//! - un pont se prend par l'un de ses bouts et se quitte par un bout ; sous une voie surélevée, on
//!   passe (`bridgeGoal`) ;
//! - dans une ville (`urban`), une destination dans un bâtiment est ramenée dans la rue, un robot
//!   entré dans un bâtiment en ressort par une ouverture, et un robot qui longe un mur le contourne ;
//! - dans une arène à grille de passage (pentes, lave, eau profonde), la destination passe d'abord par
//!   elle (`gridWaypoint` : A*, navgrid.rs) ; dans une arène à réseau de passage (le Canyon), le plus
//!   court chemin du réseau (`routeGoal`), et seuls comptent les obstacles à sa hauteur (`atLevel`).
//!
//! Les calculs se font dans le plan (x, z), sur l'emprise au sol des boîtes du décor et des
//! accessoires ancrés, comme le TypeScript, opération par opération. Ce que le TypeScript garde par
//! robot dans des `WeakMap` (son chemin sur la grille, sa route sur le réseau, le coin qu'il vise en
//! ville) est dans `Bot.nav` ; le nombre de recherches de chemin du pas, dans `Sim.searches`.

use super::arena::{Grid, LINK_MARGIN, LINK_REACH, footprint, is_bridge, ground_level, or_one, walkable};
use super::brain::Mode;
use super::props::{present, prop};
use super::vec::{Q, V3, add, qrot, scale, sub, v3};
use super::world::{SceneryBox, Sim};
use crate::jsmath;
use std::rc::Rc;

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
/// Un pont s'aborde à DECK_APPROACH m de son bout, dans son axe ; on est dessus à moins de DECK_ABOARD m sous son tablier.
const DECK_APPROACH: f64 = 5.0;
const DECK_ABOARD: f64 = 1.5;
/// Dans une arène à grille de passage, aux abords d'un pont (à moins de DECK_LANE m de son axe), le
/// robot vise un point de l'axe PURSUIT m plus loin.
const DECK_LANE: f64 = 3.0;
const PURSUIT: f64 = 6.0;
/// Un obstacle dont le haut est à plus de LOWER m sous le centre de masse du robot est sous lui (m).
const LOWER: f64 = 0.4;
/// Avec un réseau de passage : un obstacle dont le bas est à plus de ABOVE m au-dessus du centre de masse du robot est au-dessus de lui (m).
const ABOVE: f64 = 1.5;
/// En ville, un coin à moins de cela est atteint : il vise le suivant (m).
const CORNER_REACHED: f64 = 1.5;
/// Ce qui est à plus de BEYOND m au-delà du bord de l'arène (`bounds.half`) ne compte pas (m).
const BEYOND: f64 = 5.0;
/// Une rampe qui monte de plus que cela (m) est une haute rampe.
const TALL_RAMP: f64 = 2.0;
/// Un mur est sur un côté de son bâtiment s'il en est à moins de ON_SIDE m ; une ouverture plus large
/// que DOOR m est une sortie.
const ON_SIDE: f64 = 0.6;
const DOOR: f64 = 2.4;
/// En ville, le corps d'un robot : cette part de son rayon (au plus BODY_MAX m) autour de son centre.
const BODY: f64 = 0.9;
const BODY_MAX: f64 = 2.2;
/// Sur une haute rampe, il vise un point de son axe à cette distance devant lui (m).
const RAMP_LEAD: f64 = 4.0;
/// En ville, le coin visé se garde tant qu'aucun autre n'est plus court de CORNER_KEEP m.
const CORNER_KEEP: f64 = 3.0;
/// Ce qu'ajoute au détour un coin qu'il ne rejoint pas sur un sol praticable (m).
const UNREACHABLE_CORNER: f64 = 1000.0;
/// Le réseau de passage : la route se recalcule quand la destination a bougé de plus de REPLAN_SHIFT m,
/// ou toutes les REPLAN_EVERY s ; un point est passé à moins de WAYPOINT_REACHED m ; toutes les
/// SKIP_EVERY s, on regarde si l'on peut couper au suivant ; destination injoignable : les
/// GOAL_FALLBACK points les plus proches d'elle.
const REPLAN_SHIFT: f64 = 6.0;
const REPLAN_EVERY: f64 = 2.0;
const WAYPOINT_REACHED: f64 = 3.5;
const SKIP_EVERY: f64 = 0.4;
const GOAL_FALLBACK: usize = 3;
/// La grille de passage : un chemin se recalcule au bout de REPLAN s, si le robot s'en est écarté de
/// plus de OFF_ROUTE cases, ou si sa destination a bougé de plus de GOAL_DRIFT cases ; jamais moins de
/// MIN_REPLAN s après le précédent.
const REPLAN: f64 = 4.0;
const MIN_REPLAN: f64 = 1.0;
const OFF_ROUTE: f64 = 3.0;
const GOAL_DRIFT: i64 = 4;
/// En combat, un chemin plus long que DETOUR_FACTOR fois la ligne droite, plus DETOUR_SLACK m, ne vaut
/// pas le détour : il va au plus près, parmi les DETOUR_REACH cases autour de lui.
const DETOUR_FACTOR: f64 = 2.5;
const DETOUR_SLACK: f64 = 25.0;
const DETOUR_REACH: usize = 120;
/// Le robot vise la plus lointaine des LOOKAHEAD cases suivantes de son chemin qu'il voit en ligne droite.
const LOOKAHEAD: usize = 14;
/// Recherches de chemin par pas, tous robots confondus.
const SEARCHES_PER_STEP: u32 = 1;

/// Un rectangle du plan (x, z) (`Rect`).
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub min_x: f64,
    pub max_x: f64,
    pub min_z: f64,
    pub max_z: f64,
}

/// Un obstacle au sol (`Obstacle`) : son emprise, la boîte du décor s'il en est une (son rang dans
/// `Sim.boxes`), s'il est assez haut et large pour qu'on s'abrite derrière, les murs encore debout d'un
/// bâtiment, ses hauteurs.
pub struct Obstacle {
    pub rect: Rect,
    pub boxed: Option<usize>,
    pub shelter: bool,
    pub walls: Option<Vec<Rect>>,
    pub bottom: f64,
    pub top: f64,
}

/// Le chemin d'un robot sur la grille de passage (`GridRoute`) : sa case d'arrivée, ses cases, celle
/// qu'il vise, quand il a été calculé, s'il ne va qu'au plus près.
#[derive(Clone, Debug)]
pub struct GridRoute {
    goal: usize,
    cells: Vec<usize>,
    at: usize,
    time: f64,
    short: bool,
}

/// La route d'un robot sur le réseau de passage (`NavRoute`) : la destination pour laquelle elle a été
/// calculée, les points qui lui restent à passer, quand elle a été calculée, puis vérifiée.
#[derive(Clone, Debug)]
pub struct NavRoute {
    goal: V3,
    path: std::collections::VecDeque<usize>,
    planned: f64,
    checked: f64,
}

/// Ce que la navigation garde d'un robot (des `WeakMap` du TypeScript) : son chemin sur la grille, sa
/// route sur le réseau, le coin qu'il vise en ville (`aimed`).
#[derive(Clone, Debug, Default)]
pub struct NavMemory {
    pub grid: Option<GridRoute>,
    pub route: Option<NavRoute>,
    pub aimed: Option<V3>,
}

pub fn flat_distance(a: V3, b: V3) -> f64 {
    jsmath::hypot2(a.x - b.x, a.z - b.z)
}

/// L'emprise d'une boîte, agrandie de `grow` (`rectOf`).
fn rect_of(pos: V3, half: V3, rot: Q, grow: f64) -> Rect {
    let f = footprint(half, rot);
    Rect { min_x: pos.x - f.x - grow, max_x: pos.x + f.x + grow, min_z: pos.z - f.z - grow, max_z: pos.z + f.z + grow }
}

fn box_rect(b: &SceneryBox, grow: f64) -> Rect {
    rect_of(b.pos, b.half, b.rot, grow)
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

/// L'obstacle est à la hauteur d'un robot dont le centre de masse est à `y` : ni sous lui, ni
/// au-dessus de lui (`atLevel` ; seulement dans une arène à réseau de passage).
pub fn at_level(o: &Obstacle, y: f64) -> bool {
    o.top >= y - LOWER && o.bottom <= y + ABOVE
}

/// Une haute rampe dans le plan (`TallRamp`) : son rang, son emprise, son haut, son centre, son axe
/// (vers son bas) et son travers, sa demi-longueur et sa demi-largeur (m).
#[derive(Clone, Copy)]
pub struct TallRamp {
    pub ramp: usize,
    rect: Rect,
    top: V3,
    center: V3,
    down: V3,
    across: V3,
    half: f64,
    width: f64,
}

/// Les deux bouts d'une rampe, le long de sa plus grande longueur : le bas, puis le haut.
fn ramp_ends(b: &SceneryBox) -> (V3, V3) {
    let along = if b.half.x > b.half.z { v3(b.half.x, 0.0, 0.0) } else { v3(0.0, 0.0, b.half.z) };
    let ends = [add(b.pos, qrot(b.rot, along)), sub(b.pos, qrot(b.rot, along))];
    if ends[0].y < ends[1].y { (ends[0], ends[1]) } else { (ends[1], ends[0]) }
}

/// Les rampes qui montent de plus de TALL_RAMP m (`tallRamps`).
pub fn tall_ramps(boxes: &[SceneryBox]) -> Vec<TallRamp> {
    let mut list = Vec::new();
    for (i, b) in boxes.iter().enumerate() {
        if b.kind != "ramp" {
            continue;
        }
        let along_x = b.half.x > b.half.z;
        let (low, high) = ramp_ends(b);
        if high.y - low.y < TALL_RAMP {
            continue;
        }
        let length = jsmath::hypot2(low.x - high.x, low.z - high.z);
        let down = v3((low.x - high.x) / length, 0.0, (low.z - high.z) / length);
        list.push(TallRamp {
            ramp: i,
            rect: box_rect(b, 0.0),
            top: high,
            center: v3((low.x + high.x) / 2.0, 0.0, (low.z + high.z) / 2.0),
            down,
            across: v3(-down.z, 0.0, down.x),
            half: length / 2.0,
            width: if along_x { b.half.z } else { b.half.x },
        });
    }
    list
}

/// Coordonnées d'un point dans le repère d'une rampe : le long de son axe (+ vers son bas), en travers.
fn ramp_coords(ramp: &TallRamp, p: V3) -> (f64, f64) {
    let dx = p.x - ramp.center.x;
    let dz = p.z - ramp.center.z;
    (dx * ramp.down.x + dz * ramp.down.z, dx * ramp.across.x + dz * ramp.across.z)
}

/// L'emprise d'une plateforme, étendue à celle de ses hautes rampes (`withRamps`).
fn with_ramps(sim: &Sim, platform: &SceneryBox) -> Rect {
    let mut r = box_rect(platform, 0.0);
    let landing = box_rect(platform, 1.0);
    for ramp in &sim.tall_ramps {
        if !inside(ramp.top, landing) {
            continue;
        }
        r.min_x = jsmath::min(r.min_x, ramp.rect.min_x);
        r.max_x = jsmath::max(r.max_x, ramp.rect.max_x);
        r.min_z = jsmath::min(r.min_z, ramp.rect.min_z);
        r.max_z = jsmath::max(r.max_z, ramp.rect.max_z);
    }
    r
}

/// Ce qui arrête un robot au sol (`obstacles`) : piliers, murets, plateformes (et leurs hautes
/// rampes), rochers, conteneurs, immeubles ; chaque accessoire ancré debout, assez bas et large (un
/// arbre, une citerne ; son emprise d'après la pose de son corps, que rien ne bouge tant qu'il est
/// ancré : `footingOf`) ; puis chaque bâtiment (l'emprise de ses murs encore debout, d'un bloc). Gardé
/// le temps d'un pas (comme le TypeScript) : refait quand le temps avance et qu'un accessoire ancré est
/// tombé ou a disparu.
pub fn obstacles(sim: &Sim) -> Rc<Vec<Obstacle>> {
    let fixed = present(sim).into_iter().filter(|&i| prop(sim, i).fixed).count();
    if let Some((time, count, list)) = &*sim.obstacle_cache.borrow()
        && (*time == sim.time || *count == fixed)
    {
        return list.clone();
    }
    let list = Rc::new(survey(sim));
    *sim.obstacle_cache.borrow_mut() = Some((sim.time, fixed, list.clone()));
    list
}

fn survey(sim: &Sim) -> Vec<Obstacle> {
    let mut list = Vec::new();
    // Au-delà du bord de l'arène (les immeubles qui ferment une ville), rien ne gêne personne
    let edge = sim.bounds.half + BEYOND;
    let within = |r: &Rect| r.max_x > -edge && r.min_x < edge && r.max_z > -edge && r.min_z < edge;
    for (i, b) in sim.boxes.iter().enumerate() {
        if !OBSTACLE_KINDS.contains(&b.kind.as_str()) {
            continue;
        }
        // Une plateforme et ses hautes rampes : un seul obstacle
        let rect = if b.kind == "platform" { with_ramps(sim, b) } else { box_rect(b, 0.0) };
        let dy = footprint(b.half, b.rot).y;
        if within(&rect) {
            list.push(Obstacle { rect, boxed: Some(i), shelter: b.kind != "platform", walls: None, bottom: b.pos.y - dy, top: b.pos.y + dy });
        }
    }
    // Les bâtiments, dans l'ordre où on les rencontre (une `Map`)
    let mut buildings: Vec<(u32, Obstacle)> = Vec::new();
    let mut index = std::collections::HashMap::<u32, usize>::new();
    for i in present(sim) {
        let p = prop(sim, i);
        if !p.fixed {
            continue;
        }
        let pos = sim.phys.translation(p.rb);
        let rot = sim.phys.rotation(p.rb);
        let f = footprint(p.half, rot);
        let bottom = pos.y - qrot(rot, v3(0.0, p.half.y, 0.0)).y.abs();
        let blocks = bottom <= ground_level(sim, pos.x, pos.z) + OVERHEAD && jsmath::max(f.x, f.z) >= SLENDER;
        if !blocks {
            continue;
        }
        let r = Rect { min_x: pos.x - f.x, max_x: pos.x + f.x, min_z: pos.z - f.z, max_z: pos.z + f.z };
        let top = pos.y + f.y;
        let Some(building) = sim.arena.buildings.get(i).copied().flatten() else {
            list.push(Obstacle { rect: r, boxed: None, shelter: jsmath::min(f.x, f.z) > 1.0, walls: None, bottom, top });
            continue;
        };
        match index.get(&building) {
            None => {
                index.insert(building, buildings.len());
                buildings.push((building, Obstacle { rect: r, boxed: None, shelter: true, walls: Some(vec![r]), bottom, top }));
            }
            Some(&k) => {
                let b = &mut buildings[k].1;
                b.rect = Rect {
                    min_x: jsmath::min(b.rect.min_x, r.min_x),
                    max_x: jsmath::max(b.rect.max_x, r.max_x),
                    min_z: jsmath::min(b.rect.min_z, r.min_z),
                    max_z: jsmath::max(b.rect.max_z, r.max_z),
                };
                b.walls.as_mut().expect("les murs d'un bâtiment").push(r);
                b.bottom = jsmath::min(b.bottom, bottom);
                b.top = jsmath::max(b.top, top);
            }
        }
    }
    list.extend(buildings.into_iter().map(|(_, o)| o));
    list
}

/// Le point `p` est-il dans un obstacle au sol (hors plateformes), à `margin` m près (`insideObstacle`) ?
pub fn inside_obstacle(sim: &Sim, p: V3, margin: f64) -> bool {
    obstacles(sim).iter().any(|o| !o.boxed.is_some_and(|i| sim.boxes[i].kind == "platform") && inside(p, grown(o.rect, margin)))
}

/// Une destination dans un obstacle (hors plateformes) ou à moins de `margin` m de lui est ramenée au
/// point le plus proche à `margin` m de son bord (`clearOf`).
fn clear_of(sim: &Sim, goal: V3, margin: f64) -> V3 {
    let mut p = goal;
    let m = margin - 0.05;
    let list = obstacles(sim);
    for _ in 0..3 {
        let q = p;
        let hit = list.iter().find(|o| {
            let r = o.rect;
            let bx = o.boxed.map(|i| &sim.boxes[i]);
            !bx.is_some_and(|b| b.kind == "platform")
                && !bx.is_some_and(|b| b.pos.y + b.half.y < q.y - LOWER)
                && q.x > r.min_x - m
                && q.x < r.max_x + m
                && q.z > r.min_z - m
                && q.z < r.max_z + m
        });
        let Some(hit) = hit else { break };
        let r = grown(hit.rect, margin);
        let exits = [v3(r.min_x, p.y, p.z), v3(r.max_x, p.y, p.z), v3(p.x, p.y, r.min_z), v3(p.x, p.y, r.max_z)];
        // (`reduce` : le premier à égalité)
        let mut best = exits[0];
        for &e in &exits[1..] {
            best = if flat_distance(best, p) <= flat_distance(e, p) { best } else { e };
        }
        p = best;
    }
    p
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

/// La rampe de cette plateforme la plus commode pour aller de `from` à `to` (`rampPath`) ; le pied
/// d'une haute rampe se prend plus loin (de `reach` m de plus).
fn ramp_path(sim: &Sim, platform: usize, from: V3, to: V3, reach: f64) -> Option<RampPath> {
    let top = box_rect(&sim.boxes[platform], 1.0);
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
    sim.boxes.iter().any(|b| b.kind == "ramp" && inside(pos, box_rect(b, 0.0)))
}

/// Le robot est sur ce tablier (dans son emprise, à sa hauteur), pas dessous (`isAboard`).
fn is_aboard(b: &SceneryBox, r: Rect, pos: V3) -> bool {
    inside(pos, r) && pos.y > b.pos.y + b.half.y - DECK_ABOARD
}

/// Le robot est sur un pont (`onDeck`).
fn on_deck(sim: &Sim, pos: V3) -> bool {
    sim.boxes.iter().any(|b| is_bridge(b) && is_aboard(b, box_rect(b, 0.0), pos))
}

/// Ce que rend `bridgeGoal` : pas de pont en jeu, la destination elle-même (le même objet en
/// TypeScript : `navigate` compare les identités), ou un autre point.
#[derive(Clone, Copy, PartialEq)]
enum Bridged {
    None,
    Target,
    At(V3),
}

/// Un pont sur le trajet (`bridgeGoal`) : une destination sur son tablier se prend par le bout le plus
/// commode (d'abord son abord, dans l'axe, puis droit dessus) ; un robot sur le tablier qui va ailleurs
/// en sort par le bout le plus proche de sa destination. Sous une voie surélevée, une destination reste
/// en bas, sauf à sa hauteur. Dans une arène à grille de passage, un pont que le trajet traverse se
/// prend aussi par un bout, et se suit dans son axe jusqu'à l'autre.
fn bridge_goal(sim: &Sim, radius: f64, pos: V3, target: V3) -> Bridged {
    let grid = sim.arena.grid.is_some();
    let decks = if grid { &sim.arena.bridges } else { &sim.arena.decks };
    for &i in decks {
        let b = &sim.boxes[i];
        let r = box_rect(b, 0.0);
        let deck = b.pos.y + b.half.y - DECK_ABOARD;
        let aboard = is_aboard(b, r, pos);
        let wanted = inside(target, r) && (!b.underpass || aboard || target.y > deck);
        let crossing = grid && !aboard && !wanted && entry(pos, target, r).is_some();
        // (dessus et y reste, ou ni l'un ni l'autre)
        if aboard == wanted && !crossing {
            continue;
        }
        let axis = if b.half.x > b.half.z { v3(1.0, 0.0, 0.0) } else { v3(0.0, 0.0, 1.0) };
        let length = jsmath::max(b.half.x, b.half.z);
        let approach = b.approach.unwrap_or(DECK_APPROACH);
        let ends = [1.0, -1.0].map(|s: f64| {
            let end = add(v3(b.pos.x, 0.0, b.pos.z), scale(axis, s * length));
            let onto = add(v3(b.pos.x, b.pos.y + b.half.y, b.pos.z), scale(axis, s * (length - DECK_ABOARD)));
            let near = add(v3(b.pos.x, 0.0, b.pos.z), scale(axis, s * (length + approach)));
            (s, end, onto, near)
        });
        if aboard {
            // Il sort par le bout le plus proche de sa destination
            let exit = if flat_distance(ends[0].1, target) <= flat_distance(ends[1].1, target) { ends[0] } else { ends[1] };
            return Bridged::At(exit.3);
        }
        let cost = |e: &(f64, V3, V3, V3)| flat_distance(pos, e.3) + flat_distance(e.3, target);
        let entrance = if cost(&ends[0]) <= cost(&ends[1]) { ends[0] } else { ends[1] };
        let onto = if b.underpass { Bridged::At(entrance.2) } else { Bridged::Target };
        let lateral = ((pos.x - b.pos.x) * (1.0 - axis.x) + (pos.z - b.pos.z) * (1.0 - axis.z)).abs();
        let width = jsmath::min(b.half.x, b.half.z);
        if grid {
            let u = entrance.0 * ((pos.x - b.pos.x) * axis.x + (pos.z - b.pos.z) * axis.z);
            if u < length + approach + 2.0 && lateral < width + DECK_LANE {
                if !crossing && u < length {
                    return onto;
                }
                let next = jsmath::max(u - PURSUIT, -(length + approach));
                return Bridged::At(add(v3(b.pos.x, 0.0, b.pos.z), scale(axis, entrance.0 * next)));
            }
            return Bridged::At(entrance.3);
        }
        // (sous une voie surélevée, il faut d'abord en être sorti par ce bout)
        let along = ((pos.x - b.pos.x) * axis.x + (pos.z - b.pos.z) * axis.z).abs();
        let in_line = lateral < width - radius * 0.5 && flat_distance(pos, entrance.1) < approach + 2.0 && (!b.underpass || along > length);
        if flat_distance(pos, entrance.3) > FOOT_REACHED && !in_line {
            return Bridged::At(entrance.3);
        }
        return onto;
    }
    Bridged::None
}

/// Un robot entré dans un bâtiment en ressort par l'ouverture la plus commode (`buildingExit`) : il se
/// place d'abord en face (un peu en dedans), puis sort. Rien : il n'est dans aucun bâtiment, ou
/// celui-ci est fermé.
fn building_exit(sim: &Sim, radius: f64, pos: V3, target: V3) -> Option<V3> {
    let list = obstacles(sim);
    let home = list.iter().find(|o| o.walls.is_some() && inside(pos, o.rect))?;
    let walls = home.walls.as_ref()?;
    let r = home.rect;
    let need = DOOR;
    let mut best = None;
    let mut best_cost = f64::INFINITY;
    // Chaque côté : s'il court le long de x, sa position, son sens vers l'extérieur
    for (along_x, at, out) in [(true, r.min_z, -1.0), (true, r.max_z, 1.0), (false, r.min_x, -1.0), (false, r.max_x, 1.0)] {
        let gap = |w: &Rect| {
            if along_x {
                if out < 0.0 { w.min_z - r.min_z } else { r.max_z - w.max_z }
            } else if out < 0.0 {
                w.min_x - r.min_x
            } else {
                r.max_x - w.max_x
            }
        };
        let mut covered: Vec<(f64, f64)> =
            walls.iter().filter(|w| gap(w) < ON_SIDE).map(|w| if along_x { (w.min_x, w.max_x) } else { (w.min_z, w.max_z) }).collect();
        covered.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let (from, to) = if along_x { (r.min_x, r.max_x) } else { (r.min_z, r.max_z) };
        let mut openings = Vec::new();
        let mut reached = from;
        for &(a, b) in &covered {
            if a - reached >= need {
                openings.push((reached, a));
            }
            reached = jsmath::max(reached, b);
        }
        if to - reached >= need {
            openings.push((reached, to));
        }
        for (a, b) in openings {
            let mid = (a + b) / 2.0;
            let point = |depth: f64| if along_x { v3(mid, 0.0, at + out * depth) } else { v3(at + out * depth, 0.0, mid) };
            let inner = point(-(radius + 1.0));
            let outer = point(radius + CLEARANCE);
            let cost = flat_distance(pos, inner) + flat_distance(outer, target);
            if cost >= best_cost {
                continue;
            }
            best_cost = cost;
            // En face de l'ouverture, il sort ; sinon, il s'y présente d'abord
            let lateral = ((if along_x { pos.x } else { pos.z }) - mid).abs();
            best = Some(if lateral < (b - a) / 2.0 - radius * 0.7 { outer } else { inner });
        }
    }
    best
}

/// Un robot au pied du flanc d'une haute rampe (qu'il ne monte pas), qui va au-delà de son bas ou de
/// l'autre côté : il la longe jusqu'à son bas, de son côté (`besideRamp`).
fn beside_ramp(sim: &Sim, radius: f64, pos: V3, goal: V3, climbing: Option<usize>) -> Option<V3> {
    for ramp in &sim.tall_ramps {
        if Some(ramp.ramp) == climbing {
            continue;
        }
        let (u, v) = ramp_coords(ramp, pos);
        let side = ramp.width + radius + CLEARANCE;
        if v.abs() < ramp.width - 0.3 || v.abs() > side || u > ramp.half || u < -ramp.half - side {
            continue;
        }
        let (gu, gv) = ramp_coords(ramp, goal);
        // Sa destination est de son côté, sans dépasser le bas de la rampe : rien à faire
        if gu <= ramp.half && jsmath::sign(gv) == jsmath::sign(v) && gv.abs() >= ramp.width {
            continue;
        }
        let sv = jsmath::sign(v);
        let s = if sv == 0.0 || sv.is_nan() { 1.0 } else { sv };
        let lu = ramp.half + 0.8;
        let lv = s * (ramp.width + radius + 0.6);
        return Some(v3(ramp.center.x + ramp.down.x * lu + ramp.across.x * lv, goal.y, ramp.center.z + ramp.down.z * lu + ramp.across.z * lv));
    }
    None
}

/// Demi-largeur de ce qui porte le robot (m : `halfWidth`), au plus la marge des liaisons du réseau
/// (`sideMargin`).
fn side_margin(sim: &Sim, b: usize) -> f64 {
    jsmath::min(LINK_MARGIN, sim.bots[b].half_width)
}

/// Point vers lequel rouler pour aller de `pos` à `goal` par le réseau de passage (`routeGoal`) : la
/// destination elle-même si la ligne droite est praticable, sinon le prochain point du plus court chemin.
fn route_goal(sim: &mut Sim, b: usize, pos: V3, goal: V3) -> V3 {
    let Some(terrain) = &sim.arena.terrain else { return goal };
    let Some(graph) = &sim.arena.graph else { return goal };
    let margin = side_margin(sim, b);
    let stale = match &sim.bots[b].nav.route {
        None => true,
        Some(r) => flat_distance(r.goal, goal) > REPLAN_SHIFT || sim.time - r.planned > REPLAN_EVERY,
    };
    if stale {
        let path = plan_route(terrain, graph, pos, goal, margin);
        sim.bots[b].nav.route = Some(NavRoute { goal, path: path.into(), planned: sim.time, checked: sim.time });
    }
    let (terrain, graph) = (sim.arena.terrain.as_ref().expect("relief"), sim.arena.graph.as_ref().expect("réseau"));
    let node = |i: usize| v3(graph.points[i].0, 0.0, graph.points[i].1);
    let time = sim.time;
    let route = sim.bots[b].nav.route.as_mut().expect("route");
    while route.path.front().is_some_and(|&i| flat_distance(pos, node(i)) < WAYPOINT_REACHED) {
        route.path.pop_front();
    }
    // Couper au plus court : le point suivant (ou la destination) est-il déjà en vue directe ?
    if !route.path.is_empty() && time - route.checked > SKIP_EVERY {
        route.checked = time;
        let next = if route.path.len() > 1 { node(route.path[1]) } else { goal };
        if walkable(terrain, pos.x, pos.z, next.x, next.z, margin) {
            route.path.pop_front();
        }
    }
    route.path.front().map_or(goal, |&i| node(i))
}

/// Plus court chemin du réseau de `pos` à `goal` (les points à passer) ; vide si la ligne droite est
/// praticable (à `margin` m de chaque côté), ou sans issue (`planRoute`).
fn plan_route(terrain: &crate::terrain::Terrain, graph: &super::arena::Graph, pos: V3, goal: V3, margin: f64) -> Vec<usize> {
    if walkable(terrain, pos.x, pos.z, goal.x, goal.z, margin) {
        return Vec::new();
    }
    let points = &graph.points;
    let n = points.len();
    let span = |i: usize, p: V3| jsmath::hypot2(points[i].0 - p.x, points[i].1 - p.z);
    // Départs : les points du réseau qu'il voit en ligne droite, toute sa largeur sur un sol
    // praticable (à défaut, son centre seulement) ; arrivées : ceux d'où l'on voit la destination
    let mut dist = vec![f64::INFINITY; n];
    let mut from = vec![-1i64; n];
    for side in [margin, 0.0] {
        for i in 0..n {
            let d = span(i, pos);
            if d <= LINK_REACH && walkable(terrain, pos.x, pos.z, points[i].0, points[i].1, side) {
                dist[i] = d;
            }
        }
        if dist.iter().any(|&d| d < f64::INFINITY) {
            break;
        }
    }
    let mut exit: Vec<Option<f64>> = vec![None; n];
    let mut exits = 0;
    for i in 0..n {
        let d = span(i, goal);
        if d <= LINK_REACH && walkable(terrain, points[i].0, points[i].1, goal.x, goal.z, margin) {
            exit[i] = Some(d);
            exits += 1;
        }
    }
    if exits == 0 {
        // Destination injoignable : au plus près (un tri stable, comme celui de JavaScript)
        let mut nearest: Vec<usize> = (0..n).collect();
        nearest.sort_by(|&a, &b| {
            let d = span(a, goal) - span(b, goal);
            if d < 0.0 {
                std::cmp::Ordering::Less
            } else if d > 0.0 {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
        for &i in nearest.iter().take(GOAL_FALLBACK) {
            exit[i] = Some(span(i, goal));
        }
    }
    // Dijkstra (le réseau a quelques centaines de points)
    let mut done = vec![false; n];
    let mut best: i64 = -1;
    let mut best_cost = f64::INFINITY;
    loop {
        let mut u: i64 = -1;
        for i in 0..n {
            if !done[i] && dist[i] < f64::INFINITY && (u < 0 || dist[i] < dist[u as usize]) {
                u = i as i64;
            }
        }
        if u < 0 || dist[u as usize] >= best_cost {
            break;
        }
        let u = u as usize;
        done[u] = true;
        if let Some(out) = exit[u]
            && dist[u] + out < best_cost
        {
            best_cost = dist[u] + out;
            best = u as i64;
        }
        for &v in &graph.next[u] {
            let d = dist[u] + jsmath::hypot2(points[u].0 - points[v].0, points[u].1 - points[v].1);
            if d < dist[v] {
                dist[v] = d;
                from[v] = u as i64;
            }
        }
    }
    let mut path = Vec::new();
    let mut i = best;
    while i >= 0 {
        path.push(i as usize);
        i = from[i as usize];
    }
    path.reverse();
    path
}

/// Une recherche de chemin est-elle permise à ce pas (`maySearch`) ? Et la compte.
fn may_search(sim: &mut Sim) -> bool {
    let time = sim.time;
    if sim.searches.is_none_or(|s| s.0 != time) {
        sim.searches = Some((time, 0));
    }
    let s = sim.searches.as_mut().expect("les recherches du pas");
    let ok = s.1 < SEARCHES_PER_STEP;
    s.1 += 1;
    ok
}

/// Étape vers `target` sur la grille de passage (`gridWaypoint`) : la destination (ou la case
/// franchissable la plus proche) si la ligne droite est libre ; sinon un point de son chemin. Avec, en
/// second, si c'est la destination elle-même (le même objet en TypeScript).
fn grid_waypoint(sim: &mut Sim, b: usize, pos: V3, target: V3) -> (V3, bool) {
    let (goal_cell, goal, target_open, n, cell) = {
        let grid: &Grid = sim.arena.grid.as_ref().expect("grille");
        let Some(goal_cell) = grid.nearest_open(grid.cell_at(target.x, target.z)) else { return (target, true) };
        let target_open = grid.nav.open[grid.cell_at(target.x, target.z)] != 0;
        let goal = if target_open { target } else { grid.center(goal_cell) };
        // Ligne droite libre : il y va (et garde son chemin, s'il en a un)
        if grid.clear_line(pos, goal) {
            return (goal, target_open);
        }
        (goal_cell, goal, target_open, grid.nav.n, grid.cell)
    };
    let (age, missing, off, moved) = match &sim.bots[b].nav.grid {
        None => (f64::INFINITY, true, false, false),
        Some(r) => {
            let grid: &Grid = sim.arena.grid.as_ref().expect("grille");
            // (`route.cells[route.at]` : une case qui n'existe pas donne NaN, jamais « écarté »)
            let off = r.cells.get(r.at).is_some_and(|&c| flat_distance(pos, grid.center(c)) > OFF_ROUTE * cell);
            let rows = ((r.goal / n) as i64 - (goal_cell / n) as i64).abs() as f64;
            let columns = ((r.goal % n) as i64 - (goal_cell % n) as i64).abs() as f64;
            (sim.time - r.time, false, off, jsmath::max(rows, columns) > GOAL_DRIFT as f64)
        }
    };
    // Trop tôt, ou trop de recherches à ce pas : il garde son ancien chemin, ou va droit, en attendant
    if (missing || moved || off || age > REPLAN) && age >= MIN_REPLAN && may_search(sim) {
        let mode = sim.bots[b].ai.mode;
        let grid = sim.arena.grid.as_mut().expect("grille");
        let mut start = grid.cell_at(pos.x, pos.z);
        // Poussé dans une case fermée dont aucune voisine n'est ouverte : il rejoint d'abord la plus proche
        let mut cells = match grid.nav.find_path(start, goal_cell) {
            Some(c) => c,
            None => {
                let Some(s) = grid.nearest_open(start) else { return (goal, target_open) };
                start = s;
                match grid.nav.find_path(start, goal_cell) {
                    Some(mut c) => {
                        c.insert(0, start);
                        c
                    }
                    None => {
                        let c = grid.center(start);
                        sim.bots[b].nav.grid = None;
                        return (c, false);
                    }
                }
            }
        };
        let short = matches!(mode, Mode::Engage | Mode::Support | Mode::Charge)
            && cells.len() as f64 * cell > DETOUR_FACTOR * flat_distance(pos, goal) + DETOUR_SLACK;
        if short {
            cells = grid.nav.approach_path(start, goal_cell, DETOUR_REACH);
        }
        let time = sim.time;
        sim.bots[b].nav.grid = Some(GridRoute { goal: goal_cell, cells, at: 0, time, short });
    }
    let grid: &Grid = sim.arena.grid.as_ref().expect("grille");
    // Sans chemin (en attendant d'en chercher un) : droit vers la destination
    let Some(route) = sim.bots[b].nav.grid.as_mut() else { return (goal, target_open) };
    // Le point le plus lointain du chemin qu'il voit en ligne droite (il avance sur son chemin)
    let mut best = route.at;
    let end = route.cells.len().min(route.at + LOOKAHEAD);
    for k in route.at..end {
        if grid.clear_line(pos, grid.center(route.cells[k])) {
            best = k;
        }
    }
    route.at = best;
    if best + 1 == route.cells.len() && !route.short {
        (goal, target_open)
    } else {
        (grid.center(route.cells[best]), false)
    }
}

/// Point vers lequel rouler pour aller à `target` depuis `pos` (`navigate`) : la destination
/// elle-même si la voie est libre ; sinon une étape de son chemin, le bout d'un pont, le pied d'une
/// rampe, la sortie d'un bâtiment ou le coin d'un obstacle.
pub fn navigate(sim: &mut Sim, b: usize, pos: V3, target: V3) -> V3 {
    let radius = sim.bots[b].radius;
    // Grille de passage (lave, mer, pentes) : la destination passe d'abord par elle
    // (la destination elle-même reste celle qu'on monte rejoindre par une rampe : le pont d'un navire)
    let final_ = target;
    let has_grid = sim.arena.grid.is_some();
    let (target, same) = if has_grid { grid_waypoint(sim, b, pos, target) } else { (target, true) };
    let bridged = bridge_goal(sim, radius, pos, target);
    let mut goal = match bridged {
        Bridged::At(p) => p,
        _ => target,
    };
    // Le relief coupe la route : par le réseau de passage (sauf sur un pont, ou pour y monter)
    if sim.arena.graph.is_some() && bridged != Bridged::Target && !on_deck(sim, pos) {
        goal = route_goal(sim, b, pos, goal);
    }
    let (to, aimed) = detour(sim, b, pos, final_, same, goal);
    if let Some(at) = aimed {
        sim.bots[b].nav.aimed = Some(at);
    }
    to
}

/// La suite de `navigate`, une fois la destination passée par la grille, les ponts et le réseau : les
/// rampes, les bâtiments d'une ville, les hautes rampes, le coin du premier obstacle ; et, en ville, le
/// coin qu'il vise désormais.
fn detour(sim: &Sim, b: usize, pos: V3, final_: V3, same: bool, mut goal: V3) -> (V3, Option<V3>) {
    let radius = sim.bots[b].radius;
    let graph = sim.arena.graph.is_some();
    // Destination sur une plateforme : par une rampe, sauf s'il y est déjà ou qu'il en est au pied
    let mut aboard: Option<usize> = None;
    let mut climbing: Option<usize> = None;
    for (i, bx) in sim.boxes.iter().enumerate() {
        if bx.kind != "platform" {
            continue;
        }
        let top = box_rect(bx, 0.0);
        if inside(pos, box_rect(bx, 0.3)) {
            aboard = Some(i);
        }
        if !inside(final_, top) || aboard == Some(i) {
            continue;
        }
        let Some(path) = ramp_path(sim, i, pos, final_, radius) else { break };
        // Avec une grille de passage, il ne vise le pied de la rampe que d'où il le voit
        if let Some(grid) = &sim.arena.grid
            && !same
            && !grid.clear_line(pos, path.foot)
        {
            break;
        }
        // Au pied ou déjà sur la rampe : il la monte dans son axe, sans déborder sur ses côtés
        if inside(pos, box_rect(&sim.boxes[path.ramp], 0.3)) || flat_distance(pos, path.foot) <= FOOT_REACHED {
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
    let urban = sim.arena.urban;
    if urban {
        // Entré dans un bâtiment : il en ressort par une ouverture
        if let Some(exit) = building_exit(sim, radius, pos, goal) {
            return (exit, None);
        }
        // Une destination dans un bâtiment se prend dans la rue, au plus près
        goal = clear_of(sim, goal, grow);
    }
    // Le long d'une haute rampe : il la longe jusqu'à son bas plutôt que de buter contre son flanc
    if let Some(along) = beside_ramp(sim, radius, pos, goal, climbing) {
        return (along, None);
    }

    // Premier obstacle sur le trajet : on vise son coin le plus commode
    let mut first: Option<Rect> = None;
    let mut first_t = f64::INFINITY;
    // En ville, un robot qui longe un mur (dans sa marge) le contourne quand même s'il allait le traverser
    let hugging = urban;
    let mut core: Option<Rect> = None;
    let mut away: Option<V3> = None;
    let mut away_d = f64::INFINITY;
    // Ce qui est loin du trajet (au-delà de la marge) ne peut pas le couper : écarté sans calcul
    let reach = grown(
        Rect { min_x: jsmath::min(pos.x, goal.x), max_x: jsmath::max(pos.x, goal.x), min_z: jsmath::min(pos.z, goal.z), max_z: jsmath::max(pos.z, goal.z) },
        grow,
    );
    for o in obstacles(sim).iter() {
        let rect = o.rect;
        if rect.min_x >= reach.max_x || rect.max_x <= reach.min_x || rect.min_z >= reach.max_z || rect.max_z <= reach.min_z {
            continue;
        }
        if o.boxed.is_some() && o.boxed == aboard {
            continue;
        }
        // Les niveaux se superposent (un tunnel, le pied d'une falaise) : seuls comptent les obstacles à sa hauteur
        if graph && !at_level(o, pos.y) {
            continue;
        }
        let bx = o.boxed.map(|i| &sim.boxes[i]);
        // Plus bas que lui (les piles d'un pont sur lequel il roule) : rien à contourner (en ville, plus
        // bas aussi que sa destination)
        if let Some(bx) = bx
            && bx.pos.y + bx.half.y < (if hugging { jsmath::max(pos.y, goal.y) } else { pos.y }) - LOWER
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
        if inside(pos, r) {
            // Déjà contre lui : l'évitement local s'en charge (en ville, s'il ne le traverse pas)
            if !hugging || inside(pos, rect) {
                continue;
            }
            // En ville, son corps (une part de son rayon) doit passer à côté du mur, pas seulement son centre
            let body = grown(rect, jsmath::min(radius * BODY, BODY_MAX));
            if inside(pos, body) {
                // Si près du mur que son corps le frotte : il s'en écarte d'abord
                if bx.is_some_and(|bx| bx.kind == "platform") || climbing.is_some() {
                    continue;
                }
                let near =
                    v3(jsmath::max(rect.min_x, jsmath::min(pos.x, rect.max_x)), pos.y, jsmath::max(rect.min_z, jsmath::min(pos.z, rect.max_z)));
                let d = flat_distance(pos, near);
                if d > 1e-3 && !inside(goal, body) && d < away_d {
                    away_d = d;
                    away = Some(v3(near.x + ((pos.x - near.x) / d) * grow, goal.y, near.z + ((pos.z - near.z) / d) * grow));
                }
                continue;
            }
            if let Some(t) = entry(pos, goal, body)
                && t < first_t
            {
                first_t = t;
                first = Some(r);
                core = Some(body);
            }
            continue;
        }
        if let Some(t) = entry(pos, goal, r)
            && t < first_t
        {
            first_t = t;
            first = Some(r);
            core = None;
        }
    }
    if let Some(away) = away {
        return (away, None);
    }
    let Some(r) = first else { return (goal, None) };
    let corners = [v3(r.min_x, 0.0, r.min_z), v3(r.min_x, 0.0, r.max_z), v3(r.max_x, 0.0, r.min_z), v3(r.max_x, 0.0, r.max_z)];
    // Un coin est derrière l'obstacle si on le traverse pour l'atteindre (dans sa marge : l'obstacle lui-même)
    let shrunk = match core {
        Some(c) => grown(c, -0.05),
        None => Rect { min_x: r.min_x + 0.05, max_x: r.max_x - 0.05, min_z: r.min_z + 0.05, max_z: r.max_z - 0.05 },
    };
    let kept = if hugging { sim.bots[b].nav.aimed } else { None };
    let steep_terrain = if graph { sim.arena.terrain.as_ref() } else { None };
    let mut best = goal;
    let mut best_cost = f64::INFINITY;
    for (ci, &c) in corners.iter().enumerate() {
        // ce coin est derrière l'obstacle
        if entry(pos, c, shrunk).is_some() {
            continue;
        }
        // En ville : pas le coin où il est déjà ; et d'un coin d'où l'obstacle cache encore la
        // destination, il faudra passer par un coin voisin
        if hugging && flat_distance(pos, c) < CORNER_REACHED {
            continue;
        }
        let onward = if hugging && entry(c, goal, shrunk).is_some() {
            corners
                .iter()
                .enumerate()
                .filter(|&(ni, n)| ni != ci && (n.x == c.x || n.z == c.z))
                .map(|(_, &n)| flat_distance(c, n) + flat_distance(n, goal))
                .fold(f64::INFINITY, jsmath::min)
        } else {
            flat_distance(c, goal)
        };
        // Là où le relief coupe les routes, un coin qu'il ne rejoint pas en ligne droite praticable ne
        // vient qu'en dernier recours
        let steep = match steep_terrain {
            Some(t) if !walkable(t, pos.x, pos.z, c.x, c.z, 0.0) => UNREACHABLE_CORNER,
            _ => 0.0,
        };
        let keep = if kept.is_some_and(|k| flat_distance(k, c) < 0.5) { CORNER_KEEP } else { 0.0 };
        let cost = flat_distance(pos, c) + onward + steep - keep;
        if cost < best_cost {
            best_cost = cost;
            best = c;
        }
    }
    (best, hugging.then_some(best))
}

// Évitement des mines : il regarde ce qui est sur sa route jusqu'à MINE_LOOKAHEAD m, et passe à
/// MINE_MARGIN m de plus que leur rayon.
const MINE_LOOKAHEAD: f64 = 18.0;
const MINE_MARGIN: f64 = 1.2;

/// Mines ennemies que son équipe a repérées (`avoidMines`) : s'il allait passer sur l'une d'elles en
/// allant vers `goal`, il vise d'abord un point à côté d'elle, du côté où elle ne se trouve pas. Les
/// mines qui ne visent pas les robots au sol (anti-aériennes, capteurs) ne comptent pas.
pub fn avoid_mines(sim: &Sim, b: usize, pos: V3, goal: V3) -> V3 {
    let dx = goal.x - pos.x;
    let dz = goal.z - pos.z;
    let length = jsmath::hypot2(dx, dz);
    if length < 0.5 {
        return goal;
    }
    let ux = dx / length;
    let uz = dz / length;
    let bot = &sim.bots[b];
    let mut detour = None;
    let mut nearest = jsmath::min(length, MINE_LOOKAHEAD);
    for p in &sim.projectiles {
        if !p.landed || !p.spotted.contains(&bot.team) {
            continue;
        }
        let Some(mine) = &p.def().projectile.mine else { continue };
        if mine.trigger == "air" || mine.trigger == "none" || p.shooter.is_some_and(|s| !(s != b && sim.bots[s].team != bot.team)) {
            continue;
        }
        let mx = p.pos.x - pos.x;
        let mz = p.pos.z - pos.z;
        let along = mx * ux + mz * uz;
        if along < 0.0 || along > nearest {
            continue;
        }
        // > 0 : la mine est à gauche de la route
        let across = mx * uz - mz * ux;
        let clear = mine.radius + bot.radius + MINE_MARGIN;
        if across.abs() >= clear {
            continue;
        }
        nearest = along;
        let side = if across >= 0.0 { -clear } else { clear };
        detour = Some(v3(p.pos.x + uz * side, 0.0, p.pos.z - ux * side));
    }
    detour.unwrap_or(goal)
}
