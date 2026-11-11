import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mergeSegments, surfaceSegment } from "../src/client/render/surfaceModels";
import { applyDamage } from "../src/shared/combat/damage";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { vec3, NO_ROTATION } from "../src/shared/math/vec";
import { flapGroups } from "../src/shared/robot/aero";
import {
  carrierCell, designSurfaceSides, flapRuns, hingeChord, linkedAt,
  CLOSED_LEFT, CLOSED_RIGHT, SEAMLESS_FRONT, SEAMLESS_REAR, SIDE_FRONT, SIDE_LEFT, SIDE_REAR, SIDE_RIGHT, SIDES_ALONE,
} from "../src/shared/robot/surfaces";
import type { AeroSurface, Bot } from "../src/shared/sim/entities";
import { takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { LETHAL } from "./helpers";
import { seedRandom } from "./seed";

/*
 * Ailes et gouvernes en rangs (shared/robot/surfaces.ts) : des gouvernes bout à bout font une seule
 * gouverne, qui braque d'un seul angle ; un bloc détruit au milieu coupe le rang, un morceau arraché
 * emporte les siens ; le profil de chaque case dépend de ce qui la touche (render/surfaceModels.ts).
 */

const DOWN = vec3(0, -1, 0);
const FAR = vec3(0, 60, 0);
const keys = (run: readonly AeroSurface[]): string[] => run.map((s) => s.block.key).sort();

describe("ailes et gouvernes en rangs", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(3);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  const plane = (): Bot => {
    spawnWave(sim, PRESET_BOTS.filter((p) => p.id === "plane"));
    return sim.bots[0];
  };
  const kill = (bot: Bot, key: string): void => {
    applyDamage(sim, bot.lastPos, DOWN, LETHAL, { kind: "block", block: bot.blocks.get(key)! }, FAR);
  };
  /** Le rang qui contient ce bloc. */
  const runOf = (bot: Bot, key: string): AeroSurface[] => flapRuns(bot).find((r) => r.some((s) => s.block.key === key))!;

  it("des gouvernes bout à bout font une seule gouverne ; deux rangs l'un derrière l'autre en font deux", () => {
    const bot = plane();
    // Ailerons : deux rangs de trois de chaque côté ; profondeur : un rang de cinq ; direction : deux, à la verticale
    expect(flapRuns(bot).map((r) => r.length).sort()).toEqual([2, 3, 3, 3, 3, 5]);
    expect(keys(runOf(bot, "0,0,-6"))).toEqual(["-1,0,-6", "-2,0,-6", "0,0,-6", "1,0,-6", "2,0,-6"]);
    expect(keys(runOf(bot, "0,1,-6"))).toEqual(["0,1,-6", "0,2,-6"]);
    expect(keys(runOf(bot, "5,0,0"))).toEqual(["4,0,0", "5,0,0", "6,0,0"]);
    expect(keys(runOf(bot, "5,0,-1"))).toEqual(["4,0,-1", "5,0,-1", "6,0,-1"]);
    // Le mélangeur raisonne par rang
    expect(flapGroups(bot)).toHaveLength(6);
  });

  it("toute la gouverne braque du même angle ; les ailerons, en sens opposés", () => {
    const bot = plane();
    takeControl(bot, sim.input);
    Object.assign(sim.input, { manual: true, power: 1, steer: 1, climb: 0.5 });
    for (let i = 0; i < 40; i++) sim.step();
    for (const run of flapRuns(bot)) {
      for (const s of run) expect(s.deflection).toBe(run[0].deflection);
    }
    const left = runOf(bot, "5,0,0")[0].deflection;
    const right = runOf(bot, "-5,0,0")[0].deflection;
    expect(Math.abs(left)).toBeGreaterThan(0.1);
    expect(Math.sign(left)).toBe(-Math.sign(right));
  });

  it("un bloc détruit au milieu coupe le rang en deux ; un morceau arraché emporte les siens", () => {
    const bot = plane();
    takeControl(bot, sim.input);
    Object.assign(sim.input, { manual: true, power: 1, steer: 1 });
    kill(bot, "0,0,-6");
    expect(keys(runOf(bot, "1,0,-6"))).toEqual(["1,0,-6", "2,0,-6"]);
    expect(keys(runOf(bot, "-1,0,-6"))).toEqual(["-1,0,-6", "-2,0,-6"]);
    // Les deux moitiés de la profondeur sont deux gouvernes : le mélangeur peut s'en servir pour rouler
    for (let i = 0; i < 40; i++) sim.step();
    expect(flapGroups(bot)).toHaveLength(7);
    expect(runOf(bot, "1,0,-6")[0].deflection).not.toBeCloseTo(runOf(bot, "-1,0,-6")[0].deflection, 3);
    // Le fuselage coupé devant l'empennage : la queue part avec sa profondeur et sa direction
    kill(bot, "0,0,-4");
    const tail = bot.blocks.get("1,0,-6")!.part;
    expect(tail).not.toBe(bot.cockpit.part);
    expect(keys(runOf(bot, "1,0,-6"))).toEqual(["1,0,-6", "2,0,-6"]);
    expect(runOf(bot, "0,1,-6").every((s) => s.block.part === tail)).toBe(true);
    // Le mélangeur ne braque plus que les gouvernes reliées au cockpit : les quatre rangs d'ailerons
    expect(flapGroups(bot).map((g) => g.length)).toEqual([3, 3, 3, 3]);
  });

  it("charnière : derrière ce qui la porte, ou au milieu d'une gouverne monobloc ; un volet est porté par l'aileron devant lui", () => {
    const bot = plane();
    const blocks = (key: string) => runOf(bot, key).map((s) => s.block);
    // Profondeur : derrière l'empennage, au centre de l'arrondi de son bord d'attaque
    expect(hingeChord(blocks("0,0,-6"), linkedAt)).toBeCloseTo(-5.5 * 0.5 - 0.05, 6);
    // Rang avant de l'aileron : rien devant lui, il pivote au milieu de sa corde
    expect(hingeChord(blocks("5,0,0"), linkedAt)).toBeCloseTo(0, 6);
    // Rang arrière : derrière le rang avant, qui le porte
    expect(hingeChord(blocks("5,0,-1"), linkedAt)).toBeCloseTo(-0.5 * 0.5 - 0.05, 6);
    expect(carrierCell(blocks("5,0,-1"), linkedAt)?.z).toBe(0);
    expect(carrierCell(blocks("5,0,0"), linkedAt)).toBeNull();
    expect(carrierCell(blocks("0,0,-6"), linkedAt)).toBeNull(); // l'empennage est une aile, pas une gouverne
  });
});

describe("profil des cases", () => {
  const sides = designSurfaceSides(PRESET_BOTS.find((p) => p.id === "plane")!.design.blocks);

  it("un côté qui ne touche rien est façonné ; entre deux ailes du même plan, rien n'est dessiné", () => {
    // Emplanture de l'aile, rang avant : bord d'attaque arrondi, l'aile continue derrière et vers le
    // bout ; contre le fuselage, une face droite
    expect(sides.get("1,0,0")).toBe(SIDE_FRONT | SEAMLESS_REAR | CLOSED_RIGHT);
    expect(sides.get("1,0,-1")).toBe(SIDE_REAR | SEAMLESS_FRONT | CLOSED_RIGHT);
    expect(sides.get("2,0,0")).toBe(SIDE_FRONT | SEAMLESS_REAR);
    // Contre l'aileron (qui pivote) : une face droite, de part et d'autre
    expect(sides.get("3,0,0")).toBe(SIDE_FRONT | SEAMLESS_REAR | CLOSED_LEFT);
    expect(sides.get("4,0,0")).toBe(SIDE_FRONT | CLOSED_RIGHT);
    // Bout de l'aileron : le bord d'attaque d'une gouverne est toujours arrondi (sa charnière), saumon au bout
    expect(sides.get("6,0,0")).toBe(SIDE_FRONT | SIDE_LEFT);
    expect(sides.get("6,0,-1")).toBe(SIDE_FRONT | SIDE_REAR | SIDE_LEFT);
    expect(sides.get("-6,0,0")).toBe(SIDE_FRONT | SIDE_RIGHT);
    // Empennage : devant, rien ; derrière, la profondeur (une gouverne : bord droit, pas d'une pièce avec elle)
    expect(sides.get("1,0,-5")).toBe(SIDE_FRONT | CLOSED_RIGHT);
    expect(sides.get("2,0,-6")).toBe(SIDE_FRONT | SIDE_REAR | SIDE_LEFT);
    // Pas une surface : rien
    expect(sides.has("0,0,0")).toBe(false);
  });

  it("chaque profil est tourné vers le dehors, dans sa case ; deux cases d'un rang se rejoignent bord à bord", () => {
    for (let s = 0; s < 256; s++) {
      if ((s & SIDE_FRONT && s & SEAMLESS_FRONT) || (s & SIDE_REAR && s & SEAMLESS_REAR)) continue;
      if ((s & SIDE_LEFT && s & CLOSED_LEFT) || (s & SIDE_RIGHT && s & CLOSED_RIGHT)) continue;
      const g = surfaceSegment(s);
      const p = (i: number) => vec3(g.positions[3 * i], g.positions[3 * i + 1], g.positions[3 * i + 2]);
      const n = (i: number) => vec3(g.normals[3 * i], g.normals[3 * i + 1], g.normals[3 * i + 2]);
      for (let i = 0; i < g.positions.length / 3; i++) {
        const v = p(i);
        expect(Math.max(Math.abs(v.x), Math.abs(v.z))).toBeLessThanOrEqual(0.25 + 1e-9);
        expect(Math.abs(v.y)).toBeLessThanOrEqual(0.05 + 1e-9);
      }
      // Chaque triangle tourne sa face (sens des aiguilles d'une montre vu de dehors) du côté de ses normales
      for (let t = 0; t < g.indices.length; t += 3) {
        const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
        const [pa, pb, pc] = [p(a), p(b), p(c)];
        const e1 = vec3(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
        const e2 = vec3(pc.x - pa.x, pc.y - pa.y, pc.z - pa.z);
        const cross = vec3(e1.y * e2.z - e1.z * e2.y, e1.z * e2.x - e1.x * e2.z, e1.x * e2.y - e1.y * e2.x);
        const area = Math.hypot(cross.x, cross.y, cross.z);
        if (area < 1e-8) continue;
        const nn = [n(a), n(b), n(c)].reduce((acc, v) => vec3(acc.x + v.x, acc.y + v.y, acc.z + v.z));
        // (au bout du saumon, une facette vue par la tranche a des normales dans son plan : produit nul)
        expect(cross.x * nn.x + cross.y * nn.y + cross.z * nn.z, `profil ${s}`).toBeLessThan(1e-9 * area);
      }
    }
    // Deux cases d'un rang, côte à côte : le dessus de l'une s'arrête exactement où commence celui de l'autre
    const { geometry, ranges } = mergeSegments([
      { sides: SIDE_FRONT | SIDE_RIGHT, rot: NO_ROTATION, pos: vec3(0, 0, 0) },
      { sides: SIDE_FRONT | SIDE_LEFT, rot: NO_ROTATION, pos: vec3(0.5, 0, 0) },
    ]);
    const top = (range: [number, number]): number[] => {
      const xs: number[] = [];
      for (let i = range[0]; i < range[0] + range[1]; i++) if (Math.abs(geometry.positions[3 * i + 1] - 0.05) < 1e-9) xs.push(geometry.positions[3 * i]);
      return xs;
    };
    expect(Math.max(...top(ranges[0]))).toBe(0.25);
    expect(Math.min(...top(ranges[1]))).toBe(0.25);
    // … et rien entre elles : pas de face tournée vers la voisine (elle rayait la peau d'un pointillé)
    const facing = (range: [number, number], nx: number): number => {
      let count = 0;
      for (let i = range[0]; i < range[0] + range[1]; i++) if (geometry.normals[3 * i] === nx) count++;
      return count;
    };
    expect(facing(ranges[0], 1)).toBe(0);
    expect(facing(ranges[1], -1)).toBe(0);
    expect(surfaceSegment(SIDES_ALONE).indices.length).toBeGreaterThan(0);
  });
});
