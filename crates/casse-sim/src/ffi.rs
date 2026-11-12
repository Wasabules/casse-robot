//! L'interface WebAssembly : des fonctions `extern "C"` sur des nombres et des pointers dans la
//! mémoire du module (pas de wasm-bindgen : rien d'autre à installer que Rust). Le TypeScript
//! (src/shared/native/native.ts) réserve la mémoire (`alloc`), y écrit ses tableaux, appelle, lit le
//! résultat, puis la rend (`dealloc`). Les reliefs et les grilles vivent ici, désignés par un numéro.

use crate::navgrid::{NavGrid, keep_largest_region};
use crate::terrain::Terrain;
use std::cell::RefCell;

thread_local! {
    static TERRAINS: RefCell<Vec<Option<Terrain>>> = const { RefCell::new(Vec::new()) };
    static GRIDS: RefCell<Vec<Option<NavGrid>>> = const { RefCell::new(Vec::new()) };
}

/// Range un objet dans la première place libre ; son numéro (à partir de 1 : 0 n'est personne).
fn store<T>(list: &mut Vec<Option<T>>, value: T) -> u32 {
    if let Some(i) = list.iter().position(Option::is_none) {
        list[i] = Some(value);
        return i as u32 + 1;
    }
    list.push(Some(value));
    list.len() as u32
}

/// Réserve `len` octets (alignés pour des nombres de 8 octets) dans la mémoire du module.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let words = len.div_ceil(8).max(1);
    let mut buf: Vec<u64> = Vec::with_capacity(words);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr as *mut u8
}

/// Rend `len` octets réservés par `alloc`.
///
/// # Safety
/// `ptr` vient de `alloc(len)`, et n'est plus lu.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    let words = len.div_ceil(8).max(1);
    drop(unsafe { Vec::from_raw_parts(ptr as *mut u64, 0, words) });
}

// --- Relief ---

/// Un relief, ses hauteurs copiées (`cells + 1`² nombres de 4 octets en `heights`).
///
/// # Safety
/// `heights` pointe sur `(cells + 1)²` f32.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn terrain_new(size: f64, cells: u32, heights: *const f32) -> u32 {
    let n = cells as usize + 1;
    let heights = unsafe { std::slice::from_raw_parts(heights, n * n) }.to_vec();
    let t = Terrain { size, cells: cells as usize, heights };
    TERRAINS.with(|list| store(&mut list.borrow_mut(), t))
}

#[unsafe(no_mangle)]
pub extern "C" fn terrain_free(id: u32) {
    TERRAINS.with(|list| list.borrow_mut()[id as usize - 1] = None);
}

#[unsafe(no_mangle)]
pub extern "C" fn terrain_height(id: u32, x: f64, z: f64) -> f64 {
    TERRAINS.with(|list| list.borrow()[id as usize - 1].as_ref().map_or(f64::NAN, |t| t.height(x, z)))
}

/// La distance où le rayon entre dans le relief ; -1 s'il ne le touche pas.
#[unsafe(no_mangle)]
pub extern "C" fn terrain_ray(id: u32, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, max_dist: f64) -> f64 {
    TERRAINS.with(|list| {
        let list = list.borrow();
        let t = list[id as usize - 1].as_ref().expect("relief inconnu");
        t.ray([ox, oy, oz], [dx, dy, dz], max_dist).unwrap_or(-1.0)
    })
}

// --- Grille de passage ---

/// Une grille de `n` × `n` cases, ses cases ouvertes copiées (`n`² octets en `open`).
///
/// # Safety
/// `open` pointe sur `n²` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn grid_new(n: u32, open: *const u8) -> u32 {
    let n = n as usize;
    let open = unsafe { std::slice::from_raw_parts(open, n * n) }.to_vec();
    GRIDS.with(|list| store(&mut list.borrow_mut(), NavGrid::new(n, open)))
}

#[unsafe(no_mangle)]
pub extern "C" fn grid_free(id: u32) {
    GRIDS.with(|list| list.borrow_mut()[id as usize - 1] = None);
}

/// Écrit un chemin dans `out` (au plus `cap` cases) ; sa longueur, ou -1 s'il n'y en a pas (ou s'il
/// ne tient pas).
fn write_path(path: Option<Vec<usize>>, out: *mut i32, cap: u32) -> i32 {
    match path {
        Some(p) if p.len() <= cap as usize => {
            let out = unsafe { std::slice::from_raw_parts_mut(out, p.len()) };
            for (o, c) in out.iter_mut().zip(p.iter()) {
                *o = *c as i32;
            }
            p.len() as i32
        }
        _ => -1,
    }
}

/// A* de `start` à `goal` (`findPath`).
///
/// # Safety
/// `out` pointe sur `cap` entiers de 4 octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn grid_find_path(id: u32, start: u32, goal: u32, out: *mut i32, cap: u32) -> i32 {
    let path = GRIDS.with(|list| {
        let mut list = list.borrow_mut();
        let g = list[id as usize - 1].as_mut().expect("grille inconnue");
        g.find_path(start as usize, goal as usize)
    });
    write_path(path, out, cap)
}

/// Le chemin d'approche (`approachPath`).
///
/// # Safety
/// `out` pointe sur `cap` entiers de 4 octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn grid_approach_path(id: u32, start: u32, goal: u32, budget: u32, out: *mut i32, cap: u32) -> i32 {
    let path = GRIDS.with(|list| {
        let mut list = list.borrow_mut();
        let g = list[id as usize - 1].as_mut().expect("grille inconnue");
        g.approach_path(start as usize, goal as usize, budget as usize)
    });
    write_path(Some(path), out, cap)
}

/// La case ouverte la plus proche (`nearestOpenCell`) ; -1 s'il n'y en a pas à moins de `reach` cases.
#[unsafe(no_mangle)]
pub extern "C" fn grid_nearest_open(id: u32, cell: u32, reach: u32) -> i32 {
    GRIDS.with(|list| {
        let list = list.borrow();
        let g = list[id as usize - 1].as_ref().expect("grille inconnue");
        g.nearest_open_cell(cell as usize, reach as i64).map_or(-1, |c| c as i32)
    })
}

/// Ne garde ouverte que la plus grande région (`keepLargestRegion`), sur place.
///
/// # Safety
/// `open` pointe sur `n²` octets.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn grid_keep_largest_region(open: *mut u8, n: u32) {
    let n = n as usize;
    let open = unsafe { std::slice::from_raw_parts_mut(open, n * n) };
    keep_largest_region(open, n);
}

// --- Les fonctions de Math de JavaScript (jsmath.rs) ---

/// Une fonction de `Math`, comme V8 la calcule (pour les tests de parité).
#[unsafe(no_mangle)]
pub extern "C" fn js_math(op: u32, a: f64, b: f64, c: f64) -> f64 {
    crate::jsmath::eval(op, a, b, c)
}

/// La même, sur `n` valeurs d'un coup : `out[i] = op(a[i], b[i], c[i])` (les tests en passent des
/// centaines de milliers ; un appel par valeur coûterait plus que la fonction).
///
/// # Safety
/// `a`, `b`, `c` et `out` pointent sur `n` f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn js_math_many(op: u32, a: *const f64, b: *const f64, c: *const f64, out: *mut f64, n: u32) {
    let n = n as usize;
    let (a, b, c) = unsafe { (std::slice::from_raw_parts(a, n), std::slice::from_raw_parts(b, n), std::slice::from_raw_parts(c, n)) };
    let out = unsafe { std::slice::from_raw_parts_mut(out, n) };
    for i in 0..n {
        out[i] = crate::jsmath::eval(op, a[i], b[i], c[i]);
    }
}
