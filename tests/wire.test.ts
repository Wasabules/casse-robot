import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateRawSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { ProgressBook } from "../src/server/progressBook";
import { Room, type Connection, type Player } from "../src/server/room";
import { qmul, type Quat, type Vec3 } from "../src/shared/math/vec";
import { utf8Decode, utf8Encode } from "../src/shared/net/binary";
import { decodeFrame, encodeFrame, PROTOCOL_VERSION, SNAPSHOT_EVERY, type FrameHeader } from "../src/shared/net/protocol";
import { Replica } from "../src/shared/net/replica";
import { readSnapshot, type Snapshot } from "../src/shared/net/snapshot";
import { expand, quantize, roundHeader, WireDecoder, WireEncoder, WireError } from "../src/shared/net/wire";
import { newInput } from "../src/shared/sim/player";
import { initPhysics } from "../src/shared/sim/simulation";
import { seedRandom } from "./seed";

/*
 * Le fil du multijoueur (src/shared/net/wire.ts) : les images d'une vraie salle, quantifiées, en écarts
 * à la précédente, puis décodées, doivent redonner les instantanés de la salle, exacts là où ils le sont
 * (identifiants, états, flottants bruts), à l'erreur de quantification près ailleurs (positions,
 * rotations, vitesses). Une image tronquée ou corrompue lève `WireError`, sans boucler.
 * `WIRE_REPORT=1` : les débits par joueur d'une bataille à douze robots, par une vraie WebSocket
 * (avant, compression seule, quantification, delta, tout), le travail du serveur, l'erreur de la réplique.
 */

beforeAll(async () => {
  await initPhysics();
});

/** Les images qu'envoie une salle à un joueur qui pilote (un char qui tire en tournant), puis à un second qui arrive. */
function playRoom(seconds: number, late = seconds / 2): { first: Uint8Array[]; second: Uint8Array[] } {
  seedRandom(23);
  const room = new Room(new ProgressBook());
  const first: Uint8Array[] = [];
  const second: Uint8Array[] = [];
  const join = (out: Uint8Array[], name: string, preset: string): Player => {
    const p = room.connect({ send: (d) => void (typeof d !== "string" && out.push(d)) });
    room.receive(p, JSON.stringify({ t: "join", version: PROTOCOL_VERSION, name, robot: { preset }, token: `jeton-du-fil-${name.toLowerCase()}-0000` }));
    return p;
  };
  const pilot = join(first, "Un", "tank");
  for (let i = 0; i < seconds * 60; i++) {
    const t = i / 60;
    if (i === late * 60) join(second, "Deux", "buggy");
    room.receive(pilot, JSON.stringify({ t: "input", input: { ...newInput(), throttle: 1, steer: Math.sin(t / 2), trigger: t > 1, aim: { x: 0, y: 1, z: 25 } } }));
    room.tick();
  }
  room.dispose();
  return { first, second };
}

const angleBetween = (a: Quat, b: Quat): number => {
  const d = qmul({ x: -a.x, y: -a.y, z: -a.z, w: a.w }, b);
  return 2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w));
};
const gap = (a: Vec3, b: Vec3): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));

/** Les écarts au plus entre deux instantanés (le même monde), et ce qui doit être exact l'est. */
function compare(exact: Snapshot, wired: Snapshot): Record<string, number> {
  const worst: Record<string, number> = {};
  const note = (name: string, value: number): void => void (worst[name] = Math.max(worst[name] ?? 0, value));
  expect(wired.time).toBe(exact.time);
  expect(wired.match).toEqual(exact.match);
  expect(wired.detected).toEqual(exact.detected);
  for (const key of ["bots", "parts", "wheels", "debris", "props", "projectiles"] as const) expect([...wired[key].keys()]).toEqual([...exact[key].keys()]);
  for (const [id, s] of exact.bots) {
    const w = wired.bots.get(id)!;
    note("lastPos", gap(s.lastPos, w.lastPos));
    for (const [block, t] of s.turrets) {
      const u = w.turrets.get(block)!;
      note("angle", Math.max(Math.abs(t.yaw - u.yaw), Math.abs(t.pitch - u.pitch)));
      expect({ ...u, yaw: 0, pitch: 0 }).toEqual({ ...t, yaw: 0, pitch: 0 });
    }
    expect({ ...w, lastPos: null, turrets: null }).toEqual({ ...s, lastPos: null, turrets: null });
  }
  for (const [id, s] of exact.parts) {
    const w = wired.parts.get(id)!;
    note("pos", gap(s.pos, w.pos));
    note("rot", angleBetween(s.rot, w.rot));
    note("vel", gap(s.vel, w.vel));
    note("ang", gap(s.ang, w.ang));
    note("com", gap(s.com, w.com));
    expect(w.mass).toBe(s.mass);
  }
  for (const [id, s] of exact.wheels) {
    const w = wired.wheels.get(id)!;
    expect([w.part, w.drive, w.steer, !!w.hub]).toEqual([s.part, s.drive, s.steer, !!s.hub]);
    note("wheel", gap(s.pos, w.pos));
    note("wheelRot", angleBetween(s.rot, w.rot));
    if (s.hub && w.hub) {
      note("wheel", gap(s.hub.pos, w.hub.pos));
      note("wheelRot", angleBetween(s.hub.rot, w.hub.rot));
    }
  }
  for (const [id, s] of exact.debris) {
    const w = wired.debris.get(id)!;
    note("pos", gap(s.pos, w.pos));
    note("rot", angleBetween(s.rot, w.rot));
  }
  for (const [id, s] of exact.props) {
    const w = wired.props.get(id)!;
    note("pos", gap(s.pos, w.pos));
    note("rot", angleBetween(s.rot, w.rot));
    expect([w.state, w.leak]).toEqual([s.state, s.leak]);
  }
  for (const [id, s] of exact.projectiles) {
    const w = wired.projectiles.get(id)!;
    note("pos", gap(s.pos, w.pos));
    note("vel", gap(s.vel, w.vel));
    note("age", Math.abs(s.age - w.age));
  }
  return worst;
}

/** Les bornes de la quantification (avec la marge des flottants de 32 bits de l'instantané). */
const BOUNDS: Record<string, number> = {
  pos: 0.5 / 2048 + 1e-5, lastPos: 0.5 / 2048 + 1e-5, com: 0.5e-3, wheel: 0.5e-3, rot: 1e-4, wheelRot: 2e-4, vel: 0.5 / 512 + 1e-5,
  ang: 0.5 / 1024 + 1e-5, age: 0.5 / 4096 + 1e-6, angle: 0.5 / 16384 + 1e-6,
};

describe("le fil du multijoueur", () => {
  let frames: { first: Uint8Array[]; second: Uint8Array[] };

  beforeAll(() => {
    frames = playRoom(10, 6);
  }, 300_000);

  it("redonne les instantanés d'une bataille : exacts, ou à la quantification près", () => {
    const encoder = new WireEncoder();
    const worst: Record<string, number> = {};
    for (const [list, stream, decoder] of [[frames.first, encoder.stream(), new WireDecoder()], [frames.second, encoder.stream(), new WireDecoder()]] as const) {
      list.forEach((frame, k) => {
        const wire = stream.encode(frame);
        // La première image d'un fil est complète, les suivantes en écarts
        expect(wire[0]).toBe(k === 0 ? 1 : 2);
        const { header, snapshot } = decoder.decode(wire);
        const exact = decodeFrame(frame);
        expect(header.you).toBe(exact.header.you);
        expect(header.events.map((e) => e.t)).toEqual(exact.header.events.map((e) => e.t));
        // (les événements, arrondis une fois pour tous les joueurs : comme en-tête par en-tête)
        const json = frame.subarray(4, 4 + new DataView(frame.buffer, frame.byteOffset).getUint32(0, true));
        expect(header).toEqual(JSON.parse(utf8Decode(roundHeader(json))));
        for (const [name, value] of Object.entries(compare(readSnapshot(exact.snapshot), snapshot))) worst[name] = Math.max(worst[name] ?? 0, value);
      });
    }
    for (const [name, value] of Object.entries(worst)) expect(value, name).toBeLessThanOrEqual(BOUNDS[name]);
    // On a bien vu ce qui se quantifie (des projectiles, des débris, des roues)
    expect(Object.keys(worst).sort()).toEqual(Object.keys(BOUNDS).sort());
  });

  it("en écarts, le client retrouve exactement ce qu'il trouverait d'images complètes : rien ne s'accumule", () => {
    const encoder = new WireEncoder();
    const delta = encoder.stream();
    const key = encoder.stream();
    const a = new WireDecoder();
    const b = new WireDecoder();
    for (const frame of frames.first) {
      key.restart();
      expect(a.decode(delta.encode(frame)).snapshot).toEqual(b.decode(key.encode(frame)).snapshot);
    }
    // Et la quantification ne dépend pas du chemin : celle du serveur, relue
    const last = readSnapshot(decodeFrame(frames.first.at(-1)!).snapshot);
    expect(expand(quantize(last))).toEqual(a.decode(delta.encode(frames.first.at(-1)!)).snapshot);
  });

  it("après une salle relancée (une image reset), l'image part complète, et le client la lit", () => {
    const encoder = new WireEncoder();
    const stream = encoder.stream();
    const client = new WireDecoder();
    const list = frames.first;
    for (const frame of list.slice(0, 5)) client.decode(stream.encode(frame));
    // La même image, avec reset en dernière clé de son en-tête, comme l'écrit la salle (server/room.ts)
    const { header, snapshot } = decodeFrame(list[5]);
    const reset = encodeFrame({ ...header, reset: true }, snapshot);
    const wire = stream.encode(reset);
    expect(wire[0]).toBe(1);
    const read = client.decode(wire);
    expect(read.header.reset).toBe(true);
    expect(read.snapshot).toEqual(new WireDecoder().decode(encoder.stream().encode(list[5])).snapshot);
    // Puis les écarts reprennent
    expect(stream.encode(list[6])[0]).toBe(2);
  });

  it("une valeur hors d'étendue passe en flottants bruts, sans rien perdre", () => {
    const snap = readSnapshot(decodeFrame(frames.first[40]).snapshot);
    const [partId, part] = [...snap.parts][0];
    snap.parts.set(partId, { ...part, pos: { x: 3e9, y: -0.5, z: 1 }, vel: { x: Infinity, y: 0, z: 0 } });
    const [botId, bot] = [...snap.bots][0];
    snap.bots.set(botId, { ...bot, lastPos: { x: NaN, y: 1, z: 2 } });
    const out = expand(quantize(snap));
    expect(out.parts.get(partId)).toEqual(snap.parts.get(partId));
    expect(out.bots.get(botId)!.lastPos).toEqual(snap.bots.get(botId)!.lastPos);
    // (les roues de ce morceau se donnent alors dans le monde)
    for (const [id, w] of snap.wheels) if (w.part === partId) expect(gap(out.wheels.get(id)!.pos, w.pos)).toBeLessThan(1e-3);
  });

  it("une image tronquée, corrompue ou hors de son ordre lève WireError, sans boucler", () => {
    const encoder = new WireEncoder();
    const stream = encoder.stream();
    const wires = frames.first.slice(0, 120).map((f) => stream.encode(f));
    // Un client qui suit le fil, au point de chaque image
    const points: WireDecoder[] = [];
    const client = new WireDecoder();
    for (const w of wires) {
      points.push(client.fork());
      client.decode(w);
    }
    const follow = (k: number): WireDecoder => points[k].fork();
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const start = performance.now();
    let refused = 0;
    let read = 0;
    for (let trial = 0; trial < 400; trial++) {
      const k = 1 + rand(wires.length - 1);
      const decoder = follow(k);
      const bytes = wires[k].slice();
      const kind = rand(3);
      let input: Uint8Array;
      if (kind === 0) input = bytes.subarray(0, rand(bytes.length));
      else if (kind === 1) {
        for (let n = 1 + rand(4); n > 0; n--) bytes[rand(bytes.length)] = rand(256);
        input = bytes;
      } else {
        input = new Uint8Array(rand(64)).map(() => rand(256));
      }
      try {
        decoder.decode(input);
        read++;
      } catch (e) {
        expect(e).toBeInstanceOf(WireError);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(300);
    expect(read + refused).toBe(400);
    // Une image sautée : la suivante ne suit pas la précédente
    const d = follow(10);
    expect(() => d.decode(wires[11])).toThrow(WireError);
    // Une image complète repart de zéro
    expect(() => d.decode(wires[0])).not.toThrow();
    // Des comptes immenses ne font rien allouer : refusés d'entrée
    const huge = new Uint8Array([1, 0, 2, 0x7b, 0x7d, ...new Array(8).fill(0), 0xff, 0xff, 0xff, 0xff, 0x0f]);
    expect(() => new WireDecoder().decode(huge)).toThrow(WireError);
    expect(performance.now() - start).toBeLessThan(30_000);
  });

  it("arrondit les nombres réels des événements, pas les robots qu'il décrit, ni les identifiants, ni les textes, ni le verrouillage", () => {
    const header: FrameHeader = {
      events: [
        { t: "shot", weapon: "rifle", origin: { x: -28.534372978827882, y: 1.8991517568574796, z: 0.25 }, dir: { x: 0.8625856688139072, y: -0.05, z: -0.5032867654695394 } },
        { t: "hp", block: 823, hp: 242.9473210865241, repaired: false },
      ],
      you: 736,
      lock: { turret: 12, target: 34, progress: 0.123456789 },
    };
    const desc = decodeFrame(frames.second[0]).header.events.find((e) => e.t === "bot")!;
    header.events.push(desc);
    const out = JSON.parse(utf8Decode(roundHeader(utf8Encode(JSON.stringify(header))))) as FrameHeader;
    expect(out.events[0]).toEqual({ t: "shot", weapon: "rifle", origin: { x: -28.5344, y: 1.8992, z: 0.25 }, dir: { x: 0.8626, y: -0.05, z: -0.5033 } });
    expect(out.events[1]).toEqual({ t: "hp", block: 823, hp: 242.9473, repaired: false });
    expect(out.lock).toEqual({ turret: 12, target: 34, progress: 0.123456789 });
    expect(out.events[2]).toEqual(desc);
    expect(out.you).toBe(736);
  });
});

describe.skipIf(!process.env.WIRE_REPORT)("le fil du multijoueur : mesures (WIRE_REPORT=1)", () => {
  /** Une bataille à douze robots servie par une vraie WebSocket : les octets reçus par le client (Ko/s). */
  async function served(seconds: number, transport: "raw" | "key" | "wire", deflate: boolean): Promise<{ kbs: number; frames: number; ms: number }> {
    seedRandom(31);
    const room = new Room(new ProgressBook());
    const encoder = new WireEncoder(() => performance.now());
    const http = createServer();
    const wss = new WebSocketServer({ server: http, perMessageDeflate: deflate ? { threshold: 64 } : false });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    const port = (http.address() as AddressInfo).port;
    let player: Player | null = null;
    let encodeMs = 0;
    let posted = 0;
    wss.on("connection", (socket) => {
      const stream = encoder.stream();
      const conn: Connection = {
        send: (data) => {
          if (typeof data === "string") return socket.send(data);
          const t0 = performance.now();
          if (transport === "key") stream.restart();
          const out = transport === "raw" ? data : stream.encode(data);
          encodeMs += performance.now() - t0;
          posted++;
          socket.send(out);
        },
      };
      player = room.connect(conn);
      socket.on("message", (d) => room.receive(player!, d.toString()));
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: deflate });
    let frames = 0;
    client.on("message", (_d, binary) => void (binary && frames++));
    await new Promise<void>((done) => client.on("open", () => done()));
    client.send(JSON.stringify({ t: "join", version: PROTOCOL_VERSION, name: "Mesure", robot: { preset: "tank" }, token: "jeton-de-mesure-0001" }));
    // (il a rejoint quand la salle a traité son message : avant, elle ne lui envoie rien)
    const joined = (): Player | null => player;
    while (!joined()?.profile) await new Promise((r) => setTimeout(r, 5));
    const pilot = joined()!;
    const sent = seconds * 60;
    const socket = (client as unknown as { _socket: { bytesRead: number } })._socket;
    const before = socket.bytesRead;
    for (let i = 0; i < sent; i++) {
      const t = i / 60;
      room.receive(pilot, JSON.stringify({ t: "input", input: { ...newInput(), throttle: 1, steer: Math.sin(t / 3), trigger: t > 2, aim: { x: 0, y: 1, z: 25 } } }));
      room.tick();
      if ((i + 1) % SNAPSHOT_EVERY === 0) await new Promise((r) => setImmediate(r));
    }
    while (frames < posted) await new Promise((r) => setTimeout(r, 5));
    const bytes = socket.bytesRead - before;
    client.close();
    wss.close();
    http.close();
    room.dispose();
    return { kbs: bytes / seconds / 1024, frames, ms: encodeMs / frames };
  }

  it("débits par joueur, travail du serveur, erreur de la réplique", { timeout: 1_800_000 }, async () => {
    const seconds = 60;
    const rows: string[] = [];
    for (const [name, transport, deflate] of [
      ["avant (instantané brut)", "raw", false], ["compression seule (permessage-deflate)", "raw", true], ["quantification (images complètes)", "key", false],
      ["quantification + delta", "wire", false], ["quantification + delta + compression", "wire", true],
    ] as const) {
      const r = await served(seconds, transport, deflate);
      rows.push(`${name} : ${r.kbs.toFixed(1)} Ko/s (${r.frames} images ; fil ${r.ms.toFixed(3)} ms par image)`);
    }
    // Le travail du serveur par image (une salle, un joueur) et la compression (zlib, comme la WebSocket, mesurée à part)
    const { first } = playRoom(30, 30);
    const encoder = new WireEncoder(() => performance.now());
    const stream = encoder.stream();
    const wires = first.map((f) => stream.encode(f));
    let zip = 0;
    let history = Buffer.alloc(0);
    const t0 = performance.now();
    for (const w of wires) {
      zip += deflateRawSync(w, history.length ? { dictionary: history } : {}).length;
      history = Buffer.concat([history, w]).subarray(-32768);
    }
    const zipMs = (performance.now() - t0) / wires.length;
    const s = encoder.stats;
    rows.push(`serveur, par image : quantifier ${(s.quantizeMs / s.frames).toFixed(3)} ms, écrire ${(s.writeMs / s.frames).toFixed(3)} ms (une fois pour tous), en-tête ${(s.headerMs / wires.length).toFixed(3)} ms par joueur, compression ~${zipMs.toFixed(3)} ms par joueur (${(zip / wires.length).toFixed(0)} o)`);
    rows.push(`sections après delta (o/image) : ${["globales", "robots", "morceaux", "roues", "débris", "accessoires", "projectiles"].map((n, k) => `${n} ${(s.sections[k] / s.frames).toFixed(0)}`).join(", ")}`);
    // L'erreur que voit la réplique : la même partie rejouée d'après les images brutes et d'après le fil
    const exact = new Replica();
    const wired = new Replica();
    const decoder = new WireDecoder();
    let pos = 0;
    let rot = 0;
    first.forEach((f, k) => {
      exact.receive(f);
      wired.receiveFrame(decoder.decode(wires[k]));
      exact.flush();
      wired.flush();
      for (const bot of exact.bots) {
        const twin = wired.bots.find((b) => b.id === bot.id)!;
        for (const part of bot.parts) {
          const t = [...twin.parts].find((p) => p.id === part.id)!;
          pos = Math.max(pos, gap(part.rb.translation(), t.rb.translation()));
          rot = Math.max(rot, angleBetween(part.rb.rotation(), t.rb.rotation()));
        }
        for (const w of bot.wheels) {
          const t = twin.wheels.find((x) => x.id === w.id)!;
          pos = Math.max(pos, gap(w.rb.translation(), t.rb.translation()));
          rot = Math.max(rot, angleBetween(w.rb.rotation(), t.rb.rotation()));
        }
      }
    });
    rows.push(`réplique : écart au plus ${(pos * 1000).toFixed(3)} mm par axe, ${((rot * 180) / Math.PI).toFixed(4)}° (morceaux et roues, ${first.length} images)`);
    console.log(rows.join("\n"));
  });
});

// (encodeFrame : les images de la salle, avant le fil)
void encodeFrame;
