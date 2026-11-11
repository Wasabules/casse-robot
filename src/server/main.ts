import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { STEP } from "../shared/config";
import { MAP_LIMITS, type MapFile } from "../shared/map/format";
import { checkMapText } from "../shared/map/validate";
import { DEFAULT_PORT } from "../shared/net/protocol";
import { initPhysics } from "../shared/sim/simulation";
import { ProgressBook } from "./progressBook";
import { Room, type Player } from "./room";
import { cacheControl, contentType, staticPath } from "./staticFiles";

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
book.onChange = () => {
  if (saving) return;
  saving = setTimeout(() => {
    saving = null;
    // Écrire à côté puis renommer : un arrêt brutal ne laisse pas un fichier à moitié écrit
    writeFileSync(`${PROGRESS_FILE}.tmp`, JSON.stringify(book));
    renameSync(`${PROGRESS_FILE}.tmp`, PROGRESS_FILE);
  }, SAVE_DELAY * 1000);
};
/**
 * Dossier des cartes communautaires (MAPS_DIR pour en changer) : chaque fichier `.json` y est lu et
 * vérifié au démarrage (`checkMapText`) ; une carte valide entre dans la rotation, après les
 * arènes du jeu (MAPS_ONLY=1 : seulement les cartes), une carte invalide est écartée, et le journal
 * dit pourquoi.
 */
const MAPS_DIR = resolve(process.env.MAPS_DIR || "maps");

function loadMaps(dir: string): MapFile[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).sort();
  } catch {
    console.log(`Cartes communautaires : pas de dossier ${dir}`);
    return [];
  }
  const maps: MapFile[] = [];
  const keys = new Set<string>();
  for (const name of files) {
    const file = join(dir, name);
    try {
      const size = statSync(file).size;
      if (size > MAP_LIMITS.bytes) {
        console.warn(`Carte écartée : ${name} (${Math.round(size / 1024)} Ko, au plus ${MAP_LIMITS.bytes / 1024} Ko)`);
        continue;
      }
      const check = checkMapText(readFileSync(file, "utf8"));
      if (!check.map || !check.key || check.issues.length) {
        const why = check.issues.map((i) => `${i.code}${Object.keys(i).length > 1 ? ` ${JSON.stringify({ ...i, code: undefined })}` : ""}`);
        console.warn(`Carte écartée : ${name} — ${why.join(" ; ")}`);
        continue;
      }
      if (keys.has(check.key)) {
        console.warn(`Carte écartée : ${name} (la même carte qu'un autre fichier)`);
        continue;
      }
      keys.add(check.key);
      maps.push(check.map);
      console.log(`Carte : ${check.map.meta.name} (${name}, ${check.key})`);
    } catch (e) {
      console.warn(`Carte écartée : ${name} (illisible : ${String(e)})`);
    }
  }
  return maps;
}

const room = new Room(book, { maps: loadMaps(MAPS_DIR), mapsOnly: process.env.MAPS_ONLY === "1" });
console.log(`Rotation des arènes : ${room.rotation.length}`);
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
    // Pour l'hébergeur, pas pour le joueur : en français, comme les journaux du serveur
    res.end(`Casse-Robot : serveur de jeu, ${room.playerCount} joueur(s)\n`); // i18n-ignore
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && serveFile(req, res, url)) return;
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end(staticPath(url) === "index.html"
    ? `Casse-Robot : serveur de jeu, ${room.playerCount} joueur(s). La page du jeu n'est pas compilée : npm run build.\n` // i18n-ignore
    : "Introuvable\n");
});

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

const sockets = new WebSocketServer({ server: http });
sockets.on("connection", (socket: WebSocket, request) => {
  const player: Player = room.connect({
    send: (data) => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
  });
  const from = request.socket.remoteAddress ?? "?";
  console.log(`connexion ${player.id} (${from})`);
  socket.on("message", (data, isBinary) => {
    if (!isBinary) room.receive(player, data.toString());
  });
  socket.on("close", () => {
    room.disconnect(player);
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
    room.tick();
    accumulator -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS) accumulator = 0;
}, 1000 * STEP / 2);
