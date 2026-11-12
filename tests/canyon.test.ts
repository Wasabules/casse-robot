import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { navigate } from "../src/shared/ai/navigation";
import { ARENAS, groundLevel, type StaticBox } from "../src/shared/arena/layout";
import { MAX_GRADE, walkable } from "../src/shared/arena/navGraph";
import { rayArena } from "../src/shared/arena/ray";
import { terrainHeight } from "../src/shared/arena/terrain";
import { propDef, propHalf } from "../src/shared/catalog/props";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { flatDistance, qrot, vec3, type Vec3 } from "../src/shared/math/vec";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import { startMatch } from "../src/shared/sim/match";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";
import { botName } from "../src/client/i18n/names";

/*
 * Le Canyon : un relief que coupent des falaises, franchi par des sentiers, un viaduc, une arche
 * et des tunnels ; l'IA au sol y suit le réseau de passage de la carte.
 */

const CANYON = ARENAS.canyon;
const terrain = CANYON.terrain!;
const nav = CANYON.nav!;

/** Plus court chemin du réseau entre deux points (indices), ou null. */
function graphPath(from: number, to: number): number[] | null {
  const next: number[][] = nav.points.map(() => []);
  for (const [a, b] of nav.links) {
    next[a].push(b);
    next[b].push(a);
  }
  const prev = new Map<number, number>([[from, -1]]);
  const queue = [from];
  while (queue.length) {
    const u = queue.shift()!;
    if (u === to) break;
    for (const v of next[u]) if (!prev.has(v)) prev.set(v, u), queue.push(v);
  }
  if (!prev.has(to)) return null;
  const path: number[] = [];
  for (let i = to; i >= 0; i = prev.get(i)!) path.unshift(i);
  return path;
}

/** Le point du réseau le plus proche de (x, z) d'où on le rejoint en ligne droite. */
function nearestNode(x: number, z: number): number {
  let best = -1;
  for (let i = 0; i < nav.points.length; i++) {
    const [px, pz] = nav.points[i];
    if (!walkable(terrain, px, pz, x, z)) continue;
    if (best < 0 || Math.hypot(px - x, pz - z) < Math.hypot(nav.points[best][0] - x, nav.points[best][1] - z)) best = i;
  }
  return best;
}

/** Emprise au sol d'une boîte (rectangle englobant, x et z). */
function extent(b: { pos: Vec3; half: Vec3; rot: StaticBox["rot"] }): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const axis of [vec3(b.half.x, 0, 0), vec3(0, b.half.y, 0), vec3(0, 0, b.half.z)]) {
    const v = qrot(b.rot, axis);
    x += Math.abs(v.x);
    z += Math.abs(v.z);
  }
  return { x, z };
}

describe("le Canyon (données)", () => {
  it("les lignes de départ sont dégagées et à plat, les zones au niveau de leur sol", () => {
    const { spawnLine, spawnSpread } = CANYON.bounds;
    for (const side of [-1, 1]) {
      for (let x = -spawnSpread; x <= spawnSpread; x += 3) {
        for (const dz of [-6, 0, 6]) {
          const z = side * spawnLine + dz;
          expect(walkable(terrain, x - 3, z, x + 3, z), `${x}, ${z}`).toBe(true);
          for (const b of CANYON.boxes) {
            if (b.kind === "bound") continue;
            const e = extent(b);
            expect(Math.abs(b.pos.x - x) > e.x + 2 || Math.abs(b.pos.z - z) > e.z + 2, `boîte ${b.kind} sur la ligne de départ en ${x}, ${z}`).toBe(true);
          }
          for (const s of CANYON.props) expect(Math.hypot(s.pos.x - x, s.pos.z - z) > 4, `${s.type} sur la ligne de départ`).toBe(true);
        }
      }
    }
    for (const zone of CANYON.zones) {
      // A sur l'arche, C sur le viaduc : le dessus de leur tablier ; les autres, le relief
      const deck = CANYON.boxes.find((b) => b.kind === "deck" && Math.min(b.half.x, b.half.z) >= 1 && Math.abs(b.pos.x - zone.pos.x) < b.half.x && Math.abs(b.pos.z - zone.pos.z) < b.half.z);
      const floor = deck ? deck.pos.y + deck.half.y : groundLevel(CANYON, zone.pos.x, zone.pos.z);
      expect(Math.abs(zone.pos.y - floor), zone.label).toBeLessThan(0.2);
      expect(Math.max(Math.abs(zone.pos.x), Math.abs(zone.pos.z)), zone.label).toBeLessThan(CANYON.bounds.roam);
    }
  });

  it("le canyon est une coupure : ses parois sont infranchissables, ses sentiers praticables", () => {
    // Droit à travers le canyon, de part et d'autre du viaduc : pas de passage
    for (const x of [-90, -50, -25, 25, 50, 90]) expect(walkable(terrain, x, -40, x, 40), `x = ${x}`).toBe(false);
    // Le lit est profond de près de 10 m sous le plateau
    expect(groundLevel(CANYON, 0, 0)).toBeLessThan(3.2);
    expect(groundLevel(CANYON, 0, 40)).toBeGreaterThan(11);
    // Chaque sentier se suit d'un bout à l'autre (la ligne des chemins dessinés qui le suivent) : ceux
    // dont les bouts sont à des hauteurs très différentes
    const drop = (p: { points: readonly (readonly [number, number])[] }): number =>
      Math.abs(terrainHeight(terrain, ...p.points[0]) - terrainHeight(terrain, ...p.points[p.points.length - 1]));
    const trails = CANYON.paths!.filter((p) => drop(p) > 8);
    expect(trails.length).toBeGreaterThanOrEqual(8);
    for (const t of trails) {
      for (let i = 1; i < t.points.length; i++) {
        const [a, b] = [t.points[i - 1], t.points[i]];
        expect(walkable(terrain, a[0], a[1], b[0], b[1]), `sentier ${t.points[0].join(",")} segment ${i}`).toBe(true);
      }
    }
    expect(MAX_GRADE).toBeLessThan(0.7);
  });

  it("l'eau n'est que dans la mare de l'oasis", () => {
    const water = CANYON.water!;
    let wet = 0;
    for (let x = -104; x <= 104; x += 2) {
      for (let z = -104; z <= 104; z += 2) {
        if (terrainHeight(terrain, x, z) >= water) continue;
        wet++;
        expect(Math.hypot(x + 79, z + 12), `eau en ${x}, ${z}`).toBeLessThan(9);
      }
    }
    expect(wet).toBeGreaterThan(10);
  });

  it("les accessoires ont leurs dimensions et leurs appuis, et ne sont pas dans le décor", () => {
    const solid = CANYON.boxes.filter((b) => ["pillar", "barrier", "platform", "rock", "container"].includes(b.kind));
    for (const spot of CANYON.props) {
      const half = propHalf(spot.type, spot);
      expect(Math.min(half.x, half.y, half.z), spot.type).toBeGreaterThan(0.02);
      for (const r of spot.rests ?? []) expect(CANYON.props[r], spot.type).toBeDefined();
      if (propDef(spot.type).shape.kind === "slab") continue;
      // Un accessoire (caisse, baril, cactus, arbre, réservoir) n'entre pas dans une boîte du décor
      for (const b of solid) {
        // Dans le repère de la boîte (l'accessoire, debout, compté comme une boîte englobante)
        const inverse = { x: -b.rot.x, y: -b.rot.y, z: -b.rot.z, w: b.rot.w };
        const p = qrot(inverse, vec3(spot.pos.x - b.pos.x, spot.pos.y - b.pos.y, spot.pos.z - b.pos.z));
        const reach = Math.max(half.x, half.z);
        const inside = Math.abs(p.x) < b.half.x + reach - 0.05 && Math.abs(p.z) < b.half.z + reach - 0.05 && Math.abs(p.y) < b.half.y + half.y - 0.05;
        expect(inside, `${spot.type} en ${spot.pos.x.toFixed(1)}, ${spot.pos.z.toFixed(1)} dans un ${b.kind}`).toBe(false);
      }
    }
    expect(CANYON.props.filter((s) => s.type === "cactus").length).toBeGreaterThan(40);
    expect(CANYON.props.some((s) => s.type === "watertank")).toBe(true);
  });

  it("le réseau de passage relie les lignes de départ et toutes les zones", () => {
    const north = nearestNode(0, CANYON.bounds.spawnLine);
    const south = nearestNode(0, -CANYON.bounds.spawnLine);
    expect(north).toBeGreaterThanOrEqual(0);
    expect(south).toBeGreaterThanOrEqual(0);
    expect(graphPath(north, south)).not.toBeNull();
    for (const zone of CANYON.zones) {
      // Une zone sur un tablier se rejoint par l'abord d'un de ses bouts
      const deck = CANYON.boxes.find((b) => b.kind === "deck" && Math.min(b.half.x, b.half.z) >= 1 && Math.abs(b.pos.x - zone.pos.x) < b.half.x && Math.abs(b.pos.z - zone.pos.z) < b.half.z);
      const node = deck ? nearestNode(deck.pos.x, deck.pos.z + deck.half.z + 5) : nearestNode(zone.pos.x, zone.pos.z);
      expect(node, zone.label).toBeGreaterThanOrEqual(0);
      expect(graphPath(north, node), zone.label).not.toBeNull();
      expect(graphPath(south, node), zone.label).not.toBeNull();
    }
    // Le lit du canyon se rejoint aussi
    expect(graphPath(north, nearestNode(-30, -9))).not.toBeNull();
  });

  it("les tunnels : la voie passe sous le toit de grès, à travers la butte", () => {
    for (const roof of CANYON.boxes.filter((b) => b.kind === "platform" && b.look === "sandstone")) {
      const { x, z } = roof.pos;
      // Sous le toit, la voie au niveau du plateau, 5 m de hauteur libre
      expect(groundLevel(CANYON, x, z)).toBeCloseTo(12, 0);
      expect(roof.pos.y - roof.half.y - groundLevel(CANYON, x, z)).toBeGreaterThan(4.5);
      // Le long de la voie, un rayon à hauteur de robot traverse la butte ; en travers, il bute sur sa paroi
      const along = qrot(roof.rot, vec3(0, 0, 1));
      const start = vec3(x - along.x * 30, 13.2, z - along.z * 30);
      expect(rayArena(CANYON, start, along, 60)).toBeNull();
      const across = qrot(roof.rot, vec3(1, 0, 0));
      expect(rayArena(CANYON, vec3(x, 13.2, z), across, 20)).not.toBeNull();
      // D'en haut, on tombe sur le toit
      const fromAbove = rayArena(CANYON, vec3(x, 40, z), vec3(0, -1, 0), 40);
      expect(40 - fromAbove!).toBeCloseTo(roof.pos.y + roof.half.y, 1);
    }
  });
});

describe("le Canyon (simulation)", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(6);
    sim = new Simulation();
    sim.loadArena("canyon");
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number, until?: () => boolean): void => {
    for (let i = 0; i < seconds * 60 && !until?.(); i++) sim.step();
  };
  const place = (id: string, x: number, z: number, yaw = 0): Bot => {
    const profile = PRESET_BOTS.find((p) => p.id === id)!;
    const bot = spawnBot(sim, profile, vec3(x, groundLevel(sim.arena, x, z) + groundHeight(profile.design) + 0.05, z), yaw, "blue");
    sim.bots.push(bot);
    return bot;
  };

  it("du plateau, pour descendre au fond du canyon, un robot prend un sentier, pas la falaise", () => {
    const bot = place("buggy", 30, 40);
    const pos = bot.cockpit.part.rb.worldCom();
    const target = vec3(30, 0, 9.5); // le lit, juste en contrebas
    const goal = navigate(sim, bot, pos, target);
    // Il ne file pas droit vers la falaise : il va vers un sentier
    expect(flatDistance(goal, target)).toBeGreaterThan(5);
    expect(walkable(terrain, pos.x, pos.z, goal.x, goal.z)).toBe(true);
  });

  it("dans le tunnel, le toit au-dessus du robot ne compte pas comme un obstacle", () => {
    const roof = CANYON.boxes.find((b) => b.kind === "platform" && b.look === "sandstone")!;
    const along = qrot(roof.rot, vec3(0, 0, 1));
    const bot = place("buggy", roof.pos.x - along.x * 6, roof.pos.z - along.z * 6, Math.atan2(along.x, along.z));
    const pos = bot.cockpit.part.rb.worldCom();
    const target = vec3(roof.pos.x + along.x * 20, 0, roof.pos.z + along.z * 20);
    const goal = navigate(sim, bot, pos, target);
    expect(flatDistance(goal, target)).toBeLessThan(0.01);
  });

  /** Un robot de l'IA seul en jeu, qu'on mène à une zone (il prendrait la plus proche qu'il ne tient pas) ; rend le temps qu'il y a mis (s). */
  const driveTo = (bot: Bot, label: string, seconds: number): { reached: boolean; time: number } => {
    const zone = CANYON.zones.find((z) => z.label === label)!;
    const reached = (): boolean => flatDistance(bot.cockpit.part.rb.worldCom(), zone.pos) < zone.radius && Math.abs(bot.cockpit.part.rb.worldCom().y - zone.pos.y) < 4;
    let i = 0;
    for (; i < seconds * 60 && !reached(); i++) {
      // Sa destination, tant qu'il patrouille (sans gêner un dégagement en marche arrière ni son redressement)
      if (i % 30 === 0 && bot.ai.mode === "patrol") {
        bot.ai.target = vec3(zone.pos.x, 0, zone.pos.z);
        bot.ai.timer = 10;
      }
      sim.step();
    }
    return { reached: reached(), time: i / 60 };
  };

  it("un robot de l'IA rejoint la zone du fond du canyon depuis le plateau", { timeout: 120_000 }, () => {
    startMatch(sim, { ...GAME_MODES.capture.match, timeLimit: 600 });
    sim.combat = false;
    const toOasis = driveTo(place("buggy", 20, 40, Math.PI), "E", 90);
    expect(toOasis.reached, `au bout de ${toOasis.time.toFixed(0)} s`).toBe(true);
  });

  it("du plateau, un robot de l'IA monte à la zone de l'arche par le sentier en corniche", { timeout: 120_000 }, () => {
    // (il partait de (40, 22), sur le rebord du canyon : ses roues de gauche au-dessus du vide, la
    // roue arrière en l'air ; selon le premier coup de volant, il partait, restait calé ou tombait)
    startMatch(sim, { ...GAME_MODES.capture.match, timeLimit: 600 });
    sim.combat = false;
    const toArch = driveTo(place("buggy", 40, 25, 1.2), "A", 80);
    expect(toArch.reached, `au bout de ${toArch.time.toFixed(0)} s`).toBe(true);
  });

  // Du fond du canyon à l'arche : un sentier dans la paroi jusqu'au plateau, puis le sentier en
  // corniche (au nord ou au sud de la gorge) ; de l'est (l'oasis), en passant d'abord sous le viaduc.
  // Le robot calait au coude du sentier en corniche, une roue ou une chenille sur son arête : les
  // liaisons du réseau et ses raccourcis longeaient le bord du sentier (une marge de 1 m, jugée sur
  // deux lignes seulement), le sentier ne faisait que 6,5 m de large, et ses coudes avaient une marche
  // sur leur bord intérieur ; sous le viaduc, il heurtait un des deux pieds d'une palée (le Buggy y
  // perdait une roue). Sur six départs du lit et trois graines, le Buggy, le Tricycle et le Char y
  // montaient 8 fois sur 18 (graine 6), maintenant 51 fois sur 54, en 30 à 120 s (voir la feuille de route)
  const CLIMBS: readonly (readonly [string, number, number])[] = [
    ["buggy", 45, 9], ["buggy", 55, 7], ["buggy", -30, -9.5],
    ["trike", 45, 9], ["trike", 55, 7], ["trike", -64, -4],
    ["tank", 20, 8.5], ["tank", 45, 9],
  ];
  for (const [id, x, z] of CLIMBS) {
    it(`du fond du canyon (${x}, ${z}), un robot de l'IA (${id}) monte à la zone de l'arche`, { timeout: 180_000 }, () => {
      startMatch(sim, { ...GAME_MODES.capture.match, timeLimit: 600 });
      sim.combat = false;
      const toArch = driveTo(place(id, x, z, Math.PI / 2), "A", 130);
      expect(toArch.reached, `au bout de ${toArch.time.toFixed(0)} s`).toBe(true);
    });
  }

  it("une bataille s'y joue sans erreur, robots dans la carte, et des robots y sont détruits", { timeout: 120_000 }, () => {
    // Une graine dont les équipes tirées au sort se rencontrent en 45 s (le tirage change avec le
    // catalogue des robots : à 43 robots, la graine 6 n'en détruisait aucun)
    sim.dispose();
    seedRandom(2);
    sim = new Simulation();
    sim.loadArena("canyon");
    const mode = GAME_MODES.battle;
    spawnTeams(sim, matchEntries(mode, PRESET_BOTS[2]));
    const match = startMatch(sim, { ...mode.match, timeLimit: 60 });
    let kills = 0;
    sim.on((e) => {
      if (e.type === "botKilled") kills++;
    });
    run(45, () => match.winner !== null);
    expect(kills).toBeGreaterThan(0);
    // Les avions, eux, patrouillent au-dessus des montagnes jusqu'aux limites invisibles (avec l'ancien
    // mélangeur comme avec les rangs de gouvernes, ils les touchent) : ils restent en deçà
    const wall = Math.min(...CANYON.boxes.filter((b) => b.kind === "bound").map((b) => Math.max(Math.abs(b.pos.x), Math.abs(b.pos.z)) - Math.min(b.half.x, b.half.z)));
    for (const b of sim.bots) {
      if (!b.cockpit.alive) continue;
      const p = b.cockpit.part.rb.translation();
      const limit = b.profile.mobility === "plane" ? wall : CANYON.bounds.half + 20;
      expect(Math.max(Math.abs(p.x), Math.abs(p.z)), botName(b.profile)).toBeLessThan(limit);
    }
  });
});
