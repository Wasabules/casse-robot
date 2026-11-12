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
//! les petites arènes (Dépôt, Forteresse, Tranchées, Chantier : sans relief). tests/nativeSim.test.ts
//! fait rouler et se heurter les mêmes robots, pilotés ou conduits par l'IA, contre les mêmes
//! accessoires, dans les mêmes flaques, ici et dans la simulation du TypeScript, et compare leurs
//! états au bit près.
//!
//! L'interface : des fonctions `extern "C"` (comme ffi.rs) ; un monde est désigné par un numéro.

pub mod brain;
pub mod catalog;
pub mod colliders;
pub mod collisions;
pub mod damage;
pub mod debris;
pub mod detection;
pub mod drive;
pub mod explosion;
pub mod fire;
pub mod json;
pub mod lifecycle;
pub mod navigation;
pub mod physics;
pub mod props;
pub mod repair;
pub mod rng;
pub mod robot;
pub mod shapes;
pub mod structure;
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

/// Un monde, son sol ; son numéro (à partir de 1).
#[unsafe(no_mangle)]
pub extern "C" fn sim_new() -> u32 {
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

/// Les dimensions de l'arène (`ArenaBounds`) : la demi-largeur de son terrain, celle de la zone où rôde l'IA (m).
#[unsafe(no_mangle)]
pub extern "C" fn sim_set_bounds(id: u32, half: f64, roam: f64) {
    with(id, |s| s.bounds = world::Bounds { half, roam });
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
    with(id, |s| s.bots[bot as usize].input = robot::Input { throttle, steer, brake, boost: boost != 0 });
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
        explosion::explode(s, v3(x, y, z), &ex, v3(dx, dy, dz), v3(x, y, z), attacker);
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
/// ceux du robot ; -1 arrachée, -2 retirée) : quinze nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 15 f64.
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
        let out = unsafe { std::slice::from_raw_parts_mut(out, 15) };
        out.copy_from_slice(&[p.x, p.y, p.z, r.x, r.y, r.z, r.w, w.steer, w.travel, w.spin, w.spin_rate, w.load, w.drive, w.hp, at]);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_block_count(id: u32, bot: u32) -> u32 {
    with(id, |s| s.bots[bot as usize].blocks.len() as u32)
}

/// L'état d'un bloc (dans l'ordre du plan) : ses points de structure, s'il est vivant (1 ou 0), le
/// rang de son morceau parmi ceux du robot (-1 s'il est détruit), son feu (secondes qu'il brûlera
/// encore), s'il est perdu (1 ou 0 : détruit, une réparation pourra le faire repousser) : cinq
/// nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 5 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_block_state(id: u32, bot: u32, block: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let k = &b.blocks[block as usize];
        let at = if k.alive { b.parts.iter().position(|&x| x == k.part).map_or(-3.0, |i| i as f64) } else { -1.0 };
        let lost = if b.lost(block as usize) { 1.0 } else { 0.0 };
        unsafe { std::slice::from_raw_parts_mut(out, 5) }.copy_from_slice(&[k.hp, if k.alive { 1.0 } else { 0.0 }, at, k.burn, lost]);
    });
}

/// L'état d'un robot : quand il a été touché pour la dernière fois (-∞ : jamais), le moment avant
/// lequel aucun bloc ne lui repousse, l'énergie de ses batteries (kJ), et l'ordre de ses blocs
/// vivants (`bot.blocks`) résumé en un nombre (la somme de leurs numéros pondérés par leur rang) :
/// quatre nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 4 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_bot_state(id: u32, bot: u32, out: *mut f64) {
    with(id, |s| {
        let b = &s.bots[bot as usize];
        let order = b.live.iter().enumerate().fold(0.0, |sum, (rank, &k)| sum + ((rank + 1) * (k + 1)) as f64);
        unsafe { std::slice::from_raw_parts_mut(out, 4) }.copy_from_slice(&[b.last_hit, b.rebuild_at, b.energy, order]);
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
/// (`navigate`, sans rien changer : de quoi comparer le chemin) : trois nombres de 8 octets.
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

/// Ce qui s'est passé depuis la création du monde : chocs, lots de dégâts, blocs détruits,
/// liaisons rompues, robots hors de combat, roues arrachées, roues retirées, ce qui n'est pas porté,
/// tirages du hasard, explosions, accessoires retirés, accessoires libérés, blocs allumés, blocs
/// éteints, événements du feu des accessoires, blocs repoussés, blocs réparés, flaques de feu
/// allumées, flaques éteintes : dix-neuf nombres de 8 octets.
///
/// # Safety
/// `out` pointe sur 19 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_stats(id: u32, out: *mut f64) {
    with(id, |s| {
        let t = s.stats;
        let values = [
            t.collisions, t.damage, t.destroyed, t.links_broken, t.killed, t.wheels_released, t.wheels_removed, t.unported, 0, t.explosions,
            t.props_removed, t.props_released, t.fires_started, t.fires_ended, t.prop_fire_events, t.rebuilt, t.repaired,
            t.ground_fires_added, t.ground_fires_removed,
        ];
        let out = unsafe { std::slice::from_raw_parts_mut(out, 19) };
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
        assert!(sim.spawn("drone", v3(5.0, 3.0, 0.0), 0.0).is_err());
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
            sim.bots[bot].input = robot::Input { throttle: if i < 60 { 0.0 } else { 1.0 }, steer: 0.0, brake: 0.0, boost: i >= 60 };
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
            sim.bots[bot].input = robot::Input { throttle: if i < 60 { 0.0 } else { 1.0 }, steer: 0.0, brake: 0.0, boost: i >= 60 };
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
                60..540 => robot::Input { throttle: 1.0, steer: 0.0, brake: 0.0, boost: true },
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
        explosion::explode(&mut sim, v3(0.0, 0.3, 0.0), &barrel, v3(0.0, 1.0, 0.0), v3(0.0, 0.3, 0.0), None);
        assert_eq!(sim.bots[bots[0]].ai.mode, brain::Mode::Charge);
        assert_eq!(sim.bots[bots[1]].ai.mode, brain::Mode::Flee);
        let t = sim.bots[bots[1]].ai.target;
        assert!(t.x > 10.0, "il fuit à l'opposé de l'explosion : {t:?}");
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
        explosion::explode(&mut sim, v3(2.5, 0.3, -20.0), &napalm, v3(0.0, 1.0, 0.0), v3(2.5, 0.3, -20.0), None);
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
}
