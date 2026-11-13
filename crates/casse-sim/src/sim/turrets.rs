//! Les tourelles (src/shared/combat/turrets.ts) : une tête orientée en lacet et en site, à vitesse
//! limitée, indépendamment du robot ; son repère (la bouche du canon), la ligne de tir qui ne doit
//! pas traverser son propre robot, le tir (le projectile part de la bouche avec la vitesse du robot
//! en ce point, le recul le pousse à l'opposé), et le tir à tour de rôle d'armes identiques. Les
//! zones touchables des têtes suivent leur lacet et leur site (`syncHeads`, robot/colliders.ts).

use super::arsenal::{can_fire, stack_rate, use_arm};
use super::catalog::{Fixed, TurretSpec, WeaponDef, catalog};
use super::debris::block_world_pos;
use super::projectiles::{Launch, spawn_projectile};
use super::robot::Head;
use super::vec::{NO_ROTATION, Q, V3, add, axis_angle, clamp, cross, dot, qmul, qrot, qrot_inv, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;

/// Pas du suivi de la ligne de tir dans la grille du robot (m) : `BLOCK_SIZE / 5`.
const LINE_STEP: f64 = 0.5 / 5.0;
/// Écart de lacet ou de site (rad) en deçà duquel on ne repose pas une zone touchable (`HEAD_TURN`).
const HEAD_TURN: f64 = 0.01;

/// La spécification de la tourelle `t` du robot `bot` (`turretSpec`).
pub fn spec(sim: &Sim, bot: usize, t: usize) -> &'static TurretSpec {
    let b = &sim.bots[bot];
    catalog().blocks[&b.blocks[b.turrets[t].block].kind].turret.as_ref().expect("tourelle sans spécification")
}

/// L'arme de la tourelle `t` du robot `bot` (`weaponDef(t.weapon)`).
pub fn weapon(sim: &Sim, bot: usize, t: usize) -> &'static WeaponDef {
    &catalog().weapons[sim.bots[bot].turrets[t].weapon]
}

/// Les tourelles encore reliées au cockpit : les seules alimentées (`liveTurrets`), leurs rangs.
pub fn live_turrets(sim: &Sim, bot: usize) -> Vec<usize> {
    let b = &sim.bots[bot];
    if !b.cockpit_alive() {
        return Vec::new();
    }
    let ck = b.cockpit_part();
    (0..b.turrets.len()).filter(|&t| b.blocks[b.turrets[t].block].alive && b.blocks[b.turrets[t].block].part == ck).collect()
}

/// Direction du canon dans le repère du bloc, d'après le lacet et le site (`barrelLocal`).
fn barrel_local(yaw: f64, pitch: f64) -> V3 {
    v3(dsin(yaw) * dcos(pitch), dsin(pitch), dcos(yaw) * dcos(pitch))
}

/// Direction du tir dans le repère du bloc : celle du canon, ou la sortie d'une tourelle fixe (`outletLocal`).
fn outlet_local(spec: &TurretSpec, yaw: f64, pitch: f64) -> V3 {
    match spec.fixed {
        Some(Fixed::Back) => v3(0.0, 0.0, -1.0),
        Some(Fixed::Down) => v3(0.0, -1.0, 0.0),
        None => barrel_local(yaw, pitch),
    }
}

/// Repère d'une tourelle (`TurretFrame`) : la rotation de son bloc dans le monde, la direction du
/// canon et sa bouche.
pub struct Frame {
    pub base: Q,
    pub dir: V3,
    pub muzzle: V3,
}

/// Repère actuel d'une tourelle (`turretFrame`).
pub fn turret_frame(sim: &Sim, bot: usize, t: usize) -> Frame {
    let s = spec(sim, bot, t);
    let b = &sim.bots[bot];
    let turret = &b.turrets[t];
    let block = &b.blocks[turret.block];
    let base = qmul(sim.phys.rotation(sim.part(block.part).rb), block.rot);
    let pivot = add(block_world_pos(sim, bot, turret.block), qrot(base, v3(0.0, s.height, 0.0)));
    let dir = qrot(base, outlet_local(s, turret.yaw, turret.pitch));
    Frame { base, dir, muzzle: add(pivot, scale(dir, s.barrel)) }
}

/// La case de la grille du robot qui contient ce point (repère local, m) (`cellOf`).
fn cell_of(p: V3) -> (i64, i64, i64) {
    let r = |x: f64| jsmath::round(x / 0.5) as i64;
    (r(p.x), r(p.y), r(p.z))
}

/// Axe de la tête d'une tourelle, dans le repère du robot (m) (`pivotLocal`).
fn pivot_local(sim: &Sim, bot: usize, t: usize) -> V3 {
    let b = &sim.bots[bot];
    let block = &b.blocks[b.turrets[t].block];
    add(block.local, qrot(block.rot, v3(0.0, spec(sim, bot, t).height, 0.0)))
}

/// La ligne de tir traverse-t-elle son propre robot (`lineOfFireBlocked`) ? On la suit depuis l'axe
/// de la tête, case par case dans la grille du robot, jusqu'à sortir de son encombrement : un bloc de
/// son morceau (autre que celui de la tourelle), ou la tête d'une autre de ses tourelles, la masque.
pub fn line_of_fire_blocked(sim: &Sim, bot: usize, t: usize) -> bool {
    let s = spec(sim, bot, t);
    let b = &sim.bots[bot];
    let turret = &b.turrets[t];
    let block = &b.blocks[turret.block];
    let pivot = pivot_local(sim, bot, t);
    let dir = qrot(block.rot, outlet_local(s, turret.yaw, turret.pitch));
    let mut heads = Vec::new();
    for (o, other) in b.turrets.iter().enumerate() {
        let ob = &b.blocks[other.block];
        if o != t && ob.alive && ob.part == block.part {
            heads.push(cell_of(pivot_local(sim, bot, o)));
        }
    }
    let reach = 2.0 * b.radius + jsmath::max(b.top, 1.0) + 1.0;
    let own = block.cell();
    let mut d = LINE_STEP / 2.0;
    while d <= reach {
        let key = cell_of(add(pivot, scale(dir, d)));
        d += LINE_STEP;
        if key == own {
            continue;
        }
        if let Some(&hit) = b.cells.get(&key)
            && b.blocks[hit].part == block.part
        {
            return true;
        }
        if heads.contains(&key) {
            return true;
        }
    }
    false
}

/// Lacet et site (dans son débattement) que doit prendre la tête pour viser la direction monde `want` (`aimAngles`).
fn aim_angles(s: &TurretSpec, base: Q, want: V3) -> (f64, f64) {
    let local = qrot_inv(base, want);
    (local.x.atan2(local.z), clamp(local.y.atan2(jsmath::hypot2(local.x, local.z)), s.min_pitch, s.max_pitch))
}

/// La tête revient au repos, canon droit devant, à l'horizontale (dans son débattement) (`restTurret`).
pub fn rest_turret(sim: &mut Sim, bot: usize, t: usize) {
    let s = spec(sim, bot, t);
    if s.fixed.is_none() {
        turn_head(sim, bot, t, 0.0, clamp(0.0, s.min_pitch, s.max_pitch));
    }
}

/// Un pas de rotation de la tête vers ce lacet (par le plus court) et ce site, à ses vitesses de rotation (`turnHead`).
fn turn_head(sim: &mut Sim, bot: usize, t: usize, yaw: f64, pitch: f64) {
    let s = spec(sim, bot, t);
    let turret = &mut sim.bots[bot].turrets[t];
    let dyaw = dsin(yaw - turret.yaw).atan2(dcos(yaw - turret.yaw));
    turret.yaw += clamp(dyaw, -s.yaw_rate * STEP, s.yaw_rate * STEP);
    turret.pitch += clamp(pitch - turret.pitch, -s.pitch_rate * STEP, s.pitch_rate * STEP);
}

/// Tourne la tête vers la direction monde `want`, à ses vitesses de rotation et dans son débattement
/// en site (`aimTurret`) ; l'angle qui reste entre le canon et `want` (rad).
pub fn aim_turret(sim: &mut Sim, bot: usize, t: usize, want: V3) -> f64 {
    aim_turret_within(sim, bot, t, want, false)
}

/// `aimTurret(t, want, reachable)` : avec `reachable`, l'angle qui reste jusqu'à la position que la
/// tête peut atteindre (à sa butée en site), pas jusqu'à `want` (le tir en cloche du pilote).
pub fn aim_turret_within(sim: &mut Sim, bot: usize, t: usize, want: V3, reachable: bool) -> f64 {
    let s = spec(sim, bot, t);
    if s.fixed.is_some() {
        return 0.0;
    }
    let base = turret_frame(sim, bot, t).base;
    let (yaw, pitch) = aim_angles(s, base, want);
    turn_head(sim, bot, t, yaw, pitch);
    let turret = &sim.bots[bot].turrets[t];
    let now = qrot(base, barrel_local(turret.yaw, turret.pitch));
    let goal = if reachable { qrot(base, barrel_local(yaw, pitch)) } else { want };
    clamp(dot(now, goal), -1.0, 1.0).acos()
}

/// La tourelle peut tirer : cadence, chaleur et munitions, et assez d'énergie pour une arme électrique (`turretReady`).
pub fn turret_ready(sim: &Sim, bot: usize, t: usize) -> bool {
    let power = weapon(sim, bot, t).power;
    can_fire(&sim.bots[bot].turrets[t].arm) && (power == 0.0 || sim.bots[bot].energy >= power)
}

/// Une tourelle prête à tirer à ce pas, qui attend son tour, la cible de ses missiles à tête
/// chercheuse, et la dispersion d'un tir du pilote (`ShotRequest` ; aucune : celle de l'IA).
pub struct ShotRequest {
    pub turret: usize,
    pub homing: Option<usize>,
    pub spread: Option<f64>,
}

/// Tir à tour de rôle des armes identiques d'un robot (`fireInTurn`) : parmi les tourelles d'une même
/// arme prêtes à tirer, celle qui a tiré le moins récemment tire, si le rythme commun de l'arme le
/// permet (`next_shot`). Au plus un tir par arme et par pas.
pub fn fire_in_turn(sim: &mut Sim, bot: usize, requests: &[ShotRequest]) {
    // (une `Map` : les armes dans l'ordre de leur première demande)
    let mut turn: Vec<(&'static str, &ShotRequest)> = Vec::new();
    for r in requests {
        let b = &sim.bots[bot];
        let w = b.turrets[r.turret].weapon;
        match turn.iter_mut().find(|e| e.0 == w) {
            Some(e) => {
                if b.turrets[r.turret].fired_at < b.turrets[e.1.turret].fired_at {
                    e.1 = r;
                }
            }
            None => turn.push((w, r)),
        }
    }
    for (w, r) in turn {
        let t = r.turret;
        let next = sim.bots[bot].next_shot.iter().find(|e| e.0 == w).map_or(f64::NEG_INFINITY, |e| e.1);
        if sim.time < next {
            continue;
        }
        let count = live_turrets(sim, bot).into_iter().filter(|&o| sim.bots[bot].turrets[o].weapon == w).count();
        // (le retard dû au pas fixe se reporte sur le tir suivant, d'un pas au plus)
        let at = jsmath::max(next, sim.time - STEP) + catalog().weapons[w].cooldown / stack_rate(count);
        let b = &mut sim.bots[bot];
        match b.next_shot.iter_mut().find(|e| e.0 == w) {
            Some(e) => e.1 = at,
            None => b.next_shot.push((w, at)),
        }
        b.turrets[t].fired_at = sim.time;
        fire_turret(sim, bot, t, r.homing, r.spread);
    }
}

/// Vitesse du robot au point `muzzle` (celle que garde un projectile qui en part) (`muzzleVelocity`).
pub fn muzzle_velocity(sim: &Sim, bot: usize, t: usize, muzzle: V3) -> V3 {
    let b = &sim.bots[bot];
    let rb = sim.part(b.blocks[b.turrets[t].block].part).rb;
    add(sim.phys.linvel(rb), cross(sim.phys.angvel(rb), sub(muzzle, sim.phys.world_com(rb))))
}

/// Tire (`fireTurret`) : le projectile part de la bouche avec la vitesse du robot en ce point
/// (dispersé comme le tir de l'IA, sans viseur ; téléguidé par la tourelle ; `homing` : la cible de
/// sa tête chercheuse), et le recul pousse le robot à l'opposé.
pub fn fire_turret(sim: &mut Sim, bot: usize, t: usize, homing: Option<usize>, spread: Option<f64>) {
    let w = weapon(sim, bot, t);
    if w.power != 0.0 {
        let b = &mut sim.bots[bot];
        b.energy = jsmath::max(0.0, b.energy - w.power);
    }
    let Frame { dir, muzzle, .. } = turret_frame(sim, bot, t);
    let rb = sim.part(sim.bots[bot].blocks[sim.bots[bot].turrets[t].block].part).rb;
    let inherit = muzzle_velocity(sim, bot, t, muzzle);
    let launch = Launch { shooter: Some(bot), commander: Some(t), homing, inherit, spread };
    spawn_projectile(sim, sim.bots[bot].turrets[t].weapon, muzzle, dir, launch);
    if w.recoil != 0.0 {
        sim.phys.apply_impulse_at_point(rb, scale(dir, -w.recoil), muzzle, true);
    }
    use_arm(&mut sim.bots[bot].turrets[t].arm, w);
}

/// Pose la zone touchable d'une tête d'après son lacet et son site (`placeHead`), dans le repère du
/// morceau : lacet, puis site ; un poseur de mines est tourné vers l'arrière.
pub fn place_head(sim: &mut Sim, bot: usize, h: &mut Head) {
    let s = spec(sim, bot, h.turret);
    let turret = &sim.bots[bot].turrets[h.turret];
    let block = &sim.bots[bot].blocks[turret.block];
    let turn = match s.fixed {
        Some(Fixed::Back) => axis_angle(v3(0.0, 1.0, 0.0), std::f64::consts::PI),
        Some(Fixed::Down) => NO_ROTATION,
        None => qmul(axis_angle(v3(0.0, 1.0, 0.0), turret.yaw), axis_angle(v3(1.0, 0.0, 0.0), -turret.pitch)),
    };
    let q = qmul(block.rot, turn);
    let pivot = add(block.local, qrot(block.rot, v3(0.0, s.height, 0.0)));
    let (yaw, pitch) = (turret.yaw, turret.pitch);
    if let Some(c) = h.head {
        sim.phys.set_translation_wrt_parent(c, pivot);
        sim.phys.set_rotation_wrt_parent(c, q);
    }
    if let Some(c) = h.barrel {
        let capsule_to_z = axis_angle(v3(1.0, 0.0, 0.0), std::f64::consts::PI / 2.0);
        sim.phys.set_translation_wrt_parent(c, add(pivot, qrot(q, v3(0.0, 0.0, s.barrel / 2.0))));
        sim.phys.set_rotation_wrt_parent(c, qmul(q, capsule_to_z));
    }
    h.yaw = yaw;
    h.pitch = pitch;
}

/// Les zones touchables suivent les têtes qui ont tourné (`syncHeads`, une fois par pas, avant la physique).
pub fn sync_heads(sim: &mut Sim) {
    use super::colliders::place_blade;
    for p in sim.order.clone() {
        let bot = sim.part(p).bot;
        let mut heads = std::mem::take(&mut sim.part_mut(p).heads);
        for h in heads.iter_mut() {
            let t = &sim.bots[bot].turrets[h.turret];
            if (t.yaw - h.yaw).abs() > HEAD_TURN || (t.pitch - h.pitch).abs() > HEAD_TURN {
                place_head(sim, bot, h);
            }
        }
        sim.part_mut(p).heads = heads;
        // (les lames des rotors à bras et les têtes des bras : celles qui ont tourné)
        let mut blades = std::mem::take(&mut sim.part_mut(p).blades);
        for h in blades.iter_mut() {
            let arm = &sim.bots[bot].melee[h.arm];
            let moved = match h.moves {
                super::robot::Moves::Rotor => (arm.angle - h.angle).abs() > HEAD_TURN,
                super::robot::Moves::Swing => (arm.swing - h.swing).abs() > HEAD_TURN,
                super::robot::Moves::Still => false,
            };
            if moved {
                place_blade(sim, bot, h);
            }
        }
        sim.part_mut(p).blades = blades;
    }
}
