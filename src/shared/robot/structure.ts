import { BLOCK_TYPES } from "../catalog/blocks";
import { cellKey, NEIGHBORS } from "../design/robotDesign";
import { add, cross, distance, len, qrot, qrotInv, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { Block, Part, WeakLink } from "../sim/entities";

/*
 * Solidité des liaisons. Un morceau est un seul corps rigide : tant qu'un ensemble de blocs y est
 * relié par plusieurs faces, il tient. Mais là où il ne tient que par une seule face (un col, un
 * bras, une tourelle posée sur un bloc), cette liaison doit transmettre à elle seule les chocs
 * entre les deux côtés, et elle peut rompre. Le côté détachable devient alors un morceau à part,
 * sans perdre de blocs.
 */

/** Bras de levier ajouté pour l'effort tranchant d'une liaison (m) : la moitié d'un bloc. */
const SHEAR_ARM = 0.25;

/** Clé d'une liaison entre deux blocs voisins, indépendante de l'ordre. */
export const linkKey = (a: Block, b: Block): string => (a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`);

/** Voisins d'un bloc qui lui sont encore liés : même morceau, liaison intacte. */
export function linkedNeighbors(block: Block): Block[] {
  const { bot } = block;
  const out: Block[] = [];
  for (const [dx, dy, dz] of NEIGHBORS) {
    const n = bot.blocks.get(cellKey(block.x + dx, block.y + dy, block.z + dz));
    if (n && n.part === block.part && !bot.cuts.has(linkKey(block, n))) out.push(n);
  }
  return out;
}

/**
 * Liaisons faibles d'un morceau : les ponts de son graphe de blocs (une liaison dont la rupture le
 * coupe en deux). Le côté détachable est celui qui ne contient pas le cockpit, ou le plus petit.
 * Le résultat est gardé dans `part.links` jusqu'au prochain changement de ses blocs.
 */
export function weakLinks(part: Part): WeakLink[] {
  if (part.links) return part.links;
  const blocks = [...part.blocks];
  const index = new Map(blocks.map((b, i) => [b, i]));
  const adj = blocks.map((b) => linkedNeighbors(b).map((n) => index.get(n)!));

  // Ponts (Tarjan) : l'arête u–v est un pont si rien sous v ne remonte au-dessus de v
  const order = new Array<number>(blocks.length).fill(-1);
  const low = new Array<number>(blocks.length).fill(0);
  const bridges: [number, number][] = [];
  let time = 0;
  const visit = (u: number, parent: number): void => {
    order[u] = low[u] = time++;
    for (const v of adj[u]) {
      if (v === parent) continue;
      if (order[v] >= 0) {
        low[u] = Math.min(low[u], order[v]);
      } else {
        visit(v, u);
        low[u] = Math.min(low[u], low[v]);
        if (low[v] > order[u]) bridges.push([u, v]);
      }
    }
  };
  for (let i = 0; i < blocks.length; i++) if (order[i] < 0) visit(i, -1);

  const ck = part.bot.cockpit;
  const anchor = ck.alive && ck.part === part ? index.get(ck) : undefined;
  const links: WeakLink[] = [];
  for (const [u, v] of bridges) {
    // Côté de v, sans repasser par le pont
    const side = new Set([v]);
    const stack = [v];
    while (stack.length) {
      const x = stack.pop()!;
      for (const y of adj[x]) {
        if ((x === v && y === u) || side.has(y)) continue;
        side.add(y);
        stack.push(y);
      }
    }
    const vBeyond = anchor !== undefined ? !side.has(anchor) : side.size <= blocks.length / 2;
    const [inner, outer] = vBeyond ? [blocks[u], blocks[v]] : [blocks[v], blocks[u]];
    const beyond = new Set(vBeyond ? [...side].map((i) => blocks[i]) : blocks.filter((_, i) => !side.has(i)));
    let mass = 0;
    let weighted = vec3(0, 0, 0);
    for (const b of beyond) {
      const m = BLOCK_TYPES[b.type].mass;
      mass += m;
      weighted = add(weighted, scale(b.local, m));
    }
    links.push({
      key: linkKey(inner, outer),
      inner,
      outer,
      beyond,
      mass,
      com: scale(weighted, 1 / mass),
      joint: scale(add(inner.local, outer.local), 0.5),
      strength: Math.min(BLOCK_TYPES[inner.type].bond, BLOCK_TYPES[outer.type].bond),
    });
  }
  part.links = links;
  return links;
}

/**
 * Choc sur un morceau : l'impulsion `impulse` (N·s, repère monde) reçue en `point`, sur le bloc
 * `hit` (le plus proche du point si null). Le morceau entier encaisse le choc, mais chaque
 * liaison faible doit transmettre sa part à travers une seule face :
 * - si le choc frappe le côté détachable, la liaison doit entraîner le reste du morceau ; elle
 *   transmet la part du choc qui revient à ce reste, au bout du bras de levier qui va du point
 *   d'impact à la liaison ;
 * - sinon, elle doit entraîner le côté détachable : elle transmet la part qui lui revient, au
 *   bout du bras qui va de la liaison à son centre de masse.
 * Le moment de ce choc (plus l'effort tranchant) comparé à la solidité de la liaison décide de
 * sa rupture. Renvoie les liaisons qui cèdent.
 */
export function stressLinks(part: Part, point: Vec3, impulse: Vec3, hit: Block | null): WeakLink[] {
  const links = weakLinks(part);
  if (!links.length) return [];
  const rb = part.rb;
  const t = rb.translation();
  const q = rb.rotation();
  const total = rb.mass();
  const struck = hit ?? nearestBlock(part, qrotInv(q, sub(point, t)));
  const broken: WeakLink[] = [];
  for (const link of links) {
    const joint = add(t, qrot(q, link.joint));
    const onBeyond = !!struck && link.beyond.has(struck);
    const share = onBeyond ? 1 - link.mass / total : link.mass / total;
    const transmitted = scale(impulse, Math.max(0, share));
    const lever = onBeyond ? sub(point, joint) : sub(add(t, qrot(q, link.com)), joint);
    const load = len(cross(lever, transmitted)) + len(transmitted) * SHEAR_ARM;
    if (load > link.strength) broken.push(link);
  }
  return broken;
}

function nearestBlock(part: Part, local: Vec3): Block | null {
  let best: Block | null = null;
  let bestDist = Infinity;
  for (const b of part.blocks) {
    const d = distance(b.local, local);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}
