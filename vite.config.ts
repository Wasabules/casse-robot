import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Les fichiers des éléments du jeu (content/<famille>/<id>.json, qu'importent les catalogues de
 * src/shared/catalog) entrent dans les paquets sans leurs champs « $ » : `$schema` et `$comment` sont
 * pour qui modifie un fichier, le jeu les ignore (src/shared/catalog/content.ts). Leurs notes ne
 * pèsent ainsi rien dans la page, le Worker ou le serveur.
 */
function contentData(): Plugin {
  return {
    name: "casse-robot:content-data",
    enforce: "pre",
    transform(code, id) {
      // Un import avec une requête (« ?raw », « ?url ») n'est plus du JSON quand il arrive ici
      if (id.includes("?") || !/[\\/]content[\\/][^\\/]+[\\/][^\\/]+\.json$/.test(id)) return null;
      const data = JSON.parse(code) as Record<string, unknown>;
      return { code: JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith("$")))), map: null };
    },
  };
}

export default defineConfig({
  // L'adresse où la page est servie : « / » par défaut (serveur de dev, serveur de jeu) ; GitHub Pages
  // la sert sous le nom du dépôt (BASE_PATH=/casse-robot/, .github/workflows/pages.yml). Les sons
  // se chargent d'après elle (import.meta.env.BASE_URL)
  base: process.env.BASE_PATH || "/",
  plugins: [contentData()],
  // Un fichier JSON importé (les éléments du jeu, content/) devient un seul objet, sans un export par
  // champ (qui écrivait une constante par champ dans le paquet)
  json: { namedExports: false },
  // Le client attend l'initialisation de Rapier avec un « await » au premier niveau. Le paquet
  // pèse ~5,8 Mo, dont 4,2 Mo pour Rapier (sa version « compat » embarque le WebAssembly en base64)
  build: { target: "es2022", chunkSizeWarningLimit: 6500 },
  // Les dépendances se cherchent depuis la seule page du jeu : par défaut, Vite parcourt toutes les
  // pages du dossier, y compris celles des copies de travail du dépôt rangées dedans
  optimizeDeps: { entries: ["index.html"], esbuildOptions: { target: "es2022" } },
  // Les Workers (la vérification des cartes de l'éditeur, client/editor/checkWorker.ts ; la partie
  // solo, client/sim/simWorker.ts) se construisent en modules, avec leurs propres greffons
  worker: { format: "es", plugins: () => [contentData()] },
  // Les paquets construits ne sont pas surveillés : un changement qui fait vider le cache de Vite
  // recharge la page en pleine partie, qui perd alors ses morceaux de code chargés à la demande
  // (shaders : l'arène ne se dessinait plus)
  server: { open: true, watch: { ignored: ["**/dist/**", "**/dist-server/**", "**/dist-tools/**"] } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Les arènes du jeu, lues sur le disque depuis leurs fichiers (content/arenas/), comme le serveur les lit
    setupFiles: ["tests/arenaFiles.ts"],
    // Certains tests simulent plusieurs dizaines de secondes de jeu
    testTimeout: 60_000,
  },
});
