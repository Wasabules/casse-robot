//! Les projectiles (src/shared/combat/projectiles.ts) : chaque tir lance un projectile (une gerbe de
//! plombs, une salve de leurres en lancent plusieurs d'un coup, pour un seul tir), dispersé au hasard
//! comme le tir de l'IA (`hipSpread`) ; une roquette de salve part écartée en éventail. À chaque pas,
//! il avance par un lancer de rayon entre sa position et la suivante, ignore le robot qui l'a tiré,
//! frappe ce qu'il touche (`strike` : un bloc, une roue, un accessoire), enflamme parfois, perce tant
//! qu'il détruit ce qu'il frappe (`pierceRobot` : à l'intérieur d'un robot, case par case dans sa
//! grille), ou éclate (`detonate` : explosion.rs). Un missile guidé (`steer`) file d'abord droit, puis
//! suit l'axe de son lance-missiles (téléguidé) ou poursuit sa cible (tête chercheuse : il doit la
//! voir, sight.rs), ou le point que vise sa tourelle (l'ogive, que l'IA téléguide) ; il ne vire pas
//! plus serré que son accélération latérale ne le permet, et ses virages lui coûtent de la vitesse ;
//! un leurre peut le détourner (decoys.rs). Les balles, obus et rayons touchent en passant les
//! projectiles qu'on peut abattre (interception.rs) ; un leurre ne touche que le décor.
//!
//! Une mine tombe comme un projectile et se pose sur le décor ; c'est mines.rs qui la fait attendre.
//! Un obus ou une mine qui éclate lâche son impulsion électromagnétique (emp.rs) ou son nuage de fumée
//! (smoke.rs). Le projectile d'un projecteur de bouclier se déploie en un mur d'énergie au bout de sa
//! course, ou sur ce qu'il touche ; un mur ennemi sur le trajet d'un tir l'arrête (barriers.rs). Un
//! tir réparateur (rayon, nanites) remet en état l'allié qu'il touche, ou vole la vie d'un ennemi
//! (repair.rs). Une bombe tombe et éclate au sol ; un projectile à fusée de proximité (la flak, le
//! missile que lance la mine anti-aérienne) éclate dès qu'un ennemi qu'il vise (en vol, ou n'importe
//! lequel) passe à portée de sa fusée.

use super::events::{Surface, code};
use super::barriers::{barrier_on_path, damage_barrier, deploy_barrier};
use super::brain::owner_bot;
use super::catalog::{WeaponDef, catalog};
use super::colliders::block_at;
use super::damage::{Target, strike};
use super::decoys::{DECOY_BURST, live_projectile, seduce};
use super::emp::emp_pulse;
use super::explosion::explode;
use super::fire::{BURN_TIME, PUDDLE_REACH, ground_below, ignite, ignite_prop, spawn_ground_fire};
use super::gunner::enemies;
use super::mines::{nearest_enemy, step_mine};
use super::interception::{damage_projectile, projectile_on_path, strikes_projectiles};
use super::props::prop;
use super::repair::{drain_at, repair_at};
use super::sight::sight_blocked;
use super::smoke::release_smoke;
use super::turrets::turret_frame;
use super::vec::{Q, V3, add, axis_angle, clamp, cross, dot, len, norm, qrot, qrot_inv, scale, sub, v3};
use super::world::{Owner, STEP, Sim};
use crate::jsmath;

/// Nombre maximal d'éléments qu'un projectile perforant traverse en un pas (`MAX_PIERCE`).
const MAX_PIERCE: usize = 6;
/// Perforation dans un robot : longueur des pas dans sa grille, distance maximale parcourue (m).
const PIERCE_STEP: f64 = 0.1;
const PIERCE_REACH: f64 = 6.0;
/// Le bois s'enflamme d'autant plus facilement qu'un bloc (facteur sur `ignite`, `WOOD_KINDLING`).
const WOOD_KINDLING: f64 = 2.0;
/// Une tête chercheuse qui ne voit plus sa cible file sur son élan pendant ce temps (s), puis la perd.
const SEEKER_MEMORY: f64 = 1.2;
/// Un missile téléguidé vise sa ligne de visée à cette distance devant lui (m) (`LINE_LEAD`).
const LINE_LEAD: f64 = 6.0;

/// Un projectile en vol (`Projectile`) : son numéro, son arme, le robot qui l'a tiré, la tourelle
/// (de ce robot) qui le téléguide, la cible de sa tête chercheuse, d'où il est parti (pour la réaction
/// de la cible), sa position, sa vitesse, son âge (s), les dégâts qu'il peut encore infliger (ils
/// diminuent quand il perce) ; les points de structure de sa coque et s'il a été abattu (il éclate au
/// pas suivant) ; le leurre qui l'a détourné (son numéro), les leurres qu'il a déjà vus, s'il a perdu
/// sa cible ; où sa tête chercheuse l'a vue pour la dernière fois, depuis combien de temps elle ne la
/// voit plus (s) ; une mine : posée, collée à un bloc (`stuck`), l'instant où elle éclate (rien :
/// elle guette), les équipes adverses qui l'ont repérée, l'instant où un capteur peut de nouveau
/// signaler un ennemi ; et s'il a fini sa course.
pub struct Projectile {
    pub id: u64,
    pub weapon: &'static str,
    pub shooter: Option<usize>,
    pub commander: Option<usize>,
    pub homing: Option<usize>,
    pub origin: V3,
    pub pos: V3,
    pub vel: V3,
    pub age: f64,
    pub damage: f64,
    pub hp: f64,
    pub blown: bool,
    pub decoy: Option<u64>,
    pub tried: Vec<u64>,
    pub lost: bool,
    pub seen: Option<V3>,
    pub blind: f64,
    pub landed: bool,
    pub stuck: Option<Stuck>,
    pub fuse: Option<f64>,
    pub spotted: Vec<usize>,
    pub ping_at: f64,
    pub done: bool,
}

/// Une mine ventouse collée (`Projectile.stuck`) : le robot et le bloc qu'elle tient, et où elle est
/// sur lui (dans le repère de son morceau, depuis son centre).
#[derive(Clone, Copy, Debug)]
pub struct Stuck {
    pub bot: usize,
    pub block: usize,
    pub offset: V3,
}

impl Projectile {
    pub fn def(&self) -> &'static WeaponDef {
        &catalog().weapons[self.weapon]
    }
}

/// Comment part un projectile (`LaunchOptions`) : le robot qui tire, la tourelle (de ce robot) qui le
/// téléguide, la cible d'une tête chercheuse, la vitesse du tireur qu'il garde en partant.
pub struct Launch {
    pub shooter: Option<usize>,
    pub commander: Option<usize>,
    pub homing: Option<usize>,
    pub inherit: V3,
    /// Dispersion du tir (rad) ; aucune : celle de l'arme sans viseur (`hipSpread`), celle de l'IA.
    pub spread: Option<f64>,
}

/// Dispersion d'un tir sans viseur (`hipSpread`, combat/accuracy.ts) : celle de l'IA.
fn hip_spread(w: &WeaponDef) -> f64 {
    w.spread * w.hip
}

/// Écarte une direction d'un angle aléatoire d'au plus `spread` rad (`scatter`).
fn scatter(sim: &mut Sim, dir: V3, spread: f64) -> V3 {
    // (`!spread` : 0 ou NaN)
    if spread == 0.0 || spread.is_nan() {
        return dir;
    }
    let side = norm(if dir.y.abs() < 0.9 { cross(dir, v3(0.0, 1.0, 0.0)) } else { cross(dir, v3(1.0, 0.0, 0.0)) });
    let turned = qrot(axis_angle(side, sim.rng.rand(-spread, spread)), dir);
    qrot(axis_angle(dir, sim.rng.rand(0.0, std::f64::consts::PI * 2.0)), turned)
}

/// Lance un projectile de l'arme `weapon` depuis `origin`, dans la direction unitaire `dir` (plus la
/// dispersion) (`spawnProjectile`) ; une arme à gerbe en lance plusieurs d'un coup, écartés autour de
/// cette direction, pour un seul tir, et une roquette de salve part écartée en éventail.
pub fn spawn_projectile(sim: &mut Sim, weapon: &'static str, origin: V3, dir: V3, launch: Launch) {
    let w = &catalog().weapons[weapon];
    let p = &w.projectile;
    let d = scatter(sim, dir, launch.spread.unwrap_or_else(|| hip_spread(w)));
    // (`pellets?.spread ?? fan ?? 0`)
    let spray = p.pellets.map(|x| x.1).or(p.fan).unwrap_or(0.0);
    let count = p.pellets.map_or(1.0, |x| x.0);
    let mut i = 0.0;
    while i < count {
        let vel = add(scale(scatter(sim, d, spray), p.speed), launch.inherit);
        let id = sim.next_id();
        sim.projectiles.push(Projectile {
            id,
            weapon,
            shooter: launch.shooter,
            commander: launch.commander,
            homing: launch.homing,
            origin,
            pos: origin,
            vel,
            age: 0.0,
            damage: p.damage,
            hp: p.hull.map_or(0.0, |h| h.1),
            blown: false,
            decoy: None,
            tried: Vec::new(),
            lost: false,
            seen: None,
            blind: 0.0,
            landed: false,
            stuck: None,
            fuse: None,
            spotted: Vec::new(),
            ping_at: 0.0,
            done: false,
        });
        sim.stats.projectiles_added += 1;
        sim.emit(code::PROJECTILE_ADDED, |s, w| {
            w.id(Some(id)).text(weapon).id(s.bot_id_of(launch.shooter));
        });
        i += 1.0;
    }
    sim.stats.shots += 1;
    sim.emit(code::SHOT, |_, w| {
        w.text(weapon).vec(origin).vec(d);
    });
}

/// Fait avancer tous les projectiles d'un pas ; ceux qui ont fini leur course disparaissent
/// (`stepProjectiles`). Ils restent dans la liste pendant le pas (une explosion, un leurre, un
/// projectile qu'on abat la parcourent).
pub fn step_projectiles(sim: &mut Sim) {
    // (le `for…of` du TypeScript voit aussi ce qui s'ajoute à la liste pendant la boucle : le missile
    // qu'une mine anti-aérienne lance avance dans le même pas)
    let mut i = 0;
    while i < sim.projectiles.len() {
        if !advance(sim, i) {
            sim.projectiles[i].done = true;
            sim.stats.projectiles_removed += 1;
            let id = sim.projectiles[i].id;
            sim.emit_gone(code::PROJECTILE_REMOVED, id);
        }
        i += 1;
    }
    sim.projectiles.retain(|p| !p.done);
}

/// Ce que touche un projectile, d'après le collider touché (`hitTargetOf`) : un bloc précis (la case
/// juste derrière le point d'impact), le bloc d'une tourelle par sa tête, une roue, un accessoire.
pub fn hit_target_of(sim: &Sim, owner: Option<Owner>, point: V3, dir: V3) -> Option<Target> {
    match owner? {
        Owner::Part(p) => {
            let bot = sim.part(p).bot;
            block_at(sim, p, point, dir).map(|b| Target::Block(bot, b))
        }
        Owner::Head(bot, t) => {
            let block = sim.bots[bot].turrets[t].block;
            sim.bots[bot].blocks[block].alive.then_some(Target::Block(bot, block))
        }
        // La lame ou le bras d'une arme de contact : c'est son bloc qui encaisse
        Owner::Blade(bot, a) => {
            let block = sim.bots[bot].melee[a].block;
            sim.bots[bot].blocks[block].alive.then_some(Target::Block(bot, block))
        }
        Owner::Wheel(bot, w) => Some(Target::Wheel(bot, w)),
        Owner::Prop(i) => Some(Target::Prop(i)),
        Owner::Debris => None,
    }
}

/// `norm(v)` d'une vitesse, ou vers le bas si elle est presque nulle (un projectile abattu).
fn heading_or_down(v: V3) -> V3 {
    if len(v) > 0.1 { norm(v) } else { v3(0.0, -1.0, 0.0) }
}

/// Un pas d'un projectile (`advance`) ; faux quand il a fini sa course.
fn advance(sim: &mut Sim, i: usize) -> bool {
    let w = sim.projectiles[i].def();
    let spec = &w.projectile;
    sim.projectiles[i].age += STEP;
    let bursts = spec.explosion.is_some() || spec.emp.is_some() || spec.smoke.is_some();
    if sim.projectiles[i].age > spec.life {
        // Autodestruction d'un missile ; une grenade (fumigène, IEM) éclate en fin de course
        if (spec.guidance.is_some() && spec.explosion.is_some()) || spec.emp.is_some() || spec.smoke.is_some() {
            let (pos, vel) = (sim.projectiles[i].pos, sim.projectiles[i].vel);
            detonate(sim, i, pos, norm(vel), Surface::Scenery);
        }
        // Un jet de flammes qui s'éteint près du sol y laisse parfois une flaque de feu
        let pos = sim.projectiles[i].pos;
        leave_puddle(sim, i, pos);
        return false;
    }
    // Mine posée, collée, qui bondit ou qu'une explosion a atteinte : mines.rs
    if let Some(mine) = &spec.mine {
        let p = &sim.projectiles[i];
        if p.landed || p.stuck.is_some() || p.fuse.is_some() || p.blown {
            return step_mine(sim, i, mine);
        }
    }
    // Abattu (balle, explosion : interception.rs) : il éclate là où il est
    if sim.projectiles[i].blown {
        if bursts {
            let (pos, vel) = (sim.projectiles[i].pos, sim.projectiles[i].vel);
            detonate(sim, i, pos, heading_or_down(vel), Surface::Scenery);
        }
        return false;
    }

    steer(sim, i);
    let g = sim.gravity;
    let p = &mut sim.projectiles[i];
    p.vel = add(p.vel, v3(0.0, -g * spec.gravity * STEP, 0.0));

    // Détourné par un leurre : il éclate en l'atteignant
    if let Some(decoy) = p.decoy
        && let Some(at) = sim.projectiles.iter().find(|q| q.id == decoy).map(|q| q.pos)
        && distance(sim.projectiles[i].pos, at) < DECOY_BURST
    {
        let (pos, vel) = (sim.projectiles[i].pos, sim.projectiles[i].vel);
        detonate(sim, i, pos, norm(vel), Surface::Scenery);
        return false;
    }

    // Fusée de proximité (missile anti-aérien)
    if let Some(proximity) = spec.proximity
        && spec.mine.is_none()
        && nearest_enemy(sim, i, proximity, if spec.guidance.as_ref().is_some_and(|g| g.air_only) { "air" } else { "any" }).is_some()
    {
        let (pos, vel) = (sim.projectiles[i].pos, sim.projectiles[i].vel);
        detonate(sim, i, pos, norm(vel), Surface::Scenery);
        return false;
    }

    // Déplacement : lancer de rayon entre la position actuelle et la suivante
    let p = &sim.projectiles[i];
    let speed = len(p.vel);
    let dir = scale(p.vel, 1.0 / if speed == 0.0 || speed.is_nan() { 1.0 } else { speed });
    let mut from = p.pos;
    let mut remaining = speed * STEP;
    let shooter = p.shooter;
    // Une mine, un leurre, ne touchent pas les robots : ils se posent sur le décor, ou s'éteignent
    let ground_only = spec.mine.is_some() || spec.decoy;
    let interceptor = strikes_projectiles(spec);
    let mut pierced = 0;
    let team = shooter.map(|s| sim.bots[s].team);
    while pierced < MAX_PIERCE && remaining > 1e-4 {
        pierced += 1;
        // Projecteur de bouclier : il se déploie au bout de sa course
        if let Some(wall) = &spec.barrier
            && sim.projectiles[i].age >= wall.reach / spec.speed
        {
            let pos = sim.projectiles[i].pos;
            deploy_barrier(sim, i, pos, dir, wall);
            return false;
        }
        let hit = {
            let s = &*sim;
            let keep = |h| {
                let owner = s.owners.get(&h);
                match owner {
                    // (le sol et le décor fixe)
                    None => true,
                    Some(Owner::Debris) => false,
                    Some(o) => {
                        let bot = owner_bot(s, Some(o));
                        !(bot.is_some() && bot == shooter) && !(ground_only && bot.is_some())
                    }
                }
            };
            s.phys.cast_ray_hit_where(from, dir, remaining, true, &keep)
        };
        // Un mur d'énergie ennemi sur le trajet, avant ce que touche le rayon : le tir s'y écrase
        let wall = if ground_only || spec.barrier.is_some() { None } else { barrier_on_path(sim, from, dir, hit.map_or(remaining, |h| h.1), team) };
        if let Some((k, at)) = wall {
            let point = add(from, scale(dir, at));
            let damage = sim.projectiles[i].damage + spec.explosion.map_or(0.0, |e| e.damage);
            damage_barrier(sim, k, damage, point);
            if bursts {
                detonate(sim, i, sub(point, scale(dir, 0.3)), dir, Surface::Scenery);
            }
            return false;
        }
        // Un projectile qu'on peut abattre sur le trajet, avant ce que touche le rayon
        let struck = if interceptor { projectile_on_path(sim, i, from, dir, hit.map_or(remaining, |h| h.1)) } else { None };
        if let Some((k, at)) = struck {
            let point = add(from, scale(dir, at));
            let damage = sim.projectiles[i].damage;
            damage_projectile(&mut sim.projectiles[k], damage);
            if spec.explosion.is_some() {
                detonate(sim, i, point, dir, Surface::Scenery);
            } else {
                sim.stats.impacts += 1;
                sim.emit_impact(point, Surface::Projectile);
            }
            return false;
        }
        let Some((collider, toi)) = hit else { break };
        let point = add(from, scale(dir, toi));
        if spec.decoy {
            return false;
        }
        if let Some(wall) = &spec.barrier {
            deploy_barrier(sim, i, sub(point, scale(dir, 0.6)), dir, wall);
            return false;
        }
        if spec.mine.is_some() {
            // Une mine se pose là où elle tombe
            let p = &mut sim.projectiles[i];
            p.pos = sub(point, scale(dir, 0.05));
            p.vel = v3(0.0, 0.0, 0.0);
            p.landed = true;
            return true;
        }
        let target = hit_target_of(sim, sim.owners.get(&collider).copied(), point, dir);
        let (origin, damage, weapon) = (sim.projectiles[i].origin, sim.projectiles[i].damage, sim.projectiles[i].weapon);
        // Tir réparateur (rayon, nanites) : il remet en état un allié autour du point touché ; sur un
        // ennemi, le rayon vole de la vie (repair.rs)
        if let Some(shot) = &spec.repair {
            let bot = match target {
                Some(Target::Block(b, _)) | Some(Target::Wheel(b, _)) => Some(b),
                _ => None,
            };
            match (bot, target, shooter) {
                (Some(b), _, _) if !enemies(sim, shooter, b) => repair_at(sim, b, point, shot),
                (_, Some(Target::Block(b, k)), Some(s)) if shot.drain != 0.0 => drain_at(sim, b, k, point, dir, shot, s, origin, weapon),
                _ => {
                    sim.stats.impacts += 1;
                    sim.emit_impact(point, surface_of(target));
                }
            }
            return false;
        }
        if bursts {
            strike(sim, target, damage, &spec.damage_type, point, dir, spec.impulse, origin, shooter, Some(weapon));
            detonate(sim, i, point, dir, surface_of(target));
            return false;
        }
        // Repère du morceau touché, relevé avant le coup : s'il ne restait que ce bloc, le corps disparaît
        let frame = match target {
            Some(Target::Block(bot, b)) => {
                let rb = sim.part(sim.bots[bot].blocks[b].part).rb;
                Some((bot, sim.phys.rotation(rb), sim.phys.translation(rb)))
            }
            _ => None,
        };
        let (absorbed, destroyed) = strike(sim, target, damage, &spec.damage_type, point, dir, spec.impulse, origin, shooter, Some(weapon));
        if spec.ignite != 0.0
            && let Some(Target::Block(bot, b)) = target
            && sim.bots[bot].blocks[b].alive
            && sim.rng.rand(0.0, 1.0) < spec.ignite
        {
            ignite(sim, bot, b, BURN_TIME);
        }
        // Le bois prend plus vite que l'acier
        if spec.ignite != 0.0
            && let Some(Target::Prop(k)) = target
            && prop(sim, k).hp > 0.0
            && sim.rng.rand(0.0, 1.0) < spec.ignite * WOOD_KINDLING
        {
            ignite_prop(sim, k);
        }
        // Un jet de flammes sur le sol ou le décor y laisse parfois une flaque de feu
        if matches!(target, None | Some(Target::Prop(_))) {
            leave_puddle(sim, i, point);
        }
        if !spec.penetrating || !destroyed || damage - absorbed <= 0.0 {
            sim.stats.impacts += 1;
            sim.emit_impact(point, surface_of(target));
            return false;
        }
        // Perforation : il continue avec les dégâts qui lui restent, à travers le robot puis au-delà
        sim.projectiles[i].damage -= absorbed;
        let mut exit = point;
        if let Some((bot, q, at)) = frame {
            match pierce_robot(sim, i, bot, q, at, point, dir) {
                Some(out) => exit = out,
                None => return false,
            }
        }
        remaining -= toi + distance(point, exit);
        from = exit;
    }
    let p = &mut sim.projectiles[i];
    p.pos = add(p.pos, scale(p.vel, STEP));
    true
}

fn distance(a: V3, b: V3) -> f64 {
    jsmath::hypot3(a.x - b.x, a.y - b.y, a.z - b.z)
}

/// Tourne le vecteur unitaire `dir` vers `want` d'au plus `max_angle` rad (`turnToward`).
fn turn_toward(dir: V3, want: V3, max_angle: f64) -> V3 {
    let angle = clamp(dot(dir, want), -1.0, 1.0).acos();
    if angle <= max_angle {
        return want;
    }
    let mut axis = cross(dir, want);
    if len(axis) < 1e-6 {
        axis = if dir.y.abs() < 0.9 { cross(dir, v3(0.0, 1.0, 0.0)) } else { cross(dir, v3(1.0, 0.0, 0.0)) };
    }
    qrot(axis_angle(norm(axis), max_angle), dir)
}

/// Guidage (`steer`) : un missile téléguidé suit l'axe de visée de son lance-missiles (sans
/// lance-missiles vivant, le point qu'il visait) ; une tête chercheuse poursuit sa cible, en visant
/// là où elle sera, tant qu'elle la voit ; l'ogive de l'IA va au point que vise sa tourelle. Un leurre
/// peut le détourner : il le suit, puis, le leurre éteint, file droit.
fn steer(sim: &mut Sim, i: usize) {
    let spec = &sim.projectiles[i].def().projectile;
    let Some(guidance) = &spec.guidance else { return };
    // Son moteur lui rend peu à peu la vitesse que ses virages lui ont coûtée
    if guidance.recover != 0.0 {
        let p = &mut sim.projectiles[i];
        let s = len(p.vel);
        if s > 0.1 {
            p.vel = scale(p.vel, (s + (spec.speed - s) * jsmath::min(1.0, guidance.recover * STEP)) / s);
        }
    }
    // Départ : il file d'abord droit dans l'axe de l'arme
    if guidance.launch != 0.0 && sim.projectiles[i].age < guidance.launch {
        return;
    }
    seduce(sim, i);
    // (le leurre éteint : un projectile fini, ou retiré à un pas précédent)
    if let Some(decoy) = sim.projectiles[i].decoy
        && live_projectile(sim, decoy).is_none()
    {
        let p = &mut sim.projectiles[i];
        p.decoy = None;
        p.lost = true;
    }
    if sim.projectiles[i].lost {
        return;
    }
    let p = &sim.projectiles[i];
    let mut target = None;
    if let Some(decoy) = p.decoy {
        target = live_projectile(sim, decoy);
    } else if guidance.mode == "piloted"
        && let Some(bot) = p.shooter
        && sim.bots[bot].piloted
    {
        // L'ogive d'un pilote : elle tourne vers le point qu'il vise
        target = sim.bots[bot].input.aim;
    } else if guidance.mode == "command"
        && let Some(t) = p.commander
        && let Some(bot) = p.shooter
        && sim.bots[bot].blocks[sim.bots[bot].turrets[t].block].alive
    {
        // Téléguidé : il suit l'axe de visée de son lance-missiles, un peu devant lui
        let frame = turret_frame(sim, bot, t);
        let along = jsmath::max(0.0, dot(sub(p.pos, frame.muzzle), frame.dir));
        target = Some(add(frame.muzzle, scale(frame.dir, along + LINE_LEAD)));
    } else if guidance.mode == "command" || guidance.mode == "piloted" {
        // (une ogive tirée par l'IA, ou un missile dont le lance-missiles est détruit : le point que
        // visait sa tourelle)
        target = match (p.commander, p.shooter) {
            (Some(t), Some(bot)) => sim.bots[bot].turrets[t].aim,
            _ => None,
        };
    } else if let Some(h) = p.homing
        && sim.bots[h].cockpit_alive()
    {
        let rb = sim.part(sim.bots[h].cockpit_part()).rb;
        let at = sim.phys.world_com(rb);
        let eta = distance(at, p.pos) / jsmath::max(1.0, len(p.vel));
        let ahead = add(at, scale(sim.phys.linvel(rb), eta));
        target = Some(ahead);
        // Tête chercheuse : il doit voir sa cible ; cachée, il file sur son élan sans virer, puis la perd
        if spec.repair.is_none() {
            let pos = p.pos;
            if sight_blocked(sim, pos, h) {
                let p = &mut sim.projectiles[i];
                p.blind += STEP;
                if p.blind > SEEKER_MEMORY {
                    p.lost = true;
                }
                return;
            }
            let p = &mut sim.projectiles[i];
            p.blind = 0.0;
            p.seen = Some(ahead);
        }
    }
    let Some(target) = target else { return };
    let p = &mut sim.projectiles[i];
    let speed = len(p.vel);
    let heading = scale(p.vel, 1.0 / speed);
    // Il ne vire pas plus serré que son accélération latérale ne le permet, et chaque virage lui coûte de la vitesse
    let rate = if guidance.max_accel != 0.0 { jsmath::min(guidance.turn_rate, guidance.max_accel / jsmath::max(1.0, speed)) } else { guidance.turn_rate };
    let turned = turn_toward(heading, norm(sub(target, p.pos)), rate * STEP);
    let angle = clamp(dot(heading, turned), -1.0, 1.0).acos();
    p.vel = scale(turned, speed * (1.0 - guidance.bleed * angle));
}

/// Perforation à l'intérieur d'un robot (`pierceRobot`) : le projectile avance dans la grille du robot
/// par petits pas, et frappe chaque bloc rencontré tant qu'il lui reste des dégâts (les colliders d'un
/// morceau reconstruits après une destruction ne sont visibles des rayons qu'au pas suivant). Le
/// repère est celui du morceau touché, relevé avant le coup : tous les morceaux du robot le partagent.
/// Le point de sortie, ou rien s'il s'arrête.
#[allow(clippy::too_many_arguments)]
fn pierce_robot(sim: &mut Sim, i: usize, bot: usize, q: Q, origin: V3, entry: V3, dir: V3) -> Option<V3> {
    let spec = &sim.projectiles[i].def().projectile;
    let (from, shooter, weapon) = (sim.projectiles[i].origin, sim.projectiles[i].shooter, sim.projectiles[i].weapon);
    let mut last: Option<usize> = None;
    let mut point = entry;
    let mut travelled = 0.0;
    while travelled < PIERCE_REACH {
        travelled += PIERCE_STEP;
        point = add(point, scale(dir, PIERCE_STEP));
        let local = qrot_inv(q, sub(point, origin));
        let r = |x: f64| jsmath::round(x / 0.5) as i64;
        let Some(&block) = sim.bots[bot].cells.get(&(r(local.x), r(local.y), r(local.z))) else { continue };
        if last == Some(block) {
            continue;
        }
        last = Some(block);
        let damage = sim.projectiles[i].damage;
        let (absorbed, destroyed) = strike(sim, Some(Target::Block(bot, block)), damage, &spec.damage_type, point, dir, spec.impulse, from, shooter, Some(weapon));
        sim.projectiles[i].damage -= absorbed;
        if !destroyed || sim.projectiles[i].damage <= 0.0 {
            sim.stats.impacts += 1;
            sim.emit_impact(point, Surface::Robot);
            return None;
        }
    }
    Some(point)
}

/// Flaque de feu d'un jet de lance-flammes (`leavePuddle`), s'il y a du sol juste dessous (et la chance de son projectile).
fn leave_puddle(sim: &mut Sim, i: usize, at: V3) {
    let spec = &sim.projectiles[i].def().projectile;
    let Some(puddle) = spec.puddle else { return };
    if sim.rng.rand(0.0, 1.0) >= spec.puddle_chance {
        return;
    }
    let shooter = sim.projectiles[i].shooter;
    if let Some(ground) = ground_below(sim, at, PUDDLE_REACH) {
        spawn_ground_fire(sim, ground, puddle, shooter);
    }
}

/// Fin d'un projectile qui éclate (`detonate`) : son impulsion électromagnétique, son nuage de fumée
/// (juste devant la surface touchée, pas dedans), son explosion (sa cause est son arme). Sans rien de
/// tout cela, un impact sur `surface`, ce qu'il a touché (une fusée de proximité éclate en l'air : le décor).
pub fn detonate(sim: &mut Sim, i: usize, point: V3, dir: V3, surface: Surface) {
    let p = &sim.projectiles[i];
    let spec = &p.def().projectile;
    let (origin, shooter, weapon) = (p.origin, p.shooter, p.weapon);
    let at = sub(point, scale(dir, 0.15));
    if let Some(pulse) = &spec.emp {
        emp_pulse(sim, at, pulse);
    }
    if let Some(smoke) = &spec.smoke {
        release_smoke(sim, at, smoke);
    }
    match spec.explosion {
        Some(ex) => explode(sim, point, &ex, dir, origin, shooter, Some(weapon)),
        None if spec.emp.is_none() && spec.smoke.is_none() => {
            sim.stats.impacts += 1;
            sim.emit_impact(point, surface);
        }
        None => {}
    }
}

/// Ce que touche un projectile, pour le bruit de l'impact (`surfaceOf`) : rien de touché, c'est le décor.
pub fn surface_of(target: Option<Target>) -> Surface {
    match target {
        None => Surface::Scenery,
        Some(Target::Prop(_)) => Surface::Prop,
        Some(_) => Surface::Robot,
    }
}

/// L'ogive pilotée en vol tirée par ce robot, s'il y en a une (`pilotedWarhead`) : son rang dans
/// `sim.projectiles`.
pub fn piloted_warhead(sim: &Sim, b: usize) -> Option<usize> {
    sim.projectiles.iter().position(|p| p.shooter == Some(b) && catalog().weapons[p.weapon].projectile.guidance.as_ref().is_some_and(|g| g.mode == "piloted"))
}

/// Le robot ennemi vers lequel part un missile à tête chercheuse tiré par le pilote
/// (`findHomingTarget`) : le plus proche de l'axe du tir, à moins de 30° ; un missile anti-aérien ne
/// prend qu'un robot en vol.
pub fn find_homing_target(sim: &Sim, origin: V3, dir: V3, air_only: bool, shooter: Option<usize>) -> Option<usize> {
    let mut best = None;
    let mut best_cos = crate::det::dcos(std::f64::consts::PI / 6.0);
    for b in sim.roster.clone() {
        let bot = &sim.bots[b];
        if !bot.cockpit_alive() || !enemies(sim, shooter, b) {
            continue;
        }
        if air_only && bot.mobility == super::catalog::Mobility::Ground {
            continue;
        }
        let c = dot(norm(sub(bot.last_pos, origin)), dir);
        if c > best_cos {
            best_cos = c;
            best = Some(b);
        }
    }
    best
}
