//! Les rafales d'air (src/shared/arena/air.ts) : à chaque pas, de petites impulsions tirées au hasard
//! font dériver la vitesse et la rotation d'un robot en vol (une marche aléatoire). Un pilote
//! automatique qui contrôle tous les axes les corrige sans peine ; s'il lui manque un axe, le robot part
//! en dérive.

use super::propulsion::inertia_times;
use super::vec::{scale, v3};
use super::world::{STEP, Sim};
use rapier3d::prelude::RigidBodyHandle;

/// Turbulence (`TURBULENCE`, config.ts) : en rotation (rad/s par √s) et en vitesse (m/s par √s).
const ANGULAR: f64 = 0.3;
const LINEAR: f64 = 0.4;

/// Les rafales d'un pas sur le corps `rb` (`buffet`).
pub fn buffet(sim: &mut Sim, rb: RigidBodyHandle) {
    let k = STEP.sqrt();
    // (les arguments se tirent de gauche à droite, comme en JavaScript)
    let (sx, sy, sz) = (sim.rng.normal(), sim.rng.normal(), sim.rng.normal());
    let spin = v3(sx, sy, sz);
    let inertia = sim.phys.effective_angular_inertia(rb);
    sim.phys.apply_torque_impulse(rb, inertia_times(inertia, scale(spin, ANGULAR * k)), true);
    let gx = sim.rng.normal();
    let gy = 0.5 * sim.rng.normal();
    let gz = sim.rng.normal();
    let mass = sim.phys.mass(rb);
    sim.phys.apply_impulse(rb, scale(v3(gx, gy, gz), mass * LINEAR * k), true);
}
