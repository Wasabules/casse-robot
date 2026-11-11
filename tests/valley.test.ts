import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { navigate } from "../src/shared/ai/navigation";
import { ARENAS, groundLevel } from "../src/shared/arena/layout";
import { rayArena } from "../src/shared/arena/ray";
import { propDistance } from "../src/shared/arena/structures";
import { propDef, propHalf, propHp } from "../src/shared/catalog/props";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { explode, strike } from "../src/shared/combat/damage";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, qrot, scale, vec3 } from "../src/shared/math/vec";
import { GAME_MODES, pickRoster } from "../src/shared/modes";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Prop } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * La Vallée : relief, bâtiments et arbres ancrés qui s'abattent, pont.
 */

const VALLEY = ARENAS.valley;

describe("la Vallée", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(4);
    sim = new Simulation();
    sim.loadArena("valley");
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  /** L'accessoire posé à l'emplacement `spot`. */
  const at = (spot: number): Prop | undefined => sim.props.find((p) => p.spot === spot);
  /** Abat un accessoire d'un coup (des dégâts qui dépassent ses points), du côté de `dir`. */
  const knockDown = (prop: Prop, dir = vec3(1, 0, 0)): void => {
    const p = prop.rb.translation();
    strike(sim, { kind: "prop", prop }, 1e6, "explosive", p, dir, 0, add(p, scale(dir, -5)));
  };

  it("le relief est sous les pieds de tous : robots posés dessus, zones et rochers à sa hauteur, et il arrête la caméra", () => {
    const bots = spawnTeams(sim, pickRoster(GAME_MODES.battle).map((profile, i) => ({ profile, team: i % 2 ? "red" : "blue" })));
    sim.aiPaused = true;
    run(2);
    for (const bot of bots) {
      if (!bot.cockpit.alive || bot.profile.mobility !== "ground") continue;
      const p = bot.cockpit.part.rb.translation();
      const ground = groundLevel(sim.arena, p.x, p.z);
      expect(p.y, bot.profile.name).toBeGreaterThan(ground);
      expect(p.y - ground, bot.profile.name).toBeLessThan(3);
    }
    for (const zone of VALLEY.zones) {
      if (zone.label !== "C") expect(Math.abs(zone.pos.y - groundLevel(VALLEY, zone.pos.x, zone.pos.z)), zone.label).toBeLessThan(0.05);
    }
    // De la berge, un rayon horizontal vers le fort rencontre le flanc de la colline
    const hill = rayArena(VALLEY, vec3(-72, 6, -12), vec3(0, 0, 1), 40);
    expect(hill).not.toBeNull();
    expect(hill!).toBeGreaterThan(1);
    expect(hill!).toBeLessThan(20);
  });

  it("un rocher a la forme qu'on voit : les coins de sa boîte ne sont plus des obstacles invisibles", () => {
    sim.step();
    const rock = VALLEY.boxes.find((b) => b.kind === "rock")!;
    const { pos, half, rot } = rock;
    const top = pos.y + half.y;
    // Au-dessus du centre, le rayon tombe sur le rocher ; au-dessus d'un coin de sa boîte, sur le sol
    const onCenter = sim.raycast(vec3(pos.x, top + 5, pos.z), vec3(0, -1, 0), 20, null);
    expect(onCenter!.point.y).toBeGreaterThan(top - 0.4);
    const corner = qrot(rot, vec3(half.x * 0.95, 0, half.z * 0.95));
    const onCorner = sim.raycast(vec3(pos.x + corner.x, top + 5, pos.z + corner.z), vec3(0, -1, 0), 20, null);
    expect(onCorner!.point.y).toBeLessThan(pos.y);
  });

  it("un toit tombe quand tous les murs qui le portent sont abattus, pas avant", () => {
    const spot = VALLEY.props.findIndex((s) => s.type === "roof" && (s.rests?.length ?? 0) >= 2);
    const roof = at(spot)!;
    const rests = VALLEY.props[spot].rests!;
    expect(roof.fixed).toBe(true);
    const y0 = roof.rb.translation().y;
    knockDown(at(rests[0])!);
    run(0.2);
    expect(roof.fixed).toBe(true); // un mur tient encore
    for (const r of rests.slice(1)) {
      const wall = at(r);
      if (wall) knockDown(wall);
    }
    run(0.2);
    expect(roof.fixed).toBe(false);
    expect(events.some((e) => e.type === "propReleased" && e.prop === roof)).toBe(true);
    run(2);
    // Il est tombé, ou s'est brisé en tombant
    expect(!sim.props.includes(roof) || roof.rb.translation().y < y0 - 1).toBe(true);
    // Les murs abattus sont partis en gros morceaux
    expect(events.some((e) => e.type === "debrisAdded" && e.debris.look.kind === "prop" && (e.debris.look.size ?? 0) >= 0.3)).toBe(true);
  });

  it("un arbre abattu bascule du côté du coup, puis se brise s'il cède encore", () => {
    // Un chêne isolé dans les champs (dans un bois, il retomberait contre un voisin)
    const alone = (i: number): number => Math.min(...VALLEY.props.filter((_, j) => j !== i).map((o) => Math.hypot(o.pos.x - VALLEY.props[i].pos.x, o.pos.z - VALLEY.props[i].pos.z)));
    const oaks = VALLEY.props.map((_, i) => i).filter((i) => VALLEY.props[i].type === "oak");
    const spot = oaks.reduce((a, b) => (alone(a) >= alone(b) ? a : b));
    const tree = at(spot)!;
    expect(tree.fixed).toBe(true);
    knockDown(tree, vec3(0, 0, 1));
    expect(tree.fixed).toBe(false);
    expect(tree.hp).toBeCloseTo(propHp("oak", tree.half) * propDef("oak").topples!, 3);
    run(3);
    // Couché, la cime vers +z
    const up = qrot(tree.rb.rotation(), vec3(0, 1, 0));
    expect(up.y).toBeLessThan(0.5);
    expect(up.z).toBeGreaterThan(0.5);
    knockDown(tree);
    run(0.2);
    expect(sim.props.includes(tree)).toBe(false);
  });

  it("une explosion contre un grand mur le touche en plein, même loin de son centre", () => {
    const spot = VALLEY.props.findIndex((s) => s.type === "brick" && (s.half?.x ?? 0) > 1.5);
    const wall = at(spot)!;
    const p = wall.rb.translation();
    // Au bout du pan, juste devant sa face
    const point = vec3(p.x + wall.half.x * 0.9, p.y, p.z + wall.half.z + 0.2);
    expect(propDistance(wall, point)).toBeCloseTo(0.2, 3);
    const before = wall.hp;
    const shell = WEAPONS.cannon.projectile.explosion!;
    explode(sim, point, shell, vec3(0, 0, -1), add(point, vec3(0, 0, 5)));
    const dealt = before - wall.hp;
    expect(dealt).toBeGreaterThan(shell.damage * 0.8 * (propDef("brick").resist?.explosive ?? 1));
  });

  it("la citerne de l'usine explose, et fait sauter ses voisines", () => {
    const tanks = sim.props.filter((p) => p.type === "tank");
    const first = tanks[0];
    // Les voisines, relevées avant l'explosion (un corps retiré ne se relit pas)
    const center = first.rb.translation();
    const neighbours = tanks.filter((t) => t !== first && propDistance(t, center) < 4);
    expect(neighbours.length).toBeGreaterThan(0);
    knockDown(first);
    run(3);
    expect(sim.props.includes(first)).toBe(false);
    for (const t of neighbours) expect(sim.props.includes(t)).toBe(false);
    expect(events.filter((e) => e.type === "explosion").length).toBeGreaterThan(1);
  });

  it("pour aller sur le pont, un robot passe par l'un de ses bouts, pas par-dessous", () => {
    const profile = PRESET_BOTS.find((p) => p.id === "buggy")!;
    const below = vec3(10, groundLevel(sim.arena, 10, -2) + groundHeight(profile.design) + 0.05, -2);
    const bot = spawnBot(sim, profile, below, 0, "blue");
    sim.bots.push(bot);
    const deck = VALLEY.boxes.find((b) => b.kind === "deck" && b.half.x > 1)!;
    // Au bord de la rivière, à l'est du pont : il vise l'abord d'un bout du pont, dans son axe
    const goal = navigate(sim, bot, below, vec3(0, 0, 0));
    expect(Math.abs(goal.x)).toBeLessThan(1);
    expect(Math.abs(goal.z)).toBeGreaterThan(deck.half.z);
    // Dans l'axe, devant le bout du pont : droit sur la destination
    const front = vec3(0, groundLevel(sim.arena, 0, -19) + 1, -19);
    expect(navigate(sim, bot, front, vec3(0, 0, 0)).z).toBeCloseTo(0, 3);
  });

  it("chaque accessoire a ses dimensions, et les bâtiments ont leurs appuis", () => {
    for (const spot of VALLEY.props) {
      const half = propHalf(spot.type, spot);
      expect(Math.min(half.x, half.y, half.z), spot.type).toBeGreaterThan(0.02);
      for (const r of spot.rests ?? []) expect(VALLEY.props[r], spot.type).toBeDefined();
    }
    expect(VALLEY.props.some((s) => s.diamond)).toBe(true);
    expect(sim.props.length).toBe(VALLEY.props.length);
    expect(sim.props.filter((p) => p.fixed).length).toBeGreaterThan(200);
  });
});
