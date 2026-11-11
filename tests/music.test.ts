import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAIN_FADE, MUSIC_TRACKS, STINGERS, ShuffleBag, THEMES, chainMove, tracksOf, type MusicKey } from "../src/client/audio/music";

/** Un hasard reproductible (générateur congruentiel). */
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe("musique : enchaînement des morceaux", () => {
  it("le sac mélangé fait passer chaque morceau une fois par tour, jamais deux fois de suite le même", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const items = ["a", "b", "c", "d", "e"];
      const bag = new ShuffleBag(items, seeded(seed));
      const drawn: string[] = [];
      for (let i = 0; i < items.length * 6; i++) {
        const next = bag.peek();
        expect(bag.take()).toBe(next);
        drawn.push(next);
      }
      for (let round = 0; round < 6; round++) {
        expect([...drawn.slice(round * items.length, (round + 1) * items.length)].sort()).toEqual(items);
      }
      for (let i = 1; i < drawn.length; i++) expect(drawn[i], `tirage ${i} (graine ${seed})`).not.toBe(drawn[i - 1]);
    }
  });

  it("avec deux morceaux, ils alternent ; avec un seul, il revient", () => {
    const two = new ShuffleBag(["a", "b"], seeded(7));
    const seq = Array.from({ length: 10 }, () => two.take());
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
    const one = new ShuffleBag(["a"], seeded(7));
    expect([one.take(), one.take(), one.take()]).toEqual(["a", "a", "a"]);
    expect(() => new ShuffleBag([])).toThrow();
  });

  it("le morceau en cours enchaîne près de sa fin si le suivant est prêt, sinon il reprend à son début", () => {
    expect(chainMove(60, "ready")).toBe("wait");
    expect(chainMove(CHAIN_FADE + 1, "ready")).toBe("wait");
    expect(chainMove(CHAIN_FADE, "ready")).toBe("chain");
    expect(chainMove(1, "ready")).toBe("chain");
    // Pas prêt : on attend, puis on reprend au début juste avant la fin
    expect(chainMove(CHAIN_FADE, "loading")).toBe("wait");
    expect(chainMove(0.3, "loading")).toBe("loop");
    expect(chainMove(0.3, null)).toBe("loop");
    // Illisible : on en prépare un autre
    expect(chainMove(CHAIN_FADE, "failed")).toBe("replace");
    expect(chainMove(60, "failed")).toBe("wait");
  });

  it("chaque morceau appartient à un écran ou à un motif, et chaque écran en a plusieurs", () => {
    const listed = [...Object.values(THEMES).flat(), ...Object.values(STINGERS).flat()];
    expect([...listed].sort()).toEqual(Object.keys(MUSIC_TRACKS).sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const [theme, keys] of Object.entries(THEMES)) expect(tracksOf(keys).length, theme).toBeGreaterThanOrEqual(2);
    expect(tracksOf(["music-battle-a", "music-battle-c"])).toEqual(["music-battle-a-1", "music-battle-a-2", "music-battle-c-1"]);
  });

  it("les morceaux sont encodés avec les marges d'une boucle, les motifs non", () => {
    const catalog = JSON.parse(readFileSync("tools/sounds/catalog.json", "utf8")) as { sounds: Record<string, { loop: boolean; music?: boolean }> };
    for (const key of Object.values(THEMES).flat() as MusicKey[]) expect(catalog.sounds[key].loop, key).toBe(true);
    for (const key of Object.values(STINGERS).flat() as MusicKey[]) expect(catalog.sounds[key].loop, key).toBe(false);
  });
});
