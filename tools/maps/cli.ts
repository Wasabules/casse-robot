import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { deflateSync, inflateSync } from "node:zlib";
import { mapIssueText } from "../../src/client/i18n/names";
import { isLocale, setLocale } from "../../src/client/i18n/state";
import { ARENA_IDS, isArenaId, type ArenaId } from "../../src/shared/arena/layout";
import { propDef } from "../../src/shared/catalog/props";
import {
  blankMap, checkMapText, decodePng, decodeRaw16, isHeightmapError, MAP_EXTENSION, MAP_LIMITS, mapText, PACKAGE_FILES, packageImage, packMap,
  readMapText, terrainFromImage, unpackMap, type MapCheck, type MapFile, type TerrainImport,
} from "../../src/shared/map";
import { ARENA_CONTENT, arenaText } from "./arenas";
import { licenseText } from "./packages";
import { exampleMap } from "./example";

/*
 * Outil des auteurs de cartes, en ligne de commande (`npm run map:check`, `npm run map:terrain`) :
 * - check [fichiers…] : vérifie des cartes comme le jeu et le serveur (sans fichier : celles du
 *   dossier maps/) ; code de sortie 1 si l'une ne se joue pas (la CI peut le lancer) ;
 * - terrain <image.png|relief.r16> --cells N --step S --low L --high H [--mountains DEPUIS,HAUTEUR]
 *   [--smooth R] [--big-endian] [--into carte.casse-map.json] [--name NOM] [--author AUTEUR] [--half H] :
 *   importe un relief (PNG 8 ou 16 bits, RAW 16 bits) dans une carte (la remplace dans `--into`
 *   si elle existe, sinon en crée une, prête à compléter) ;
 * - example : refait la carte d'exemple (maps/val-du-lac.casse-map.json) et son relief source ;
 * - export <arène…|all> [--into dossier] : écrit les arènes du jeu en cartes (content/arenas/ par
 *   défaut, pas maps/ : le jeu les chargerait en double), et les vérifie ;
 * - pack <cartes…> [--into dossier] : met des cartes en paquets (un dossier : map.json, terrain.png
 *   en 16 bits, LICENSE.txt ; shared/map/pack.ts) ;
 * - unpack <paquets…> [--into dossier] : refait la carte (.casse-map.json) d'un paquet, et la vérifie.
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

/** Vérifie des fichiers de carte ; vrai si tous se jouent. */
function check(files: readonly string[]): boolean {
  let ok = true;
  for (const file of files) {
    const size = statSync(file).size;
    const result = size > MAP_LIMITS.bytes
      ? { map: null, arena: null, key: null, issues: [{ code: "tooLarge", size: Math.ceil(size / 1024), max: MAP_LIMITS.bytes / 1024 }] } as MapCheck
      : checkMapText(readFileSync(file, "utf8"));
    if (result.issues.length || !result.map) {
      ok = false;
      console.log(`✗ ${file}`);
      for (const issue of result.issues) console.log(`  - ${mapIssueText(issue)}`);
    } else {
      console.log(`✓ ${file}\n${describe(result)}`);
    }
  }
  return ok;
}

/** Les cartes du dossier maps/ du dépôt. */
function bundledMaps(): string[] {
  const dir = resolve("maps");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f)) : [];
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
  check([out]);
}

/** Exporte des arènes du jeu en fichiers de carte (`all` : toutes), dans content/arenas/ par défaut. */
function exportArenas(): void {
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
  if (!check(files)) process.exit(1);
}

/** Le nom d'une carte d'après son fichier (sans « .casse-map.json »). */
const mapNameOf = (file: string): string => basename(file).replace(/\.casse-map\.json$|\.json$/i, "");

/**
 * Met des cartes en paquets : pour `carte.casse-map.json`, le dossier `carte/` (à côté, ou dans
 * `--into`) avec map.json, terrain.png et LICENSE.txt.
 */
async function pack(): Promise<void> {
  const into = option("into");
  if (!args.length) {
    console.error("Cartes attendues (.casse-map.json)");
    process.exit(2);
  }
  for (const file of args) {
    const read = readMapText(readFileSync(file, "utf8"));
    if (!read.ok) {
      for (const issue of read.issues) console.log(`  - ${mapIssueText(issue)}`);
      console.error(`${file} : carte illisible, pas de paquet`);
      process.exit(1);
    }
    const dir = join(resolve(into ?? dirname(file)), mapNameOf(file));
    const parts = await packMap(read.map, (d) => new Uint8Array(deflateSync(d, { level: 9 })));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PACKAGE_FILES.map), mapText(parts.map));
    if (parts.terrain) writeFileSync(join(dir, PACKAGE_FILES.terrain), parts.terrain);
    writeFileSync(join(dir, PACKAGE_FILES.license), licenseText(read.map.meta));
    console.log(`Paquet écrit : ${dir}`);
  }
}

/**
 * Refait des cartes d'après leurs paquets : pour le dossier `carte/`, `carte.casse-map.json` (à côté
 * du dossier, ou dans `--into`), vérifiée comme le jeu la vérifie.
 */
async function unpack(): Promise<void> {
  const into = option("into");
  if (!args.length) {
    console.error("Paquets attendus (des dossiers avec map.json)");
    process.exit(2);
  }
  const files: string[] = [];
  for (const dir of args) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(dir, PACKAGE_FILES.map), "utf8"));
    } catch {
      console.error(`${dir} : pas de ${PACKAGE_FILES.map} lisible`);
      process.exit(1);
    }
    const image = packageImage(json);
    const png = image && existsSync(join(dir, image)) ? new Uint8Array(readFileSync(join(dir, image))) : null;
    const read = await unpackMap(json, png, (d) => new Uint8Array(inflateSync(d)));
    if (!read.ok) {
      for (const issue of read.issues) console.log(`  - ${mapIssueText(issue)}`);
      console.error(`${dir} : paquet illisible, pas de carte`);
      process.exit(1);
    }
    const out = join(resolve(into ?? dirname(resolve(dir))), `${basename(resolve(dir))}${MAP_EXTENSION}`);
    writeFileSync(out, mapText(read.map));
    files.push(out);
    console.log(`Carte écrite : ${out}`);
  }
  if (!check(files)) process.exit(1);
}

async function example(): Promise<void> {
  const { map, png } = await exampleMap((d) => new Uint8Array(deflateSync(d, { level: 9 })), (d) => new Uint8Array(inflateSync(d)));
  writeFileSync(resolve("tools/maps/val-du-lac.png"), png);
  writeMap(resolve("maps/val-du-lac.casse-map.json"), map);
  console.log("Carte d'exemple écrite : maps/val-du-lac.casse-map.json (relief source : tools/maps/val-du-lac.png)");
  if (!check([resolve("maps/val-du-lac.casse-map.json")])) process.exit(1);
}

switch (command) {
  case "check": {
    const files = args.length ? args : bundledMaps();
    if (!files.length) {
      console.log("Aucune carte à vérifier");
      break;
    }
    if (!check(files)) process.exit(1);
    break;
  }
  case "terrain":
    await terrain();
    break;
  case "example":
    await example();
    break;
  case "export":
    exportArenas();
    break;
  case "pack":
    await pack();
    break;
  case "unpack":
    await unpack();
    break;
  default:
    console.log("Commandes : check [cartes…], terrain <image> --cells N --step S --high H [--low L] [--mountains DEPUIS,HAUTEUR] [--into carte], example, "
      + "export <arène…|all> [--into dossier], pack <cartes…> [--into dossier], unpack <paquets…> [--into dossier]");
    process.exit(command === "help" ? 0 : 2);
}
