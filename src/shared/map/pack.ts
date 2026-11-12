import type { MapAsset, MapAssets } from "../arena/layout";
import { PROP_TYPES, type PropType } from "../catalog/props";
import { inspectGlb } from "../media/glb";
import { inspectOpus } from "../media/ogg";
import { sha256 } from "../media/sha256";
import { utf8Bytes, utf8Text } from "../media/utf8";
import { openZip, writeZip, type DeflateRaw, type InflateRaw, type ZipArchive, type ZipEntry } from "../media/zip";
import { terrainCodes, toBase64 } from "./codec";
import { MAP_LIMITS, PACKAGE_LIMITS, type MapFile, type MapIssue, type MapTerrain } from "./format";
import { decodePng, type HeightImage, type Inflate } from "./heightmap";
import { encodePng, type Deflate } from "./png";
import { readMap, type ReadResult } from "./read";
import { mapText } from "./text";

/*
 * Paquet de carte : un dossier (la forme de travail de l'auteur), ou ce dossier en une archive zip
 * (`.casse-map.zip`, le fichier qu'on échange : un navigateur importe mal un dossier). Dedans :
 * - `map.json` : la carte, dont le relief nomme son image (`terrain.image`) au lieu de porter ses
 *   hauteurs ;
 * - `terrain.png` : le relief en PNG gris 16 bits, chaque pixel le code de sa hauteur (0 : `min`,
 *   65 535 : `max`), le haut au nord et la gauche à l'ouest, comme une image de relief qu'on importe ;
 * - `LICENSE.txt` : la licence (l'outil l'écrit) ;
 * - `models/props/<type>.glb` (facultatifs) : des modèles glTF qui remplacent, sur cette carte
 *   seulement, celui d'un type d'accessoire existant (les conventions de public/models/props/,
 *   docs/models.md ; les mêmes contrôles que `npm run models`) ;
 * - `sounds/ambience.ogg` (facultatif) : l'ambiance sonore, une boucle Ogg Opus, à la place de celle
 *   d'une arène du jeu (`ambience`).
 * Lire un paquet (`readPackage`) donne la carte, avec l'empreinte de ses ressources (`MapFile.assets` :
 * l'identifiant de la carte les couvre), et leurs octets d'après leur empreinte ; le jeu, le serveur
 * et l'outil des cartes (`npm run map:pack`, `map:unpack`) s'en servent. Un paquet sans ressources et
 * un fichier .casse-map.json se convertissent l'un en l'autre sans rien perdre.
 *
 * Un paquet vient de n'importe qui : tout est borné avant d'être lu (`PACKAGE_LIMITS` : l'archive, le
 * nombre de fichiers, la taille de chacun), un fichier dont on ne veut pas n'est pas lu, chaque
 * ressource est vérifiée (un modèle par `inspectGlb`, l'ambiance par `inspectOpus`) ; ce qui ne va pas
 * est un `MapIssue`, et rien ne lève d'exception.
 */

/** Les fichiers d'un paquet (`models` : le dossier de ses modèles). */
export const PACKAGE_FILES = {
  map: "map.json",
  terrain: "terrain.png",
  license: "LICENSE.txt",
  models: "models/props/",
  ambience: "sounds/ambience.ogg",
} as const;

/** L'extension d'un paquet en un fichier (une archive zip). */
export const PACKAGE_EXTENSION = ".casse-map.zip";

/** Le relief d'un paquet : ses dimensions, et le nom de son image dans le paquet. */
export type PackedTerrain = Omit<MapTerrain, "heights"> & { readonly image: string };
/**
 * La carte d'un paquet (`map.json`) : sans les empreintes de ses ressources, que la lecture refait
 * d'après les fichiers du paquet (un modèle changé dans le dossier ne demande pas de toucher à la carte).
 */
export type PackedMap = Omit<MapFile, "terrain" | "assets"> & { readonly terrain?: PackedTerrain };

/** Un paquet : sa carte, l'image de son relief (null sans relief), ses modèles (par type) et son ambiance. */
export interface MapPackage {
  readonly map: PackedMap;
  readonly terrain: Uint8Array | null;
  readonly models: Readonly<Partial<Record<PropType, Uint8Array>>>;
  readonly ambience: Uint8Array | null;
}

/** Les octets des ressources de cartes, d'après leur empreinte SHA-256. */
export type AssetShelf = ReadonlyMap<string, Uint8Array>;

/** Le chemin du modèle d'un type d'accessoire dans un paquet. */
export const modelPath = (type: PropType): string => `${PACKAGE_FILES.models}${type}.glb`;

/** Une ressource d'une carte : son chemin dans un paquet, son empreinte et sa taille, et ce qu'elle est. */
export interface AssetEntry {
  readonly path: string;
  readonly asset: MapAsset;
  /** Le type d'accessoire d'un modèle ; null : l'ambiance. */
  readonly type: PropType | null;
}

/** Les ressources d'une carte (les modèles par type, puis l'ambiance). */
export function assetEntries(assets: MapAssets | undefined): AssetEntry[] {
  const out: AssetEntry[] = [];
  for (const [type, asset] of Object.entries(assets?.models ?? {}) as [PropType, MapAsset][]) out.push({ path: modelPath(type), asset, type });
  if (assets?.ambience) out.push({ path: PACKAGE_FILES.ambience, asset: assets.ambience, type: null });
  return out;
}

/** Le nom d'une image du paquet : un simple nom de fichier PNG, dans le dossier du paquet. */
const IMAGE_NAME = /^[\w.-]+\.png$/i;

/** L'image de relief que nomme la carte d'un paquet (un nom de fichier sûr), ou null. */
export function packageImage(json: unknown): string | null {
  const terrain = json && typeof json === "object" ? (json as { terrain?: unknown }).terrain : undefined;
  const image = terrain && typeof terrain === "object" ? (terrain as { image?: unknown }).image : undefined;
  return typeof image === "string" && IMAGE_NAME.test(image) && image !== ".png" ? image : null;
}

/** Sommet (ix, iz) du relief → pixel (ligne, colonne) de l'image : le nord en haut, l'ouest à gauche (voir `imageFromHeights`). */
const pixelOf = (cells: number, ix: number, iz: number): number => (cells - iz) * (cells + 1) + (cells - ix);

/**
 * Une carte (déjà lue) en paquet : son relief en image, au code près, et ses ressources, prises dans
 * `shelf` d'après leur empreinte (une ressource absente, ou qui n'a pas son empreinte, lève : c'est à
 * l'appelant de les fournir).
 */
export async function packMap(map: MapFile, deflate: Deflate, shelf: AssetShelf = new Map()): Promise<MapPackage> {
  const { terrain, assets, ...rest } = map;
  const models: Partial<Record<PropType, Uint8Array>> = {};
  let ambience: Uint8Array | null = null;
  for (const entry of assetEntries(assets)) {
    const bytes = shelf.get(entry.asset.sha256);
    if (!bytes || bytes.length !== entry.asset.bytes || sha256(bytes) !== entry.asset.sha256) throw new Error(`Ressource absente ou différente : ${entry.path}`);
    if (entry.type) models[entry.type] = bytes;
    else ambience = bytes;
  }
  if (!terrain) return { map: rest, terrain: null, models, ambience };
  const codes = terrainCodes(terrain);
  if (!codes) throw new Error("Relief illisible : rien à mettre en paquet");
  const n = terrain.cells + 1;
  const data = new Float32Array(n * n);
  for (let ix = 0; ix < n; ix++) for (let iz = 0; iz < n; iz++) data[pixelOf(terrain.cells, ix, iz)] = codes[ix * n + iz] / 65535;
  const png = await encodePng({ width: n, height: n, data, bits: 16 }, deflate, 16);
  const packed: PackedTerrain = { cells: terrain.cells, step: terrain.step, min: terrain.min, max: terrain.max, image: PACKAGE_FILES.terrain };
  return { map: { ...rest, terrain: packed }, terrain: png, models, ambience };
}

/**
 * Les fichiers d'un paquet, dans l'ordre où on les écrit (un dossier, une archive) : la carte, son
 * relief, sa licence (`license` : son texte, s'il y en a un), ses modèles (par type), son ambiance.
 * Un PNG et un Ogg sont déjà compressés : l'archive les range tels quels.
 */
export function packageEntries(pkg: MapPackage, license: string | null): ZipEntry[] {
  const entries: ZipEntry[] = [{ name: PACKAGE_FILES.map, data: utf8Bytes(mapText(pkg.map)), deflate: true }];
  if (pkg.terrain) entries.push({ name: PACKAGE_FILES.terrain, data: pkg.terrain });
  if (license !== null) entries.push({ name: PACKAGE_FILES.license, data: utf8Bytes(license), deflate: true });
  for (const type of (Object.keys(pkg.models) as PropType[]).sort()) entries.push({ name: modelPath(type), data: pkg.models[type]!, deflate: true });
  if (pkg.ambience) entries.push({ name: PACKAGE_FILES.ambience, data: pkg.ambience });
  return entries;
}

/** Une licence écrite comme un identifiant SPDX (« CC-BY-4.0 », « AGPL-3.0-or-later »). */
const SPDX = /^[A-Za-z0-9.+-]+$/;

/**
 * Le texte de LICENSE.txt d'un paquet, d'après ce qu'en dit sa carte ; `resources` : les chemins de ses
 * ressources (ses modèles, son ambiance). En anglais, comme la documentation : il s'adresse à qui
 * reprend le paquet, dans n'importe quelle langue (le contenu d'un fichier, pas un texte du jeu).
 * L'outil des cartes et l'export du navigateur l'écrivent ; la carte (map.json) reste la référence.
 */
export function licenseText(meta: MapFile["meta"], resources: readonly string[] = []): string {
  const covered = resources.length
    ? `This license covers the map (map.json), its terrain (terrain.png) and its resources (${resources.join(", ")}).`
    : "This license covers the map (map.json) and its terrain (terrain.png).";
  return [
    `"${meta.name}" by ${meta.author}`,
    `License: ${meta.license}`,
    ...(SPDX.test(meta.license) ? [`https://spdx.org/licenses/${meta.license}.html`] : []),
    "",
    covered,
    "",
  ].join("\n");
}

/** Ce qu'il faut pour écrire une archive : la compression zlib (le PNG du relief), la brute (l'archive), et le texte de la licence. */
export interface ArchiveWriting {
  readonly deflate: Deflate;
  readonly deflateRaw: DeflateRaw;
  readonly license: string | null;
}

/** Une carte (déjà lue) et ses ressources en un paquet d'un seul fichier (`.casse-map.zip`). */
export async function writeMapArchive(map: MapFile, shelf: AssetShelf, how: ArchiveWriting): Promise<Uint8Array> {
  return writeZip(packageEntries(await packMap(map, how.deflate, shelf), how.license), how.deflateRaw);
}

/**
 * La carte d'un paquet : sa carte (`map.json`, déjà décodée) et l'image de son relief, relues et
 * vérifiées comme un fichier de carte (`readMap`). Une image illisible, qui n'a pas la taille du
 * relief ou pas 16 bits : `terrainData`. Un relief qui garde ses hauteurs (`heights`) se lit tel quel.
 */
export async function unpackMap(json: unknown, image: Uint8Array | null, inflate: Inflate): Promise<ReadResult> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, issues: [{ code: "json" }] };
  const raw = json as Record<string, unknown>;
  const terrain = raw.terrain;
  if (!terrain || typeof terrain !== "object" || Array.isArray(terrain) || "heights" in terrain) return readMap(raw);
  const { image: _name, ...dims } = terrain as Record<string, unknown>;
  // (une taille hors des bornes : la lecture le dit, sans décoder l'image)
  const cells = dims.cells;
  if (typeof cells !== "number" || !Number.isInteger(cells) || cells < MAP_LIMITS.minCells || cells > MAP_LIMITS.maxCells) {
    return readMap({ ...raw, terrain: { ...dims, heights: "" } });
  }
  if (!image) return { ok: false, issues: [{ code: "terrainData" }] };
  // L'en-tête de l'image d'abord (sa taille, 16 bits en gris) : une autre image ne se décompresse pas
  const n0 = cells + 1;
  const header = image.length >= 33 ? new DataView(image.buffer, image.byteOffset, 33) : null;
  if (!header || header.getUint32(12) !== 0x49484452 || header.getUint32(16) !== n0 || header.getUint32(20) !== n0 || image[24] !== 16 || image[25] !== 0) {
    return { ok: false, issues: [{ code: "terrainData" }] };
  }
  let img: HeightImage;
  try {
    img = await decodePng(image, inflate);
  } catch {
    return { ok: false, issues: [{ code: "terrainData" }] };
  }
  const n = cells + 1;
  if (img.width !== n || img.height !== n || img.bits !== 16) return { ok: false, issues: [{ code: "terrainData" }] };
  const bytes = new Uint8Array(n * n * 2);
  const view = new DataView(bytes.buffer);
  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) view.setUint16((ix * n + iz) * 2, Math.round(img.data[pixelOf(cells, ix, iz)] * 65535), true);
  }
  return readMap({ ...raw, terrain: { ...dims, heights: toBase64(bytes) } });
}

// --- Lire un paquet (un dossier, une archive) ---

/**
 * Les fichiers d'un paquet, d'où qu'ils viennent : leurs chemins dans le paquet (« models/props/crate.glb »),
 * la taille de chacun (avant de le lire), et sa lecture (null : il ne se lit pas).
 */
export interface PackageSource {
  readonly names: readonly string[];
  size(name: string): number;
  read(name: string): Promise<Uint8Array | null>;
}

/** Ce qu'on lit d'un paquet : la carte (avec l'empreinte de ses ressources), ses ressources d'après leur empreinte, sa licence ; ou ses problèmes. */
export type PackageRead =
  | { ok: true; map: MapFile; assets: Map<string, Uint8Array>; license: Uint8Array | null }
  | { ok: false; issues: MapIssue[] };

/** Ce qui peut mal tourner en lisant : au plus autant de problèmes (comme la lecture d'une carte). */
const MAX_ISSUES = 24;
/** Un modèle d'accessoire du paquet : « models/props/<type>.glb ». */
const MODEL = /^models\/props\/([A-Za-z0-9]+)\.glb$/;
/** Des notes qu'on peut laisser dans un paquet (crédits, sources) : jamais lues. */
const NOTES = /\.(md|txt)$/i;

const kb = (bytes: number): number => Math.ceil(bytes / 1024);

/**
 * La taille permise d'un fichier d'un paquet d'après son chemin, ou null : on ne le lit pas (une note,
 * un fichier de travail de l'auteur). Les chemins réservés aux ressources (`models/`, `sounds/`) ont
 * une taille permise même pour un nom inattendu : la lecture le signale.
 */
export function packageFileLimit(name: string): number | null {
  if (name === PACKAGE_FILES.map) return PACKAGE_LIMITS.map;
  if (name === PACKAGE_FILES.license) return PACKAGE_LIMITS.license;
  if (IMAGE_NAME.test(name)) return PACKAGE_LIMITS.terrain;
  if (name.startsWith("models/")) return PACKAGE_LIMITS.model;
  if (name.startsWith("sounds/")) return PACKAGE_LIMITS.ambience;
  return null;
}

/** Ce qui ne va pas dans un modèle d'un paquet (ou null : le jeu le lit). */
export function modelIssue(path: string, bytes: Uint8Array): MapIssue | null {
  if (bytes.length > PACKAGE_LIMITS.model) return { code: "assetSize", path, size: kb(bytes.length), max: kb(PACKAGE_LIMITS.model) };
  const problem = inspectGlb(bytes).problems[0];
  return problem ? { code: "assetModel", path, problem } : null;
}

/** Ce qui ne va pas dans l'ambiance d'un paquet (ou null). */
export function ambienceIssue(path: string, bytes: Uint8Array): MapIssue | null {
  if (bytes.length > PACKAGE_LIMITS.ambience) return { code: "assetSize", path, size: kb(bytes.length), max: kb(PACKAGE_LIMITS.ambience) };
  const opus = inspectOpus(bytes, { min: PACKAGE_LIMITS.ambienceMin, max: PACKAGE_LIMITS.ambienceMax });
  return opus.ok ? null : { code: "assetSound", path, problem: opus.problem };
}

/**
 * Une ressource reçue pour une carte (du serveur, de la bibliothèque) est-elle bien celle que dit la
 * carte, et se lit-elle ? Sa taille et son empreinte, puis les contrôles de sa sorte.
 */
export function assetMatches(entry: AssetEntry, bytes: Uint8Array): boolean {
  if (bytes.length !== entry.asset.bytes || sha256(bytes) !== entry.asset.sha256) return false;
  return (entry.type ? modelIssue(entry.path, bytes) : ambienceIssue(entry.path, bytes)) === null;
}

/**
 * Lit un paquet : sa carte, l'image de son relief, ses ressources (chacune vérifiée), et sa licence.
 * La carte rendue porte l'empreinte de ses ressources (`MapFile.assets`), quoi qu'en dise son map.json.
 */
export async function readPackage(source: PackageSource, inflate: Inflate): Promise<PackageRead> {
  const issues: MapIssue[] = [];
  const fail = (issue: MapIssue): void => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };
  try {
    if (source.names.length > PACKAGE_LIMITS.entries) return { ok: false, issues: [{ code: "tooMany", what: "files", count: source.names.length, max: PACKAGE_LIMITS.entries }] };
    // Un fichier qu'on veut lire : sa taille d'abord (null : trop gros ou illisible, et c'est signalé)
    const take = async (name: string): Promise<Uint8Array | null> => {
      const limit = packageFileLimit(name) ?? 0;
      const size = source.size(name);
      if (!Number.isFinite(size) || size < 0) {
        fail({ code: "archive" });
        return null;
      }
      if (size > limit) {
        fail(name === PACKAGE_FILES.map ? { code: "tooLarge", size: kb(size), max: kb(limit) } : { code: "assetSize", path: name, size: kb(size), max: kb(limit) });
        return null;
      }
      const bytes = await source.read(name);
      if (!bytes || bytes.length > limit) {
        fail({ code: "archive" });
        return null;
      }
      return bytes;
    };
    if (!source.names.includes(PACKAGE_FILES.map)) return { ok: false, issues: [{ code: "packageMap" }] };
    const mapBytes = await take(PACKAGE_FILES.map);
    if (!mapBytes) return { ok: false, issues };
    let json: unknown;
    try {
      json = JSON.parse(utf8Text(mapBytes) ?? "");
    } catch {
      return { ok: false, issues: [{ code: "json" }] };
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, issues: [{ code: "json" }] };
    const imageName = packageImage(json);
    const image = imageName && source.names.includes(imageName) ? await take(imageName) : null;
    const license = source.names.includes(PACKAGE_FILES.license) ? await take(PACKAGE_FILES.license) : null;

    // Les ressources : les modèles (un par type d'accessoire connu), l'ambiance ; rien d'autre sous models/ ni sounds/
    const assets = new Map<string, Uint8Array>();
    const models: Partial<Record<PropType, MapAsset>> = {};
    let ambience: MapAsset | undefined;
    let modelBytes = 0;
    for (const name of [...source.names].sort()) {
      if (!name.startsWith("models/") && !name.startsWith("sounds/")) continue;
      if (NOTES.test(name)) continue;
      const model = MODEL.exec(name);
      const type = model && Object.hasOwn(PROP_TYPES, model[1]) ? (model[1] as PropType) : null;
      if (!type && name !== PACKAGE_FILES.ambience) {
        fail({ code: "assetName", path: name.slice(0, 96) });
        continue;
      }
      const bytes = await take(name);
      if (!bytes) continue;
      const issue = type ? modelIssue(name, bytes) : ambienceIssue(name, bytes);
      if (issue) {
        fail(issue);
        continue;
      }
      const asset: MapAsset = { sha256: sha256(bytes), bytes: bytes.length };
      assets.set(asset.sha256, bytes);
      if (type) {
        models[type] = asset;
        modelBytes += bytes.length;
      } else {
        ambience = asset;
      }
    }
    if (modelBytes > PACKAGE_LIMITS.models) fail({ code: "assetSize", path: PACKAGE_FILES.models, size: kb(modelBytes), max: kb(PACKAGE_LIMITS.models) });

    const manifest: MapAssets | undefined = Object.keys(models).length || ambience
      ? { ...(Object.keys(models).length ? { models } : {}), ...(ambience ? { ambience } : {}) }
      : undefined;
    const { assets: _stale, ...raw } = json as Record<string, unknown>;
    const read = await unpackMap(manifest ? { ...raw, assets: manifest } : raw, image, inflate);
    if (!read.ok) for (const issue of read.issues) fail(issue);
    if (issues.length || !read.ok) return { ok: false, issues };
    return { ok: true, map: read.map, assets, license };
  } catch {
    // Rien ne devrait lever ici ; un paquet qui y parviendrait est refusé, sans faire tomber le serveur
    return { ok: false, issues: issues.length ? issues : [{ code: "archive" }] };
  }
}

/**
 * Les fichiers d'une archive ouverte, comme ceux d'un paquet. Une archive faite en compressant le
 * dossier du paquet (le menu « Envoyer vers » de Windows, `zip -r`) range tout dans ce dossier : s'il
 * n'y a pas de map.json à la racine et que tout est dans un même dossier, c'est lui la racine.
 */
export function zipSource(archive: ZipArchive, inflateRaw: InflateRaw): PackageSource {
  const all = archive.names;
  let prefix = "";
  if (!all.includes(PACKAGE_FILES.map)) {
    const first = all[0]?.split("/")[0];
    if (first && all.every((n) => n.startsWith(`${first}/`)) && all.includes(`${first}/${PACKAGE_FILES.map}`)) prefix = `${first}/`;
  }
  const names = prefix ? all.map((n) => n.slice(prefix.length)) : all;
  return {
    names,
    size: (name) => archive.size(prefix + name),
    read: (name) => archive.read(prefix + name, inflateRaw),
  };
}

/** Lit un paquet en un fichier (`.casse-map.zip`) : l'archive, puis le paquet (`readPackage`). */
export async function readMapArchive(bytes: Uint8Array, inflate: Inflate, inflateRaw: InflateRaw): Promise<PackageRead> {
  const zip = openZip(bytes, { bytes: PACKAGE_LIMITS.archive, entries: PACKAGE_LIMITS.entries });
  if (!zip.ok) {
    const p = zip.problem;
    const issue: MapIssue = p.code === "tooLarge" ? { code: "tooLarge", size: kb(p.size), max: kb(p.max) }
      : p.code === "entries" ? { code: "tooMany", what: "files", count: p.count, max: p.max }
      : p.code === "path" ? { code: "packagePath", path: p.name }
      : { code: "archive" };
    return { ok: false, issues: [issue] };
  }
  return readPackage(zipSource(zip.archive, inflateRaw), inflate);
}

/** Ces octets sont-ils une archive zip (le début d'un paquet en un fichier) plutôt qu'un fichier de carte ? */
export function isArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Ce qu'il faut d'un système de fichiers pour lire un paquet en dossier (Node : node:fs ; les chemins
 * relatifs au dossier du paquet, séparés par « / »).
 */
export interface FolderAccess {
  /** Les entrées d'un dossier du paquet (« » : sa racine) : leurs noms, et si ce sont des dossiers ; [] s'il n'existe pas. */
  list(dir: string): readonly { readonly name: string; readonly dir: boolean }[];
  /** La taille d'un fichier (octets). */
  size(path: string): number;
  /** Ses octets ; lève s'il ne se lit pas. */
  read(path: string): Uint8Array;
}

/**
 * Les fichiers d'un paquet en dossier : ceux de sa racine, de `models/`, `models/props/` et `sounds/`
 * (les autres dossiers, des fichiers de travail de l'auteur, ne sont pas parcourus), au plus
 * `PACKAGE_LIMITS.entries` (+ 1 : la lecture dit qu'il y en a trop).
 */
export function folderSource(access: FolderAccess): PackageSource {
  const names: string[] = [];
  const walk = (dir: string, inner: readonly string[]): void => {
    for (const entry of access.list(dir)) {
      if (names.length > PACKAGE_LIMITS.entries) return;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.dir) {
        if (inner.includes(entry.name)) walk(path, entry.name === "models" ? ["props"] : []);
      } else {
        names.push(path);
      }
    }
  };
  walk("", ["models", "sounds"]);
  return {
    names,
    size: (name) => {
      try {
        return access.size(name);
      } catch {
        return Infinity;
      }
    },
    read: async (name) => {
      try {
        return access.read(name);
      } catch {
        return null;
      }
    },
  };
}
