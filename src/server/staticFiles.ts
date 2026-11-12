/*
 * Pages du jeu servies par le serveur de jeu lui-même (`npm run share`, `npm run server` après
 * `npm run build`) : une seule adresse pour la page et la partie, ce que demande un tunnel. Ici, la
 * logique pure (quel fichier pour quelle adresse, son type, sa mise en cache) ; la lecture des
 * fichiers est dans main.ts, seul à toucher à Node.
 */

/**
 * Chemin du fichier (relatif au dossier du client compilé, séparé par des « / ») que demande
 * l'adresse `url` (« /assets/x.js?v=1 ») ; la page d'accueil pour « / ». Null pour une adresse
 * qui chercherait à sortir du dossier (« .. », barre oblique inverse, lecteur, caractère nul) ou
 * qu'on ne sait pas lire.
 */
export function staticPath(url: string): string | null {
  const path = url.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || /[\\\0:]/.test(decoded)) return null;
  const parts = decoded.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.length ? parts.join("/") : "index.html";
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  wasm: "application/wasm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  glb: "model/gltf-binary",
  zip: "application/zip",
};

/** Type d'un fichier d'après son extension. */
export function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

/**
 * Mise en cache : les fichiers de `assets/` portent l'empreinte de leur contenu dans leur nom
 * (Vite), ils ne changent jamais ; la page et le reste se revérifient à chaque visite (une
 * nouvelle version du jeu se voit tout de suite).
 */
export function cacheControl(path: string): string {
  return path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

/** Une ressource d'une carte (map/pack.ts) : son adresse dit son empreinte, elle ne change jamais. */
export const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * L'empreinte SHA-256 de la ressource de carte que demande l'adresse `url`
 * (« /map-assets/<64 chiffres hexadécimaux> », voir `MAP_ASSET_PATH`), ou null si ce n'en est pas une.
 * Le serveur ne sert que les ressources des cartes qu'il a lues, d'après leur empreinte : rien d'un dossier.
 */
export function mapAssetHash(url: string, prefix: string): string | null {
  const path = url.split(/[?#]/, 1)[0];
  if (!path.startsWith(prefix)) return null;
  const hash = path.slice(prefix.length);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}
