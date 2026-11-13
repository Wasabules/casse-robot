import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { gzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { ARENA_IDS, gameArena, type ArenaId } from "../shared/arena/layout";
import { STEP } from "../shared/config";
import { MAP_LIMITS, PACKAGE_LIMITS, type MapFile, type MapIssue } from "../shared/map/format";
import { GAME_ARENA_DIR, gameArenaFileName, provideGameArenaText } from "../shared/map/gameArenas";
import { assetEntries, folderSource, isArchive, PACKAGE_FILES, readMapArchive, readPackage, type FolderAccess, type PackageRead } from "../shared/map/pack";
import { readMapText } from "../shared/map/read";
import { checkMap } from "../shared/map/validate";
import { DEFAULT_PORT, MAP_ASSET_PATH } from "../shared/net/protocol";
import { WireEncoder } from "../shared/net/wire";
import { initPhysics } from "../shared/sim/simulation";
import { SimCompiled } from "../shared/native/simModule";
import { DEFAULT_SIMULATION, simulationNamed, type SimulationEngine } from "../shared/native/choice";
import { NativeRoom } from "./nativeRoom";
import { ProgressBook } from "./progressBook";
import { Room, type Player, type RoomBase, type RoomOptions } from "./room";
import { RoomHost } from "./roomHost";
import { cacheControl, contentType, IMMUTABLE, mapAssetHash, staticPath } from "./staticFiles";

/*
 * Serveur de jeu : une salle (room.ts) qui simule à pas fixe, et un serveur WebSocket qui relie
 * les clients à la salle. `npm run server` le construit et le lance ; le port se change avec la
 * variable d'environnement PORT. Il sert aussi la page du jeu compilée (`npm run build`, dossier
 * `dist`, CLIENT_DIR pour en changer) : la page et la partie à la même adresse, ce que demande un
 * tunnel (`npm run share`) ; son état est sur `/status`.
 */

/** Au plus autant de pas d'un coup : si la machine décroche, le jeu ralentit au lieu de s'emballer. */
const MAX_STEPS = 8;

/** Fichier où le serveur garde la progression des joueurs (PROGRESS_FILE pour en changer). */
const PROGRESS_FILE = process.env.PROGRESS_FILE || "casse-robot-progress.json";
/** Délai avant d'enregistrer après un changement (s) : plusieurs changements, une seule écriture. */
const SAVE_DELAY = 1;

await initPhysics();
const book = new ProgressBook();
try {
  book.load(JSON.parse(readFileSync(PROGRESS_FILE, "utf8")));
} catch {
  // Premier démarrage : pas encore de fichier
}
let saving: ReturnType<typeof setTimeout> | null = null;
/** Enregistre la progression, si elle a changé depuis la dernière fois. */
function saveProgress(): void {
  if (!saving) return;
  clearTimeout(saving);
  saving = null;
  // Écrire à côté puis renommer : un arrêt brutal ne laisse pas un fichier à moitié écrit
  writeFileSync(`${PROGRESS_FILE}.tmp`, JSON.stringify(book));
  renameSync(`${PROGRESS_FILE}.tmp`, PROGRESS_FILE);
}
book.onChange = () => {
  saving ??= setTimeout(saveProgress, SAVE_DELAY * 1000);
};

/**
 * Le processus s'arrête : la progression d'abord (un changement de moins d'une seconde n'est pas encore
 * écrit). Une erreur que rien n'a rattrapée l'arrête avec le code 1, qu'un superviseur relance
 * (tools/server/supervise.mjs, `npm run server:supervised`) ; un arrêt demandé (Ctrl+C, SIGTERM), avec le code 0.
 */
function stop(code: number): never {
  try {
    saveProgress();
  } catch (e) {
    console.error("Progression non enregistrée :", e);
  }
  process.exit(code);
}
process.on("uncaughtException", (e) => {
  console.error("Erreur que rien n'a rattrapée : le serveur s'arrête", e);
  stop(1);
});
process.on("unhandledRejection", (e) => {
  console.error("Promesse rejetée que rien n'a rattrapée : le serveur s'arrête", e);
  stop(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(0));
/**
 * Dossier des arènes du jeu (ARENAS_DIR pour en changer) : leurs fichiers de carte (content/arenas/,
 * faits par `npm run map:export`), lus et construits au démarrage (map/gameArenas.ts). Une arène dont
 * le fichier manque ou ne se lit pas sort de la rotation, et le journal dit pourquoi ; sans le Dépôt,
 * l'arène par défaut, la salle ne se crée pas. ARENAS=valley,canyon : seulement ces arènes du jeu dans
 * la rotation, dans cet ordre.
 */
const ARENAS_DIR = resolve(process.env.ARENAS_DIR || GAME_ARENA_DIR);

/** Les arènes du jeu de la rotation : celles de ARENAS (parmi celles qui se sont chargées), sinon toutes. */
function rotationOf(loaded: readonly ArenaId[]): ArenaId[] {
  const wanted = (process.env.ARENAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) return [...loaded];
  for (const id of wanted) if (!loaded.some((a) => a === id)) console.warn(`ARENAS : ${id} n'est pas une arène du jeu chargée`);
  const picked = loaded.length ? wanted.flatMap((id) => loaded.filter((a) => a === id)) : [];
  return picked.length ? picked : [...loaded];
}

function loadGameArenas(dir: string): ArenaId[] {
  const loaded: ArenaId[] = [];
  for (const id of ARENA_IDS) {
    const name = gameArenaFileName(id);
    try {
      const start = performance.now();
      provideGameArenaText(id, readFileSync(join(dir, name), "utf8"));
      // Construite tout de suite : un fichier qui ne se joue pas se voit au démarrage, pas à son tour
      const arena = gameArena(id);
      console.log(`Arène : ${id} (${name}, ${arena.boxes.length} boîtes, ${arena.props.length} accessoires, ${Math.round(performance.now() - start)} ms)`);
      loaded.push(id);
    } catch (e) {
      console.warn(`Arène écartée : ${id} (${join(dir, name)} : ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return loaded;
}

/**
 * Dossier des cartes communautaires (MAPS_DIR pour en changer) : chaque carte y est lue et vérifiée
 * au démarrage (`checkMap`) : un fichier `.json`, un paquet en archive (`.zip`) ou en dossier (un
 * dossier qui a un map.json : map/pack.ts) ; une carte valide entre dans la rotation, après les
 * arènes du jeu (MAPS_ONLY=1 : seulement les cartes), une carte invalide est écartée, et le journal
 * dit pourquoi. Les ressources d'un paquet (modèles, ambiance) sont gardées en mémoire et servies
 * d'après leur empreinte (`MAP_ASSET_PATH`) au client qui reçoit la carte.
 */
const MAPS_DIR = resolve(process.env.MAPS_DIR || "maps");

/** Décompression zlib (le relief d'un paquet), bornée à la taille de l'image qu'on attend. */
const inflate = (d: Uint8Array, max?: number): Uint8Array => new Uint8Array(inflateSync(d, max ? { maxOutputLength: max } : {}));
/** Décompression brute bornée : au-delà de la taille annoncée par l'archive, elle s'arrête. */
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

/** Une carte du dossier : un fichier de carte, un paquet en archive ou en dossier. */
async function readMapSource(file: string, folder: boolean): Promise<PackageRead> {
  if (folder) return readPackage(folderSource(folderAccess(file)), inflate);
  const size = statSync(file).size;
  const max = file.toLowerCase().endsWith(".zip") ? PACKAGE_LIMITS.archive : MAP_LIMITS.bytes;
  if (size > max) return { ok: false, issues: [{ code: "tooLarge", size: Math.ceil(size / 1024), max: max / 1024 }] };
  const bytes = new Uint8Array(readFileSync(file));
  if (isArchive(bytes)) return readMapArchive(bytes, inflate, inflateRaw);
  const read = readMapText(new TextDecoder().decode(bytes));
  return read.ok ? { ok: true, map: read.map, assets: new Map(), license: null } : read;
}

/** Une ressource servie : ses octets, son type, et sa version compressée (un modèle), faite une fois. */
interface Shelved {
  readonly bytes: Uint8Array;
  readonly type: string;
  gzip?: Buffer;
}

/** Les ressources des cartes de la rotation, d'après leur empreinte. */
const shelf = new Map<string, Shelved>();

/** Pourquoi une carte est écartée, pour le journal (des codes : le serveur n'écrit pas de texte au joueur). */
const why = (issues: readonly MapIssue[]): string => issues.map((i) => `${i.code}${Object.keys(i).length > 1 ? ` ${JSON.stringify({ ...i, code: undefined })}` : ""}`).join(" ; ");

async function loadMaps(dir: string): Promise<MapFile[]> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    console.log(`Cartes communautaires : pas de dossier ${dir}`);
    return [];
  }
  const sources = entries
    .filter((e) => (e.isDirectory() ? existsSync(join(dir, e.name, PACKAGE_FILES.map)) : /\.(json|zip)$/i.test(e.name)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const maps: MapFile[] = [];
  const keys = new Set<string>();
  for (const entry of sources) {
    const name = entry.name;
    try {
      const read = await readMapSource(join(dir, name), entry.isDirectory());
      if (!read.ok) {
        console.warn(`Carte écartée : ${name} — ${why(read.issues)}`);
        continue;
      }
      const check = checkMap(read.map);
      if (!check.map || !check.key || check.issues.length) {
        console.warn(`Carte écartée : ${name} — ${why(check.issues)}`);
        continue;
      }
      if (keys.has(check.key)) {
        console.warn(`Carte écartée : ${name} (la même carte qu'un autre fichier)`);
        continue;
      }
      keys.add(check.key);
      maps.push(check.map);
      const assets = assetEntries(check.map.assets);
      for (const a of assets) shelf.set(a.asset.sha256, { bytes: read.assets.get(a.asset.sha256)!, type: a.type ? contentType("x.glb") : contentType("x.ogg") });
      const extra = assets.length ? `, ${assets.length} ressource(s), ${Math.round(assets.reduce((n, a) => n + a.asset.bytes, 0) / 1024)} Ko` : "";
      console.log(`Carte : ${check.map.meta.name} (${name}, ${check.key}${extra})`);
    } catch (e) {
      console.warn(`Carte écartée : ${name} (illisible : ${String(e)})`);
    }
  }
  return maps;
}

/**
 * La simulation compilée entière (la simulation Rust) : SIM_WASM, sinon celle des sources
 * (src/shared/native/casse-sim.wasm, npm run native), sinon celle du client compilé (dist/assets/) ;
 * null si aucune n'est là.
 */
function simWasm(): Uint8Array | null {
  const candidates = [process.env.SIM_WASM, "src/shared/native/casse-sim.wasm"].filter((p): p is string => !!p).map((p) => resolve(p));
  const assets = resolve(process.env.CLIENT_DIR || "dist", "assets");
  if (existsSync(assets)) candidates.push(...readdirSync(assets).filter((f) => /^casse-sim-.*\.wasm$/.test(f)).map((f) => join(assets, f)));
  const found = candidates.find((p) => existsSync(p));
  return found ? new Uint8Array(readFileSync(found)) : null;
}

/**
 * La salle, sur la simulation choisie : `SIM=ts` ou `SIM=rust`, sinon celle par défaut
 * (`DEFAULT_SIMULATION`, src/shared/native/choice.ts) ; les mêmes images. La simulation Rust demandée
 * (`SIM=rust`) dont le module manque arrête le serveur ; celle par défaut laisse la place au TypeScript.
 * Le module est compilé une fois : chaque salle a son instance (une salle relancée après une panique,
 * server/roomHost.ts, en prend une neuve).
 */
async function openHost(options: RoomOptions): Promise<RoomHost> {
  const asked = simulationNamed(process.env.SIM);
  if (process.env.SIM && !asked) throw new Error(`SIM : « ts » ou « rust », pas « ${process.env.SIM} »`);
  let compiled: SimCompiled | null = null;
  if ((asked ?? DEFAULT_SIMULATION) === "rust") {
    const bytes = simWasm();
    if (bytes) compiled = await SimCompiled.compile(bytes);
    else if (asked) throw new Error("SIM=rust : la simulation compilée est introuvable (npm run native, ou SIM_WASM)");
    else console.warn("Simulation Rust introuvable (npm run native, ou SIM_WASM) : la salle tourne sur celle du TypeScript");
  }
  const make = (engine: SimulationEngine, roomOptions: RoomOptions): RoomBase<unknown> =>
    engine === "rust" && compiled ? new NativeRoom(compiled.instance(), book, roomOptions) : new Room(book, roomOptions);
  return new RoomHost(make, compiled ? "rust" : "ts", options, {
    fault: faultOf(process.env.SIM_FAULT),
    onGiveUp: () => stop(1),
  });
}

/**
 * Outil d'essai, pas pour un vrai serveur : `SIM_FAULT=secondes[,nombre]` provoque une vraie panne de la
 * simulation (une panique du module Rust, une exception de celle du TypeScript : `provokeFault`) après
 * tant de secondes de temps simulé dans chaque salle, `nombre` fois en tout (1 par défaut) ; la salle
 * se relance (server/roomHost.ts). `SIM_FAULT=10,3` : trois paniques de la Rust, puis le repli sur le TypeScript.
 */
function faultOf(text: string | undefined): { after: number; count: number } | null {
  if (!text) return null;
  const [after, count = 1] = text.split(",").map(Number);
  if (!Number.isFinite(after) || after < 0 || !Number.isInteger(count) || count < 1) throw new Error(`SIM_FAULT : « secondes[,nombre] », pas « ${text} »`);
  console.warn(`SIM_FAULT=${text} : ${count} panne(s) d'essai de la simulation, après ${after} s dans chaque salle`);
  return { after, count };
}

const roomOptions: RoomOptions = { arenas: rotationOf(loadGameArenas(ARENAS_DIR)), maps: await loadMaps(MAPS_DIR), mapsOnly: process.env.MAPS_ONLY === "1" };
const host = await openHost(roomOptions);
console.log(`Rotation des arènes : ${host.room.rotation.length} (simulation ${host.engine === "rust" ? "Rust" : "TypeScript"})`);
const port = Number(process.env.PORT) || DEFAULT_PORT;

/** Dossier du client compilé, servi à côté de la partie. */
const CLIENT_DIR = resolve(process.env.CLIENT_DIR || "dist");
/** Types qu'on compresse (le paquet du jeu pèse ~6 Mo, dont Rapier en base64 : il se réduit beaucoup). */
const COMPRESSIBLE = /^(text\/|application\/(json|wasm)|image\/svg)/;
/** Fichiers déjà compressés, avec la date du fichier compressé : une seule compression par version. */
const gzipped = new Map<string, { mtime: number; data: Buffer }>();

const http = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/status" || url.startsWith("/status?")) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
    // Pour l'hébergeur, pas pour le joueur : en français, comme les journaux du serveur (la simulation, ses redémarrages, la dernière panne)
    res.end(`Casse-Robot : serveur de jeu, ${host.playerCount} joueur(s), ${host.describe()}\n`); // i18n-ignore
    return;
  }
  const asset = mapAssetHash(url, MAP_ASSET_PATH);
  if (asset !== null && (req.method === "GET" || req.method === "HEAD")) {
    serveAsset(req, res, asset);
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && serveFile(req, res, url)) return;
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end(staticPath(url) === "index.html"
    ? `Casse-Robot : serveur de jeu, ${host.playerCount} joueur(s). La page du jeu n'est pas compilée : npm run build.\n` // i18n-ignore
    : "Introuvable\n");
});

/**
 * Sert une ressource d'une carte de la rotation, d'après son empreinte : à n'importe quelle page
 * (`access-control-allow-origin` : en développement, la page vient de Vite, sur un autre port), et
 * pour toujours (l'adresse dit le contenu). Un modèle se compresse (une fois) ; un Ogg l'est déjà.
 */
function serveAsset(req: IncomingMessage, res: ServerResponse, hash: string): void {
  const item = shelf.get(hash);
  const headers: Record<string, string | number> = { "access-control-allow-origin": "*" };
  if (!item) {
    res.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" });
    res.end("Introuvable\n");
    return;
  }
  Object.assign(headers, { "content-type": item.type, "cache-control": IMMUTABLE, vary: "accept-encoding" });
  let body: Uint8Array = item.bytes;
  if (item.type === contentType("x.glb") && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    item.gzip ??= gzipSync(item.bytes);
    body = item.gzip;
    headers["content-encoding"] = "gzip";
  }
  headers["content-length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

/** Sert un fichier du client compilé, s'il existe (et sans sortir de son dossier). */
function serveFile(req: IncomingMessage, res: ServerResponse, url: string): boolean {
  const rel = staticPath(url);
  if (!rel) return false;
  const file = resolve(CLIENT_DIR, rel);
  if (!file.startsWith(CLIENT_DIR + sep)) return false;
  let mtime: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return false;
    mtime = stat.mtimeMs;
  } catch {
    return false;
  }
  const type = contentType(rel);
  const headers: Record<string, string | number> = { "content-type": type, "cache-control": cacheControl(rel), vary: "accept-encoding" };
  let body: Buffer;
  if (COMPRESSIBLE.test(type) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    let cached = gzipped.get(file);
    if (!cached || cached.mtime !== mtime) {
      cached = { mtime, data: gzipSync(readFileSync(file)) };
      gzipped.set(file, cached);
    }
    body = cached.data;
    headers["content-encoding"] = "gzip";
  } else {
    body = readFileSync(file);
  }
  headers["content-length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

/**
 * Le fil (shared/net/wire.ts) : chaque image de la salle, quantifiée une fois pour tous, part à chacun en
 * écarts à la précédente qu'il a reçue ; la WebSocket la compresse par-dessus (`permessage-deflate`,
 * que les navigateurs parlent : chaque liaison garde son contexte d'une image à l'autre).
 */
const wire = new WireEncoder(() => performance.now());
const sockets = new WebSocketServer({ server: http, perMessageDeflate: { threshold: 64 } });
sockets.on("connection", (socket: WebSocket, request) => {
  const stream = wire.stream();
  const player: Player<unknown> = host.connect({
    send: (data) => {
      if (socket.readyState === socket.OPEN) socket.send(typeof data === "string" ? data : stream.encode(data));
    },
  });
  const from = request.socket.remoteAddress ?? "?";
  console.log(`connexion ${player.id} (${from})`);
  socket.on("message", (data, isBinary) => {
    if (!isBinary) host.receive(player, data.toString());
  });
  socket.on("close", () => {
    host.disconnect(player);
    console.log(`départ ${player.id}${player.name ? ` (${player.name})` : ""}`);
  });
});

http.listen(port, () => console.log(`Serveur Casse-Robot : http://localhost:${port} (partie : ws://localhost:${port})`));

// Boucle à pas fixe
let last = performance.now();
let accumulator = 0;
setInterval(() => {
  const now = performance.now();
  accumulator += (now - last) / 1000;
  last = now;
  let steps = 0;
  while (accumulator >= STEP && steps < MAX_STEPS) {
    host.tick();
    accumulator -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS) accumulator = 0;
}, 1000 * STEP / 2);
