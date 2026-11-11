import { beforeAll, describe, expect, it } from "vitest";
import { ARENAS } from "../src/shared/arena/layout";
import { blockDef } from "../src/shared/catalog/blocks";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { readMap } from "../src/shared/map/read";
import { blankMap } from "../src/shared/map/template";
import { axisAngle, qrot, vec3, type Vec3 } from "../src/shared/math/vec";
import { spawnBot } from "../src/shared/robot/lifecycle";
import { blockWorldPos } from "../src/shared/robot/queries";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { chooseLights, KEEP, LIGHT_SIGHT, type LightRequest } from "../src/client/render/lightChoice";
import { gatherLights, lampColors, lampLevels, LIGHT_BLOCKS, lightPowered, sweepDirection, type LightContext } from "../src/client/render/lightSources";
import { LIGHT_LENSES } from "../src/client/render/models/lights";
import { DesignGrid } from "../src/shared/design/robotDesign";
import type { BotProfile } from "../src/shared/design/presets";

/*
 * La nuit : la Cité de nuit, les phares et les balises des robots, ce que demande chaque source de
 * lumière (render/lightSources.ts, sans Babylon) et le choix des lumières de la réserve
 * (render/lightChoice.ts). Le rendu lui-même (les lumières en grappes de Babylon) se vérifie dans
 * le navigateur.
 */

beforeAll(async () => {
  await initPhysics();
});

const req = (key: string, at: Vec3, intensity: number, range: number): LightRequest =>
  ({ key, x: at.x, y: at.y, z: at.z, r: 1, g: 1, b: 1, intensity, range });
const eye = vec3(0, 2, 0);

describe("choix des lumières", () => {
  it("garde les plus utiles à la caméra, dans la limite de la réserve", () => {
    const near = req("près", vec3(5, 2, 0), 1, 8);
    const far = req("loin", vec3(80, 2, 0), 1, 8);
    const strong = req("fort", vec3(40, 2, 0), 3, 20);
    expect(chooseLights([far, near, strong], eye, 2, new Set()).map((r) => r.key)).toEqual(["près", "fort"]);
    expect(chooseLights([far, near, strong], eye, 5, new Set())).toHaveLength(3);
    expect(chooseLights([near], eye, 0, new Set())).toEqual([]);
  });

  it("une lumière déjà allumée garde sa place devant une à peine plus utile (pas de clignotement)", () => {
    const a = req("a", vec3(20, 2, 0), 1, 8);
    const b = req("b", vec3(19, 2, 0), 1, 8);
    expect(chooseLights([a, b], eye, 1, new Set())[0].key).toBe("b");
    expect(chooseLights([a, b], eye, 1, new Set(["a"]))[0].key).toBe("a");
    // Mais pas devant une nettement plus utile
    const c = req("c", vec3(19, 2, 0), KEEP * 1.5, 8);
    expect(chooseLights([a, c], eye, 1, new Set(["a"]))[0].key).toBe("c");
  });

  it("rien de ce qu'on ne verrait pas (trop loin dans le brouillard, éteint)", () => {
    expect(chooseLights([req("x", vec3(LIGHT_SIGHT + 30, 2, 0), 5, 10)], eye, 4, new Set())).toEqual([]);
    expect(chooseLights([req("y", vec3(5, 2, 0), 0, 10)], eye, 4, new Set())).toEqual([]);
  });
});

describe("la Cité de nuit", () => {
  it("est la Cité sous la lune : les mêmes rues, des lampes en plus", () => {
    const day = ARENAS.city;
    const night = ARENAS.cityNight;
    expect(night.sky?.night).toBe(true);
    expect(day.sky?.night).toBeFalsy();
    expect(night.boxes).toBe(day.boxes);
    expect(night.zones).toBe(day.zones);
    expect(night.bounds).toEqual(day.bounds);
    // Les accessoires de la Cité aux mêmes rangs (les appuis des toits renvoient à leurs rangs), puis les lampes
    expect(night.props.slice(0, day.props.length)).toEqual(day.props);
    const added = night.props.slice(day.props.length);
    expect(added.length).toBeGreaterThan(10);
    expect(added.every((p) => p.type === "lamppost" || p.type === "floodlight")).toBe(true);
    expect(added.filter((p) => p.type === "floodlight").length).toBeGreaterThanOrEqual(6);
  });

  it("ses lampes sont loin des lignes de départ", () => {
    const { spawnLine, spawnSpread } = ARENAS.cityNight.bounds;
    for (const p of ARENAS.cityNight.props.slice(ARENAS.city.props.length)) {
      const off = Math.abs(Math.abs(p.pos.z) - (spawnLine ?? 0));
      expect(off > 8 || Math.abs(p.pos.x) > (spawnSpread ?? 0) + 8).toBe(true);
    }
  });
});

describe("phares et balises", () => {
  it("un phare éclaire en cône le long de son haut, une balise tout autour, de la couleur de son équipe", () => {
    expect(blockDef("headlight").light).toMatchObject({ kind: "spot" });
    expect(blockDef("headlight").light!.cone).toBeGreaterThan(0.5);
    expect(blockDef("beacon").light).toMatchObject({ kind: "point", color: "team" });
  });

  it("des robots prédéfinis en portent, et leur plan les recense", () => {
    const sim = new Simulation();
    const truck = spawnBot(sim, PRESET_BOTS.find((p) => p.id === "truck")!, vec3(0, 2, 0), 0, "blue");
    expect(truck.lights.map((b) => b.type).sort()).toEqual(["beacon", "headlight", "headlight"]);
    for (const b of truck.lights) expect(lightPowered(sim, b)).toBe(true);
    // Paralysé, éteint ; le cockpit perdu, éteint
    truck.lights[0].stunnedUntil = sim.time + 1;
    expect(lightPowered(sim, truck.lights[0])).toBe(false);
    truck.cockpit.alive = false;
    expect(lightPowered(sim, truck.lights[1])).toBe(false);
  });
});

describe("ce qui éclaire", () => {
  const context = (sim: Simulation, night: boolean, effects: boolean): LightContext => ({ world: sim, night, effects, now: 0, barriers: [], burning: [] });

  it("la nuit, les lampes debout de la Cité et les phares des robots", () => {
    const sim = new Simulation();
    sim.loadArena("cityNight");
    const yaw = 0.7;
    const truck = spawnBot(sim, PRESET_BOTS.find((p) => p.id === "truck")!, vec3(0, 5, 0), yaw, "red");
    sim.bots.push(truck);
    const out: LightRequest[] = [];
    gatherLights(context(sim, true, false), out);
    const props = new Set<unknown>(sim.props);
    const lamps = out.filter((r) => props.has(r.key));
    const floods = lamps.filter((r) => (r.key as { type: string }).type === "floodlight");
    expect(floods.length).toBeGreaterThanOrEqual(6);
    expect(lamps.length).toBeGreaterThan(30);
    // Un lampadaire éclaire vers le bas, depuis la tête de son bras
    for (const r of lamps) expect(r.dir!.y).toBeLessThan(-0.5);
    // Les phares du Camion : devant lui, vers l'avant du robot
    const forward = qrot(axisAngle(vec3(0, 1, 0), yaw), vec3(0, 0, 1));
    const heads = out.filter((r) => truck.lights.some((b) => b === r.key && b.type === "headlight"));
    expect(heads).toHaveLength(2);
    for (const r of heads) {
      expect(r.dir!.x * forward.x + r.dir!.y * forward.y + r.dir!.z * forward.z).toBeGreaterThan(0.95);
      const block = truck.lights.find((b) => b === r.key)!;
      const at = blockWorldPos(block);
      expect((r.x - at.x) * forward.x + (r.z - at.z) * forward.z).toBeGreaterThan(0.2);
    }
    // La balise, de la couleur des rouges
    const beacon = out.find((r) => truck.lights.some((b) => b === r.key && b.type === "beacon"))!;
    expect(beacon.dir).toBeUndefined();
    expect(beacon.r).toBeGreaterThan(beacon.b);
  });

  it("le jour, ni lampes ni phares ; un lampadaire couché ou abattu s'éteint", () => {
    const sim = new Simulation();
    sim.loadArena("cityNight");
    sim.bots.push(spawnBot(sim, PRESET_BOTS.find((p) => p.id === "truck")!, vec3(0, 5, 0), 0, "red"));
    const day: LightRequest[] = [];
    gatherLights(context(sim, false, false), day);
    expect(day).toEqual([]);
    const before: LightRequest[] = [];
    gatherLights(context(sim, true, false), before);
    const lamp = [...sim.props].find((p) => p.type === "lamppost")!;
    lamp.rb.setRotation(axisAngle(vec3(1, 0, 0), Math.PI / 2), true);
    const after: LightRequest[] = [];
    gatherLights(context(sim, true, false), after);
    expect(after.some((r) => r.key === lamp)).toBe(false);
    expect(after).toHaveLength(before.length - 1);
  });

  it("avec les lumières dynamiques, ce qui brille en vol : un leurre, un tir de plasma ; une balle ordinaire, non", () => {
    const sim = new Simulation();
    const flare = sim.fire("flare", vec3(0, 3, 0), vec3(1, 0, 0));
    const plasma = sim.fire("plasma", vec3(0, 3, 5), vec3(1, 0, 0));
    const rifles = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => sim.fire("rifle", vec3(0, 3, 10 + i), vec3(1, 0, 0)));
    const off: LightRequest[] = [];
    gatherLights(context(sim, false, false), off);
    expect(off).toEqual([]);
    const on: LightRequest[] = [];
    gatherLights(context(sim, false, true), on);
    const lit = (key: unknown): LightRequest | undefined => on.find((r) => r.key === key);
    expect(lit(flare)!.intensity).toBeGreaterThan(1.5);
    expect(lit(flare)!.range).toBeGreaterThan(10);
    expect(lit(plasma)).toBeDefined();
    // Une balle sur quatre est une traçante : elle seule brille
    expect(rifles.filter((p) => lit(p)).length).toBe(2);
  });
});

describe("la nuit dans le format des cartes", () => {
  it("se lit, s'écrit, et refuse ce qui n'est pas un booléen", () => {
    const map = { ...blankMap({ name: "Nuit", author: "Tests" }), sky: { color: "#141b2b", fog: 0.0095, night: true } };
    const read = readMap(map);
    expect(read.ok && read.map.sky?.night).toBe(true);
    const day = readMap({ ...map, sky: { color: "#bfd0db", fog: 0.004 } });
    expect(day.ok && day.map.sky && "night" in day.map.sky).toBe(false);
    const bad = readMap({ ...map, sky: { color: "#141b2b", fog: 0.0095, night: "oui" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toContainEqual({ code: "field", path: "sky.night" });
  });
});

describe("feux décoratifs", () => {
  it("chaque lumière a son verre et ses couleurs, un par feu", () => {
    for (const type of LIGHT_BLOCKS) {
      const lenses = LIGHT_LENSES[type];
      expect(lenses, type).toBeDefined();
      expect(lampColors(type, 1, "blue")).toHaveLength(lenses!.length);
    }
  });

  it("un feu de position est rouge à gauche du robot, vert à droite, blanc au milieu ; une rampe de police, bleue puis rouge", () => {
    const [left] = lampColors("navLight", 3, "blue");
    const [right] = lampColors("navLight", -3, "blue");
    const [middle] = lampColors("navLight", 0, "blue");
    expect(left).toBe("#ff2a1e");
    expect(right).toBe("#1eff5a");
    expect(middle).toBe("#f4f8ff");
    expect(lampColors("policeBar", 0, "red")).toEqual(["#2f78ff", "#ff2a1e"]);
    // Une balise prend la couleur de son équipe
    expect(lampColors("beacon", 0, "red")).not.toEqual(lampColors("beacon", 0, "blue"));
  });

  it("à leur rythme : un feu à éclats ne brille qu'un instant, une rampe alterne ses deux feux", () => {
    // (une période du feu à éclats, 1,2 s, en 1 000 instants)
    const samples = (pattern: Parameters<typeof lampLevels>[0], i = 0): number[] => Array.from({ length: 1000 }, (_, k) => lampLevels(pattern, k * 0.0012, 7)[i]);
    const strobe = samples("strobe");
    const lit = strobe.filter((v) => v > 0.5).length / strobe.length;
    expect(lit).toBeGreaterThan(0.04);
    expect(lit).toBeLessThan(0.15);
    // Deux éclats par période : deux montées (la période boucle sur elle-même)
    expect(strobe.filter((v, k) => v > 0.5 && strobe[(k + strobe.length - 1) % strobe.length] <= 0.5).length).toBe(2);
    for (let k = 0; k < 900; k++) {
      const [blue, red] = lampLevels("wigwag", k / 1000, 3);
      expect(blue > 0 && red > 0).toBe(false);
    }
    const blue = Array.from({ length: 900 }, (_, k) => lampLevels("wigwag", k / 1000, 3)[0]);
    expect(blue.some((v) => v > 0)).toBe(true);
    expect(lampLevels("steady", 5, 1)).toEqual([1]);
    expect(lampLevels("pulse", 5, 1)[0]).toBeGreaterThan(0.45);
  });

  it("le faisceau d'un gyrophare fait le tour, un peu penché vers le bas", () => {
    const a = sweepDirection(0, 4);
    const b = sweepDirection(0.45, 4);
    expect(a.y).toBeLessThan(0);
    expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(1, 6);
    // Un demi-tour en une demi-période
    expect(a.x * b.x + a.z * b.z).toBeLessThan(-0.8);
  });

  it("un robot qui porte tous les feux les allume, la nuit, à leur rythme", () => {
    const g = new DesignGrid();
    g.box(-2, 2, 0, 0, -2, 2, "frame");
    g.put(0, 1, 0, "cockpit");
    g.put(2, 1, 2, "navLight").put(-2, 1, 2, "navLight");
    g.put(0, -1, 0, "strobe", { up: "-y", forward: "+z" });
    g.put(0, 1, -2, "antiCollision");
    g.put(1, 1, 0, "rotatingLight");
    g.put(-1, 1, 0, "policeBar");
    const profile: BotProfile = { id: "garage:feux", color: "#888888", speed: 3, turn: 2, behavior: "flee", mobility: "ground", design: { blocks: g.blocks(), wheels: [] } };
    const sim = new Simulation();
    const bot = spawnBot(sim, profile, vec3(0, 3, 0), 0, "blue");
    sim.bots.push(bot);
    expect(bot.lights).toHaveLength(6);
    const at = (time: number): LightRequest[] => {
      (sim as { time: number }).time = time;
      const out: LightRequest[] = [];
      gatherLights({ world: sim, night: true, effects: false, now: time, barriers: [], burning: [] }, out);
      return out;
    };
    const lightsOf = (out: LightRequest[], type: string): LightRequest[] => out.filter((r) => {
      const id = typeof r.key === "string" ? Number(r.key.split(":")[1]) : (r.key as { id: number }).id;
      return bot.lights.some((b) => b.id === id && b.type === type);
    });
    // Les feux de position, toujours ; le gyrophare, un cône qui tourne
    const t0 = at(10);
    expect(lightsOf(t0, "navLight")).toHaveLength(2);
    const sweep0 = lightsOf(t0, "rotatingLight")[0];
    expect(sweep0.dir).toBeDefined();
    expect(sweep0.beam).toBeGreaterThan(0);
    const sweep1 = lightsOf(at(10.3), "rotatingLight")[0];
    expect(sweep0.dir!.x * sweep1.dir!.x + sweep0.dir!.z * sweep1.dir!.z).toBeLessThan(0.9);
    // Le feu à éclats et la rampe : parfois allumés, parfois non, et d'un coup
    let strobe = 0, police = 0, both = 0;
    for (let k = 0; k < 240; k++) {
      const out = at(20 + k / 120);
      const s = lightsOf(out, "strobe");
      const p = lightsOf(out, "policeBar");
      if (s.length) strobe++;
      if (p.length) police++;
      if (p.length === 2) both++;
      for (const r of [...s, ...p]) expect(r.sudden).toBe(true);
    }
    expect(strobe).toBeGreaterThan(0);
    expect(strobe).toBeLessThan(80);
    expect(police).toBeGreaterThan(40);
    expect(both).toBe(0);
  });
});
