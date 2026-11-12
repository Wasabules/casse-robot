//! La solidité des liaisons (src/shared/robot/structure.ts). Là où un ensemble de blocs ne tient au
//! reste de son morceau que par une seule face (un col, un bras, une tourelle posée sur un bloc),
//! cette liaison doit transmettre à elle seule les chocs entre les deux côtés, et elle peut rompre :
//! le côté détachable devient un morceau à part (lifecycle.rs, `splitPart`).

use super::catalog::catalog;
use super::robot::{Bot, Cell, NEIGHBORS, WeakLink, link_key};
use super::vec::{V3, add, cross, len, qrot, qrot_inv, scale, sub, v3};
use super::world::Sim;

/// Bras de levier ajouté pour l'effort tranchant d'une liaison (m) : la moitié d'un bloc.
const SHEAR_ARM: f64 = 0.25;

/// Voisins d'un bloc qui lui sont encore liés : même morceau, liaison intacte (`linkedNeighbors`).
pub fn linked_neighbors(bot: &Bot, block: usize) -> Vec<usize> {
    let b = &bot.blocks[block];
    let here = b.cell();
    let mut out = Vec::new();
    for (dx, dy, dz) in NEIGHBORS {
        let cell: Cell = (here.0 + dx, here.1 + dy, here.2 + dz);
        if let Some(&n) = bot.cells.get(&cell)
            && bot.blocks[n].part == b.part
            && !bot.cuts.contains(&link_key(here, cell))
        {
            out.push(n);
        }
    }
    out
}

/// Liaisons faibles d'un morceau (`weakLinks`) : les ponts de son graphe de blocs (Tarjan), le côté
/// détachable étant celui qui ne contient pas le cockpit, ou le plus petit. Gardées dans le morceau
/// jusqu'au prochain changement de ses blocs.
pub fn weak_links(sim: &mut Sim, p: usize) -> &[WeakLink] {
    if sim.part(p).links.is_none() {
        let links = compute_links(sim, p);
        sim.part_mut(p).links = Some(links);
    }
    sim.part(p).links.as_deref().unwrap_or(&[])
}

/// L'état de la recherche des ponts (`visit`, récursive comme celle du TypeScript).
struct Tarjan<'a> {
    adj: &'a [Vec<usize>],
    order: Vec<i64>,
    low: Vec<i64>,
    time: i64,
    bridges: Vec<(usize, usize)>,
}

impl Tarjan<'_> {
    fn visit(&mut self, u: usize, parent: Option<usize>) {
        self.order[u] = self.time;
        self.low[u] = self.time;
        self.time += 1;
        for &v in &self.adj[u] {
            if Some(v) == parent {
                continue;
            }
            if self.order[v] >= 0 {
                self.low[u] = self.low[u].min(self.order[v]);
            } else {
                self.visit(v, Some(u));
                self.low[u] = self.low[u].min(self.low[v]);
                if self.low[v] > self.order[u] {
                    self.bridges.push((u, v));
                }
            }
        }
    }
}

fn compute_links(sim: &Sim, p: usize) -> Vec<WeakLink> {
    let part = sim.part(p);
    let bot = &sim.bots[part.bot];
    let blocks = &part.blocks;
    let index = |k: usize| blocks.iter().position(|&x| x == k).expect("bloc hors du morceau");
    let adj: Vec<Vec<usize>> = blocks.iter().map(|&b| linked_neighbors(bot, b).into_iter().map(index).collect()).collect();

    let mut t = Tarjan { adj: &adj, order: vec![-1; blocks.len()], low: vec![0; blocks.len()], time: 0, bridges: Vec::new() };
    for i in 0..blocks.len() {
        if t.order[i] < 0 {
            t.visit(i, None);
        }
    }

    let c = catalog();
    let ck = bot.cockpit;
    let anchor = if bot.blocks[ck].alive && bot.blocks[ck].part == p { blocks.iter().position(|&x| x == ck) } else { None };
    let mut links = Vec::new();
    for &(u, v) in &t.bridges {
        // Côté de v, sans repasser par le pont (dans l'ordre où il est parcouru)
        let mut side = vec![v];
        let mut in_side = vec![false; blocks.len()];
        in_side[v] = true;
        let mut stack = vec![v];
        while let Some(x) = stack.pop() {
            for &y in &adj[x] {
                if (x == v && y == u) || in_side[y] {
                    continue;
                }
                in_side[y] = true;
                side.push(y);
                stack.push(y);
            }
        }
        let v_beyond = match anchor {
            Some(a) => !in_side[a],
            None => side.len() as f64 <= blocks.len() as f64 / 2.0,
        };
        let (inner, outer) = if v_beyond { (blocks[u], blocks[v]) } else { (blocks[v], blocks[u]) };
        let beyond: Vec<usize> = if v_beyond { side.iter().map(|&i| blocks[i]).collect() } else { (0..blocks.len()).filter(|&i| !in_side[i]).map(|i| blocks[i]).collect() };
        let mut mass = 0.0;
        let mut weighted = v3(0.0, 0.0, 0.0);
        for &b in &beyond {
            let m = c.blocks[&bot.blocks[b].kind].mass;
            mass += m;
            weighted = add(weighted, scale(bot.blocks[b].local, m));
        }
        let (bi, bo) = (&bot.blocks[inner], &bot.blocks[outer]);
        links.push(WeakLink {
            key: link_key(bi.cell(), bo.cell()),
            inner,
            outer,
            beyond: beyond.into_iter().collect(),
            mass,
            com: scale(weighted, 1.0 / mass),
            joint: scale(add(bi.local, bo.local), 0.5),
            strength: crate::jsmath::min(c.blocks[&bi.kind].bond, c.blocks[&bo.kind].bond),
        });
    }
    links
}

/// Choc sur un morceau (`stressLinks`) : l'impulsion `impulse` (N·s, monde) reçue en `point`, sur le
/// bloc `hit` (le plus proche du point s'il n'y en a pas). Chaque liaison faible transmet sa part du
/// choc au bout d'un bras de levier ; celles dont la charge dépasse la solidité cèdent.
pub fn stress_links(sim: &mut Sim, p: usize, point: V3, impulse: V3, hit: Option<usize>) -> Vec<WeakLink> {
    if weak_links(sim, p).is_empty() {
        return Vec::new();
    }
    let rb = sim.part(p).rb;
    let (t, q, total) = (sim.phys.translation(rb), sim.phys.rotation(rb), sim.phys.mass(rb));
    let struck = hit.or_else(|| nearest_block(sim, p, qrot_inv(q, sub(point, t))));
    let mut broken = Vec::new();
    for link in sim.part(p).links.as_deref().unwrap_or(&[]) {
        let joint = add(t, qrot(q, link.joint));
        let on_beyond = struck.is_some_and(|s| link.beyond.contains(&s));
        let share = if on_beyond { 1.0 - link.mass / total } else { link.mass / total };
        let transmitted = scale(impulse, crate::jsmath::max(0.0, share));
        let lever = if on_beyond { sub(point, joint) } else { sub(add(t, qrot(q, link.com)), joint) };
        let load = len(cross(lever, transmitted)) + len(transmitted) * SHEAR_ARM;
        if load > link.strength {
            broken.push(link.clone());
        }
    }
    broken
}

fn nearest_block(sim: &Sim, p: usize, local: V3) -> Option<usize> {
    let part = sim.part(p);
    let bot = &sim.bots[part.bot];
    let mut best = None;
    let mut best_dist = f64::INFINITY;
    for &b in &part.blocks {
        let l = bot.blocks[b].local;
        let d = crate::jsmath::hypot3(l.x - local.x, l.y - local.y, l.z - local.z);
        if d < best_dist {
            best_dist = d;
            best = Some(b);
        }
    }
    best
}
