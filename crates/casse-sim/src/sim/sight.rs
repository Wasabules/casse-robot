//! La ligne de vue d'une arme ou d'une tête chercheuse vers un robot (src/shared/combat/sight.ts) :
//! le décor, les accessoires et la fumée (smoke.rs) la coupent, pas les robots. La cible est en vue si
//! son cockpit, ou un point un peu au-dessus, l'est.

use super::smoke::smoke_blocks;
use super::vec::{V3, add, len, scale, sub, v3};
use super::world::{Owner, Sim};

/// On vise le centre de masse du cockpit, ou ce point au-dessus (m) (`SIGHT_RISE`).
const SIGHT_RISE: f64 = 0.8;

/// Le décor, un accessoire ou la fumée cachent-ils le robot `target`, vu de `from` (`sightBlocked`) ?
pub fn sight_blocked(sim: &Sim, from: V3, target: usize) -> bool {
    let com = sim.phys.world_com(sim.part(sim.bots[target].cockpit_part()).rb);
    blocked_to(sim, from, com) && blocked_to(sim, from, add(com, v3(0.0, SIGHT_RISE, 0.0)))
}

/// De la fumée, ou un collider du décor ou d'un accessoire entre les deux points (à 0,3 m près du
/// second) (`blockedTo`) ?
fn blocked_to(sim: &Sim, from: V3, to: V3) -> bool {
    if smoke_blocks(sim, from, to) {
        return true;
    }
    let seg = sub(to, from);
    let d = len(seg);
    if d < 0.5 {
        return false;
    }
    let keep = |h| matches!(sim.owners.get(&h), None | Some(Owner::Prop(_)));
    sim.phys.cast_ray_where(from, scale(seg, 1.0 / d), d - 0.3, true, &keep).is_some()
}
