import { ARENA_IDS, gameArena, isArenaId, type ArenaId, type ArenaKey, type ArenaLayout } from "../../shared/arena/layout";
import type { MapFile } from "../../shared/map/format";
import { gameArenaFile, hasGameArenaFile, provideGameArenaText } from "../../shared/map/gameArenas";
import { arenaOfPath } from "./smallArenas";

/*
 * Les arènes du jeu dans le navigateur : leurs fichiers de carte (content/arenas/, faits par
 * `npm run map:export` d'après le code des arènes, qui n'est plus dans le paquet). Les petites sont
 * dans le paquet (smallArenas.ts) ; chaque grande (170 à 590 Ko de fichier, 40 à 230 Ko compressée)
 * est dans son morceau, téléchargé quand on la joue (`App.play` l'attend derrière l'écran de
 * chargement ; en réseau, net/netClient.ts retient les images qui l'annoncent) ou qu'on la montre (le
 * choix de l'arène dessine son plan, la démonstration derrière le menu s'y promène). Une fois là, elle
 * reste, et le navigateur garde son morceau (un nom haché, servi en cache permanent).
 */
const LARGE = import.meta.glob<string>(["/content/arenas/*.casse-map.json", "!/content/arenas/{depot,fort,trenches,yard}.casse-map.json"], {
  query: "?raw",
  import: "default",
});
/** Le morceau de chaque grande arène, par identifiant. */
const CHUNKS = new Map<string, () => Promise<string>>(Object.entries(LARGE).map(([path, read]) => [arenaOfPath(path) ?? path, read]));

/** Les chargements en cours ou faits, par arène. */
const loads = new Map<ArenaId, Promise<void>>();

/** Ce qu'a coûté le chargement de chaque grande arène (ms) : son morceau téléchargé, puis son fichier lu (`__casse.arenas.times`). */
export const LOAD_TIMES = new Map<ArenaId, { fetch: number; read: number }>();

/**
 * Charge le fichier d'une arène du jeu (une fois ; on peut l'attendre plusieurs fois). Une petite
 * arène, une carte communautaire : rien à charger ici. Un échec (le réseau) se retente à la demande suivante.
 */
export function loadArena(key: ArenaKey): Promise<void> {
  if (!isArenaId(key) || hasGameArenaFile(key)) return Promise.resolve();
  let load = loads.get(key);
  if (!load) {
    const chunk = CHUNKS.get(key);
    const start = performance.now();
    load = chunk
      ? chunk().then((text) => {
        const fetched = performance.now();
        provideGameArenaText(key, text);
        LOAD_TIMES.set(key, { fetch: fetched - start, read: performance.now() - fetched });
      })
      : Promise.reject(new Error(`Pas de fichier pour l'arène du jeu ${key}`));
    loads.set(key, load);
    load.catch(() => loads.delete(key));
  }
  return load;
}

/** L'arène du jeu, une fois son fichier chargé (construite à la première demande, une fois). */
export async function loadedArena(id: ArenaId): Promise<ArenaLayout> {
  await loadArena(id);
  return gameArena(id);
}

/** L'arène se joue-t-elle tout de suite (son fichier est là ; une carte communautaire : toujours) ? */
export const arenaReady = (key: ArenaKey): boolean => !isArenaId(key) || hasGameArenaFile(key);

/** Les arènes du jeu dont le fichier est là. */
export const readyArenas = (): ArenaId[] => ARENA_IDS.filter((id) => hasGameArenaFile(id));

/** Le fichier d'une arène du jeu, s'il est là : le Worker de la partie solo le reçoit avec la partie. */
export const arenaFile = (id: ArenaId): MapFile | undefined => (hasGameArenaFile(id) ? gameArenaFile(id) : undefined);

/** Ce qu'on dit d'une arène dans le choix de l'arène : sa taille, ses zones, le jour ou la nuit. */
export interface ArenaFacts {
  readonly half: number;
  readonly zones: number;
  readonly night: boolean;
}

/** Les faits d'une arène du jeu, lus dans son fichier une fois chargé (sans la construire). */
export async function arenaFacts(id: ArenaId): Promise<ArenaFacts> {
  await loadArena(id);
  const map = gameArenaFile(id)!;
  return { half: map.bounds.half, zones: map.zones.length, night: !!map.sky?.night };
}
