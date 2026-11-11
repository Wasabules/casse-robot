import { describe, expect, it } from "vitest";
import { NOISE_SIZE, noiseTexture, PUFF_CELL, PUFF_FRAMES, puffAtlas, seeded } from "../src/client/render/fx/fxNoise";

/*
 * Les textures des effets réalistes (render/fx/fxNoise.ts) : calculées au démarrage, sans Babylon.
 */
describe("Textures de la fumée et des flammes", () => {
  const atlas = puffAtlas();
  const side = PUFF_CELL * 2;
  const px = (x: number, y: number): [number, number, number, number] => {
    const o = (y * side + x) * 4;
    return [atlas[o], atlas[o + 1], atlas[o + 2], atlas[o + 3]];
  };

  it("le générateur à graine donne toujours les mêmes nombres, dans [0, 1[", () => {
    const a = seeded(3);
    const b = seeded(3);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("l'atlas a quatre volutes, les mêmes à chaque chargement", () => {
    expect(PUFF_FRAMES).toBe(4);
    expect(atlas.length).toBe(side * side * 4);
    expect(puffAtlas()).toEqual(atlas);
  });

  it("chaque volute est dense au cœur et nulle au bord de sa case (pas de bavure d'une case sur l'autre)", () => {
    for (let frame = 0; frame < PUFF_FRAMES; frame++) {
      const ox = (frame % 2) * PUFF_CELL;
      const oy = Math.floor(frame / 2) * PUFF_CELL;
      let edge = 0;
      for (let k = 0; k < PUFF_CELL; k++) {
        edge = Math.max(edge, px(ox + k, oy)[3], px(ox + k, oy + PUFF_CELL - 1)[3], px(ox, oy + k)[3], px(ox + PUFF_CELL - 1, oy + k)[3]);
      }
      expect(edge).toBeLessThan(4);
      const [r, g, , a] = px(ox + PUFF_CELL / 2, oy + PUFF_CELL / 2);
      expect(a).toBeGreaterThan(150);
      // Au cœur, la surface fait face à la caméra : une normale presque droite
      expect(Math.abs(r - 128)).toBeLessThan(90);
      expect(Math.abs(g - 128)).toBeLessThan(90);
    }
  });

  it("les volutes ne se ressemblent pas", () => {
    const frame = (f: number): number[] => {
      const out: number[] = [];
      for (let y = 0; y < PUFF_CELL; y += 8) for (let x = 0; x < PUFF_CELL; x += 8) out.push(px((f % 2) * PUFF_CELL + x, Math.floor(f / 2) * PUFF_CELL + y)[3]);
      return out;
    };
    const frames = [0, 1, 2, 3].map(frame);
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const diff = frames[i].reduce((s, v, k) => s + Math.abs(v - frames[j][k]), 0) / frames[i].length;
        expect(diff).toBeGreaterThan(8);
      }
    }
  });

  it("le bruit est pavable et contrasté, sur ses trois canaux", () => {
    const noise = noiseTexture();
    const n = NOISE_SIZE;
    expect(noise.length).toBe(n * n * 4);
    for (let c = 0; c < 3; c++) {
      let min = 255;
      let max = 0;
      let seam = 0;
      let inside = 0;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const v = noise[(y * n + x) * 4 + c];
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
        // Le raccord (dernière colonne contre la première) ne se voit pas plus qu'entre deux colonnes voisines
        seam += Math.abs(noise[(y * n + n - 1) * 4 + c] - noise[(y * n) * 4 + c]);
        inside += Math.abs(noise[(y * n + n / 2) * 4 + c] - noise[(y * n + n / 2 - 1) * 4 + c]);
      }
      expect(min).toBeLessThan(70);
      expect(max).toBeGreaterThan(185);
      expect(seam).toBeLessThan(inside * 2.5 + n);
    }
  });
});
