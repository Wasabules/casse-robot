import { arenaById, registerArena, type ArenaLayout, type MapKey } from "../arena/layout";
import { arenaFromMap } from "./build";
import type { MapFile } from "./format";
import { mapKey } from "./key";

/*
 * Une carte dans le jeu : son arène, connue sous son identifiant (`registerArena`, arena/layout.ts)
 * ; `Simulation.loadArena` la charge ensuite comme une arène du jeu. Une carte déjà connue n'est pas
 * reconstruite (sa grille de passage, calculée une fois, reste).
 */

/** Les cartes connues, par identifiant (la partie solo dans un Worker la lui donne : il la fait connaître à son tour). */
const files = new Map<MapKey, MapFile>();

/** La carte de cet identifiant, si elle a été faite connaître ici (`registerMap`). */
export function mapFileOf(key: MapKey): MapFile | undefined {
  return files.get(key);
}

/** L'arène d'une carte (déjà lue : `readMap`, `checkMap`), connue désormais sous son identifiant. */
export function registerMap(map: MapFile): ArenaLayout {
  const key = mapKey(map);
  files.set(key, map);
  const known = arenaById(key);
  if (known) return known;
  const arena = arenaFromMap(map, key);
  registerArena(arena);
  return arena;
}
