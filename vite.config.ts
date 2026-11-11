import { defineConfig } from "vitest/config";

export default defineConfig({
  // L'adresse où la page est servie : « / » par défaut (serveur de dev, serveur de jeu) ; GitHub Pages
  // la sert sous le nom du dépôt (BASE_PATH=/casse-robot/, .github/workflows/pages.yml). Les sons
  // se chargent d'après elle (import.meta.env.BASE_URL)
  base: process.env.BASE_PATH || "/",
  // Le client attend l'initialisation de Rapier avec un « await » au premier niveau. Le paquet
  // pèse ~5,8 Mo, dont 4,2 Mo pour Rapier (sa version « compat » embarque le WebAssembly en base64)
  build: { target: "es2022", chunkSizeWarningLimit: 6500 },
  // Les dépendances se cherchent depuis la seule page du jeu : par défaut, Vite parcourt toutes les
  // pages du dossier, y compris celles des copies de travail du dépôt rangées dedans
  optimizeDeps: { entries: ["index.html"], esbuildOptions: { target: "es2022" } },
  // La vérification des cartes de l'éditeur tourne dans un Worker (client/editor/checkWorker.ts), en module
  worker: { format: "es" },
  // Les paquets construits ne sont pas surveillés : un changement qui fait vider le cache de Vite
  // recharge la page en pleine partie, qui perd alors ses morceaux de code chargés à la demande
  // (shaders : l'arène ne se dessinait plus)
  server: { open: true, watch: { ignored: ["**/dist/**", "**/dist-server/**", "**/dist-tools/**"] } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Certains tests simulent plusieurs dizaines de secondes de jeu
    testTimeout: 60_000,
  },
});
