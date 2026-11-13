//! Ce que la session de la simulation portée envoie au client (src/shared/net/snapshot.ts,
//! encoder.ts) : l'instantané binaire de chaque image (`writeSnapshot`), octet pour octet celui du
//! TypeScript, la description d'un robot (`describeBot`) et celle du monde pour qui arrive
//! (`describeWorld`), et le verrou du pilote (`pilotLock`).
//!
//! L'instantané écrit les nombres réels en flottants de 4 octets (`as f32`, l'arrondi au plus proche
//! de `DataView.setFloat32`) et les entiers comme les écrit `DataView` (`setUint8` d'un nombre : sa
//! partie entière, modulo 256).

use super::aero::{aero_of, flap_runs};
use super::barriers::write_barrier;
use super::brain::Mode;
use super::debris::write_debris;
use super::emp::{local_stuns, write_shock};
use super::events::{Writer, code};
use super::fire::write_ground_fire;
use super::game::Winner;
use super::melee::{Phase, Surface, melee_frame};
use super::props::{PropState, present, prop};
use super::smoke::write_smoke;
use super::vec::{Q, V3, sub};
use super::world::Sim;

/// L'écriture d'un instantané (`Writer` de src/shared/net/binary.ts, petit-boutiste).
struct Bytes(Vec<u8>);

impl Bytes {
    /// `setUint8` d'un nombre : sa partie entière, modulo 256 (NaN : 0).
    fn u8(&mut self, v: f64) {
        self.0.push(if v.is_finite() { (v.trunc() as i64).rem_euclid(256) as u8 } else { 0 });
    }
    fn u16(&mut self, v: f64) {
        let n = if v.is_finite() { (v.trunc() as i64).rem_euclid(65536) as u16 } else { 0 };
        self.0.extend_from_slice(&n.to_le_bytes());
    }
    fn u32(&mut self, v: u64) {
        self.0.extend_from_slice(&(v as u32).to_le_bytes());
    }
    fn f32(&mut self, v: f64) {
        self.0.extend_from_slice(&(v as f32).to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn vec3(&mut self, v: V3) {
        self.f32(v.x);
        self.f32(v.y);
        self.f32(v.z);
    }
    fn quat(&mut self, q: Q) {
        self.f32(q.x);
        self.f32(q.y);
        self.f32(q.z);
        self.f32(q.w);
    }
}

/// Code d'un mode d'IA dans l'instantané (`MODE_CODES`, src/shared/net/protocol.ts).
pub fn mode_code(m: Mode) -> f64 {
    (match m {
        Mode::Patrol => 0,
        Mode::Engage => 1,
        Mode::Cover => 2,
        Mode::Flee => 3,
        Mode::Charge => 4,
        Mode::Reverse => 5,
        Mode::Hover => 6,
        Mode::Paused => 7,
        Mode::Gliding => 8,
        Mode::Landing => 9,
        Mode::Stunned => 10,
        Mode::Flipped => 11,
        Mode::Stranded => 12,
        Mode::Falling => 13,
        Mode::Dead => 14,
        Mode::Support => 15,
    }) as f64
}

/// Munitions illimitées (armes sans chargeur) dans l'instantané (`NO_AMMO`).
const NO_AMMO: f64 = 255.0;
/// Drapeau d'une morsure qui glisse (`BITE_GLANCE`).
const BITE_GLANCE: u8 = 0x80;

/// L'instantané du monde (`writeSnapshot`).
pub fn write_snapshot(sim: &Sim) -> Vec<u8> {
    let mut w = Bytes(Vec::with_capacity(8192));
    w.f64(sim.time);

    match &sim.match_ {
        None => w.u8(0.0),
        Some(m) => {
            w.u8(1.0);
            // (en capture de zones, le score gagne des fractions de point : on envoie la partie entière)
            w.u16(m.score[0].floor());
            w.u16(m.score[1].floor());
            w.f32(m.elapsed);
            w.u8(match m.winner {
                None => 0.0,
                Some(Winner::Team(0)) => 1.0,
                Some(Winner::Team(_)) => 2.0,
                Some(Winner::Draw) => 3.0,
            });
            w.u8(m.respawns.len().min(255) as f64);
            for &(b, at) in m.respawns.iter().take(255) {
                w.u32(sim.bots[b].id);
                w.f32(at);
            }
            w.u8(m.zones.len() as f64);
            for z in &m.zones {
                w.u8(z.owner.map_or(0.0, |o| o as f64 + 1.0));
                w.f32(z.progress);
                w.u8((if z.contested { 1.0 } else { 0.0 }) + if z.active { 2.0 } else { 0.0 });
            }
        }
    }
    for team in 0..2 {
        let seen = sim.detected[team].as_deref().unwrap_or(&[]);
        w.u16(seen.len() as f64);
        for &b in seen {
            w.u32(sim.bots[b].id);
        }
    }

    w.u16(sim.roster.len() as f64);
    for &b in &sim.roster {
        write_bot(sim, &mut w, b);
    }

    w.u16(sim.order.len() as f64);
    for &p in &sim.order {
        let part = sim.part(p);
        let rb = part.rb;
        w.u32(part.id);
        w.vec3(sim.phys.translation(rb));
        w.quat(sim.phys.rotation(rb));
        w.vec3(sim.phys.linvel(rb));
        w.vec3(sim.phys.angvel(rb));
        w.vec3(sim.phys.world_com(rb));
        w.f32(sim.phys.mass(rb));
    }

    // (une épave de roue retirée n'a plus de corps : elle n'est plus là)
    let wheels: Vec<(usize, usize)> = sim
        .roster
        .iter()
        .flat_map(|&b| (0..sim.bots[b].wheels.len()).map(move |i| (b, i)))
        .filter(|&(b, i)| {
            let wheel = &sim.bots[b].wheels[i];
            wheel.part.is_some() || wheel.body.is_some()
        })
        .collect();
    w.u16(wheels.len() as f64);
    for (b, i) in wheels {
        let wheel = &sim.bots[b].wheels[i];
        w.u32(wheel.id);
        match wheel.body {
            Some(body) => {
                w.vec3(sim.phys.translation(body));
                w.quat(sim.phys.rotation(body));
            }
            None => {
                w.vec3(wheel.rb.pos);
                w.quat(wheel.rb.rot);
            }
        }
        w.u32(wheel.part.map_or(0, |p| sim.part(p).id));
        match &wheel.hub {
            Some(hub) => {
                w.u8(1.0);
                w.vec3(hub.pos);
                w.quat(hub.rot);
            }
            None => w.u8(0.0),
        }
        w.f32(wheel.drive);
        w.f32(wheel.steer);
    }

    w.u16(sim.debris.len() as f64);
    for d in &sim.debris {
        w.u32(d.id);
        w.vec3(sim.phys.translation(d.rb));
        w.quat(sim.phys.rotation(d.rb));
    }

    // Un accessoire ancré ne bouge pas : la réplique le pose d'après son emplacement
    let moving: Vec<usize> = present(sim).into_iter().filter(|&i| !prop(sim, i).fixed).collect();
    w.u16(moving.len() as f64);
    for i in moving {
        let p = prop(sim, i);
        w.u32(p.id);
        w.vec3(sim.phys.translation(p.rb));
        w.quat(sim.phys.rotation(p.rb));
        match p.state {
            PropState::Intact => {
                w.u8(0.0);
                w.f32(0.0);
                w.f32(0.0);
            }
            PropState::Fuse { .. } => {
                w.u8(1.0);
                w.f32(0.0);
                w.f32(0.0);
            }
            PropState::Venting { leak, .. } => {
                w.u8(2.0);
                w.f32(leak.x);
                w.f32(leak.z);
            }
        }
    }

    w.u16(sim.projectiles.len() as f64);
    for p in &sim.projectiles {
        w.u32(p.id);
        w.vec3(p.pos);
        w.vec3(p.vel);
        w.f32(p.age);
    }
    w.0
}

fn write_bot(sim: &Sim, w: &mut Bytes, b: usize) {
    let bot = &sim.bots[b];
    w.u32(bot.id);
    w.u8(if bot.piloted { 1.0 } else { 0.0 });
    w.f32(bot.energy);
    w.u8(bot.flares.charges.min(255.0));
    w.u8(mode_code(bot.ai.mode));
    w.f32(bot.stunned_until);
    w.f32(bot.righting);
    w.f32(bot.flipped_for);
    w.u32(bot.last_attacker.map_or(0, |a| sim.bots[a].id));
    w.vec3(bot.last_pos);

    let turrets: Vec<_> = bot.turrets.iter().filter(|t| bot.blocks[t.block].alive).collect();
    w.u8(turrets.len() as f64);
    for t in turrets {
        w.u32(bot.blocks[t.block].id);
        w.f32(t.yaw);
        w.f32(t.pitch);
        w.u8(if t.arm.ammo.is_finite() { t.arm.ammo.min(NO_AMMO - 1.0) } else { NO_AMMO });
        w.f32(t.arm.heat);
        w.u8(if t.arm.overheated { 1.0 } else { 0.0 });
        w.f32(t.arm.cooldown);
        w.f32(t.arm.restock);
    }
    let thrusters: Vec<_> = bot.thrusters.iter().filter(|t| bot.blocks[t.block].alive).collect();
    w.u8(thrusters.len() as f64);
    for t in thrusters {
        w.u32(bot.blocks[t.block].id);
        w.f32(t.thrust);
        w.f32(t.tilt_a);
        w.f32(t.tilt_b);
    }
    // Gouvernes : un braquage par rang, nommé par l'un de ses blocs (`flapRuns`)
    let flaps: Vec<usize> = (0..bot.surfaces.len())
        .filter(|&s| {
            let k = bot.surfaces[s].block;
            bot.blocks[k].alive && aero_of(sim, b, k).max_deflection.is_some_and(|d| d != 0.0)
        })
        .collect();
    let runs = if flaps.is_empty() { Vec::new() } else { flap_runs(sim, b, &flaps) };
    w.u8(runs.len() as f64);
    for run in runs {
        let s = &bot.surfaces[run[0]];
        w.u32(bot.blocks[s.block].id);
        w.f32(s.deflection);
    }
    let supports: Vec<_> = bot.supports.iter().filter(|s| bot.blocks[s.block].alive).collect();
    w.u8(supports.len() as f64);
    for s in supports {
        w.u32(bot.blocks[s.block].id);
        w.f32(s.contact);
        w.f32(s.force);
        w.f32(s.phase);
    }
    let melee: Vec<_> = bot.melee.iter().filter(|a| bot.blocks[a.block].alive).collect();
    w.u8(melee.len() as f64);
    for a in melee {
        w.u32(bot.blocks[a.block].id);
        w.f32(a.spin);
        w.u8(match a.phase {
            Phase::Ready => 0.0,
            Phase::Strike => 1.0,
            Phase::Recover => 2.0,
            Phase::Hold => 3.0,
        });
        w.f32(a.swing);
        match &a.bite {
            Some(bite) => {
                let surface = match bite.surface {
                    Surface::Robot => 1,
                    Surface::Prop => 2,
                    Surface::Scenery => 3,
                };
                w.0.push(surface | if bite.glance { BITE_GLANCE } else { 0 });
                w.vec3(bite.point);
                w.vec3(bite.dir);
                w.f32(bite.power);
            }
            None => w.u8(0.0),
        }
        // Une frappe à mécanique : ce que tient une mâchoire, la boule d'un fléau (`mechanicsState`)
        let link = match &a.grip {
            Some(g) if sim.bots[g.bot].blocks[g.block].alive => sim.bots[g.bot].blocks[g.block].id,
            _ => 0,
        };
        w.u32(link);
        let mut values = Vec::new();
        if a.spec().motion == "flail"
            && let Some(ball) = &a.ball
        {
            let hub = melee_frame(sim, b, a).hub;
            let at = sub(ball.pos, hub);
            values.extend([a.angle, at.x, at.y, at.z, ball.wound]);
            if let Some(wrap) = &ball.wrap {
                let p = sub(wrap.point, hub);
                values.extend([p.x, p.y, p.z]);
            }
        }
        w.u8(values.len() as f64);
        for x in values {
            w.f32(x);
        }
    }
}

/// La description d'un robot tel qu'il est (`describeBot`, hors son profil, que la session garde) :
/// son équipe, s'il est piloté, ses morceaux, ses blocs vivants (case, numéro, morceau, points, feu),
/// son cockpit, ses roues (rang, numéro, points), ses liaisons rompues (deux cases chacune).
pub fn describe_bot(sim: &Sim, b: usize, w: &mut Writer) {
    let bot = &sim.bots[b];
    w.num(bot.team as f64).flag(bot.piloted).num(bot.profile as f64);
    w.num(bot.parts.len() as f64);
    for &p in &bot.parts {
        w.id(Some(sim.parts[p].as_ref().map_or(0, |part| part.id)));
    }
    w.num(bot.live.len() as f64);
    for &k in &bot.live {
        let block = &bot.blocks[k];
        let part = sim.parts[block.part].as_ref().map_or(0, |part| part.id);
        w.num(block.x).num(block.y).num(block.z).id(Some(block.id)).id(Some(part)).num(block.hp).num(block.burn);
    }
    w.id(Some(bot.blocks[bot.cockpit].id));
    w.num(bot.wheels.len() as f64);
    for wheel in &bot.wheels {
        w.id(Some(wheel.id)).num(wheel.hp);
    }
    w.num(bot.cut_order.len() as f64);
    for &(a, c) in &bot.cut_order {
        w.num(a.0 as f64).num(a.1 as f64).num(a.2 as f64).num(c.0 as f64).num(c.1 as f64).num(c.2 as f64);
    }
}

/// Tout le monde, pour une nouvelle image qui décrit le monde (`describeWorld`, hors l'arène et la
/// partie, que la session dit) : les robots, les accessoires, le bois qui brûle ou a brûlé, les flaques
/// de feu, les débris, les projectiles, les fumées, les murs, les paralysies locales en cours. Des
/// événements du journal (events.rs), dans cet ordre.
pub fn describe_world(sim: &Sim) -> Vec<u8> {
    let mut log = Vec::new();
    let mut put = |c: u8, f: &mut dyn FnMut(&mut Writer)| {
        log.push(c);
        f(&mut Writer::new(&mut log));
    };
    for &b in &sim.roster {
        put(code::BOT_ADDED, &mut |w| {
            w.id(Some(sim.bots[b].id)).num(sim.time).num(sim.bots[b].profile as f64);
        });
    }
    let props = present(sim);
    for &i in &props {
        let p = prop(sim, i);
        put(code::PROP_ADDED, &mut |w| {
            w.id(Some(p.id)).text(&p.kind).num(i as f64).flag(p.fixed);
        });
    }
    for &i in &props {
        let p = prop(sim, i);
        if p.burn > 0.0 || p.charred > 0.0 {
            put(code::PROP_FIRE, &mut |w| {
                w.id(Some(p.id)).flag(p.burn > 0.0).num(p.charred);
            });
        }
    }
    for f in &sim.ground_fires {
        put(code::GROUND_FIRE_ADDED, &mut |w| write_ground_fire(w, f));
    }
    for d in &sim.debris {
        put(code::DEBRIS_ADDED, &mut |w| write_debris(sim, w, d));
    }
    for p in &sim.projectiles {
        put(code::PROJECTILE_ADDED, &mut |w| {
            w.id(Some(p.id)).text(p.weapon).id(sim.bot_id_of(p.shooter));
        });
    }
    for c in &sim.smokes {
        put(code::SMOKE_ADDED, &mut |w| write_smoke(w, c));
    }
    for b in &sim.barriers {
        put(code::BARRIER_ADDED, &mut |w| write_barrier(w, b));
    }
    for &b in &sim.roster {
        let (blocks, wheels, until) = local_stuns(sim, b);
        if !blocks.is_empty() || !wheels.is_empty() {
            put(code::ORGANS_STUNNED, &mut |w| write_shock(sim, w, b, &blocks, &wheels, until, None));
        }
    }
    log
}

/// Le verrou à montrer au pilote (`pilotLock`) : la première tourelle de son robot qui verrouille un
/// ennemi encore en vie ; le numéro de son bloc, celui de sa cible et la part acquise (`lockProgress`).
pub fn pilot_lock(sim: &Sim, b: usize) -> Option<(u64, u64, f64)> {
    let bot = &sim.bots[b];
    let t = bot.turrets.iter().find(|t| bot.blocks[t.block].alive && t.lock_on.is_some_and(|o| sim.bots[o].cockpit_alive()))?;
    let target = t.lock_on?;
    let lock = super::catalog::catalog().weapons[t.weapon].lock?;
    let progress = crate::jsmath::min(1.0, t.lock_time / lock.0);
    Some((bot.blocks[t.block].id, sim.bots[target].id, progress))
}
