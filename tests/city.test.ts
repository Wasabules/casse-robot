import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insideObstacle, navigate, obstacles } from "../src/shared/ai/navigation";
import { ARENAS, groundLevel } from "../src/shared/arena/layout";
import { CAR_HALF, propDef, propHalf } from "../src/shared/catalog/props";
import { strike } from "../src/shared/combat/damage";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { add, flatDistance, qrot, scale, vec3, type Vec3 } from "../src/shared/math/vec";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import { groundHeight, removeBot, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot, Prop, Team } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { startMatch } from "../src/shared/sim/match";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";
import { botName } from "../src/client/i18n/names";

/*
 * La Cité : lignes de départ dégagées, zones atteignables, rien qui se chevauche ; immeubles qui
 * s'effondrent étage par étage, voiture qui flambe puis explose ; voie surélevée et bâtiments dont
 * l'IA sait sortir ; une courte bataille.
 */

const CITY = ARENAS.city;
const preset = (id: string): BotProfile => PRESET_BOTS.find((p) => p.id === id)!;
/** Demi-largeur de l'avenue sous la voie rapide (m). */
const HW_SPAN = 7;

describe("la Cité", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(6);
    sim = new Simulation();
    sim.loadArena("city");
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  const at = (spot: number): Prop | undefined => sim.props.find((p) => p.spot === spot);
  /** Un robot posé au sol en (x, z), tourné de `yaw`. */
  const place = (id: string, team: Team, x: number, z: number, yaw = 0): Bot => {
    const profile = preset(id);
    const bot = spawnBot(sim, profile, vec3(x, groundLevel(sim.arena, x, z) + groundHeight(profile.design) + 0.05, z), yaw, team);
    sim.bots.push(bot);
    return bot;
  };
  /** Abat un accessoire d'un coup, du côté de `dir`. */
  const knockDown = (prop: Prop, dir = vec3(1, 0, 0)): void => {
    const p = prop.rb.translation();
    strike(sim, { kind: "prop", prop }, 1e6, "explosive", p, dir, 0, add(p, scale(dir, -5)));
  };

  it("les deux équipes partent de leur ligne, dans les boulevards dégagés", () => {
    const bots = spawnTeams(sim, matchEntries(GAME_MODES.battle, PRESET_BOTS[0]));
    const { spawnLine, spawnSpread } = CITY.bounds;
    for (const bot of bots) {
      if (bot.profile.mobility === "plane") continue;
      const p = bot.cockpit.part.rb.translation();
      // Sur sa ligne (pas sur les cercles de secours), au nord pour les rouges, au sud pour les bleus
      expect(Math.abs(Math.abs(p.z) - spawnLine), botName(bot.profile)).toBeLessThan(6);
      expect(Math.sign(p.z), botName(bot.profile)).toBe(bot.team === "red" ? 1 : -1);
      expect(Math.abs(p.x), botName(bot.profile)).toBeLessThan(spawnSpread + 5);
      expect(insideObstacle(sim, p, 0), botName(bot.profile)).toBe(false);
    }
    // Rien d'ancré sur les lignes de départ
    for (const spot of CITY.props) {
      const onLine = Math.abs(Math.abs(spot.pos.z) - spawnLine) < 7 && Math.abs(spot.pos.x) < spawnSpread + 5;
      expect(onLine, spot.type).toBe(false);
    }
  });

  it("rien ne se chevauche : accessoires entre eux, accessoires et décor fixe", () => {
    // Emprise d'une boîte orientée (pour un accessoire, celle de sa pose de départ), un peu réduite
    const aabb = (pos: Vec3, half: Vec3, rot: { x: number; y: number; z: number; w: number }): { lo: Vec3; hi: Vec3 } => {
      const ext = [vec3(half.x, 0, 0), vec3(0, half.y, 0), vec3(0, 0, half.z)].map((v) => qrot(rot, v));
      const e = vec3(
        ext.reduce((s, v) => s + Math.abs(v.x), 0) - 0.08,
        ext.reduce((s, v) => s + Math.abs(v.y), 0) - 0.08,
        ext.reduce((s, v) => s + Math.abs(v.z), 0) - 0.08,
      );
      return { lo: vec3(pos.x - e.x, pos.y - e.y, pos.z - e.z), hi: vec3(pos.x + e.x, pos.y + e.y, pos.z + e.z) };
    };
    const overlap = (a: { lo: Vec3; hi: Vec3 }, b: { lo: Vec3; hi: Vec3 }): boolean =>
      a.lo.x < b.hi.x && b.lo.x < a.hi.x && a.lo.y < b.hi.y && b.lo.y < a.hi.y && a.lo.z < b.hi.z && b.lo.z < a.hi.z;
    const props = CITY.props.map((s) => ({ spot: s, box: aabb(s.pos, propHalf(s.type, s), s.rot ?? { x: 0, y: 0, z: 0, w: 1 }) }));
    const solid = CITY.boxes.filter((b) => b.kind !== "bound" && b.kind !== "road" && b.kind !== "track" && b.kind !== "ramp").map((b) => ({ box: b, aabb: aabb(b.pos, b.half, b.rot) }));
    const clashes: string[] = [];
    for (let i = 0; i < props.length; i++) {
      for (let j = i + 1; j < props.length; j++) {
        if (overlap(props[i].box, props[j].box)) clashes.push(`${props[i].spot.type} ${i} / ${props[j].spot.type} ${j}`);
      }
      for (const s of solid) {
        if (overlap(props[i].box, s.aabb)) clashes.push(`${props[i].spot.type} ${i} / ${s.box.kind} (${s.box.pos.x}, ${s.box.pos.z})`);
      }
    }
    expect(clashes).toEqual([]);
    // Chaque accessoire a ses dimensions, et ce sur quoi il repose existe
    for (const spot of CITY.props) {
      const half = propHalf(spot.type, spot);
      expect(Math.min(half.x, half.y, half.z), spot.type).toBeGreaterThan(0.02);
      for (const r of spot.rests ?? []) expect(CITY.props[r], spot.type).toBeDefined();
    }
  });

  it("un étage abattu fait tomber ce qui le surmonte, et le toit quand plus rien ne le porte", () => {
    // Un pan du rez-de-chaussée qui porte un étage, sous une bande de toit
    const ground = CITY.props.findIndex((s, i) => s.type === "facade" && s.building !== undefined && !s.rests
      && CITY.props.some((u) => u.rests?.length === 1 && u.rests[0] === i));
    const upper = CITY.props.findIndex((s) => s.rests?.length === 1 && s.rests[0] === ground);
    expect(at(upper)!.fixed).toBe(true);
    knockDown(at(ground)!);
    run(0.2);
    expect(at(upper) === undefined || !at(upper)!.fixed).toBe(true);
    expect(events.some((e) => e.type === "propReleased")).toBe(true);
  });

  it("une voiture à bout prend feu, brûle, puis explose", () => {
    const car = sim.props.find((p) => p.type === "car")!;
    const p = car.rb.translation();
    strike(sim, { kind: "prop", prop: car }, 1e4, "kinetic", p, vec3(1, 0, 0), 0, add(p, vec3(-5, 0, 0)));
    expect(car.state.kind).toBe("fuse");
    expect(car.burn).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "propFire" && e.prop === car)).toBe(true);
    run(2);
    expect(sim.props.includes(car)).toBe(true); // elle flambe encore
    run(4);
    expect(sim.props.includes(car)).toBe(false);
    expect(events.some((e) => e.type === "explosion" && e.look === "car")).toBe(true);
    // Une épave, elle, ne brûle pas
    expect(propDef("wreck").burns).toBeUndefined();
    expect(CAR_HALF.x).toBeGreaterThan(CAR_HALF.z);
  });

  it("sous la voie rapide on passe ; pour sa zone, on monte par le remblai, dans l'axe", () => {
    const bot = place("trike", "blue", -60, 20);
    const deck = CITY.boxes.find((b) => b.kind === "deck" && b.underpass)!;
    const top = deck.pos.y + deck.half.y;
    const pos = bot.cockpit.part.rb.worldCom();
    // Une destination sous le tablier : il y reste (en contournant au plus une pile)
    const below = navigate(sim, bot, pos, vec3(-60, 0, 0));
    expect(Math.abs(below.x + 60)).toBeLessThan(HW_SPAN);
    expect(Math.abs(below.z)).toBeLessThan(deck.half.z);
    // La zone sur le tablier : par l'abord d'un bout, au pied de son remblai
    // (de dessous, il sort d'abord vers un bout en contournant la culée par une rue de côté)
    const up = navigate(sim, bot, pos, vec3(-60, top, 0));
    expect(Math.abs(up.z)).toBeGreaterThan(20);
    expect(Math.abs(up.x + 60)).toBeGreaterThan(HW_SPAN);
    // Aucun obstacle fixe n'est compté au-delà du bord de la ville
    const edge = CITY.bounds.half + 5;
    expect(obstacles(sim).every((o) => o.rect.minX < edge && o.rect.maxX > -edge && o.rect.minZ < edge && o.rect.maxZ > -edge)).toBe(true);
  });

  it("un robot entré dans un immeuble en ressort par l'ouverture", () => {
    // L'îlot de la rue de la gare au sud (x de 31 à 43, z de -24 à -5), ouvert au sud
    const bot = place("trike", "blue", 38.5, -21.7);
    const exit = navigate(sim, bot, vec3(38.5, 4.1, -21.7), vec3(60, 1.5, 0));
    expect(exit.x).toBeGreaterThan(31);
    expect(exit.x).toBeLessThan(37.5);
    expect(exit.z).toBeLessThan(-20);
  });

  it("une courte bataille se joue sans erreur, et des robots y sont détruits", { timeout: 120_000 }, () => {
    // (une graine dont le tirage des robots donne des destructions en 30 s ; le tirage dépend de la
    // liste des robots prédéfinis : à 46 robots, la 4 donne trois destructions, et aligne le
    // Duelliste et le Pilon ; sur les graines 1 à 10, quatre n'en donnent aucune)
    seedRandom(4);
    spawnTeams(sim, matchEntries(GAME_MODES.battle, PRESET_BOTS[1]));
    startMatch(sim, { ...GAME_MODES.battle.match, timeLimit: 30 });
    let kills = 0;
    sim.on((e) => {
      if (e.type === "botKilled") kills++;
    });
    run(30);
    expect(kills).toBeGreaterThan(0);
    // Les robots volants de l'IA restent au-dessus des toits
    for (const bot of sim.bots) {
      if (bot.profile.mobility !== "hover" || !bot.cockpit.alive || bot.ai.mode !== "patrol") continue;
      const p = bot.cockpit.part.rb.worldCom();
      expect(p.y - groundLevel(sim.arena, p.x, p.z), botName(bot.profile)).toBeGreaterThan(CITY.bounds.hoverFloor! - 4);
    }
  });

  // Un robot au sol part d'une ligne de départ et gagne chaque zone : les rues, la tranchée et le quai,
  // la butte du parc, les rampes du parking, les remblais de la voie rapide
  // (le Char, large et lent à manœuvrer, met plus d'une minute à gagner le toit du parking : pas ici)
  for (const [id, team, labels] of [["trike", "blue", "ABCDE"], ["tank", "red", "ABCE"]] as const) {
    it(`chaque zone est atteignable depuis la ligne de départ (${id}, ${team === "blue" ? "du sud" : "du nord"})`, { timeout: 300_000 }, () => {
      sim.aiPaused = false;
      const reached: string[] = [];
      const zones = CITY.zones.filter((z) => labels.includes(z.label));
      for (const zone of zones) {
        const side = team === "blue" ? -1 : 1;
        const bot = place(id, team, 6 * side, side * CITY.bounds.spawnLine, team === "blue" ? 0 : Math.PI);
        let t = 0;
        for (; t < 90 * 60; t++) {
          if (bot.ai.mode !== "reverse") bot.ai.mode = "patrol";
          bot.ai.timer = 10;
          bot.ai.target = vec3(zone.pos.x, zone.pos.y, zone.pos.z);
          sim.step();
          const p = bot.cockpit.part.rb.worldCom();
          if (flatDistance(p, zone.pos) < zone.radius * 0.8 && p.y > zone.pos.y - 0.5) break;
        }
        if (t < 90 * 60) reached.push(zone.label);
        removeBot(sim, bot);
        sim.bots = sim.bots.filter((b) => b !== bot);
      }
      expect(reached).toEqual(zones.map((z) => z.label));
    });
  }
});
