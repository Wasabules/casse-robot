import { describe, expect, it } from "vitest";
import { COMBAT_CUES, cueAllowed, soundScene, STINGER_DUCK, type SoundScreen } from "../src/client/audio/soundScene";

describe("ce qui sonne selon l'écran", () => {
  const SCREENS: SoundScreen[] = ["playing", "paused", "over", "menu", "garage", "loading"];

  it("au garage et pendant le chargement d'une partie, le monde se tait tout à fait : ses boucles sont libérées", () => {
    for (const screen of ["garage", "loading"] as const) {
      const scene = soundScene(screen);
      expect(scene.live, screen).toBe(false);
      expect(scene.world, screen).toBe(0);
      expect(scene.ambience, screen).toBe(0);
    }
    // Partout ailleurs, le monde est là (même en pause : ses boucles se taisent sans être perdues)
    for (const screen of SCREENS.filter((s) => s !== "garage" && s !== "loading")) expect(soundScene(screen).live, screen).toBe(true);
  });

  it("en partie tout s'entend ; en pause, le monde figé se tait (en réseau, la partie continue, de loin)", () => {
    expect(soundScene("playing")).toEqual({ world: 1, ambience: 1, live: true, cues: true });
    expect(soundScene("paused").world).toBe(0);
    expect(soundScene("paused").ambience).toBeGreaterThan(0);
    expect(soundScene("paused", true).world).toBeGreaterThan(0);
    expect(soundScene("paused", true).world).toBeLessThan(1);
  });

  it("derrière la fin de partie et les menus, la bataille continue plus bas ; le motif de fin la baisse encore", () => {
    for (const screen of ["over", "menu"] as const) {
      const s = soundScene(screen);
      expect(s.world, screen).toBeGreaterThan(0);
      expect(s.world, screen).toBeLessThan(0.5);
    }
    expect(STINGER_DUCK.level).toBeLessThan(1);
    expect(STINGER_DUCK.seconds).toBeGreaterThan(1);
  });

  it("hors partie, les signaux de combat se taisent ; ceux des menus et du garage passent toujours", () => {
    for (const screen of SCREENS) {
      const scene = soundScene(screen);
      for (const kind of ["hit", "hurt", "tick", "start", "critical", "missile", "lock", "respawn"] as const) {
        expect(COMBAT_CUES.has(kind)).toBe(true);
        expect(cueAllowed(kind, scene), `${kind} (${screen})`).toBe(screen === "playing");
      }
      for (const kind of ["click", "hover", "back", "credits", "save", "place", "unlock"] as const) {
        expect(cueAllowed(kind, scene), `${kind} (${screen})`).toBe(true);
      }
    }
  });
});
