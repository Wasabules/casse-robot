//! Les tirs du pilote (src/shared/sim/player.ts, `operatePlayerTurrets`) : les tourelles de l'arme
//! choisie tournent vers le point visé (avec l'angle balistique de leur arme, sauf un tir en cloche,
//! dont le pilote choisit la hausse : `lobDirection`, src/shared/combat/ballistics.ts), les autres
//! reviennent au repos ; gâchette pressée, celles de l'arme choisie tirent quand elles sont prêtes,
//! des armes identiques à tour de rôle, avec la dispersion du pilote (`aimSpread`,
//! src/shared/combat/accuracy.ts : le viseur, le mouvement et les rotations du robot, la vibration
//! d'un rotor déséquilibré) ; une arme de précision ne tire qu'au viseur ; une arme à verrouillage
//! verrouille au viseur ce qu'il vise ; un poseur de mines sème, une soute largue sans viser ; un
//! missile à tête chercheuse part vers l'ennemi le plus proche de l'axe du tir. Et la conduite à la
//! caméra au sol (`cameraDrive`).

use super::arsenal::tick_arm;
use super::catalog::{Mobility, WeaponDef};
use super::drive::steering_geometry;
use super::emp::organ_stunned;
use super::gunner::{firing_direction, operate_support};
use super::lock::{is_locked, release_lock, update_lock};
use super::melee::vibration;
use super::projectiles::find_homing_target;
use super::robot::Input;
use super::turrets::{ShotRequest, aim_turret, aim_turret_within, fire_in_turn, line_of_fire_blocked, live_turrets, muzzle_velocity, rest_turret, turret_frame, turret_ready, weapon};
use super::vec::{V3, add, clamp, dot, norm, qrot, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;

/// Vitesse (m/s) et rotation (rad/s) en deçà desquelles un robot compte pour immobile et stable.
const STILL_SPEED: f64 = 0.3;
const STEADY_TURN: f64 = 0.08;
/// Dispersion la plus large (rad).
const MAX_SPREAD: f64 = 0.3;
/// Une vibration entière (balourd d'une arme de contact) compte comme une rotation de tant de rad/s.
const SHAKE_TURN: f64 = 2.0;
/// Conduite à la caméra : au-delà de cet écart (rad), le robot recule ; gain du braquage.
const REVERSE_ANGLE: f64 = 2.2;
const RELATIVE_STEER: f64 = 1.6;

/// Ce qui dégrade la visée en ce moment (`unsteadiness`) : la vitesse du robot (m/s ; rien en avion)
/// et ses rotations (rad/s), vibration comprise.
fn unsteadiness(sim: &Sim, b: usize) -> (f64, f64) {
    let bot = &sim.bots[b];
    if !bot.cockpit_alive() {
        return (0.0, 0.0);
    }
    let rb = sim.part(bot.cockpit_part()).rb;
    let v = sim.phys.linvel(rb);
    let w = sim.phys.angvel(rb);
    let speed = if bot.mobility == Mobility::Plane { 0.0 } else { jsmath::max(0.0, jsmath::hypot3(v.x, v.y, v.z) - STILL_SPEED) };
    let shake = if bot.melee.is_empty() { 0.0 } else { vibration(sim, b) * SHAKE_TURN };
    (speed, jsmath::max(0.0, jsmath::hypot3(w.x, w.y, w.z) - STEADY_TURN) + shake)
}

/// Dispersion d'un tir du pilote (`aimSpread`, rad) : viseur ou non, et ce que son robot bouge.
fn aim_spread(sim: &Sim, b: usize, w: &WeaponDef, scoped: bool) -> f64 {
    let base = w.spread * (if scoped { 1.0 } else { w.hip });
    let (speed, turn) = unsteadiness(sim, b);
    jsmath::min(MAX_SPREAD, base + w.sway.0 * speed + w.sway.1 * turn)
}

/// Une arme qui tire en cloche (`lobbed`) : lente et soumise à la pesanteur, ni guidée, ni posée.
fn lobbed(w: &WeaponDef) -> bool {
    let p = &w.projectile;
    p.gravity >= 0.2 && p.speed <= 100.0 && p.guidance.is_none() && p.mine.is_none() && !w.dropped
}

/// Une arme qui lâche ses projectiles sans viser (`released`) : poseurs de mines, soute à bombes.
fn released(w: &WeaponDef) -> bool {
    w.projectile.mine.is_some() || w.dropped
}

/// Tir en cloche du pilote (`lobDirection`) : le canon pointe droit vers le point visé, la vitesse
/// héritée du robot retranchée.
fn lob_direction(muzzle: V3, aim: V3, inherit: V3, speed: f64) -> V3 {
    let d = norm(sub(aim, muzzle));
    // k·d − inherit doit mesurer `speed`
    let along = dot(d, inherit);
    let k = along + jsmath::max(0.0, along * along - dot(inherit, inherit) + speed * speed).sqrt();
    norm(sub(scale(d, k), inherit))
}

/// Tourelles du pilote (`operatePlayerTurrets`), avec ses commandes de ce pas (`input` : une ogive en
/// vol les remet à zéro).
pub fn operate_player_turrets(sim: &mut Sim, b: usize, input: &Input) {
    let mut ready = Vec::new();
    for t in live_turrets(sim, b) {
        let w = weapon(sim, b, t);
        tick_arm(&mut sim.bots[b].turrets[t].arm, w, STEP);
        // Paralysée localement (lance électrique, emp.rs) : elle se fige et se tait
        if organ_stunned(sim, b, sim.bots[b].turrets[t].block) {
            continue;
        }
        // Tourelle de soin automatique (nanites) : elle choisit et soigne ses alliés seule
        if w.auto_support {
            if !operate_support(sim, b, t, w, &mut ready) {
                rest_turret(sim, b, t);
            }
            continue;
        }
        let id = sim.bots[b].turrets[t].weapon;
        let armed = input.trigger && input.weapon.is_none_or(|chosen| chosen == id) && (!w.scope_only || input.scope);
        if released(w) {
            if armed && turret_ready(sim, b, t) && !line_of_fire_blocked(sim, b, t) {
                ready.push(ShotRequest { turret: t, homing: None, spread: None });
            }
            continue;
        }
        let Some(aim) = input.aim else { continue };
        // Le point visé (un missile téléguidé suit, lui, l'axe de son lance-missiles)
        sim.bots[b].turrets[t].aim = Some(aim);
        // Les tourelles des autres armes reviennent au repos
        if input.weapon.is_some_and(|chosen| chosen != id) {
            rest_turret(sim, b, t);
            if w.lock.is_some() {
                release_lock(sim, b, t);
            }
            continue;
        }
        let frame = turret_frame(sim, b, t);
        // Tir en cloche : la hausse est celle du pilote ; sinon, correction balistique, la vitesse du
        // robot retranchée
        if lobbed(w) {
            let inherit = muzzle_velocity(sim, b, t, frame.muzzle);
            aim_turret_within(sim, b, t, lob_direction(frame.muzzle, aim, inherit, w.projectile.speed), true);
        } else {
            let rb = sim.part(sim.bots[b].blocks[sim.bots[b].turrets[t].block].part).rb;
            let vel = scale(sim.phys.linvel(rb), -1.0);
            aim_turret(sim, b, t, firing_direction(frame.muzzle, aim, vel, w, sim.gravity));
        }
        // Une arme à verrouillage ne verrouille qu'au viseur ; en le quittant, le verrou retombe
        if w.lock.is_some() {
            if input.scope {
                update_lock(sim, b, t, frame.muzzle, norm(sub(aim, frame.muzzle)), STEP);
            } else {
                release_lock(sim, b, t);
            }
        }
        if armed && turret_ready(sim, b, t) && !line_of_fire_blocked(sim, b, t) && (w.lock.is_none() || is_locked(sim, b, t)) {
            let guidance = w.projectile.guidance.as_ref();
            let homing = if w.lock.is_some() {
                sim.bots[b].turrets[t].lock_on
            } else if let Some(g) = guidance
                && g.mode == "homing"
            {
                find_homing_target(sim, frame.muzzle, frame.dir, g.air_only, Some(b))
            } else {
                None
            };
            let spread = aim_spread(sim, b, w, input.scope);
            ready.push(ShotRequest { turret: t, homing, spread: Some(spread) });
        }
    }
    // Des armes identiques tirent à tour de rôle
    fire_in_turn(sim, b, &ready);
}

/// Conduite à la caméra au sol (`cameraDrive`) : la direction voulue à l'écran ; le robot braque vers
/// elle et avance, d'autant moins vite qu'il en est loin ; s'il lui tourne le dos, il recule.
pub fn camera_drive(sim: &Sim, b: usize, input: &Input) -> (f64, f64) {
    let forward = v3(dsin(input.heading), 0.0, dcos(input.heading));
    let left = v3(forward.z, 0.0, -forward.x);
    let want = add(scale(forward, input.throttle), scale(left, input.steer));
    let magnitude = jsmath::min(1.0, jsmath::hypot2(want.x, want.z));
    if magnitude < 0.1 {
        return (0.0, 0.0);
    }
    let rb = sim.part(sim.bots[b].cockpit_part()).rb;
    let nose = qrot(sim.phys.rotation(rb), v3(0.0, 0.0, 1.0));
    let wrap = |a: f64| dsin(a).atan2(dcos(a));
    // > 0 : la direction voulue est à gauche du robot
    let angle = wrap(want.x.atan2(want.z) - nose.x.atan2(nose.z));
    if angle.abs() > REVERSE_ANGLE {
        let behind = wrap(angle - std::f64::consts::PI);
        let steered = steering_geometry(&sim.phys, &sim.bots[b], Some(rb)).max_curvature > 0.0;
        return (-magnitude, clamp((if steered { -1.0 } else { 1.0 }) * behind * RELATIVE_STEER, -1.0, 1.0));
    }
    (magnitude * clamp(1.0 - angle.abs() / 1.6, 0.25, 1.0), clamp(angle * RELATIVE_STEER, -1.0, 1.0))
}
