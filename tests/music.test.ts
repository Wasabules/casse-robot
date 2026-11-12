import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHAIN_FADE, HISTORY, MUSIC_TRACKS, Playlist, STINGERS, ShuffleBag, SKIP_FADE, THEMES, chainMove, tracksOf, type MusicKey,
} from "../src/client/audio/music";
import { LOCALE_IDS, translate } from "../src/client/i18n/i18n";

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

  it("chaque morceau et chaque motif a un titre dans chaque langue, différent des autres", () => {
    const all = tracksOf(Object.keys(MUSIC_TRACKS) as MusicKey[]);
    expect(all.length).toBe(24);
    for (const lang of LOCALE_IDS) {
      const titles = all.map((track) => translate(lang, `music.title.${track}`));
      for (const [i, title] of titles.entries()) expect(title.trim().length, `${lang} : ${all[i]}`).toBeGreaterThan(0);
      expect(new Set(titles).size, lang).toBe(titles.length);
    }
  });

  it("les morceaux sont encodés avec les marges d'une boucle, les motifs non", () => {
    const catalog = JSON.parse(readFileSync("tools/sounds/catalog.json", "utf8")) as { sounds: Record<string, { loop: boolean; music?: boolean }> };
    for (const key of Object.values(THEMES).flat() as MusicKey[]) expect(catalog.sounds[key].loop, key).toBe(true);
    for (const key of Object.values(STINGERS).flat() as MusicKey[]) expect(catalog.sounds[key].loop, key).toBe(false);
  });
});

describe("musique : morceau suivant, morceau précédent", () => {
  /** Les `n` morceaux suivants d'une liste de lecture, dans l'ordre. */
  const run = (list: Playlist<string>, n: number): string[] => Array.from({ length: n }, () => list.next());

  it("le suivant vient du sac ; le précédent est celui entendu avant ; puis on repart vers celui qu'on avait quitté", () => {
    const list = new Playlist(["a", "b", "c", "d", "e"], seeded(3));
    expect(list.current).toBeNull();
    expect(list.peekPrevious()).toBeUndefined();
    expect(list.previous()).toBeUndefined();
    const [first, second, third] = run(list, 3);
    expect(list.current).toBe(third);
    expect(list.peekPrevious()).toBe(second);
    expect(list.previous()).toBe(second);
    expect(list.previous()).toBe(first);
    // Rien avant le premier
    expect(list.previous()).toBeUndefined();
    expect(list.current).toBe(first);
    // En avant : d'abord ce qu'on a quitté en revenant, dans l'ordre, puis le sac reprend où il en était
    expect(list.peekNext()).toBe(second);
    expect(list.next()).toBe(second);
    expect(list.next()).toBe(third);
    expect([first, second, third]).not.toContain(list.next());
  });

  it("revenir en arrière puis repartir en avant ne change pas ce que donne le sac : chaque morceau une fois par tour", () => {
    const items = ["a", "b", "c", "d"];
    const plain = new Playlist(items, seeded(11));
    const wandering = new Playlist(items, seeded(11));
    const heard: string[] = [];
    for (let i = 0; i < items.length * 5; i++) {
      heard.push(plain.next());
      const now = wandering.next();
      // De temps en temps, deux pas en arrière puis deux en avant : on retombe sur le même morceau
      if (i >= 2 && i % 3 === 2) {
        const [before, older] = [heard[i - 1], heard[i - 2]];
        expect(wandering.previous()).toBe(before);
        expect(wandering.previous()).toBe(older);
        expect(wandering.next()).toBe(before);
        expect(wandering.next()).toBe(now);
      }
      expect(wandering.current).toBe(plain.current);
    }
    for (let round = 0; round < 5; round++) expect(heard.slice(round * 4, round * 4 + 4).sort()).toEqual(items);
  });

  it("au hasard des sauts, jamais deux fois de suite le même morceau ; un pas en arrière défait un pas en avant", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const random = seeded(seed * 97);
      const list = new Playlist(["a", "b", "c"], seeded(seed));
      let last: string | null = null;
      for (let step = 0; step < 200; step++) {
        const before = list.current;
        const r = random();
        const moves: (string | undefined)[] = [];
        if (r < 0.55) {
          moves.push(list.next());
          if (before !== null && random() < 0.3) {
            const back = list.previous();
            expect(back, `graine ${seed}, pas ${step}`).toBe(before);
            moves.push(back);
          }
        } else if (r < 0.9) {
          const back = list.previous();
          moves.push(back);
          if (back !== undefined && before !== null && random() < 0.3) {
            const forth = list.next();
            expect(forth, `graine ${seed}, pas ${step}`).toBe(before);
            moves.push(forth);
          }
        } else {
          // L'écran se tait, puis reprend au suivant
          list.stop();
          expect(list.current).toBeNull();
          moves.push(list.next());
        }
        for (const moved of moves) {
          if (moved === undefined) continue;
          expect(moved, `graine ${seed}, pas ${step}`).not.toBe(last);
          last = moved;
        }
      }
    }
  });

  it("l'historique garde les derniers morceaux, pas plus", () => {
    const items = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const list = new Playlist(items, seeded(5));
    const heard = run(list, 15);
    const back: string[] = [];
    for (let m = list.previous(); m !== undefined; m = list.previous()) back.push(m);
    expect(back).toEqual(heard.slice(-HISTORY - 1, -1).reverse());
    expect(list.snapshot()).toEqual({ behind: [], ahead: heard.slice(-HISTORY) });
  });

  it("l'écran se tait : le morceau passe derrière, on reprendra au suivant ; on peut encore revenir en arrière", () => {
    const list = new Playlist(["a", "b", "c"], seeded(8));
    const [first, second] = run(list, 2);
    const next = list.peekNext();
    list.stop();
    expect(list.current).toBeNull();
    expect(list.peekNext()).toBe(next);
    expect(list.next()).toBe(next);
    expect(list.previous()).toBe(second);
    expect(list.previous()).toBe(first);
  });

  it("un morceau demandé illisible : on revient à celui qu'on entend, en arrière comme en avant", () => {
    const list = new Playlist(["a", "b", "c", "d"], seeded(21));
    const [first, second] = run(list, 2);
    // En avant, deux fois (le joueur insiste), puis l'échec du dernier : retour au morceau entendu
    list.next();
    list.next();
    expect(list.seek(second)).toBe(true);
    expect(list.current).toBe(second);
    // En arrière, puis l'échec : retour
    expect(list.previous()).toBe(first);
    expect(list.seek(second)).toBe(true);
    expect(list.current).toBe(second);
    expect(list.seek("z")).toBe(false);
  });

  it("un suivant illisible est écarté : il ne revient qu'au tour suivant", () => {
    const list = new Playlist(["a", "b", "c"], seeded(2));
    list.next();
    const skipped = list.peekNext();
    list.discardNext();
    expect(list.peekNext()).not.toBe(skipped);
    // Après un retour en arrière, c'est le morceau quitté qu'on écarte (il reste dans l'historique)
    const second = list.next();
    list.previous();
    expect(list.peekNext()).toBe(second);
    list.discardNext();
    expect(list.peekNext()).not.toBe(second);
  });

  it("un saut se fait en fondu, plus court que l'enchaînement", () => {
    expect(SKIP_FADE).toBeGreaterThan(0.3);
    expect(SKIP_FADE).toBeLessThan(CHAIN_FADE);
  });
});
