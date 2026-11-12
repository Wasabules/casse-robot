import { setGameArenaSource, type ArenaId, type ArenaLayout } from "../arena/layout";
import { arenaFromMap } from "./build";
import { MAP_EXTENSION, type MapFile } from "./format";
import { readMapText } from "./read";

/*
 * Les arènes du jeu, lues de leurs fichiers de carte : content/arenas/<id>.casse-map.json, écrits par
 * `npm run map:export` d'après le code des arènes (arena/sources.ts), qui reste leur source et la
 * référence de l'aller-retour (tests/arenaExport.test.ts : au bit près, relief compris). Le code
 * partagé n'a ni `fetch` ni `fs` : qui le fait tourner fournit les fichiers. Le client a les petites
 * arènes dans son paquet et charge les grandes à la demande (client/maps/gameArenas.ts), puis donne au
 * Worker de la partie solo celle qu'il va jouer (`SessionCommand` `start`, net/session.ts) ; le serveur
 * (server/main.ts) et les essais (tests/arenaFiles.ts) les lisent sur le disque, à la demande
 * (`readGameArenasWith`). Une arène se construit à sa première demande (`arenaById`, `ARENAS`,
 * arena/layout.ts), une seule fois.
 */

/** Dossier des fichiers des arènes du jeu (depuis la racine du dépôt). */
export const GAME_ARENA_DIR = "content/arenas";
/** Nom du fichier d'une arène du jeu, dans `GAME_ARENA_DIR`. */
export const gameArenaFileName = (id: ArenaId): string => `${id}${MAP_EXTENSION}`;

/** Les fichiers fournis, déjà lus (`readMapText`), par arène. */
const files = new Map<ArenaId, MapFile>();
/** Lecture synchrone du texte d'un fichier, à la demande (Node : le disque) ; undefined s'il n'y en a pas. */
let reader: ((id: ArenaId) => string | undefined) | null = null;

/**
 * Le texte du fichier d'une arène du jeu, lu ; une erreur s'il ne se lit pas (une donnée du jeu, que
 * les essais vérifient : `npm run map:export` la refait).
 */
export function readGameArenaText(id: ArenaId, text: string): MapFile {
  const read = readMapText(text);
  if (!read.ok) throw new Error(`Le fichier de l'arène ${id} ne se lit pas : ${JSON.stringify(read.issues)}`);
  return read.map;
}

/** Fournit le texte du fichier d'une arène du jeu : lu tout de suite, l'arène construite à sa première demande. */
export function provideGameArenaText(id: ArenaId, text: string): void {
  if (!files.has(id)) files.set(id, readGameArenaText(id, text));
}

/** Fournit le fichier d'une arène du jeu, déjà lu (le Worker de la partie solo le reçoit ainsi de la page). */
export function provideGameArenaFile(id: ArenaId, map: MapFile): void {
  if (!files.has(id)) files.set(id, map);
}

/** Lit les fichiers des arènes du jeu à la demande, de façon synchrone (Node : `readFileSync`) ; `read` rend undefined s'il n'y en a pas. */
export function readGameArenasWith(read: (id: ArenaId) => string | undefined): void {
  reader = read;
}

/** Le fichier de cette arène du jeu a-t-il été fourni (sans le lire sur le disque) ? */
export const hasGameArenaFile = (id: ArenaId): boolean => files.has(id);

/** Le fichier d'une arène du jeu, s'il a été fourni (ou si on sait le lire) ; undefined sinon. */
export function gameArenaFile(id: ArenaId): MapFile | undefined {
  let map = files.get(id);
  if (!map && reader) {
    const text = reader(id);
    if (text !== undefined) {
      map = readGameArenaText(id, text);
      files.set(id, map);
    }
  }
  return map;
}

/** L'arène du jeu d'après son fichier : celle de son code au bit près (son identifiant, ses noms traduits). */
export const gameArenaFromMap = (id: ArenaId, map: MapFile): ArenaLayout => arenaFromMap(map, id);

// Les arènes du jeu viennent de leurs fichiers
setGameArenaSource((id) => {
  const map = gameArenaFile(id);
  return map && gameArenaFromMap(id, map);
});
