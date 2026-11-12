import { beforeAll, expect, it } from "vitest";
import { STEP } from "../src/shared/config";
import { BATTLE_ROSTER, PRESET_BOTS } from "../src/shared/design/presets";
import { ENDLESS_MATCH, GAME_MODES } from "../src/shared/modes";
import { Replica } from "../src/shared/net/replica";
import { LocalSession } from "../src/shared/net/session";
import { initPhysics } from "../src/shared/sim/simulation";
import { seedRandom } from "./seed";

/*
 * La partie solo hors du fil du rendu (net/session.ts) : la session joue la partie et rend des images
 * comme le serveur ; la réplique qu'elles nourrissent doit reproduire son monde. Ce que le client lui
 * demande passe par des commandes (une partie, les commandes du joueur, le temps, un tir de la caméra
 * libre, la pause de l'IA, une vague).
 */

beforeAll(async () => {
  await initPhysics();
});

const now = (): number => performance.now();

function play(session: LocalSession, replica: Replica, steps: number): number {
  let bytes = 0;
  for (let i = 0; i < steps; i++) {
    for (const f of session.handle({ t: "advance", dt: STEP })) {
      bytes += f.length;
      replica.receive(f);
    }
  }
  return bytes;
}

it("une partie pilotée jouée par la session se rejoue dans la réplique", () => {
  seedRandom(21);
  const session = new LocalSession(now);
  const replica = new Replica();
  replica.delay = 2 * STEP;
  for (const f of session.handle({ t: "start", mode: "battle", arena: "depot", pilot: PRESET_BOTS[0], roster: null })) replica.receive(f);
  // Le joueur avance et tire
  session.handle({ t: "input", input: { ...session.sim.input, throttle: 1, trigger: true }, aim: null });
  const t0 = performance.now();
  const bytes = play(session, replica, 240);
  const ms = performance.now() - t0;
  replica.flush();

  expect(replica.bots.length).toBe(session.sim.bots.length);
  expect(replica.player?.id).toBe(session.sim.player?.id);
  expect(replica.match?.rules).toEqual(GAME_MODES.battle.match);
  expect(replica.arena.id).toBe("depot");
  // Les morceaux à la même place que dans la session
  for (const bot of session.sim.bots) {
    const twin = replica.bots.find((b) => b.id === bot.id);
    expect(twin).toBeDefined();
    if (!bot.cockpit.alive) continue;
    const a = bot.cockpit.part.rb.translation(), b = twin!.cockpit.part.rb.translation();
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.05);
  }
  // Le robot du joueur est piloté : il lit les commandes de la simulation (Bot.input reste nul en solo)
  expect(session.sim.player!.controller).toBe("player");
  console.log(`Session : ${(bytes / 240 / 1024).toFixed(1)} Ko par image, ${(ms / 240).toFixed(2)} ms par pas (simulation, encodage, décodage)`);
  session.dispose();
});

it("caméra libre : les robots imposés, une partie sans fin, les tirs et l'état des armes, la pause de l'IA", () => {
  seedRandom(22);
  const session = new LocalSession(now);
  const replica = new Replica();
  replica.delay = 2 * STEP;
  for (const f of session.handle({ t: "start", mode: "arena", arena: "depot", pilot: null, roster: BATTLE_ROSTER })) replica.receive(f);
  expect(session.sim.bots.length).toBe(BATTLE_ROSTER.length);
  expect(session.sim.match?.rules).toEqual(ENDLESS_MATCH);

  session.handle({ t: "fire", weapon: "cannon", origin: { x: 0, y: 10, z: -30 }, dir: { x: 0, y: -0.2, z: 1 }, free: false, homing: null });
  play(session, replica, 30);
  replica.flush();
  // Le coup est parti : le canon recharge, la réplique le sait (le HUD de la caméra libre)
  expect(replica.freeArms?.get("cannon")?.cooldown ?? 0).toBeGreaterThan(0);

  // L'IA figée : plus personne ne bouge de lui-même
  session.handle({ t: "pause", ai: true });
  expect(session.sim.aiPaused).toBe(true);

  // Une autre vague : la réplique décrit le nouveau monde
  for (const f of session.handle({ t: "spawn", profiles: [PRESET_BOTS[1], PRESET_BOTS[2]] })) replica.receive(f);
  play(session, replica, 10);
  replica.flush();
  expect(replica.bots.map((b) => b.id).sort()).toEqual(session.sim.bots.map((b) => b.id).sort());
  session.dispose();
});

it("la mesure des étapes d'un pas part avec les images", () => {
  const session = new LocalSession(now);
  const replica = new Replica();
  for (const f of session.handle({ t: "start", mode: "arena", arena: "depot", pilot: null, roster: BATTLE_ROSTER })) replica.receive(f);
  session.handle({ t: "profile", on: true });
  play(session, replica, 20);
  replica.flush();
  expect(replica.simProfile.steps).toBe(20);
  expect(Object.keys(replica.simProfile.times)).toContain("physique");
  session.dispose();
});

it("un appui qui quitte le sol ou s'y pose ne fait pas de distance au sol invalide dans la réplique", () => {
  const session = new LocalSession(now);
  const replica = new Replica();
  replica.delay = 2 * STEP;
  const hover = PRESET_BOTS.filter((p) => p.id === "hovercraft" || p.id === "spider");
  for (const f of session.handle({ t: "start", mode: "arena", arena: "canyon", pilot: null, roster: [...hover, ...hover] })) replica.receive(f);
  let bad = 0;
  // Des images, et la réplique qui avance par petits bouts entre elles (l'interpolation)
  for (let i = 0; i < 180; i++) {
    for (const f of session.handle({ t: "advance", dt: STEP })) replica.receive(f);
    for (let k = 0; k < 3; k++) {
      replica.advance(STEP / 3);
      for (const bot of replica.bots) for (const s of bot.supports) if (Number.isNaN(s.contact)) bad++;
    }
  }
  expect(bad).toBe(0);
  session.dispose();
});
