//! La simulation portée, propriétaire de son monde Rapier (fonctionnalité `sim`, dans la sonde, hors
//! du module du jeu). Premier jalon, « un robot qui roule » : les catalogues lus dans
//! content/catalog.json (catalog.rs), le monde et son sol (world.rs), un robot préfabriqué depuis
//! son plan (lifecycle.rs, robot.rs), ses colliders fusionnés (colliders.rs ; ses blocs de forme :
//! shapes.rs), les roues par lancer de rayon (wheels.rs) et la conduite (drive.rs), Rapier manié
//! comme le manie le TypeScript (physics.rs). Deuxième jalon, « les chocs et les dégâts » : les
//! forces de contact du pas et la vitesse de rapprochement d'avant le pas (collisions.rs), les lots
//! de dégâts (damage.rs), les liaisons faibles (structure.rs), les blocs détruits et leurs débris
//! (debris.rs), les morceaux séparés et les roues arrachées (lifecycle.rs), le hasard à graine fixe
//! (rng.rs). Troisième jalon, « les accessoires » : caisses, barils, bouteilles de gaz, murs et
//! arbres ancrés (props.rs), leurs chocs avec les robots et la percée d'un accessoire ancré
//! (collisions.rs), les explosions et leur souffle (explosion.rs), le feu des blocs et du bois
//! (fire.rs). tests/nativeSim.test.ts fait rouler et se heurter les mêmes robots, contre les mêmes
//! accessoires, ici et dans la simulation du TypeScript, et compare leurs états au bit près.
//!
//! L'interface : des fonctions `extern "C"` (comme ffi.rs) ; un monde est désigné par un numéro.

pub mod catalog;
pub mod colliders;
pub mod collisions;
pub mod damage;
pub mod debris;
pub mod drive;
pub mod explosion;
pub mod fire;
pub mod json;
pub mod lifecycle;
pub mod physics;
pub mod props;
pub mod rng;
pub mod robot;
pub mod shapes;
pub mod structure;
pub mod vec;
pub mod wheels;
pub mod world;

use std::cell::RefCell;
use vec::{Q, v3};
use world::Sim;

thread_local! {
    static SIMS: RefCell<Vec<Option<Sim>>> = const { RefCell::new(Vec::new()) };
    static ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

fn with<T>(id: u32, f: impl FnOnce(&mut Sim) -> T) -> T {
    SIMS.with(|list| f(list.borrow_mut()[id as usize - 1].as_mut().expect("monde inconnu")))
}

/// Un texte UTF-8 de la mémoire du module.
///
/// # Safety
/// `ptr` pointe sur `len` octets.
unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap_or("")
}

/// Un monde, son sol ; son numéro (à partir de 1).
#[unsafe(no_mangle)]
pub extern "C" fn sim_new() -> u32 {
    SIMS.with(|list| {
        let mut list = list.borrow_mut();
        if let Some(i) = list.iter().position(Option::is_none) {
            list[i] = Some(Sim::new());
            return i as u32 + 1;
        }
        list.push(Some(Sim::new()));
        list.len() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_free(id: u32) {
    SIMS.with(|list| list.borrow_mut()[id as usize - 1] = None);
}

/// Une boîte du décor fixe : centre, demi-dimensions, rotation (x, y, z, w), `round` non nul : un cylindre.
#[unsafe(no_mangle)]
pub extern "C" fn sim_add_box(id: u32, x: f64, y: f64, z: f64, hx: f64, hy: f64, hz: f64, qx: f64, qy: f64, qz: f64, qw: f64, round: u32) {
    with(id, |s| s.add_box(v3(x, y, z), v3(hx, hy, hz), Q { x: qx, y: qy, z: qz, w: qw }, round != 0));
}

/// L'accessoire de l'emplacement suivant de l'arène : son type `name` (UTF-8, `len` octets), sa
/// position, sa rotation (x, y, z, w ; `qw` NaN : debout, sans rotation), les demi-dimensions de
/// son emplacement (une dalle ; `hx` NaN : aucune) et son échelle (un cylindre ; NaN : aucune) ;
/// son numéro (celui de l'emplacement), ou -1 (le message : `sim_error`).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_add_prop(
    id: u32, name: *const u8, len: usize, x: f64, y: f64, z: f64, qx: f64, qy: f64, qz: f64, qw: f64, hx: f64, hy: f64, hz: f64, scale: f64,
) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    let rot = (!qw.is_nan()).then_some(Q { x: qx, y: qy, z: qz, w: qw });
    let half = (!hx.is_nan()).then_some(v3(hx, hy, hz));
    let scale = (!scale.is_nan()).then_some(scale);
    match with(id, |s| s.add_prop(&name, v3(x, y, z), rot, half, scale)) {
        Ok(i) => i as i32,
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message);
            -1
        }
    }
}

/// L'accessoire `prop` repose sur l'emplacement `on` (`PropSpot.rests`) : quand tous ses appuis ont
/// disparu, il tombe.
#[unsafe(no_mangle)]
pub extern "C" fn sim_prop_rest(id: u32, prop: u32, on: u32) {
    with(id, |s| s.props[prop as usize].as_mut().expect("accessoire retiré").rests.push(on as usize));
}

/// Fait apparaître le robot préfabriqué `name` (UTF-8, `len` octets) en (`x`, `y`, `z`), tourné de
/// `yaw` ; son numéro dans le monde, ou -1 (le message : `sim_error`).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_spawn(id: u32, name: *const u8, len: usize, x: f64, y: f64, z: f64, yaw: f64) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    match with(id, |s| s.spawn(&name, v3(x, y, z), yaw)) {
        Ok(bot) => bot as i32,
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message);
            -1
        }
    }
}

/// Le dernier message d'erreur, écrit dans `out` (au plus `cap` octets) ; sa longueur.
///
/// # Safety
/// `out` pointe sur `cap` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_error(out: *mut u8, cap: usize) -> usize {
    ERROR.with(|e| {
        let e = e.borrow();
        let n = e.len().min(cap);
        unsafe { std::slice::from_raw_parts_mut(out, n) }.copy_from_slice(&e.as_bytes()[..n]);
        n
    })
}

/// `groundHeight` du plan d'un robot préfabriqué (NaN s'il est inconnu).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_ground_height(name: *const u8, len: usize) -> f64 {
    let name = unsafe { text(name, len) };
    catalog::catalog().robots.get(name).map_or(f64::NAN, |r| robot::ground_height(&r.design))
}

/// Le morceau `piece` de la forme `name` (`shapePieces`) : ses sommets (x, y, z en nombres de 8
/// octets, au plus `cap` sommets) écrits dans `out`, et son volume dans `out[3 · n]` ; le nombre de
/// sommets, ou -1 (forme ou morceau inconnu, ou trop de sommets).
///
/// # Safety
/// `name` pointe sur `len` octets, `out` sur `3 · cap + 1` f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_shape_piece(name: *const u8, len: usize, piece: u32, out: *mut f64, cap: u32) -> i32 {
    let name = unsafe { text(name, len) };
    let Some(p) = shapes::shape_pieces(name).and_then(|pieces| pieces.get(piece as usize)) else { return -1 };
    if p.points.len() > cap as usize {
        return -1;
    }
    let out = unsafe { std::slice::from_raw_parts_mut(out, 3 * p.points.len() + 1) };
    for (i, v) in p.points.iter().enumerate() {
        out[3 * i..3 * i + 3].copy_from_slice(&[v.x, v.y, v.z]);
    }
    out[3 * p.points.len()] = p.volume;
    p.points.len() as i32
}

/// Les commandes du pilote du robot `bot` : gaz, direction (> 0 : à gauche), frein (0 à 1), boost (non nul).
#[unsafe(no_mangle)]
pub extern "C" fn sim_control(id: u32, bot: u32, throttle: f64, steer: f64, brake: f64, boost: u32) {
    with(id, |s| s.bots[bot as usize].input = robot::Input { throttle, steer, brake, boost: boost != 0 });
}

/// La graine du hasard du monde (`Math.random` à graine fixe, comme `seedRandom` de tests/seed.ts) :
/// à donner avant de faire apparaître les robots (leurs tourelles tirent déjà).
#[unsafe(no_mangle)]
pub extern "C" fn sim_seed(id: u32, seed: u32) {
    with(id, |s| s.rng = rng::Rng::new(seed));
}

/// Avance de `n` pas.
#[unsafe(no_mangle)]
pub extern "C" fn sim_step(id: u32, n: u32) {
    with(id, |s| {
        for _ in 0..n {
            s.step();
        }
    });
}

/// Le nombre de morceaux du robot `bot`.
#[unsafe(no_mangle)]
pub extern "C" fn sim_part_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].parts.len() as u32)
}

/// L'état d'un corps lu de Rapier : position, rotation (x, y, z, w), vitesse, vitesse angulaire.
fn body_state(s: &Sim, rb: rapier3d::prelude::RigidBodyHandle) -> [f64; 13] {
    let (t, r, v, w) = (s.phys.translation(rb), s.phys.rotation(rb), s.phys.linvel(rb), s.phys.angvel(rb));
    [t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z]
}

/// L'état du morceau `part` (dans l'ordre où ils sont nés) du robot `bot` : treize nombres de 8
/// octets (`body_state`).
///
/// # Safety
/// `out` pointe sur 13 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_part_state(id: u32, bot: u32, part: u32, out: *mut f64) {
    with(id, |s| {
        let rb = s.part(s.bots[bot as usize].parts[part as usize]).rb;
        unsafe { std::slice::from_raw_parts_mut(out, 13) }.copy_from_slice(&body_state(s, rb));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_wheel_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].wheels.len() as u32)
}

/// L'état d'une roue : sa pose (position, rotation : celle de son corps une fois arrachée), son
/// braquage, son débattement, sa rotation sur l'essieu, sa vitesse de rotation, sa charge, la
/// tension de son moteur, ses points de structure, et où elle est (le rang de son morceau parmi
/// ceux du robot ; -1 arrachée, -2 retirée) : quinze nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 15 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_wheel_state(id: u32, bot: u32, wheel: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let w = &b.wheels[wheel as usize];
        let (p, r) = match w.body {
            Some(rb) => (s.phys.translation(rb), s.phys.rotation(rb)),
            None => (w.rb.pos, w.rb.rot),
        };
        let at = match (w.part, w.body) {
            (Some(part), _) => b.parts.iter().position(|&x| x == part).map_or(-3.0, |i| i as f64),
            (None, Some(_)) => -1.0,
            (None, None) => -2.0,
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out, 15) };
        out.copy_from_slice(&[p.x, p.y, p.z, r.x, r.y, r.z, r.w, w.steer, w.travel, w.spin, w.spin_rate, w.load, w.drive, w.hp, at]);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_block_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].blocks.len() as u32)
}

/// L'état d'un bloc (dans l'ordre du plan) : ses points de structure, s'il est vivant (1 ou 0), le
/// rang de son morceau parmi ceux du robot (-1 s'il est détruit), son feu (secondes qu'il brûlera
/// encore) : quatre nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 4 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_block_state(id: u32, bot: u32, block: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let k = &b.blocks[block as usize];
        let at = if k.alive { b.parts.iter().position(|&x| x == k.part).map_or(-3.0, |i| i as f64) } else { -1.0 };
        unsafe { std::slice::from_raw_parts_mut(out, 4) }.copy_from_slice(&[k.hp, if k.alive { 1.0 } else { 0.0 }, at, k.burn]);
    });
}

/// Le nombre d'emplacements d'accessoires (présents ou retirés).
#[unsafe(no_mangle)]
pub extern "C" fn sim_prop_count(id: u32) -> u32 {
    with(id, |s| s.props.len() as u32)
}

/// L'état de l'accessoire de l'emplacement `i` : présent (1 ou 0 ; retiré, tout le reste à 0), son
/// corps (treize nombres : `body_state`), ancré (1 ou 0), ses points de structure, son état (0
/// intact, 1 mèche, 2 fuite) et le temps qui lui reste, la direction de sa fuite (x, z), son feu, sa
/// part noircie, jusqu'à quand il laisse passer les robots (0 : non), la vitesse de ses éclats s'il
/// a été brisé par un robot (x, y, z ; sinon 0) : vingt-six nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 26 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_prop_state(id: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let out = unsafe { std::slice::from_raw_parts_mut(out, 26) };
        out.fill(0.0);
        let Some(p) = s.props[i as usize].as_ref() else { return };
        out[0] = 1.0;
        out[1..14].copy_from_slice(&body_state(s, p.rb));
        let (kind, left, leak) = match p.state {
            props::PropState::Intact => (0.0, 0.0, v3(0.0, 0.0, 0.0)),
            props::PropState::Fuse { left } => (1.0, left, v3(0.0, 0.0, 0.0)),
            props::PropState::Venting { left, leak } => (2.0, left, leak),
        };
        let struck = p.struck.unwrap_or(v3(0.0, 0.0, 0.0));
        let fixed = if p.fixed { 1.0 } else { 0.0 };
        out[14..26].copy_from_slice(&[fixed, p.hp, kind, left, leak.x, leak.z, p.burn, p.charred, p.yielding, struck.x, struck.y, struck.z]);
    });
}

/// Le nombre de liaisons rompues du robot `bot`.
#[unsafe(no_mangle)]
pub extern "C" fn sim_cut_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].cuts.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_debris_count(id: u32) -> u32 {
    with(id, |s| s.debris.len() as u32)
}

/// L'état du débris `i` (du plus vieux au plus jeune) : treize nombres de 8 octets (`body_state`).
///
/// # Safety
/// `out` pointe sur 13 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_debris_state(id: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let rb = s.debris[i as usize].rb;
        unsafe { std::slice::from_raw_parts_mut(out, 13) }.copy_from_slice(&body_state(s, rb));
    });
}

/// Ce qui s'est passé depuis la création du monde : chocs, lots de dégâts, blocs détruits,
/// liaisons rompues, robots hors de combat, roues arrachées, roues retirées, ce qui n'est pas porté,
/// tirages du hasard, explosions, accessoires retirés, accessoires libérés, blocs allumés, blocs
/// éteints, événements du feu des accessoires : quinze nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 15 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_stats(id: u32, out: *mut f64) {
    with(id, |s| {
        let t = s.stats;
        let values = [
            t.collisions, t.damage, t.destroyed, t.links_broken, t.killed, t.wheels_released, t.wheels_removed, t.unported, 0, t.explosions,
            t.props_removed, t.props_released, t.fires_started, t.fires_ended, t.prop_fire_events,
        ];
        let out = unsafe { std::slice::from_raw_parts_mut(out, 15) };
        for (o, v) in out.iter_mut().zip(values) {
            *o = v as f64;
        }
        out[8] = s.rng.draws as f64;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_robot_roule() {
        let mut sim = Sim::new();
        let design = &catalog::catalog().robots["trike"].design;
        let y = robot::ground_height(design) + 0.03;
        let bot = sim.spawn("trike", v3(0.0, y, 0.0), 0.0).unwrap();
        for _ in 0..60 {
            sim.step();
        }
        sim.bots[bot].input.throttle = 1.0;
        for _ in 0..180 {
            sim.step();
        }
        let rb = sim.part(sim.bots[bot].parts[0]).rb;
        let p = sim.phys.translation(rb);
        assert!(p.z > 5.0, "le tricycle avance : z = {}", p.z);
        assert!(sim.spawn("drone", v3(5.0, 3.0, 0.0), 0.0).is_err());
    }

    #[test]
    fn un_robot_qui_heurte_un_mur_s_abime() {
        // Le mille-pattes, lancé contre un mur : des blocs détruits, des liaisons rompues, des morceaux
        let mut sim = Sim::new();
        sim.add_box(v3(0.0, 0.6, -36.0), v3(36.5, 0.6, 0.5), vec::NO_ROTATION, false);
        sim.rng = rng::Rng::new(7);
        let y = robot::ground_height(&catalog::catalog().robots["centi"].design) + 0.03;
        let bot = sim.spawn("centi", v3(0.0, y, 8.0), std::f64::consts::PI).unwrap();
        for i in 0..9 * 60 {
            sim.bots[bot].input = robot::Input { throttle: if i < 60 { 0.0 } else { 1.0 }, steer: 0.0, brake: 0.0, boost: i >= 60 };
            sim.step();
        }
        let s = sim.stats;
        assert!(s.collisions > 0 && s.destroyed > 0, "il s'est abîmé : {} chocs, {} blocs détruits", s.collisions, s.destroyed);
        assert!(sim.bots[bot].parts.len() > 1, "il s'est séparé en morceaux");
        assert_eq!(s.links_broken as usize, sim.bots[bot].cuts.len());
        assert_eq!(s.unported, 0);
    }

    #[test]
    fn un_baril_ecrase_contre_un_mur_explose_et_met_le_feu() {
        // Le char lancé contre un baril coincé au pied du mur sud, entre des caisses
        let mut sim = Sim::new();
        sim.add_box(v3(0.0, 0.6, -36.0), v3(36.5, 0.6, 0.5), vec::NO_ROTATION, false);
        sim.rng = rng::Rng::new(13);
        sim.add_prop("barrel", v3(0.0, 0.5, -35.1), None, None, None).unwrap();
        for x in [2.8, -2.8] {
            sim.add_prop("crate", v3(x, 0.5, -35.0), None, None, None).unwrap();
        }
        assert!(sim.add_prop("piano", v3(0.0, 0.5, 0.0), None, None, None).is_err());
        let y = robot::ground_height(&catalog::catalog().robots["tank"].design) + 0.03;
        let bot = sim.spawn("tank", v3(0.0, y, -22.0), std::f64::consts::PI).unwrap();
        for i in 0..9 * 60 {
            sim.bots[bot].input = robot::Input { throttle: if i < 60 { 0.0 } else { 1.0 }, steer: 0.0, brake: 0.0, boost: i >= 60 };
            sim.step();
        }
        let s = sim.stats;
        assert_eq!(s.explosions, 1, "le baril a sauté");
        assert!(sim.props[0].is_none(), "le baril n'est plus là");
        assert!(s.destroyed > 0 && s.fires_started > 0, "le char est abîmé et en feu : {} blocs détruits, {} allumés", s.destroyed, s.fires_started);
        assert_eq!(s.unported, 0);
    }
}
