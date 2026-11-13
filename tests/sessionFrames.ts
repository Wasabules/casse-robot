import { readFileSync } from "node:fs";
import { beforeAll, expect } from "vitest";
import { loadSimModule, type SimModule } from "../src/shared/native/simModule";
import { NativeSession } from "../src/shared/native/session";
import { decodeFrame } from "../src/shared/net/protocol";
import { readSnapshot } from "../src/shared/net/snapshot";
import { LocalSession, type SessionCommand, type SessionLike } from "../src/shared/net/session";
import { newInput, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics } from "../src/shared/sim/simulation";
import { STEP } from "../src/shared/config";
import { simWasmPath } from "./probe";

/*
 * Comparer les images de deux sessions (tests/nativeSession.test.ts) : `LocalSession` (la simulation
 * du TypeScript) et `NativeSession` (la simulation portée en Rust), mêmes commandes, même graine.
 */

export const WASM = simWasmPath();

export let module: SimModule;

beforeAll(async () => {
  await initPhysics();
  if (WASM) module = await loadSimModule(readFileSync(WASM));
});

/** Une horloge qui ne compte rien (les images ne dépendent pas du temps de calcul). */
const clock = (): number => 0;

/** Les commandes d'une partie : son début, puis `seconds` s d'images, avec les commandes du joueur. */
export function script(start: Extract<SessionCommand, { t: "start" }>, seconds: number, drive: (t: number, input: PlayerInput) => void): SessionCommand[] {
  const cmds: SessionCommand[] = [start];
  const input = newInput();
  // (des images de 2,5 pas : une sur deux en avance deux pas, l'autre trois)
  const frame = 2.5 * STEP;
  for (let t = 0; t < seconds; t += frame) {
    drive(t, input);
    cmds.push({ t: "input", input: { ...input }, aim: null });
    cmds.push({ t: "advance", dt: frame });
  }
  return cmds;
}

function play(session: SessionLike, cmds: readonly SessionCommand[]): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (const c of cmds) frames.push(...session.handle(c));
  session.dispose();
  return frames;
}

/** La première différence entre deux suites d'images, dite lisiblement ; null s'il n'y en a pas. */
export function firstDifference(a: Uint8Array[], b: Uint8Array[]): string | null {
  if (a.length !== b.length) return `${a.length} images contre ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.length === y.length && x.every((v, k) => v === y[k])) continue;
    const fa = decodeFrame(x);
    const fb = decodeFrame(y);
    const ha = JSON.stringify(fa.header);
    const hb = JSON.stringify(fb.header);
    if (ha !== hb) {
      const ea = fa.header.events;
      const eb = fb.header.events;
      for (let k = 0; k < Math.max(ea.length, eb.length); k++) {
        const sa = JSON.stringify(ea[k]);
        const sb = JSON.stringify(eb[k]);
        if (sa !== sb) return `image ${i}, événement ${k} :\n  TS   ${sa?.slice(0, 600)}\n  Rust ${sb?.slice(0, 600)}`;
      }
      const { events: _a, ...ra } = fa.header;
      const { events: _b, ...rb } = fb.header;
      return `image ${i}, en-tête :\n  TS   ${JSON.stringify(ra).slice(0, 600)}\n  Rust ${JSON.stringify(rb).slice(0, 600)}`;
    }
    const sa = readSnapshot(fa.snapshot);
    const sb = readSnapshot(fb.snapshot);
    const path = diff(sa, sb, "instantané");
    return `image ${i} : ${path ?? "instantanés différents (octets)"}`;
  }
  return null;
}

/** Le premier champ qui diffère entre deux valeurs lues (instantanés), avec son chemin. */
function diff(a: unknown, b: unknown, path: string): string | null {
  if (Object.is(a, b)) return null;
  if (a instanceof Map && b instanceof Map) {
    const ka = [...a.keys()];
    const kb = [...b.keys()];
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return `${path} : clés ${JSON.stringify(ka).slice(0, 300)} contre ${JSON.stringify(kb).slice(0, 300)}`;
    for (const k of ka) {
      const d = diff(a.get(k), b.get(k), `${path}[${String(k)}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path} : ${String(a)} contre ${String(b)}`;
}

export function compare(cmds: SessionCommand[], seed: number): { frames: number; bytes: number } {
  const t0 = performance.now();
  const ts = play(new LocalSession(clock), cmds);
  const t1 = performance.now();
  const rs = play(new NativeSession(module, clock, seed), cmds);
  const t2 = performance.now();
  if (process.env.SESSION_REPORT) console.log(`TypeScript ${(t1 - t0).toFixed(0)} ms, Rust ${(t2 - t1).toFixed(0)} ms, ${ts.length} images`);
  expect(firstDifference(ts, rs)).toBeNull();
  return { frames: ts.length, bytes: ts.reduce((s, f) => s + f.length, 0) };
}

