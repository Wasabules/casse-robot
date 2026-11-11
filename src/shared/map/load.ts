import { arenaById, registerArena, type ArenaLayout } from "../arena/layout";
import { arenaFromMap } from "./build";
import type { MapFile } from "./format";
import { mapKey } from "./key";

/*
 * Une carte dans le jeu : son arène, connue sous son identifiant (`registerArena`, arena/layout.ts)
 * ; `Simulation.loadArena` la charge ensuite comme une arène du jeu. Une carte déjà connue n'est pas
 * reconstruite (sa grille de passage, calculée une fois, reste).
 */

/** L'arène d'une carte (déjà lue : `readMap`, `checkMap`), connue désormais sous son identifiant. */
export function registerMap(map: MapFile): ArenaLayout {
  const key = mapKey(map);
  const known = arenaById(key);
  if (known) return known;
  const arena = arenaFromMap(map, key);
  registerArena(arena);
  return arena;
}
