import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NativeRoom } from "../src/server/nativeRoom";
import { ProgressBook } from "../src/server/progressBook";
import { Room, type Player, type RoomOptions } from "../src/server/room";
import { CRASH_LIMIT, CRASH_WINDOW, RoomHost, type HostLog, type RoomMaker } from "../src/server/roomHost";
import { STEP } from "../src/shared/config";
import { hasPart, lockedParts, REWARDS } from "../src/shared/design/progression";
import { PRESET_BOTS } from "../src/shared/design/presets";
import type { SimulationEngine } from "../src/shared/native/choice";
import { SimCompiled } from "../src/shared/native/simModule";
import { decodeFrame, PROTOCOL_VERSION, SNAPSHOT_EVERY, type ClientMessage, type RobotChoice, type ServerMessage } from "../src/shared/net/protocol";
import { Replica } from "../src/shared/net/replica";
import { initPhysics } from "../src/shared/sim/simulation";
import { simWasmPath } from "./probe";
import { seedRandom } from "./seed";

/*
 * L'hôte de la salle du serveur (src/server/roomHost.ts) : une salle qui s'arrête sur une erreur est
 * relancée, ses joueurs reprennent dans une partie neuve, trois pannes rapprochées de la simulation Rust
 * la font passer sur celle du TypeScript, et la progression des joueurs ne perd rien. Sans réseau, comme
 * tests/network.test.ts : la panne est provoquée par la salle (`provokeFault`, l'outil d'essai de
 * SIM_FAULT), une exception de la simulation du TypeScript, ou une vraie panique du module Rust.
 */

/** Un client en mémoire : ce que le serveur lui envoie va dans sa réplique. */
interface TestClient {
  player: Player<unknown>;
  replica: Replica;
  texts: ServerMessage[];
  /** Images reçues, et celles qui disaient d'oublier le monde (`reset`). */
  frames: number;
  resets: number;
  send(msg: ClientMessage): void;
}

/** Un journal qui garde ses lignes (au lieu de la console). */
function memoryLog(): HostLog & { lines: string[] } {
  const lines: string[] = [];
  const keep = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, log: keep, warn: keep, error: keep };
}

describe("hôte de la salle", () => {
  let book: ProgressBook;
  let host: RoomHost;
  let now: number;
  let made: SimulationEngine[];
  let log: ReturnType<typeof memoryLog>;
  let tokens = 0;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(5);
    book = new ProgressBook();
    now = 0;
    made = [];
    log = memoryLog();
  });
  afterEach(() => {
    // (un hôte qui a abandonné garde la salle arrêtée, déjà jetée)
    if (host && !host.gaveUp) host.room.dispose();
  });

  /** Des salles du TypeScript, quelle que soit la simulation demandée (on note laquelle). */
  const tsRooms: RoomMaker = (engine, options) => {
    made.push(engine);
    return new Room(book, options);
  };

  const open = (engine: SimulationEngine, fault: { after: number; count: number } | null, make = tsRooms, options: RoomOptions = {}): RoomHost => {
    host = new RoomHost(make, engine, { arenas: ["depot", "fort", "trenches"], ...options }, { clock: () => now, console: log, fault });
    return host;
  };

  const connect = (name: string, robot: RobotChoice = { preset: "buggy" }, token = `jeton-hote-${++tokens}-00000000`): TestClient => {
    const replica = new Replica();
    const client: TestClient = {
      player: null!, replica, texts: [], frames: 0, resets: 0,
      send: (msg) => host.receive(client.player, JSON.stringify(msg)),
    };
    client.player = host.connect({
      send: (data) => {
        if (typeof data === "string") {
          client.texts.push(JSON.parse(data) as ServerMessage);
          return;
        }
        client.frames++;
        if (decodeFrame(data).header.reset) client.resets++;
        replica.receive(data);
      },
    });
    client.send({ t: "join", version: PROTOCOL_VERSION, name, robot, token });
    return client;
  };

  /** Avance d'un nombre entier d'images ; l'horloge de l'hôte suit le temps simulé. */
  const run = (seconds: number): void => {
    const steps = Math.ceil((seconds * 60) / SNAPSHOT_EVERY) * SNAPSHOT_EVERY;
    for (let i = 0; i < steps; i++) {
      host.tick();
      now += STEP * 1000;
    }
  };

  /** La réplique du client montre-t-elle le monde de la salle du TypeScript en place, et son robot ? */
  const expectSameWorld = (client: TestClient): void => {
    const room = host.room as Room;
    // (jusqu'à l'image suivante : la salle relancée a repris ses images à son premier pas)
    while (Math.round(room.elapsed / STEP) % SNAPSHOT_EVERY !== 0) {
      host.tick();
      now += STEP * 1000;
    }
    client.replica.flush();
    expect(client.replica.time).toBeCloseTo(room.sim.time, 6);
    expect(client.replica.bots.map((b) => b.id).sort((a, b) => a - b)).toEqual(room.sim.bots.map((b) => b.id).sort((a, b) => a - b));
    expect(client.replica.arena.id).toBe(room.sim.arena.id);
    const bot = room.sim.bots.find((b) => b.input === client.player.input);
    expect(bot, "le robot du joueur").toBeDefined();
    expect(client.replica.player?.id).toBe(bot!.id);
  };

  it("relance la salle dont le pas lève une exception : les joueurs reçoivent encore des images, dans une partie neuve", () => {
    open("ts", { after: 3, count: 1 });
    const first = host.room as Room;
    const ann = connect("Ann", { preset: "tank" });
    const bob = connect("Bob");
    run(2);
    expectSameWorld(ann);
    const before = { frames: ann.frames, team: ann.player.team, profile: ann.player.profile, input: ann.player.input };
    expect(first.sim.arena.id).toBe("depot");

    run(2);
    // La panne (après 3 s), journalisée, et une salle neuve, dans l'arène suivante de la rotation
    expect(host.restarts).toBe(1);
    expect(host.room).not.toBe(first);
    expect(host.lastCrash?.during).toBe("step");
    expect(host.lastCrash?.message).toContain("panne d'essai");
    expect(host.lastCrash?.arena).toBe("depot");
    expect(host.lastCrash?.matchTime).toBeGreaterThan(2.9);
    expect(log.lines.some((l) => l.startsWith("Salle arrêtée sur une erreur (pas ; simulation TypeScript, arène depot, mode battle"))).toBe(true);
    expect(log.lines.some((l) => l.startsWith("Salle relancée (simulation TypeScript, redémarrage n° 1) : 2 joueur(s)"))).toBe(true);
    const room = host.room as Room;
    expect(room.sim.arena.id).toBe("fort");
    expect(room.sim.match?.elapsed).toBeLessThan(1.1);

    // Les joueurs sont toujours là, avec leur nom, leur robot, leur équipe, leurs commandes
    expect(ann.frames).toBeGreaterThan(before.frames);
    expect(ann.resets).toBe(1);
    expect(bob.resets).toBe(1);
    expect(ann.player.team).toBe(before.team);
    expect(ann.player.profile).toBe(before.profile);
    expect(ann.player.input).toBe(before.input);
    expect(host.playerCount).toBe(2);
    // Pas de nouvel accueil, ni de refus : le client ne voit qu'un monde neuf
    expect(ann.texts.filter((m) => m.t === "welcome")).toHaveLength(1);
    expect(ann.texts.some((m) => m.t === "refused")).toBe(false);
    expectSameWorld(ann);
    expectSameWorld(bob);
    expect(ann.replica.resets).toBe(1);
    const tank = room.sim.bots.find((b) => b.input === ann.player.input)!;
    expect(tank.profile.id).toBe("tank");
    expect(tank.controller).toBe("player");

    // Ses commandes pilotent son nouveau robot
    ann.send({ t: "input", input: { ...ann.player.input, throttle: 1 } });
    run(1);
    expect(tank.input?.throttle).toBe(1);
    expectSameWorld(ann);
    expect(host.status()).toMatchObject({ engine: "ts", asked: "ts", restarts: 1, gaveUp: false, players: 2 });
    expect(host.describe()).toContain("1 redémarrage(s) de la salle");
  });

  it("relance aussi la salle qu'un message d'un joueur fait échouer, et oublie celui qui part", () => {
    /** Une salle dont le sabordage lève une exception (comme une panique de la simulation). */
    class Fragile extends Room {
      protected override selfDestructBot(): void {
        throw new Error("sabordage impossible");
      }
    }
    open("ts", null, (engine, options) => {
      made.push(engine);
      return made.length === 1 ? new Fragile(book, options) : new Room(book, options);
    });
    const ann = connect("Ann");
    const bob = connect("Bob");
    const idle = connect("Cid");
    run(1);
    // Un client qui part pendant la panne ne passe pas dans la salle neuve
    host.disconnect(idle.player);
    ann.send({ t: "selfDestruct" });
    expect(host.restarts).toBe(1);
    expect(host.lastCrash?.during).toBe("message");
    expect(host.lastCrash?.message).toBe("Error: sabordage impossible");
    expect(host.room.connected).toEqual([ann.player, bob.player]);
    run(1);
    expectSameWorld(ann);
    expectSameWorld(bob);
    expect(ann.resets).toBe(1);
  });

  it("passe de la simulation Rust à celle du TypeScript après trois pannes rapprochées", () => {
    open("rust", { after: 1, count: CRASH_LIMIT + 1 });
    const ann = connect("Ann");
    run(1.5);
    expect(host.restarts).toBe(1);
    expect(host.engine).toBe("rust");
    run(2.5);
    // Trois pannes de la Rust : la salle suivante est du TypeScript, pour de bon
    expect(host.restarts).toBe(CRASH_LIMIT);
    expect(made).toEqual(["rust", "rust", "rust", "ts"]);
    expect(host.engine).toBe("ts");
    expect(log.lines.some((l) => l.includes("la salle passe sur celle du TypeScript"))).toBe(true);
    expect(host.describe()).toContain("repli après 3 pannes de la simulation Rust");
    // Une panne de celle du TypeScript ne la fait pas revenir à la Rust
    run(1.5);
    expect(made).toEqual(["rust", "rust", "rust", "ts", "ts"]);
    expect(host.status()).toMatchObject({ engine: "ts", asked: "rust", restarts: CRASH_LIMIT + 1, gaveUp: false });
    expect(ann.resets).toBe(CRASH_LIMIT + 1);
    run(1);
    expectSameWorld(ann);
  });

  it("ne compte que les pannes rapprochées ; trop de pannes du TypeScript, et l'hôte abandonne", () => {
    let reason: string | null = null;
    host = new RoomHost(tsRooms, "rust", { arenas: ["depot"] }, { clock: () => now, console: log, fault: { after: 1, count: 7 }, onGiveUp: (r) => (reason = r) });
    connect("Ann");
    // Des pannes espacées de plus de dix minutes : la Rust reste
    for (let i = 0; i < CRASH_LIMIT + 1; i++) {
      run(1.2);
      now += CRASH_WINDOW * 1000;
    }
    expect(host.restarts).toBe(CRASH_LIMIT + 1);
    expect(host.engine).toBe("rust");
    expect(made.every((e) => e === "rust")).toBe(true);
    // Trois pannes rapprochées (une par seconde) : la Rust passe la main
    run(4);
    expect(host.engine).toBe("ts");
    expect(host.restarts).toBe(CRASH_LIMIT * 2 + 1);
    expect(reason).toBeNull();

    // Le TypeScript qui s'arrête trois fois de suite : l'hôte abandonne (le processus s'arrêtera)
    const failing: RoomMaker = (engine, options) => {
      made.push(engine);
      if (engine === "ts" && made.length > 1) throw new Error("Rapier ne répond plus");
      return new Room(book, options);
    };
    made = [];
    host.room.dispose();
    host = new RoomHost(failing, "ts", { arenas: ["depot"] }, { clock: () => now, console: log, fault: { after: 1, count: 1 }, onGiveUp: (r) => (reason = r) });
    connect("Ann");
    run(1.5);
    expect(made).toEqual(["ts", "ts", "ts"]);
    expect(host.gaveUp).toBe(true);
    expect(reason).toBe("3 pannes de la simulation TypeScript en 10 min");
    expect(log.lines.some((l) => l.startsWith("La salle neuve ne se crée pas (simulation TypeScript) : Rapier ne répond plus"))).toBe(true);
    // Abandonné : plus rien ne tourne (le processus s'arrête), sans nouvelle exception
    run(0.5);
    host.receive(host.room.connected[0], JSON.stringify({ t: "selfDestruct" }));
  });

  it("garde la progression des joueurs : ce qu'ils ont débloqué, leurs crédits, sans rien payer deux fois ; la partie interrompue rapporte la partie jouée", () => {
    open("ts", { after: 1, count: 1 });
    // Un robot du garage avec des pièces à débloquer, et de quoi les payer
    const sapper = PRESET_BOTS.find((p) => p.id === "sapper")!;
    const token = "jeton-hote-progression-0001";
    const ledger = book.get(token);
    ledger.credits = 10000;
    const locked = lockedParts(sapper.design, (part) => hasPart({ credits: 0, unlocked: [] }, part));
    expect(locked.length).toBeGreaterThan(0);
    let changes = 0;
    book.onChange = () => changes++;
    const ann = connect("Ann", { name: "Mon sapeur", color: "#335577", design: sapper.design }, token);
    const welcome = ann.texts.find((m) => m.t === "welcome")!;
    expect(welcome.t === "welcome" && welcome.bought?.parts.length).toBe(locked.length);
    const after = { credits: ledger.credits, unlocked: [...ledger.unlocked] };
    expect(after.credits).toBeLessThan(10000);
    expect(changes).toBe(1);

    run(2);
    expect(host.restarts).toBe(1);
    // La même progression, rien de payé de nouveau, et son robot du garage dans la partie neuve ; la
    // partie interrompue lui rapporte la partie jouée (aucune destruction en une seconde), une fois
    expect(book.get(token)).toBe(ledger);
    expect(ledger.credits).toBe(after.credits + REWARDS.played);
    expect(ledger.unlocked).toEqual(after.unlocked);
    expect(changes).toBe(2);
    const paid = ann.texts.filter((m) => m.t === "progress");
    expect(paid).toHaveLength(1);
    expect(paid[0].t === "progress" && paid[0].reward.lines).toEqual([{ kind: "played", n: 1, credits: REWARDS.played }]);
    expect(ann.texts.filter((m) => m.t === "welcome" || m.t === "refused")).toHaveLength(1);
    const bot = (host.room as Room).sim.bots.find((b) => b.input === ann.player.input)!;
    expect(bot.profile.color).toBe("#335577");
    expect(bot.profile.design.blocks).toHaveLength(sapper.design.blocks.length);
    expectSameWorld(ann);
  });

  const WASM = simWasmPath();
  it.skipIf(!WASM)("relance la salle de la simulation Rust après une vraie panique du module, sur une instance neuve", async () => {
    const compiled = await SimCompiled.compile(new Uint8Array(readFileSync(WASM!)));
    const modules = new Set<unknown>();
    const native: RoomMaker = (engine, options) => {
      made.push(engine);
      const m = compiled.instance();
      modules.add(m);
      return new NativeRoom(m, book, options, 9);
    };
    open("rust", { after: 1, count: 1 }, native);
    const ann = connect("Ann", { preset: "tank" });
    run(0.5);
    const frames = ann.frames;
    run(1.5);
    expect(host.restarts).toBe(1);
    expect(host.engine).toBe("rust");
    expect(made).toEqual(["rust", "rust"]);
    expect(modules.size).toBe(2);
    // Le message de la panique (`keep_panics`, `SimModule.explain`)
    expect(host.lastCrash?.message).toMatch(/^unreachable \(panique : panicked at crates.casse-sim.src.sim.hooks\.rs:\d+:\d+: index out of bounds/);
    expect(log.lines.some((l) => l.startsWith("Salle arrêtée sur une erreur (pas ; simulation Rust, arène depot"))).toBe(true);
    // Le joueur reçoit encore des images, d'un monde neuf où il pilote son char
    run(1);
    expect(ann.frames).toBeGreaterThan(frames + 20);
    expect(ann.resets).toBe(1);
    ann.replica.flush();
    expect(ann.replica.arena.id).toBe("fort");
    expect(ann.replica.player?.profile.id).toBe("tank");
    expect(ann.replica.bots).toHaveLength(12);
    // (le monde neuf a deux secondes ; celui d'avant en aurait trois)
    expect(ann.replica.time).toBeLessThan(2.1);
  });
});
