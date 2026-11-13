//! La vie d'un robot (src/shared/robot/lifecycle.ts, destruction.ts) : sa naissance d'après son plan
//! (`spawnBot`), ses morceaux (`makePart`, `removePart`, `splitPart`), ses blocs qui passent d'un
//! morceau à l'autre (`attachBlock`, `detachBlock`), ses roues montées, déplacées, arrachées et
//! retirées (`attachWheel`, `moveWheel`, `releaseWheel`, `discardWheel`, `refreshWheels`).
//!
//! Chaque création ou retrait d'un corps ou d'un collider se fait au même moment que dans le
//! TypeScript : Rapier range ses corps et ses colliders (et réutilise leurs places libérées) dans
//! l'ordre des appels, et cet ordre compte pour le bit près.

use super::arsenal::new_arm_state;
use super::catalog::{Mobility, axis, catalog};
use super::colliders::rebuild_colliders;
use super::physics::{BodyDesc, ColliderDesc, groups};
use super::brain::AiState;
use super::melee::MeleeArm;
use super::propulsion::add_thrusters;
use super::robot::{
    Block, Bot, COCKPIT_BATTERY, Cell, Input, NEIGHBORS, Part, Support, Surface, Turret, WHEEL_ANGULAR_DAMPING, Wheel, design_radius, half_width, link_key, part_damping,
    unported_weapon, unsupported,
    wheel_local_pos,
};
use super::vec::{Q, V3, add, axis_angle, cross, qrot, quat_from_basis, scale, v3};
use super::wheels::{WheelPose, place_wheel, wheel_collider};
use super::world::{Owner, Sim};
use super::catalog::Robot;
use super::events::code;
use super::robot::NO_PROFILE;
use std::collections::{HashMap, HashSet};

/// Part de ses points de structure que garde l'épave d'une roue arrachée, et sa durée sur le terrain (s).
const WHEEL_WRECK_HP: f64 = 0.6;
const WHEEL_WRECK_LIFE: f64 = 30.0;

/// Mouvement d'un morceau relevé avant d'y retirer des blocs (`PartMotion`).
#[derive(Clone, Copy)]
pub struct PartMotion {
    pub com: V3,
    pub linvel: V3,
    pub angvel: V3,
}

/// `capturePartMotion`.
pub fn capture_part_motion(sim: &Sim, p: usize) -> PartMotion {
    let rb = sim.part(p).rb;
    PartMotion { com: sim.phys.world_com(rb), linvel: sim.phys.linvel(rb), angvel: sim.phys.angvel(rb) }
}

/// Vitesse du point `p`, supposé solidaire du morceau relevé (`pointVelocity`).
pub fn point_velocity(m: &PartMotion, p: V3) -> V3 {
    add(m.linvel, cross(m.angvel, super::vec::sub(p, m.com)))
}

/// Capacité des batteries (kJ) : la batterie du cockpit et celles encore reliées au cockpit (`energyCapacity`).
pub fn energy_capacity(sim: &Sim, bot: usize) -> f64 {
    let b = &sim.bots[bot];
    if !b.cockpit_alive() {
        return 0.0;
    }
    let c = catalog();
    let mut capacity = COCKPIT_BATTERY;
    for &k in &sim.part(b.cockpit_part()).blocks {
        capacity += c.blocks[&b.blocks[k].kind].battery;
    }
    capacity
}

/// Crée un morceau vide (un corps) à la pose donnée (`makePart`) ; son numéro.
pub fn make_part(sim: &mut Sim, bot: usize, pos: V3, rot: Q) -> usize {
    let (linear, angular) = part_damping(sim.bots[bot].mobility);
    let rb = sim.phys.create_body(&BodyDesc { linear_damping: linear, angular_damping: angular, ..BodyDesc::dynamic(pos, rot) });
    let id = sim.next_id();
    let p = sim.parts.len();
    sim.parts.push(Some(Part { id, bot, rb, blocks: Vec::new(), colliders: Vec::new(), dirty: false, links: None, heads: Vec::new(), blades: Vec::new() }));
    sim.part_bots.push(bot);
    sim.bots[bot].parts.push(p);
    sim.order.push(p);
    sim.emit_part(code::PART_ADDED, id, bot);
    p
}

/// Retire un morceau vide ; ses roues sont arrachées (`removePart`).
pub fn remove_part(sim: &mut Sim, p: usize) {
    let bot = sim.part(p).bot;
    for w in 0..sim.bots[bot].wheels.len() {
        if sim.bots[bot].wheels[w].part == Some(p) {
            release_wheel(sim, bot, w);
        }
    }
    let part = sim.parts[p].take().expect("morceau retiré");
    for c in &part.colliders {
        sim.owners.remove(c);
    }
    sim.phys.remove_body(part.rb);
    sim.bots[bot].parts.retain(|&x| x != p);
    sim.order.retain(|&x| x != p);
    sim.emit_part(code::PART_REMOVED, part.id, bot);
}

/// Fixe un bloc sur un morceau (`attachBlock`) ; ses colliders seront refaits ensuite.
pub fn attach_block(sim: &mut Sim, bot: usize, block: usize, p: usize) {
    sim.bots[bot].blocks[block].part = p;
    let part = sim.part_mut(p);
    part.dirty = true;
    part.links = None;
    part.blocks.push(block);
    sim.emit_attached(bot, block);
}

/// Retire un bloc de son morceau (`detachBlock`) ; le bloc garde le numéro du morceau.
pub fn detach_block(sim: &mut Sim, bot: usize, block: usize) {
    let p = sim.bots[bot].blocks[block].part;
    let part = sim.part_mut(p);
    let Some(i) = part.blocks.iter().position(|&k| k == block) else { return };
    part.blocks.remove(i);
    part.dirty = true;
    part.links = None;
}

/// Monte une roue sur un morceau (`attachWheel`) : son collider à sa place de repos, sa masse
/// comptée tout de suite, sa pose.
pub fn attach_wheel(sim: &mut Sim, bot: usize, w: usize, p: usize) {
    let rb = sim.part(p).rb;
    let wheel = &sim.bots[bot].wheels[w];
    let desc = ColliderDesc { translation: wheel.local, collision_groups: groups::WHEEL, ..wheel_collider(&wheel.def, wheel.def.grip) };
    let collider = sim.phys.create_collider(&desc, rb).expect("collider de roue refusé");
    sim.owners.insert(collider, Owner::Wheel(bot, w));
    let wheel = &mut sim.bots[bot].wheels[w];
    wheel.collider = collider;
    wheel.part = Some(p);
    if wheel.hub.is_none() {
        wheel.hub = Some(WheelPose::default());
    }
    sim.phys.recompute_mass(rb);
    place_wheel(&sim.phys, rb, &mut sim.bots[bot].wheels[w]);
}

/// La roue quitte son morceau : son collider est retiré, la masse du morceau recalculée (`unmountWheel`).
fn unmount_wheel(sim: &mut Sim, bot: usize, w: usize) {
    let Some(p) = sim.bots[bot].wheels[w].part else { return };
    let collider = sim.bots[bot].wheels[w].collider;
    sim.owners.remove(&collider);
    sim.phys.remove_collider(collider, true);
    sim.phys.recompute_mass(sim.part(p).rb);
    sim.bots[bot].wheels[w].part = None;
}

/// Rattache une roue à un autre morceau, après une séparation (`moveWheel`).
fn move_wheel(sim: &mut Sim, bot: usize, w: usize, p: usize) {
    unmount_wheel(sim, bot, w);
    attach_wheel(sim, bot, w, p);
}

/// Arrache une roue (`releaseWheel`) : son collider quitte le morceau, et elle devient un corps
/// libre, à sa pose et à sa vitesse.
pub fn release_wheel(sim: &mut Sim, bot: usize, w: usize) {
    if sim.bots[bot].wheels[w].part.is_none() {
        return;
    }
    unmount_wheel(sim, bot, w);
    let wheel = &sim.bots[bot].wheels[w];
    let pose = wheel.rb;
    let body = sim.phys.create_body(&BodyDesc {
        linvel: pose.vel,
        angvel: pose.ang,
        angular_damping: WHEEL_ANGULAR_DAMPING,
        ..BodyDesc::dynamic(pose.pos, pose.rot)
    });
    let desc = ColliderDesc { collision_groups: groups::ROBOT_GROUP, ..wheel_collider(&wheel.def, wheel.def.grip) };
    let collider = sim.phys.create_collider(&desc, body).expect("collider de roue refusé");
    sim.owners.insert(collider, Owner::Wheel(bot, w));
    let time = sim.time;
    let wheel = &mut sim.bots[bot].wheels[w];
    wheel.body = Some(body);
    wheel.hub = None;
    wheel.collider = collider;
    wheel.powered = false;
    wheel.engaged = false;
    wheel.load = 0.0;
    wheel.hp = wheel.def.hp * WHEEL_WRECK_HP;
    wheel.released_at = time;
    sim.stats.wheels_released += 1;
}

/// Retire l'épave d'une roue arrachée (`discardWheel`) : son corps disparaît, elle garde une pose
/// figée ; `broken` : elle a cédé (un éclat, compté comme un choc).
pub fn discard_wheel(sim: &mut Sim, bot: usize, w: usize, broken: bool) {
    let Some(body) = sim.bots[bot].wheels[w].body else { return };
    let (at, rot) = (sim.phys.translation(body), sim.phys.rotation(body));
    let collider = sim.bots[bot].wheels[w].collider;
    sim.owners.remove(&collider);
    sim.phys.remove_body(body);
    let wheel = &mut sim.bots[bot].wheels[w];
    wheel.body = None;
    wheel.frozen = true;
    let still = v3(0.0, 0.0, 0.0);
    wheel.rb = WheelPose { pos: at, rot, vel: still, ang: still };
    sim.stats.wheels_removed += 1;
    let id = sim.bots[bot].wheels[w].id;
    sim.emit(code::WHEEL_REMOVED, |s, wr| {
        wr.id(Some(id)).id(Some(s.bots[bot].id));
    });
    if broken {
        sim.stats.collisions += 1;
        sim.emit_point(code::COLLISION, at, Some(WHEEL_BREAK_STRENGTH));
    }
}

/// Force de l'éclat d'une épave qui cède (`WHEEL_BREAK_STRENGTH` : pour son effet et son bruit de choc).
const WHEEL_BREAK_STRENGTH: f64 = 40.0;

/// Les épaves de roues qui ont fait leur temps disparaissent (`expireWheelWrecks`).
pub fn expire_wheel_wrecks(sim: &mut Sim) {
    for b in sim.roster.clone() {
        for w in 0..sim.bots[b].wheels.len() {
            let wheel = &sim.bots[b].wheels[w];
            if wheel.body.is_some() && sim.time - wheel.released_at > WHEEL_WRECK_LIFE {
                discard_wheel(sim, b, w, false);
            }
        }
    }
}

/// Après une destruction de blocs ou la rupture d'une liaison, découpe le morceau en composantes
/// connexes (voisinage 6, sans passer par les liaisons rompues) (`splitPart`). La composante du
/// cockpit garde le corps (sinon la plus grosse) ; chaque autre devient un nouveau corps à la même
/// pose, lancé à la vitesse qu'avait le morceau d'origine au centre de masse de la composante.
pub fn split_part(sim: &mut Sim, p: usize, before: &PartMotion) {
    let bot = sim.part(p).bot;
    if sim.part(p).blocks.is_empty() {
        remove_part(sim, p);
        return;
    }
    let blocks = sim.part(p).blocks.clone();
    let mut remaining: HashSet<usize> = blocks.iter().copied().collect();
    let mut comps: Vec<Vec<usize>> = Vec::new();
    {
        let b = &sim.bots[bot];
        for &start in &blocks {
            if !remaining.remove(&start) {
                continue;
            }
            let mut comp = vec![start];
            let mut i = 0;
            while i < comp.len() {
                let here = b.blocks[comp[i]].cell();
                for (dx, dy, dz) in NEIGHBORS {
                    let cell: Cell = (here.0 + dx, here.1 + dy, here.2 + dz);
                    if let Some(&n) = b.cells.get(&cell)
                        && !b.cuts.contains(&link_key(here, cell))
                        && remaining.remove(&n)
                    {
                        comp.push(n);
                    }
                }
                i += 1;
            }
            comps.push(comp);
        }
    }
    if comps.len() == 1 {
        return;
    }
    let ck = sim.bots[bot].cockpit;
    let ck_alive = sim.bots[bot].cockpit_alive();
    let keep = match comps.iter().position(|c| ck_alive && c.contains(&ck)) {
        Some(i) => i,
        None => {
            // (`reduce` : la première des plus grosses)
            let mut best = 0;
            for (i, c) in comps.iter().enumerate() {
                if c.len() > comps[best].len() {
                    best = i;
                }
            }
            best
        }
    };
    let rb = sim.part(p).rb;
    let (t, r) = (sim.phys.translation(rb), sim.phys.rotation(rb));
    let c = catalog();
    for (i, comp) in comps.iter().enumerate() {
        if i == keep {
            continue;
        }
        let np = make_part(sim, bot, t, r);
        let mut weighted = v3(0.0, 0.0, 0.0);
        let mut mass = 0.0;
        for &k in comp {
            detach_block(sim, bot, k);
            attach_block(sim, bot, k, np);
            let b = &sim.bots[bot].blocks[k];
            let m = c.blocks[&b.kind].mass;
            weighted = add(weighted, scale(b.local, m));
            mass += m;
        }
        let com_world = add(t, qrot(r, scale(weighted, 1.0 / mass)));
        let nrb = sim.part(np).rb;
        sim.phys.set_linvel(nrb, point_velocity(before, com_world), true);
        sim.phys.set_angvel(nrb, before.angvel, true);
    }
}

/// Une roue suit le morceau de son bloc support, et tombe si ce bloc est détruit (`refreshWheels`).
pub fn refresh_wheels(sim: &mut Sim, bot: usize) {
    for w in 0..sim.bots[bot].wheels.len() {
        let Some(wp) = sim.bots[bot].wheels[w].part else { continue };
        let b = &sim.bots[bot];
        match b.cells.get(&b.wheels[w].mount) {
            None => release_wheel(sim, bot, w),
            Some(&k) => {
                let sp = b.blocks[k].part;
                if sp != wp {
                    move_wheel(sim, bot, w, sp);
                }
            }
        }
    }
}

/// Construit un robot d'un seul morceau à la position `pos`, tourné de `yaw` autour de la verticale
/// (`spawnBot`), dans l'équipe `team`, aux commandes d'un pilote (`takeControl`) ou de l'IA ; son
/// numéro. Le plan est supposé valide (`validateDesign` : les robots du catalogue le sont). Chaque
/// tourelle tire au hasard sa cadence de départ (`registerOrgans`), pour que les tourelles ne tirent
/// pas toutes ensemble. Au combat, un robot de l'IA dont une arme n'est pas encore maniée est refusé.
pub fn spawn_bot(sim: &mut Sim, id: &str, pos: V3, yaw: f64, team: usize, piloted: bool) -> Result<usize, String> {
    let robot = catalog().robots.get(id).ok_or_else(|| format!("robot inconnu : {id}"))?;
    spawn_robot(sim, robot, NO_PROFILE, id, pos, yaw, team, piloted)
}

/// `spawnBot` d'un robot (`robot` : son plan et sa conduite ; `profile`, le rang de son profil dans
/// `Sim.profiles` ; `id`, son nom pour les messages).
#[allow(clippy::too_many_arguments)]
pub fn spawn_robot(sim: &mut Sim, robot: &Robot, profile: usize, id: &str, pos: V3, yaw: f64, team: usize, piloted: bool) -> Result<usize, String> {
    let c = catalog();
    for b in &robot.design.blocks {
        if !c.blocks.contains_key(&b.kind) {
            return Err(format!("bloc inconnu : {}", b.kind));
        }
    }
    for w in &robot.design.wheels {
        if !c.wheels.contains_key(&w.kind) {
            return Err(format!("roue inconnue : {}", w.kind));
        }
    }
    if let Some(what) = unsupported(c, robot) {
        return Err(format!("{id} : pas encore porté ({what})"));
    }
    // (au combat, l'IA se sert de ses armes : celles qu'elle ne sait pas encore manier ne sont pas portées)
    if sim.combat
        && !piloted
        && let Some(what) = unported_weapon(c, robot)
    {
        return Err(format!("{id} : pas encore porté ({what})"));
    }
    let bs = c.constants.block_size;

    // (le numéro du robot : `sim.nextId()` ; l'altitude que vise en vol l'état de son IA,
    // `createAiState`, tirée au hasard avant le reste du robot)
    let bot_id = sim.next_id();
    let alt = match robot.mobility {
        Mobility::Hover => sim.rng.rand(4.5, 6.5),
        Mobility::Plane => sim.rng.rand(10.0, 14.0),
        Mobility::Ground => 0.0,
    };
    let bot = sim.bots.len();
    sim.bots.push(Bot {
        id: bot_id,
        profile,
        input_slot: None,
        cut_order: Vec::new(),
        speed: robot.speed,
        turn: robot.turn,
        mobility: robot.mobility,
        blocks: Vec::new(),
        cells: HashMap::new(),
        live: Vec::new(),
        cockpit: 0,
        parts: Vec::new(),
        wheels: Vec::new(),
        thrusters: Vec::new(),
        supports: Vec::new(),
        surfaces: Vec::new(),
        melee: Vec::new(),
        turrets: Vec::new(),
        next_shot: Vec::new(),
        top: robot.design.blocks.iter().fold(0.0, |m, b| crate::jsmath::max(m, b.y)) * bs,
        last_attacker: None,
        vulnerability: None,
        flare_launchers: Vec::new(),
        flares: Default::default(),
        shields: Vec::new(),
        cuts: HashSet::new(),
        total: robot.design.blocks.len(),
        input: Input::default(),
        energy: 0.0,
        drawn: 0.0,
        flipped_for: 0.0,
        righting: 0.0,
        last_hit: f64::NEG_INFINITY,
        rebuild_at: 0.0,
        lost_order: Vec::new(),
        stunned_until: 0.0,
        thrown_by: None,
        trigger_held: false,
        team,
        radius: design_radius(&robot.design),
        half_width: half_width(&robot.design, design_radius(&robot.design)),
        nav: Default::default(),
        charges: robot.charges,
        last_pos: pos,
        piloted,
        ai: AiState::new(pos, alt),
    });

    sim.emit(code::BOT_ADDED, |s, w| {
        w.id(Some(bot_id)).num(s.time).num(profile as f64);
    });

    // Le morceau (`makePart`)
    let main = make_part(sim, bot, pos, axis_angle(v3(0.0, 1.0, 0.0), yaw));

    // Les blocs (`newBlock`, `attachBlock`, `registerOrgans`)
    let mut cockpit = None;
    for spec in &robot.design.blocks {
        let up = axis(&spec.up).ok_or("axe inconnu")?;
        let forward = axis(&spec.forward).ok_or("axe inconnu")?;
        let up = v3(up[0], up[1], up[2]);
        let forward = v3(forward[0], forward[1], forward[2]);
        let def = &c.blocks[&spec.kind];
        let id = sim.next_id();
        let b = &mut sim.bots[bot];
        let index = b.blocks.len();
        b.blocks.push(Block {
            id,
            kind: spec.kind.clone(),
            x: spec.x,
            y: spec.y,
            z: spec.z,
            local: v3(spec.x * bs, spec.y * bs, spec.z * bs),
            up,
            forward,
            rot: quat_from_basis(cross(up, forward), up, forward),
            hp: def.hp,
            alive: true,
            part: main,
            burn: 0.0,
            stunned_until: 0.0,
        });
        let cell = b.blocks[index].cell();
        b.cells.insert(cell, index);
        b.live.push(index);
        if spec.kind == "cockpit" {
            cockpit = Some(index);
        }
        attach_block(sim, bot, index, main);
        // Ses organes (`registerOrgans`), dans l'ordre : arme de contact, surface portante, appui,
        // bouclier, leurres, tourelle
        if let Some(m) = &def.melee {
            let weapon = c.melee.get_key_value(m).map(|(k, _)| k.as_str()).ok_or("arme de contact inconnue")?;
            sim.bots[bot].melee.push(MeleeArm::new(index, weapon));
        }
        if def.aero.is_some() {
            sim.bots[bot].surfaces.push(Surface { block: index, deflection: 0.0 });
        }
        if def.support.is_some() {
            sim.bots[bot].supports.push(Support { block: index, contact: f64::INFINITY, force: 0.0, phase: 0.0 });
        }
        if def.shield.is_some() {
            sim.bots[bot].shields.push(index);
        }
        if let Some((charges, _)) = def.flares {
            // (il apparaît chargé)
            sim.bots[bot].flare_launchers.push(index);
            sim.bots[bot].flares.charges += charges;
        }
        if let Some(spec) = &def.turret {
            // Pour que les tourelles ne tirent pas toutes ensemble (`arm.cooldown = rand(0, cooldown)`)
            let weapon = &c.weapons[&spec.weapon];
            let mut arm = new_arm_state(weapon);
            arm.cooldown = sim.rng.rand(0.0, weapon.cooldown);
            sim.bots[bot].turrets.push(Turret {
                block: index,
                weapon: spec.weapon.as_str(),
                yaw: 0.0,
                pitch: 0.0,
                arm,
                target: None,
                retarget: 0.0,
                aim: None,
                wobble: v3(0.0, 0.0, 0.0),
                fired_at: f64::NEG_INFINITY,
                lock_on: None,
                lock_time: 0.0,
                lock_hidden: 0.0,
                repair_aim: None,
                patient_at: f64::NEG_INFINITY,
            });
        }
    }
    sim.bots[bot].cockpit = cockpit.ok_or("plan sans cockpit")?;
    rebuild_colliders(sim, main);
    add_thrusters(sim, bot, &robot.design);
    sim.bots[bot].energy = energy_capacity(sim, bot);

    // Les roues (`createWheel`, `attachWheel`)
    for m in &robot.design.wheels {
        let def = c.wheels[&m.kind].clone();
        let local = wheel_local_pos(m, &def, bs);
        let hp = def.hp;
        let wheel_id = sim.next_id();
        sim.bots[bot].wheels.push(Wheel {
            id: wheel_id,
            steerable: def.steering.is_some(),
            side: if local.x.abs() < 0.1 { 0.0 } else { crate::jsmath::sign(local.x) },
            local,
            mount: (m.x as i64, m.y as i64, m.z as i64),
            // (posé par attach_wheel, aussitôt)
            collider: rapier3d::prelude::ColliderHandle::invalid(),
            part: None,
            body: None,
            frozen: false,
            hp,
            released_at: 0.0,
            def,
            steer: 0.0,
            drive: 0.0,
            powered: false,
            engaged: false,
            overrun: false,
            brake: 0.0,
            travel: 0.0,
            spin: 0.0,
            spin_rate: 0.0,
            load: 0.0,
            rb: WheelPose::default(),
            hub: Some(WheelPose::default()),
            stunned_until: 0.0,
        });
        let w = sim.bots[bot].wheels.len() - 1;
        sim.emit(code::WHEEL_ADDED, |_, wr| {
            wr.id(Some(wheel_id)).id(Some(bot_id));
        });
        attach_wheel(sim, bot, w, main);
    }
    Ok(bot)
}
