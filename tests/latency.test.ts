import { beforeAll, describe, expect, it } from "vitest";
import { ProgressBook } from "../src/server/progressBook";
import { Room, type Player } from "../src/server/room";
import { STEP } from "../src/shared/config";
import { qrot, vec3, type Vec3 } from "../src/shared/math/vec";
import { DelayTuner, InputPacer } from "../src/shared/net/pacing";
import { INPUT_RATE, INTERP_DELAY, PROTOCOL_VERSION, SNAPSHOT_EVERY } from "../src/shared/net/protocol";
import { Replica } from "../src/shared/net/replica";
import { WireDecoder, WireEncoder } from "../src/shared/net/wire";
import type { Bot } from "../src/shared/sim/entities";
import { newInput, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics } from "../src/shared/sim/simulation";
import { seedRandom } from "./seed";

/*
 * Ce que ressent le joueur en ligne : le temps entre une commande (il appuie sur une touche) et le moment
 * où son robot bouge à l'écran. Un banc en temps simulé : la salle du serveur (l'IA en pause), une
 * liaison qui retarde les messages (l'aller-retour, la gigue ; dans l'ordre, comme TCP), et un client qui
 * fait ce que fait le jeu à chaque image (client/game.ts, client/net/netClient.ts : le fil, la réplique
 * qui avance, le retard d'affichage réglé, les commandes qui partent). Le retard réglé et l'envoi des
 * touches (src/shared/net/pacing.ts) doivent raccourcir ce temps sans à-coups. `LATENCY_REPORT=1` : le
 * tableau, pour plusieurs allers-retours et plusieurs réglages (et ce que donneraient 30 images par
 * seconde, ou le robot du joueur extrapolé).
 */

beforeAll(async () => {
  await initPhysics();
});

/** Une liaison dans un sens : les messages arrivent dans l'ordre, chacun après son retard. */
class Link<T> {
  private readonly queue: { at: number; data: T }[] = [];
  private last = 0;
  private readonly delay: () => number;

  constructor(delay: () => number) {
    this.delay = delay;
  }

  send(now: number, data: T): void {
    this.last = Math.max(this.last, now + this.delay());
    this.queue.push({ at: this.last, data });
  }

  take(now: number): T[] {
    const out: T[] = [];
    while (this.queue.length && this.queue[0].at <= now) out.push(this.queue.shift()!.data);
    return out;
  }
}

interface Setup {
  /** Aller-retour (s) et gigue (s, au plus, sur chaque sens). */
  rtt: number;
  jitter: number;
  /** Commandes envoyées à `INPUT_RATE` par seconde (`rate`), ou aussi dès qu'une touche change (`keys` : `InputPacer`). */
  inputs: "rate" | "keys";
  /** Retard d'affichage réglé d'après l'arrivée des images (`DelayTuner`), sinon INTERP_DELAY. */
  tuned: boolean;
  /** Une image tous les `every` pas. */
  every: number;
  /** Vitesse du serveur : 1 s'il tient le temps réel, moins s'il décroche (une machine trop chargée). */
  speed?: number;
}

interface Sample {
  t: number;
  pos: Vec3;
  heading: number;
}

/**
 * Ce qu'un essai a vu : le robot du joueur affiché par le client, et sur le serveur ; les retards
 * d'affichage ; et le robot du joueur tel que le montrerait une extrapolation (`led` : un essai, pas le
 * jeu) : sa dernière pose reçue avancée de sa vitesse jusqu'au présent estimé (l'instant affiché plus
 * le retard d'affichage), l'écart d'une image à l'autre résorbé en `LEAD_SMOOTHING` s.
 */
interface Trace {
  shown: Sample[];
  server: Sample[];
  delays: number[];
  /** Images du client où la réplique n'avait pas l'image suivante (elle s'arrête sur la dernière : un à-coup). */
  starved: number;
  led: Sample[];
  /** Quand le serveur a reçu (et applique au pas qui suit) la première commande de chaque changement : gaz, braquage. */
  applied: { throttle: number; steer: number };
  /** À chaque image du client, l'âge de ce qu'il montre (s) : l'instant présent moins le temps affiché ; de même pour l'extrapolation. */
  lags: number[];
  ledLags: number[];
}

/** Durée (s) sur laquelle l'extrapolation résorbe l'écart quand une nouvelle image la corrige. */
const LEAD_SMOOTHING = 0.1;

const headingOf = (bot: Bot): number => {
  const f = qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
  return Math.atan2(f.x, f.z);
};

/** Un essai : le robot du joueur piloté par `drive(t)` (le temps du client), `seconds` s. */
function trial(setup: Setup, drive: (t: number, input: PlayerInput) => void, seconds: number, seed: number): Trace {
  seedRandom(seed);
  const room = new Room(new ProgressBook());
  room.sim.aiPaused = true;
  let noise = seed * 7919;
  const jitter = (): number => {
    noise = (noise * 1103515245 + 12345) % 2147483648;
    return (noise / 2147483648) * setup.jitter;
  };
  const down = new Link<Uint8Array | string>(() => setup.rtt / 2 + jitter());
  const up = new Link<string>(() => setup.rtt / 2 + jitter());
  const encoder = new WireEncoder();
  const stream = encoder.stream();
  let now = 0;
  const player: Player = room.connect({ send: (d) => down.send(now, typeof d === "string" ? d : stream.encode(d)) });
  room.receive(player, JSON.stringify({ t: "join", version: PROTOCOL_VERSION, name: "Banc", robot: { preset: "buggy" }, token: "jeton-du-banc-00001" }));
  const replica = new Replica();
  const decoder = new WireDecoder();
  const tuner = new DelayTuner();
  const input = newInput();
  const trace: Trace = { shown: [], server: [], delays: [], led: [], starved: 0, applied: { throttle: NaN, steer: NaN }, lags: [], ledLags: [] };
  let newest: { time: number; pos: Vec3; vel: Vec3; heading: number; spin: number } | null = null;
  let fresh = false;
  let offset = { x: 0, z: 0, heading: 0 };
  let last: Sample | null = null;
  const frame = 1 / 120;
  const internals = room as unknown as { steps: number; broadcast(): void };
  let step = 0;
  let nextFrame = 0;
  let inputTimer = 0;
  const pacer = new InputPacer();
  while (now < seconds) {
    const nextStep = ((step + 1) * STEP) / (setup.speed ?? 1);
    if (nextStep <= nextFrame) {
      now = nextStep;
      for (const text of up.take(now)) {
        room.receive(player, text);
        const sent = (JSON.parse(text) as { input: PlayerInput }).input;
        if (sent.throttle && Number.isNaN(trace.applied.throttle)) trace.applied.throttle = now;
        if (sent.steer && Number.isNaN(trace.applied.steer)) trace.applied.steer = now;
      }
      // La salle envoie une image tous les `every` pas (au lieu de SNAPSHOT_EVERY)
      internals.steps = 1;
      room.tick();
      step++;
      if (step % setup.every === 0) internals.broadcast();
      const bot = player.bot;
      if (bot) trace.server.push({ t: now, pos: bot.cockpit.part.rb.translation(), heading: headingOf(bot) });
    } else {
      now = nextFrame;
      nextFrame += frame;
      for (const data of down.take(now)) {
        if (typeof data === "string") continue;
        const message = decoder.decode(data);
        tuner.arrive(now, message.snapshot.time);
        replica.receiveFrame(message);
        const part = replica.player ? message.snapshot.parts.get(replica.player.cockpit.part.id) : undefined;
        if (part) {
          const f = qrot(part.rot, vec3(0, 0, 1));
          newest = { time: message.snapshot.time, pos: part.pos, vel: part.vel, heading: Math.atan2(f.x, f.z), spin: part.ang.y };
          fresh = true;
        }
      }
      replica.delay = setup.tuned ? tuner.delay : INTERP_DELAY;
      replica.rate = setup.tuned ? tuner.rate : 1;
      trace.delays.push(replica.delay);
      // Comme le jeu : les commandes de l'image, la réplique avance, les commandes partent à leur cadence
      drive(now, input);
      replica.advance(frame);
      if (now > 1 && (replica as unknown as { queue: unknown[] }).queue.length === 0) trace.starved++;
      // (l'âge, en temps du client : le temps du serveur à cet instant, moins le temps affiché, au rythme du serveur)
      if (now > 2) trace.lags.push((step * STEP - replica.time) / (setup.speed ?? 1));
      inputTimer -= frame;
      const due = setup.inputs === "keys" ? pacer.due(frame, input) : inputTimer <= 0;
      if (due) {
        up.send(now, JSON.stringify({ t: "input", input }));
        inputTimer = 1 / INPUT_RATE;
      }
      const shown = replica.player;
      if (shown?.cockpit.alive) trace.shown.push({ t: now, pos: shown.cockpit.part.rb.translation(), heading: headingOf(shown) });
      const clock = (replica as unknown as { clock: number | null }).clock;
      if (newest && clock !== null) {
        const ahead = clock + replica.delay - newest.time;
        if (now > 2) trace.ledLags.push((step * STEP - (clock + replica.delay)) / (setup.speed ?? 1));
        const n = newest;
        const at = (k: number): { x: number; z: number; heading: number } => ({ x: n.pos.x + n.vel.x * k, z: n.pos.z + n.vel.z * k, heading: n.heading + n.spin * k });
        const raw = at(ahead);
        // Une nouvelle image : on part de ce qu'on montrait (à l'image précédente), et l'écart se résorbe
        if (fresh && last) {
          const prev = at(ahead - frame);
          offset = { x: last.pos.x - prev.x, z: last.pos.z - prev.z, heading: Math.atan2(Math.sin(last.heading - prev.heading), Math.cos(last.heading - prev.heading)) };
        }
        fresh = false;
        const keep = Math.exp(-frame / LEAD_SMOOTHING);
        offset = { x: offset.x * keep, z: offset.z * keep, heading: offset.heading * keep };
        last = { t: now, pos: vec3(raw.x + offset.x, newest.pos.y, raw.z + offset.z), heading: raw.heading + offset.heading };
        trace.led.push(last);
      }
    }
  }
  room.dispose();
  return trace;
}

/** Le premier instant après `from` où le robot s'est écarté de plus de `by` m de sa place d'alors (ou de `turn` rad de son cap). */
function moved(samples: readonly Sample[], from: number, by: { m?: number; rad?: number }): number {
  const start = samples.find((s) => s.t >= from);
  if (!start) return NaN;
  for (const s of samples) {
    if (s.t < from) continue;
    const d = Math.hypot(s.pos.x - start.pos.x, s.pos.z - start.pos.z);
    const turn = Math.abs(Math.atan2(Math.sin(s.heading - start.heading), Math.cos(s.heading - start.heading)));
    if ((by.m !== undefined && d > by.m) || (by.rad !== undefined && turn > by.rad)) return s.t;
  }
  return NaN;
}

/**
 * Ce que l'affichage montre qui n'a jamais été : pour chaque image, la distance (à plat) de la pose
 * montrée au trajet du serveur (sa pose la plus proche dans la seconde autour) ; au plus, et au 95e
 * centile. Et les retours en arrière : les images où le robot montré recule de plus d'un centimètre
 * alors que celui du serveur avance (par rapport au sens de sa vitesse).
 */
function fidelity(shown: readonly Sample[], server: readonly Sample[]): { max: number; p95: number; back: number } {
  const gaps: number[] = [];
  let back = 0;
  let j = 0;
  shown.forEach((s, k) => {
    while (j < server.length && server[j].t < s.t - 1) j++;
    let best = Infinity;
    for (let i = j; i < server.length && server[i].t <= s.t + 1; i++) best = Math.min(best, Math.hypot(s.pos.x - server[i].pos.x, s.pos.z - server[i].pos.z));
    if (Number.isFinite(best)) gaps.push(best);
    const prev = shown[k - 1];
    const here = server.find((x) => x.t >= s.t);
    const before = here && server[server.indexOf(here) - 6];
    if (prev && here && before) {
      const dir = { x: here.pos.x - before.pos.x, z: here.pos.z - before.pos.z };
      const speed = Math.hypot(dir.x, dir.z);
      if (speed > 0.05 && ((s.pos.x - prev.pos.x) * dir.x + (s.pos.z - prev.pos.z) * dir.z) / speed < -0.01) back++;
    }
  });
  gaps.sort((a, b) => a - b);
  return { max: gaps.at(-1) ?? 0, p95: gaps[Math.floor(gaps.length * 0.95)] ?? 0, back };
}

/**
 * Le scénario : à l'arrêt, puis plein gaz à `press` (le démarrage), un braquage à `press + 2` (le
 * virage), puis marche arrière à `press + 4` (le robot lancé s'arrête et repart : là où une
 * extrapolation dépasse).
 */
function scenario(press: number) {
  return (t: number, input: PlayerInput): void => {
    input.throttle = t >= press + 4 ? -1 : t >= press ? 1 : 0;
    input.steer = t >= press + 2 && t < press + 4 ? 1 : 0;
  };
}

interface Felt {
  /** De la touche au serveur (s) : la commande attend son envoi, puis traverse le réseau (le gaz et le braquage, en moyenne). */
  input: number;
  /** L'âge de ce que montre l'écran (s) : l'image qui revient du serveur, puis le retard d'affichage. */
  lag: number;
  /** Retard d'affichage moyen (s), et part des images du client sans image suivante pour interpoler (un à-coup). */
  delay: number;
  starved: number;
  /** De la touche au robot qui démarre (10 cm), à l'écran et sur le serveur (s). */
  start: number;
  serverStart: number;
  /** Ce que montrerait l'extrapolation : son âge, son démarrage. */
  ledLag: number;
  ledStart: number;
  /** Ce que chacune montre qui n'a jamais été (m, au plus et 95e centile ; retours en arrière). */
  shown: { max: number; p95: number; back: number };
  led: { max: number; p95: number; back: number };
}

/** Ce qui se voit : le robot, à l'arrêt, a avancé de 10 cm. */
const START = { m: 0.1 };

const mean = (list: readonly number[]): number => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);

/** Ce que ressent le joueur : de sa commande au serveur, puis à l'écran ; et la fidélité de ce qu'il voit. */
function latency(setup: Setup, runs: number): Felt {
  const out: Felt = { input: 0, lag: 0, delay: 0, starved: 0, start: 0, serverStart: 0, ledLag: 0, ledStart: 0, shown: { max: 0, p95: 0, back: 0 }, led: { max: 0, p95: 0, back: 0 } };
  for (let k = 0; k < runs; k++) {
    // (la commande tombe à un autre moment des images et des pas d'un essai à l'autre)
    const press = 3 + k * 0.0137;
    const trace = trial(setup, scenario(press), press + 6, 40 + k);
    out.input += ((trace.applied.throttle - press + trace.applied.steer - (press + 2)) / 2) / runs;
    out.lag += mean(trace.lags) / runs;
    out.delay += mean(trace.delays.slice(-200)) / runs;
    out.starved += trace.starved / trace.delays.length / runs;
    out.start += (moved(trace.shown, press, START) - press) / runs;
    out.serverStart += (moved(trace.server, press, START) - press) / runs;
    out.ledLag += mean(trace.ledLags) / runs;
    out.ledStart += (moved(trace.led, press, START) - press) / runs;
    for (const [key, list] of [["shown", trace.shown], ["led", trace.led]] as const) {
      const f = fidelity(list, trace.server);
      out[key].max = Math.max(out[key].max, f.max);
      out[key].p95 += f.p95 / runs;
      out[key].back += f.back;
    }
  }
  return out;
}

const BEFORE: Setup = { rtt: 0.1, jitter: 0.01, inputs: "rate", tuned: false, every: SNAPSHOT_EVERY };
/** Ce que fait le client : le retard réglé, les touches envoyées dès qu'elles changent. */
const AFTER: Setup = { ...BEFORE, tuned: true, inputs: "keys" };

describe("le retard d'affichage en réseau", () => {
  it("se règle d'après la gigue des images : un intervalle et la gigue, monte d'un coup, redescend doucement", () => {
    const tuner = new DelayTuner();
    expect(tuner.delay).toBe(INTERP_DELAY);
    // Des images régulières (20 par seconde), 2 ms de gigue : un peu plus d'un intervalle
    for (let k = 0; k < 400; k++) tuner.arrive(10 + k * 0.05 + 0.04 + (k % 3) * 0.001, k * 0.05);
    expect(tuner.delay).toBeGreaterThan(0.05);
    expect(tuner.delay).toBeLessThan(0.07);
    // Une image en retard de 80 ms : il monte tout de suite
    tuner.arrive(10 + 400 * 0.05 + 0.04 + 0.08, 400 * 0.05);
    expect(tuner.delay).toBeGreaterThan(0.14);
    // Puis redescend, une fois l'à-coup sorti de la fenêtre
    for (let k = 401; k < 600; k++) tuner.arrive(10 + k * 0.05 + 0.04, k * 0.05);
    expect(tuner.delay).toBeLessThan(0.07);
    // Des valeurs absurdes ne le dérèglent pas
    tuner.arrive(NaN, 1);
    tuner.arrive(5, Infinity);
    expect(Number.isFinite(tuner.delay)).toBe(true);
    // Un serveur qui ne simule que 70 % du temps réel : ce n'est pas de la gigue (le retard ne monte pas
    // au plafond), la réplique avancera à sa vitesse
    const slow = new DelayTuner();
    for (let k = 0; k < 200; k++) slow.arrive(10 + k * 0.05 + (k % 3) * 0.001, k * 0.035);
    expect(slow.rate).toBeCloseTo(0.7, 2);
    expect(slow.delay).toBeLessThan(0.06);
  });

  it("les commandes : une touche qui change part à l'image même, la visée à INPUT_RATE, un manche qui bouge pas plus de 60 fois par seconde", () => {
    const pacer = new InputPacer();
    const input = newInput();
    const frame = 1 / 144;
    let sent = 0;
    const run = (seconds: number, change: (k: number) => void): number => {
      const before = sent;
      for (let k = 0; k < Math.round(seconds / frame); k++) {
        change(k);
        if (pacer.due(frame, input)) sent++;
      }
      return sent - before;
    };
    // La visée seule bouge à chaque image : INPUT_RATE envois par seconde
    const aimed = run(1, (k) => void (input.aim = { x: k, y: 0, z: 0 }));
    expect(aimed).toBeGreaterThanOrEqual(INPUT_RATE - 1);
    expect(aimed).toBeLessThanOrEqual(INPUT_RATE + 1);
    // Une touche : à l'image même, ou à la suivante qui laisse 1/60 s depuis le dernier envoi (bien avant le prochain envoi régulier)
    const fresh = new InputPacer();
    expect(fresh.due(frame, input)).toBe(true);
    const pressed = { ...input, throttle: -1 };
    expect([fresh.due(frame, pressed), fresh.due(frame, pressed), fresh.due(frame, pressed)]).toEqual([false, false, true]);
    expect(fresh.due(frame, pressed)).toBe(false);
    input.throttle = 1;
    // Un manche analogique qui bouge à chaque image : au plus ~60 envois par seconde
    const stick = run(1, (k) => void (input.steer = Math.sin(k / 10)));
    expect(stick).toBeGreaterThan(INPUT_RATE);
    expect(stick).toBeLessThanOrEqual(61);
  });

  it("raccourcit le temps entre une commande et son effet à l'écran", { timeout: 300_000 }, () => {
    const before = latency(BEFORE, 1);
    const after = latency(AFTER, 1);
    expect(after.delay).toBeLessThan(before.delay - 0.02);
    // (la touche part à l'image même, plus au prochain envoi : ~12 ms de moins en moyenne, selon le moment de l'appui)
    expect(after.input).toBeLessThan(before.input - 0.004);
    expect(after.lag).toBeLessThan(before.lag - 0.02);
    expect(after.start).toBeLessThan(before.start - 0.03);
    // Sans à-coups : la réplique a presque toujours l'image suivante
    expect(after.starved).toBeLessThan(0.02);
    // Le serveur démarre le robot plus tôt d'autant que la commande arrive plus tôt, pas davantage
    expect(before.serverStart - after.serverStart).toBeLessThan(before.input - after.input + 0.02);
  });
});

describe.skipIf(!process.env.LATENCY_REPORT)("le retard ressenti en ligne : mesures (LATENCY_REPORT=1)", () => {
  it("de la commande à l'écran, selon l'aller-retour et les réglages", { timeout: 3_600_000 }, () => {
    const runs = Number(process.env.LATENCY_RUNS) || 4;
    const rows: string[] = [];
    const ms = (s: number): string => (s * 1000).toFixed(0).padStart(4);
    const cm = (m: number): string => (m * 100).toFixed(1).padStart(5);
    for (const [rtt, jitter] of [[0.05, 0.01], [0.1, 0.01], [0.2, 0.01], [0.1, 0.04]] as const) {
      for (const [name, setup] of [
        ["avant (100 ms, 30 commandes/s, 20 images/s)", { ...BEFORE, rtt, jitter }],
        ["touches envoyées dès qu'elles changent", { ...BEFORE, rtt, jitter, inputs: "keys" }],
        ["retard réglé", { ...BEFORE, rtt, jitter, tuned: true }],
        ["retard réglé, touches (le client)", { ...AFTER, rtt, jitter }],
        ["le client, et 30 images/s", { ...AFTER, rtt, jitter, every: 2 }],
      ] as const) {
        const r = latency(setup, runs);
        rows.push(`aller-retour ${ms(rtt)} ± ${ms(jitter)} ms | ${name.padEnd(42)} | touche → serveur ${ms(r.input)} ms, âge de l'écran ${ms(r.lag)} ms (retard d'affichage ${ms(r.delay)}, à-coups ${(r.starved * 100).toFixed(1)} %) | démarrage à l'écran ${ms(r.start)} ms (serveur ${ms(r.serverStart)}) | hors trajet ${cm(r.shown.max)} cm, reculs ${r.shown.back}`);
        if (name.startsWith("retard réglé, touches")) rows.push(`${"".padEnd(28)} | ${"  … extrapolé (essai)".padEnd(42)} | âge de l'écran ${ms(r.ledLag)} ms | démarrage à l'écran ${ms(r.ledStart)} ms | hors trajet ${cm(r.led.max)} cm (95 % : ${cm(r.led.p95)}), reculs ${r.led.back}`);
      }
    }
    // Un serveur qui décroche (70 % du temps réel) : le retard réglé suit sa vitesse, sans à-coups
    for (const [name, setup] of [
      ["serveur à 70 % : avant", { ...BEFORE, speed: 0.7 }],
      ["serveur à 70 % : le client", { ...AFTER, speed: 0.7 }],
    ] as const) {
      const r = latency(setup, runs);
      rows.push(`aller-retour  100 ±   10 ms | ${name.padEnd(42)} | touche → serveur ${ms(r.input)} ms, âge de l'écran ${ms(r.lag)} ms (retard d'affichage ${ms(r.delay)}, à-coups ${(r.starved * 100).toFixed(1)} %) | démarrage à l'écran ${ms(r.start)} ms (serveur ${ms(r.serverStart)}) | hors trajet ${cm(r.shown.max)} cm, reculs ${r.shown.back}`);
    }
    console.log(rows.join("\n"));
  });
});
