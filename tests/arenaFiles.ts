import { readFileSync } from "node:fs";
import { GAME_ARENA_DIR, gameArenaFileName, readGameArenasWith } from "../src/shared/map/gameArenas";

/*
 * Les essais jouent les arènes du jeu depuis leurs fichiers (content/arenas/), comme le jeu et le
 * serveur : lus sur le disque à la demande, avant chaque fichier d'essais (vite.config.ts :
 * `test.setupFiles`). `ARENAS.valley` se lit donc comme avant ; le code des arènes, lui, est
 * `ARENA_SOURCES` (arena/sources.ts).
 */
readGameArenasWith((id) => {
  try {
    return readFileSync(new URL(`../${GAME_ARENA_DIR}/${gameArenaFileName(id)}`, import.meta.url), "utf8");
  } catch {
    return undefined;
  }
});
