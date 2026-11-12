import { isArenaId } from "../../shared/arena/layout";
import { MAP_EXTENSION } from "../../shared/map/format";
import { provideGameArenaText } from "../../shared/map/gameArenas";

/*
 * Les petites arènes du jeu (le Dépôt, l'arène par défaut, la Forteresse, les Tranchées, le Chantier :
 * ~3 Ko de fichier chacune, content/arenas/), dans le paquet : la première `Simulation` et la première
 * réplique se font au Dépôt, avant que rien n'ait pu être chargé, et la démonstration derrière le menu
 * a de quoi varier d'emblée. La page (client/maps/gameArenas.ts) et le Worker de la partie solo
 * (client/sim/simWorker.ts) importent ce module ; les grandes arènes se chargent à la demande.
 */
const SMALL = import.meta.glob<string>("/content/arenas/{depot,fort,trenches,yard}.casse-map.json", { eager: true, query: "?raw", import: "default" });

/** L'arène d'un chemin de fichier (« /content/arenas/depot.casse-map.json » : « depot »), ou null. */
export function arenaOfPath(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  return name.endsWith(MAP_EXTENSION) ? name.slice(0, -MAP_EXTENSION.length) : null;
}

for (const [path, text] of Object.entries(SMALL)) {
  const id = arenaOfPath(path);
  if (isArenaId(id)) provideGameArenaText(id, text);
}
