import type { ArenaLayout, StaticBox } from "../arena/layout";
import { navGrid } from "../arena/navgrid";
import type { SimModule } from "./simModule";

/*
 * Une arène donnée à la simulation portée, champ par champ, comme `loadArena` la met en place dans
 * la simulation du TypeScript (`buildScenery` : ses boîtes, puis son relief) : ce sont les mêmes
 * corps de Rapier, créés dans le même ordre. La grille de passage de l'IA est celle que calcule le
 * TypeScript (`navGrid`) : ses cases sont données au module.
 */

/** Les boîtes d'un décor, dans l'ordre (et ce qu'un tablier dit de plus). */
export function giveBoxes(m: SimModule, sim: number, boxes: readonly StaticBox[]): void {
  for (const b of boxes) {
    m.withText(b.kind, (ptr, len) =>
      m.x.sim_add_box(sim, ptr, len, b.pos.x, b.pos.y, b.pos.z, b.half.x, b.half.y, b.half.z, b.rot.x, b.rot.y, b.rot.z, b.rot.w, b.round ? 1 : 0));
  }
  for (const [i, b] of boxes.entries()) if (b.underpass || b.approach !== undefined) m.x.sim_set_deck(sim, i, b.underpass ? 1 : 0, b.approach ?? NaN);
}

/**
 * Le décor de l'arène et ce qui en découle : ses boîtes, son relief, ses dimensions et ses planchers
 * de vol, son eau (`water` : un autre niveau, pour un essai), sa lave, si c'est une ville, sa grille
 * de passage et son réseau de passage.
 */
export function giveScenery(m: SimModule, sim: number, arena: ArenaLayout, water: number | undefined = arena.water): void {
  giveBoxes(m, sim, arena.boxes);
  const t = arena.terrain;
  if (t) m.withBytes(t.heights, (ptr) => m.x.sim_set_terrain(sim, t.size, t.cells, ptr, t.heights.length));
  m.x.sim_set_bounds(sim, arena.bounds.half, arena.bounds.roam, arena.bounds.circuit);
  m.x.sim_set_floors(sim, arena.bounds.airFloor ?? 0, arena.bounds.hoverFloor ?? 0);
  m.x.sim_set_water(sim, water ?? NaN);
  m.x.sim_set_deep_water(sim, arena.deepWater ?? NaN);
  for (const shape of arena.lava ?? []) {
    if (shape.kind === "pool") m.x.sim_add_lava_pool(sim, shape.x, shape.z, shape.r);
    else m.withBytes(new Float64Array(shape.points.flat()), (ptr) => m.x.sim_add_lava_flow(sim, shape.width, ptr, shape.points.length));
  }
  m.x.sim_set_urban(sim, arena.urban ? 1 : 0);
  const grid = navGrid(arena);
  if (grid) m.withBytes(grid.open, (ptr) => m.x.sim_set_nav_grid(sim, grid.cell, grid.n, grid.min, ptr));
  const nav = arena.nav;
  if (nav) {
    m.withBytes(new Float64Array(nav.points.flat()), (points) =>
      m.withBytes(new Uint32Array(nav.links.flat()), (links) => m.x.sim_set_nav_graph(sim, points, nav.points.length, links, nav.links.length)));
  }
}

/**
 * Toute l'arène, pour une partie : son décor (`giveScenery`), ses lignes de départ, les emplacements
 * de ses accessoires (que `resetProps` remplira) et ses zones à capturer.
 */
export function giveArena(m: SimModule, sim: number, arena: ArenaLayout): void {
  giveScenery(m, sim, arena);
  const { spawnLine, spawnSpread, spawns } = arena.bounds;
  const red = spawns?.red;
  const blue = spawns?.blue;
  m.x.sim_set_spawns(sim, spawnLine, spawnSpread, spawns ? 1 : 0,
    red?.x ?? 0, red?.z ?? 0, red?.facing ?? 0, red?.spread ?? 0, blue?.x ?? 0, blue?.z ?? 0, blue?.facing ?? 0, blue?.spread ?? 0);
  for (const [i, s] of arena.props.entries()) {
    const r = s.rot;
    const h = s.half;
    const spot = m.withText(s.type, (ptr, len) =>
      m.x.sim_add_spot(sim, ptr, len, s.pos.x, s.pos.y, s.pos.z, r?.x ?? NaN, r?.y ?? NaN, r?.z ?? NaN, r?.w ?? NaN, h?.x ?? NaN, h?.y ?? NaN, h?.z ?? NaN, s.scale ?? NaN));
    if (spot !== i) throw new Error(`emplacement ${i} : ${m.lastError()}`);
    if (s.building !== undefined) m.x.sim_prop_building(sim, i, s.building);
  }
  for (const [i, s] of arena.props.entries()) for (const on of s.rests ?? []) m.x.sim_spot_rest(sim, i, on);
  for (const z of arena.zones) m.x.sim_add_zone(sim, z.pos.x, z.pos.y, z.pos.z, z.radius);
}
