import type { MapAsset, MapAssets } from "../../shared/arena/layout";
import type { MapFile } from "../../shared/map/format";
import { assetEntries, assetMatches, type AssetEntry, type AssetShelf } from "../../shared/map/pack";
import { MAP_ASSET_PATH } from "../../shared/net/protocol";
import { assetKeys, deleteAssets, readAsset, writeAsset } from "./db";

/*
 * Les ressources des cartes venues d'un paquet (map/pack.ts : des modèles d'accessoires, une
 * ambiance) dans ce navigateur, d'après leur empreinte SHA-256 : gardées dans IndexedDB (le magasin
 * `assets`, db.ts : une fois pour toutes les cartes qui s'en servent), en mémoire le temps qu'on s'en
 * sert, et, pour une carte qu'un serveur a envoyée, téléchargées chez lui (`MAP_ASSET_PATH`) dès qu'il
 * l'envoie. Une ressource n'est rendue que vérifiée contre la carte (sa taille, son empreinte, les
 * contrôles de sa sorte : `assetMatches`), d'où qu'elle vienne. Une ressource absente ou fautive rend
 * null : le rendu garde le modèle du jeu, le son l'ambiance d'une arène du jeu.
 */

/** Au plus autant d'octets gardés en mémoire (les ressources des dernières cartes jouées). */
const MEMORY = 48 * 1024 * 1024;

export class MapAssetStore {
  /** Les octets déjà lus, du plus ancien au plus récent (une `Map` garde l'ordre d'insertion). */
  private readonly memory = new Map<string, Uint8Array>();
  private held = 0;
  /** Les lectures en cours (IndexedDB, réseau), d'après l'empreinte. */
  private readonly pending = new Map<string, Promise<Uint8Array | null>>();
  /** Où télécharger une ressource qu'on n'a pas : l'origine HTTP du serveur qui a envoyé sa carte. */
  private readonly origins = new Map<string, string>();
  /** Le navigateur garde-t-il les ressources ? (Faux sans IndexedDB : elles ne vivent que le temps de la page.) */
  persistent = true;

  /** Garde des ressources déjà vérifiées (un paquet importé) : en mémoire et dans IndexedDB. */
  async keep(assets: AssetShelf): Promise<void> {
    for (const [hash, bytes] of assets) {
      this.remember(hash, bytes);
      if (!(await writeAsset(hash, bytes))) this.persistent = false;
    }
  }

  /** Les octets d'une ressource d'une carte, vérifiés ; null : absente ou fautive. */
  bytes(entry: AssetEntry): Promise<Uint8Array | null> {
    const hash = entry.asset.sha256;
    const known = this.memory.get(hash);
    if (known) {
      // (la plus récente : la dernière qu'on écarterait)
      this.memory.delete(hash);
      this.memory.set(hash, known);
      return Promise.resolve(known);
    }
    let reading = this.pending.get(hash);
    if (!reading) {
      reading = this.load(entry).finally(() => this.pending.delete(hash));
      this.pending.set(hash, reading);
    }
    return reading;
  }

  /** Les octets des ressources d'une carte (pour en faire un paquet), ou null s'il en manque une. */
  async shelfOf(map: MapFile): Promise<AssetShelf | null> {
    const shelf = new Map<string, Uint8Array>();
    for (const entry of assetEntries(map.assets)) {
      const bytes = await this.bytes(entry);
      if (!bytes) return null;
      shelf.set(entry.asset.sha256, bytes);
    }
    return shelf;
  }

  /**
   * Une carte reçue d'un serveur (`origin` : son origine HTTP, « http://hôte:8787 ») : ses ressources
   * se téléchargent chez lui tout de suite (la partie commence avec les modèles du jeu, qui laissent
   * la place aux siens quand ils arrivent), et se gardent avec la carte.
   */
  fetchFrom(origin: string, map: { readonly assets?: MapAssets }): void {
    for (const entry of assetEntries(map.assets)) {
      if (!this.origins.has(entry.asset.sha256)) this.origins.set(entry.asset.sha256, origin);
      void this.bytes(entry);
    }
  }

  /** Oublie (dans IndexedDB) les ressources qu'aucune de ces cartes n'utilise. */
  async prune(maps: readonly MapFile[]): Promise<void> {
    const used = new Set(maps.flatMap((m) => assetEntries(m.assets).map((e) => e.asset.sha256)));
    const stale = (await assetKeys()).filter((k) => !used.has(k));
    await deleteAssets(stale);
    for (const hash of stale) this.forget(hash);
  }

  private async load(entry: AssetEntry): Promise<Uint8Array | null> {
    const hash = entry.asset.sha256;
    const stored = await readAsset(hash);
    if (stored && assetMatches(entry, stored)) {
      this.remember(hash, stored);
      return stored;
    }
    const origin = this.origins.get(hash);
    if (!origin) return null;
    try {
      const bytes = await download(`${origin}${MAP_ASSET_PATH}${hash}`, entry.asset);
      if (!assetMatches(entry, bytes)) {
        console.warn(`Ressource de carte refusée (${entry.path}, ${hash}) : elle n'est pas celle que dit la carte`);
        return null;
      }
      this.remember(hash, bytes);
      if (!(await writeAsset(hash, bytes))) this.persistent = false;
      return bytes;
    } catch (e) {
      console.warn(`Ressource de carte introuvable (${entry.path}, ${origin})`, e);
      return null;
    }
  }

  private remember(hash: string, bytes: Uint8Array): void {
    if (this.memory.has(hash)) return;
    this.memory.set(hash, bytes);
    this.held += bytes.length;
    // Les plus anciennes s'en vont (une carte qu'on rejoue les relit dans IndexedDB)
    for (const [old, data] of this.memory) {
      if (this.held <= MEMORY || old === hash) break;
      this.memory.delete(old);
      this.held -= data.length;
    }
  }

  private forget(hash: string): void {
    const bytes = this.memory.get(hash);
    if (!bytes) return;
    this.memory.delete(hash);
    this.held -= bytes.length;
  }
}

/**
 * Télécharge une ressource, sans en lire plus que sa taille annoncée par la carte (un serveur hostile
 * ne remplit pas la mémoire) ; le contrôle de son contenu vient après.
 */
async function download(url: string, asset: MapAsset): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const out = new Uint8Array(asset.bytes);
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > out.length) {
      await reader.cancel();
      throw new Error(`Plus de ${asset.bytes} octets`);
    }
    out.set(value, at);
    at += value.length;
  }
  if (at !== out.length) throw new Error(`${at} octets au lieu de ${asset.bytes}`);
  return out;
}

/** L'origine HTTP d'un serveur de jeu d'après l'adresse de sa WebSocket (« ws://hôte:8787 » → « http://hôte:8787 »). */
export function httpOrigin(socketUrl: string): string | null {
  try {
    const url = new URL(socketUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
  } catch {
    return null;
  }
}

/** Les ressources des cartes de cette page (le jeu, l'éditeur, la bibliothèque). */
export const mapAssets = new MapAssetStore();
