import { beforeAll, describe, expect, it } from "vitest";
import { ARENAS } from "../src/shared/arena/layout";
import { approachPathTs, findPathTs, keepLargestRegionTs, nearestOpenCellTs, navGrid, type NavGrid } from "../src/shared/arena/navgrid";
import { rayTerrain, terrainHeight, type Terrain } from "../src/shared/arena/terrain";
import { initNative, MATH_OPS, nativeMath, NativeGrid, nativeKeepLargestRegion, NativeTerrain, type MathOp } from "../src/shared/native/native";
import { NATIVE_SOURCE } from "../src/shared/native/wasm";
import { dcos, dlog, dpow, dsin } from "../src/shared/math/det";
import { sourceHash } from "../tools/native/source.mjs";

/*
 * La simulation compilée (crates/casse-sim, temps 4) rend exactement ce que rend le TypeScript, au
 * bit près, module par module : mêmes entrées tirées au hasard (un hasard fixe, d'ici), et les vraies
 * données des arènes. Et le module embarqué (src/shared/native/wasm.ts) est bien construit sur les
 * sources du dépôt (sinon : npm run native).
 */

/** Un hasard fixe (LCG), pour des entrées qui se rejouent. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

beforeAll(async () => {
  await initNative();
});

describe("Simulation compilée", () => {
  it("le module embarqué est construit sur les sources du dépôt (npm run native)", () => {
    expect(NATIVE_SOURCE).toBe(sourceHash(process.cwd()));
  });

  it("relief : la hauteur et les rayons, au bit près", () => {
    const r = lcg(7);
    for (let k = 0; k < 6; k++) {
      const cells = 4 + Math.floor(r() * 60);
      const size = 10 + r() * 300;
      const n = cells + 1;
      const heights = new Float32Array(n * n).map(() => (r() - 0.3) * 40);
      const t: Terrain = { size, cells, heights };
      const native = new NativeTerrain(size, cells, heights);
      for (let i = 0; i < 2000; i++) {
        // (des points dehors aussi : la hauteur du bord)
        const x = (r() - 0.5) * size * 1.3;
        const z = (r() - 0.5) * size * 1.3;
        expect(Object.is(native.height(x, z), terrainHeight(t, x, z))).toBe(true);
      }
      for (let i = 0; i < 300; i++) {
        const o = { x: (r() - 0.5) * size, y: 5 + r() * 40, z: (r() - 0.5) * size };
        const a = r() * Math.PI * 2;
        const down = -0.05 - r() * 0.9;
        const flat = Math.sqrt(1 - down * down);
        const d = { x: Math.cos(a) * flat, y: down, z: Math.sin(a) * flat };
        const max = 5 + r() * 200;
        expect(native.ray(o.x, o.y, o.z, d.x, d.y, d.z, max)).toBe(rayTerrain(t, o, d, max));
      }
      native.free();
    }
  });

  it("grille de passage : A*, approche, case ouverte la plus proche, plus grande région, au bit près", () => {
    const r = lcg(11);
    // Des grilles au hasard (des murs, des trous), et les vraies grilles des arènes qui en ont
    const grids: NavGrid[] = [];
    for (let k = 0; k < 8; k++) {
      const n = 12 + Math.floor(r() * 50);
      const open = new Uint8Array(n * n).map(() => (r() < 0.28 ? 0 : 1));
      grids.push({ cell: 1, n, min: 0, open });
    }
    for (const arena of Object.values(ARENAS)) {
      const grid = navGrid(arena);
      if (grid) grids.push(grid);
    }
    expect(grids.length).toBeGreaterThan(8);
    for (const grid of grids) {
      const native = new NativeGrid(grid.n, grid.open);
      const cells = grid.n * grid.n;
      for (let i = 0; i < 60; i++) {
        const start = Math.floor(r() * cells);
        const goal = Math.floor(r() * cells);
        expect(native.findPath(start, goal)).toEqual(findPathTs(grid, start, goal));
        const budget = 20 + Math.floor(r() * 2000);
        expect(native.approachPath(start, goal, budget)).toEqual(approachPathTs(grid, start, goal, budget));
        expect(native.nearestOpenCell(start, 40)).toBe(nearestOpenCellTs(grid, start, 40));
      }
      native.free();
      // La plus grande région, sur une copie des cases avant tri
      const raw = new Uint8Array(grid.n * grid.n).map(() => (r() < 0.45 ? 0 : 1));
      const a = raw.slice();
      const b = raw.slice();
      keepLargestRegionTs(a, grid.n);
      nativeKeepLargestRegion(b, grid.n);
      expect(b).toEqual(a);
    }
  });

  it("les fonctions de Math : celles du module rendent celles de V8, et les fonctions déterministes celles du TypeScript, au bit près", () => {
    const r = lcg(23);
    const N = 200_000;
    // Des valeurs de toutes les tailles : petites, autour de l'unité, grandes, négatives, quelques cas limites
    const pick = (): number => {
      const k = r();
      if (k < 0.02) return [0, -0, 0.5, -0.5, 1.5, -2.5, 1e-300, Infinity, -Infinity, Math.PI / 2][Math.floor(r() * 10)];
      const scale = 10 ** (Math.floor(r() * 16) - 8);
      return (r() - 0.5) * 2 * scale;
    };
    const JS: Record<MathOp, (a: number, b: number, c: number) => number> = {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
      atan2: Math.atan2, exp: Math.exp, log: Math.log, pow: (a, b) => a ** b, sqrt: Math.sqrt,
      hypot2: (a, b) => Math.hypot(a, b), hypot3: (a, b, c) => Math.hypot(a, b, c), round: Math.round,
      sign: Math.sign, max: (a, b) => Math.max(a, b), min: (a, b) => Math.min(a, b), floor: Math.floor, ceil: Math.ceil,
      dsin, dcos, dlog, dpow,
    };
    // (sin, cos, log et pow de Rust ne rendent pas ceux de V8 au dernier bit, sur une valeur sur deux
    // cents à une sur cent : la simulation emploie dsin, dcos, dlog et dpow, src/shared/math/det.ts)
    const DIFFER: readonly MathOp[] = ["sin", "cos", "log", "pow"];
    const report: string[] = [];
    for (const op of MATH_OPS.filter((o) => !DIFFER.includes(o))) {
      const a = new Float64Array(N).map(pick);
      const b = new Float64Array(N).map(pick);
      const c = new Float64Array(N).map(pick);
      // (une puissance : aussi les exposants entiers de la simulation, x ** 2, x ** 3, x ** 0,5)
      if (op === "dpow") for (let i = 0; i < N; i += 2) b[i] = [2, 3, 0.5, 4, 1.5, -1, 0, 1][(i / 2) % 8];
      const native = nativeMath(op, a, b, c);
      let wrong = 0;
      let example = "";
      for (let i = 0; i < N; i++) {
        const js = JS[op](a[i], b[i], c[i]);
        if (!Object.is(native[i], js)) {
          if (!wrong) example = `${op}(${a[i]}, ${b[i]}, ${c[i]}) : ${native[i]} contre ${js}`;
          wrong++;
        }
      }
      if (wrong) report.push(`${op} : ${wrong} sur ${N} (${example})`);
    }
    expect(report).toEqual([]);
  });
});
