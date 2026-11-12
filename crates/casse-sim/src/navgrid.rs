//! Grille de passage de l'IA au sol (portée de src/shared/arena/navgrid.ts) : la recherche de
//! chemin (A*, huit voisins, sans couper les coins), l'approche quand le chemin serait trop long,
//! la plus grande région d'un seul tenant, la case ouverte la plus proche. Le calcul de la grille
//! elle-même (le relief, la lave, l'eau, les ponts) reste en TypeScript tant que l'arène y est :
//! le TypeScript la donne toute faite (`open`). Mêmes résultats au bit près que le TypeScript
//! (tests/native.test.ts) : même ordre des voisins, même tas, mêmes égalités.

/// Poids de l'estimation de A* : au-delà de 1, il cherche moins pour un chemin à peine plus long.
const GREED: f64 = 1.4;
const SQRT2: f64 = std::f64::consts::SQRT_2;

/// Les huit voisins, dans l'ordre du TypeScript (il décide des égalités du tas).
const NEIGHBORS: [(i64, i64, f64); 8] = [
    (1, 0, 1.0),
    (-1, 0, 1.0),
    (0, 1, 1.0),
    (0, -1, 1.0),
    (1, 1, SQRT2),
    (1, -1, SQRT2),
    (-1, 1, SQRT2),
    (-1, -1, SQRT2),
];

pub struct NavGrid {
    /// Cases par côté.
    pub n: usize,
    /// 1 : franchissable. Indice ix·n + iz.
    pub open: Vec<u8>,
    // Tableaux de travail de A*, remis à zéro à chaque recherche
    cost: Vec<f64>,
    from: Vec<i32>,
    closed: Vec<u8>,
    heap: Vec<i32>,
    keys: Vec<f64>,
}

impl NavGrid {
    pub fn new(n: usize, open: Vec<u8>) -> NavGrid {
        let size = n * n;
        // Une case peut entrer plusieurs fois dans le tas (à chaque amélioration) : au plus une fois par voisin
        NavGrid {
            n,
            open,
            cost: vec![0.0; size],
            from: vec![-1; size],
            closed: vec![0; size],
            heap: vec![0; size * 8],
            keys: vec![0.0; size * 8],
        }
    }

    #[inline]
    fn is_open(&self, ix: i64, iz: i64) -> bool {
        self.open[ix as usize * self.n + iz as usize] != 0
    }

    /// Chemin (cases, du départ à l'arrivée) par les cases franchissables, ou None. La case de
    /// départ peut être fermée.
    pub fn find_path(&mut self, start: usize, goal: usize) -> Option<Vec<usize>> {
        if self.open[goal] == 0 {
            return None;
        }
        let n = self.n as i64;
        self.cost.fill(f64::INFINITY);
        self.from.fill(-1);
        self.closed.fill(0);
        let gx = goal as i64 / n;
        let gz = goal as i64 % n;
        let estimate = |ix: i64, iz: i64| -> f64 {
            let dx = (ix - gx).abs() as f64;
            let dz = (iz - gz).abs() as f64;
            GREED * (dx.max(dz) + (SQRT2 - 1.0) * dx.min(dz))
        };
        let mut size = 0usize;
        self.cost[start] = 0.0;
        let s = start as i64;
        push(&mut self.heap, &mut self.keys, &mut size, start as i32, estimate(s / n, s % n));
        while size > 0 {
            let c = pop(&mut self.heap, &mut self.keys, &mut size) as usize;
            if c == goal {
                return Some(self.trace(goal));
            }
            if self.closed[c] != 0 {
                continue;
            }
            self.closed[c] = 1;
            let cx = c as i64 / n;
            let cz = c as i64 % n;
            for &(dx, dz, step) in NEIGHBORS.iter() {
                let ix = cx + dx;
                let iz = cz + dz;
                if ix < 0 || iz < 0 || ix >= n || iz >= n {
                    continue;
                }
                let k = (ix * n + iz) as usize;
                if self.open[k] == 0 || self.closed[k] != 0 {
                    continue;
                }
                // En diagonale, seulement si les deux cases voisines sont ouvertes : on ne coupe pas un coin
                if dx != 0 && dz != 0 && (!self.is_open(ix, cz) || !self.is_open(cx, iz)) {
                    continue;
                }
                let g = self.cost[c] + step;
                if g >= self.cost[k] || size >= self.heap.len() {
                    continue;
                }
                self.cost[k] = g;
                self.from[k] = c as i32;
                push(&mut self.heap, &mut self.keys, &mut size, k as i32, g + estimate(ix, iz));
            }
        }
        None
    }

    fn trace(&self, last: usize) -> Vec<usize> {
        let mut path = Vec::new();
        let mut k = last as i32;
        while k != -1 {
            path.push(k as usize);
            k = self.from[k as usize];
        }
        path.reverse();
        path
    }

    /// Chemin vers la case la plus proche de `goal` (à vol d'oiseau) qu'on atteint depuis `start` en
    /// visitant au plus `budget` cases (parcours en largeur, huit voisins, sans couper les coins).
    pub fn approach_path(&mut self, start: usize, goal: usize, budget: usize) -> Vec<usize> {
        let n = self.n as i64;
        self.from.fill(-1);
        self.closed.fill(0);
        let gx = goal as i64 / n;
        let gz = goal as i64 % n;
        let far = |c: usize| -> i64 {
            let (x, z) = (c as i64 / n - gx, c as i64 % n - gz);
            x * x + z * z
        };
        let mut queue = vec![start];
        self.closed[start] = 1;
        let mut best = start;
        let mut head = 0;
        while head < queue.len() && head < budget {
            let c = queue[head];
            if far(c) < far(best) {
                best = c;
            }
            let cx = c as i64 / n;
            let cz = c as i64 % n;
            for &(dx, dz, _) in NEIGHBORS.iter() {
                let ix = cx + dx;
                let iz = cz + dz;
                if ix < 0 || iz < 0 || ix >= n || iz >= n {
                    continue;
                }
                let k = (ix * n + iz) as usize;
                if self.open[k] == 0 || self.closed[k] != 0 {
                    continue;
                }
                if dx != 0 && dz != 0 && (!self.is_open(ix, cz) || !self.is_open(cx, iz)) {
                    continue;
                }
                self.closed[k] = 1;
                self.from[k] = c as i32;
                queue.push(k);
            }
            head += 1;
        }
        self.trace(best)
    }

    /// La case franchissable la plus proche de `cell` (elle-même si elle l'est), à moins de `reach`
    /// cases ; None sinon.
    pub fn nearest_open_cell(&self, cell: usize, reach: i64) -> Option<usize> {
        if self.open[cell] != 0 {
            return Some(cell);
        }
        let n = self.n as i64;
        let cx = cell as i64 / n;
        let cz = cell as i64 % n;
        let mut best: i64 = -1;
        let mut best_d = f64::INFINITY;
        for r in 1..=reach {
            // Un anneau de cases à r de distance (en Tchebychev) ; l'anneau suivant peut encore en
            // avoir une plus proche, jusqu'à r·√2
            if best >= 0 && (r as f64) > best_d.sqrt() + 1.0 {
                break;
            }
            for dx in -r..=r {
                let full = dx.abs() == r;
                let mut visit = |dz: i64| {
                    let ix = cx + dx;
                    let iz = cz + dz;
                    if ix < 0 || iz < 0 || ix >= n || iz >= n || self.open[(ix * n + iz) as usize] == 0 {
                        return;
                    }
                    let d = (dx * dx + dz * dz) as f64;
                    if d < best_d {
                        best_d = d;
                        best = ix * n + iz;
                    }
                };
                if full {
                    for dz in -r..=r {
                        visit(dz);
                    }
                } else {
                    visit(-r);
                    visit(r);
                }
            }
        }
        if best >= 0 { Some(best as usize) } else { None }
    }
}

/// Le tas : des cases rangées par coût estimé croissant (comme `findPath` en TypeScript).
#[inline]
fn push(heap: &mut [i32], keys: &mut [f64], size: &mut usize, cell: i32, key: f64) {
    let mut i = *size;
    *size += 1;
    while i > 0 {
        let up = (i - 1) >> 1;
        if keys[up] <= key {
            break;
        }
        heap[i] = heap[up];
        keys[i] = keys[up];
        i = up;
    }
    heap[i] = cell;
    keys[i] = key;
}

#[inline]
fn pop(heap: &mut [i32], keys: &mut [f64], size: &mut usize) -> i32 {
    let top = heap[0];
    *size -= 1;
    let cell = heap[*size];
    let key = keys[*size];
    let mut i = 0;
    loop {
        let mut m = 2 * i + 1;
        if m >= *size {
            break;
        }
        if m + 1 < *size && keys[m + 1] < keys[m] {
            m += 1;
        }
        if keys[m] >= key {
            break;
        }
        heap[i] = heap[m];
        keys[i] = keys[m];
        i = m;
    }
    heap[i] = cell;
    keys[i] = key;
    top
}

/// Ne garde ouverte que la plus grande région d'un seul tenant (voisinage 8, sans couper les coins).
pub fn keep_largest_region(open: &mut [u8], n: usize) {
    let ni = n as i64;
    let mut region = vec![-1i32; n * n];
    let mut sizes: Vec<usize> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for c0 in 0..open.len() {
        if open[c0] == 0 || region[c0] >= 0 {
            continue;
        }
        let id = sizes.len() as i32;
        let mut count = 0;
        region[c0] = id;
        stack.push(c0);
        while let Some(c) = stack.pop() {
            count += 1;
            let cx = c as i64 / ni;
            let cz = c as i64 % ni;
            for &(dx, dz, _) in NEIGHBORS.iter() {
                let ix = cx + dx;
                let iz = cz + dz;
                if ix < 0 || iz < 0 || ix >= ni || iz >= ni {
                    continue;
                }
                let k = (ix * ni + iz) as usize;
                if open[k] == 0 || region[k] >= 0 {
                    continue;
                }
                if dx != 0 && dz != 0 && (open[(ix * ni + cz) as usize] == 0 || open[(cx * ni + iz) as usize] == 0) {
                    continue;
                }
                region[k] = id;
                stack.push(k);
            }
        }
        sizes.push(count);
    }
    // (la première des plus grandes, comme `indexOf(Math.max(...))`)
    let Some(&max) = sizes.iter().max() else { return };
    let biggest = sizes.iter().position(|&s| s == max).unwrap() as i32;
    for c in 0..open.len() {
        if open[c] != 0 && region[c] != biggest {
            open[c] = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contourne_un_mur() {
        // 5 × 5, un mur en ix = 2 sauf en iz = 4
        let n = 5;
        let mut open = vec![1u8; n * n];
        for iz in 0..4 {
            open[2 * n + iz] = 0;
        }
        let mut g = NavGrid::new(n, open);
        let path = g.find_path(0, 4 * n).unwrap();
        assert_eq!(*path.first().unwrap(), 0);
        assert_eq!(*path.last().unwrap(), 4 * n);
        assert!(path.contains(&(2 * n + 4)));
        assert!(g.find_path(0, 2 * n).is_none());
    }

    #[test]
    fn la_plus_grande_region() {
        let n = 4;
        // une case isolée en (0, 0), un bloc de 4 en bas à droite
        let mut open = vec![0u8; n * n];
        open[0] = 1;
        for (ix, iz) in [(2, 2), (2, 3), (3, 2), (3, 3)] {
            open[ix * n + iz] = 1;
        }
        keep_largest_region(&mut open, n);
        assert_eq!(open[0], 0);
        assert_eq!(open.iter().filter(|&&o| o == 1).count(), 4);
    }
}
