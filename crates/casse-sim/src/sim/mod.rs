//! La simulation portée, propriétaire de son monde Rapier (fonctionnalité `sim`, dans la sonde, hors
//! du module du jeu). Premier jalon, « un robot qui roule » : les catalogues lus dans
//! content/catalog.json (catalog.rs), le monde et son sol (world.rs), un robot préfabriqué depuis
//! son plan (lifecycle.rs, robot.rs), ses colliders fusionnés (colliders.rs ; ses blocs de forme :
//! shapes.rs), les roues par lancer de rayon (wheels.rs) et la conduite (drive.rs), Rapier manié
//! comme le manie le TypeScript (physics.rs). Deuxième jalon, « les chocs et les dégâts » : les
//! forces de contact du pas et la vitesse de rapprochement d'avant le pas (collisions.rs), les lots
//! de dégâts (damage.rs), les liaisons faibles (structure.rs), les blocs détruits et leurs débris
//! (debris.rs), les morceaux séparés et les roues arrachées (lifecycle.rs), le hasard à graine fixe
//! (rng.rs). Troisième jalon, « les accessoires » : caisses, barils, bouteilles de gaz, murs et
//! arbres ancrés (props.rs), leurs chocs avec les robots et la percée d'un accessoire ancré
//! (collisions.rs), les explosions et leur souffle (explosion.rs), le feu des blocs et du bois
//! (fire.rs). Quatrième jalon, « la réparation et les flaques de feu » : les modules de réparation
//! (repair.rs : blocs et roues réparés, blocs perdus qui repoussent, y compris ceux restés sur un
//! morceau arraché), les flaques de feu au sol (fire.rs : le napalm d'une explosion, le jet du
//! lance-flammes). Cinquième jalon, « l'IA qui conduit » : hors combat (comme au stand de tir), l'IA
//! patrouille, contourne le décor, prend les rampes, se dégage quand elle est coincée, fuit ou fonce
//! sur qui la heurte (brain.rs, navigation.rs), et chaque équipe repère l'autre (detection.rs), dans
//! les petites arènes (Dépôt, Forteresse, Tranchées, Chantier : sans relief). Sixième jalon, « le
//! combat » : au combat (`sim.combat`), la tactique de l'IA (tactics.rs : adversaire, portée
//! préférée, tourner autour, charger, se mettre à couvert), ses tourelles (turrets.rs, gunner.rs :
//! choix de cible, erreur de visée, anticipation, balistique, ligne de tir, tir à tour de rôle,
//! défense rapprochée ; arsenal.rs : cadence, chaleur, chargeurs) et leurs projectiles
//! (projectiles.rs : avancée par rayons, coups, perforation, explosions, flaques du lance-flammes ;
//! guidage des missiles, lock.rs, sight.rs ; leurres, decoys.rs ; interception.rs ; mines et
//! capteurs, mines.rs), pour le tir direct (fusil, canon, fusil de précision, laser, canon
//! électrique, fusil à pompe, plasma, lance-flammes), les missiles (téléguidés, roquettes, à
//! verrouillage, l'ogive) et les mines (la mine, le capteur, la mine anti-aérienne). Septième jalon,
//! « les armes spéciales » : l'impulsion électromagnétique qui paralyse (emp.rs), la fumée qui cache
//! (smoke.rs), les mines qui bondissent, se collent ou se télécommandent (mines.rs), le soutien (le
//! rayon réparateur et les nanites, le vol de vie : repair.rs ; le choix du patient : gunner.rs ; le
//! mode soutien de la tactique : tactics.rs) et les murs d'énergie (barriers.rs) : tous les robots
//! portés se battent. Huitième jalon, « les moteurs, les appuis et le vol » : les moteurs (réacteurs,
//! propulseurs, rotors, hélice, turboréacteur, rotor orientable, rotor de queue ; leur usure et leurs
//! ratés : propulsion.rs), les patins et les pattes (supports.rs), le jet de flamme des moteurs et ce
//! qu'il brûle (exhaust.rs, scorch.rs), le vol stationnaire (`flyToward`, propulsion.rs ; la poussée
//! répartie par moindres carrés bornés : linalg.rs) et les rafales d'air (air.rs), les ailes et les
//! gouvernes par rangs (aero.rs), le pilote d'avion de l'IA et celui du joueur, à la souris ou en
//! manuel (pilot.rs), l'IA qui vole, se pose pour recharger, fuit en montant, se met à couvert
//! (brain.rs), l'hélice tranchante (melee.rs), les bombes, la flak et sa fusée de proximité, la mine
//! anti-aérienne qui lance son missile (gunner.rs, projectiles.rs, mines.rs). Neuvième jalon, « les
//! armes de contact » : les quinze armes de contact (melee.rs : le régime, la réaction du moteur, le
//! gyroscope, le balourd, le coup mesuré et le ricochet, le bras, la pointe, le champ, la morsure
//! continue ; mechanics.rs : le flipper, le fléau, la mâchoire), leurs zones touchables (colliders.rs),
//! l'IA qui les manie et le pilote (brawl.rs), la paralysie locale de la lance électrique (emp.rs) ;
//! et les tirs du pilote (player.rs : la visée, le tir en cloche, le viseur, le verrou, les leurres,
//! l'ogive pilotée et `holdPlane`, la conduite à la caméra). Tous les robots préfabriqués sont portés.
//! Dixième jalon, « les grandes arènes et les cartes » : l'arène que le TypeScript construit d'après
//! son fichier de carte (`arenaFromMap`), donnée champ par champ (arena.rs) : le relief en champ de
//! hauteurs et la hauteur du sol sans physique, les rochers en enveloppe convexe, l'eau profonde et la
//! lave (hazards.rs : la noyade, la lave qui brûle ; les patins qui glissent sur l'eau, supports.rs),
//! la grille de passage (faite par le TypeScript) et le réseau de passage, les ponts, les passages
//! sous une voie surélevée, les hautes rampes, les bâtiments faits d'accessoires et la ville
//! (navigation.rs : `gridWaypoint`, `bridgeGoal`, `routeGoal`, `buildingExit`, `clearOf`,
//! `besideRamp`), les planchers de vol (pilot.rs, brain.rs) : les dix arènes du jeu et les cartes
//! communautaires. tests/nativeSim.test.ts fait rouler, voler, se heurter et se battre les mêmes
//! robots, pilotés ou conduits par l'IA, contre les mêmes accessoires, dans les mêmes flaques, sur le
//! même relief, ici et dans la simulation du TypeScript, et compare leurs états au bit près.
//!
//! L'interface : des fonctions `extern "C"` (comme ffi.rs) ; un monde est désigné par un numéro.

pub mod aero;
pub mod arena;
pub mod air;
pub mod arsenal;
pub mod barriers;
pub mod brawl;
pub mod brain;
pub mod catalog;
pub mod colliders;
pub mod collisions;
pub mod damage;
pub mod debris;
pub mod decoys;
pub mod detection;
pub mod drive;
pub mod emp;
pub mod events;
pub mod exhaust;
pub mod explosion;
pub mod fire;
pub mod game;
pub mod gunner;
pub mod hooks;
pub mod hazards;
pub mod interception;
pub mod json;
pub mod lifecycle;
pub mod linalg;
pub mod lock;
pub mod mechanics;
pub mod melee;
pub mod mines;
pub mod net;
pub mod navigation;
pub mod physics;
pub mod pilot;
pub mod player;
pub mod projectiles;
pub mod propulsion;
pub mod props;
pub mod repair;
pub mod rng;
pub mod robot;
pub mod scorch;
pub mod shapes;
pub mod sight;
pub mod smoke;
pub mod structure;
pub mod supports;
pub mod tactics;
pub mod turrets;
pub mod vec;
pub mod wheels;
pub mod world;

use std::cell::RefCell;
use vec::{Q, v3};
use world::Sim;

thread_local! {
    static SIMS: RefCell<Vec<Option<Sim>>> = const { RefCell::new(Vec::new()) };
    static ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

fn with<T>(id: u32, f: impl FnOnce(&mut Sim) -> T) -> T {
    SIMS.with(|list| f(list.borrow_mut()[id as usize - 1].as_mut().expect("monde inconnu")))
}

/// Un texte UTF-8 de la mémoire du module.
///
/// # Safety
/// `ptr` pointe sur `len` octets.
unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap_or("")
}

/// Une panique du module (un défaut : le module s'arrête, `unreachable` côté JavaScript) laisse son
/// message et l'endroit du code où elle est née dans le dernier message d'erreur (`sim_error`) : qui
/// l'appelle ensuite (src/shared/native/simModule.ts) sait ce qui s'est passé.
fn keep_panics() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let message = format!("panique : {info}");
            ERROR.with(|e| {
                if let Ok(mut e) = e.try_borrow_mut() {
                    *e = message;
                }
            });
        }));
    });
}

/// Un monde, son sol ; son numéro (à partir de 1).
#[unsafe(no_mangle)]
pub extern "C" fn sim_new() -> u32 {
    keep_panics();
    SIMS.with(|list| {
        let mut list = list.borrow_mut();
        if let Some(i) = list.iter().position(Option::is_none) {
            list[i] = Some(Sim::new());
            return i as u32 + 1;
        }
        list.push(Some(Sim::new()));
        list.len() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_free(id: u32) {
    SIMS.with(|list| list.borrow_mut()[id as usize - 1] = None);
}

/// Une boîte du décor fixe : sa sorte `kind` (UTF-8, `len` octets : « wall », « ramp », « pillar »,
/// « platform »…), son centre, ses demi-dimensions, sa rotation (x, y, z, w), `round` non nul : un cylindre.
///
/// # Safety
/// `kind` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_add_box(
    id: u32, kind: *const u8, len: usize, x: f64, y: f64, z: f64, hx: f64, hy: f64, hz: f64, qx: f64, qy: f64, qz: f64, qw: f64, round: u32,
) {
    let kind = unsafe { text(kind, len) }.to_string();
    with(id, |s| s.add_box(&kind, v3(x, y, z), v3(hx, hy, hz), Q { x: qx, y: qy, z: qz, w: qw }, round != 0));
}

/// Retire le décor fixe (`clearScenery`), comme on change d'arène (`loadArena`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_clear_scenery(id: u32) {
    with(id, |s| s.clear_scenery());
}

/// Les dimensions de l'arène (`ArenaBounds`) : la demi-largeur de son terrain, celle de la zone où rôde
/// l'IA, le rayon du circuit des avions (m).
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_bounds(id: u32, half: f64, roam: f64, circuit: f64) {
    with(id, |s| (s.bounds.half, s.bounds.roam, s.bounds.circuit) = (half, roam, circuit));
}

/// Lance tout le robot `bot` (ses morceaux, ses roues arrachées) à la vitesse (`vx`, `vy`, `vz`)
/// (`setBotVelocity` : un avion qui apparaît en vol, `launchPlane`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_launch(id: u32, bot: u32, vx: f64, vy: f64, vz: f64) {
    with(id, |s| {
        let v = v3(vx, vy, vz);
        for p in s.bots[bot as usize].parts.clone() {
            let rb = s.part(p).rb;
            s.phys.set_linvel(rb, v, true);
        }
        for w in 0..s.bots[bot as usize].wheels.len() {
            if let Some(body) = s.bots[bot as usize].wheels[w].body {
                s.phys.set_linvel(body, v, true);
            }
        }
    });
}

/// L'accessoire de l'emplacement suivant de l'arène : son type `name` (UTF-8, `len` octets), sa
/// position, sa rotation (x, y, z, w ; `qw` NaN : debout, sans rotation), les demi-dimensions de
/// son emplacement (une dalle ; `hx` NaN : aucune) et son échelle (un cylindre ; NaN : aucune) ;
/// son numéro (celui de l'emplacement), ou -1 (le message : `sim_error`).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_add_prop(
    id: u32, name: *const u8, len: usize, x: f64, y: f64, z: f64, qx: f64, qy: f64, qz: f64, qw: f64, hx: f64, hy: f64, hz: f64, scale: f64,
) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    let rot = (!qw.is_nan()).then_some(Q { x: qx, y: qy, z: qz, w: qw });
    let half = (!hx.is_nan()).then_some(v3(hx, hy, hz));
    let scale = (!scale.is_nan()).then_some(scale);
    match with(id, |s| s.add_prop(&name, v3(x, y, z), rot, half, scale)) {
        Ok(i) => i as i32,
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message);
            -1
        }
    }
}

/// L'accessoire `prop` repose sur l'emplacement `on` (`PropSpot.rests`) : quand tous ses appuis ont
/// disparu, il tombe.
#[unsafe(no_mangle)]
pub extern "C" fn sim_prop_rest(id: u32, prop: u32, on: u32) {
    with(id, |s| s.props[prop as usize].as_mut().expect("accessoire retiré").rests.push(on as usize));
}

/// Fait apparaître le robot préfabriqué `name` (UTF-8, `len` octets) en (`x`, `y`, `z`), tourné de
/// `yaw` ; son numéro dans le monde, ou -1 (le message : `sim_error`).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_spawn(id: u32, name: *const u8, len: usize, x: f64, y: f64, z: f64, yaw: f64) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    match with(id, |s| s.spawn(&name, v3(x, y, z), yaw)) {
        Ok(bot) => bot as i32,
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message);
            -1
        }
    }
}

/// Fait apparaître le robot préfabriqué `name` (UTF-8, `len` octets), que conduit l'IA, dans l'équipe
/// `team` (0 : les rouges, 1 : les bleus), en (`x`, `y`, `z`), tourné de `yaw` ; son numéro dans le
/// monde, ou -1 (le message : `sim_error`).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_spawn_ai(id: u32, name: *const u8, len: usize, x: f64, y: f64, z: f64, yaw: f64, team: u32) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    match with(id, |s| if team > 1 { Err(format!("équipe inconnue : {team}")) } else { s.spawn_ai(&name, v3(x, y, z), yaw, team as usize) }) {
        Ok(bot) => bot as i32,
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message);
            -1
        }
    }
}

/// Le dernier message d'erreur, écrit dans `out` (au plus `cap` octets) ; sa longueur.
///
/// # Safety
/// `out` pointe sur `cap` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_error(out: *mut u8, cap: usize) -> usize {
    ERROR.with(|e| {
        let e = e.borrow();
        let n = e.len().min(cap);
        unsafe { std::slice::from_raw_parts_mut(out, n) }.copy_from_slice(&e.as_bytes()[..n]);
        n
    })
}

/// `groundHeight` du plan d'un robot préfabriqué (NaN s'il est inconnu).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_ground_height(name: *const u8, len: usize) -> f64 {
    let name = unsafe { text(name, len) };
    catalog::catalog().robots.get(name).map_or(f64::NAN, |r| robot::ground_height(&r.design))
}

/// Le morceau `piece` de la forme `name` (`shapePieces`) : ses sommets (x, y, z en nombres de 8
/// octets, au plus `cap` sommets) écrits dans `out`, et son volume dans `out[3 · n]` ; le nombre de
/// sommets, ou -1 (forme ou morceau inconnu, ou trop de sommets).
///
/// # Safety
/// `name` pointe sur `len` octets, `out` sur `3 · cap + 1` f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_shape_piece(name: *const u8, len: usize, piece: u32, out: *mut f64, cap: u32) -> i32 {
    let name = unsafe { text(name, len) };
    let Some(p) = shapes::shape_pieces(name).and_then(|pieces| pieces.get(piece as usize)) else { return -1 };
    if p.points.len() > cap as usize {
        return -1;
    }
    let out = unsafe { std::slice::from_raw_parts_mut(out, 3 * p.points.len() + 1) };
    for (i, v) in p.points.iter().enumerate() {
        out[3 * i..3 * i + 3].copy_from_slice(&[v.x, v.y, v.z]);
    }
    out[3 * p.points.len()] = p.volume;
    p.points.len() as i32
}

/// Les commandes du pilote du robot `bot` : gaz, direction (> 0 : à gauche), frein (0 à 1), boost (non nul).
#[unsafe(no_mangle)]
pub extern "C" fn sim_control(id: u32, bot: u32, throttle: f64, steer: f64, brake: f64, boost: u32) {
    with(id, |s| {
        let input = &mut s.bots[bot as usize].input;
        (input.throttle, input.steer, input.brake, input.boost) = (throttle, steer, brake, boost != 0);
    });
}

/// Les commandes de vol du pilote du robot `bot` : monter ou descendre (en avion : cabrer ou piquer),
/// lacet, cap de la caméra (rad), conduite à la caméra (non nul), pilotage manuel d'un avion (non nul),
/// ses gaz, la direction de son regard (`lx`, `ly`, `lz` ; NaN : aucun, au clavier).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sim_flight(id: u32, bot: u32, climb: f64, yaw: f64, heading: f64, relative: u32, manual: u32, power: f64, lx: f64, ly: f64, lz: f64) {
    with(id, |s| {
        let input = &mut s.bots[bot as usize].input;
        (input.climb, input.yaw, input.heading, input.relative, input.manual, input.power) = (climb, yaw, heading, relative != 0, manual != 0, power);
        input.look = (!lx.is_nan()).then_some(v3(lx, ly, lz));
    });
}

/// Le pilote du robot `bot` tient (non nul) ou non la touche qui fait sauter ses mines télécommandées.
#[unsafe(no_mangle)]
pub extern "C" fn sim_detonate(id: u32, bot: u32, on: u32) {
    with(id, |s| s.bots[bot as usize].input.detonate = on != 0);
}

/// La graine du hasard du monde (`Math.random` à graine fixe, comme `seedRandom` de tests/seed.ts) :
/// à donner avant de faire apparaître les robots (leurs tourelles tirent déjà).
#[unsafe(no_mangle)]
pub extern "C" fn sim_seed(id: u32, seed: u32) {
    with(id, |s| s.rng = rng::Rng::new(seed));
}

/// Le niveau de l'eau de l'arène (`arena.water` ; NaN : pas d'eau) : elle éteint les flaques de feu.
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_water(id: u32, level: f64) {
    with(id, |s| s.water = (!level.is_nan()).then_some(level));
}

/// Le relief de l'arène (`ArenaLayout.terrain`), après les boîtes de son décor : son côté (m), ses cases
/// par côté, ses `n` hauteurs aux sommets (nombres de 4 octets, colonne par colonne : un `Float32Array`).
///
/// # Safety
/// `heights` pointe sur `n` f32.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_set_terrain(id: u32, size: f64, cells: u32, heights: *const f32, n: usize) {
    let heights = unsafe { std::slice::from_raw_parts(heights, n) }.to_vec();
    with(id, |s| s.set_terrain(crate::terrain::Terrain { size, cells: cells as usize, heights }));
}

/// La boîte `i` du décor est un tablier sous lequel on passe (`underpass` non nul), qu'on aborde à
/// `approach` m au-delà de ses bouts (NaN : 5 m, par défaut).
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_deck(id: u32, i: u32, underpass: u32, approach: f64) {
    with(id, |s| s.set_deck(i as usize, underpass != 0, (!approach.is_nan()).then_some(approach)));
}

/// Les planchers de vol de l'arène (`airFloor` des avions, `hoverFloor` des robots volants ; 0 : aucun).
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_floors(id: u32, air: f64, hover: f64) {
    with(id, |s| (s.arena.air_floor, s.arena.hover_floor) = (air, hover));
}

/// La profondeur au-delà de laquelle l'eau de l'arène est profonde (`deepWater` ; NaN : jamais) : on
/// s'y noie, les patins y glissent, l'IA ne s'y aventure pas.
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_deep_water(id: u32, depth: f64) {
    with(id, |s| s.arena.deep_water = (!depth.is_nan()).then_some(depth));
}

/// Un lac de lave (`LavaShape` « pool ») : son centre (x, z), son rayon (m).
#[unsafe(no_mangle)]
pub extern "C" fn sim_add_lava_pool(id: u32, x: f64, z: f64, r: f64) {
    with(id, |s| s.arena.lava.push(arena::Lava::pool(x, z, r)));
}

/// Une coulée de lave (`LavaShape` « flow ») : sa largeur (m), ses `n` points (x, z à la suite).
///
/// # Safety
/// `points` pointe sur `2 · n` f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_add_lava_flow(id: u32, width: f64, points: *const f64, n: usize) {
    let flat = unsafe { std::slice::from_raw_parts(points, 2 * n) };
    let points = flat.chunks(2).map(|p| (p[0], p[1])).collect();
    with(id, |s| s.arena.lava.push(arena::Lava::flow(width, points)));
}

/// L'arène est une ville (`urban`, non nul).
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_urban(id: u32, on: u32) {
    with(id, |s| s.arena.urban = on != 0);
}

/// La grille de passage de l'IA (`navGrid(arena)`, faite par le TypeScript) : sa case (m), ses cases
/// par côté, son bord (m), ses `n · n` cases (1 : franchissable).
///
/// # Safety
/// `open` pointe sur `n · n` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_set_nav_grid(id: u32, cell: f64, n: u32, min: f64, open: *const u8) {
    let n = n as usize;
    let open = unsafe { std::slice::from_raw_parts(open, n * n) }.to_vec();
    with(id, |s| s.arena.grid = Some(arena::Grid { cell, min, nav: crate::navgrid::NavGrid::new(n, open) }));
}

/// Le réseau de passage de l'IA (`ArenaLayout.nav`) : ses `n` points (x, z à la suite) et ses `m`
/// liaisons (deux rangs à la suite).
///
/// # Safety
/// `points` pointe sur `2 · n` f64, `links` sur `2 · m` u32.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_set_nav_graph(id: u32, points: *const f64, n: usize, links: *const u32, m: usize) {
    let points = unsafe { std::slice::from_raw_parts(points, 2 * n) }.chunks(2).map(|p| (p[0], p[1])).collect();
    let links: Vec<(usize, usize)> = unsafe { std::slice::from_raw_parts(links, 2 * m) }.chunks(2).map(|l| (l[0] as usize, l[1] as usize)).collect();
    with(id, |s| s.arena.graph = Some(arena::Graph::new(points, &links)));
}

/// L'accessoire de l'emplacement `prop` fait partie du bâtiment `building` (`PropSpot.building`).
#[unsafe(no_mangle)]
pub extern "C" fn sim_prop_building(id: u32, prop: u32, building: u32) {
    with(id, |s| {
        let list = &mut s.arena.buildings;
        if list.len() <= prop as usize {
            list.resize(prop as usize + 1, None);
        }
        list[prop as usize] = Some(building);
        *s.obstacle_cache.borrow_mut() = None;
    });
}

/// Les sommets du rocher d'une boîte de demi-dimensions (`hx`, `hy`, `hz`) placée en (`x`, `z`)
/// (`rockShape`, nombres de 4 octets, au plus `cap`) écrits dans `out` ; leur nombre.
///
/// # Safety
/// `out` pointe sur `cap` f32.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_rock_shape(hx: f64, hy: f64, hz: f64, x: f64, z: f64, out: *mut f32, cap: usize) -> usize {
    let v = arena::rock_shape(v3(hx, hy, hz), x, z);
    let n = v.len().min(cap);
    unsafe { std::slice::from_raw_parts_mut(out, n) }.copy_from_slice(&v[..n]);
    v.len()
}

/// Le robot `owner` (-1 : aucun) d'un monde, s'il existe.
fn owner_of(s: &Sim, owner: i32) -> Result<Option<usize>, String> {
    if owner < 0 {
        return Ok(None);
    }
    if owner as usize >= s.bots.len() {
        return Err(format!("robot inconnu : {owner}"));
    }
    Ok(Some(owner as usize))
}

/// L'explosion du projectile de l'arme `name` (UTF-8, `len` octets) en (`x`, `y`, `z`), dans la
/// direction (`dx`, `dy`, `dz`), à l'origine de laquelle est le robot `owner` (-1 : aucun), comme
/// quand une mine saute (`explode`) : 0, ou -1 (le message : `sim_error`).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_explode(id: u32, name: *const u8, len: usize, x: f64, y: f64, z: f64, dx: f64, dy: f64, dz: f64, owner: i32) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    let done = with(id, |s| {
        let ex = catalog::catalog().weapons.get(&name).and_then(|w| w.explosion).ok_or_else(|| format!("arme sans explosion : {name}"))?;
        let attacker = owner_of(s, owner)?;
        explosion::explode(s, v3(x, y, z), &ex, v3(dx, dy, dz), v3(x, y, z), attacker, None);
        Ok::<(), String>(())
    });
    match done {
        Ok(()) => 0,
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message);
            -1
        }
    }
}

/// Lance un projectile de l'arme `name` (UTF-8, `len` octets) depuis (`x`, `y`, `z`), dans la
/// direction unitaire (`dx`, `dy`, `dz`) (plus sa dispersion), tiré par le robot `shooter` (-1 :
/// aucun, l'ennemi de tous), sa tête chercheuse sur le robot `homing` (-1 : aucun), sans vitesse
/// héritée (`spawnProjectile`) : un obus, une mine, des nanites que l'essai fait partir. 0, ou -1 (le
/// message : `sim_error`).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_fire(id: u32, name: *const u8, len: usize, x: f64, y: f64, z: f64, dx: f64, dy: f64, dz: f64, shooter: i32, homing: i32) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    let done = with(id, |s| {
        let weapon = catalog::catalog().weapons.get_key_value(&name).map(|(k, _)| k.as_str()).ok_or_else(|| format!("arme inconnue : {name}"))?;
        let shooter = owner_of(s, shooter)?;
        let homing = owner_of(s, homing)?;
        let launch = projectiles::Launch { shooter, commander: None, homing, inherit: v3(0.0, 0.0, 0.0), spread: None };
        projectiles::spawn_projectile(s, weapon, v3(x, y, z), v3(dx, dy, dz), launch);
        Ok::<(), String>(())
    });
    match done {
        Ok(()) => 0,
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message);
            -1
        }
    }
}

/// La flaque de feu que laisse le projectile de l'arme `name` (UTF-8, `len` octets) arrivé en (`x`,
/// `y`, `z`), allumée par le robot `owner` (-1 : aucun), s'il y a du sol juste dessous, comme le jet
/// du lance-flammes (`groundBelow`, `spawnGroundFire` ; sans sa chance, que tire le projectile) : 1
/// si une flaque y brûle (nouvelle ou ravivée), 0 sinon, -1 (le message : `sim_error`).
///
/// # Safety
/// `name` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_puddle(id: u32, name: *const u8, len: usize, x: f64, y: f64, z: f64, owner: i32) -> i32 {
    let name = unsafe { text(name, len) }.to_string();
    let done = with(id, |s| {
        let spec = catalog::catalog().weapons.get(&name).and_then(|w| w.puddle).ok_or_else(|| format!("arme sans flaque : {name}"))?;
        let owner = owner_of(s, owner)?;
        Ok::<bool, String>(match fire::ground_below(s, v3(x, y, z), fire::PUDDLE_REACH) {
            Some(ground) => fire::spawn_ground_fire(s, ground, spec, owner),
            None => false,
        })
    });
    match done {
        Ok(lit) => lit as i32,
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message);
            -1
        }
    }
}

/// Avance de `n` pas.
#[unsafe(no_mangle)]
pub extern "C" fn sim_step(id: u32, n: u32) {
    with(id, |s| {
        for _ in 0..n {
            s.step();
        }
    });
}

/// L'étape `k` d'un pas (`Sim::stage`, de 0 à `sim_stage_count() - 1`) : pour mesurer chacune ; les
/// enchaîner fait un pas, au bit près le même.
#[unsafe(no_mangle)]
pub extern "C" fn sim_stage(id: u32, k: u32) {
    with(id, |s| s.stage(k as usize));
}

/// Le nombre d'étapes d'un pas.
#[unsafe(no_mangle)]
pub extern "C" fn sim_stage_count() -> u32 {
    world::STAGES as u32
}

/// Le nombre de morceaux du robot `bot`.
#[unsafe(no_mangle)]
pub extern "C" fn sim_part_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].parts.len() as u32)
}

/// L'état d'un corps lu de Rapier : position, rotation (x, y, z, w), vitesse, vitesse angulaire.
fn body_state(s: &Sim, rb: rapier3d::prelude::RigidBodyHandle) -> [f64; 13] {
    let (t, r, v, w) = (s.phys.translation(rb), s.phys.rotation(rb), s.phys.linvel(rb), s.phys.angvel(rb));
    [t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z]
}

/// L'état du morceau `part` (dans l'ordre où ils sont nés) du robot `bot` : treize nombres de 8
/// octets (`body_state`).
///
/// # Safety
/// `out` pointe sur 13 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_part_state(id: u32, bot: u32, part: u32, out: *mut f64) {
    with(id, |s| {
        let rb = s.part(s.bots[bot as usize].parts[part as usize]).rb;
        unsafe { std::slice::from_raw_parts_mut(out, 13) }.copy_from_slice(&body_state(s, rb));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_wheel_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].wheels.len() as u32)
}

/// L'état d'une roue : sa pose (position, rotation : celle de son corps une fois arrachée), son
/// braquage, son débattement, sa rotation sur l'essieu, sa vitesse de rotation, sa charge, la
/// tension de son moteur, ses points de structure, et où elle est (le rang de son morceau parmi
/// ceux du robot ; -1 arrachée, -2 retirée), jusqu'à quand son moteur est coupé (paralysie locale) :
/// seize nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 16 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_wheel_state(id: u32, bot: u32, wheel: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let w = &b.wheels[wheel as usize];
        let (p, r) = match w.body {
            Some(rb) => (s.phys.translation(rb), s.phys.rotation(rb)),
            None => (w.rb.pos, w.rb.rot),
        };
        let at = match (w.part, w.body) {
            (Some(part), _) => b.parts.iter().position(|&x| x == part).map_or(-3.0, |i| i as f64),
            (None, Some(_)) => -1.0,
            (None, None) => -2.0,
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out, 16) };
        out.copy_from_slice(&[p.x, p.y, p.z, r.x, r.y, r.z, r.w, w.steer, w.travel, w.spin, w.spin_rate, w.load, w.drive, w.hp, at, w.stunned_until]);
    });
}

/// Ce que tient le pilote (automatique ou non) d'un robot en vol : l'altitude qu'il vise, le trim de
/// profondeur d'un avion, l'aide au lacet piloté, et le circuit d'attaque d'un bombardier (sa phase : 0
/// la passe, 1 l'éloignement, 2 le demi-tour, -1 aucun ; la direction de sa passe, x, y, z ; le côté de
/// son demi-tour) : huit nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 8 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_pilot_state(id: u32, bot: u32, out: *mut f64) {
    with(id, |s| {
        let ai = &s.bots[bot as usize].ai;
        let run = ai.bomb_run.map_or([-1.0, 0.0, 0.0, 0.0, 0.0], |r| {
            let phase = match r.phase {
                brain::RunPhase::Pass => 0.0,
                brain::RunPhase::Out => 1.0,
                brain::RunPhase::Turn => 2.0,
            };
            [phase, r.dir.x, r.dir.y, r.dir.z, r.turn]
        });
        let values = [ai.alt, ai.trim, ai.slip, run[0], run[1], run[2], run[3], run[4]];
        unsafe { std::slice::from_raw_parts_mut(out, 8) }.copy_from_slice(&values);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_thruster_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].thrusters.len() as u32)
}

/// L'état d'un moteur (dans l'ordre de `addThrusters`) : le rang de son bloc dans le plan, son rôle (0
/// sustentation, 1 propulsion, 2 autre), le sens de son hélice, sa poussée, l'inclinaison d'un rotor
/// orientable (deux axes), la part de sa pleine poussée qu'il peut donner, la fin de son raté : huit
/// nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 8 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_thruster_state(id: u32, bot: u32, t: u32, out: *mut f64) {
    with(id, |s| {
        let t = s.bots[bot as usize].thrusters[t as usize];
        let role = match t.role {
            robot::Role::Lift => 0.0,
            robot::Role::Cruise => 1.0,
            robot::Role::Trim => 2.0,
        };
        let values = [t.block as f64, role, t.spin, t.thrust, t.tilt_a, t.tilt_b, t.output, t.misfire_until];
        unsafe { std::slice::from_raw_parts_mut(out, 8) }.copy_from_slice(&values);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_melee_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].melee.len() as u32)
}

/// L'état d'une arme de contact (dans l'ordre du plan) : le rang de son bloc, le régime de son rotor
/// (rad/s), son angle, l'instant de son dernier coup (-∞ : jamais) ; sa phase (0 armée, 1 qui frappe,
/// 2 qui revient, 3 qui tient), depuis quand, l'angle de son bras (ou la sortie de sa pointe), d'où il
/// revient, sa fatigue ; sa morsure (1 ou 0, le point, le sens, la surface : 0 un robot, 1 un
/// accessoire, 2 le décor ; la puissance, si elle glisse) ; ce qu'elle a accumulé (dégâts, énergie
/// coupée, depuis quand ; NaN : rien) ; la boule d'un fléau (1 ou 0, sa position, sa vitesse, ce qui
/// s'est enroulé autour du moyeu ; sa chaîne enroulée autour d'un obstacle : 1 ou 0, le point d'appui,
/// la longueur, depuis quand) ; la prise d'une mâchoire (le numéro du robot tenu et le rang de son
/// bloc, -1 : rien ; le glissement, l'écrasement accumulé, le point de la prise dans le repère du
/// robot tenu) : quarante-trois nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 43 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_melee_state(id: u32, bot: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        use melee::{Phase, Surface};
        let a = s.bots[bot as usize].melee[i as usize];
        let phase = match a.phase {
            Phase::Ready => 0.0,
            Phase::Strike => 1.0,
            Phase::Recover => 2.0,
            Phase::Hold => 3.0,
        };
        let flag = |b: bool| if b { 1.0 } else { 0.0 };
        let nan = f64::NAN;
        let mut v = vec![a.block as f64, a.spin, a.angle, a.hit_at, phase, a.phase_t, a.swing, a.from, a.fatigue];
        match a.bite {
            Some(b) => {
                let surface = match b.surface {
                    Surface::Robot => 0.0,
                    Surface::Prop => 1.0,
                    Surface::Scenery => 2.0,
                };
                v.extend([1.0, b.point.x, b.point.y, b.point.z, b.dir.x, b.dir.y, b.dir.z, surface, b.power, flag(b.glance)]);
            }
            None => v.extend([0.0, nan, nan, nan, nan, nan, nan, -1.0, nan, 0.0]),
        }
        match a.gnaw {
            Some(g) => v.extend([g.damage, g.cut, g.since]),
            None => v.extend([nan, nan, nan]),
        }
        match a.ball {
            Some(b) => v.extend([1.0, b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z, b.wound]),
            None => v.extend([0.0, nan, nan, nan, nan, nan, nan, nan]),
        }
        match a.ball.and_then(|b| b.wrap) {
            Some(w) => v.extend([1.0, w.point.x, w.point.y, w.point.z, w.length, w.since]),
            None => v.extend([0.0, nan, nan, nan, nan, nan]),
        }
        match a.grip {
            Some(g) => v.extend([g.bot as f64, g.block as f64, g.slip, g.crush, g.local.x, g.local.y, g.local.z]),
            None => v.extend([-1.0, -1.0, nan, nan, nan, nan, nan]),
        }
        unsafe { std::slice::from_raw_parts_mut(out, 43) }.copy_from_slice(&v);
    });
}

/// Le pilote du robot `bot` tient (non nul) ou non la gâchette, et l'arme qu'il a choisie (`weapon`,
/// UTF-8, `len` octets : un identifiant d'arme de tourelle ou de contact ; vide : aucune, toutes).
///
/// # Safety
/// `weapon` pointe sur `len` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_arm(id: u32, bot: u32, trigger: u32, weapon: *const u8, len: usize) {
    let name = unsafe { text(weapon, len) };
    let c = catalog::catalog();
    let chosen = c.melee.get_key_value(name).map(|(k, _)| k.as_str()).or_else(|| c.weapons.get_key_value(name).map(|(k, _)| k.as_str()));
    with(id, |s| {
        let input = &mut s.bots[bot as usize].input;
        input.trigger = trigger != 0;
        input.weapon = chosen;
    });
}

/// Le point que vise le pilote du robot `bot` (x, y, z ; NaN : aucun, ses tourelles ne visent pas),
/// s'il est au viseur (non nul), s'il tient la touche des leurres (non nul).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sim_aim(id: u32, bot: u32, x: f64, y: f64, z: f64, scope: u32, flares: u32) {
    with(id, |s| {
        let input = &mut s.bots[bot as usize].input;
        input.aim = (!x.is_nan()).then_some(v3(x, y, z));
        input.scope = scope != 0;
        input.flares = flares != 0;
    });
}

/// Le robot `bot` passe dans l'équipe `team` (0 : les rouges, 1 : les bleus) : un pilote chez les
/// bleus, comme `spawnBot(…, team)`. Aussitôt après l'avoir fait apparaître.
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_team(id: u32, bot: u32, team: u32) {
    with(id, |s| s.bots[bot as usize].team = team as usize);
}

/// Paralyse localement les organes du robot `bot` à moins de `radius` m du point (x, y, z), pendant
/// `duration` s (`stunOrgans`, comme la décharge d'une lance électrique : un crochet de l'essai).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sim_stun(id: u32, bot: u32, x: f64, y: f64, z: f64, radius: f64, duration: f64) {
    with(id, |s| emp::stun_organs(s, bot as usize, v3(x, y, z), radius, duration));
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_surface_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].surfaces.len() as u32)
}

/// L'état d'une surface portante (dans l'ordre du plan) : le rang de son bloc, son braquage (une aile
/// fixe : 0) : deux nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 2 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_surface_state(id: u32, bot: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let f = s.bots[bot as usize].surfaces[i as usize];
        unsafe { std::slice::from_raw_parts_mut(out, 2) }.copy_from_slice(&[f.block as f64, f.deflection]);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_support_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].supports.len() as u32)
}

/// L'état d'un appui (dans l'ordre du plan) : le rang de son bloc, la distance au sol sous lui (∞ :
/// rien à portée), sa force d'appui, la phase de sa marche : quatre nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 4 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_support_state(id: u32, bot: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let p = s.bots[bot as usize].supports[i as usize];
        unsafe { std::slice::from_raw_parts_mut(out, 4) }.copy_from_slice(&[p.block as f64, p.contact, p.force, p.phase]);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_block_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].blocks.len() as u32)
}

/// L'état d'un bloc (dans l'ordre du plan) : ses points de structure, s'il est vivant (1 ou 0), le
/// rang de son morceau parmi ceux du robot (-1 s'il est détruit), son feu (secondes qu'il brûlera
/// encore), s'il est perdu (1 ou 0 : détruit, une réparation pourra le faire repousser), jusqu'à quand
/// l'organe qu'il porte est coupé (paralysie locale) : six nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 6 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_block_state(id: u32, bot: u32, block: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let k = &b.blocks[block as usize];
        let at = if k.alive { b.parts.iter().position(|&x| x == k.part).map_or(-3.0, |i| i as f64) } else { -1.0 };
        let lost = if b.lost(block as usize) { 1.0 } else { 0.0 };
        unsafe { std::slice::from_raw_parts_mut(out, 6) }.copy_from_slice(&[k.hp, if k.alive { 1.0 } else { 0.0 }, at, k.burn, lost, k.stunned_until]);
    });
}

/// L'état d'un robot : quand il a été touché pour la dernière fois (-∞ : jamais), le moment avant
/// lequel aucun bloc ne lui repousse, l'énergie de ses batteries (kJ), l'ordre de ses blocs vivants
/// (`bot.blocks`) résumé en un nombre (la somme de leurs numéros pondérés par leur rang), celui de
/// ses blocs perdus (`bot.lost`) de même, jusqu'à quand il est paralysé, et qui l'a soulevé (le
/// numéro du robot dont le flipper l'a lancé, -1 : personne) et jusqu'à quand : huit nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 8 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_bot_state(id: u32, bot: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let order = |list: &[usize]| list.iter().enumerate().fold(0.0, |sum, (rank, &k)| sum + ((rank + 1) * (k + 1)) as f64);
        let (by, until) = b.thrown_by.map_or((-1.0, 0.0), |(by, _, until)| (by as f64, until));
        let values = [b.last_hit, b.rebuild_at, b.energy, order(&b.live), order(&b.lost_order), b.stunned_until, by, until];
        unsafe { std::slice::from_raw_parts_mut(out, 8) }.copy_from_slice(&values);
    });
}

/// L'état de l'IA du robot `bot` : son mode (le rang de `brain::Mode`), sa destination (x, y, z), le
/// temps avant d'en changer, le temps restant dans son mode, ses compteurs de blocage (coincé, bloqué),
/// le sens de sa marche arrière, sa position au dernier pas (`lastPos` : x, y, z), et la portée de ses
/// rayons d'évitement (devant, à gauche, à droite, jusqu'à quand ; NaN avant le premier) : seize
/// nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 16 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_ai_state(id: u32, bot: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let ai = &b.ai;
        let (t, p) = (ai.target, b.last_pos);
        let probes = ai.probes.map_or([f64::NAN; 4], |r| [r.ahead, r.left, r.right, r.until]);
        let values = [
            ai.mode as u32 as f64, t.x, t.y, t.z, ai.timer, ai.mode_t, ai.stuck_t, ai.blocked_t, ai.flip, p.x, p.y, p.z, probes[0], probes[1], probes[2], probes[3],
        ];
        unsafe { std::slice::from_raw_parts_mut(out, 16) }.copy_from_slice(&values);
    });
}

/// Le point vers lequel l'IA du robot `bot` roulerait de sa position au dernier pas à sa destination
/// (`navigate` : de quoi comparer le chemin) : trois nombres de 8 octets. Comme quand l'essai la
/// demande au TypeScript, la navigation garde ce qu'elle garde d'un pas à l'autre (le chemin sur la
/// grille et sa recherche du pas, la route sur le réseau, le coin visé en ville).
///
/// # Safety
/// `out` pointe sur 3 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_nav_goal(id: u32, bot: u32, out: *mut f64) {
    with(id, |s| {
        let b = bot as usize;
        let (pos, target) = (s.bots[b].last_pos, s.bots[b].ai.target);
        let unported = s.stats.unported;
        let goal = navigation::navigate(s, b, pos, target);
        // (une question, pas un pas : ce qui n'est pas porté ne se compte pas deux fois)
        s.stats.unported = unported;
        unsafe { std::slice::from_raw_parts_mut(out, 3) }.copy_from_slice(&[goal.x, goal.y, goal.z]);
    });
}

/// Les ennemis que l'équipe `team` (0 : les rouges, 1 : les bleus) a repérés : la somme de 2 à la
/// puissance de leurs numéros, ou -1 tant que la détection n'a pas tourné.
#[unsafe(no_mangle)]
pub extern "C" fn sim_detected(id: u32, team: u32) -> f64 {
    with(id, |s| match &s.detected[team as usize] {
        None => -1.0,
        Some(seen) => seen.iter().fold(0.0, |sum, &b| sum + (2.0f64).powi(b as i32)),
    })
}

/// Le nombre de flaques de feu au sol.
#[unsafe(no_mangle)]
pub extern "C" fn sim_ground_fire_count(id: u32) -> u32 {
    with(id, |s| s.ground_fires.len() as u32)
}

/// L'état de la flaque de feu `i` (dans l'ordre où elles ont pris) : son centre (x, y, z), son rayon,
/// jusqu'à quand elle brûle, le robot qui l'a allumée (-1 : aucun) : six nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 6 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_ground_fire_state(id: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let f = &s.ground_fires[i as usize];
        let owner = f.owner.map_or(-1.0, |b| b as f64);
        unsafe { std::slice::from_raw_parts_mut(out, 6) }.copy_from_slice(&[f.pos.x, f.pos.y, f.pos.z, f.radius, f.until, owner]);
    });
}

/// Le nombre d'emplacements d'accessoires (présents ou retirés).
#[unsafe(no_mangle)]
pub extern "C" fn sim_prop_count(id: u32) -> u32 {
    with(id, |s| s.props.len() as u32)
}

/// L'état de l'accessoire de l'emplacement `i` : présent (1 ou 0 ; retiré, tout le reste à 0), son
/// corps (treize nombres : `body_state`), ancré (1 ou 0), ses points de structure, son état (0
/// intact, 1 mèche, 2 fuite) et le temps qui lui reste, la direction de sa fuite (x, z), son feu, sa
/// part noircie, jusqu'à quand il laisse passer les robots (0 : non), la vitesse de ses éclats s'il
/// a été brisé par un robot (x, y, z ; sinon 0) : vingt-six nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 26 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_prop_state(id: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let out = unsafe { std::slice::from_raw_parts_mut(out, 26) };
        out.fill(0.0);
        let Some(p) = s.props[i as usize].as_ref() else { return };
        out[0] = 1.0;
        out[1..14].copy_from_slice(&body_state(s, p.rb));
        let (kind, left, leak) = match p.state {
            props::PropState::Intact => (0.0, 0.0, v3(0.0, 0.0, 0.0)),
            props::PropState::Fuse { left } => (1.0, left, v3(0.0, 0.0, 0.0)),
            props::PropState::Venting { left, leak } => (2.0, left, leak),
        };
        let struck = p.struck.unwrap_or(v3(0.0, 0.0, 0.0));
        let fixed = if p.fixed { 1.0 } else { 0.0 };
        out[14..26].copy_from_slice(&[fixed, p.hp, kind, left, leak.x, leak.z, p.burn, p.charred, p.yielding, struck.x, struck.y, struck.z]);
    });
}

/// Le nombre de liaisons rompues du robot `bot`.
#[unsafe(no_mangle)]
pub extern "C" fn sim_cut_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].cuts.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_debris_count(id: u32) -> u32 {
    with(id, |s| s.debris.len() as u32)
}

/// L'état du débris `i` (du plus vieux au plus jeune) : treize nombres de 8 octets (`body_state`).
///
/// # Safety
/// `out` pointe sur 13 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_debris_state(id: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let rb = s.debris[i as usize].rb;
        unsafe { std::slice::from_raw_parts_mut(out, 13) }.copy_from_slice(&body_state(s, rb));
    });
}

/// Le combat (`sim.combat`) : les tourelles de l'IA visent et tirent, sa tactique la mène (non
/// nul). À régler avant de faire apparaître les robots : au combat, un robot de l'IA dont une arme
/// n'est pas encore maniée est refusé.
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_combat(id: u32, on: u32) {
    with(id, |s| s.combat = on != 0);
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_turret_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].turrets.len() as u32)
}

/// L'état d'une tourelle (dans l'ordre du plan) : son lacet, son site, l'état de son arme (cadence,
/// chaleur, surchauffe, coups, rechargement), le robot qu'elle vise (-1 : aucun), le temps avant d'en
/// changer, le point qu'elle vise (x, y, z ; NaN : aucun), son erreur de visée (x, y, z), l'heure de
/// son dernier tir, le prochain tir de son arme (`nextShot` ; -∞ : jamais encore), et son verrou (le
/// robot verrouillé, -1 : aucun ; depuis combien de temps ; depuis combien de temps il est caché) :
/// vingt nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 20 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_turret_state(id: u32, bot: u32, turret: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let t = &b.turrets[turret as usize];
        let a = t.arm;
        let aim = t.aim.unwrap_or(v3(f64::NAN, f64::NAN, f64::NAN));
        let next = b.next_shot.iter().find(|e| e.0 == t.weapon).map_or(f64::NEG_INFINITY, |e| e.1);
        let values = [
            t.yaw, t.pitch, a.cooldown, a.heat, if a.overheated { 1.0 } else { 0.0 }, a.ammo, a.restock, t.target.map_or(-1.0, |x| x as f64), t.retarget,
            aim.x, aim.y, aim.z, t.wobble.x, t.wobble.y, t.wobble.z, t.fired_at, next, t.lock_on.map_or(-1.0, |x| x as f64), t.lock_time, t.lock_hidden,
        ];
        unsafe { std::slice::from_raw_parts_mut(out, 20) }.copy_from_slice(&values);
    });
}

/// La tactique du robot `bot` : son adversaire (-1 : aucun), quand il l'a vu pour la dernière fois,
/// le sens où il tourne autour, le temps avant de revoir son plan, le temps passé à couvert, l'instant
/// avant lequel il ne s'y remet pas, le dernier ennemi qui l'a touché (-1 : aucun), et ses leurres
/// (salves, temps passé à en regagner une, pas de salve avant) : dix nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 10 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_tactics_state(id: u32, bot: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let t = b.ai.tactics;
        let f = b.flares;
        let values = [
            t.foe.map_or(-1.0, |x| x as f64), t.seen_at, t.orbit, t.plan_t, t.cover_t, t.cover_ban, b.last_attacker.map_or(-1.0, |x| x as f64), f.charges, f.restock,
            f.ready_at,
        ];
        unsafe { std::slice::from_raw_parts_mut(out, 10) }.copy_from_slice(&values);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_projectile_count(id: u32) -> u32 {
    with(id, |s| s.projectiles.len() as u32)
}

/// L'état du projectile `i` (dans l'ordre où ils sont partis) : le robot qui l'a tiré (-1 : aucun),
/// d'où il est parti (x, y, z), sa position, sa vitesse, son âge, les dégâts qu'il peut encore
/// infliger, la tourelle qui le téléguide (son rang parmi celles du tireur ; -1 : aucune), la cible de
/// sa tête chercheuse (-1 : aucune), les points de sa coque, s'il a été abattu, s'il a perdu sa cible,
/// depuis combien de temps il ne la voit plus, le leurre qui l'a détourné (son rang parmi les
/// projectiles ; -1 : aucun), le nombre de leurres qu'il a vus, et une mine : posée (1 ou 0), les équipes
/// qui l'ont repérée (la somme de 2 à la puissance de leurs numéros), le prochain signal d'un capteur,
/// le robot et le bloc auxquels elle est collée (-1 : aucun), l'instant où elle éclate (NaN : elle
/// guette) : vingt-six nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 26 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_projectile_state(id: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let p = &s.projectiles[i as usize];
        let (stuck_bot, stuck_block) = p.stuck.map_or((-1.0, -1.0), |st| (st.bot as f64, st.block as f64));
        let values = [
            p.shooter.map_or(-1.0, |x| x as f64), p.origin.x, p.origin.y, p.origin.z, p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.age, p.damage,
            p.commander.map_or(-1.0, |x| x as f64), p.homing.map_or(-1.0, |x| x as f64), p.hp, if p.blown { 1.0 } else { 0.0 }, if p.lost { 1.0 } else { 0.0 },
            p.blind, p.decoy.and_then(|d| s.projectiles.iter().position(|q| q.id == d)).map_or(-1.0, |x| x as f64), p.tried.len() as f64,
            if p.landed { 1.0 } else { 0.0 }, p.spotted.iter().fold(0.0, |m, &t| m + (2.0f64).powi(t as i32)), p.ping_at, stuck_bot, stuck_block,
            p.fuse.unwrap_or(f64::NAN),
        ];
        unsafe { std::slice::from_raw_parts_mut(out, 26) }.copy_from_slice(&values);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_smoke_count(id: u32) -> u32 {
    with(id, |s| s.smokes.len() as u32)
}

/// L'état du nuage de fumée `i` (dans l'ordre où ils sont apparus) : son centre (x, y, z), son rayon
/// final, quand il est né, sa durée : six nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 6 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_smoke_state(id: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let c = &s.smokes[i as usize];
        unsafe { std::slice::from_raw_parts_mut(out, 6) }.copy_from_slice(&[c.pos.x, c.pos.y, c.pos.z, c.radius, c.born, c.life]);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_barrier_count(id: u32) -> u32 {
    with(id, |s| s.barriers.len() as u32)
}

/// L'état du mur d'énergie `i` (dans l'ordre où ils se sont déployés) : son équipe, son centre (x, y,
/// z), sa normale (x, y, z), sa largeur, sa hauteur, ses points, jusqu'à quand il tient : onze
/// nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 11 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_barrier_state(id: u32, i: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.barriers[i as usize];
        let values = [b.team as f64, b.center.x, b.center.y, b.center.z, b.normal.x, b.normal.y, b.normal.z, b.width, b.height, b.hp, b.until];
        unsafe { std::slice::from_raw_parts_mut(out, 11) }.copy_from_slice(&values);
    });
}

/// Ce qui s'est passé depuis la création du monde : chocs, lots de dégâts, blocs détruits,
/// liaisons rompues, robots hors de combat, roues arrachées, roues retirées, ce qui n'est pas porté,
/// tirages du hasard, explosions, accessoires retirés, accessoires libérés, blocs allumés, blocs
/// éteints, événements du feu des accessoires, blocs repoussés, blocs réparés, flaques de feu
/// allumées, flaques éteintes, tirs, projectiles lancés, projectiles qui ont fini leur course, impacts,
/// robots touchés par une arme, signaux des capteurs, mines qui bondissent, mines qui se collent,
/// impulsions électromagnétiques, robots paralysés, nuages de fumée lâchés, dissipés, murs d'énergie
/// déployés, touchés, éteints ou brisés, coups des armes de contact, paralysies locales : trente-six
/// nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 36 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_stats(id: u32, out: *mut f64) {
    with(id, |s| {
        let t = s.stats;
        let values = [
            t.collisions, t.damage, t.destroyed, t.links_broken, t.killed, t.wheels_released, t.wheels_removed, t.unported, 0, t.explosions,
            t.props_removed, t.props_released, t.fires_started, t.fires_ended, t.prop_fire_events, t.rebuilt, t.repaired,
            t.ground_fires_added, t.ground_fires_removed, t.shots, t.projectiles_added, t.projectiles_removed, t.impacts, t.hits,
            t.mine_pings, t.mine_bounces, t.mine_sticks, t.emp_bursts, t.stuns, t.smokes_added, t.smokes_removed, t.barriers_added, t.barrier_hits,
            t.barriers_removed, t.melee_hits, t.organs_stunned,
        ];
        let out = unsafe { std::slice::from_raw_parts_mut(out, 36) };
        for (o, v) in out.iter_mut().zip(values) {
            *o = v as f64;
        }
        out[8] = s.rng.draws as f64;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_robot_roule() {
        let mut sim = Sim::new();
        let design = &catalog::catalog().robots["trike"].design;
        let y = robot::ground_height(design) + 0.03;
        let bot = sim.spawn("trike", v3(0.0, y, 0.0), 0.0).unwrap();
        for _ in 0..60 {
            sim.step();
        }
        sim.bots[bot].input.throttle = 1.0;
        for _ in 0..180 {
            sim.step();
        }
        let rb = sim.part(sim.bots[bot].parts[0]).rb;
        let p = sim.phys.translation(rb);
        assert!(p.z > 5.0, "le tricycle avance : z = {}", p.z);
        assert!(sim.spawn("piano", v3(5.0, 3.0, 0.0), 0.0).is_err(), "un robot inconnu");
    }

    #[test]
    fn un_robot_qui_heurte_un_mur_s_abime() {
        // Le mille-pattes, lancé contre un mur : des blocs détruits, des liaisons rompues, des morceaux
        let mut sim = Sim::new();
        sim.add_box("wall", v3(0.0, 0.6, -36.0), v3(36.5, 0.6, 0.5), vec::NO_ROTATION, false);
        sim.rng = rng::Rng::new(7);
        let y = robot::ground_height(&catalog::catalog().robots["centi"].design) + 0.03;
        let bot = sim.spawn("centi", v3(0.0, y, 8.0), std::f64::consts::PI).unwrap();
        for i in 0..9 * 60 {
            sim.bots[bot].input = robot::Input { throttle: if i < 60 { 0.0 } else { 1.0 }, boost: i >= 60, ..robot::Input::default() };
            sim.step();
        }
        let s = sim.stats;
        assert!(s.collisions > 0 && s.destroyed > 0, "il s'est abîmé : {} chocs, {} blocs détruits", s.collisions, s.destroyed);
        assert!(sim.bots[bot].parts.len() > 1, "il s'est séparé en morceaux");
        assert_eq!(s.links_broken as usize, sim.bots[bot].cuts.len());
        assert_eq!(s.unported, 0);
    }

    #[test]
    fn un_baril_ecrase_contre_un_mur_explose_et_met_le_feu() {
        // Le char lancé contre un baril coincé au pied du mur sud, entre des caisses
        let mut sim = Sim::new();
        sim.add_box("wall", v3(0.0, 0.6, -36.0), v3(36.5, 0.6, 0.5), vec::NO_ROTATION, false);
        sim.rng = rng::Rng::new(13);
        sim.add_prop("barrel", v3(0.0, 0.5, -35.1), None, None, None).unwrap();
        for x in [2.8, -2.8] {
            sim.add_prop("crate", v3(x, 0.5, -35.0), None, None, None).unwrap();
        }
        assert!(sim.add_prop("piano", v3(0.0, 0.5, 0.0), None, None, None).is_err());
        let y = robot::ground_height(&catalog::catalog().robots["tank"].design) + 0.03;
        let bot = sim.spawn("tank", v3(0.0, y, -22.0), std::f64::consts::PI).unwrap();
        for i in 0..9 * 60 {
            sim.bots[bot].input = robot::Input { throttle: if i < 60 { 0.0 } else { 1.0 }, boost: i >= 60, ..robot::Input::default() };
            sim.step();
        }
        let s = sim.stats;
        assert_eq!(s.explosions, 1, "le baril a sauté");
        assert!(sim.props[0].is_none(), "le baril n'est plus là");
        assert!(s.destroyed > 0 && s.fires_started > 0, "le char est abîmé et en feu : {} blocs détruits, {} allumés", s.destroyed, s.fires_started);
        assert_eq!(s.unported, 0);
    }

    #[test]
    fn un_mecanicien_qui_heurte_un_mur_se_repare() {
        // Lancé contre le mur sud, un peu de recul, puis le calme : son module de réparation travaille
        let mut sim = Sim::new();
        sim.add_box("wall", v3(0.0, 0.6, -36.0), v3(36.5, 0.6, 0.5), vec::NO_ROTATION, false);
        sim.rng = rng::Rng::new(11);
        let y = robot::ground_height(&catalog::catalog().robots["mechanic"].design) + 0.03;
        let bot = sim.spawn("mechanic", v3(0.0, y, -14.0), std::f64::consts::PI).unwrap();
        for i in 0..23 * 60 {
            let input = match i {
                0..60 => robot::Input::default(),
                60..540 => robot::Input { throttle: 1.0, boost: true, ..robot::Input::default() },
                540..660 => robot::Input { throttle: -0.5, ..robot::Input::default() },
                _ => robot::Input::default(),
            };
            sim.bots[bot].input = input;
            sim.step();
        }
        let s = sim.stats;
        assert!(s.destroyed > 0 && s.rebuilt == s.destroyed, "{} blocs détruits, {} repoussés", s.destroyed, s.rebuilt);
        assert!(s.repaired > 0);
        let b = &sim.bots[bot];
        assert!((0..b.blocks.len()).all(|k| !b.lost(k)), "plus de bloc perdu");
        assert_eq!(b.live.len(), b.blocks.len());
    }

    /// Les murs et les piliers du Dépôt (sans ses rampes).
    fn depot_walls_and_pillars(sim: &mut Sim) {
        for (x, z, hx, hz) in [(0.0, -36.0, 36.5, 0.5), (-36.0, 0.0, 0.5, 36.5), (0.0, 36.0, 36.5, 0.5), (36.0, 0.0, 0.5, 36.5)] {
            sim.add_box("wall", v3(x, 0.6, z), v3(hx, 0.6, hz), vec::NO_ROTATION, false);
        }
        for (x, z) in [(12.0, 12.0), (-12.0, 14.0), (14.0, -14.0), (-10.0, -18.0)] {
            sim.add_box("pillar", v3(x, 1.5, z), v3(0.8, 1.5, 0.8), vec::NO_ROTATION, false);
        }
    }

    #[test]
    fn l_ia_patrouille_et_contourne_les_piliers() {
        let mut sim = Sim::new();
        depot_walls_and_pillars(&mut sim);
        sim.rng = rng::Rng::new(5);
        let mut bots = Vec::new();
        for (i, id) in ["trike", "scarab", "tank"].into_iter().enumerate() {
            let y = robot::ground_height(&catalog::catalog().robots[id].design) + 0.03;
            bots.push(sim.spawn_ai(id, v3(-10.0 + 10.0 * i as f64, y, -27.0), 0.0, i % 2).unwrap());
        }
        let start: Vec<vec::V3> = bots.iter().map(|&b| sim.bots[b].last_pos).collect();
        let mut targets = 0;
        let mut corners = 0;
        let mut last = bots.iter().map(|&b| sim.bots[b].ai.target).collect::<Vec<_>>();
        for _ in 0..40 * 60 {
            sim.step();
            for (k, &b) in bots.iter().enumerate() {
                let (pos, target) = (sim.bots[b].last_pos, sim.bots[b].ai.target);
                if target != last[k] {
                    targets += 1;
                    last[k] = target;
                }
                let goal = navigation::navigate(&mut sim, b, pos, target);
                if goal != target {
                    corners += 1;
                }
            }
        }
        assert!(targets > bots.len(), "des destinations de patrouille : {targets}");
        assert!(corners > 0, "des coins de pilier visés");
        for (k, &b) in bots.iter().enumerate() {
            let p = sim.bots[b].last_pos;
            assert!(navigation::flat_distance(p, start[k]) > 5.0, "le robot {b} a roulé");
        }
        // (rouges et bleus se voient, au moins de temps en temps : l'arène est petite)
        assert!(sim.detected.iter().all(Option::is_some));
        assert_eq!(sim.stats.unported, 0);
    }

    #[test]
    fn un_choc_fait_fuir_ou_foncer() {
        // Un robot fait pour charger (le char) et un qui fuit (le scarabée) : une explosion entre eux
        let mut sim = Sim::new();
        sim.rng = rng::Rng::new(3);
        let mut bots = Vec::new();
        for (x, id) in [(-3.0, "tank"), (3.0, "scarab")] {
            let y = robot::ground_height(&catalog::catalog().robots[id].design) + 0.03;
            bots.push(sim.spawn_ai(id, v3(x, y, 0.0), 0.0, 0).unwrap());
        }
        for _ in 0..30 {
            sim.step();
        }
        let barrel = catalog::catalog().props["barrel"].explosion.unwrap();
        explosion::explode(&mut sim, v3(0.0, 0.3, 0.0), &barrel, v3(0.0, 1.0, 0.0), v3(0.0, 0.3, 0.0), None, None);
        assert_eq!(sim.bots[bots[0]].ai.mode, brain::Mode::Charge);
        assert_eq!(sim.bots[bots[1]].ai.mode, brain::Mode::Flee);
        let t = sim.bots[bots[1]].ai.target;
        assert!(t.x > 10.0, "il fuit à l'opposé de l'explosion : {t:?}");
    }

    #[test]
    fn au_combat_l_ia_vise_tire_et_touche() {
        // Le tricycle (un fusil) et le scarabée (un canon) face à face au Dépôt : ils s'engagent,
        // tirent et se touchent
        let mut sim = Sim::new();
        depot_walls_and_pillars(&mut sim);
        sim.combat = true;
        sim.rng = rng::Rng::new(9);
        let mut bots = Vec::new();
        for (z, yaw, team, id) in [(-15.0, 0.0, 0, "trike"), (15.0, std::f64::consts::PI, 1, "scarab")] {
            let y = robot::ground_height(&catalog::catalog().robots[id].design) + 0.03;
            bots.push(sim.spawn_ai(id, v3(0.0, y, z), yaw, team).unwrap());
        }
        for _ in 0..20 * 60 {
            sim.step();
        }
        let s = sim.stats;
        assert!(s.shots > 10 && s.hits > 0, "{} tirs, {} robots touchés", s.shots, s.hits);
        assert_eq!(s.projectiles_added, s.projectiles_removed + sim.projectiles.len() as u32);
        assert!(bots.iter().any(|&b| sim.bots[b].ai.tactics.foe.is_some() || !sim.bots[b].cockpit_alive()));
        assert_eq!(s.unported, 0);
    }

    #[test]
    fn une_impulsion_paralyse_un_robot_le_temps_qu_elle_dure() {
        // Le pilote d'un char, gaz à fond, batteries presque vides : l'impulsion coupe tout, puis il repart
        let mut sim = Sim::new();
        sim.rng = rng::Rng::new(5);
        let y = robot::ground_height(&catalog::catalog().robots["tank"].design) + 0.03;
        let bot = sim.spawn("tank", v3(0.0, y, 0.0), 0.0).unwrap();
        for _ in 0..60 {
            sim.step();
        }
        sim.bots[bot].input = robot::Input { throttle: 1.0, ..robot::Input::default() };
        sim.bots[bot].energy = 1.0;
        let pulse = catalog::catalog().weapons["emp"].projectile.emp.unwrap();
        let at = sim.bots[bot].last_pos;
        emp::emp_pulse(&mut sim, at, &pulse);
        assert!(emp::is_stunned(&sim, bot) && sim.stats.stuns == 1);
        for _ in 0..60 {
            sim.step();
        }
        let b = &sim.bots[bot];
        assert_eq!(b.ai.mode, brain::Mode::Stunned);
        assert!(b.wheels.iter().all(|w| !w.powered && !w.engaged && w.drive == 0.0), "roue libre");
        assert_eq!(b.energy, 1.0, "le générateur ne recharge pas");
        for _ in 0..4 * 60 {
            sim.step();
        }
        let b = &sim.bots[bot];
        assert!(!emp::is_stunned(&sim, bot) && b.ai.mode == brain::Mode::Patrol);
        assert!(b.energy > 1.0 && b.wheels.iter().any(|w| w.powered && w.drive > 0.0), "il repart");
    }

    #[test]
    fn la_fumee_grandit_cache_puis_se_dissipe() {
        let mut sim = Sim::new();
        let spec = catalog::catalog().weapons["smoke"].projectile.smoke.unwrap();
        smoke::release_smoke(&mut sim, v3(0.0, 1.0, 0.0), &spec);
        let (a, b) = (v3(-10.0, 1.0, 0.0), v3(10.0, 1.0, 0.0));
        assert!(!smoke::smoke_blocks(&sim, a, b), "à sa naissance, il ne cache rien");
        for _ in 0..90 {
            sim.step();
        }
        assert!(smoke::smoke_blocks(&sim, a, b));
        assert!(!smoke::smoke_blocks(&sim, v3(-10.0, 1.0, 8.0), v3(10.0, 1.0, 8.0)), "à côté du nuage");
        for _ in 0..13 * 60 {
            sim.step();
        }
        assert!(sim.smokes.is_empty() && sim.stats.smokes_removed == 1);
    }

    #[test]
    fn un_mur_d_energie_arrete_les_tirs_ennemis_pas_ceux_de_son_equipe() {
        // Le projecteur d'un char rouge, tourné vers le nord : le mur se déploie 5 m plus loin
        let mut sim = Sim::new();
        let y = robot::ground_height(&catalog::catalog().robots["tank"].design) + 0.03;
        let bot = sim.spawn("tank", v3(0.0, y, -10.0), 0.0).unwrap();
        let launch = projectiles::Launch { shooter: Some(bot), commander: None, homing: None, inherit: v3(0.0, 0.0, 0.0), spread: None };
        projectiles::spawn_projectile(&mut sim, "barrier", v3(0.0, 1.0, -8.0), v3(0.0, 0.0, 1.0), launch);
        for _ in 0..30 {
            sim.step();
        }
        assert_eq!(sim.barriers.len(), 1);
        let wall = &sim.barriers[0];
        assert!((wall.center.z + 3.0).abs() < 0.6 && wall.team == 0, "devant lui : {:?}", wall.center);
        let (from, dir) = (v3(0.0, 1.0, 10.0), v3(0.0, 0.0, -1.0));
        assert!(barriers::barrier_on_path(&sim, from, dir, 30.0, Some(1)).is_some(), "un tir ennemi");
        assert!(barriers::barrier_on_path(&sim, from, dir, 30.0, Some(0)).is_none(), "un tir allié");
        assert!(barriers::barrier_between(&sim, from, v3(0.0, 1.0, -10.0), None));
        barriers::damage_barrier(&mut sim, 0, 1000.0, v3(0.0, 0.0, 0.0));
        assert!(sim.barriers.is_empty() && sim.stats.barriers_removed == 1, "brisé");
    }

    #[test]
    fn le_napalm_laisse_une_flaque_qui_brule_puis_s_eteint() {
        // Une mine incendiaire saute à côté du camion, arrêté : ses blocs brûlent, une flaque reste
        // sept secondes au sol ; une autre, sous l'eau, ne prend pas
        let mut sim = Sim::new();
        sim.rng = rng::Rng::new(11);
        let y = robot::ground_height(&catalog::catalog().robots["truck"].design) + 0.03;
        sim.spawn("truck", v3(0.0, y, -20.0), 0.0).unwrap();
        // (posé d'abord : les requêtes de Rapier ne voient un collider qu'après un pas, le sol compris)
        for _ in 0..60 {
            sim.step();
        }
        let napalm = catalog::catalog().weapons["fireMine"].explosion.unwrap();
        explosion::explode(&mut sim, v3(2.5, 0.3, -20.0), &napalm, v3(0.0, 1.0, 0.0), v3(2.5, 0.3, -20.0), None, None);
        assert_eq!(sim.ground_fires.len(), 1);
        assert!(sim.ground_fires[0].pos.y.abs() < 1e-6, "au sol : {}", sim.ground_fires[0].pos.y);
        let puddle = catalog::catalog().weapons["flamer"].puddle.unwrap();
        assert!(fire::spawn_ground_fire(&mut sim, v3(2.6, 0.0, -20.0), puddle, None), "ravivée");
        sim.water = Some(0.4);
        assert!(!fire::spawn_ground_fire(&mut sim, v3(-10.0, 0.0, -10.0), puddle, None), "sous l'eau");
        assert_eq!(sim.ground_fires.len(), 1);
        for _ in 0..8 * 60 {
            sim.step();
        }
        let s = sim.stats;
        assert_eq!((s.ground_fires_added, s.ground_fires_removed), (1, 1), "allumée, puis éteinte");
        assert!(sim.ground_fires.is_empty());
        assert!(s.fires_started > 0 && s.destroyed > 0);
    }

    #[test]
    fn le_jet_du_dragster_brule_ce_qui_est_derriere_lui() {
        // Le dragster piloté, le nez contre le mur sud, au boost : ses turboréacteurs poussent et
        // chauffent les caisses posées derrière lui ; ses batteries paient
        let mut sim = Sim::new();
        sim.add_box("wall", v3(0.0, 0.6, -36.0), v3(36.5, 0.6, 0.5), vec::NO_ROTATION, false);
        sim.rng = rng::Rng::new(7);
        for (x, z) in [(0.8, -26.0), (-0.8, -26.4)] {
            sim.add_prop("crate", v3(x, 0.5, z), None, None, None).unwrap();
        }
        let y = robot::ground_height(&catalog::catalog().robots["dragster"].design) + 0.03;
        let bot = sim.spawn("dragster", v3(0.0, y, -32.2), std::f64::consts::PI).unwrap();
        assert_eq!(sim.bots[bot].thrusters.len(), 4);
        assert!(sim.bots[bot].thrusters.iter().all(|t| t.role == robot::Role::Cruise));
        for _ in 0..60 {
            sim.step();
        }
        let full = sim.bots[bot].energy;
        sim.bots[bot].input = robot::Input { throttle: 1.0, boost: true, ..robot::Input::default() };
        for _ in 0..8 * 60 {
            sim.step();
        }
        let b = &sim.bots[bot];
        assert!(b.thrusters.iter().all(|t| t.thrust > 0.9 * 700.0), "à pleine poussée");
        assert!(b.energy < full, "les batteries paient");
        assert!(sim.stats.prop_fire_events > 0, "le bois a pris feu");
        assert_eq!(sim.stats.unported, 0);
    }

    #[test]
    fn un_drone_de_l_ia_decolle_et_patrouille() {
        let mut sim = Sim::new();
        sim.rng = rng::Rng::new(4);
        let y = robot::ground_height(&catalog::catalog().robots["drone"].design) + 0.03;
        let bot = sim.spawn_ai("drone", v3(0.0, y, -10.0), 0.0, 0).unwrap();
        let alt = sim.bots[bot].ai.alt;
        assert!((4.5..6.5).contains(&alt), "son altitude, tirée au hasard : {alt}");
        let start = sim.bots[bot].last_pos;
        for _ in 0..8 * 60 {
            sim.step();
        }
        let p = sim.bots[bot].last_pos;
        assert!((p.y - alt).abs() < 1.5, "à son altitude : {} pour {alt}", p.y);
        assert!(navigation::flat_distance(p, start) > 5.0, "il a volé vers sa destination");
        assert_eq!(sim.stats.unported, 0);
    }

    #[test]
    fn un_avion_de_l_ia_tourne_sur_le_circuit() {
        // L'Avion lancé en vol sur le circuit (comme `launchPlane`) : il vole, ses gouvernes braquent,
        // son hélice tourne avec son moteur
        let mut sim = Sim::new();
        sim.rng = rng::Rng::new(6);
        let bot = sim.spawn_ai("plane", v3(35.0, 12.0, 0.0), 0.0, 0).unwrap();
        let speed = catalog::catalog().robots["plane"].speed;
        for p in sim.bots[bot].parts.clone() {
            let rb = sim.part(p).rb;
            sim.phys.set_linvel(rb, v3(0.0, 0.0, speed), true);
        }
        assert_eq!(sim.bots[bot].melee.len(), 1, "l'hélice tranchante");
        for _ in 0..10 * 60 {
            sim.step();
        }
        let b = &sim.bots[bot];
        assert!(b.last_pos.y > 3.0, "il vole : {}", b.last_pos.y);
        assert!(b.surfaces.iter().any(|s| s.deflection != 0.0), "ses gouvernes braquent");
        assert!(b.melee[0].spin > 10.0, "son hélice tourne : {}", b.melee[0].spin);
        assert_eq!(b.ai.mode, brain::Mode::Patrol);
        assert_eq!(sim.stats.unported, 0);
    }

    #[test]
    fn les_armes_de_contact_de_l_ia_frappent_mordent_et_tiennent() {
        // Le Cogneur (marteau), le Scieur (scie qui mord), le Broyeur (mâchoire) et le Duelliste
        // (lame laser, lance qui paralyse), chacun de l'IA contre une cible arrêtée, chez les bleus
        for (id, prey) in [("pounder", "truck"), ("sawyer", "tank"), ("crusher", "trike"), ("duelist", "bulwark")] {
            let mut sim = Sim::new();
            depot_walls_and_pillars(&mut sim);
            sim.combat = true;
            sim.rng = rng::Rng::new(7);
            let y = robot::ground_height(&catalog::catalog().robots[id].design) + 0.03;
            let bot = sim.spawn_ai(id, v3(0.0, y, -24.0), 0.0, 0).unwrap();
            let y = robot::ground_height(&catalog::catalog().robots[prey].design) + 0.03;
            let target = sim.spawn(prey, v3(0.0, y, -13.0), std::f64::consts::FRAC_PI_2).unwrap();
            sim_set_team_of(&mut sim, target, 1);
            let mut bites = 0;
            let mut grips = 0;
            for _ in 0..12 * 60 {
                sim.step();
                bites += sim.bots[bot].melee.iter().filter(|a| a.bite.is_some()).count();
                grips += sim.bots[bot].melee.iter().filter(|a| a.grip.is_some()).count();
            }
            let s = sim.stats;
            assert!(s.melee_hits > 0 || bites > 0, "{id} : ni coup ni morsure");
            assert!(s.hits > 0, "{id} : {} robots touchés", s.hits);
            match id {
                "sawyer" => assert!(bites > 0, "la scie mord"),
                "crusher" => assert!(grips > 0, "la mâchoire tient"),
                "duelist" => assert!(s.organs_stunned > 0, "la lance paralyse"),
                _ => {}
            }
            assert_eq!(s.unported, 0);
        }
    }

    /// Le robot `bot` passe dans l'équipe `team` (comme `sim_set_team`).
    fn sim_set_team_of(sim: &mut Sim, bot: usize, team: usize) {
        sim.bots[bot].team = team;
    }

    #[test]
    fn le_pilote_vise_tire_et_fait_sauter_son_ogive() {
        // Le pilote d'un Scarabée (canon, en cloche) et celui d'un Porte-ogive, contre un Camion arrêté
        let mut sim = Sim::new();
        depot_walls_and_pillars(&mut sim);
        sim.rng = rng::Rng::new(7);
        let height = |id: &str| robot::ground_height(&catalog::catalog().robots[id].design) + 0.03;
        let scarab = sim.spawn("scarab", v3(-4.0, height("scarab"), -24.0), 0.0).unwrap();
        let carrier = sim.spawn("carrier", v3(4.0, height("carrier"), -26.0), 0.0).unwrap();
        let truck = sim.spawn("truck", v3(0.0, height("truck"), -8.0), std::f64::consts::FRAC_PI_2).unwrap();
        sim_set_team_of(&mut sim, truck, 1);
        let mark = v3(0.0, 1.1, -8.0);
        sim.bots[scarab].input = robot::Input { aim: Some(mark), trigger: true, ..robot::Input::default() };
        // (l'ogive part vers le ciel, puis un nouveau clic la fait sauter en vol)
        let high = v3(14.0, 12.0, -12.0);
        sim.bots[carrier].input = robot::Input { aim: Some(high), trigger: true, weapon: Some("warhead"), ..robot::Input::default() };
        for i in 0..5 * 60 {
            if i == 30 {
                sim.bots[carrier].input.trigger = false;
            }
            if i == 90 {
                sim.bots[carrier].input.trigger = true;
            }
            sim.step();
        }
        let s = sim.stats;
        assert!(s.shots >= 3, "{} tirs", s.shots);
        assert!(s.hits > 0, "{} robots touchés", s.hits);
        assert!(s.explosions > 0, "l'ogive a sauté");
        assert_eq!(s.unported, 0);
    }

    /// Un relief en pente douce (5 %, montant vers +z), de 64 m de côté.
    fn slope(sim: &mut Sim) {
        let (cells, size) = (32, 64.0);
        let n = cells + 1;
        let mut heights = vec![0f32; n * n];
        for ix in 0..n {
            for iz in 0..n {
                heights[ix * n + iz] = (iz as f64 * 2.0 * 0.05) as f32;
            }
        }
        sim.set_terrain(crate::terrain::Terrain { size, cells, heights });
    }

    #[test]
    fn un_robot_monte_le_relief() {
        let mut sim = Sim::new();
        slope(&mut sim);
        assert!((arena::ground_level(&sim, 0.0, -20.0) - 0.6).abs() < 1e-6);
        let y = arena::ground_level(&sim, 0.0, -20.0) + robot::ground_height(&catalog::catalog().robots["trike"].design) + 0.03;
        let bot = sim.spawn("trike", v3(0.0, y, -20.0), 0.0).unwrap();
        for _ in 0..60 {
            sim.step();
        }
        let start = sim.bots[bot].last_pos;
        sim.bots[bot].input.throttle = 1.0;
        for _ in 0..4 * 60 {
            sim.step();
        }
        let p = sim.bots[bot].last_pos;
        assert!(p.z > start.z + 5.0 && p.y > start.y + 0.3, "il monte : de {start:?} à {p:?}");
        assert!(sim.bots[bot].wheels.iter().any(|w| w.load > 0.0), "ses roues portent sur le relief");
        // (sur le relief, le lancer de rayon sans physique le voit aussi)
        let d = arena::ray_arena(&sim, v3(0.0, 10.0, 0.0), v3(0.0, -1.0, 0.0), 20.0).unwrap();
        assert!((d - (10.0 - arena::ground_level(&sim, 0.0, 0.0))).abs() < 0.01);
    }

    #[test]
    fn la_lave_brule_et_la_mer_noie() {
        // Un char posé dans un lac de lave : ses blocs brûlent ; un autre dans une eau profonde : il se noie
        let mut sim = Sim::new();
        sim.rng = rng::Rng::new(3);
        sim.arena.lava.push(arena::Lava::pool(0.0, 0.0, 4.0));
        let y = robot::ground_height(&catalog::catalog().robots["tank"].design) + 0.03;
        let burnt = sim.spawn("tank", v3(0.0, y, 0.0), 0.0).unwrap();
        for _ in 0..3 * 60 {
            sim.step();
        }
        assert!(sim.stats.fires_started > 0 && sim.stats.damage > 0, "il brûle");
        assert!(sim.bots[burnt].blocks.iter().any(|b| b.hp < catalog::catalog().blocks[&b.kind].hp));

        let mut sim = Sim::new();
        (sim.water, sim.arena.deep_water) = (Some(2.5), Some(1.1));
        let drowned = sim.spawn("tank", v3(0.0, y, 0.0), 0.0).unwrap();
        assert!(arena::deep_water_at(&sim, 0.0, 0.0) && arena::in_water(&sim, v3(0.0, 1.0, 0.0)));
        for _ in 0..7 * 60 {
            sim.step();
        }
        assert!(!sim.bots[drowned].cockpit_alive() && sim.stats.killed == 1, "il s'est noyé");
    }

    #[test]
    fn la_grille_de_passage_fait_contourner_un_mur() {
        // Une grille de 20 cases de 2 m, fermée sur une ligne (z = 0) sauf à son bout ouest : un robot de
        // l'IA au sud qui va au nord passe par l'ouverture
        let mut sim = Sim::new();
        let n = 20;
        let mut open = vec![1u8; n * n];
        for ix in 0..n - 2 {
            open[ix * n + n / 2] = 0;
        }
        sim.arena.grid = Some(arena::Grid { cell: 2.0, min: -20.0, nav: crate::navgrid::NavGrid::new(n, open) });
        let y = robot::ground_height(&catalog::catalog().robots["trike"].design) + 0.03;
        let bot = sim.spawn_ai("trike", v3(0.0, y, -10.0), 0.0, 0).unwrap();
        let goal = navigation::navigate(&mut sim, bot, v3(0.0, 0.0, -10.0), v3(0.0, 0.0, 10.0));
        assert!(goal.x > 5.0 && goal.z < 2.0, "vers l'ouverture : {goal:?}");
        assert!(arena::passable(&sim, 17.0, 1.0) && !arena::passable(&sim, 0.0, 1.0));
        assert_eq!(arena::nearest_passable(&sim, v3(0.0, 0.0, 1.0)).z, -1.0);
    }

    #[test]
    fn l_aeroglisseur_flotte_sur_ses_patins() {
        let mut sim = Sim::new();
        sim.rng = rng::Rng::new(2);
        let y = robot::ground_height(&catalog::catalog().robots["hovercraft"].design) + 0.03;
        let bot = sim.spawn("hovercraft", v3(0.0, y, -10.0), 0.0).unwrap();
        sim.bots[bot].input = robot::Input { throttle: 1.0, ..robot::Input::default() };
        for _ in 0..4 * 60 {
            sim.step();
        }
        let b = &sim.bots[bot];
        assert_eq!(b.supports.len(), 6);
        assert!(b.supports.iter().all(|s| s.contact.is_finite() && s.force > 0.0), "ses patins portent");
        assert!(b.last_pos.z > -5.0, "il avance : {}", b.last_pos.z);
    }
}
