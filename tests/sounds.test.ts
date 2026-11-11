import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MUSIC_TRACKS, type MusicKey } from "../src/client/audio/music";
import { SAMPLES, sampleFile, type SampleKey } from "../src/client/audio/samples";

describe("sons enregistrés", () => {
  it("chaque son du jeu a ses fichiers, autant que le catalogue de génération en retient", () => {
    const catalog = JSON.parse(readFileSync("tools/sounds/catalog.json", "utf8")) as { sounds: Record<string, { keep: string[]; loop: boolean }> };
    for (const key of Object.keys(SAMPLES) as SampleKey[]) {
      const { variants } = SAMPLES[key];
      for (let n = 1; n <= variants; n++) expect(existsSync(`public/${sampleFile(key, n)}`), sampleFile(key, n)).toBe(true);
      expect(existsSync(`public/${sampleFile(key, variants + 1)}`), `${key} : une variante de trop`).toBe(false);
      expect(catalog.sounds[key]?.keep.length, key).toBe(variants);
      // Une boucle est encodée avec ses marges (tools/sounds/build.mjs) : le jeu doit le savoir
      expect("loop" in SAMPLES[key], `${key} : boucle ou non`).toBe(catalog.sounds[key].loop);
    }
  });

  it("chaque morceau de musique a ses fichiers, autant que le catalogue en retient", () => {
    const catalog = JSON.parse(readFileSync("tools/sounds/catalog.json", "utf8")) as { sounds: Record<string, { keep: string[]; music?: boolean }> };
    for (const key of Object.keys(MUSIC_TRACKS) as MusicKey[]) {
      const variants = MUSIC_TRACKS[key];
      for (let n = 1; n <= variants; n++) expect(existsSync(`public/sounds/${key}-${n}.ogg`), `${key}-${n}`).toBe(true);
      expect(existsSync(`public/sounds/${key}-${variants + 1}.ogg`), `${key} : une variante de trop`).toBe(false);
      expect(catalog.sounds[key]?.keep.length, key).toBe(variants);
      expect(catalog.sounds[key]?.music, key).toBe(true);
    }
  });
});
