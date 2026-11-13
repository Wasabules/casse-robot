import { describe, expect, it } from "vitest";
import { PRESET_BOTS, BATTLE_ROSTER } from "../src/shared/design/presets";
import { PROTOCOL_VERSION } from "../src/shared/net/protocol";
import type { SessionCommand } from "../src/shared/net/session";
import { newInput } from "../src/shared/sim/player";
import { NativeRoom } from "../src/server/nativeRoom";
import { ProgressBook } from "../src/server/progressBook";
import { Room, type Player, type RoomBase } from "../src/server/room";
import { compare, firstDifference, module, script, WASM } from "./sessionFrames";
import { seedRandom } from "./seed";

/*
 * La session de la simulation portée en Rust (src/shared/native/session.ts) contre `LocalSession` :
 * les mêmes commandes, avec la même graine, doivent donner les mêmes images, octet pour octet
 * (l'en-tête JSON : les événements, la description du monde, le robot du joueur, son verrou ; et
 * l'instantané binaire). Sautée sans la simulation compilée entière (`npm run native`, ou la sonde).
 * `SESSION_REPORT=1` : le temps des deux sessions.
 */

describe.skipIf(!WASM)("La simulation portée derrière le contrat de la session solo : les mêmes images, octet pour octet", () => {
  it("une bataille pilotée au Dépôt : tirs, coups, destructions, réapparitions", { timeout: 300_000 }, () => {
    const pilot = PRESET_BOTS.find((p) => p.id === "tank")!;
    const cmds = script({ t: "start", mode: "battle", arena: "depot", pilot, roster: null, seed: 11 }, 24, (t, input) => {
      input.throttle = t < 3 ? 1 : 0.5;
      input.steer = t > 2 && t < 4 ? 0.6 : 0;
      input.trigger = t > 4;
      input.aim = { x: 0, y: 1, z: 20 };
    });
    // (et le joueur se saborde : il réapparaît)
    cmds.splice(400, 0, { t: "selfDestruct" });
    const { frames } = compare(cmds, 11);
    expect(frames).toBeGreaterThan(500);
  });

  it("la caméra libre : douze robots imposés, des tirs, la pause de l'IA, une vague, un impact de la console", { timeout: 300_000 }, () => {
    const cmds = script({ t: "start", mode: "arena", arena: "depot", pilot: null, roster: BATTLE_ROSTER, seed: 3 }, 16, () => {});
    const at = (k: number, ...more: SessionCommand[]): void => void cmds.splice(k, 0, ...more);
    const up = { x: 0, y: 1, z: 0 };
    at(500, { t: "spawn", profiles: PRESET_BOTS.slice(0, 6) });
    at(300, { t: "pause", ai: true }, { t: "damage", point: { x: 0, y: 0.5, z: 0 }, dir: up, weapon: "cannon", shooter: { x: 0, y: 5, z: -10 } });
    at(260, { t: "pause", ai: false });
    for (let k = 20; k < 240; k += 10) {
      at(k,
        { t: "fire", weapon: "rifle", origin: { x: -10, y: 3, z: -30 }, dir: { x: 0.2, y: -0.05, z: 0.97 }, free: false, homing: null },
        { t: "fire", weapon: "lockon", origin: { x: 10, y: 3, z: -30 }, dir: { x: 0, y: 0.2, z: 0.98 }, free: true, homing: { from: { x: 0, y: 10, z: -30 }, dir: { x: 0, y: -0.2, z: 0.98 }, airOnly: false } },
      );
    }
    compare(cmds, 3);
  });

  it("la capture de zones et le roi de la colline (la colline se déplace), puis une autre arène", { timeout: 300_000 }, () => {
    const pilot = PRESET_BOTS.find((p) => p.id === "buggy")!;
    const capture = script({ t: "start", mode: "capture", arena: "fort", pilot, roster: null, seed: 5 }, 14, (t, input) => {
      input.throttle = 1;
      input.relative = true;
      input.heading = t;
    });
    const hill = script({ t: "start", mode: "hill", arena: "trenches", pilot, roster: null, seed: 6 }, 42, () => {});
    compare([...capture, ...hill], 5);
  });

  it("l'élimination dans la Vallée, et l'essai du garage (sans combat)", { timeout: 300_000 }, () => {
    const pilot = PRESET_BOTS.find((p) => p.id === "plane")!;
    const valley = script({ t: "start", mode: "elimination", arena: "valley", pilot, roster: null, seed: 8 }, 8, (t, input) => {
      input.power = 0.8;
      input.climb = t < 2 ? 0.5 : 0;
    });
    const trial = script({ t: "start", mode: "trial", arena: "yard", pilot: PRESET_BOTS[0], roster: null, seed: 9 }, 4, (_, input) => {
      input.throttle = 1;
    });
    compare([...valley, ...trial], 8);
  });
});

/** Une salle du serveur, un joueur qui la rejoint et pilote, puis un autre qui arrive ; ce qu'ils reçoivent. */
function playRoom(room: RoomBase<unknown>, seconds: number): (Uint8Array | string)[] {
  const out: (Uint8Array | string)[] = [];
  const conn = { send: (data: string | Uint8Array): void => void out.push(data) };
  const join = (name: string, preset: string, token: string): Player<unknown> => {
    const player = room.connect(conn);
    room.receive(player, JSON.stringify({ t: "join", version: PROTOCOL_VERSION, name, robot: { preset }, token }));
    return player;
  };
  const first = join("Un", "tank", "jeton-de-parite-0001");
  const steps = seconds * 60;
  for (let i = 0; i < steps; i++) {
    const t = i / 60;
    room.receive(first, JSON.stringify({ t: "input", input: { ...newInput(), throttle: 1, steer: t > 3 ? 0.5 : 0, trigger: t > 2, aim: { x: 0, y: 1, z: 25 } } }));
    if (i === steps / 2) join("Deux", "buggy", "jeton-de-parite-0002");
    if (i === steps - 120) room.receive(first, JSON.stringify({ t: "selfDestruct" }));
    room.tick();
  }
  room.dispose();
  return out;
}

describe.skipIf(!WASM)("La simulation portée derrière le contrat du serveur : les mêmes images, octet pour octet", () => {
  it("une salle : un joueur qui pilote, un autre qui arrive en pleine partie, un sabordage", { timeout: 300_000 }, () => {
    seedRandom(17);
    const t0 = performance.now();
    const ts = playRoom(new Room(new ProgressBook()), 12);
    const t1 = performance.now();
    const rs = playRoom(new NativeRoom(module, new ProgressBook(), {}, 17), 12);
    const t2 = performance.now();
    if (process.env.SESSION_REPORT) console.log(`salle : TypeScript ${((t1 - t0) / 720).toFixed(2)} ms par pas, Rust ${((t2 - t1) / 720).toFixed(2)} ms par pas (images comprises)`);
    const texts = (list: (Uint8Array | string)[]): string[] => list.filter((x): x is string => typeof x === "string");
    const frames = (list: (Uint8Array | string)[]): Uint8Array[] => list.filter((x): x is Uint8Array => typeof x !== "string");
    expect(texts(rs)).toEqual(texts(ts));
    expect(frames(ts).length).toBeGreaterThan(200);
    expect(firstDifference(frames(ts), frames(rs))).toBeNull();
  });
});
