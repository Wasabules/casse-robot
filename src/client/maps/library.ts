import { arenaById, unregisterArena, type ArenaLayout, type MapKey } from "../../shared/arena/layout";
import { MAP_LIMITS, PACKAGE_LIMITS, type MapFile, type MapIssue } from "../../shared/map/format";
import { mapKey } from "../../shared/map/key";
import { registerMap } from "../../shared/map/load";
import { isArchive, readMapArchive } from "../../shared/map/pack";
import { checkMap, checkMapText } from "../../shared/map/validate";
import { compareText } from "../i18n/format";
import { authored } from "../i18n/names";
import { mapAssets, type MapAssetStore } from "./assets";
import { deleteMap, mapDb, readDraftMaps, readMaps, writeMap, type MapStore } from "./db";
import { inflate, inflateRaw } from "./files";

/*
 * Les cartes communautaires que connaît ce navigateur : celles livrées avec le jeu (le dossier
 * `maps/` du dépôt, compilé avec la page), celles qu'on a importées ou faites (IndexedDB), et celles
 * que des serveurs ont envoyées (IndexedDB aussi, d'après leur identifiant). Chacune est revérifiée
 * en la chargeant (`checkMap` : le jeu a pu changer depuis). Une carte devient une arène jouable à
 * la demande (`arena`), et `Simulation.loadArena` la trouve ensuite par son identifiant. Une carte
 * venue d'un paquet (`importPackage`) a ses ressources à part (modèles, ambiance : `assets`,
 * client/maps/assets.ts), d'après leur empreinte ; supprimer la carte oublie celles que plus rien
 * n'utilise.
 *
 * C'est aussi ce dont l'éditeur de cartes se sert pour enregistrer (`save`), supprimer (`remove`),
 * importer (`importText`, `importFile`) et lister (`list`) les cartes.
 */

/** D'où vient une carte : livrée avec le jeu, importée ou faite ici, reçue d'un serveur. */
export type MapOrigin = "bundled" | "library" | "server";

export interface MapEntry {
  readonly key: MapKey;
  readonly map: MapFile;
  readonly origin: MapOrigin;
  /** Le fichier d'où elle vient (livrée, importée). */
  readonly file?: string;
}

/** Le résultat d'un import : la carte (et si elle est nouvelle), ou ce qui ne va pas. */
export type ImportResult = { ok: true; entry: MapEntry; fresh: boolean } | { ok: false; issues: readonly MapIssue[] };

/** Les cartes livrées avec le jeu : le texte de chaque fichier de `maps/`, chargé à la demande. */
const BUNDLED = import.meta.glob<string>("/maps/*.casse-map.json", { query: "?raw", import: "default" });

/** Le nom d'une carte, dans la langue affichée si son auteur l'y a écrit. */
export const mapName = (map: MapFile): string => authored(map.meta.name, map.meta.names);

export class MapLibrary {
  private readonly entries = new Map<MapKey, MapEntry>();
  private loading: Promise<void> | null = null;
  /** Le navigateur garde-t-il les cartes (IndexedDB) ? Faux en navigation privée, par exemple. */
  persistent = true;
  /** Les ressources des cartes venues d'un paquet (client/maps/assets.ts). */
  readonly assets: MapAssetStore = mapAssets;

  /** Charge les cartes (une fois ; on peut l'attendre plusieurs fois). */
  load(): Promise<void> {
    this.loading ??= this.loadAll();
    return this.loading;
  }

  private async loadAll(): Promise<void> {
    const bundled = Object.entries(BUNDLED).map(async ([path, read]) => {
      const file = path.split("/").pop() ?? path;
      try {
        const check = checkMapText(await read());
        if (check.map && check.key && !check.issues.length) this.entries.set(check.key, { key: check.key, map: check.map, origin: "bundled", file });
        else console.warn(`Carte livrée écartée : ${file}`, check.issues);
      } catch (e) {
        console.warn(`Carte livrée illisible : ${file}`, e);
      }
    });
    await Promise.all(bundled);
    this.persistent = (await mapDb()) !== null;
    for (const [store, origin] of [["library", "library"], ["cache", "server"]] as const) {
      for (const stored of await readMaps(store)) {
        const check = checkMap(stored.map);
        if (!check.map || !check.key || check.issues.length) {
          console.warn(`Carte gardée écartée (${store}) : ${stored.key}`, check.issues);
          continue;
        }
        // Une carte livrée avec le jeu reste « livrée » ; une carte importée passe avant celle d'un serveur
        if (this.entries.get(check.key)?.origin === "bundled" || (origin === "server" && this.entries.has(check.key))) continue;
        this.entries.set(check.key, { key: check.key, map: check.map, origin, file: stored.file });
      }
    }
  }

  /** Les cartes, par nom ; `origins` : seulement celles-là. */
  list(origins: readonly MapOrigin[] = ["bundled", "library"]): MapEntry[] {
    return [...this.entries.values()].filter((e) => origins.includes(e.origin)).sort((a, b) => compareText(mapName(a.map), mapName(b.map)));
  }

  get(key: MapKey): MapEntry | undefined {
    return this.entries.get(key);
  }

  /** Les identifiants des cartes que ce navigateur a : un serveur ne les renvoie pas. */
  knownKeys(): MapKey[] {
    return [...this.entries.keys()];
  }

  /** L'arène d'une carte connue, prête à jouer (connue de `Simulation.loadArena` par son identifiant). */
  arena(key: MapKey): ArenaLayout | undefined {
    const entry = this.entries.get(key);
    return entry ? registerMap(entry.map) : undefined;
  }

  /**
   * Garde une carte déjà vérifiée : faite ou importée ici (`library`), ou reçue d'un serveur
   * (`server`, dans le cache). Rend son entrée ; la même carte déjà là n'est pas dupliquée.
   */
  async save(map: MapFile, origin: "library" | "server" = "library", file?: string): Promise<MapEntry> {
    const key = mapKey(map);
    const known = this.entries.get(key);
    if (known && (known.origin !== "server" || origin === "server")) return known;
    const entry: MapEntry = { key, map, origin, file };
    this.entries.set(key, entry);
    const store: MapStore = origin === "library" ? "library" : "cache";
    await writeMap(store, { key, map, file, saved: Date.now() });
    return entry;
  }

  /**
   * Enregistre une nouvelle version d'une carte faite ici (l'éditeur de cartes) : la carte est
   * gardée, et la version précédente (`previous`, si c'est une carte de ce navigateur, et une autre)
   * est retirée. Une carte livrée avec le jeu ou reçue d'un serveur reste : la nouvelle en est une copie.
   */
  async replace(previous: MapKey | null, map: MapFile, file?: string): Promise<MapEntry> {
    const old = previous ? this.entries.get(previous) : undefined;
    const entry = await this.save(map, "library", file ?? old?.file);
    if (old && old.origin === "library" && old.key !== entry.key) await this.remove(old.key);
    return entry;
  }

  /** Retire une carte de ce navigateur (pas une carte livrée avec le jeu), et les ressources que plus rien n'utilise. */
  async remove(key: MapKey): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || entry.origin === "bundled") return;
    this.entries.delete(key);
    await deleteMap(entry.origin === "library" ? "library" : "cache", key);
    // Une arène qu'on ne joue pas en ce moment peut être oubliée
    if (arenaById(key)) unregisterArena(key);
    // (les brouillons de l'éditeur gardent les leurs)
    if (entry.map.assets) await this.assets.prune([...[...this.entries.values()].map((e) => e.map), ...(await readDraftMaps())]);
  }

  /** Importe une carte d'après le texte de son fichier : vérifiée, puis gardée. */
  async importText(text: string, file?: string): Promise<ImportResult> {
    const check = checkMapText(text);
    if (!check.map || !check.key || check.issues.length) return { ok: false, issues: check.issues.length ? check.issues : [{ code: "json" }] };
    const fresh = !this.entries.has(check.key) || this.entries.get(check.key)?.origin === "server";
    const entry = await this.save(check.map, "library", file);
    return { ok: true, entry, fresh };
  }

  /**
   * Importe un paquet (`.casse-map.zip`, map/pack.ts) : l'archive, ses ressources et sa carte vérifiées,
   * puis la carte gardée avec ses ressources.
   */
  async importPackage(bytes: Uint8Array, file?: string): Promise<ImportResult> {
    const read = await readMapArchive(bytes, inflate, inflateRaw);
    if (!read.ok) return read;
    const check = checkMap(read.map);
    if (!check.map || !check.key || check.issues.length) return { ok: false, issues: check.issues.length ? check.issues : [{ code: "json" }] };
    await this.assets.keep(read.assets);
    const fresh = !this.entries.has(check.key) || this.entries.get(check.key)?.origin === "server";
    const entry = await this.save(check.map, "library", file);
    return { ok: true, entry, fresh };
  }

  /** Importe un fichier choisi par le joueur : un paquet (une archive zip, d'après ses premiers octets) ou un fichier de carte. */
  async importFile(file: File): Promise<ImportResult> {
    const limit = Math.max(MAP_LIMITS.bytes, PACKAGE_LIMITS.archive);
    if (file.size > limit) return { ok: false, issues: [{ code: "tooLarge", size: Math.ceil(file.size / 1024), max: limit / 1024 }] };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isArchive(bytes)) return this.importPackage(bytes, file.name);
    if (bytes.length > MAP_LIMITS.bytes) return { ok: false, issues: [{ code: "tooLarge", size: Math.ceil(bytes.length / 1024), max: MAP_LIMITS.bytes / 1024 }] };
    return this.importText(new TextDecoder().decode(bytes), file.name);
  }
}
