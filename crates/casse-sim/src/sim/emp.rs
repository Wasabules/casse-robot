//! L'impulsion électromagnétique (src/shared/combat/emp.ts) : l'obus du canon IEM et la mine IEM
//! éclatent en une impulsion qui paralyse les robots dont un bloc du morceau du cockpit est à portée,
//! moins longtemps au bord (`empPulse`). Un robot paralysé perd son électronique (`cutPower`) : les
//! moteurs de ses roues passent en roue libre, sans frein, et sa direction flotte (drive.rs), ses
//! moteurs s'arrêtent (propulsion.rs), ses patins retombent et ses pattes se figent (supports.rs) ;
//! son IA ne conduit plus, ses tourelles ne visent ni ne tirent, ses leurres ne partent pas
//! (`thinkBot`) ; son générateur ne recharge plus ses batteries (`settleEnergy`), ses modules de
//! réparation s'arrêtent (repair.rs) et son radar s'éteint (detection.rs).
//!
//! La paralysie locale (la lance électrique, melee.rs) : une impulsion ciblée qui ne coupe que les
//! organes autour du point touché (`stunOrgans` : `Block::stunned_until`, `Wheel::stunned_until`), le
//! reste du robot marche. Chaque organe la respecte (`organStunned`) : une roue passe en roue libre,
//! direction flottante (`cutStunnedOrgans`, après les commandes de chaque pas) ; un moteur ne pousse
//! plus (propulsion.rs, `wearEngines`) ; un appui retombe (supports.rs) ; une tourelle se fige et se
//! tait (gunner.rs, drive.rs) ; une arme de contact n'est plus alimentée (melee.rs) ; un bouclier
//! n'absorbe plus (damage.rs).

use super::events::{Writer, code};
use super::catalog::EmpPulse;
use super::debris::block_world_pos;
use super::propulsion::idle_thrusters;
use super::supports::drive_supports;
use super::vec::V3;
use super::world::Sim;
use crate::jsmath;

fn distance(a: V3, b: V3) -> f64 {
    jsmath::hypot3(a.x - b.x, a.y - b.y, a.z - b.z)
}

/// Impulsion en `point` (`empPulse`) : paralyse les robots dont un bloc du morceau du cockpit est à
/// portée, moins longtemps au bord ; une paralysie plus longue en cours reste.
pub fn emp_pulse(sim: &mut Sim, point: V3, pulse: &EmpPulse) {
    sim.stats.emp_bursts += 1;
    sim.emit_point(code::EMP_BURST, point, Some(pulse.radius));
    for b in sim.roster.clone() {
        if !sim.bots[b].cockpit_alive() {
            continue;
        }
        let mut d = f64::INFINITY;
        for &k in &sim.part(sim.bots[b].cockpit_part()).blocks {
            d = jsmath::min(d, distance(block_world_pos(sim, b, k), point));
        }
        if d > pulse.radius {
            continue;
        }
        let until = sim.time + pulse.duration * (1.0 - (0.5 * d) / pulse.radius);
        if until > sim.bots[b].stunned_until {
            sim.bots[b].stunned_until = until;
            sim.stats.stuns += 1;
            sim.emit(code::STUNNED, |s, w| {
                w.id(Some(s.bots[b].id)).num(until);
            });
        }
    }
}

/// Le robot est-il paralysé par une impulsion électromagnétique (`isStunned`) ?
pub fn is_stunned(sim: &Sim, b: usize) -> bool {
    sim.bots[b].stunned_until > sim.time
}

/// L'organe que porte ce bloc est-il coupé, par une paralysie locale ou celle de tout son robot
/// (`organStunned`) ?
pub fn organ_stunned(sim: &Sim, b: usize, block: usize) -> bool {
    sim.bots[b].blocks[block].stunned_until > sim.time || sim.bots[b].stunned_until > sim.time
}

/// Paralysie locale (`stunOrgans`) : les blocs du robot `b` (sur ses morceaux) et ses roues montées à
/// moins de `radius` m de `point` sont coupés pendant `duration` s (une paralysie plus longue en cours
/// reste). Lit les poses de ses morceaux : à faire avant d'infliger les dégâts du coup.
pub fn stun_organs(sim: &mut Sim, b: usize, point: V3, radius: f64, duration: f64) {
    let until = sim.time + duration;
    let mut blocks = Vec::new();
    let mut wheels = Vec::new();
    for k in sim.bots[b].live.clone() {
        if distance(block_world_pos(sim, b, k), point) > radius {
            continue;
        }
        let block = &mut sim.bots[b].blocks[k];
        block.stunned_until = jsmath::max(block.stunned_until, until);
        blocks.push(k);
    }
    for (i, w) in sim.bots[b].wheels.iter_mut().enumerate() {
        if w.part.is_none() || distance(w.rb.pos, point) > radius {
            continue;
        }
        w.stunned_until = jsmath::max(w.stunned_until, until);
        wheels.push(i);
    }
    // (l'événement `organsStunned`)
    if !blocks.is_empty() || !wheels.is_empty() {
        sim.stats.organs_stunned += 1;
        sim.emit(code::ORGANS_STUNNED, |s, w| write_shock(s, w, b, &blocks, &wheels, until, Some(point)));
    }
}

/// Les organes du robot `b` paralysés localement en ce moment (`localStuns`) : ses blocs vivants, ses
/// roues montées, et jusqu'à quand.
pub fn local_stuns(sim: &Sim, b: usize) -> (Vec<usize>, Vec<usize>, f64) {
    let bot = &sim.bots[b];
    let mut until: f64 = 0.0;
    let mut blocks = Vec::new();
    for &k in &bot.live {
        let s = bot.blocks[k].stunned_until;
        if s > sim.time {
            blocks.push(k);
            until = jsmath::max(until, s);
        }
    }
    let mut wheels = Vec::new();
    for (i, w) in bot.wheels.iter().enumerate() {
        if w.part.is_some() && w.stunned_until > sim.time {
            wheels.push(i);
            until = jsmath::max(until, w.stunned_until);
        }
    }
    (blocks, wheels, until)
}

/// Une paralysie locale telle que l'encodeur la décrit (`shock`) : le robot, ses blocs et ses roues
/// coupés, jusqu'à quand, où la décharge a frappé (rien : un état décrit à qui arrive).
pub fn write_shock(s: &Sim, w: &mut Writer, b: usize, blocks: &[usize], wheels: &[usize], until: f64, point: Option<V3>) {
    let bot = &s.bots[b];
    w.id(Some(bot.id)).num(blocks.len() as f64);
    for &k in blocks {
        w.id(Some(bot.blocks[k].id));
    }
    w.num(wheels.len() as f64);
    for &i in wheels {
        w.id(Some(bot.wheels[i].id));
    }
    w.num(until).flag(point.is_some());
    if let Some(p) = point {
        w.vec(p);
    }
}

/// Les roues paralysées localement n'obéissent pas : roue libre, direction flottante, comme sous une
/// impulsion (`cutStunnedOrgans`). Après les commandes du pas (IA ou pilote), avant les roues.
pub fn cut_stunned_organs(sim: &mut Sim, b: usize) {
    let time = sim.time;
    for w in sim.bots[b].wheels.iter_mut() {
        if w.part.is_none() || w.stunned_until <= time {
            continue;
        }
        w.drive = 0.0;
        w.powered = false;
        w.engaged = false;
        w.overrun = false;
        w.brake = 0.0;
    }
}

/// Électronique coupée (`cutPower`) : les patins retombent et les pattes se figent (supports.rs), les
/// moteurs des roues passent en roue libre, sans frein, la direction flotte (une roue directrice non
/// alimentée glisse : wheels.rs), les réacteurs et les propulseurs s'éteignent (leur poussée retombe à
/// leur rythme : propulsion.rs).
pub fn cut_power(sim: &mut Sim, b: usize) {
    drive_supports(sim, b, 0.0, 0.0, false, false, 1.0, 0.0);
    for w in sim.bots[b].wheels.iter_mut() {
        w.drive = 0.0;
        w.powered = false;
        w.engaged = false;
        w.overrun = false;
        w.brake = 0.0;
    }
    idle_thrusters(sim, b);
}
