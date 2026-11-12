//! Les dégâts (src/shared/combat/damage.ts) : un lot de dégâts par cible, après résistance (une
//! cible visée deux fois garde le plus fort), et les liaisons que les chocs ont rompues ; puis son
//! effet : roues arrachées, blocs détruits (débris), liaisons coupées, morceaux séparés, colliders
//! refaits, robots hors de combat (la règle de structure : `WRECK_INTEGRITY`).
//!
//! Les dégâts infligés : ceux des chocs (collisions.rs), du feu (fire.rs) et des explosions
//! (explosion.rs, qui appelle `resolve_damage` directement, comme le TypeScript). Un accessoire qui
//! cède s'allume, fuit, bascule ou se brise (props.rs, `damage_prop`) ; une batterie détruite met le
//! feu à ses voisins. Les tirs ne sont pas encore portés.

use super::catalog::catalog;
use super::colliders::rebuild_dirty_parts;
use super::debris::{block_world_pos, spawn_debris};
use super::fire::{BURN_TIME, ignite};
use super::lifecycle::{PartMotion, capture_part_motion, detach_block, discard_wheel, point_velocity, refresh_wheels, release_wheel, split_part};
use super::props::{damage_prop, prop};
use super::robot::WeakLink;
use super::structure::{linked_neighbors, stress_links};
use super::vec::V3;
use super::world::Sim;

/// Part des blocs de départ que le morceau du cockpit doit garder (`WRECK_INTEGRITY`).
const WRECK_INTEGRITY: f64 = 0.25;

/// Ce que vise un coup (`HitTarget`) : un bloc ou une roue d'un robot, un accessoire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Block(usize, usize),
    Wheel(usize, usize),
    Prop(usize),
}

/// Dégâts à infliger en une fois (`DamageBatch`), dans l'ordre où les cibles y sont entrées (une
/// `Map` du TypeScript).
#[derive(Default)]
pub struct DamageBatch {
    pub blocks: Vec<((usize, usize), f64)>,
    pub wheels: Vec<((usize, usize), f64)>,
    pub props: Vec<(usize, f64)>,
    pub cuts: Vec<(usize, Vec<WeakLink>)>,
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
fn shield_damage(sim: &mut Sim, bot: usize, block: usize, amount: f64) -> f64 {
    let c = catalog();
    let b = &sim.bots[bot];
    if b.shields.is_empty() || amount <= 0.0 || b.energy <= 0.0 || !b.cockpit_alive() {
        return amount;
    }
    let mut generator = None;
    let mut nearest = f64::INFINITY;
    for &g in &b.shields {
        let gb = &b.blocks[g];
        // (sans paralysie locale : `stunnedUntil` reste à 0)
        if !gb.alive || gb.part != b.cockpit_part() {
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
    for &((bot, b), dealt) in &batch.blocks {
        if !sim.bots[bot].blocks[b].alive {
            continue;
        }
        let amount = shield_damage(sim, bot, b, dealt);
        let block = &mut sim.bots[bot].blocks[b];
        block.hp -= amount;
        push_unique(&mut hit_bots, bot);
        if block.hp <= 0.0 {
            doomed.push((bot, b));
        }
    }

    // Une batterie détruite met le feu à ses voisins (un moteur à bout pourrait prendre feu : les
    // robots à moteur ne sont pas encore portés)
    let c = catalog();
    let kindled: Vec<(usize, usize)> = doomed
        .iter()
        .filter(|&&(bot, b)| c.blocks[&sim.bots[bot].blocks[b].kind].battery > 0.0)
        .flat_map(|&(bot, b)| linked_neighbors(&sim.bots[bot], b).into_iter().map(move |n| (bot, n)))
        .collect();

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
            sim.stats.destroyed += 1;
        }
        for (p, links) in &batch.cuts {
            let bot = sim.part(*p).bot;
            for link in links {
                let b = &sim.bots[bot];
                if !b.blocks[link.inner].alive || !b.blocks[link.outer].alive || b.cuts.contains(&link.key) {
                    continue;
                }
                sim.bots[bot].cuts.insert(link.key);
                sim.part_mut(*p).links = None;
                push_unique(&mut hit_bots, bot);
                sim.stats.links_broken += 1;
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
    // Cockpits détruits : ces robots sont hors de combat
    for &(bot, b) in &doomed {
        if b == sim.bots[bot].cockpit {
            sim.stats.killed += 1;
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
        let mut finish = DamageBatch::default();
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
/// (les débris partent de ce côté). La réaction de l'IA ne sert pas à des robots pilotés.
pub fn inflict(sim: &mut Sim, batch: &DamageBatch, dir: V3) -> Vec<usize> {
    let hit = resolve_damage(sim, batch, dir);
    sim.stats.damage += 1;
    hit
}
