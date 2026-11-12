import { qrot, vec3, type Vec3 } from "../math/vec";
import { NativeGrid, nativeKeepLargestRegion, nativeReady } from "../native/native";
import { lavaAt } from "./features";
import { deepWaterAt, groundLevel, type ArenaLayout, type StaticBox } from "./layout";
import { dpow } from "../math/det";

/*
 * Grille de passage de l'IA au sol (`ArenaLayout.navGrid`) : l'arène découpée en cases, chacune
 * franchissable ou non d'après le relief (une pente trop raide : le flanc d'un volcan, la paroi
 * d'une gorge), la lave (avec une marge) et l'eau profonde. Un tablier relié au sol à ses deux
 * bouts (un pont) est franchissable, même au-dessus d'une gorge ; un tablier perché (le plancher
 * d'une case sur pilotis) ne l'est pas, ni ce qui est dessous. Une rampe l'est (le relief sous elle
 * ne compte pas), et ce qu'on foule au-dessus de l'eau profonde : un quai ou une jetée (une piste qui
 * plonge dans l'eau), le pont d'un navire (une plateforme dans l'eau) où mènent des rampes. Le décor (murets, rochers) et les
 * bâtiments n'y sont pas : la navigation locale les contourne (ai/navigation.ts).
 *
 * L'IA y cherche son chemin (A*, huit voisins, sans couper les coins) quand la ligne droite vers
 * sa destination traverse une case fermée. Une donnée pure, calculée une fois par arène.
 */

export interface NavGrid {
  readonly cell: number;
  /** Cases par côté ; la grille couvre ±`bounds.half` m. */
  readonly n: number;
  /** Coordonnée (x comme z) du bord de la grille (m). */
  readonly min: number;
  /** 1 : franchissable. Indice ix·n + iz. */
  readonly open: Uint8Array;
}

/** Marge autour de la lave (m) : une case plus proche de son bord est fermée. */
const LAVA_MARGIN = 2.5;
/** Écart des différences finies qui mesurent la pente au centre d'une case (m). */
const SLOPE_PROBE = 0.8;
/** L'eau profonde et les pentes se cherchent aussi à cette part de la case autour de son centre : une marge le long des côtes et des parois. */
const WATER_PROBE = 0.4;
/** Un tablier est relié au sol à un bout si le sol y est à moins de cette hauteur de son dessus (m). */
const DECK_LANDING = 1;
/** Un tablier qui ne l'est pas ferme les cases dessous si on ne peut y passer qu'à moins de cette hauteur (m). */
const DECK_HEADROOM = 2.5;

const grids = new WeakMap<ArenaLayout, NavGrid | null>();

/** La grille de passage de l'arène (calculée à la première demande), ou null si elle n'en a pas. */
export function navGrid(arena: ArenaLayout): NavGrid | null {
  let grid = grids.get(arena);
  if (grid === undefined) {
    grid = arena.navGrid ? buildGrid(arena) : null;
    grids.set(arena, grid);
  }
  return grid;
}

/** Demi-emprise au sol (x, z) d'une boîte orientée. */
function footprint(box: StaticBox): { x: number; z: number } {
  const ax = qrot(box.rot, vec3(box.half.x, 0, 0));
  const ay = qrot(box.rot, vec3(0, box.half.y, 0));
  const az = qrot(box.rot, vec3(0, 0, box.half.z));
  return { x: Math.abs(ax.x) + Math.abs(ay.x) + Math.abs(az.x), z: Math.abs(ax.z) + Math.abs(ay.z) + Math.abs(az.z) };
}

const deckCache = new WeakMap<ArenaLayout, { bridges: StaticBox[]; blocking: StaticBox[] }>();

/** Les ponts de l'arène : ses tabliers reliés au sol à leurs deux bouts (pas les parapets, ni les planchers perchés). */
export const bridgeDecks = (arena: ArenaLayout): readonly StaticBox[] => decks(arena).bridges;

/** (x, z) est-il sous un pont (dans l'emprise d'un tablier relié au sol à ses deux bouts) ? */
export function onBridge(arena: ArenaLayout, x: number, z: number): boolean {
  return decks(arena).bridges.some((b) => {
    const f = footprint(b);
    return Math.abs(x - b.pos.x) <= f.x && Math.abs(z - b.pos.z) <= f.z;
  });
}

/** Les tabliers (pas les parapets) : ceux qu'on franchit (reliés au sol à leurs deux bouts), et ceux qui ferment le passage. */
function decks(arena: ArenaLayout): { bridges: StaticBox[]; blocking: StaticBox[] } {
  const hit = deckCache.get(arena);
  if (hit) return hit;
  const bridges: StaticBox[] = [];
  const blocking: StaticBox[] = [];
  for (const box of arena.boxes) {
    if (box.kind !== "deck" || Math.min(box.half.x, box.half.z) < 1) continue;
    const top = box.pos.y + box.half.y;
    const along = box.half.x > box.half.z ? vec3(box.half.x + 1, 0, 0) : vec3(0, 0, box.half.z + 1);
    const ends = [1, -1].map((s) => groundLevel(arena, box.pos.x + s * along.x, box.pos.z + s * along.z));
    if (ends.every((g) => Math.abs(top - g) < DECK_LANDING)) bridges.push(box);
    else if (box.pos.y - box.half.y - groundLevel(arena, box.pos.x, box.pos.z) < DECK_HEADROOM) blocking.push(box);
  }
  deckCache.set(arena, { bridges, blocking });
  return { bridges, blocking };
}

/**
 * Ce qui se foule même si le relief dessous ne le permet pas : les rampes, qu'on suit dans leur
 * largeur (`ramps`), et, au-dessus de l'eau profonde, les pistes qui y plongent (un quai, une jetée)
 * et les plateformes qui s'y dressent (le pont d'un navire, où mènent ses passerelles), dont on ouvre
 * toutes les cases (`floors`).
 */
function walkways(arena: ArenaLayout): { ramps: StaticBox[]; floors: StaticBox[] } {
  const water = arena.water;
  const ramps = arena.boxes.filter((b) => b.kind === "ramp");
  if (water === undefined) return { ramps, floors: [] };
  const top = (b: StaticBox): number => b.pos.y + b.half.y;
  const floors = arena.boxes.filter((b) => top(b) > water && (
    (b.kind === "road" && b.pos.y - b.half.y < water) || (b.kind === "platform" && deepWaterAt(arena, b.pos.x, b.pos.z))
  ));
  return { ramps, floors };
}

function buildGrid(arena: ArenaLayout): NavGrid {
  const spec = arena.navGrid!;
  const half = arena.bounds.half;
  const n = Math.ceil((2 * half) / spec.cell);
  const min = -(n * spec.cell) / 2;
  const open = new Uint8Array(n * n);
  const { bridges, blocking } = decks(arena);
  const ways = walkways(arena);
  // Une case n'est sur un pont que si elle y est tout entière (on la traverse sans tomber), au moins le long de son axe
  const inset = (f: number): number => Math.max(0.05, f - spec.cell / 2);
  const under = (list: StaticBox[], x: number, z: number, onto: boolean): boolean => list.some((b) => {
    const f = footprint(b);
    return Math.abs(x - b.pos.x) <= (onto ? inset(f.x) : f.x) && Math.abs(z - b.pos.z) <= (onto ? inset(f.z) : f.z);
  });
  // Le sol, ou le dessus de ce qu'on foule au-dessus de l'eau (un quai cache la pente du relief jusqu'au fond)
  const floors = ways.floors.map((b) => ({ b, f: footprint(b), top: b.pos.y + b.half.y }));
  const g = (x: number, z: number): number => {
    let h = groundLevel(arena, x, z);
    for (const { b, f, top } of floors) if (top > h && Math.abs(x - b.pos.x) <= f.x && Math.abs(z - b.pos.z) <= f.z) h = top;
    return h;
  };
  const tan = Math.tan(spec.maxSlope);
  const probe = spec.cell * WATER_PROBE;
  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) {
      const x = min + (ix + 0.5) * spec.cell;
      const z = min + (iz + 0.5) * spec.cell;
      let ok: boolean;
      if (under(bridges, x, z, true) || under(ways.ramps, x, z, true) || under(ways.floors, x, z, false)) ok = true;
      else if (under(blocking, x, z, false)) ok = false;
      else {
        // La pente au centre de la case et à mi-chemin de ses voisines : une case au pied d'une paroi
        // (le talus d'une route de montagne) est fermée, et le robot qui suit le chemin reste au large
        const steep = [[0, 0], [probe, 0], [-probe, 0], [0, probe], [0, -probe]].some(([dx, dz]) => {
          const sx = (g(x + dx + SLOPE_PROBE, z + dz) - g(x + dx - SLOPE_PROBE, z + dz)) / (2 * SLOPE_PROBE);
          const sz = (g(x + dx, z + dz + SLOPE_PROBE) - g(x + dx, z + dz - SLOPE_PROBE)) / (2 * SLOPE_PROBE);
          return Math.hypot(sx, sz) > tan;
        });
        ok = !steep
          && lavaAt(arena.lava, x, z, LAVA_MARGIN) <= -LAVA_MARGIN
          && ![[0, 0], [probe, 0], [-probe, 0], [0, probe], [0, -probe]].some(([dx, dz]) => deepWaterAt(arena, x + dx, z + dz));
      }
      open[ix * n + iz] = ok ? 1 : 0;
    }
  }
  keepLargestRegion(open, n);
  return { cell: spec.cell, n, min, open };
}

/**
 * Ne garde ouverte que la plus grande région d'un seul tenant (voisinage 8, sans couper les coins,
 * comme A*) : un replat isolé sur le flanc d'un volcan, une case entre deux coulées, se ferment.
 * Toute case ouverte est ainsi atteignable depuis toutes les autres, et une destination n'oblige
 * jamais A* à fouiller toute l'arène pour rien.
 */
export function keepLargestRegion(open: Uint8Array, n: number): void {
  if (nativeReady()) nativeKeepLargestRegion(open, n);
  else keepLargestRegionTs(open, n);
}

/** `keepLargestRegion` en TypeScript : la référence de la simulation compilée (tests/native.test.ts). */
export function keepLargestRegionTs(open: Uint8Array, n: number): void {
  const region = new Int32Array(n * n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let c0 = 0; c0 < open.length; c0++) {
    if (!open[c0] || region[c0] >= 0) continue;
    const id = sizes.length;
    let count = 0;
    region[c0] = id;
    stack.push(c0);
    while (stack.length) {
      const c = stack.pop()!;
      count++;
      const cx = Math.floor(c / n);
      const cz = c % n;
      for (const [dx, dz] of NEIGHBORS) {
        const ix = cx + dx;
        const iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= n || iz >= n) continue;
        const k = ix * n + iz;
        if (!open[k] || region[k] >= 0) continue;
        if (dx && dz && (!open[ix * n + cz] || !open[cx * n + iz])) continue;
        region[k] = id;
        stack.push(k);
      }
    }
    sizes.push(count);
  }
  const biggest = sizes.indexOf(Math.max(...sizes));
  for (let c = 0; c < open.length; c++) if (open[c] && region[c] !== biggest) open[c] = 0;
}

/** Case qui contient (x, z), bornée à la grille. */
export function cellAt(grid: NavGrid, x: number, z: number): number {
  const ix = Math.min(grid.n - 1, Math.max(0, Math.floor((x - grid.min) / grid.cell)));
  const iz = Math.min(grid.n - 1, Math.max(0, Math.floor((z - grid.min) / grid.cell)));
  return ix * grid.n + iz;
}

/** Centre d'une case (y = 0). */
export function cellCenter(grid: NavGrid, cell: number): Vec3 {
  const ix = Math.floor(cell / grid.n);
  const iz = cell % grid.n;
  return vec3(grid.min + (ix + 0.5) * grid.cell, 0, grid.min + (iz + 0.5) * grid.cell);
}

/** (x, z) est-il franchissable ? Hors de la grille, non. */
export function isOpen(grid: NavGrid, x: number, z: number): boolean {
  const ix = Math.floor((x - grid.min) / grid.cell);
  const iz = Math.floor((z - grid.min) / grid.cell);
  return ix >= 0 && iz >= 0 && ix < grid.n && iz < grid.n && grid.open[ix * grid.n + iz] === 1;
}

/** L'IA peut-elle aller en (x, z) ? Toujours vrai dans une arène sans grille de passage. */
export function passable(arena: ArenaLayout, x: number, z: number): boolean {
  const grid = navGrid(arena);
  return !grid || isOpen(grid, x, z);
}

/** La case franchissable la plus proche de `cell` (elle-même si elle l'est), à moins de `reach` cases ; -1 sinon. */
export function nearestOpenCell(grid: NavGrid, cell: number, reach = 40): number {
  const native = nativeOf(grid);
  return native ? native.nearestOpenCell(cell, reach) : nearestOpenCellTs(grid, cell, reach);
}

/** `nearestOpenCell` en TypeScript (la référence). */
export function nearestOpenCellTs(grid: NavGrid, cell: number, reach = 40): number {
  if (grid.open[cell]) return cell;
  const cx = Math.floor(cell / grid.n);
  const cz = cell % grid.n;
  let best = -1;
  let bestD = Infinity;
  for (let r = 1; r <= reach; r++) {
    // Un anneau de cases à r de distance (en Tchebychev) : la plus proche (en euclidien) ; l'anneau suivant
    // peut encore en avoir une plus proche, jusqu'à r·√2
    if (best >= 0 && r > Math.sqrt(bestD) + 1) break;
    for (let dx = -r; dx <= r; dx++) {
      for (const dz of Math.abs(dx) === r ? range(-r, r) : [-r, r]) {
        const ix = cx + dx;
        const iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= grid.n || iz >= grid.n || !grid.open[ix * grid.n + iz]) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = ix * grid.n + iz;
        }
      }
    }
  }
  return best;
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Le point franchissable le plus proche de `p` : lui-même s'il l'est (ou sans grille), sinon le centre de la case la plus proche. */
export function nearestPassable(arena: ArenaLayout, p: Vec3): Vec3 {
  const grid = navGrid(arena);
  if (!grid || isOpen(grid, p.x, p.z)) return p;
  const cell = nearestOpenCell(grid, cellAt(grid, p.x, p.z));
  if (cell < 0) return p;
  const c = cellCenter(grid, cell);
  return vec3(c.x, p.y, c.z);
}

/**
 * La ligne droite de `a` à `b` ne passe-t-elle que par des cases franchissables ? On la suit par
 * demi-cases ; la case de départ ne compte pas (un robot qui y est déjà doit pouvoir en sortir).
 */
export function clearLine(grid: NavGrid, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const steps = Math.ceil(Math.hypot(dx, dz) / (grid.cell * 0.5));
  const start = cellAt(grid, a.x, a.z);
  for (let i = 1; i <= steps; i++) {
    const x = a.x + (dx * i) / steps;
    const z = a.z + (dz * i) / steps;
    if (!isOpen(grid, x, z) && cellAt(grid, x, z) !== start) return false;
  }
  return true;
}

/**
 * Poids de l'estimation de A* : au-delà de 1, il cherche moins (beaucoup moins derrière un grand
 * obstacle, le volcan) pour un chemin à peine plus long que le plus court.
 */
const GREED = 1.4;

/**
 * La grille copiée dans la simulation compilée (crates/casse-sim/src/navgrid.rs), quand elle est
 * chargée : A*, l'approche et la case ouverte la plus proche y tournent, avec les mêmes résultats
 * (tests/native.test.ts). Une grille ne change plus une fois faite ; sa copie part avec elle.
 */
const natives = new WeakMap<NavGrid, NativeGrid>();
const release = new FinalizationRegistry<NativeGrid>((native) => native.free());
function nativeOf(grid: NavGrid): NativeGrid | null {
  if (!nativeReady()) return null;
  let native = natives.get(grid);
  if (!native) {
    native = new NativeGrid(grid.n, grid.open);
    natives.set(grid, native);
    release.register(grid, native);
  }
  return native;
}

/** Tableaux de travail de A*, un jeu par grille (remis à zéro à chaque recherche) ; le tas garde ses clés à côté de ses cases. */
interface Scratch {
  cost: Float64Array;
  from: Int32Array;
  closed: Uint8Array;
  heap: Int32Array;
  keys: Float64Array;
}
const scratches = new WeakMap<NavGrid, Scratch>();
function scratchOf(grid: NavGrid): Scratch {
  let s = scratches.get(grid);
  if (!s) {
    const size = grid.n * grid.n;
    // Une case peut entrer plusieurs fois dans le tas (à chaque amélioration) : au plus une fois par voisin
    s = { cost: new Float64Array(size), from: new Int32Array(size), closed: new Uint8Array(size), heap: new Int32Array(size * 8), keys: new Float64Array(size * 8) };
    scratches.set(grid, s);
  }
  return s;
}

const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * Chemin vers la case la plus proche de `goal` (à vol d'oiseau) qu'on atteint depuis `start` en
 * visitant au plus `budget` cases (parcours en largeur, huit voisins, sans couper les coins) : se
 * rapprocher sans faire de grand détour. La case de départ peut être fermée.
 */
export function approachPath(grid: NavGrid, start: number, goal: number, budget: number): number[] {
  const native = nativeOf(grid);
  return native ? native.approachPath(start, goal, budget) : approachPathTs(grid, start, goal, budget);
}

/** `approachPath` en TypeScript (la référence). */
export function approachPathTs(grid: NavGrid, start: number, goal: number, budget: number): number[] {
  const n = grid.n;
  const { from, closed } = scratchOf(grid);
  from.fill(-1);
  closed.fill(0);
  const gx = Math.floor(goal / n);
  const gz = goal % n;
  const far = (c: number): number => dpow(Math.floor(c / n) - gx, 2) + dpow((c % n) - gz, 2);
  const queue = [start];
  closed[start] = 1;
  let best = start;
  for (let head = 0; head < queue.length && head < budget; head++) {
    const c = queue[head];
    if (far(c) < far(best)) best = c;
    const cx = Math.floor(c / n);
    const cz = c % n;
    for (const [dx, dz] of NEIGHBORS) {
      const ix = cx + dx;
      const iz = cz + dz;
      if (ix < 0 || iz < 0 || ix >= n || iz >= n) continue;
      const k = ix * n + iz;
      if (!grid.open[k] || closed[k]) continue;
      if (dx && dz && (!grid.open[ix * n + cz] || !grid.open[cx * n + iz])) continue;
      closed[k] = 1;
      from[k] = c;
      queue.push(k);
    }
  }
  const path: number[] = [];
  for (let k = best; k !== -1; k = from[k]) path.push(k);
  return path.reverse();
}

/**
 * Chemin (cases, du départ à l'arrivée) par les cases franchissables, ou null s'il n'y en a pas.
 * La case de départ peut être fermée (un robot poussé hors du chemin en sort par une voisine).
 */
export function findPath(grid: NavGrid, start: number, goal: number): number[] | null {
  const native = nativeOf(grid);
  return native ? native.findPath(start, goal) : findPathTs(grid, start, goal);
}

/** `findPath` en TypeScript (la référence). */
export function findPathTs(grid: NavGrid, start: number, goal: number): number[] | null {
  if (!grid.open[goal]) return null;
  const n = grid.n;
  const { cost, from, closed, heap, keys } = scratchOf(grid);
  cost.fill(Infinity);
  from.fill(-1);
  closed.fill(0);
  const gx = Math.floor(goal / n);
  const gz = goal % n;
  // Le tas : des cases rangées par coût estimé croissant
  let size = 0;
  const push = (cell: number, key: number): void => {
    let i = size++;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up] <= key) break;
      heap[i] = heap[up];
      keys[i] = keys[up];
      i = up;
    }
    heap[i] = cell;
    keys[i] = key;
  };
  const pop = (): number => {
    const top = heap[0];
    const cell = heap[--size];
    const key = keys[size];
    let i = 0;
    for (;;) {
      let m = 2 * i + 1;
      if (m >= size) break;
      if (m + 1 < size && keys[m + 1] < keys[m]) m++;
      if (keys[m] >= key) break;
      heap[i] = heap[m];
      keys[i] = keys[m];
      i = m;
    }
    heap[i] = cell;
    keys[i] = key;
    return top;
  };
  const estimate = (ix: number, iz: number): number => {
    const dx = Math.abs(ix - gx);
    const dz = Math.abs(iz - gz);
    return GREED * (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz));
  };
  cost[start] = 0;
  push(start, estimate(Math.floor(start / n), start % n));
  while (size) {
    const c = pop();
    if (c === goal) {
      const path: number[] = [];
      for (let k = goal; k !== -1; k = from[k]) path.push(k);
      return path.reverse();
    }
    if (closed[c]) continue;
    closed[c] = 1;
    const cx = Math.floor(c / n);
    const cz = c % n;
    for (const [dx, dz, step] of NEIGHBORS) {
      const ix = cx + dx;
      const iz = cz + dz;
      if (ix < 0 || iz < 0 || ix >= n || iz >= n) continue;
      const k = ix * n + iz;
      if (!grid.open[k] || closed[k]) continue;
      // En diagonale, seulement si les deux cases voisines sont ouvertes : on ne coupe pas un coin
      if (dx && dz && (!grid.open[ix * n + cz] || !grid.open[cx * n + iz])) continue;
      const g = cost[c] + step;
      if (g >= cost[k] || size >= heap.length) continue;
      cost[k] = g;
      from[k] = c;
      push(k, g + estimate(ix, iz));
    }
  }
  return null;
}
