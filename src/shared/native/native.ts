import { NATIVE_WASM } from "./wasm";

/*
 * La simulation compilée (crates/casse-sim, Rust → WebAssembly : temps 4 du plan moteur), chargée
 * ici pour la page, le Worker de la partie solo, le serveur Node et les tests : le module est
 * embarqué en base64 (src/shared/native/wasm.ts, fait par `npm run native`), comme Rapier.
 *
 * Elle est portée module par module, en commençant par les feuilles ; chaque module porté a ici son
 * enveloppe, et tests/native.test.ts vérifie qu'il rend exactement ce que rend le TypeScript (au bit
 * près). Le TypeScript appelle le module compilé quand il est chargé (`initNative`, fait par
 * `initPhysics`), et garde le sien sinon.
 */

/** Ce que le module exporte (crates/casse-sim/src/ffi.rs). */
interface Exports {
  readonly memory: { readonly buffer: ArrayBuffer };
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  terrain_new(size: number, cells: number, heights: number): number;
  terrain_free(id: number): void;
  terrain_height(id: number, x: number, z: number): number;
  terrain_ray(id: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number;
  grid_new(n: number, open: number): number;
  grid_free(id: number): void;
  grid_find_path(id: number, start: number, goal: number, out: number, cap: number): number;
  grid_approach_path(id: number, start: number, goal: number, budget: number, out: number, cap: number): number;
  grid_nearest_open(id: number, cell: number, reach: number): number;
  grid_keep_largest_region(open: number, n: number): void;
  js_math_many(op: number, a: number, b: number, c: number, out: number, n: number): void;
}

/** Le peu de WebAssembly dont on se sert (le code partagé n'a pas les types du navigateur). */
interface WasmApi {
  instantiate(bytes: Uint8Array, imports: object): Promise<{ instance: { exports: object } }>;
}

let wasm: Exports | null = null;
let loading: Promise<void> | null = null;

/** Charge le module (une seule fois). */
export function initNative(): Promise<void> {
  loading ??= (async () => {
    const api = (globalThis as unknown as { WebAssembly?: WasmApi }).WebAssembly;
    if (!api) return;
    const { instance } = await api.instantiate(decodeBase64(NATIVE_WASM), {});
    wasm = instance.exports as unknown as Exports;
  })();
  return loading;
}

/** Le module est-il chargé ? */
export function nativeReady(): boolean {
  return wasm !== null;
}

function exportsOf(): Exports {
  if (!wasm) throw new Error("simulation compilée non chargée (initNative)");
  return wasm;
}

/**
 * Un tableau copié dans la mémoire du module le temps d'un appel. Les vues de la mémoire se refont
 * après chaque appel : si le module grandit sa mémoire, les anciennes ne voient plus rien.
 */
function withBytes<T>(bytes: Uint8Array, use: (ptr: number) => T): T {
  const w = exportsOf();
  const ptr = w.alloc(bytes.byteLength);
  try {
    new Uint8Array(w.memory.buffer, ptr, bytes.byteLength).set(bytes);
    return use(ptr);
  } finally {
    w.dealloc(ptr, bytes.byteLength);
  }
}

/** Un relief (crates/casse-sim/src/terrain.rs), copié dans le module. */
export class NativeTerrain {
  private id: number;

  constructor(size: number, cells: number, heights: Float32Array) {
    const bytes = new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength);
    this.id = withBytes(bytes, (ptr) => exportsOf().terrain_new(size, cells, ptr));
  }

  height(x: number, z: number): number {
    return exportsOf().terrain_height(this.id, x, z);
  }

  /** La distance où le rayon entre dans le relief, ou null (comme `rayTerrain`). */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number | null {
    const d = exportsOf().terrain_ray(this.id, ox, oy, oz, dx, dy, dz, maxDist);
    return d < 0 ? null : d;
  }

  free(): void {
    if (this.id) exportsOf().terrain_free(this.id);
    this.id = 0;
  }
}

/** Une grille de passage (crates/casse-sim/src/navgrid.rs), copiée dans le module. */
export class NativeGrid {
  private id: number;
  private readonly cells: number;

  constructor(n: number, open: Uint8Array) {
    this.cells = n * n;
    this.id = withBytes(open, (ptr) => exportsOf().grid_new(n, ptr));
  }

  /** Un chemin écrit par le module dans un tampon d'autant de cases que la grille. */
  private path(run: (out: number, cap: number) => number): number[] | null {
    const w = exportsOf();
    const len = this.cells * 4;
    const out = w.alloc(len);
    try {
      const n = run(out, this.cells);
      return n < 0 ? null : Array.from(new Int32Array(w.memory.buffer, out, n));
    } finally {
      w.dealloc(out, len);
    }
  }

  findPath(start: number, goal: number): number[] | null {
    return this.path((out, cap) => exportsOf().grid_find_path(this.id, start, goal, out, cap));
  }

  approachPath(start: number, goal: number, budget: number): number[] {
    return this.path((out, cap) => exportsOf().grid_approach_path(this.id, start, goal, budget, out, cap)) ?? [start];
  }

  nearestOpenCell(cell: number, reach: number): number {
    return exportsOf().grid_nearest_open(this.id, cell, reach);
  }

  free(): void {
    if (this.id) exportsOf().grid_free(this.id);
    this.id = 0;
  }
}

/** Ne garde ouverte que la plus grande région de la grille (`keepLargestRegion`), sur place. */
export function nativeKeepLargestRegion(open: Uint8Array, n: number): void {
  const w = exportsOf();
  const ptr = w.alloc(open.byteLength);
  try {
    new Uint8Array(w.memory.buffer, ptr, open.byteLength).set(open);
    w.grid_keep_largest_region(ptr, n);
    open.set(new Uint8Array(w.memory.buffer, ptr, open.byteLength));
  } finally {
    w.dealloc(ptr, open.byteLength);
  }
}

/**
 * Les fonctions de `Math` que calcule le module (crates/casse-sim/src/jsmath.rs), dans l'ordre de
 * leurs numéros : celles dont la simulation se sert, que les modules portés emploient à la place de
 * celles de Rust quand elles diffèrent de V8.
 */
export const MATH_OPS = [
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "exp", "log", "pow", "sqrt", "hypot2", "hypot3",
  "round", "sign", "max", "min", "floor", "ceil", "dsin", "dcos", "dlog", "dpow",
] as const;
export type MathOp = (typeof MATH_OPS)[number];

/** Une fonction de `Math` calculée par le module sur `n` valeurs (les tests de parité). */
export function nativeMath(op: MathOp, a: Float64Array, b: Float64Array, c: Float64Array): Float64Array {
  const w = exportsOf();
  const n = a.length;
  const bytes = n * 8;
  const ptrs = [w.alloc(bytes), w.alloc(bytes), w.alloc(bytes), w.alloc(bytes)];
  try {
    [a, b, c].forEach((values, i) => new Float64Array(w.memory.buffer, ptrs[i], n).set(values));
    w.js_math_many(MATH_OPS.indexOf(op), ptrs[0], ptrs[1], ptrs[2], ptrs[3], n);
    return new Float64Array(w.memory.buffer, ptrs[3], n).slice();
  } finally {
    for (const ptr of ptrs) w.dealloc(ptr, bytes);
  }
}

/** Base64 → octets (le code partagé n'a pas `atob` dans ses types). */
function decodeBase64(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const value = new Uint8Array(128);
  for (let i = 0; i < alphabet.length; i++) value[alphabet.charCodeAt(i)] = i;
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = value[clean.charCodeAt(i)];
    const b = value[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? value[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < clean.length ? value[clean.charCodeAt(i + 3)] : 0;
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (bits >> 16) & 255;
    if (o < out.length) out[o++] = (bits >> 8) & 255;
    if (o < out.length) out[o++] = bits & 255;
  }
  return out;
}
