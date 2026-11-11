import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ARENA_IDS, ARENAS } from "../src/shared/arena/layout";
import { rayArena } from "../src/shared/arena/ray";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { flatDistance, vec3, type Vec3 } from "../src/shared/math/vec";
import { GAME_MODES, pickRoster } from "../src/shared/modes";
import { readSnapshot, writeSnapshot } from "../src/shared/net/snapshot";
import { groundHeight, removeBot, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot, Team } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { startMatch, zoneOccupants } from "../src/shared/sim/match";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";
import { botName } from "../src/client/i18n/names";

const preset = (id: string): BotProfile => PRESET_BOTS.find((p) => p.id === id)!;
const CAPTURE = GAME_MODES.capture.match;

describe("lancer de rayon sur le décor (caméra)", () => {
  const depot = ARENAS.depot;

  it("un rayon s'arrête sur un pilier, à la bonne distance, et pas sur le sol", () => {
    // Pilier du Dépôt en (12, 12), de 1,6 m de côté : on arrive par l'ouest à 1 m de haut
    const t = rayArena(depot, vec3(0, 1, 12), vec3(1, 0, 0), 50);
    expect(t).toBeCloseTo(12 - 0.8, 5);
    // Trop court pour l'atteindre, ou au-dessus : rien
    expect(rayArena(depot, vec3(0, 1, 12), vec3(1, 0, 0), 10)).toBeNull();
    expect(rayArena(depot, vec3(0, 4, 12), vec3(1, 0, 0), 50)).toBeNull();
    // Vers le sol, en plein champ : le sol ne compte pas
    expect(rayArena(depot, vec3(0, 3, -30), vec3(0, -1, 0), 10)).toBeNull();
  });

  it("une rampe inclinée arrête le rayon sur sa pente ; un rayon parti de l'intérieur d'une boîte l'ignore", () => {
    // Rampe du Dépôt en (0, ·, 20), inclinée vers le nord : un rayon vertical la touche entre le sol et son sommet
    const t = rayArena(depot, vec3(0, 5, 20), vec3(0, -1, 0), 10);
    expect(t).not.toBeNull();
    expect(5 - t!).toBeGreaterThan(0.2);
    expect(5 - t!).toBeLessThan(1.6);
    // Du cœur du pilier vers l'est : on n'est pas arrêté par le pilier qui nous entoure
    expect(rayArena(depot, vec3(12, 1, 12), vec3(1, 0, 0), 5)).toBeNull();
  });
});

describe("arènes et capture de zones", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(5);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  /** Un robot posé en `at`, qui ne bouge pas (IA figée). */
  const place = (id: string, team: Team, at: Vec3): Bot => {
    const profile = preset(id);
    const bot = spawnBot(sim, profile, vec3(at.x, at.y + groundHeight(profile.design) + 0.03, at.z), 0, team);
    sim.bots.push(bot);
    return bot;
  };

  it("changer d'arène remplace le décor et les accessoires, sans rien laisser derrière", () => {
    // Le Dépôt, avec ses accessoires en place
    sim.loadArena("trenches");
    sim.loadArena("depot");
    const bodies = sim.world.bodies.len();
    const colliders = sim.world.colliders.len();
    events.length = 0;
    for (const id of ["fort", "trenches", "depot"] as const) {
      sim.loadArena(id);
      expect(sim.arena.id).toBe(id);
      expect(sim.props.map((p) => p.type)).toEqual(ARENAS[id].props.map((p) => p.type));
    }
    expect(events.filter((e) => e.type === "arenaChanged").map((e) => e.type === "arenaChanged" && e.arena)).toEqual(["fort", "trenches", "depot"]);
    expect(sim.world.bodies.len()).toBe(bodies);
    expect(sim.world.colliders.len()).toBe(colliders);
    // Le décor de la Forteresse est bien là : un rayon vertical tombe sur sa plateforme
    sim.loadArena("fort");
    sim.step();
    const hit = sim.raycast(vec3(0, 10, 0), vec3(0, -1, 0), 20, null);
    expect(hit?.point.y).toBeCloseTo(1.2, 2);
  });

  // (une arène par test : enchaînées dans un seul, les robots de chaque arène restaient dans la suivante)
  it.each(ARENA_IDS)("dans l'arène %s, une bataille se déroule : les robots apparaissent hors du décor et restent dans l'enceinte", (id) => {
    sim.loadArena(id);
    const bots = spawnTeams(sim, pickRoster(GAME_MODES.battle).map((profile, i) => ({ profile, team: i % 2 ? "red" : "blue" })));
    run(8);
    for (const bot of bots) {
      // (un robot renversé, projeté par une explosion ou son redressement, peut passer le mur bas de l'enceinte)
      if (!bot.cockpit.alive || bot.profile.mobility === "plane" || bot.ai.mode === "flipped") continue;
      const p = bot.cockpit.part.rb.translation();
      expect(Math.abs(p.x), `${botName(bot.profile)} (${id})`).toBeLessThan(ARENAS[id].bounds.half);
      expect(Math.abs(p.z), `${botName(bot.profile)} (${id})`).toBeLessThan(ARENAS[id].bounds.half);
    }
  });

  it("une zone se prend en y restant seul, rapporte des points, et se dispute", () => {
    sim.aiPaused = true;
    const zone = sim.arena.zones[0];
    const blue = place("trike", "blue", zone.pos);
    startMatch(sim, CAPTURE);
    const state = sim.match!.zones[0];
    run(CAPTURE.capture.time * 0.9);
    expect(state.owner).toBeNull();
    expect(state.progress).toBeGreaterThan(0.8);
    run(CAPTURE.capture.time * 0.2);
    expect(state.owner).toBe("blue");
    expect(events.some((e) => e.type === "zoneChanged" && e.zone === 0 && e.owner === "blue")).toBe(true);
    // Elle rapporte `rate` points par seconde
    const before = sim.match!.score.blue;
    run(4);
    expect(sim.match!.score.blue - before).toBeCloseTo(4 * CAPTURE.capture.rate, 1);
    // Un rouge arrive, à côté du bleu (sans que leurs roues se chevauchent) : la zone est disputée, rien ne bouge
    place("trike", "red", vec3(zone.pos.x + 3.5, zone.pos.y, zone.pos.z));
    run(3);
    expect(state.contested).toBe(true);
    expect(state.owner).toBe("blue");
    expect(state.progress).toBeCloseTo(1, 3);
    // Le bleu parti, le rouge la neutralise puis la prend
    removeBot(sim, blue);
    sim.bots = sim.bots.filter((b) => b !== blue);
    run(CAPTURE.capture.time * 1.1);
    expect(state.owner).toBeNull();
    expect(events.some((e) => e.type === "zoneChanged" && e.owner === null && e.by === "red")).toBe(true);
    run(CAPTURE.capture.time);
    expect(state.owner).toBe("red");
    // Les destructions ne comptent pas
    expect(sim.match!.score.red).toBeLessThan(1);
  });

  it("l'état des zones passe dans l'instantané réseau", () => {
    sim.aiPaused = true;
    place("trike", "blue", sim.arena.zones[1].pos);
    startMatch(sim, CAPTURE);
    run(CAPTURE.capture.time * 1.2);
    const snap = readSnapshot(writeSnapshot(sim));
    expect(snap.match!.zones.map(([owner]) => owner)).toEqual([null, "blue", null]);
    expect(snap.match!.zones[1][1]).toBeCloseTo(1, 3);
    expect(snap.match!.score.blue).toBe(Math.floor(sim.match!.score.blue));
  });

  it("au roi de la colline, une seule zone est en jeu ; elle se déplace, et l'ancienne revient au neutre", () => {
    const HILL = GAME_MODES.hill.match;
    sim.aiPaused = true;
    // Un robot bleu sur chaque zone : seule la colline (au centre d'abord) se prend et rapporte
    for (const z of sim.arena.zones) place("trike", "blue", z.pos);
    const match = startMatch(sim, HILL);
    expect(match.zones.map((z) => z.active)).toEqual([false, true, false]);
    run(HILL.capture.time * 1.5);
    expect(match.zones.map((z) => z.owner)).toEqual([null, "blue", null]);
    expect(match.score.blue).toBeGreaterThan(0);
    // Au bout de `hill` s, la colline passe ailleurs ; la zone B est neutre, et hors jeu
    run(HILL.capture.hill - HILL.capture.time * 1.5 + 0.1);
    const active = match.zones.findIndex((z) => z.active);
    expect(active).not.toBe(1);
    expect(match.zones.filter((z) => z.active)).toHaveLength(1);
    expect(match.zones[1].owner).toBeNull();
    expect(match.zones[1].progress).toBe(0);
    // L'état passe dans l'instantané réseau
    const snap = readSnapshot(writeSnapshot(sim));
    expect(snap.match!.zones.map(([, , , on]) => on)).toEqual(match.zones.map((z) => z.active));
  });

  it("au roi de la colline, l'IA converge sur la colline et l'occupe", () => {
    spawnTeams(sim, pickRoster(GAME_MODES.hill).map((profile, i) => ({ profile, team: i % 2 ? "red" : "blue" })));
    const match = startMatch(sim, GAME_MODES.hill.match);
    let heading = 0;
    let inside = 0;
    for (let t = 0; t < 30; t++) {
      run(1);
      const hill = match.zones.find((z) => z.active)!;
      // Les robots qui s'y rendent (leur destination est dans la zone) ; ceux qui y sont
      const going = sim.bots.filter((b) => b.cockpit.alive && flatDistance(b.ai.target, hill.zone.pos) <= hill.zone.radius).length;
      const count = zoneOccupants(sim, hill.zone);
      heading = Math.max(heading, going);
      inside += count.red + count.blue;
    }
    // La plupart y vont d'emblée ; le centre devient un champ de bataille, où l'on se relaie
    expect(heading).toBeGreaterThanOrEqual(6);
    expect(inside).toBeGreaterThan(5);
  });

  it("en capture de zones, l'IA va prendre les zones", () => {
    // Tirés parmi les robots qui peuvent tenir une zone : un avion la survole sans s'y arrêter
    const capturers = { ...GAME_MODES.capture, roster: GAME_MODES.capture.roster.filter((p) => p.mobility !== "plane") };
    spawnTeams(sim, pickRoster(capturers).map((profile, i) => ({ profile, team: i % 2 ? "red" : "blue" })));
    const zones = startMatch(sim, CAPTURE).zones;
    // Chaque seconde, le nombre de robots près d'une zone
    let most = 0;
    for (let t = 0; t < 50; t++) {
      run(1);
      const near = sim.bots.filter((b) => b.cockpit.alive && zones.some((z) => flatDistance(b.lastPos, z.zone.pos) < z.zone.radius + 6));
      most = Math.max(most, near.length);
    }
    // Des zones ont été prises (peu importe par qui), et elles rapportent
    expect(events.filter((e) => e.type === "zoneChanged" && e.owner).length).toBeGreaterThanOrEqual(2);
    expect(sim.match!.score.blue + sim.match!.score.red).toBeGreaterThan(5);
    // Les robots se pressent autour des zones
    expect(most).toBeGreaterThanOrEqual(4);
  });

  it("au Chantier, l'IA monte sur les terrasses pour prendre les zones A et C", () => {
    sim.loadArena("yard");
    spawnTeams(sim, pickRoster(GAME_MODES.capture).map((profile, i) => ({ profile, team: i % 2 ? "red" : "blue" })));
    const zones = startMatch(sim, CAPTURE).zones;
    let aboard = 0;
    for (let t = 0; t < 40 && !aboard; t++) {
      run(1);
      for (const i of [0, 2]) {
        const count = zoneOccupants(sim, zones[i].zone);
        aboard += count.red + count.blue;
      }
    }
    expect(aboard).toBeGreaterThan(0);
  });

  it("dans la Forteresse, l'IA monte sur la plateforme par les rampes pour prendre la zone B", () => {
    sim.loadArena("fort");
    spawnTeams(sim, pickRoster(GAME_MODES.capture).map((profile, i) => ({ profile, team: i % 2 ? "red" : "blue" })));
    const zones = startMatch(sim, CAPTURE).zones;
    const platform = zones[1];
    let aboard = 0;
    for (let t = 0; t < 30 && !aboard; t++) {
      run(1);
      const count = zoneOccupants(sim, platform.zone);
      aboard = count.red + count.blue;
    }
    expect(aboard).toBeGreaterThan(0);
  });
});
