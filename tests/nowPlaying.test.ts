import { describe, expect, it } from "vitest";
import { announces, PlayerFold, UNFOLD_MS } from "../src/client/hud/nowPlaying";

describe("Lecteur de musique : déplié, réduit à sa pastille, caché", () => {
  it("toujours affiché : jamais réduit, la note ne fait rien", () => {
    const f = new PlayerFold();
    expect(f.setting).toBe("always");
    f.unfold(0);
    expect(f.folded).toBe(false);
    expect(f.due).toBeNull();
    expect(f.tick(UNFOLD_MS * 10, false)).toBe(false);
    f.toggle(0);
    expect(f.folded).toBe(false);
  });

  it("qui se réduit tout seul : réduit d'emblée, déplié quand un morceau commence, réduit après le délai", () => {
    const f = new PlayerFold();
    f.setMode("auto");
    expect(f.folded).toBe(true);
    expect(f.due).toBeNull();
    // Un morceau commence à 1 s : déplié jusqu'à 1 s + UNFOLD_MS
    f.unfold(1000);
    expect(f.folded).toBe(false);
    expect(f.due).toBe(1000 + UNFOLD_MS);
    expect(f.tick(1000 + UNFOLD_MS - 1, false)).toBe(false);
    expect(f.folded).toBe(false);
    expect(f.tick(1000 + UNFOLD_MS, false)).toBe(true);
    expect(f.folded).toBe(true);
    expect(f.due).toBeNull();
    // Plus rien à faire une fois réduit
    expect(f.tick(1000 + 5 * UNFOLD_MS, false)).toBe(false);
  });

  it("un toucher sur la pastille la déplie, un autre sur la note la réduit", () => {
    const f = new PlayerFold();
    f.setMode("auto");
    f.toggle(500);
    expect(f.folded).toBe(false);
    expect(f.due).toBe(500 + UNFOLD_MS);
    f.toggle(900);
    expect(f.folded).toBe(true);
    expect(f.due).toBeNull();
  });

  it("ne se réduit pas sous les doigts du joueur : chaque geste relance le délai, et il attend tant qu'on s'en sert", () => {
    const f = new PlayerFold();
    f.setMode("auto");
    f.unfold(0);
    // Le joueur touche « suivant » peu avant l'échéance : le délai repart
    f.touch(UNFOLD_MS - 100);
    expect(f.tick(UNFOLD_MS, false)).toBe(false);
    expect(f.due).toBe(2 * UNFOLD_MS - 100);
    // À l'échéance, la souris dessus (ou le focus dedans, ou un écran de chargement) : il attend encore
    expect(f.tick(2 * UNFOLD_MS, true)).toBe(false);
    expect(f.folded).toBe(false);
    expect(f.due).toBe(3 * UNFOLD_MS);
    expect(f.tick(3 * UNFOLD_MS, false)).toBe(true);
    // Réduit, un geste ne le déplie pas (seule la note le fait)
    f.touch(4 * UNFOLD_MS);
    expect(f.folded).toBe(true);
  });

  it("changer de réglage : déplié d'emblée, ou réduit d'emblée", () => {
    const f = new PlayerFold();
    f.setMode("auto");
    f.unfold(0);
    f.setMode("always");
    expect(f.folded).toBe(false);
    expect(f.due).toBeNull();
    f.setMode("hidden");
    expect(f.folded).toBe(false);
    f.setMode("auto");
    expect(f.folded).toBe(true);
    // Le même réglage ne change rien
    f.unfold(0);
    f.setMode("auto");
    expect(f.folded).toBe(false);
  });

  it("caché : seul un changement que le joueur a demandé s'annonce", () => {
    for (const mode of ["always", "auto"] as const) {
      expect(announces(mode, true, false)).toBe(true);
      expect(announces(mode, true, true)).toBe(true);
      expect(announces(mode, false, false)).toBe(false);
    }
    expect(announces("hidden", true, false)).toBe(false);
    expect(announces("hidden", true, true)).toBe(true);
    expect(announces("hidden", false, false)).toBe(false);
  });
});
