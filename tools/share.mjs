// npm run share : partager le jeu sur Internet, pour jouer à plusieurs.
//
// Compile la page du jeu et le serveur, lance le serveur de jeu (qui sert aussi la page : une
// seule adresse pour tout ; sous son superviseur, tools/server/supervise.mjs, qui le relance s'il
// s'arrête sur une erreur), puis ouvre un tunnel Cloudflare rapide (cloudflared, sans compte) vers
// lui et affiche le lien à envoyer. Chacun ouvre le lien et choisit « Multijoueur » : le client
// trouve tout seul le serveur à la même adresse. Ctrl+C arrête tout.
//
//   npm run share                  compile, lance le serveur et le tunnel
//   npm run share -- --no-build    sans recompiler (déjà fait)
//   PORT=9000 npm run share        sur un autre port
import { spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";

const PORT = process.env.PORT || "8787";
const skipBuild = process.argv.includes("--no-build");
/** Le lien d'un tunnel rapide, dans ce qu'écrit cloudflared. */
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const children = [];
let stopping = false;
/** Ctrl+C reçu : on attend que les processus s'arrêtent d'eux-mêmes (voir `interrupt`). */
let leaving = false;
/** Au plus combien de secondes on leur laisse pour s'arrêter seuls après Ctrl+C. */
const GRACE = 6;

/** Sous Windows, un processus tué ne tue pas les siens (le superviseur, son serveur) : on tue l'arbre. */
function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill();
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) kill(child);
  process.exit(code);
}

/**
 * Ctrl+C : sous Windows, il parvient aussi au superviseur, au serveur (qui enregistre alors la
 * progression des joueurs) et au tunnel ; on leur laisse le temps de s'arrêter seuls avant de tuer
 * ce qui reste. Ailleurs, `kill` leur envoie SIGTERM, que le superviseur passe au serveur.
 */
function interrupt() {
  if (stopping || leaving) return;
  if (process.platform !== "win32") return stop(0);
  leaving = true;
  const until = Date.now() + GRACE * 1000;
  const wait = () => {
    const alive = children.some((c) => c.exitCode === null && c.signalCode === null);
    if (!alive || Date.now() > until) stop(0);
    else setTimeout(wait, 100);
  };
  wait();
}
process.on("SIGINT", interrupt);
process.on("SIGTERM", () => stop(0));

function run(label, command) {
  console.log(`\n» ${label}`);
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`\nÉchec : ${label}.`);
    process.exit(result.status ?? 1);
  }
}

if (!skipBuild) {
  run("Compilation de la page du jeu", "npx vite build");
  run("Compilation du serveur", "npx vite build --ssr src/server/main.ts --outDir dist-server --emptyOutDir");
}

// Le serveur de jeu, sous son superviseur : relancé s'il s'arrête sur une erreur (ce qu'il ne sait pas
// rattraper lui-même, voir server/roomHost.ts), arrêté avec lui
console.log(`\n» Serveur de jeu sur le port ${PORT} (relancé s'il s'arrête sur une erreur)`);
const server = spawn(process.execPath, ["tools/server/supervise.mjs", "dist-server/main.js"], { env: { ...process.env, PORT }, stdio: "inherit" });
children.push(server);
server.on("exit", (code) => {
  if (!stopping && !leaving) {
    console.error(`\nLe serveur de jeu s'est arrêté (code ${code}).`);
    stop(code ?? 1);
  }
});

// On attend qu'il réponde avant d'ouvrir le tunnel
const local = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
  try {
    const res = await fetch(`${local}/status`);
    if (res.ok) break;
  } catch {
    // pas encore prêt
  }
  if (i > 120) {
    console.error("\nLe serveur de jeu ne répond pas.");
    stop(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}

/**
 * Adresse de la machine sur le réseau local (pour jouer à la maison sans tunnel) : celle de la
 * carte par laquelle elle sort vers Internet. Une socket UDP « connectée » ne fait que choisir sa
 * route, elle n'envoie rien ; les cartes virtuelles (VirtualBox, VMware, Hyper-V…) sont ainsi écartées.
 */
const lanAddress = await new Promise((resolve) => {
  const socket = createSocket("udp4");
  socket.on("error", () => resolve(null));
  socket.connect(53, "1.1.1.1", () => {
    const { address } = socket.address();
    socket.close();
    resolve(address);
  });
});
const lan = lanAddress ? [`http://${lanAddress}:${PORT}`] : [];

function banner(link) {
  const lines = [
    "Casse-Robot est partagé !",
    "",
    link ? `Lien à envoyer : ${link}` : "Pas de tunnel : seulement sur ce réseau.",
    "",
    `Sur cette machine : ${local}`,
    ...lan.map((a) => `Réseau local      : ${a}`),
    "",
    "Chacun ouvre le lien, puis « Multijoueur » → « Rejoindre ».",
    "Ctrl+C pour tout arrêter.",
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const bar = "═".repeat(width + 2);
  console.log(`\n╔${bar}╗\n${lines.map((l) => `║ ${l.padEnd(width)} ║`).join("\n")}\n╚${bar}╝\n`);
}

// Le tunnel
console.log("\n» Tunnel Cloudflare (cloudflared)");
const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", local], { stdio: ["ignore", "pipe", "pipe"] });
children.push(tunnel);
let announced = false;
const watch = (chunk) => {
  const text = chunk.toString();
  const found = text.match(TUNNEL_URL);
  if (found && !announced) {
    announced = true;
    banner(found[0]);
  }
  // Ses erreurs, sans le reste de son bavardage
  for (const line of text.split("\n")) if (/\bERR\b/.test(line)) console.error(`[cloudflared] ${line.trim()}`);
};
tunnel.stdout.on("data", watch);
tunnel.stderr.on("data", watch);
tunnel.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error("\ncloudflared est introuvable. Pour l'installer : winget install --id Cloudflare.cloudflared");
    console.error("(ou https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)");
    console.error("Le serveur reste lancé : on peut jouer sur le réseau local.");
    banner(null);
  } else {
    console.error(`\nTunnel impossible : ${err.message}`);
  }
});
tunnel.on("exit", (code) => {
  if (!stopping && !leaving && announced) console.error(`\nLe tunnel s'est fermé (code ${code}). Le serveur reste lancé sur le réseau local ; relancer npm run share pour un nouveau lien.`);
});
