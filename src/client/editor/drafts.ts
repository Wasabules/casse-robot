import type { MapKey } from "../../shared/arena/layout";
import type { MapFile } from "../../shared/map/format";
import { readMap } from "../../shared/map/read";
import { deleteDraftEntry, readDraftEntry, writeDraftEntry } from "../maps/db";
import type { MapOrigin } from "../maps/library";

/*
 * Le brouillon de l'éditeur de cartes, gardé dans le navigateur (IndexedDB, magasin `drafts`) à
 * chaque modification : un rechargement de la page ne perd rien, et l'éditeur se rouvre où l'on en
 * était. Il garde aussi l'identité de la carte : la version de la bibliothèque qu'il remplacera en
 * l'enregistrant (une carte livrée avec le jeu ou reçue d'un serveur s'enregistre en copie).
 */

/** D'où vient le brouillon : une carte de la bibliothèque (`key`), un fichier, ou rien (une nouvelle carte). */
export interface DraftSource {
  readonly key: MapKey | null;
  readonly origin: MapOrigin | "file" | null;
  readonly file?: string;
}

/** La vue de l'éditeur, retrouvée avec le brouillon. */
export interface DraftView {
  readonly alpha: number;
  readonly beta: number;
  readonly radius: number;
  readonly x: number;
  readonly z: number;
  readonly top: boolean;
}

export interface Draft {
  readonly map: MapFile;
  readonly source: DraftSource;
  /** Des modifications ne sont pas dans la bibliothèque. */
  readonly dirty: boolean;
  readonly view?: DraftView;
  readonly saved: number;
}

/** La clé du brouillon (il n'y en a qu'un). */
const KEY = "current";

/** Le brouillon gardé (relu : une carte que ce jeu ne lit plus est écartée), ou null. */
export async function loadDraft(): Promise<Draft | null> {
  const stored = await readDraftEntry<Draft & { key: string }>(KEY);
  if (!stored?.map) return null;
  const read = readMap(stored.map);
  if (!read.ok) {
    console.warn("Éditeur de cartes : brouillon illisible, écarté", read.issues);
    return null;
  }
  return { map: read.map, source: stored.source ?? { key: null, origin: null }, dirty: !!stored.dirty, view: stored.view, saved: stored.saved ?? 0 };
}

export function saveDraft(draft: Draft): Promise<boolean> {
  return writeDraftEntry({ key: KEY, ...draft });
}

export function dropDraft(): Promise<void> {
  return deleteDraftEntry(KEY);
}
