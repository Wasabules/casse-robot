//! Les fonctions du module pour la session de la simulation portée (src/shared/native/session.ts) :
//! ce que fait la session solo (`LocalSession`) et la salle du serveur (`Room`) sur la simulation du
//! TypeScript, sur celle-ci. Les profils des robots qu'elle fait apparaître, l'arène (ses accessoires,
//! ses zones, ses lignes de départ ; le reste comme les essais de parité la donnent), les vagues et
//! les équipes, la partie, les commandes des pilotes, la caméra libre ; et ce qu'elle lit pour ses
//! images : le journal des événements, l'instantané, la description des robots et du monde.
//!
//! Ce qui se lit (un journal, un instantané, une description) est écrit dans un tampon du module : la
//! fonction rend sa longueur, `sim_out` son adresse (valable jusqu'au prochain appel).

use super::catalog::{Mobility, Robot, read_design};
use super::game::{self, Capture, Rules, SpawnLine, Spot, Zone};
use super::json::Json;
use super::net;
use super::robot::Input;
use super::vec::{Q, v3};
use super::{ERROR, text, with};
use std::cell::RefCell;
use std::rc::Rc;

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Garde `bytes` dans le tampon de sortie ; sa longueur.
fn output(bytes: Vec<u8>) -> usize {
    OUT.with(|o| {
        *o.borrow_mut() = bytes;
        o.borrow().len()
    })
}

/// Le message d'une erreur, gardé pour `sim_error` ; -1.
fn fail(message: String) -> i32 {
    ERROR.with(|e| *e.borrow_mut() = message);
    -1
}

/// L'adresse du tampon de sortie.
#[unsafe(no_mangle)]
pub extern "C" fn sim_out() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

/// Tient le journal des événements (non nul), ou non.
#[unsafe(no_mangle)]
pub extern "C" fn sim_log_events(id: u32, on: u32) {
    with(id, |s| s.events = if on != 0 { Some(s.events.take().unwrap_or_default()) } else { None });
}

/// Les événements depuis le dernier appel (le journal est vidé) : leur longueur, dans le tampon.
#[unsafe(no_mangle)]
pub extern "C" fn sim_take_events(id: u32) -> usize {
    let log = with(id, |s| s.events.as_mut().map(std::mem::take).unwrap_or_default());
    output(log)
}

/// Un profil (`BotProfile`) : sa vitesse, sa conduite différentielle, sa mobilité (0 au sol, 1 en vol
/// stationnaire, 2 avion), s'il charge, son plan (JSON, `len` octets, tel que le garage l'enregistre) ;
/// son rang, ou -1 (le message : `sim_error`).
///
/// # Safety
/// `design` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_add_profile(id: u32, speed: f64, turn: f64, mobility: u32, charges: u32, design: *const u8, len: usize) -> i32 {
    let text = unsafe { text(design, len) };
    let design = match Json::parse(text).and_then(|j| read_design(&j)) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let mobility = match mobility {
        1 => Mobility::Hover,
        2 => Mobility::Plane,
        _ => Mobility::Ground,
    };
    let robot = Robot { speed, turn, mobility, charges: charges != 0, design };
    with(id, |s| {
        s.profiles.push(Rc::new(robot));
        s.profiles.len() as i32 - 1
    })
}

/// Oublie le décor et ce que l'arène avait en plus (avant d'en donner une autre, comme `loadArena`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_arena_reset(id: u32) {
    with(id, |s| {
        s.clear_scenery();
        s.arena = Default::default();
        s.water = None;
        s.bounds.spawns = None;
        *s.obstacle_cache.borrow_mut() = None;
    });
}

/// Les lignes de départ de l'arène (`spawnLine`, `spawnSpread`) ; `placed` non nul : celles d'une carte
/// (`spawns`), des rouges puis des bleus (milieu, direction, demi-longueur).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sim_set_spawns(id: u32, line: f64, spread: f64, placed: u32, rx: f64, rz: f64, rf: f64, rs: f64, bx: f64, bz: f64, bf: f64, bs: f64) {
    with(id, |s| {
        s.bounds.spawn_line = line;
        s.bounds.spawn_spread = spread;
        s.bounds.spawns = (placed != 0).then_some([SpawnLine { x: rx, z: rz, facing: rf, spread: rs }, SpawnLine { x: bx, z: bz, facing: bf, spread: bs }]);
    });
}

/// Un emplacement d'accessoire de l'arène (`PropSpot`), comme `sim_add_prop` (NaN : absent), sans créer
/// l'accessoire (`resetProps` le fera) ; son rang.
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_add_spot(
    id: u32, name: *const u8, len: usize, x: f64, y: f64, z: f64, qx: f64, qy: f64, qz: f64, qw: f64, hx: f64, hy: f64, hz: f64, scale: f64,
) -> i32 {
    let kind = unsafe { text(name, len) }.to_string();
    if !super::catalog::catalog().props.contains_key(&kind) {
        return fail(format!("accessoire inconnu : {kind}"));
    }
    let spot = Spot {
        kind,
        pos: v3(x, y, z),
        rot: (!qw.is_nan()).then_some(Q { x: qx, y: qy, z: qz, w: qw }),
        half: (!hx.is_nan()).then_some(v3(hx, hy, hz)),
        scale: (!scale.is_nan()).then_some(scale),
        rests: Vec::new(),
    };
    with(id, |s| {
        s.arena.spots.push(spot);
        s.arena.spots.len() as i32 - 1
    })
}

/// L'emplacement `spot` repose sur l'emplacement `on` (`PropSpot.rests`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_spot_rest(id: u32, spot: u32, on: u32) {
    with(id, |s| s.arena.spots[spot as usize].rests.push(on as usize));
}

/// Une zone à capturer de l'arène : son centre, son rayon.
#[unsafe(no_mangle)]
pub extern "C" fn sim_add_zone(id: u32, x: f64, y: f64, z: f64, radius: f64) {
    with(id, |s| s.arena.zones.push(Zone { pos: v3(x, y, z), radius }));
}

/// L'arène a changé (`arenaChanged`), et ses accessoires sont remis en place (`resetProps`) : 0, ou -1.
#[unsafe(no_mangle)]
pub extern "C" fn sim_arena_changed(id: u32) -> i32 {
    match with(id, |s| {
        s.emit(super::events::code::ARENA_CHANGED, |_, _| {});
        game::reset_props(s)
    }) {
        Ok(()) => 0,
        Err(e) => fail(e),
    }
}

/// Le combat (`sim.combat`) : les tourelles de l'IA tirent.
#[unsafe(no_mangle)]
pub extern "C" fn sim_combat(id: u32, on: u32) {
    with(id, |s| s.combat = on != 0);
}

/// Les robots qu'a fait naître le dernier appel (leurs rangs, sur 4 octets), dans le tampon.
fn bots_out(bots: Vec<usize>) -> i32 {
    let bytes: Vec<u8> = bots.iter().flat_map(|&b| (b as u32).to_le_bytes()).collect();
    output(bytes);
    bots.len() as i32
}

/// Vide l'arène et fait apparaître deux équipes (`spawnTeams`) : `n` entrées (profil, équipe : 0 les
/// rouges, 1 les bleus) ; le nombre de robots (leurs rangs dans le tampon), ou -1.
///
/// # Safety
/// `entries` pointe sur `2 · n` u32.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_spawn_teams(id: u32, entries: *const u32, n: usize) -> i32 {
    let list: Vec<(usize, usize)> = unsafe { std::slice::from_raw_parts(entries, 2 * n) }.chunks(2).map(|e| (e[0] as usize, e[1] as usize)).collect();
    match with(id, |s| game::spawn_teams(s, &list)) {
        Ok(bots) => bots_out(bots),
        Err(e) => fail(e),
    }
}

/// Vide l'arène et fait apparaître une vague (`spawnWave`) de `n` profils ; le nombre de robots, ou -1.
///
/// # Safety
/// `profiles` pointe sur `n` u32.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_spawn_wave(id: u32, profiles: *const u32, n: usize) -> i32 {
    let list: Vec<usize> = unsafe { std::slice::from_raw_parts(profiles, n) }.iter().map(|&p| p as usize).collect();
    match with(id, |s| game::spawn_wave(s, &list).map(|()| s.roster.clone())) {
        Ok(bots) => bots_out(bots),
        Err(e) => fail(e),
    }
}

/// Commence une partie (`startMatch`) : score à atteindre, durée (0 : aucune), délai de réapparition
/// (NaN : élimination), capture de zones (`capture` non nul : temps de prise, points par seconde,
/// période de la colline, NaN : aucune).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sim_start_match(id: u32, score: f64, limit: f64, respawn: f64, capture: u32, time: f64, rate: f64, hill: f64) {
    let rules = Rules {
        score_to_win: score,
        time_limit: limit,
        respawn: (!respawn.is_nan()).then_some(respawn),
        capture: (capture != 0).then_some(Capture { time, rate, hill: (!hill.is_nan()).then_some(hill) }),
    };
    with(id, |s| game::start_match(s, rules));
}

/// Plus de partie (`endMatch`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_end_match(id: u32) {
    with(id, game::end_match);
}

/// Le robot `bot` (un rang) passe aux commandes du pilote dont les commandes sont au rang `slot`.
#[unsafe(no_mangle)]
pub extern "C" fn sim_take_control(id: u32, bot: u32, slot: u32) {
    with(id, |s| game::take_control(s, bot as usize, slot as usize));
}

/// Le robot repasse à l'IA.
#[unsafe(no_mangle)]
pub extern "C" fn sim_release_control(id: u32, bot: u32) {
    with(id, |s| game::release_control(s, bot as usize));
}

/// Le robot du joueur (`sim.player` ; -1 : aucun).
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_player(id: u32, bot: i32) {
    with(id, |s| s.player = (bot >= 0).then_some(bot as usize));
}

/// Le robot du joueur (son rang ; -1 : aucun).
#[unsafe(no_mangle)]
pub extern "C" fn sim_player(id: u32) -> i32 {
    with(id, |s| s.player.map_or(-1, |b| b as i32))
}

/// Les commandes du pilote au rang `slot` (`PlayerInput`) : les nombres, puis les drapeaux (bits :
/// 1 boost, 2 gâchette, 4 viseur, 8 mines, 16 leurres, 32 conduite à la caméra, 64 manuel), l'arme
/// choisie (UTF-8, `len` octets ; 0 octet : aucune), le point visé et la direction du regard (NaN : aucun).
///
/// # Safety
/// `weapon` pointe sur `len` octets.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn sim_set_input(
    id: u32, slot: u32, throttle: f64, steer: f64, climb: f64, brake: f64, yaw: f64, power: f64, heading: f64, flags: u32, weapon: *const u8, len: usize,
    ax: f64, ay: f64, az: f64, lx: f64, ly: f64, lz: f64,
) {
    let name = unsafe { text(weapon, len) };
    let c = super::catalog::catalog();
    // (une arme de tourelle ou de contact du catalogue ; une autre n'existe pas pour la simulation)
    let weapon: Option<&'static str> = if name.is_empty() {
        None
    } else {
        c.weapons.get_key_value(name).map(|(k, _)| k.as_str()).or_else(|| c.melee.get_key_value(name).map(|(k, _)| k.as_str()))
    };
    let input = Input {
        throttle,
        steer,
        climb,
        brake,
        yaw,
        power,
        heading,
        boost: flags & 1 != 0,
        trigger: flags & 2 != 0,
        scope: flags & 4 != 0,
        detonate: flags & 8 != 0,
        flares: flags & 16 != 0,
        relative: flags & 32 != 0,
        manual: flags & 64 != 0,
        weapon,
        aim: (!ax.is_nan()).then_some(v3(ax, ay, az)),
        look: (!lx.is_nan()).then_some(v3(lx, ly, lz)),
    };
    with(id, |s| {
        let slot = slot as usize;
        if s.inputs.len() <= slot {
            s.inputs.resize(slot + 1, Input::default());
        }
        s.inputs[slot] = input;
    });
}

/// Le point que vise la caméra libre (`playerAim` ; NaN : aucun).
#[unsafe(no_mangle)]
pub extern "C" fn sim_player_aim(id: u32, x: f64, y: f64, z: f64) {
    with(id, |s| s.player_aim = (!x.is_nan()).then_some(v3(x, y, z)));
}

/// L'IA figée (`aiPaused`, non nul) ou non.
#[unsafe(no_mangle)]
pub extern "C" fn sim_pause(id: u32, on: u32) {
    with(id, |s| s.ai_paused = on != 0);
}

/// Le robot (un rang) se saborde (`selfDestruct`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_self_destruct(id: u32, bot: u32) {
    with(id, |s| game::self_destruct(s, bot as usize));
}

/// Un joueur prend la place du robot de l'IA `old` (un rang) : celui-ci est retiré (et oublié de la
/// partie), un robot du profil `profile` apparaît du côté de l'équipe `team`, aux commandes du pilote
/// `slot`, à sa place dans `sim.bots` (`Room.replaceAi`) ; son rang, ou -1.
#[unsafe(no_mangle)]
pub extern "C" fn sim_replace_bot(id: u32, old: u32, profile: u32, team: u32, slot: u32) -> i32 {
    let done = with(id, |s| {
        let old = old as usize;
        let i = s.roster.iter().position(|&b| b == old).ok_or("robot absent")?;
        if let Some(m) = &mut s.match_ {
            m.respawns.retain(|r| r.0 != old);
            m.stuck.retain(|r| r.0 != old);
        }
        game::remove_bot(s, old);
        let bot = game::respawn_bot(s, profile as usize, team as usize)?;
        game::take_control(s, bot, slot as usize);
        s.roster[i] = bot;
        Ok::<usize, String>(bot)
    });
    match done {
        Ok(b) => b as i32,
        Err(e) => fail(e),
    }
}

/// Un tir de la caméra libre (`sim.fire`) : un projectile de l'arme `name` depuis `origin` dans la
/// direction `dir`, sans tireur ; `homing` non nul : un missile à tête chercheuse qui cherche sa cible le
/// long du rayon (`from`, `look`), parmi les robots en vol seulement (`air` non nul). 0, ou -1.
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn sim_fire_free(
    id: u32, name: *const u8, len: usize, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, homing: u32, fx: f64, fy: f64, fz: f64, hx: f64, hy: f64, hz: f64, air: u32,
) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    let Some(weapon) = super::catalog::catalog().weapons.get_key_value(&name).map(|(k, _)| k.as_str()) else { return fail(format!("arme inconnue : {name}")) };
    with(id, |s| {
        let target = if homing != 0 { super::projectiles::find_homing_target(s, v3(fx, fy, fz), v3(hx, hy, hz), air != 0, None) } else { None };
        let launch = super::projectiles::Launch { shooter: None, commander: None, homing: target, inherit: v3(0.0, 0.0, 0.0), spread: None };
        super::projectiles::spawn_projectile(s, weapon, v3(ox, oy, oz), v3(dx, dy, dz), launch);
    });
    0
}

/// Un impact de la console (`applyDamage` sans cible) : l'explosion de l'arme `name` en `point`, dans
/// la direction `dir`, comme si le tir venait de `shooter` (sans arme qui explose : rien). 0, ou -1.
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn sim_apply_damage(id: u32, name: *const u8, len: usize, px: f64, py: f64, pz: f64, dx: f64, dy: f64, dz: f64, sx: f64, sy: f64, sz: f64) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    let Some(w) = super::catalog::catalog().weapons.get(&name) else { return fail(format!("arme inconnue : {name}")) };
    if let Some(ex) = w.projectile.explosion {
        with(id, |s| super::explosion::explode(s, v3(px, py, pz), &ex, v3(dx, dy, dz), v3(sx, sy, sz), None, None));
    }
    0
}

/// Avance de `n` pas ; 0, ou -1 (une erreur survenue pendant un pas : `sim_error`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_advance(id: u32, n: u32) -> i32 {
    let failure = with(id, |s| {
        for _ in 0..n {
            s.step();
        }
        s.failure.take()
    });
    match failure {
        None => 0,
        Some(e) => fail(e),
    }
}

/// L'instantané du monde (`writeSnapshot`) : sa longueur, dans le tampon.
#[unsafe(no_mangle)]
pub extern "C" fn sim_snapshot(id: u32) -> usize {
    output(with(id, |s| net::write_snapshot(s)))
}

/// La description du monde pour une image qui le décrit (`describeWorld`, des événements) : sa longueur, dans le tampon.
#[unsafe(no_mangle)]
pub extern "C" fn sim_describe_world(id: u32) -> usize {
    output(with(id, |s| net::describe_world(s)))
}

/// La description du robot de numéro d'entité `bot` (`describeBot`) : sa longueur, dans le tampon ; 0
/// s'il n'existe pas.
#[unsafe(no_mangle)]
pub extern "C" fn sim_describe_bot(id: u32, bot: f64) -> usize {
    let bytes = with(id, |s| {
        let Some(b) = s.bots.iter().position(|x| x.id as f64 == bot) else { return Vec::new() };
        let mut out = Vec::new();
        net::describe_bot(s, b, &mut super::events::Writer::new(&mut out));
        out
    });
    output(bytes)
}

/// Le verrou à montrer au pilote du robot `bot` (un rang) : le bloc de la tourelle, sa cible (numéros
/// d'entité) et la part acquise, écrits dans `out` ; 0 s'il n'y en a pas, 1 sinon.
///
/// # Safety
/// `out` pointe sur 3 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_lock(id: u32, bot: u32, out: *mut f64) -> u32 {
    match with(id, |s| net::pilot_lock(s, bot as usize)) {
        None => 0,
        Some((turret, target, progress)) => {
            unsafe { std::slice::from_raw_parts_mut(out, 3) }.copy_from_slice(&[turret as f64, target as f64, progress]);
            1
        }
    }
}

/// L'état de la partie : présente (0 ou 1), score des rouges et des bleus, temps écoulé, vainqueur
/// (-1 aucun, 0 les rouges, 1 les bleus, 2 égalité), dans `out` ; et le temps simulé.
///
/// # Safety
/// `out` pointe sur 6 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_match_state(id: u32, out: *mut f64) {
    let values = with(id, |s| match &s.match_ {
        None => [0.0, 0.0, 0.0, 0.0, -1.0, s.time],
        Some(m) => {
            let winner = match m.winner {
                None => -1.0,
                Some(game::Winner::Team(t)) => t as f64,
                Some(game::Winner::Draw) => 2.0,
            };
            [1.0, m.score[0], m.score[1], m.elapsed, winner, s.time]
        }
    });
    unsafe { std::slice::from_raw_parts_mut(out, 6) }.copy_from_slice(&values);
}

/// Les robots présents, pour un bilan (`npm run battle`) : pour chacun, son rang, son numéro d'entité,
/// son profil, son équipe, son cockpit vivant, sa mobilité (0 au sol, 1 en vol, 2 avion), le code de
/// son mode d'IA, le temps qu'il est resté bloqué (`blockedT`), s'il est piloté ; 9 nombres de 8 octets
/// chacun, dans le tampon. Leur nombre.
#[unsafe(no_mangle)]
pub extern "C" fn sim_roster(id: u32) -> usize {
    let bytes = with(id, |s| {
        let mut out = Vec::new();
        let mut w = super::events::Writer::new(&mut out);
        for &b in &s.roster {
            let bot = &s.bots[b];
            let mobility = match bot.mobility {
                Mobility::Ground => 0.0,
                Mobility::Hover => 1.0,
                Mobility::Plane => 2.0,
            };
            w.num(b as f64).id(Some(bot.id)).num(bot.profile as f64).num(bot.team as f64).flag(bot.cockpit_alive()).num(mobility);
            w.num(net::mode_code(bot.ai.mode)).num(bot.ai.blocked_t).flag(bot.piloted);
        }
        out
    });
    let n = bytes.len() / (9 * 8);
    output(bytes);
    n
}

/// Le numéro d'entité du robot de rang `bot` (-1 : aucun).
#[unsafe(no_mangle)]
pub extern "C" fn sim_bot_id(id: u32, bot: i32) -> f64 {
    with(id, |s| if bot < 0 { -1.0 } else { s.bots[bot as usize].id as f64 })
}

/// Le premier robot présent aux commandes du pilote `slot` (son rang ; -1 : aucun).
#[unsafe(no_mangle)]
pub extern "C" fn sim_bot_with_input(id: u32, slot: u32) -> i32 {
    with(id, |s| s.roster.iter().copied().find(|&b| s.bots[b].input_slot == Some(slot as usize)).map_or(-1, |b| b as i32))
}

/// Le cockpit du robot (un rang) est-il intact ?
#[unsafe(no_mangle)]
pub extern "C" fn sim_alive(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].cockpit_alive() as u32)
}

/// L'état du hasard du monde (mulberry32) : le TypeScript tire avec (la composition des équipes), puis le rend (`sim_seed`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_rng_state(id: u32) -> u32 {
    with(id, |s| s.rng.state())
}

/// Le temps simulé (s).
#[unsafe(no_mangle)]
pub extern "C" fn sim_time(id: u32) -> f64 {
    with(id, |s| s.time)
}

/// Le nombre de tirages du hasard depuis la graine (`Math.random`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_draws(id: u32) -> f64 {
    with(id, |s| s.rng.draws as f64)
}
