import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { deflateRawSync, deflateSync, inflateRawSync, inflateSync } from "node:zlib";
import { mapIssueText } from "../../src/client/i18n/names";
import { isLocale, setLocale } from "../../src/client/i18n/state";
import { ARENA_IDS, isArenaId, type ArenaId } from "../../src/shared/arena/layout";
import { propDef } from "../../src/shared/catalog/props";
import {
  assetEntries, blankMap, checkMap, decodePng, decodeRaw16, folderSource, isArchive, isHeightmapError, MAP_EXTENSION, MAP_LIMITS, mapText,
  PACKAGE_EXTENSION, PACKAGE_LIMITS, packageEntries, packMap, readMapArchive, readMapText, readPackage, terrainFromImage, writeMapArchive,
  type FolderAccess, type MapCheck, type MapFile, type MapIssue, type PackageRead, type TerrainImport,
} from "../../src/shared/map";
import { ARENA_CONTENT, arenaText } from "./arenas";
import { licenseText } from "./packages";
import { exampleMap } from "./example";

/*
 * Outil des auteurs de cartes, en ligne de commande (`npm run map:check`, `npm run map:terrain`) :
 * - check [cartes…] : vérifie des cartes comme le jeu et le serveur (sans argument : celles du
 *   dossier maps/) ; une carte est un fichier .casse-map.json, un paquet en dossier ou en archive
 *   (.casse-map.zip) ; code de sortie 1 si l'une ne se joue pas (la CI peut le lancer) ;
 * - terrain <image.png|relief.r16> --cells N --step S --low L --high H [--mountains DEPUIS,HAUTEUR]
 *   [--smooth R] [--big-endian] [--into carte.casse-map.json] [--name NOM] [--author AUTEUR] [--half H] :
 *   importe un relief (PNG 8 ou 16 bits, RAW 16 bits) dans une carte (la remplace dans `--into`
 *   si elle existe, sinon en crée une, prête à compléter) ;
 * - example : refait la carte d'exemple (maps/val-du-lac.casse-map.json) et son relief source ;
 * - export <arène…|all> [--into dossier] : écrit les arènes du jeu en cartes (content/arenas/ par
 *   défaut, pas maps/ : le jeu les chargerait en double), et les vérifie ;
 * - pack <cartes…> [--into dossier] [--zip] : met des cartes en paquets (shared/map/pack.ts) ; un
 *   fichier .casse-map.json devient un dossier (map.json, terrain.png en 16 bits, LICENSE.txt), ou une
 *   archive avec `--zip` ; un paquet en dossier (avec ses modèles et son ambiance) devient une archive
 *   .casse-map.zip, le fichier qu'on échange ;
 * - unpack <paquets…> [--into dossier] : une archive .casse-map.zip redevient un dossier (la forme de
 *   travail) ; un dossier redevient une carte .casse-map.json (sans ses ressources : un fichier de
 *   carte ne les porte pas), vérifiée.
 * `--lang en` : les messages en anglais (le français par défaut).
 */

const args = process.argv.slice(2);
const command = args.shift() ?? "help";

/** Valeur d'une option (`--cells 160`), ou undefined. */
function option(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function flag(name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function numberOption(name: string, fallback?: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (value === undefined || !Number.isFinite(value)) {
    console.error(`Option --${name} : un nombre est attendu`);
    process.exit(2);
  }
  return value;
}

const lang = option("lang") ?? "fr";
if (isLocale(lang)) setLocale(lang);

/** Résumé d'une carte vérifiée. */
function describe(check: MapCheck): string {
  const map = check.map!;
  const arena = check.arena!;
  const terrain = map.terrain ? `${map.terrain.cells * map.terrain.step} m au pas de ${map.terrain.step} m` : "plat";
  const dynamic = arena.props.filter((p) => !propDef(p.type).anchored).length;
  return [
    `« ${map.meta.name} » par ${map.meta.author} (${map.meta.license}), ${check.key}`,
    `  zone de jeu ±${map.bounds.half} m, relief ${terrain}, ${arena.zones.length} zones (${arena.zones.map((z) => z.label).join(", ")})`,
    `  ${arena.boxes.length} boîtes, ${arena.props.length} accessoires dont ${dynamic} mobiles (au plus ${MAP_LIMITS.boxes}, ${MAP_LIMITS.props}, ${MAP_LIMITS.dynamicProps})`,
  ].join("\n");
}

const deflate = (d: Uint8Array): Uint8Array => new Uint8Array(deflateSync(d, { level: 9 }));
const inflate = (d: Uint8Array, max?: number): Uint8Array => new Uint8Array(inflateSync(d, max ? { maxOutputLength: max } : {}));
const deflateRaw = (d: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(d, { level: 9 }));
/** Décompression brute bornée : au-delà de la taille annoncée par l'archive, elle s'arrête (une « bombe » ne remplit pas la mémoire). */
const inflateRaw = (d: Uint8Array, max: number): Uint8Array => new Uint8Array(inflateRawSync(d, { maxOutputLength: Math.max(1, max) }));

/** Un paquet en dossier, lu par node:fs (les chemins du paquet séparés par « / »). */
function folderAccess(dir: string): FolderAccess {
  return {
    list: (sub) => {
      try {
        return readdirSync(join(dir, sub), { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
      } catch {
        return [];
      }
    },
    size: (path) => statSync(join(dir, path)).size,
    read: (path) => new Uint8Array(readFileSync(join(dir, path))),
  };
}

/**
 * Une carte d'après son chemin : un fichier .casse-map.json, un paquet en dossier, ou en archive (un
 * fichier zip, d'après ses premiers octets). Sa carte, ses ressources (d'après leur empreinte) et la
 * licence du paquet ; ou ses problèmes.
 */
async function readSource(path: string): Promise<PackageRead> {
  const stat = statSync(path);
  if (stat.isDirectory()) return readPackage(folderSource(folderAccess(path)), inflate);
  const limit = Math.max(MAP_LIMITS.bytes, PACKAGE_LIMITS.archive);
  if (stat.size > limit) return { ok: false, issues: [{ code: "tooLarge", size: Math.ceil(stat.size / 1024), max: limit / 1024 }] };
  const bytes = new Uint8Array(readFileSync(path));
  if (isArchive(bytes)) return readMapArchive(bytes, inflate, inflateRaw);
  if (bytes.length > MAP_LIMITS.bytes) return { ok: false, issues: [{ code: "tooLarge", size: Math.ceil(bytes.length / 1024), max: MAP_LIMITS.bytes / 1024 }] };
  const read = readMapText(new TextDecoder().decode(bytes));
  return read.ok ? { ok: true, map: read.map, assets: new Map(), license: null } : read;
}

/** Résumé des ressources d'une carte (un paquet). */
function describeAssets(map: MapFile): string | null {
  const entries = assetEntries(map.assets);
  if (!entries.length) return null;
  return `  ressources : ${entries.map((e) => `${e.path} (${Math.round(e.asset.bytes / 1024)} Ko)`).join(", ")}`;
}

/** Vérifie des cartes (fichiers, paquets) ; vrai si toutes se jouent. */
async function check(files: readonly string[]): Promise<boolean> {
  let ok = true;
  for (const file of files) {
    let issues: readonly MapIssue[];
    let result: MapCheck | null = null;
    try {
      const read = await readSource(file);
      if (read.ok) {
        result = checkMap(read.map);
        issues = result.issues;
      } else {
        issues = read.issues;
      }
    } catch (e) {
      console.log(`✗ ${file} (illisible : ${String(e)})`);
      ok = false;
      continue;
    }
    if (issues.length || !result?.map) {
      ok = false;
      console.log(`✗ ${file}`);
      for (const issue of issues) console.log(`  - ${mapIssueText(issue)}`);
    } else {
      console.log(`✓ ${file}\n${describe(result)}`);
      const assets = describeAssets(result.map);
      if (assets) console.log(assets);
    }
  }
  return ok;
}

/** Les cartes du dossier maps/ du dépôt : ses fichiers .json, ses paquets (archives, dossiers qui ont un map.json). */
function bundledMaps(): string[] {
  const dir = resolve("maps");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() ? existsSync(join(dir, e.name, "map.json")) : /\.(json|zip)$/i.test(e.name)))
    .map((e) => join(dir, e.name))
    .sort();
}

/** Écrit une carte, lisible (deux espaces d'indentation). */
function writeMap(file: string, map: MapFile): void {
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

async function terrain(): Promise<void> {
  const into = option("into");
  const name = option("name");
  const author = option("author");
  const half = option("half");
  const mountains = option("mountains");
  const smooth = option("smooth");
  const bigEndian = flag("big-endian");
  const options: TerrainImport = {
    cells: numberOption("cells"),
    step: numberOption("step", 2),
    low: numberOption("low", 0),
    high: numberOption("high"),
    smooth: smooth === undefined ? undefined : Number(smooth),
    mountains: mountains ? { from: Number(mountains.split(",")[0]), height: Number(mountains.split(",")[1]) } : undefined,
  };
  const source = args[0];
  if (!source) {
    console.error("Image du relief attendue (PNG ou RAW 16 bits)");
    process.exit(2);
  }
  const bytes = new Uint8Array(readFileSync(source));
  let image;
  try {
    image = /\.(r16|raw)$/i.test(source) ? decodeRaw16(bytes, !bigEndian) : await decodePng(bytes, (d) => new Uint8Array(inflateSync(d)));
  } catch (e) {
    console.error(isHeightmapError(e) ? `Relief illisible (${e.code}) : ${e.message}` : e);
    process.exit(1);
  }
  console.log(`Relief : ${image.width} × ${image.height} pixels, ${image.bits} bits`);
  const relief = terrainFromImage(image, options);
  let map: MapFile;
  if (into && existsSync(into)) {
    const read = readMapText(readFileSync(into, "utf8"));
    if (!read.ok) {
      for (const issue of read.issues) console.log(`  - ${mapIssueText(issue)}`);
      console.error(`${into} : carte illisible, rien n'est changé`);
      process.exit(1);
    }
    map = { ...read.map, terrain: relief };
  } else {
    const side = options.cells * options.step;
    map = {
      ...blankMap({ name: name ?? basename(source).replace(/\.[^.]+$/, ""), author: author ?? "?", half: half ? Number(half) : Math.max(20, Math.round(side / 2 - 40)) }),
      terrain: relief,
    };
  }
  const out = into ?? source.replace(/\.[^.]+$/, MAP_EXTENSION);
  writeMap(out, map);
  console.log(`Carte écrite : ${out}`);
  await check([out]);
}

/** Exporte des arènes du jeu en fichiers de carte (`all` : toutes), dans content/arenas/ par défaut. */
async function exportArenas(): Promise<void> {
  const into = resolve(option("into") ?? ARENA_CONTENT);
  const ids = args.includes("all") ? ARENA_IDS : args;
  const unknown = ids.filter((id) => !isArenaId(id));
  if (!ids.length || unknown.length) {
    console.error(unknown.length ? `Arène inconnue : ${unknown.join(", ")} (${ARENA_IDS.join(", ")})` : `Arènes attendues : ${ARENA_IDS.join(", ")} ou all`);
    process.exit(2);
  }
  mkdirSync(into, { recursive: true });
  const files: string[] = [];
  for (const id of ids as ArenaId[]) {
    const text = arenaText(id);
    const file = join(into, `${id}${MAP_EXTENSION}`);
    writeFileSync(file, text);
    files.push(file);
    console.log(`${file} : ${Math.round(text.length / 1024)} Ko`);
  }
  if (!(await check(files))) process.exit(1);
}

/** Le nom d'une carte d'après son fichier ou son dossier (sans « .casse-map.json » ni « .casse-map.zip »). */
const mapNameOf = (file: string): string => basename(resolve(file)).replace(/\.casse-map\.(json|zip)$|\.(json|zip)$/i, "");

/** Lit une carte (fichier, paquet) ; illisible, l'outil dit pourquoi et s'arrête. */
async function readOrExit(path: string, what: string): Promise<Extract<PackageRead, { ok: true }>> {
  const read = await readSource(path);
  if (!read.ok) {
    for (const issue of read.issues) console.log(`  - ${mapIssueText(issue)}`);
    console.error(`${path} : carte illisible, ${what}`);
    process.exit(1);
  }
  return read;
}

/** Le texte de la licence d'un paquet : celui qu'il avait, sinon celui qu'en fait l'outil d'après la carte. */
const licenseOf = (read: Extract<PackageRead, { ok: true }>): string =>
  (read.license ? new TextDecoder().decode(read.license) : licenseText(read.map.meta, assetEntries(read.map.assets).map((e) => e.path)));

/** Écrit un paquet en dossier (ses ressources comprises). */
async function writeFolder(dir: string, read: Extract<PackageRead, { ok: true }>): Promise<void> {
  for (const entry of packageEntries(await packMap(read.map, deflate, read.assets), licenseOf(read))) {
    const file = join(dir, ...entry.name.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry.data);
  }
}

/**
 * Met des cartes en paquets : `carte.casse-map.json` devient le dossier `carte/` (à côté, ou dans
 * `--into`), ou l'archive `carte.casse-map.zip` avec `--zip` ; un paquet en dossier `carte/` (avec
 * ses modèles et son ambiance) devient l'archive `carte.casse-map.zip`, vérifiée.
 */
async function pack(): Promise<void> {
  const into = option("into");
  const zip = flag("zip");
  if (!args.length) {
    console.error("Cartes attendues (.casse-map.json, ou des paquets en dossier)");
    process.exit(2);
  }
  const archives: string[] = [];
  for (const source of args) {
    const read = await readOrExit(source, "pas de paquet");
    const at = resolve(into ?? dirname(resolve(source)));
    if (zip || statSync(source).isDirectory()) {
      const out = join(at, `${mapNameOf(source)}${PACKAGE_EXTENSION}`);
      mkdirSync(at, { recursive: true });
      writeFileSync(out, await writeMapArchive(read.map, read.assets, { deflate, deflateRaw, license: licenseOf(read) }));
      archives.push(out);
      console.log(`Paquet écrit : ${out} (${Math.round(statSync(out).size / 1024)} Ko)`);
    } else {
      const dir = join(at, mapNameOf(source));
      await writeFolder(dir, read);
      console.log(`Paquet écrit : ${dir}`);
    }
  }
  if (archives.length && !(await check(archives))) process.exit(1);
}

/**
 * Défait des paquets : l'archive `carte.casse-map.zip` redevient le dossier `carte/` (la forme de
 * travail, ses fichiers réécrits par l'outil : la carte, son relief, sa licence, ses ressources) ; le
 * dossier `carte/` redevient `carte.casse-map.json` (à côté du dossier, ou dans `--into`), vérifiée
 * comme le jeu la vérifie ; un fichier de carte ne porte pas de ressources : elles restent dans le dossier.
 */
async function unpack(): Promise<void> {
  const into = option("into");
  if (!args.length) {
    console.error("Paquets attendus (des dossiers avec map.json, des archives .casse-map.zip)");
    process.exit(2);
  }
  const files: string[] = [];
  for (const source of args) {
    const read = await readOrExit(source, "pas de carte");
    const at = resolve(into ?? dirname(resolve(source)));
    if (!statSync(source).isDirectory()) {
      const dir = join(at, mapNameOf(source));
      await writeFolder(dir, read);
      files.push(dir);
      console.log(`Paquet écrit : ${dir}`);
      continue;
    }
    const { assets: dropped, ...map } = read.map;
    const out = join(at, `${mapNameOf(source)}${MAP_EXTENSION}`);
    writeFileSync(out, mapText(map));
    files.push(out);
    console.log(`Carte écrite : ${out}`);
    if (dropped) console.log(`  (sans ses ressources : ${assetEntries(dropped).map((e) => e.path).join(", ")} ; un fichier .casse-map.json ne les porte pas)`);
  }
  if (!(await check(files))) process.exit(1);
}

async function example(): Promise<void> {
  const { map, png } = await exampleMap(deflate, inflate);
  writeFileSync(resolve("tools/maps/val-du-lac.png"), png);
  writeMap(resolve("maps/val-du-lac.casse-map.json"), map);
  console.log("Carte d'exemple écrite : maps/val-du-lac.casse-map.json (relief source : tools/maps/val-du-lac.png)");
  if (!(await check([resolve("maps/val-du-lac.casse-map.json")]))) process.exit(1);
}

switch (command) {
  case "check": {
    const files = args.length ? args : bundledMaps();
    if (!files.length) {
      console.log("Aucune carte à vérifier");
      break;
    }
    if (!(await check(files))) process.exit(1);
    break;
  }
  case "terrain":
    await terrain();
    break;
  case "example":
    await example();
    break;
  case "export":
    await exportArenas();
    break;
  case "pack":
    await pack();
    break;
  case "unpack":
    await unpack();
    break;
  default:
    console.log("Commandes : check [cartes…], terrain <image> --cells N --step S --high H [--low L] [--mountains DEPUIS,HAUTEUR] [--into carte], example, "
      + "export <arène…|all> [--into dossier], pack <cartes…|paquets…> [--into dossier] [--zip], unpack <paquets…> [--into dossier]");
    process.exit(command === "help" ? 0 : 2);
}
