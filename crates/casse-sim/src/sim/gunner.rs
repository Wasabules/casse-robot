//! Le tireur de l'IA (src/shared/ai/gunner.ts) : chaque tourelle choisit un ennemi repéré à sa portée
//! (le plus proche, de préférence abîmé, vulnérable à son arme, et celui que le robot engage déjà),
//! le vise avec une erreur (une direction tirée au hasard à chaque choix de cible, qui grandit avec la
//! vitesse de la cible en travers de la ligne de tir), en anticipant sa course et en relevant le canon
//! d'une arme dont le projectile retombe, tourne vers lui à ses vitesses de rotation, et tire quand
//! elle est pointée, prête, que la ligne de tir ne traverse pas son robot et que la voie est libre ;
//! des armes identiques, à tour de rôle (turrets.rs).
//!
//! Une arme à verrouillage ne tire que sur sa cible verrouillée (lock.rs), et ses missiles la
//! poursuivent ; une arme automatique rapide (fusil, laser) suit le missile qui fonce sur son robot et
//! tire dessus (la défense rapprochée). Un poseur de mines sème quand un ennemi qu'elles peuvent
//! prendre est à proximité ; un fumigène ne part qu'en fuyant ou en allant se mettre à couvert, et la
//! fumée cache la cible comme le décor (smoke.rs) ; un projecteur de bouclier déploie son mur vers sa
//! cible juste après un coup reçu (`barrierUseful`). Une tourelle de soin (rayon réparateur, nanites)
//! soigne l'allié le plus abîmé à sa portée (`operateSupport`) : le rayon vise son bloc le plus abîmé
//! qu'il atteint vraiment (`repairAim`) ; sans patient, le rayon, qui vole la vie, se bat comme une
//! autre arme. Une soute à bombes lâche quand une bombe lâchée maintenant tomberait sur sa cible, là où
//! elle sera (`bombsOnTarget`), jamais sur un équipier.
//!
//! Pas encore porté : la paralysie locale d'une tourelle (aucune lance électrique).

use super::arsenal::tick_arm;
use super::barriers::Barrier;
use super::debris::block_world_pos;
use super::decoys::incoming_missile;
use super::interception::strikes_projectiles;
use super::lock::{is_locked, release_lock, update_lock};
use super::brain::{Mode, owner_bot};
use super::catalog::{WeaponDef, catalog};
use super::repair::{damaged_blocks, repair_need};
use super::rng::Rng;
use super::smoke::smoke_blocks;
use super::tactics::is_detected;
use super::turrets::{ShotRequest, aim_turret, fire_in_turn, line_of_fire_blocked, live_turrets, muzzle_velocity, rest_turret, turret_frame, turret_ready, weapon};
use super::vec::{V3, add, dot, len, norm, scale, sub, v3};
use super::world::{Owner, STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;

/// Intervalle entre deux choix de cible (s).
const RETARGET: f64 = 0.6;
/// Préférences du choix de cible (`targetScore`).
const FINISH_BONUS: f64 = 0.5;
const WEAKNESS_BONUS: f64 = 0.6;
const FOCUS_BONUS: f64 = 0.15;
/// Erreur de visée de l'IA (rad) : sur une cible immobile, et par m/s de vitesse relative en travers.
const AIM_BASE: f64 = 0.012;
const AIM_TRACKING: f64 = 0.0055;
/// Écart de visée toléré pour tirer (rad) : les balles, les missiles.
const TOLERANCE_DIRECT: f64 = 0.04;
const TOLERANCE_GUIDED: f64 = 0.35;

/// Écart de visée toléré pour tirer (`toleranceOf`).
fn tolerance_of(w: &WeaponDef) -> f64 {
    if w.projectile.guidance.is_some() { TOLERANCE_GUIDED } else { jsmath::max(TOLERANCE_DIRECT, w.spread * 2.0) }
}

fn distance(a: V3, b: V3) -> f64 {
    jsmath::hypot3(a.x - b.x, a.y - b.y, a.z - b.z)
}

/// Les deux robots sont-ils ennemis (`areEnemies`) : deux robots distincts d'équipes différentes.
pub fn are_enemies(sim: &Sim, a: usize, b: usize) -> bool {
    a != b && sim.bots[a].team != sim.bots[b].team
}

/// `areEnemies(a, b)` quand `a` peut manquer (le tireur d'un projectile) : sans robot, l'ennemi de tous.
pub fn enemies(sim: &Sim, a: Option<usize>, b: usize) -> bool {
    a.is_none_or(|a| are_enemies(sim, a, b))
}

/// Défense rapprochée : une tourelle se tourne vers un missile qui fonce sur son robot dès qu'il est
/// à moins de cette distance (m) (`POINT_DEFENSE_TRACK`).
const POINT_DEFENSE_TRACK: f64 = 45.0;

/// L'arme peut-elle abattre un missile en vol (`pointDefense`) ? Une arme automatique à projectile
/// rapide et direct (fusil, laser).
fn point_defense(w: &WeaponDef) -> bool {
    let p = &w.projectile;
    w.automatic && strikes_projectiles(p) && p.speed >= 100.0 && p.explosion.is_none()
}

/// Le robot manœuvre ses tourelles (`operateTurrets`).
pub fn operate_turrets(sim: &mut Sim, bot: usize, dt: f64) {
    let mut ready = Vec::new();
    for t in live_turrets(sim, bot) {
        let w = weapon(sim, bot, t);
        tick_arm(&mut sim.bots[bot].turrets[t].arm, w, dt);
        // Paralysée localement (lance électrique, emp.rs) : elle se fige et se tait
        if super::emp::organ_stunned(sim, bot, sim.bots[bot].turrets[t].block) {
            continue;
        }
        // Rayon réparateur, nanites : leurs cibles sont des alliés. Sans patient, le rayon qui vole la
        // vie se bat comme une autre arme ; les nanites attendent
        if let Some(shot) = &w.projectile.repair {
            if operate_support(sim, bot, t, w, &mut ready) {
                continue;
            }
            if shot.drain == 0.0 {
                sim.bots[bot].turrets[t].aim = None;
                rest_turret(sim, bot, t);
                continue;
            }
        }
        // Défense rapprochée : une arme automatique rapide suit le missile qui fonce sur son robot, et
        // tire dessus dès qu'il est à sa portée, avec l'erreur de visée de l'IA
        let missile = if point_defense(w) { incoming_missile(sim, bot, POINT_DEFENSE_TRACK) } else { None };
        if let Some(m) = missile {
            let frame = turret_frame(sim, bot, t);
            let (pos, vel) = (sim.projectiles[m].pos, sim.projectiles[m].vel);
            let where_ = add(pos, intercept_error(sim, bot, t, frame.muzzle, pos, vel));
            sim.bots[bot].turrets[t].aim = Some(where_);
            let error = aim_turret(sim, bot, t, firing_direction(frame.muzzle, where_, vel, w, sim.gravity));
            let in_range = distance(pos, frame.muzzle) <= w.range;
            if in_range && turret_ready(sim, bot, t) && error < tolerance_of(w) && !line_of_fire_blocked(sim, bot, t) {
                ready.push(ShotRequest { turret: t, homing: None, spread: None });
            }
            continue;
        }
        let turret = &mut sim.bots[bot].turrets[t];
        turret.retarget -= dt;
        let target = turret.target;
        if turret.retarget <= 0.0 || !is_valid_target(sim, bot, target, w) {
            let pick = pick_target(sim, bot, t, w);
            let wobble = random_in_ball(&mut sim.rng);
            let turret = &mut sim.bots[bot].turrets[t];
            turret.target = pick;
            turret.retarget = RETARGET;
            turret.wobble = wobble;
        }
        let Some(target) = sim.bots[bot].turrets[t].target else {
            sim.bots[bot].turrets[t].aim = None;
            release_lock(sim, bot, t);
            continue;
        };
        let frame = turret_frame(sim, bot, t);
        let rb = sim.part(sim.bots[target].cockpit_part()).rb;
        let where_ = add(sim.phys.world_com(rb), aim_error(sim, bot, t, frame.muzzle, target));
        sim.bots[bot].turrets[t].aim = Some(where_);
        // Poseur de mines : il sème derrière lui quand un ennemi qu'elles peuvent prendre est à proximité
        if w.projectile.mine.is_some() {
            if turret_ready(sim, bot, t) && !line_of_fire_blocked(sim, bot, t) && mine_useful(sim, bot, t, w) {
                ready.push(ShotRequest { turret: t, homing: None, spread: None });
            }
            continue;
        }
        // Soute à bombes : elle largue quand une bombe lâchée maintenant tomberait sur la cible
        if w.dropped {
            if turret_ready(sim, bot, t) && !line_of_fire_blocked(sim, bot, t) && bombs_on_target(sim, bot, t, w, target) {
                ready.push(ShotRequest { turret: t, homing: None, spread: None });
            }
            continue;
        }
        let want = firing_direction(frame.muzzle, where_, sim.phys.linvel(rb), w, sim.gravity);
        let error = aim_turret(sim, bot, t, want);
        // Arme à verrouillage : elle verrouille ce qu'elle vise, et ne tire que sur sa cible verrouillée
        if w.lock.is_some() {
            update_lock(sim, bot, t, frame.muzzle, norm(sub(where_, frame.muzzle)), dt);
        }
        let locked = w.lock.is_none() || (is_locked(sim, bot, t) && sim.bots[bot].turrets[t].lock_on == Some(target));
        // Un fumigène sert à couvrir une fuite ou un repli : on ne le lance qu'en fuyant ou en allant se mettre à couvert
        let useful = w.projectile.smoke.is_none() || matches!(sim.bots[bot].ai.mode, Mode::Flee | Mode::Cover);
        // Un mur d'énergie : quand on le prend pour cible, entre lui et nous (il n'a pas besoin de voir la cible)
        if w.projectile.barrier.is_some() {
            if turret_ready(sim, bot, t) && error < tolerance_of(w) && !line_of_fire_blocked(sim, bot, t) && barrier_useful(sim, bot, target) {
                ready.push(ShotRequest { turret: t, homing: None, spread: None });
            }
            continue;
        }
        if useful
            && locked
            && turret_ready(sim, bot, t)
            && error < tolerance_of(w)
            && !line_of_fire_blocked(sim, bot, t)
            && clear_shot(sim, bot, frame.muzzle, where_, target)
        {
            let homing = if w.projectile.guidance.as_ref().is_some_and(|g| g.mode == "homing") { Some(target) } else { None };
            ready.push(ShotRequest { turret: t, homing, spread: None });
        }
    }
    fire_in_turn(sim, bot, &ready);
}

/// Temps (s) que met un projectile lancé avec la vitesse verticale `vy` pour descendre de `drop` m,
/// selon `ballisticPoint` ; rien s'il n'y arrive jamais (`fallTime`, combat/ballistics.ts).
fn fall_time(drop: f64, vy: f64, gravity: f64, scale_g: f64) -> Option<f64> {
    let g = gravity * scale_g;
    if g <= 0.0 {
        return None;
    }
    // vy·t − g·t·(t + STEP)/2 = −drop
    let b = vy - 0.5 * g * STEP;
    let disc = b * b + 2.0 * g * drop;
    if disc < 0.0 {
        return None;
    }
    let t = (b + disc.sqrt()) / g;
    (t > 0.0).then_some(t)
}

/// Position d'un projectile lancé de `from` à la vitesse `vel` au bout de `t` s, comme l'intègre
/// `advance` (`ballisticPoint`).
fn ballistic_point(from: V3, vel: V3, gravity: f64, scale_g: f64, t: f64) -> V3 {
    let drop = 0.5 * gravity * scale_g * t * (t + STEP);
    v3(from.x + vel.x * t, from.y + vel.y * t - drop, from.z + vel.z * t)
}

/// Une bombe lâchée maintenant tomberait-elle sur la cible (`bombsOnTarget`) ? Elle part avec la
/// vitesse du robot ; on suit sa chute jusqu'à la hauteur de la cible, et on la compare à l'endroit où
/// celle-ci sera alors. Pas si un coéquipier est dans la zone de l'explosion.
fn bombs_on_target(sim: &Sim, bot: usize, t: usize, w: &WeaponDef, target: usize) -> bool {
    let p = &w.projectile;
    let frame = turret_frame(sim, bot, t);
    let vel = add(muzzle_velocity(sim, bot, t, frame.muzzle), scale(frame.dir, p.speed));
    let rb = sim.part(sim.bots[target].cockpit_part()).rb;
    let goal = sim.phys.world_com(rb);
    let Some(time) = fall_time(frame.muzzle.y - goal.y, vel.y, sim.gravity, p.gravity) else { return false };
    let impact = ballistic_point(frame.muzzle, vel, sim.gravity, p.gravity, time);
    let ahead = add(goal, scale(sim.phys.linvel(rb), time));
    let radius = p.explosion.map_or(1.0, |e| e.radius);
    if jsmath::hypot2(impact.x - ahead.x, impact.z - ahead.z) > radius + sim.bots[target].radius {
        return false;
    }
    !sim.roster.iter().copied().any(|o| {
        let b = &sim.bots[o];
        o != bot && b.cockpit_alive() && !are_enemies(sim, bot, o) && jsmath::hypot2(b.last_pos.x - impact.x, b.last_pos.z - impact.z) < radius + b.radius
    })
}

/// Poser une mine maintenant sert-il à quelque chose (`mineUseful`) ? Un ennemi qu'elle peut prendre
/// est déjà à portée ; une mine fumigène couvre une fuite ou un repli ; un capteur ne se pose pas là où
/// son équipe en a déjà un.
fn mine_useful(sim: &Sim, bot: usize, t: usize, w: &WeaponDef) -> bool {
    let p = &w.projectile;
    if p.smoke.is_some() {
        return matches!(sim.bots[bot].ai.mode, Mode::Flee | Mode::Cover);
    }
    let sense = p.mine.as_ref().map_or(0.0, |m| m.sense);
    if sense == 0.0 {
        return true;
    }
    let at = turret_frame(sim, bot, t).muzzle;
    let team = sim.bots[bot].team;
    !sim.projectiles.iter().any(|q| {
        q.landed
            && q.shooter.is_some_and(|s| sim.bots[s].team == team)
            && q.def().projectile.mine.as_ref().is_some_and(|m| m.sense != 0.0)
            && distance(q.pos, at) < sense
    })
}

/// L'IA déploie un mur dans les BARRIER_ALERT s qui suivent un coup reçu, pas contre un ennemi à moins
/// de BARRIER_MIN_RANGE m, ni à moins de BARRIER_SPACING m d'un mur de son équipe.
const BARRIER_ALERT: f64 = 2.0;
const BARRIER_MIN_RANGE: f64 = 8.0;
const BARRIER_SPACING: f64 = 9.0;

/// Déployer un mur d'énergie vers `target` sert-il maintenant (`barrierUseful`) ? Le robot vient d'être
/// touché, la cible n'est pas collée à lui, et son équipe n'a pas déjà un mur tout près de lui.
fn barrier_useful(sim: &Sim, bot: usize, target: usize) -> bool {
    let b = &sim.bots[bot];
    if sim.time - b.last_hit > BARRIER_ALERT || distance(sim.bots[target].last_pos, b.last_pos) < BARRIER_MIN_RANGE {
        return false;
    }
    !sim.barriers.iter().any(|w: &Barrier| w.team == b.team && distance(w.center, b.last_pos) < BARRIER_SPACING)
}

/// Un allié ne se soigne au rayon qu'à partir de ce que ses blocs ont perdu (points de structure).
const PATIENT_NEED: f64 = 20.0;
/// Blocs abîmés qu'un rayon réparateur essaie d'atteindre, les plus abîmés d'abord.
const REPAIR_TRIES: usize = 12;

/// Tourelle de soin (rayon réparateur, nanites) (`operateSupport`) : elle choisit l'allié le plus
/// abîmé à sa portée (moins s'il est loin). Le rayon vise son bloc le plus abîmé qu'il atteint vraiment
/// et tire quand il est pointé et que rien ne s'interpose ; les nanites, qui le poursuivent et se
/// répandent sur lui, partent dès que la tourelle est tournée vers lui. Faux sans patient (la tourelle
/// est libre).
pub fn operate_support(sim: &mut Sim, bot: usize, t: usize, w: &WeaponDef, ready: &mut Vec<ShotRequest>) -> bool {
    let c = catalog();
    let guided = w.projectile.guidance.is_some();
    // (`areEnemies(bot, t.target)` : sa cible est-elle un allié ?)
    let current = sim.bots[bot].turrets[t].target.filter(|&x| !are_enemies(sim, bot, x));
    let aimed = sim.bots[bot].turrets[t].repair_aim;
    let done = match current {
        None => true,
        Some(c0) => {
            !sim.bots[c0].cockpit_alive()
                || (!guided
                    && aimed.is_none_or(|(ab, ak)| {
                        let k = &sim.bots[ab].blocks[ak];
                        !k.alive || ab != c0 || k.hp >= c.blocks[&k.kind].hp
                    }))
        }
    };
    if sim.bots[bot].turrets[t].patient_at <= sim.time || (current.is_some() && done) {
        sim.bots[bot].turrets[t].patient_at = sim.time + RETARGET;
        let patient = pick_patient(sim, bot, t, w);
        if patient.is_some() {
            sim.bots[bot].turrets[t].target = patient;
        } else if current.is_some() {
            sim.bots[bot].turrets[t].target = None;
        }
        let radius = w.projectile.repair.map_or(1.0, |r| r.radius);
        let block = match patient {
            Some(p) if !guided => repair_aim(sim, bot, t, p, radius).map(|k| (p, k)),
            _ => None,
        };
        sim.bots[bot].turrets[t].repair_aim = block;
    }
    let Some(target) = sim.bots[bot].turrets[t].target.filter(|&x| !are_enemies(sim, bot, x)) else { return false };
    let frame = turret_frame(sim, bot, t);
    let rb = sim.part(sim.bots[target].cockpit_part()).rb;
    if guided {
        let where_ = sim.phys.world_com(rb);
        sim.bots[bot].turrets[t].aim = Some(where_);
        let error = aim_turret(sim, bot, t, norm(sub(where_, frame.muzzle)));
        if turret_ready(sim, bot, t) && error < tolerance_of(w) && !line_of_fire_blocked(sim, bot, t) {
            ready.push(ShotRequest { turret: t, homing: Some(target), spread: None });
        }
        return true;
    }
    let Some((ab, ak)) = sim.bots[bot].turrets[t].repair_aim else {
        // Rien d'atteignable de là : il reste avec son patient (son robot tourne autour, tactics.rs)
        sim.bots[bot].turrets[t].aim = None;
        rest_turret(sim, bot, t);
        return true;
    };
    let where_ = block_world_pos(sim, ab, ak);
    sim.bots[bot].turrets[t].aim = Some(where_);
    let error = aim_turret(sim, bot, t, firing_direction(frame.muzzle, where_, sim.phys.linvel(rb), w, sim.gravity));
    if turret_ready(sim, bot, t) && error < tolerance_of(w) && !line_of_fire_blocked(sim, bot, t) && clear_shot(sim, bot, frame.muzzle, where_, target) {
        ready.push(ShotRequest { turret: t, homing: None, spread: None });
    }
    true
}

/// Bloc à viser sur le patient (`repairAim`) : le plus abîmé que le rayon atteint vraiment (son point
/// d'impact à portée de réparation de ce bloc), ou rien. Un bloc enfoui sous d'autres ne se vise pas :
/// le rayon réparerait la surface sans l'atteindre ; il se répare en visant ses voisins.
fn repair_aim(sim: &Sim, bot: usize, t: usize, patient: usize, radius: f64) -> Option<usize> {
    let muzzle = turret_frame(sim, bot, t).muzzle;
    let keep = |h| {
        let owner = sim.owners.get(&h);
        !matches!(owner, Some(Owner::Debris)) && owner_bot(sim, owner) != Some(bot)
    };
    for b in damaged_blocks(sim, patient).into_iter().take(REPAIR_TRIES) {
        let at = block_world_pos(sim, patient, b);
        let to = sub(at, muzzle);
        let dist = len(to);
        if dist < 1e-3 {
            continue;
        }
        if let Some((_, toi)) = sim.phys.cast_ray_hit_where(muzzle, scale(to, 1.0 / dist), dist + 1.0, true, &keep)
            && distance(add(muzzle, scale(to, toi / dist)), at) < radius
        {
            return Some(b);
        }
    }
    None
}

/// Allié à soigner (`pickPatient`) : le plus abîmé à portée de l'arme, préféré proche.
fn pick_patient(sim: &Sim, bot: usize, t: usize, w: &WeaponDef) -> Option<usize> {
    let from = turret_frame(sim, bot, t).muzzle;
    let mut best = None;
    let mut best_score = 0.0;
    for other in sim.roster.clone() {
        if other == bot || !sim.bots[other].cockpit_alive() || are_enemies(sim, bot, other) {
            continue;
        }
        let d = distance(sim.bots[other].last_pos, from);
        let need = repair_need(sim, other);
        if d > w.range || need < PATIENT_NEED {
            continue;
        }
        let score = need / (1.0 + d / 20.0);
        if score > best_score {
            best_score = score;
            best = Some(other);
        }
    }
    best
}

/// Erreur de visée sur un missile (m), comme sur un robot : sa vitesse en travers de la ligne de tir
/// la grossit (`interceptError`).
fn intercept_error(sim: &Sim, bot: usize, t: usize, muzzle: V3, pos: V3, vel: V3) -> V3 {
    let los = sub(pos, muzzle);
    let range = len(los);
    if range < 1e-3 {
        return v3(0.0, 0.0, 0.0);
    }
    let u = scale(los, 1.0 / range);
    let mine = sim.part(sim.bots[bot].cockpit_part()).rb;
    let rel = sub(vel, sim.phys.linvel(mine));
    let across = len(sub(rel, scale(u, dot(rel, u))));
    scale(sim.bots[bot].turrets[t].wobble, range * (AIM_BASE + AIM_TRACKING * across))
}

/// Décalage du point visé (m) : l'erreur de visée à cette distance, selon le mouvement relatif (`aimError`).
fn aim_error(sim: &Sim, bot: usize, t: usize, muzzle: V3, target: usize) -> V3 {
    let los = sub(sim.bots[target].last_pos, muzzle);
    let range = len(los);
    if range < 1e-3 {
        return v3(0.0, 0.0, 0.0);
    }
    let u = scale(los, 1.0 / range);
    let mine = sim.part(sim.bots[bot].cockpit_part()).rb;
    let theirs = sim.part(sim.bots[target].cockpit_part()).rb;
    let rel = sub(sim.phys.linvel(theirs), sim.phys.linvel(mine));
    let across = len(sub(rel, scale(u, dot(rel, u))));
    scale(sim.bots[bot].turrets[t].wobble, range * (AIM_BASE + AIM_TRACKING * across))
}

/// Point tiré au hasard dans la boule unité (`randomInBall`).
fn random_in_ball(rng: &mut Rng) -> V3 {
    loop {
        let x = rng.rand(-1.0, 1.0);
        let y = rng.rand(-1.0, 1.0);
        let z = rng.rand(-1.0, 1.0);
        let v = v3(x, y, z);
        if len(v) <= 1.0 {
            return v;
        }
    }
}

/// Une cible reste valable tant qu'elle vit, reste repérée, à portée, et convient à l'arme (`isValidTarget`).
fn is_valid_target(sim: &Sim, bot: usize, target: Option<usize>, w: &WeaponDef) -> bool {
    let Some(target) = target else { return false };
    if !sim.bots[target].cockpit_alive() || !suits(sim, w, target) || !is_detected(sim, sim.bots[bot].team, target) {
        return false;
    }
    let d = distance(sim.bots[target].last_pos, sim.bots[bot].last_pos);
    d <= w.range && d >= w.min_range.unwrap_or(0.0)
}

/// L'arme convient-elle à ce genre de cible (`suits`) ? Les robots portés sont tous au sol.
pub fn suits(sim: &Sim, w: &WeaponDef, target: usize) -> bool {
    use super::catalog::Mobility;
    let mobility = sim.bots[target].mobility;
    let flying = mobility != Mobility::Ground;
    let p = &w.projectile;
    let trigger = p.mine.as_ref().map(|m| m.trigger.as_str());
    if p.guidance.as_ref().is_some_and(|g| g.air_only) || trigger == Some("air") {
        return flying;
    }
    if trigger == Some("none") {
        return true;
    }
    if p.mine.is_some() || w.dropped {
        return !flying;
    }
    if p.gravity != 0.0 && p.explosion.is_some() {
        return mobility != Mobility::Plane;
    }
    true
}

/// Cible d'une tourelle, parmi les ennemis repérés à portée qui conviennent à l'arme (`pickTarget`).
fn pick_target(sim: &mut Sim, bot: usize, t: usize, w: &WeaponDef) -> Option<usize> {
    let mut best = None;
    let mut best_score = f64::INFINITY;
    let from = turret_frame(sim, bot, t).muzzle;
    for other in sim.roster.clone() {
        if !sim.bots[other].cockpit_alive() || !are_enemies(sim, bot, other) || !suits(sim, w, other) || !is_detected(sim, sim.bots[bot].team, other) {
            continue;
        }
        let d = distance(sim.bots[other].last_pos, from);
        if d > w.range || d < w.min_range.unwrap_or(0.0) {
            continue;
        }
        let score = target_score(sim, bot, other, w, d);
        if score < best_score {
            best_score = score;
            best = Some(other);
        }
    }
    best
}

/// Note d'une cible à la distance `d` pour cette arme (`targetScore`) : plus elle est basse, mieux c'est.
fn target_score(sim: &mut Sim, bot: usize, other: usize, w: &WeaponDef, d: f64) -> f64 {
    let focus = if sim.bots[bot].ai.tactics.foe == Some(other) { FOCUS_BONUS } else { 0.0 };
    d / w.range - FINISH_BONUS * (1.0 - integrity(sim, other)) - WEAKNESS_BONUS * (vulnerability(sim, other, &w.projectile.damage_type) - 1.0) - focus
}

/// Part des blocs de départ que garde le morceau du cockpit (`integrity`).
pub fn integrity(sim: &Sim, bot: usize) -> f64 {
    let b = &sim.bots[bot];
    if b.cockpit_alive() { sim.part(b.cockpit_part()).blocks.len() as f64 / b.total as f64 } else { 0.0 }
}

/// Facteur moyen des dégâts de nature `kind` sur les blocs du morceau du cockpit (`vulnerability`) ;
/// gardé par robot, recalculé quand le nombre de ces blocs change (comme le TypeScript).
fn vulnerability(sim: &mut Sim, bot: usize, kind: &str) -> f64 {
    let c = catalog();
    let part = sim.bots[bot].cockpit_part();
    let size = sim.part(part).blocks.len();
    if !matches!(sim.bots[bot].vulnerability, Some((n, _)) if n == size) {
        sim.bots[bot].vulnerability = Some((size, Vec::new()));
    }
    if let Some((_, by_type)) = &sim.bots[bot].vulnerability
        && let Some(&(_, v)) = by_type.iter().find(|e| e.0 == kind)
    {
        return v;
    }
    let mut sum = 0.0;
    for &k in &sim.part(part).blocks {
        sum += c.blocks[&sim.bots[bot].blocks[k].kind].resistance(kind);
    }
    let v = if size != 0 { sum / size as f64 } else { 1.0 };
    if let Some((_, by_type)) = &mut sim.bots[bot].vulnerability {
        by_type.push((kind.to_string(), v));
    }
    v
}

/// Direction de tir vers une cible en `target` qui se déplace à `vel` (`firingDirection`) : là où
/// elle sera à l'arrivée du projectile, le canon relevé s'il retombe (tir tendu de la balistique).
pub fn firing_direction(muzzle: V3, target: V3, vel: V3, w: &WeaponDef, gravity: f64) -> V3 {
    let p = &w.projectile;
    if let Some(g) = &p.guidance {
        return if g.mode == "command" { norm(sub(target, muzzle)) } else { norm(add(norm(sub(target, muzzle)), v3(0.0, 0.15, 0.0))) };
    }
    let mut aim = target;
    let mut dir = norm(sub(aim, muzzle));
    for _ in 0..3 {
        let d = sub(aim, muzzle);
        let horizontal = jsmath::hypot2(d.x, d.z);
        let mut flight = jsmath::hypot2(horizontal, d.y) / p.speed;
        dir = norm(d);
        if p.gravity != 0.0 && horizontal > 0.1 {
            let g = gravity * p.gravity;
            let v2 = p.speed * p.speed;
            let root = v2 * v2 - g * (g * horizontal * horizontal + 2.0 * d.y * v2);
            let angle = if root >= 0.0 { ((v2 - root.sqrt()) / (g * horizontal)).atan() } else { std::f64::consts::PI / 4.0 };
            let flat = v3(d.x / horizontal, 0.0, d.z / horizontal);
            dir = add(scale(flat, dcos(angle)), v3(0.0, dsin(angle), 0.0));
            flight = horizontal / (p.speed * dcos(angle));
        }
        aim = add(target, scale(vel, flight));
    }
    dir
}

/// Rien entre la bouche et la cible (`clearShot`) : ni fumée, ni décor (sauf tout près de la cible),
/// ni coéquipier ; `enemy` est le robot visé (un allié pour le rayon réparateur).
fn clear_shot(sim: &Sim, bot: usize, muzzle: V3, target: V3, enemy: usize) -> bool {
    if smoke_blocks(sim, muzzle, target) {
        return false;
    }
    let to = sub(target, muzzle);
    let dist = jsmath::hypot3(to.x, to.y, to.z);
    let keep = |h| {
        let owner = sim.owners.get(&h);
        if matches!(owner, Some(Owner::Debris)) {
            return false;
        }
        owner_bot(sim, owner) != Some(bot)
    };
    let Some((collider, toi)) = sim.phys.cast_ray_hit_where(muzzle, scale(to, 1.0 / dist), dist, true, &keep) else { return true };
    if let Some(other) = owner_bot(sim, sim.owners.get(&collider)) {
        return other == enemy || are_enemies(sim, bot, other);
    }
    // Décor ou accessoire : on tire s'il est tout près de la cible
    toi > dist - 1.5
}
