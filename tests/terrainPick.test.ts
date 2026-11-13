import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as B from "../src/client/babylon";
import { pickTerrain } from "../src/client/render/terrainPick";
import { makeTerrain, noise2, type Terrain } from "../src/shared/arena/terrain";
import { norm, vec3, type Vec3 } from "../src/shared/math/vec";

/**
 * Le maillage du relief tel que le dessine render/arenaView.ts (`terrain`) : un sommet par point du
 * champ (positions en flottants de 32 bits), chaque case coupée le long de sa diagonale
 * (ix+1, iz) – (ix, iz+1), découpé en morceaux comme l'était celui du jeu.
 */
function terrainMesh(scene: B.Scene, t: Terrain): B.Mesh {
  const n = t.cells + 1;
  const step = t.size / t.cells;
  const positions = new Float32Array(n * n * 3);
  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) positions.set([-t.size / 2 + ix * step, t.heights[ix * n + iz], -t.size / 2 + iz * step], (ix * n + iz) * 3);
  }
  const indices: number[] = [];
  for (let ix = 0; ix < t.cells; ix++) {
    for (let iz = 0; iz < t.cells; iz++) {
      const a = ix * n + iz, b = (ix + 1) * n + iz, c = ix * n + iz + 1, d = (ix + 1) * n + iz + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const data = new B.VertexData();
  data.positions = positions;
  data.indices = indices;
  const mesh = new B.Mesh("terrain", scene);
  data.applyToMesh(mesh);
  mesh.subdivide(16);
  return mesh;
}

/** Hasard fixe (une suite de congruences) : les mêmes rayons à chaque fois. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe("viser le relief sans la scène (render/terrainPick.ts)", () => {
  let engine: NullEngine;
  let scene: B.Scene;
  beforeAll(() => {
    engine = new NullEngine();
    scene = new B.Scene(engine);
    scene.useRightHandedSystem = true;
  });
  afterAll(() => {
    scene.dispose();
    engine.dispose();
  });

  // Un relief bosselé (collines, falaises), à pas entier et à pas qui ne tombe pas juste en flottants
  const reliefs: [string, Terrain][] = [
    ["collines, pas de 2 m", makeTerrain(128, 64, (x, z) => 6 * noise2(x / 18, z / 18) + 2 * noise2(x / 5, z / 5))],
    ["falaises, pas de 1,375 m", makeTerrain(110, 80, (x, z) => (noise2(x / 9, z / 9) > 0.2 ? 14 : 0) + 3 * noise2(x / 4, z / 4))],
  ];

  for (const [name, t] of reliefs) {
    it(`touche le même point que le lancer de rayon de Babylon sur son maillage : ${name}`, () => {
      const mesh = terrainMesh(scene, t);
      const rand = lcg(42);
      let hits = 0;
      for (let i = 0; i < 1500; i++) {
        // De haut, de biais, au ras du sol, parfois de l'extérieur du carré ou vers le ciel
        const origin = vec3((rand() - 0.5) * t.size * 1.3, 2 + rand() * 40, (rand() - 0.5) * t.size * 1.3);
        const dir: Vec3 = norm(vec3(rand() - 0.5, -rand() * (i % 3 === 0 ? 0.1 : 1) + (i % 17 === 0 ? 0.3 : 0), rand() - 0.5));
        const length = 20 + rand() * 200;
        const ray = new B.Ray(new B.Vector3(origin.x, origin.y, origin.z), new B.Vector3(dir.x, dir.y, dir.z), length);
        const babylon = scene.pickWithRay(ray, (m) => m === mesh);
        const expected = babylon?.hit ? babylon.distance : null;
        const got = pickTerrain(t, origin, dir, length);
        if (expected === null) expect(got, `rayon ${i}`).toBeNull();
        else {
          hits++;
          expect(got, `rayon ${i}`).not.toBeNull();
          expect(Math.abs(got! - expected), `rayon ${i}`).toBeLessThan(1e-6);
        }
      }
      // (assez de rayons qui touchent pour que la comparaison dise quelque chose)
      expect(hits).toBeGreaterThan(400);
      mesh.dispose();
    });
  }

  it("un rayon qui part sous le relief le touche en ressortant (des deux côtés, comme Babylon)", () => {
    const t = makeTerrain(64, 32, () => 5);
    const got = pickTerrain(t, vec3(0, 1, 0), vec3(0, 1, 0), 10);
    expect(got).toBeCloseTo(4, 9);
  });
});
