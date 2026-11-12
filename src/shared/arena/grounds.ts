import { NO_PEAK, VALLEY_GROUND, type GroundStyle } from "./features";
import type { ArenaId } from "./layout";

/*
 * Palettes du sol des arènes du jeu : celle que le code de chacune lui donne (arena/canyon.ts…), que
 * son fichier écrit (content/arenas/), et dont part une carte communautaire qui la nomme
 * (`MapGround.preset`, map/build.ts ; l'éditeur de cartes les propose). À part du code des arènes,
 * que le jeu ne charge plus : construire une carte n'a besoin que de ceci, sans lire le fichier d'une
 * autre arène.
 */

/** Le Canyon : grès rouge, sable, strates des falaises ; ni neige ni cendre au sommet de la Table. */
export const CANYON_GROUND: GroundStyle = {
  base: ["#c98f5b", "#d6a46c"],
  dirt: "#a8714a",
  sand: "#dcc391",
  mud: "#6a5a40",
  rock: "#a4573a",
  strata: ["#9a4a2e", "#b8653f", "#cf8f5f", "#a95536", "#dcae7c", "#8f4430"],
  strataStep: 1.7,
  rockLine: 34,
  peak: "#eef1f3",
  peakLine: NO_PEAK,
  // L'herbe autour de l'étang de l'oasis (à -79, -12 : arena/canyon.ts), un pré sec à côté
  patches: [{ x: -79, z: -12, r: 15, color: "#7f8f45" }, { x: -66, z: -4, r: 8, color: "#a99a5a" }],
};

/** La Cité : dalles et pavés tachés de crasse, talus de terre sèche sur les pentes, gravats au-dessus de 10,5 m. */
export const CITY_GROUND: GroundStyle = {
  base: ["#8d8980", "#a09a8e"], dirt: "#6d675c", sand: "#8d8980", mud: "#6d675c", rock: "#726c64", peak: "#726c64",
  rockLine: 10.5, rockSpan: 3, peakLine: NO_PEAK, grain: 7, stains: 0.35,
  slope: { color: "#77705d", from: 0.985, span: 0.04 }, lawn: "#5d7a3e",
};

/** L'Île volcanique : jungle, sable des plages, roche puis cendre du volcan, basalte au bord de la lave. */
export const ISLAND_GROUND: GroundStyle = {
  base: ["#4c8a32", "#6fa645"], dirt: "#8d6c47", sand: "#dccb94", mud: "#6f6c56", rock: "#665d55", peak: "#3e3936",
  rockLine: 9, peakLine: 21, beach: 1.5, basalt: "#2c2722", basaltWidth: 4,
};

/** Le Port : le béton des quais et ses taches ; l'herbe des collines au-dessus des quais (à 6 m, et 1,5 m plus haut). */
export const PORT_GROUND: GroundStyle = {
  base: ["#8a8984", "#7e7d78"], dirt: "#5d5f61", sand: "#6f6d66", mud: "#3c4846", rock: "#6c7d47", peak: "#77736b",
  rockLine: 7.5, rockSpan: 2, peakLine: 30, stains: 0.15, grain: 6, slope: { color: "#6c7d47", from: 0.82, span: 0.18 },
};

/** La palette de chaque arène du jeu ; undefined : celle de la Vallée (`VALLEY_GROUND`), par défaut. */
export const ARENA_GROUNDS: Readonly<Record<ArenaId, GroundStyle | undefined>> = {
  depot: undefined, fort: undefined, trenches: undefined, yard: undefined, valley: undefined,
  canyon: CANYON_GROUND, island: ISLAND_GROUND, city: CITY_GROUND, cityNight: CITY_GROUND, port: PORT_GROUND,
};

/** La palette d'une arène du jeu (celle de la Vallée sans la sienne). */
export const arenaGround = (id: ArenaId): GroundStyle => ARENA_GROUNDS[id] ?? VALLEY_GROUND;
