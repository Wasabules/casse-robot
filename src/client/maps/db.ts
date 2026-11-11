import type { MapKey } from "../../shared/arena/layout";
import type { MapFile } from "../../shared/map/format";

/*
 * Les cartes gardées dans le navigateur, dans IndexedDB (une carte pèse jusqu'à quelques centaines
 * de Ko : localStorage serait trop petit) : celles qu'on a importées ou faites (`library`), et
 * celles que des serveurs ont envoyées (`cache`, d'après leur identifiant : on ne les reçoit qu'une
 * fois), et le brouillon de l'éditeur de cartes (`drafts`, gardé à chaque modification : un
 * rechargement de la page ne perd rien). Sans IndexedDB (navigation privée de certains
 * navigateurs), rien n'est gardé : les fonctions rendent des listes vides, sans erreur.
 */

const DB_NAME = "casse-robot-maps";
/** 2 : le brouillon de l'éditeur de cartes. */
const DB_VERSION = 2;
export type MapStore = "library" | "cache";
/** Les magasins : les cartes, et les brouillons de l'éditeur (une entrée par brouillon, sous sa clé). */
const STORES: readonly (MapStore | "drafts")[] = ["library", "cache", "drafts"];
/** Au plus autant d'attente pour ouvrir la base (s) ; au-delà, on fait sans. */
const OPEN_TIMEOUT = 4;

/** Une carte gardée : son identifiant, la carte, le nom du fichier d'où elle vient, quand. */
export interface StoredMap {
  readonly key: MapKey;
  readonly map: MapFile;
  readonly file?: string;
  readonly saved: number;
}

let opening: Promise<IDBDatabase | null> | null = null;

/** La base (ouverte une fois), ou null si le navigateur n'en donne pas. */
export function mapDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn("Cartes : IndexedDB indisponible", request.error);
        resolve(null);
      };
      request.onblocked = () => resolve(null);
      // Une base qui ne répond pas ne doit pas bloquer le démarrage du jeu (qui attend les cartes)
      setTimeout(() => resolve(null), OPEN_TIMEOUT * 1000);
    } catch (e) {
      console.warn("Cartes : IndexedDB indisponible", e);
      resolve(null);
    }
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Toutes les cartes d'un magasin. */
export async function readMaps(store: MapStore): Promise<StoredMap[]> {
  const db = await mapDb();
  if (!db) return [];
  try {
    return await done(db.transaction(store, "readonly").objectStore(store).getAll() as IDBRequest<StoredMap[]>);
  } catch (e) {
    console.warn(`Cartes : lecture de ${store} impossible`, e);
    return [];
  }
}

/** Garde une carte (la remplace si elle y est déjà) ; faux si le navigateur ne garde rien. */
export async function writeMap(store: MapStore, entry: StoredMap): Promise<boolean> {
  const db = await mapDb();
  if (!db) return false;
  try {
    await done(db.transaction(store, "readwrite").objectStore(store).put(entry));
    return true;
  } catch (e) {
    console.warn(`Cartes : écriture dans ${store} impossible`, e);
    return false;
  }
}

export async function deleteMap(store: MapStore, key: MapKey): Promise<void> {
  const db = await mapDb();
  if (!db) return;
  try {
    await done(db.transaction(store, "readwrite").objectStore(store).delete(key));
  } catch (e) {
    console.warn(`Cartes : suppression dans ${store} impossible`, e);
  }
}

/** Lit l'entrée `key` d'un magasin de brouillons (null : rien, ou pas d'IndexedDB). */
export async function readDraftEntry<T>(key: string): Promise<T | null> {
  const db = await mapDb();
  if (!db) return null;
  try {
    return ((await done(db.transaction("drafts", "readonly").objectStore("drafts").get(key))) as T | undefined) ?? null;
  } catch (e) {
    console.warn("Cartes : lecture du brouillon impossible", e);
    return null;
  }
}

/** Garde un brouillon (`entry.key` : sa clé) ; faux si le navigateur ne garde rien. */
export async function writeDraftEntry(entry: { readonly key: string }): Promise<boolean> {
  const db = await mapDb();
  if (!db) return false;
  try {
    await done(db.transaction("drafts", "readwrite").objectStore("drafts").put(entry));
    return true;
  } catch (e) {
    console.warn("Cartes : écriture du brouillon impossible", e);
    return false;
  }
}

export async function deleteDraftEntry(key: string): Promise<void> {
  const db = await mapDb();
  if (!db) return;
  try {
    await done(db.transaction("drafts", "readwrite").objectStore("drafts").delete(key));
  } catch (e) {
    console.warn("Cartes : suppression du brouillon impossible", e);
  }
}
