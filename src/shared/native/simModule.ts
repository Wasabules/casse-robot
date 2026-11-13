import { utf8Decode, utf8Encode } from "../net/binary";

/*
 * La simulation compilée entière (crates/casse-sim avec sa fonctionnalité `sim` : Rapier compris,
 * ~3 Mo de WebAssembly) : la simulation portée en Rust, propriétaire de son monde, que fait tourner
 * la session de la simulation portée (src/shared/native/session.ts) à la place de `Simulation`. Ce
 * module n'est pas celui que la page embarque (src/shared/native/wasm.ts, sans Rapier) : il est à
 * part (src/shared/native/casse-sim.wasm, fait par `npm run native`), et seuls le Worker de la partie
 * solo et le serveur le chargent, quand on choisit la simulation Rust (`?sim=rust`, `SIM=rust`). Le
 * code partagé n'a ni `fetch` ni `fs` : qui le fait tourner donne ses octets (`loadSimModule`).
 */

/** Ce que le module exporte, dont la session se sert (crates/casse-sim/src/ffi.rs, sim/mod.rs, sim/hooks.rs). */
export interface SimExports {
  readonly memory: { readonly buffer: ArrayBuffer };
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  sim_new(): number;
  sim_free(id: number): void;
  sim_error(out: number, cap: number): number;
  sim_seed(id: number, seed: number): void;
  sim_out(): number;
  sim_log_events(id: number, on: number): void;
  sim_take_events(id: number): number;
  sim_add_profile(id: number, speed: number, turn: number, mobility: number, charges: number, design: number, len: number): number;
  sim_arena_reset(id: number): void;
  sim_add_box(id: number, kind: number, len: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, qx: number, qy: number, qz: number, qw: number, round: number): void;
  sim_set_deck(id: number, i: number, underpass: number, approach: number): void;
  sim_set_terrain(id: number, size: number, cells: number, heights: number, n: number): void;
  sim_set_bounds(id: number, half: number, roam: number, circuit: number): void;
  sim_set_floors(id: number, air: number, hover: number): void;
  sim_set_spawns(id: number, line: number, spread: number, placed: number, rx: number, rz: number, rf: number, rs: number, bx: number, bz: number, bf: number, bs: number): void;
  sim_set_water(id: number, level: number): void;
  sim_set_deep_water(id: number, depth: number): void;
  sim_add_lava_pool(id: number, x: number, z: number, r: number): void;
  sim_add_lava_flow(id: number, width: number, points: number, n: number): void;
  sim_set_urban(id: number, on: number): void;
  sim_set_nav_grid(id: number, cell: number, n: number, min: number, open: number): void;
  sim_set_nav_graph(id: number, points: number, n: number, links: number, m: number): void;
  sim_add_spot(id: number, kind: number, len: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, hx: number, hy: number, hz: number, scale: number): number;
  sim_spot_rest(id: number, spot: number, on: number): void;
  sim_prop_building(id: number, prop: number, building: number): void;
  sim_add_zone(id: number, x: number, y: number, z: number, radius: number): void;
  sim_arena_changed(id: number): number;
  sim_combat(id: number, on: number): void;
  sim_spawn_teams(id: number, entries: number, n: number): number;
  sim_spawn_wave(id: number, profiles: number, n: number): number;
  sim_start_match(id: number, score: number, limit: number, respawn: number, capture: number, time: number, rate: number, hill: number): void;
  sim_end_match(id: number): void;
  sim_take_control(id: number, bot: number, slot: number): void;
  sim_release_control(id: number, bot: number): void;
  sim_set_player(id: number, bot: number): void;
  sim_player(id: number): number;
  sim_bot_id(id: number, bot: number): number;
  sim_set_input(
    id: number, slot: number, throttle: number, steer: number, climb: number, brake: number, yaw: number, power: number, heading: number, flags: number,
    weapon: number, len: number, ax: number, ay: number, az: number, lx: number, ly: number, lz: number,
  ): void;
  sim_player_aim(id: number, x: number, y: number, z: number): void;
  sim_pause(id: number, on: number): void;
  sim_self_destruct(id: number, bot: number): void;
  sim_replace_bot(id: number, old: number, profile: number, team: number, slot: number): number;
  sim_fire_free(
    id: number, name: number, len: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    homing: number, fx: number, fy: number, fz: number, hx: number, hy: number, hz: number, air: number,
  ): number;
  sim_apply_damage(id: number, name: number, len: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number, sx: number, sy: number, sz: number): number;
  sim_advance(id: number, n: number): number;
  sim_stage(id: number, k: number): void;
  sim_stage_count(): number;
  sim_snapshot(id: number): number;
  sim_describe_world(id: number): number;
  sim_describe_bot(id: number, bot: number): number;
  sim_lock(id: number, bot: number, out: number): number;
  sim_match_state(id: number, out: number): void;
  sim_roster(id: number): number;
  sim_time(id: number): number;
  sim_bot_with_input(id: number, slot: number): number;
  sim_alive(id: number, bot: number): number;
  sim_rng_state(id: number): number;
  sim_draws(id: number): number;
}

/** Le peu de WebAssembly dont on se sert (le code partagé n'a pas les types du navigateur). */
interface WasmApi {
  instantiate(bytes: Uint8Array, imports: object): Promise<{ instance: { exports: object } }>;
}

/** Le module chargé, et ce qu'il faut pour lui parler : des octets copiés dans sa mémoire, ses messages. */
export class SimModule {
  readonly x: SimExports;

  constructor(x: SimExports) {
    this.x = x;
  }

  /** Un texte UTF-8 dans la mémoire du module, le temps d'un appel. */
  withText<T>(text: string, use: (ptr: number, len: number) => T): T {
    return this.withBytes(utf8Encode(text), (ptr, len) => use(ptr, len));
  }

  /** Des octets (ou des nombres) dans la mémoire du module, le temps d'un appel. */
  withBytes<T>(values: Uint8Array | Float64Array | Float32Array | Uint32Array, use: (ptr: number, len: number) => T): T {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    const size = Math.max(1, bytes.length);
    const ptr = this.x.alloc(size);
    try {
      new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
      return use(ptr, bytes.length);
    } finally {
      this.x.dealloc(ptr, size);
    }
  }

  /** Le tampon de sortie du module (`len` octets), copié. */
  out(len: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, this.x.sim_out(), len).slice();
  }

  /** `n` nombres de 8 octets que le module écrit dans un tampon. */
  numbers(n: number, write: (ptr: number) => unknown): Float64Array {
    const ptr = this.x.alloc(n * 8);
    try {
      write(ptr);
      return new Float64Array(this.x.memory.buffer, ptr, n).slice();
    } finally {
      this.x.dealloc(ptr, n * 8);
    }
  }

  /** Le dernier message d'erreur du module. */
  lastError(): string {
    const ptr = this.x.alloc(512);
    try {
      const n = this.x.sim_error(ptr, 512);
      return utf8Decode(new Uint8Array(this.x.memory.buffer, ptr, n));
    } finally {
      this.x.dealloc(ptr, 512);
    }
  }

  /** Lève l'erreur du module si `result` est négatif ; sinon le rend. */
  check(result: number, what: string): number {
    if (result < 0) throw new Error(`${what} : ${this.lastError()}`);
    return result;
  }
}

let module: Promise<SimModule> | null = null;

/** Charge la simulation compilée entière depuis ses octets (une seule fois par processus). */
export function loadSimModule(bytes: Uint8Array): Promise<SimModule> {
  module ??= (async () => {
    const api = (globalThis as unknown as { WebAssembly?: WasmApi }).WebAssembly;
    if (!api) throw new Error("pas de WebAssembly");
    const { instance } = await api.instantiate(bytes, {});
    const exports = instance.exports as unknown as SimExports;
    if (typeof exports.sim_take_events !== "function") throw new Error("ce module n'a pas la simulation entière (npm run native)");
    return new SimModule(exports);
  })();
  return module;
}

/** Le module déjà chargé (`loadSimModule`), sinon une erreur. */
export async function simModule(): Promise<SimModule> {
  if (!module) throw new Error("simulation compilée non chargée (loadSimModule)");
  return module;
}
