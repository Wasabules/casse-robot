//! Les dégâts (src/shared/combat/damage.ts) : un lot de dégâts par cible, après résistance (une
//! cible visée deux fois garde le plus fort), et les liaisons que les chocs ont rompues ; puis son
//! effet : roues arrachées, blocs détruits (débris), liaisons coupées, morceaux séparés, colliders
//! refaits, robots hors de combat (la règle de structure : `WRECK_INTEGRITY`).
//!
//! Les dégâts infligés : ceux des chocs (collisions.rs), du feu et des flaques de feu (fire.rs), des
//! explosions (explosion.rs, qui appelle `resolve_damage` directement, comme le TypeScript) et des
//! projectiles (`strike` : un coup direct, et son impulsion). Chaque lot dit qui l'inflige (le dernier
//! attaquant ennemi d'un robot sera crédité de sa destruction) et si une arme en est la cause. Un
//! accessoire qui cède s'allume, fuit, bascule ou se brise (props.rs, `damage_prop`) ; une batterie
//! détruite met le feu à ses voisins ; un bloc détruit est perdu (`Bot::lost`) jusqu'à ce qu'une
//! réparation le fasse repousser (repair.rs), et un robot touché le note (`last_hit`) ; son IA réagit
//! au coup, s'il vient de quelque part (brain.rs, `onHit`).

use super::brain::react;
use super::catalog::catalog;
use super::colliders::rebuild_dirty_parts;
use super::debris::{block_world_pos, spawn_debris};
use super::fire::{BURN_TIME, ignite};
use super::lifecycle::{PartMotion, capture_part_motion, detach_block, discard_wheel, point_velocity, refresh_wheels, release_wheel, split_part};
use super::props::{damage_prop, prop};
use super::robot::WeakLink;
use super::structure::{linked_neighbors, stress_links};
use super::vec::{V3, add, qrot, scale};
use super::events::code;
use super::world::Sim;
use rapier3d::prelude::RigidBodyHandle;

/// Part des blocs de départ que le morceau du cockpit doit garder (`WRECK_INTEGRITY`).
const WRECK_INTEGRITY: f64 = 0.25;
/// Un moteur sous cette part de ses points de structure, touché, prend feu avec cette probabilité.
const ENGINE_FIRE_BELOW: f64 = 0.25;
const ENGINE_FIRE_CHANCE: f64 = 0.2;

/// Ce que vise un coup (`HitTarget`) : un bloc ou une roue d'un robot, un accessoire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Block(usize, usize),
    Wheel(usize, usize),
    Prop(usize),
}

/// Dégâts à infliger en une fois (`DamageBatch`), dans l'ordre où les cibles y sont entrées (une
/// `Map` du TypeScript) ; le robot à l'origine des dégâts (`attacker` : crédité d'une destruction),
/// et si leur cause est une arme (`cause`, `isArmId` : chaque robot touché reçoit alors un retour de
/// tir, l'événement `hit`).
#[derive(Default)]
pub struct DamageBatch {
    pub blocks: Vec<((usize, usize), f64)>,
    pub wheels: Vec<((usize, usize), f64)>,
    pub props: Vec<(usize, f64)>,
    pub cuts: Vec<(usize, Vec<WeakLink>)>,
    pub attacker: Option<usize>,
    pub armed: bool,
    /// Sa cause (`cause`, `KillCause` : une arme de tourelle ou de contact, « impact », « fire »,
    /// « blast », « self », « lava », « drown », « exhaust ») : dite par les événements `hit` et `botKilled`.
    pub cause: Option<&'static str>,
    /// Sa cause est le feu ou le jet de flamme d'un moteur (`cause` « fire », « exhaust ») : un moteur à
    /// bout qu'il touche ne prend pas feu pour autant.
    pub fiery: bool,
}

/// `keepMax` : une cible déjà là garde le plus fort, une nouvelle n'entre que pour plus que rien.
fn keep_max(list: &mut Vec<((usize, usize), f64)>, key: (usize, usize), amount: f64) {
    match list.iter_mut().find(|e| e.0 == key) {
        Some(e) => {
            if amount > e.1 {
                e.1 = amount;
            }
        }
        None => {
            if amount > 0.0 {
                list.push((key, amount));
            }
        }
    }
}

impl DamageBatch {
    /// `amount` dégâts de nature `kind` sur `target`, multipliés par sa résistance (`add`).
    pub fn add(&mut self, sim: &Sim, target: Option<Target>, amount: f64, kind: &str) {
        let Some(target) = target else { return };
        if amount <= 0.0 {
            return;
        }
        match target {
            Target::Block(bot, b) => {
                let dealt = amount * catalog().blocks[&sim.bots[bot].blocks[b].kind].resistance(kind);
                keep_max(&mut self.blocks, (bot, b), dealt);
            }
            // (les roues n'ont pas de résistances)
            Target::Wheel(bot, w) => keep_max(&mut self.wheels, (bot, w), amount),
            Target::Prop(i) => {
                let dealt = amount * prop(sim, i).def().resistance(kind);
                match self.props.iter_mut().find(|e| e.0 == i) {
                    Some(e) => {
                        if dealt > e.1 {
                            e.1 = dealt;
                        }
                    }
                    None => {
                        if dealt > 0.0 {
                            self.props.push((i, dealt));
                        }
                    }
                }
            }
        }
    }

    /// Choc (impulsion en N·s, monde) reçu en `point` par un morceau : ses liaisons faibles trop
    /// sollicitées rompront (`shock`).
    pub fn shock(&mut self, sim: &mut Sim, part: usize, point: V3, impulse: V3, hit: Option<usize>) {
        let broken = stress_links(sim, part, point, impulse, hit);
        if broken.is_empty() {
            return;
        }
        match self.cuts.iter_mut().find(|c| c.0 == part) {
            Some(c) => c.1.extend(broken),
            None => self.cuts.push((part, broken)),
        }
    }
}

/// Dégâts reçus par un bloc une fois le bouclier passé (`shieldDamage`) : la part absorbée est payée
/// sur les batteries du robot.
fn shield_damage(sim: &mut Sim, bot: usize, block: usize, amount: f64, flashed: &mut Vec<usize>) -> f64 {
    let c = catalog();
    let b = &sim.bots[bot];
    if b.shields.is_empty() || amount <= 0.0 || b.energy <= 0.0 || !b.cockpit_alive() {
        return amount;
    }
    let mut generator = None;
    let mut nearest = f64::INFINITY;
    for &g in &b.shields {
        let gb = &b.blocks[g];
        // (un générateur paralysé localement n'absorbe rien)
        if !gb.alive || gb.part != b.cockpit_part() || gb.stunned_until > sim.time {
            continue;
        }
        let (gl, bl) = (gb.local, b.blocks[block].local);
        let d = crate::jsmath::hypot3(gl.x - bl.x, gl.y - bl.y, gl.z - bl.z);
        if d <= c.blocks[&gb.kind].shield.map_or(0.0, |s| s.radius) && d < nearest {
            nearest = d;
            generator = Some(g);
        }
    }
    let Some(g) = generator else { return amount };
    let spec = c.blocks[&b.blocks[g].kind].shield.expect("générateur sans bouclier");
    let absorbed = crate::jsmath::min(amount * spec.absorb, b.energy / spec.cost);
    sim.bots[bot].energy -= absorbed * spec.cost;
    // (un `Set` : l'éclat de chaque générateur qui a absorbé quelque chose, une fois)
    if !flashed.contains(&g) {
        flashed.push(g);
    }
    amount - absorbed
}

fn push_unique(list: &mut Vec<usize>, x: usize) {
    if !list.contains(&x) {
        list.push(x);
    }
}

/// Inflige un lot de dégâts (`resolveDamage`) ; les robots touchés, dans l'ordre où ils l'ont été.
pub fn resolve_damage(sim: &mut Sim, batch: &DamageBatch, dir: V3) -> Vec<usize> {
    let mut hit_bots: Vec<usize> = Vec::new();

    // Une roue montée à 0 est arrachée ; l'épave d'une roue arrachée à 0 cède (retirée à la fin du lot)
    let mut broken_wheels = Vec::new();
    for &((bot, w), amount) in &batch.wheels {
        let wheel = &mut sim.bots[bot].wheels[w];
        if wheel.part.is_some() {
            wheel.hp -= amount;
            push_unique(&mut hit_bots, bot);
            if sim.bots[bot].wheels[w].hp <= 0.0 {
                release_wheel(sim, bot, w);
            }
        } else if wheel.body.is_some() {
            wheel.hp -= amount;
            if wheel.hp <= 0.0 {
                broken_wheels.push((bot, w));
            }
        }
    }

    let mut doomed: Vec<(usize, usize)> = Vec::new();
    // (les générateurs de bouclier qui ont absorbé : un `Set` par robot du TypeScript, ici (robot, bloc))
    let mut flashed: Vec<(usize, usize)> = Vec::new();
    for &((bot, b), dealt) in &batch.blocks {
        if !sim.bots[bot].blocks[b].alive {
            continue;
        }
        let mut lit = Vec::new();
        let amount = shield_damage(sim, bot, b, dealt, &mut lit);
        for g in lit {
            if !flashed.contains(&(bot, g)) {
                flashed.push((bot, g));
            }
        }
        let block = &mut sim.bots[bot].blocks[b];
        block.hp -= amount;
        push_unique(&mut hit_bots, bot);
        if block.hp <= 0.0 {
            doomed.push((bot, b));
        } else {
            sim.emit_block(code::BLOCK_DAMAGED, bot, b);
        }
    }
    for (bot, g) in flashed {
        sim.emit_block(code::SHIELD_HIT, bot, g);
    }

    // Une batterie détruite met le feu à ses voisins
    let c = catalog();
    let mut kindled: Vec<(usize, usize)> = doomed
        .iter()
        .filter(|&&(bot, b)| c.blocks[&sim.bots[bot].blocks[b].kind].battery > 0.0)
        .flat_map(|&(bot, b)| linked_neighbors(&sim.bots[bot], b).into_iter().map(move |n| (bot, n)))
        .collect();
    // Un moteur à bout, touché encore, peut prendre feu (pas par le feu ni par un jet de flamme : il
    // brûlerait sans fin, et un jet a sa propre chance d'allumer ce qu'il chauffe, scorch.rs)
    if !batch.fiery {
        for &((bot, b), _) in &batch.blocks {
            let k = &sim.bots[bot].blocks[b];
            let def = &c.blocks[&k.kind];
            if def.thruster.is_some() && k.alive && !doomed.contains(&(bot, b)) && k.hp < def.hp * ENGINE_FIRE_BELOW && sim.rng.rand(0.0, 1.0) < ENGINE_FIRE_CHANCE {
                kindled.push((bot, b));
            }
        }
    }

    if !doomed.is_empty() || !batch.cuts.is_empty() {
        // On relève le mouvement des morceaux avant de toucher à leurs colliders
        let mut motions: Vec<(usize, PartMotion)> = Vec::new();
        for &(bot, b) in &doomed {
            let p = sim.bots[bot].blocks[b].part;
            if !motions.iter().any(|m| m.0 == p) {
                motions.push((p, capture_part_motion(sim, p)));
            }
        }
        for (p, _) in &batch.cuts {
            if !motions.iter().any(|m| m.0 == *p) {
                motions.push((*p, capture_part_motion(sim, *p)));
            }
        }
        for &(bot, b) in &doomed {
            let p = sim.bots[bot].blocks[b].part;
            let before = motions.iter().find(|m| m.0 == p).expect("mouvement relevé").1;
            let vel = point_velocity(&before, block_world_pos(sim, bot, b));
            spawn_debris(sim, bot, b, vel, dir);
            detach_block(sim, bot, b);
            let cell = sim.bots[bot].blocks[b].cell();
            sim.bots[bot].blocks[b].alive = false;
            sim.bots[bot].cells.remove(&cell);
            // (perdu, s'il n'est pas le cockpit : une réparation pourra le faire repousser, repair.rs)
            sim.bots[bot].live.retain(|&k| k != b);
            if sim.bots[bot].blocks[b].kind != "cockpit" {
                sim.bots[bot].lost_order.push(b);
            }
            sim.stats.destroyed += 1;
            sim.emit_block(code::BLOCK_DESTROYED, bot, b);
        }
        for (p, links) in &batch.cuts {
            let bot = sim.part(*p).bot;
            for link in links {
                let b = &sim.bots[bot];
                if !b.blocks[link.inner].alive || !b.blocks[link.outer].alive || b.cuts.contains(&link.key) {
                    continue;
                }
                sim.bots[bot].cuts.insert(link.key);
                sim.bots[bot].cut_order.push(link.key);
                sim.part_mut(*p).links = None;
                push_unique(&mut hit_bots, bot);
                sim.stats.links_broken += 1;
                let rb = sim.part(*p).rb;
                let at = add(sim.phys.translation(rb), qrot(sim.phys.rotation(rb), link.joint));
                sim.emit_point(code::LINK_BROKEN, at, None);
            }
        }
        for (p, before) in &motions {
            let bot = sim.parts[*p].as_ref().map(|part| part.bot);
            if let Some(bot) = bot
                && sim.bots[bot].parts.contains(p)
            {
                split_part(sim, *p, before);
            }
        }
        for &bot in &hit_bots {
            refresh_wheels(sim, bot);
            rebuild_dirty_parts(sim, bot);
        }
    }

    for &(bot, b) in &kindled {
        if sim.bots[bot].blocks[b].alive {
            ignite(sim, bot, b, BURN_TIME);
        }
    }
    // (le dernier coup reçu : les modules de réparation attendent un moment sans coup ; le dernier
    // attaquant ennemi sera crédité de la destruction)
    for &bot in &hit_bots {
        sim.bots[bot].last_hit = sim.time;
        if let Some(a) = batch.attacker
            && sim.bots[a].team != sim.bots[bot].team
        {
            sim.bots[bot].last_attacker = Some(a);
        }
    }
    // Retour de tir : chaque robot touché par une arme (pas le feu, les chocs ni les barils)
    if batch.armed {
        sim.stats.hits += hit_bots.len() as u32;
        for &bot in &hit_bots {
            let destroyed = doomed.iter().filter(|d| d.0 == bot).count();
            sim.emit(code::HIT, |s, w| {
                w.id(Some(s.bots[bot].id)).id(s.bot_id_of(batch.attacker)).maybe(batch.cause).num(destroyed as f64);
            });
        }
    }
    // Cockpits détruits : ces robots sont hors de combat
    for &(bot, b) in &doomed {
        if b == sim.bots[bot].cockpit {
            sim.stats.killed += 1;
            // (et, pour qui compte les destructions de chaque joueur : les équipes, les commandes du tueur)
            sim.emit(code::BOT_KILLED, |s, w| {
                let killer = s.bots[bot].last_attacker;
                w.id(Some(s.bots[bot].id)).id(s.bot_id_of(killer)).maybe(batch.cause).num(s.time);
                w.num(s.bots[bot].team as f64).num(killer.map_or(-1.0, |k| s.bots[k].team as f64));
                w.num(killer.and_then(|k| s.bots[k].input_slot).map_or(-1.0, |i| i as f64));
            });
            super::game::on_bot_killed(sim, bot);
        }
    }
    // Un robot dont le cockpit ne tient plus qu'une petite part de la structure est hors de combat
    let wrecked: Vec<usize> = hit_bots
        .iter()
        .copied()
        .filter(|&bot| {
            let b = &sim.bots[bot];
            b.cockpit_alive() && (sim.part(b.cockpit_part()).blocks.len() as f64 / b.total as f64) < WRECK_INTEGRITY
        })
        .collect();
    if !wrecked.is_empty() {
        let mut finish = DamageBatch { attacker: batch.attacker, armed: batch.armed, fiery: batch.fiery, cause: batch.cause, ..DamageBatch::default() };
        for &bot in &wrecked {
            finish.blocks.push(((bot, sim.bots[bot].cockpit), f64::INFINITY));
        }
        for bot in resolve_damage(sim, &finish, dir) {
            push_unique(&mut hit_bots, bot);
        }
    }
    for &(i, amount) in &batch.props {
        damage_prop(sim, i, amount, dir);
    }
    for (bot, w) in broken_wheels {
        discard_wheel(sim, bot, w, true);
    }
    hit_bots
}

/// Inflige un lot de dégâts préparé ailleurs (`inflict` : chocs, feu) : `dir`, la direction du coup
/// (les débris partent de ce côté) ; `source`, d'où il vient, pour la réaction de l'IA (rien : pas
/// de réaction, comme pour le feu ou un choc contre un mur).
pub fn inflict(sim: &mut Sim, batch: &DamageBatch, dir: V3, source: Option<V3>) -> Vec<usize> {
    let hit = resolve_damage(sim, batch, dir);
    react(sim, &hit, source);
    sim.stats.damage += 1;
    hit
}

/// La cause est-elle une arme, de tourelle ou de contact (`isArmId`) ?
pub fn is_arm(cause: Option<&str>) -> bool {
    let c = catalog();
    cause.is_some_and(|id| c.weapons.contains_key(id) || c.melee.contains_key(id))
}

/// Facteur des dégâts de nature `kind` sur une cible (`resistance` ; les roues n'en ont pas).
pub fn resistance(sim: &Sim, target: Target, kind: &str) -> f64 {
    match target {
        Target::Block(bot, b) => catalog().blocks[&sim.bots[bot].blocks[b].kind].resistance(kind),
        Target::Prop(i) => prop(sim, i).def().resistance(kind),
        Target::Wheel(..) => 1.0,
    }
}

/// Points de structure qui restent à la cible (`remainingHp`) : un bloc vivant, une roue montée ou
/// l'épave d'une roue arrachée, un accessoire.
fn remaining_hp(sim: &Sim, target: Option<Target>) -> f64 {
    match target {
        None => 0.0,
        Some(Target::Block(bot, b)) => {
            let k = &sim.bots[bot].blocks[b];
            if k.alive { k.hp } else { 0.0 }
        }
        Some(Target::Wheel(bot, w)) => {
            let wheel = &sim.bots[bot].wheels[w];
            if wheel.part.is_some() || wheel.body.is_some() { wheel.hp } else { 0.0 }
        }
        Some(Target::Prop(i)) => crate::jsmath::max(0.0, prop(sim, i).hp),
    }
}

/// Le corps qui encaisse le choc d'un coup sur la cible (`bodyOf`) : celui du morceau d'un bloc
/// vivant, d'une roue arrachée (ou du morceau qui porte une roue montée), d'un accessoire.
fn body_of(sim: &Sim, target: Option<Target>) -> Option<RigidBodyHandle> {
    match target? {
        Target::Block(bot, b) => {
            let k = &sim.bots[bot].blocks[b];
            k.alive.then(|| sim.part(k.part).rb)
        }
        Target::Wheel(bot, w) => {
            let wheel = &sim.bots[bot].wheels[w];
            wheel.body.or_else(|| wheel.part.map(|p| sim.part(p).rb))
        }
        Target::Prop(i) => Some(prop(sim, i).rb),
    }
}

/// Impact direct d'un projectile (`strike`) : `amount` dégâts de nature `kind` sur `target`, et une
/// impulsion `impulse` (N·s) le long de `dir` au point d'impact, qui éprouve aussi les liaisons du
/// morceau touché ; `shooter`, d'où vient le tir (l'IA touchée réagit), `attacker` le robot qui tire,
/// `cause`, sa cause (une arme : chaque robot touché reçoit un retour de tir). Les dégâts bruts que la
/// cible a absorbés (avant résistance) et si elle a cédé, pour la perforation.
#[allow(clippy::too_many_arguments)]
pub fn strike(
    sim: &mut Sim, target: Option<Target>, amount: f64, kind: &str, point: V3, dir: V3, impulse: f64, shooter: V3, attacker: Option<usize>, cause: Option<&'static str>,
) -> (f64, bool) {
    let before = remaining_hp(sim, target);
    if let Some(body) = body_of(sim, target)
        && impulse != 0.0
    {
        sim.phys.apply_impulse_at_point(body, scale(dir, impulse), point, true);
    }
    let Some(t) = target else { return (0.0, false) };
    if before <= 0.0 {
        return (0.0, false);
    }
    let mut batch = DamageBatch { attacker, armed: is_arm(cause), cause, ..DamageBatch::default() };
    batch.add(sim, target, amount, kind);
    if impulse != 0.0
        && let Target::Block(bot, b) = t
    {
        let part = sim.bots[bot].blocks[b].part;
        batch.shock(sim, part, point, scale(dir, impulse), Some(b));
    }
    inflict(sim, &batch, dir, Some(shooter));
    let factor = resistance(sim, t, kind);
    (crate::jsmath::min(amount, before / factor), amount * factor >= before)
}
