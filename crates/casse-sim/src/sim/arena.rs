//! L'arène, en données, au-delà de ses boîtes et de ses accessoires : son relief (un champ de hauteurs
//! pour Rapier, et la hauteur du sol lue sans physique : src/shared/arena/terrain.ts, layout.ts), ses
//! rochers (l'enveloppe convexe de la boule cabossée qu'on voit : arena/rocks.ts), son eau (profonde
//! ou non), sa lave (arena/features.ts), ses ponts (arena/navgrid.ts : `decks`), sa grille de passage
//! (faite par le TypeScript : `navGrid`, donnée toute faite ; la recherche de chemin est celle de
//! navgrid.rs) et son réseau de passage (arena/navGraph.ts : `walkable`, `surfaceHeight`, `edgeAhead`,
//! `onNav`), le lancer de rayon sur le décor sans physique (arena/ray.ts : `rayArena`), ses planchers
//! de vol (`airFloor`, `hoverFloor`), si c'est une ville (`urban`), et le bâtiment de chaque
//! emplacement d'accessoire (`PropSpot.building`).
//!
//! Le TypeScript construit l'arène d'après son fichier de carte (`arenaFromMap`, src/shared/map/) et
//! la donne à la simulation portée champ par champ (mod.rs : `sim_add_box`, `sim_set_terrain`…) : les
//! mêmes nombres, dans le même ordre. Les calculs suivent le TypeScript opération par opération.

use super::vec::{Q, V3, qrot, qrot_inv, sub, v3};
use super::world::{SceneryBox, Sim};
use crate::jsmath;
use crate::navgrid::NavGrid;
use crate::terrain::Terrain;

/// Une forme de lave (`LavaShape`) : un lac (un disque) ou une coulée (une ligne brisée, large de
/// `width` m), et son emprise (`lavaBounds`).
pub struct Lava {
    pub pool: Option<(f64, f64, f64)>,
    pub width: f64,
    pub points: Vec<(f64, f64)>,
    pub bounds: (f64, f64, f64, f64),
}

/// La grille de passage de l'IA (`NavGrid`, arena/navgrid.ts) : sa case (m), son bord (m), et ses
/// cases (la recherche de chemin : navgrid.rs).
pub struct Grid {
    pub cell: f64,
    pub min: f64,
    pub nav: NavGrid,
}

/// Le réseau de passage de l'IA (`NavGraph`) : ses points, et les voisins de chacun (`neighbours`).
pub struct Graph {
    pub points: Vec<(f64, f64)>,
    pub next: Vec<Vec<usize>>,
}

/// Ce que l'arène a en plus de ses boîtes, de ses dimensions et du niveau de son eau (world.rs).
#[derive(Default)]
pub struct Arena {
    pub terrain: Option<Terrain>,
    /// Profondeur au-delà de laquelle l'eau est profonde (`deepWater`) : on s'y noie.
    pub deep_water: Option<f64>,
    pub lava: Vec<Lava>,
    pub urban: bool,
    /// Altitudes au-dessous desquelles l'IA ne fait voler ni ses avions ni ses robots volants (0 : aucune).
    pub air_floor: f64,
    pub hover_floor: f64,
    pub grid: Option<Grid>,
    pub graph: Option<Graph>,
    /// Le bâtiment de chaque emplacement d'accessoire (`PropSpot.building`), par emplacement.
    pub buildings: Vec<Option<u32>>,
    /// Les tabliers (rangs dans `Sim.boxes`) : les ponts (reliés au sol à leurs deux bouts), ceux qui
    /// ferment le passage dessous (`decks`), et tous ceux qu'on prend pour des ponts sans grille (`isBridge`).
    pub bridges: Vec<usize>,
    pub blocking: Vec<usize>,
    pub decks: Vec<usize>,
    /// Les emplacements de ses accessoires (`props` : `resetProps` les y remet) et ses zones à capturer.
    pub spots: Vec<super::game::Spot>,
    pub zones: Vec<super::game::Zone>,
}

/// Hauteur du sol (le relief, sinon le sol plat) en (x, z), hors décor (`groundLevel`).
pub fn ground_level(sim: &Sim, x: f64, z: f64) -> f64 {
    match &sim.arena.terrain {
        Some(t) => jsmath::max(0.0, t.height(x, z)),
        None => 0.0,
    }
}

/// L'eau est-elle profonde en (x, z) (`deepWaterAt`) ?
pub fn deep_water_at(sim: &Sim, x: f64, z: f64) -> bool {
    match (sim.arena.deep_water, sim.water) {
        (Some(deep), Some(water)) => water - ground_level(sim, x, z) > deep,
        _ => false,
    }
}

/// Le point `p` est-il dans l'eau (sous la surface, au-dessus d'un fond plus bas qu'elle) (`inWater`) ?
pub fn in_water(sim: &Sim, p: V3) -> bool {
    sim.water.is_some_and(|w| p.y < w && ground_level(sim, p.x, p.z) < w)
}

/// Distance devant un robot volant à laquelle il regarde le relief (m).
const TERRAIN_LOOKAHEAD: f64 = 8.0;

/// Altitude (y) où voler à `alt` m au-dessus du relief, en allant de `pos` vers `target` (`flightLevel`).
pub fn flight_level(sim: &Sim, pos: V3, target: V3, alt: f64) -> f64 {
    let dx = target.x - pos.x;
    let dz = target.z - pos.z;
    let d = jsmath::hypot2(dx, dz);
    let k = if d > 1e-3 { jsmath::min(TERRAIN_LOOKAHEAD, d) / d } else { 0.0 };
    jsmath::max(ground_level(sim, pos.x, pos.z), ground_level(sim, pos.x + dx * k, pos.z + dz * k)) + alt
}

// --- La lave (arena/features.ts) ---

/// Hauteur au-dessus de la lave jusqu'à laquelle elle brûle (m).
pub const LAVA_HEIGHT: f64 = 1.3;

/// Distance (m) d'un point au segment [a, b] du plan (`segmentDistance`).
fn segment_distance(x: f64, z: f64, a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = b.0 - a.0;
    let dz = b.1 - a.1;
    let t = super::vec::clamp(((x - a.0) * dx + (z - a.1) * dz) / or_one(dx * dx + dz * dz), 0.0, 1.0);
    jsmath::hypot2(x - a.0 - dx * t, z - a.1 - dz * t)
}

/// `x || 1` : 0, -0 et NaN sont « faux » en JavaScript.
pub fn or_one(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 1.0 } else { x }
}

impl Lava {
    /// Un lac de lave.
    pub fn pool(x: f64, z: f64, r: f64) -> Lava {
        Lava { pool: Some((x, z, r)), width: 0.0, points: Vec::new(), bounds: (x - r, x + r, z - r, z + r) }
    }

    /// Une coulée de lave (`lavaBounds` : l'emprise de ses points, élargie de sa demi-largeur).
    pub fn flow(width: f64, points: Vec<(f64, f64)>) -> Lava {
        let w = width / 2.0;
        let fold = |f: fn(f64, f64) -> f64, start: f64, pick: fn(&(f64, f64)) -> f64| points.iter().map(pick).fold(start, f);
        let bounds = (
            fold(jsmath::min, f64::INFINITY, |p| p.0) - w,
            fold(jsmath::max, f64::NEG_INFINITY, |p| p.0) + w,
            fold(jsmath::min, f64::INFINITY, |p| p.1) - w,
            fold(jsmath::max, f64::NEG_INFINITY, |p| p.1) + w,
        );
        Lava { pool: None, width, points, bounds }
    }

    /// Profondeur (m) d'un point dans la forme : > 0 dedans, < 0 dehors (`lavaDepth`).
    fn depth(&self, x: f64, z: f64) -> f64 {
        if let Some((px, pz, r)) = self.pool {
            return r - jsmath::hypot2(x - px, z - pz);
        }
        let mut best = f64::INFINITY;
        for i in 1..self.points.len() {
            best = jsmath::min(best, segment_distance(x, z, self.points[i - 1], self.points[i]));
        }
        self.width / 2.0 - best
    }
}

/// Profondeur dans la lave la plus proche (m) : > 0 dans la lave ; -∞ s'il n'y en a pas (`lavaAt`).
pub fn lava_at(sim: &Sim, x: f64, z: f64, margin: f64) -> f64 {
    let mut best = f64::NEG_INFINITY;
    for shape in &sim.arena.lava {
        let (min_x, max_x, min_z, max_z) = shape.bounds;
        if x < min_x - margin || x > max_x + margin || z < min_z - margin || z > max_z + margin {
            continue;
        }
        best = jsmath::max(best, shape.depth(x, z));
    }
    best
}

// --- Les tabliers et les ponts (arena/navgrid.ts, ai/navigation.ts) ---

/// Un tablier est relié au sol à un bout si le sol y est à moins de cette hauteur de son dessus (m) ;
/// un tablier qui ne l'est pas ferme les cases dessous si on ne peut y passer qu'à moins de cette hauteur (m).
const DECK_LANDING: f64 = 1.0;
const DECK_HEADROOM: f64 = 2.5;

/// Demi-emprise au sol (x, y, z) d'une boîte orientée (`footprint`).
pub fn footprint(half: V3, rot: Q) -> V3 {
    let ax = qrot(rot, v3(half.x, 0.0, 0.0));
    let ay = qrot(rot, v3(0.0, half.y, 0.0));
    let az = qrot(rot, v3(0.0, 0.0, half.z));
    v3(ax.x.abs() + ay.x.abs() + az.x.abs(), ax.y.abs() + ay.y.abs() + az.y.abs(), ax.z.abs() + ay.z.abs() + az.z.abs())
}

/// Un tablier de pont (`isBridge` : pas un parapet, ni une poutre).
pub fn is_bridge(b: &SceneryBox) -> bool {
    b.kind == "deck" && jsmath::min(b.half.x, b.half.z) >= 1.0
}

/// Relève les tabliers (`decks`, `isBridge`) : à refaire quand le décor ou le relief change.
pub fn survey_decks(sim: &mut Sim) {
    let mut bridges = Vec::new();
    let mut blocking = Vec::new();
    let mut decks = Vec::new();
    for (i, b) in sim.boxes.iter().enumerate() {
        if !is_bridge(b) {
            continue;
        }
        decks.push(i);
        let top = b.pos.y + b.half.y;
        let along = if b.half.x > b.half.z { v3(b.half.x + 1.0, 0.0, 0.0) } else { v3(0.0, 0.0, b.half.z + 1.0) };
        let ends = [1.0, -1.0].map(|s: f64| ground_level(sim, b.pos.x + s * along.x, b.pos.z + s * along.z));
        if ends.iter().all(|g| (top - g).abs() < DECK_LANDING) {
            bridges.push(i);
        } else if b.pos.y - b.half.y - ground_level(sim, b.pos.x, b.pos.z) < DECK_HEADROOM {
            blocking.push(i);
        }
    }
    (sim.arena.bridges, sim.arena.blocking, sim.arena.decks) = (bridges, blocking, decks);
}

/// (x, z) est-il sous un pont (dans l'emprise d'un tablier relié au sol à ses deux bouts) (`onBridge`) ?
pub fn on_bridge(sim: &Sim, x: f64, z: f64) -> bool {
    sim.arena.bridges.iter().any(|&i| {
        let b = &sim.boxes[i];
        let f = footprint(b.half, b.rot);
        (x - b.pos.x).abs() <= f.x && (z - b.pos.z).abs() <= f.z
    })
}

// --- La grille de passage (arena/navgrid.ts) ---

impl Grid {
    /// Case qui contient (x, z), bornée à la grille (`cellAt`).
    pub fn cell_at(&self, x: f64, z: f64) -> usize {
        let n = self.nav.n as f64;
        let ix = jsmath::min(n - 1.0, jsmath::max(0.0, ((x - self.min) / self.cell).floor()));
        let iz = jsmath::min(n - 1.0, jsmath::max(0.0, ((z - self.min) / self.cell).floor()));
        (ix * n + iz) as usize
    }

    /// Centre d'une case (y = 0) (`cellCenter`).
    pub fn center(&self, cell: usize) -> V3 {
        let ix = (cell / self.nav.n) as f64;
        let iz = (cell % self.nav.n) as f64;
        v3(self.min + (ix + 0.5) * self.cell, 0.0, self.min + (iz + 0.5) * self.cell)
    }

    /// (x, z) est-il franchissable ? Hors de la grille, non (`isOpen`).
    pub fn is_open(&self, x: f64, z: f64) -> bool {
        let ix = ((x - self.min) / self.cell).floor();
        let iz = ((z - self.min) / self.cell).floor();
        let n = self.nav.n as f64;
        ix >= 0.0 && iz >= 0.0 && ix < n && iz < n && self.nav.open[(ix * n + iz) as usize] == 1
    }

    /// La ligne droite de `a` à `b` ne passe-t-elle que par des cases franchissables (`clearLine`) ?
    /// On la suit par demi-cases ; la case de départ ne compte pas.
    pub fn clear_line(&self, a: V3, b: V3) -> bool {
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let steps = (jsmath::hypot2(dx, dz) / (self.cell * 0.5)).ceil();
        let start = self.cell_at(a.x, a.z);
        let mut i = 1.0;
        while i <= steps {
            let x = a.x + (dx * i) / steps;
            let z = a.z + (dz * i) / steps;
            if !self.is_open(x, z) && self.cell_at(x, z) != start {
                return false;
            }
            i += 1.0;
        }
        true
    }

    /// La case franchissable la plus proche de `cell` (elle-même si elle l'est), à moins de 40 cases (`nearestOpenCell`).
    pub fn nearest_open(&self, cell: usize) -> Option<usize> {
        self.nav.nearest_open_cell(cell, 40)
    }
}

/// L'IA peut-elle aller en (x, z) ? Toujours vrai sans grille de passage (`passable`).
pub fn passable(sim: &Sim, x: f64, z: f64) -> bool {
    sim.arena.grid.as_ref().is_none_or(|g| g.is_open(x, z))
}

/// Le point franchissable le plus proche de `p` : lui-même s'il l'est (ou sans grille), sinon le
/// centre de la case la plus proche (`nearestPassable`).
pub fn nearest_passable(sim: &Sim, p: V3) -> V3 {
    let Some(grid) = &sim.arena.grid else { return p };
    if grid.is_open(p.x, p.z) {
        return p;
    }
    let Some(cell) = grid.nearest_open(grid.cell_at(p.x, p.z)) else { return p };
    let c = grid.center(cell);
    v3(c.x, p.y, c.z)
}

// --- Le réseau de passage (arena/navGraph.ts) ---

/// Pente la plus raide qu'un robot au sol monte ou descend (dénivelé par mètre), pas des
/// échantillons (m), portée des liaisons (m), leur marge de côté (m), dévers le plus fort (par mètre).
pub const MAX_GRADE: f64 = 0.62;
const SAMPLE: f64 = 1.0;
pub const LINK_REACH: f64 = 34.0;
pub const LINK_MARGIN: f64 = 2.0;
const MAX_CROSS: f64 = 0.4;

/// La ligne droite de (ax, az) à (bx, bz) est-elle praticable sur le relief, toute la bande de
/// `margin` m de demi-largeur (`walkable`) ?
pub fn walkable(t: &Terrain, ax: f64, az: f64, bx: f64, bz: f64, margin: f64) -> bool {
    let length = jsmath::hypot2(bx - ax, bz - az);
    let n = jsmath::max(1.0, (length / SAMPLE).ceil());
    let limit = MAX_GRADE * (length / n);
    let lanes = if margin > 0.0 && length > 1e-6 { (margin / SAMPLE).ceil() } else { 0.0 };
    if lanes == 0.0 {
        let mut last = t.height(ax, az);
        let mut i = 1.0;
        while i <= n {
            let h = t.height(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n);
            if (h - last).abs() > limit {
                return false;
            }
            last = h;
            i += 1.0;
        }
        return true;
    }
    let gap = margin / lanes;
    let sx = ((bz - az) / length) * gap;
    let sz = (-(bx - ax) / length) * gap;
    let tilt = MAX_CROSS * gap;
    let width = 2 * lanes as usize + 1;
    let mut last: Vec<f64> = (0..width).map(|k| t.height(ax + sx * (k as f64 - lanes), az + sz * (k as f64 - lanes))).collect();
    let mut i = 1.0;
    while i <= n {
        let x = ax + ((bx - ax) * i) / n;
        let z = az + ((bz - az) * i) / n;
        let mut beside = 0.0;
        for (k, l) in last.iter_mut().enumerate() {
            let h = t.height(x + sx * (k as f64 - lanes), z + sz * (k as f64 - lanes));
            if (h - *l).abs() > limit || (k > 0 && (h - beside).abs() > tilt) {
                return false;
            }
            *l = h;
            beside = h;
        }
        i += 1.0;
    }
    true
}

/// Hauteur de ce sur quoi l'on roule en (x, z), à la hauteur `level` : le tablier d'un pont s'il passe
/// là à sa hauteur (à 2 m près), sinon le relief (`surfaceHeight`).
pub fn surface_height(sim: &Sim, x: f64, z: f64, level: f64) -> f64 {
    let ground = sim.arena.terrain.as_ref().map_or(0.0, |t| t.height(x, z));
    for &i in &sim.arena.decks {
        let b = &sim.boxes[i];
        let top = b.pos.y + b.half.y;
        if (top - level).abs() > 2.0 || top < ground {
            continue;
        }
        // Dans le repère du tablier (tourné autour de la verticale)
        let p = qrot_inv(b.rot, v3(x - b.pos.x, 0.0, z - b.pos.z));
        if p.x.abs() <= b.half.x && p.z.abs() <= b.half.z {
            return top;
        }
    }
    ground
}

/// Distance, de (x, z) dans la direction (dx, dz), jusqu'au premier pas trop raide de ce sur quoi il
/// roule, au plus `reach` m ; ∞ s'il n'y en a pas (`edgeAhead`).
pub fn edge_ahead(height: impl Fn(f64, f64) -> f64, x: f64, z: f64, dx: f64, dz: f64, reach: f64) -> f64 {
    let mut last = height(x, z);
    let mut d = SAMPLE;
    while d <= reach {
        let h = height(x + dx * d, z + dz * d);
        if (h - last).abs() > MAX_GRADE * SAMPLE {
            return d - SAMPLE;
        }
        last = h;
        d += SAMPLE;
    }
    f64::INFINITY
}

/// Le point (x, z) se rejoint par le réseau : un de ses points le voit en ligne droite praticable (`onNav`).
pub fn on_nav(t: &Terrain, points: &[(f64, f64)], x: f64, z: f64) -> bool {
    points.iter().any(|&(px, pz)| jsmath::hypot2(px - x, pz - z) <= LINK_REACH * 0.7 && walkable(t, px, pz, x, z, 0.0))
}

impl Graph {
    /// Le réseau, ses voisins d'après ses liaisons (`neighbours`).
    pub fn new(points: Vec<(f64, f64)>, links: &[(usize, usize)]) -> Graph {
        let mut next = vec![Vec::new(); points.len()];
        for &(a, b) in links {
            next[a].push(b);
            next[b].push(a);
        }
        Graph { points, next }
    }
}

// --- Le lancer de rayon sur le décor, sans physique (arena/ray.ts) ---

/// Distance le long du rayon où il entre dans la boîte (`rayBox`), si c'est avant `max` ; rien sinon,
/// ou s'il part de l'intérieur.
fn ray_box(pos: V3, half: V3, rot: Q, origin: V3, dir: V3, max: f64) -> Option<f64> {
    let o = qrot_inv(rot, sub(origin, pos));
    let d = qrot_inv(rot, dir);
    let mut near = f64::NEG_INFINITY;
    let mut far = f64::INFINITY;
    for (h, oa, da) in [(half.x, o.x, d.x), (half.y, o.y, d.y), (half.z, o.z, d.z)] {
        if da.abs() < 1e-9 {
            if oa.abs() > h {
                return None;
            }
            continue;
        }
        let t1 = (-h - oa) / da;
        let t2 = (h - oa) / da;
        near = jsmath::max(near, jsmath::min(t1, t2));
        far = jsmath::min(far, jsmath::max(t1, t2));
        if near > far {
            return None;
        }
    }
    (near >= 0.0 && near <= max).then_some(near)
}

/// Distance le long du rayon jusqu'au premier élément du décor fixe parmi les boîtes `boxes` (rangs
/// dans `Sim.boxes`), puis le relief, au plus `max` (`rayArena`) ; rien : rien.
pub fn ray_boxes(sim: &Sim, boxes: &[usize], origin: V3, dir: V3, max: f64) -> Option<f64> {
    let mut best: Option<f64> = None;
    for &i in boxes {
        let bx = &sim.boxes[i];
        // invisible : la caméra passe au travers
        if bx.kind == "bound" {
            continue;
        }
        if let Some(t) = ray_box(bx.pos, bx.half, bx.rot, origin, dir, best.unwrap_or(max)) {
            best = Some(t);
        }
    }
    if let Some(t) = &sim.arena.terrain
        && let Some(d) = t.ray([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], best.unwrap_or(max))
    {
        best = Some(d);
    }
    best
}

/// `rayArena` sur toutes les boîtes du décor, et le relief.
pub fn ray_arena(sim: &Sim, origin: V3, dir: V3, max: f64) -> Option<f64> {
    let all: Vec<usize> = (0..sim.boxes.len()).collect();
    ray_boxes(sim, &all, origin, dir, max)
}

// --- Les rochers (arena/rocks.ts) ---

/// Relief des bosses : chaque sommet est à ROCK_BUMP_MIN à 1 fois le rayon de la boule.
const ROCK_BUMP_MIN: f64 = 0.86;

/// Hasard fixe d'un point entier du plan, de -1 à 1 (`hash2`).
fn hash2(ix: i32, iz: i32) -> f64 {
    let mut h = ix.wrapping_mul(374761393) ^ iz.wrapping_mul(668265263);
    h = (h ^ ((h as u32 >> 13) as i32)).wrapping_mul(1274126177);
    h ^= (h as u32 >> 16) as i32;
    ((h as u32) as f64 / 4294967295.0) * 2.0 - 1.0
}

/// Lissage d'Hermite de 0 à 1 (`smoothstep(0, 1, x)`).
fn smooth(x: f64) -> f64 {
    let t = super::vec::clamp((x - 0.0) / (1.0 - 0.0), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Bruit de valeur lissé, de -1 à 1 (`noise2`).
fn noise2(x: f64, z: f64) -> f64 {
    let fx = x.floor();
    let fz = z.floor();
    let u = smooth(x - fx);
    let v = smooth(z - fz);
    let (ix, iz) = (fx as i32, fz as i32);
    let a = hash2(ix, iz);
    let b = hash2(ix.wrapping_add(1), iz);
    let c = hash2(ix, iz.wrapping_add(1));
    let d = hash2(ix.wrapping_add(1), iz.wrapping_add(1));
    a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/// Sommets (x, y, z à la suite) d'une boule à facettes de rayon 1 (`icosphere(2)` ; ses faces ne servent pas ici).
fn icosphere() -> Vec<f64> {
    let t = (1.0 + 5f64.sqrt()) / 2.0;
    let mut vertices: Vec<f64> = Vec::new();
    let add = |vertices: &mut Vec<f64>, x: f64, y: f64, z: f64| -> usize {
        let l = jsmath::hypot3(x, y, z);
        vertices.extend([x / l, y / l, z / l]);
        vertices.len() / 3 - 1
    };
    for [x, y, z] in [
        [-1.0, t, 0.0], [1.0, t, 0.0], [-1.0, -t, 0.0], [1.0, -t, 0.0], [0.0, -1.0, t], [0.0, 1.0, t], [0.0, -1.0, -t], [0.0, 1.0, -t],
        [t, 0.0, -1.0], [t, 0.0, 1.0], [-t, 0.0, -1.0], [-t, 0.0, 1.0],
    ] {
        add(&mut vertices, x, y, z);
    }
    let mut faces: Vec<usize> = vec![
        0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4,
        9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
    ];
    for _ in 0..2 {
        let mut middle = std::collections::HashMap::<(usize, usize), usize>::new();
        let mut mid = |vertices: &mut Vec<f64>, a: usize, b: usize| -> usize {
            let key = if a < b { (a, b) } else { (b, a) };
            if let Some(&m) = middle.get(&key) {
                return m;
            }
            let m = add(vertices, vertices[a * 3] + vertices[b * 3], vertices[a * 3 + 1] + vertices[b * 3 + 1], vertices[a * 3 + 2] + vertices[b * 3 + 2]);
            middle.insert(key, m);
            m
        };
        let mut next = Vec::with_capacity(faces.len() * 4);
        for f in faces.chunks(3) {
            let (a, b, c) = (f[0], f[1], f[2]);
            let ab = mid(&mut vertices, a, b);
            let bc = mid(&mut vertices, b, c);
            let ca = mid(&mut vertices, c, a);
            next.extend([a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca]);
        }
        faces = next;
    }
    vertices
}

/// Les sommets du rocher d'une boîte de demi-dimensions `half`, placé en (x, z) (qui fixe ses bosses),
/// dans le repère de la boîte, en nombres de 4 octets (`rockShape`).
pub fn rock_shape(half: V3, x: f64, z: f64) -> Vec<f32> {
    let v = icosphere();
    let mut out = vec![0f32; v.len()];
    let mut i = 0;
    while i < v.len() {
        // Bosses fixes, d'après la direction du sommet et la place du rocher
        let bump = ROCK_BUMP_MIN + (1.0 - ROCK_BUMP_MIN) * (0.5 + 0.5 * noise2(v[i] * 2.3 + x * 0.7, v[i + 2] * 2.3 + v[i + 1] * 1.7 + z * 0.7));
        out[i] = (v[i] * bump * half.x) as f32;
        out[i + 1] = (v[i + 1] * bump * half.y) as f32;
        out[i + 2] = (v[i + 2] * bump * half.z) as f32;
        i += 3;
    }
    out
}
