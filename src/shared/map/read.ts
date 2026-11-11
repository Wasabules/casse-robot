import { ARENA_IDS, type ArenaId, type BoxLook, type PathSurface, type StaticKind } from "../arena/layout";
import { PROP_TYPES, type PropType } from "../catalog/props";
import { terrainCodes } from "./codec";
import {
  MAP_FORMAT, MAP_LIMITS, type MapBox, type MapCounted, type MapFall, type MapFile, type MapGround, type MapIssue, type MapLava,
  type MapMeta, type MapPath, type MapPlace, type MapPoint, type MapPrefab, type MapProp, type MapSize, type MapSpawn, type MapSpawns, type MapTerrain, type MapVent,
  type MapZone, type RoofMaterial, type TreeType, type WallMaterial,
} from "./format";

/*
 * Lecture d'une carte venue d'ailleurs (un fichier, le réseau) : une entrée non fiable. Tout est
 * vérifié et recopié champ par champ (types, nombres finis et bornés, textes bornés, listes
 * bornées), les champs inconnus sont ignorés : ce qui sort est une `MapFile` propre, ou la liste de
 * ce qui ne va pas (`MapIssue`). Rien ici ne lève d'exception ni ne fait de travail démesuré, quelle
 * que soit l'entrée : le serveur lit ainsi les cartes de son dossier, le client celles qu'il importe
 * ou qu'un serveur lui envoie. Une carte d'un format plus ancien passe d'abord par `upgradeMap`.
 */

/** Au plus autant de problèmes signalés : au-delà, la carte est de toute façon à reprendre. */
const MAX_ISSUES = 24;

/** Migration d'une version du format à la suivante (`n` → `n + 1`), sur le JSON brut. */
export type MapMigration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Les migrations du format, par version de départ (comme `upgradeDesign` pour les robots). Le
 * format 1 est le premier : aucune encore. Quand le format changera, `MAP_FORMAT` passera à 2 et
 * `MAP_MIGRATIONS[1]` fera d'une carte du format 1 une carte du format 2.
 */
export const MAP_MIGRATIONS: Readonly<Record<number, MapMigration>> = {};

export type ReadResult = { ok: true; map: MapFile } | { ok: false; issues: MapIssue[] };

/** Exhaustifs : TypeScript réclame toute nouvelle sorte de boîte, allure, revêtement. */
const STATIC_KINDS: Record<StaticKind, true> = {
  wall: true, ramp: true, pillar: true, platform: true, barrier: true, rock: true, container: true, deck: true, road: true, bound: true, tower: true, track: true,
};
const BOX_LOOKS: Record<BoxLook, true> = {
  sandstone: true, timber: true, rail: true, wagon: true, wood: true, basalt: true, rust: true,
  quay: true, steel: true, hull: true, superstructure: true, hatch: true, funnel: true, lighthouse: true, lamp: true, silo: true, container: true,
};
const PATH_SURFACES: Record<PathSurface, true> = { dirt: true, grass: true, sand: true, road: true, gravel: true, ballast: true, asphalt: true };
const WALLS: Record<WallMaterial, true> = { brick: true, concrete: true, plank: true, sheet: true };
const ROOFS: Record<RoofMaterial, true> = { roof: true, sheet: true, concrete: true, plank: true };
const TREES: Record<TreeType, true> = { pine: true, oak: true, palm: true, kapok: true, cactus: true };
const FACADES = { facade: true, tenement: true, brick: true, concrete: true } as const;
const SIDES = { n: true, s: true, w: true, e: true } as const;

const COLOR = /^#[0-9a-fA-F]{6}$/;
const LANGUAGE = /^[a-z]{2}$/;
const ZONE_LABEL = /^[A-E]$/;

type Raw = Record<string, unknown>;

/** Lecteur : chaque méthode lit un champ, le borne, et note ce qui ne va pas (le chemin du champ fautif). */
class Reader {
  readonly issues: MapIssue[] = [];

  fail(issue: MapIssue): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push(issue);
  }

  bad(path: string): void {
    this.fail({ code: "field", path });
  }

  obj(v: unknown, path: string): Raw | null {
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Raw;
    this.bad(path);
    return null;
  }

  /** Un nombre fini dans [min, max] (entier si `int`) ; mal formé : 0, et le problème noté. */
  num(v: unknown, path: string, min: number, max: number, int = false): number {
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v))) return v;
    this.bad(path);
    return Math.max(min, Math.min(max, 0));
  }

  /** Un nombre facultatif : absent, undefined. */
  optNum(v: unknown, path: string, min: number, max: number, int = false): number | undefined {
    return v === undefined ? undefined : this.num(v, path, min, max, int);
  }

  coord(v: unknown, path: string): number {
    return this.num(v, path, -MAP_LIMITS.reach, MAP_LIMITS.reach);
  }

  height(v: unknown, path: string): number | undefined {
    return this.optNum(v, path, MAP_LIMITS.minY, MAP_LIMITS.maxY);
  }

  /** Un angle (degrés) : n'importe quel nombre fini, ramené à ]-360, 360[. */
  angle(v: unknown, path: string): number | undefined {
    if (v === undefined) return undefined;
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e6) return v % 360;
    this.bad(path);
    return 0;
  }

  bool(v: unknown, path: string): boolean | undefined {
    if (v === undefined) return undefined;
    if (typeof v === "boolean") return v;
    this.bad(path);
    return undefined;
  }

  /** Un texte, sans caractères de contrôle, débarrassé de ses blancs aux bouts ; au plus `max` caractères. */
  text(v: unknown, path: string, max: number, required: boolean): string | undefined {
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string") {
      this.bad(path);
      return required ? "" : undefined;
    }
    const clean = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (clean.length > max) this.fail({ code: "text", path, max });
    else if (required && !clean) this.bad(path);
    return clean.slice(0, max);
  }

  /** Un texte par langue : { "en": "…" }, au plus `MAP_LIMITS.languages`. */
  texts(v: unknown, path: string, max: number): Record<string, string> | undefined {
    if (v === undefined) return undefined;
    const o = this.obj(v, path);
    if (!o) return undefined;
    const keys = Object.keys(o);
    if (keys.length > MAP_LIMITS.languages) {
      this.fail({ code: "tooMany", what: "languages", count: keys.length, max: MAP_LIMITS.languages });
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const k of keys) {
      if (!LANGUAGE.test(k)) {
        this.bad(`${path}.${k.slice(0, 8)}`);
        continue;
      }
      const s = this.text(o[k], `${path}.${k}`, max, true);
      if (s) out[k] = s;
    }
    return keys.length ? out : undefined;
  }

  oneOf<T extends string>(v: unknown, path: string, values: Readonly<Record<T, unknown>>): T | undefined {
    if (typeof v === "string" && Object.hasOwn(values, v)) return v as T;
    this.bad(path);
    return undefined;
  }

  color(v: unknown, path: string): string {
    if (typeof v === "string" && COLOR.test(v)) return v.toLowerCase();
    this.bad(path);
    return "#808080";
  }

  optColor(v: unknown, path: string): string | undefined {
    return v === undefined ? undefined : this.color(v, path);
  }

  /** Une liste d'au plus `max` éléments (sinon le dépassement est noté et la liste ignorée). */
  list(v: unknown, path: string, max: number, what: MapCounted): unknown[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      this.bad(path);
      return [];
    }
    if (v.length > max) {
      this.fail({ code: "tooMany", what, count: v.length, max });
      return [];
    }
    return v;
  }

  point(v: unknown, path: string): MapPoint {
    if (Array.isArray(v) && v.length === 2) return [this.coord(v[0], `${path}[0]`), this.coord(v[1], `${path}[1]`)];
    this.bad(path);
    return [0, 0];
  }

  points(v: unknown, path: string, min: number): MapPoint[] {
    const list = this.list(v, path, MAP_LIMITS.points, "points");
    if (list.length < min) this.bad(path);
    return list.map((p, i) => this.point(p, `${path}[${i}]`));
  }

  size(v: unknown, path: string): MapSize {
    if (Array.isArray(v) && v.length === 3) {
      const s = (i: number): number => this.num(v[i], `${path}[${i}]`, 0.01, MAP_LIMITS.maxSize);
      return [s(0), s(1), s(2)];
    }
    this.bad(path);
    return [1, 1, 1];
  }

  /** Deux nombres [a, b] avec a ≤ b, dans [min, max]. */
  range(v: unknown, path: string, min: number, max: number): readonly [number, number] | undefined {
    if (v === undefined) return undefined;
    if (Array.isArray(v) && v.length === 2) {
      const a = this.num(v[0], `${path}[0]`, min, max);
      const b = this.num(v[1], `${path}[1]`, min, max);
      if (a <= b) return [a, b];
    }
    this.bad(path);
    return undefined;
  }
}

/** Un objet aux seuls champs définis (les facultatifs absents ne sont pas écrits : la forme canonique en dépend). */
function defined<T extends object>(o: T): T {
  const fields = o as Record<string, unknown>;
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  return o;
}

function readMeta(r: Reader, v: unknown): MapMeta {
  const o = r.obj(v, "meta") ?? {};
  const L = MAP_LIMITS;
  return defined({
    name: r.text(o.name, "meta.name", L.name, true) ?? "",
    names: r.texts(o.names, "meta.names", L.name),
    author: r.text(o.author, "meta.author", L.author, true) ?? "",
    description: r.text(o.description, "meta.description", L.description, false) || undefined,
    descriptions: r.texts(o.descriptions, "meta.descriptions", L.description),
    license: r.text(o.license, "meta.license", L.license, true) ?? "",
  });
}

function readTerrain(r: Reader, v: unknown): MapTerrain | undefined {
  if (v === undefined) return undefined;
  const o = r.obj(v, "terrain");
  if (!o) return undefined;
  const L = MAP_LIMITS;
  const cells = typeof o.cells === "number" ? o.cells : NaN;
  const step = typeof o.step === "number" ? o.step : NaN;
  if (!Number.isInteger(cells) || cells < L.minCells || cells > L.maxCells || !L.steps.includes(step) || cells * step > L.maxSide) {
    r.fail({ code: "terrainSize", cells: Number.isFinite(cells) ? cells : 0, step: Number.isFinite(step) ? step : 0 });
    return undefined;
  }
  const min = r.num(o.min, "terrain.min", L.minHeight, L.maxHeight);
  const max = r.num(o.max, "terrain.max", L.minHeight, L.maxHeight);
  if (max <= min) r.bad("terrain.max");
  // Les hauteurs : du base64, de la bonne longueur (vérifiée sans les décoder deux fois)
  if (typeof o.heights !== "string" || o.heights.length > L.bytes) {
    r.fail({ code: "terrainData" });
    return undefined;
  }
  const terrain: MapTerrain = { cells, step, min, max, heights: o.heights.replace(/\s+/g, "") };
  if (!terrainCodes(terrain)) {
    r.fail({ code: "terrainData" });
    return undefined;
  }
  return terrain;
}

function readBounds(r: Reader, v: unknown): MapFile["bounds"] {
  const o = r.obj(v, "bounds") ?? {};
  const L = MAP_LIMITS;
  return defined({
    half: r.num(o.half, "bounds.half", L.minHalf, L.maxHalf),
    roam: r.optNum(o.roam, "bounds.roam", 5, L.maxHalf),
    spawnLine: r.optNum(o.spawnLine, "bounds.spawnLine", 5, L.maxHalf),
    spawnSpread: r.optNum(o.spawnSpread, "bounds.spawnSpread", 2, L.maxHalf),
    circuit: r.optNum(o.circuit, "bounds.circuit", 10, L.maxHalf + 40),
    airFloor: r.optNum(o.airFloor, "bounds.airFloor", 0, 80),
    hoverFloor: r.optNum(o.hoverFloor, "bounds.hoverFloor", 0, 40),
  });
}

function readGround(r: Reader, v: unknown): MapGround | undefined {
  if (v === undefined) return undefined;
  const o = r.obj(v, "ground");
  if (!o) return undefined;
  const c = (k: string): string | undefined => r.optColor(o[k], `ground.${k}`);
  const n = (k: string, min: number, max: number): number | undefined => r.optNum(o[k], `ground.${k}`, min, max);
  let base: readonly [string, string] | undefined;
  if (o.base !== undefined) {
    base = Array.isArray(o.base) && o.base.length === 2 ? [r.color(o.base[0], "ground.base[0]"), r.color(o.base[1], "ground.base[1]")] : undefined;
    if (!base) r.bad("ground.base");
  }
  const strata = o.strata === undefined ? undefined : r.list(o.strata, "ground.strata", 12, "points").map((s, i) => r.color(s, `ground.strata[${i}]`));
  const patches = o.patches === undefined ? undefined : r.list(o.patches, "ground.patches", 32, "points").map((p, i) => {
    const q = r.obj(p, `ground.patches[${i}]`) ?? {};
    return { x: r.coord(q.x, `ground.patches[${i}].x`), z: r.coord(q.z, `ground.patches[${i}].z`), r: r.num(q.r, `ground.patches[${i}].r`, 0.5, 200), color: r.color(q.color, `ground.patches[${i}].color`) };
  });
  let slope: MapGround["slope"];
  if (o.slope !== undefined) {
    const s = r.obj(o.slope, "ground.slope") ?? {};
    slope = defined({ color: r.optColor(s.color, "ground.slope.color"), from: r.num(s.from, "ground.slope.from", 0, 1), span: r.num(s.span, "ground.slope.span", 0.01, 1) });
  }
  return defined({
    preset: o.preset === undefined ? undefined : r.oneOf<ArenaId>(o.preset, "ground.preset", Object.fromEntries(ARENA_IDS.map((id) => [id, true])) as Record<ArenaId, true>),
    base, dirt: c("dirt"), sand: c("sand"), mud: c("mud"), rock: c("rock"), peak: c("peak"),
    rockLine: n("rockLine", -50, 300), peakLine: n("peakLine", -50, 300), beach: n("beach", 0, 10),
    basalt: c("basalt"), basaltWidth: n("basaltWidth", 0, 30), strata, strataStep: n("strataStep", 0.2, 50), patches,
    grain: n("grain", 1, 100), stains: n("stains", 0, 1), slope, rockSpan: n("rockSpan", 0.1, 100), lawn: c("lawn"),
  });
}

function readLava(r: Reader, v: unknown, i: number): MapLava {
  const path = `lava[${i}]`;
  const o = r.obj(v, path) ?? {};
  if (o.kind === "pool") return { kind: "pool", x: r.coord(o.x, `${path}.x`), z: r.coord(o.z, `${path}.z`), r: r.num(o.r, `${path}.r`, 0.5, 120) };
  if (o.kind !== "flow") r.bad(`${path}.kind`);
  return { kind: "flow", width: r.num(o.width, `${path}.width`, 0.5, 60), points: r.points(o.points, `${path}.points`, 2) };
}

function readVent(r: Reader, v: unknown, i: number): MapVent {
  const path = `vents[${i}]`;
  const o = r.obj(v, path) ?? {};
  return defined({
    x: r.coord(o.x, `${path}.x`), z: r.coord(o.z, `${path}.z`), y: r.height(o.y, `${path}.y`),
    size: r.num(o.size, `${path}.size`, 0.2, 6), steam: r.bool(o.steam, `${path}.steam`),
  });
}

function readFall(r: Reader, v: unknown, i: number): MapFall {
  const path = `falls[${i}]`;
  const o = r.obj(v, path) ?? {};
  const top = r.num(o.top, `${path}.top`, MAP_LIMITS.minY, MAP_LIMITS.maxY);
  const bottom = r.num(o.bottom, `${path}.bottom`, MAP_LIMITS.minY, MAP_LIMITS.maxY);
  if (bottom >= top) r.bad(`${path}.bottom`);
  return {
    x: r.coord(o.x, `${path}.x`), z: r.coord(o.z, `${path}.z`), top, bottom,
    width: r.num(o.width, `${path}.width`, 0.2, 60), dir: r.angle(o.dir, `${path}.dir`) ?? 0,
  };
}

function readPath(r: Reader, v: unknown, i: number): MapPath {
  const path = `paths[${i}]`;
  const o = r.obj(v, path) ?? {};
  return defined({
    width: r.num(o.width, `${path}.width`, 0.5, 40),
    points: r.points(o.points, `${path}.points`, 2),
    surface: o.surface === undefined ? undefined : r.oneOf(o.surface, `${path}.surface`, PATH_SURFACES),
  });
}

function readTurn(r: Reader, o: Raw, path: string): { yaw?: number; pitch?: number; roll?: number } {
  return { yaw: r.angle(o.yaw, `${path}.yaw`), pitch: r.angle(o.pitch, `${path}.pitch`), roll: r.angle(o.roll, `${path}.roll`) };
}

function readBox(r: Reader, v: unknown, i: number): MapBox {
  const path = `boxes[${i}]`;
  const o = r.obj(v, path) ?? {};
  return defined({
    kind: r.oneOf(o.kind, `${path}.kind`, STATIC_KINDS) ?? "pillar",
    x: r.coord(o.x, `${path}.x`), z: r.coord(o.z, `${path}.z`), y: r.height(o.y, `${path}.y`),
    size: r.size(o.size, `${path}.size`),
    ...readTurn(r, o, path),
    look: o.look === undefined ? undefined : r.oneOf(o.look, `${path}.look`, BOX_LOOKS),
    round: r.bool(o.round, `${path}.round`),
    underpass: r.bool(o.underpass, `${path}.underpass`),
    approach: r.optNum(o.approach, `${path}.approach`, 0, 100),
  });
}

function readProp(r: Reader, v: unknown, i: number, count: number): MapProp {
  const path = `props[${i}]`;
  const o = r.obj(v, path) ?? {};
  const rests = o.rests === undefined ? undefined : r.list(o.rests, `${path}.rests`, 16, "points").map((k, j) => r.num(k, `${path}.rests[${j}]`, 0, Math.max(0, count - 1), true));
  return defined({
    type: r.oneOf<PropType>(o.type, `${path}.type`, PROP_TYPES) ?? "crate",
    x: r.coord(o.x, `${path}.x`), z: r.coord(o.z, `${path}.z`), y: r.height(o.y, `${path}.y`),
    ...readTurn(r, o, path),
    size: o.size === undefined ? undefined : r.size(o.size, `${path}.size`),
    scale: r.optNum(o.scale, `${path}.scale`, 0.2, 4),
    rests,
    group: r.optNum(o.group, `${path}.group`, 0, 10000, true),
  });
}

function readPrefab(r: Reader, v: unknown, i: number): MapPrefab | null {
  const path = `prefabs[${i}]`;
  const o = r.obj(v, path);
  if (!o) return null;
  const L = MAP_LIMITS;
  const at = (): { x: number; z: number } => ({ x: r.coord(o.x, `${path}.x`), z: r.coord(o.z, `${path}.z`) });
  const len = (k: string, min: number, max: number): number => r.num(o[k], `${path}.${k}`, min, max);
  const seed = (): number | undefined => r.optNum(o.seed, `${path}.seed`, 0, 2 ** 31, true);
  switch (o.kind) {
    case "house":
      return defined({
        kind: "house" as const, ...at(), y: r.height(o.y, `${path}.y`), yaw: r.angle(o.yaw, `${path}.yaw`),
        width: len("width", 2, 40), depth: len("depth", 2, 30), height: len("height", 1.5, 12),
        wall: r.oneOf(o.wall, `${path}.wall`, WALLS) ?? "brick", roof: r.oneOf(o.roof, `${path}.roof`, ROOFS) ?? "roof",
        roofKind: o.roofKind === undefined ? undefined : r.oneOf(o.roofKind, `${path}.roofKind`, { gable: true, flat: true }),
        door: r.optNum(o.door, `${path}.door`, 0.5, 38), through: r.bool(o.through, `${path}.through`),
      });
    case "tenement": {
      const doors = o.doors === undefined ? undefined : r.list(o.doors, `${path}.doors`, 16, "points").map((d, j) => {
        const ok = Array.isArray(d) && d.length === 2;
        if (!ok) r.bad(`${path}.doors[${j}]`);
        return [r.oneOf(ok ? d[0] : undefined, `${path}.doors[${j}][0]`, SIDES) ?? "s", r.num(ok ? d[1] : undefined, `${path}.doors[${j}][1]`, 0, 20, true)] as const;
      });
      return defined({
        kind: "tenement" as const, ...at(), y: r.height(o.y, `${path}.y`), yaw: r.angle(o.yaw, `${path}.yaw`),
        width: len("width", 4, 60), depth: len("depth", 4, 60), floors: r.num(o.floors, `${path}.floors`, 1, L.floors, true),
        wall: r.oneOf(o.wall, `${path}.wall`, FACADES) ?? "facade", doors,
        ruin: r.optNum(o.ruin, `${path}.ruin`, 0, 1), seed: seed(),
      });
    }
    case "fence":
      return defined({
        kind: "fence" as const, points: r.points(o.points, `${path}.points`, 2), height: r.optNum(o.height, `${path}.height`, 0.3, 6),
        material: o.material === undefined ? undefined : r.oneOf(o.material, `${path}.material`, WALLS),
      });
    case "woods":
      return defined({
        kind: "woods" as const, ...at(), radius: len("radius", 1, 150), count: r.num(o.count, `${path}.count`, 1, L.scatter, true),
        trees: o.trees === undefined ? undefined : r.list(o.trees, `${path}.trees`, 5, "points").map((t, j) => r.oneOf(t, `${path}.trees[${j}]`, TREES) ?? "pine"),
        scale: r.range(o.scale, `${path}.scale`, 0.3, 2.5), spacing: r.optNum(o.spacing, `${path}.spacing`, 1, 40), seed: seed(),
      });
    case "rocks":
      return defined({
        kind: "rocks" as const, ...at(), radius: len("radius", 1, 150), count: r.num(o.count, `${path}.count`, 1, L.scatter, true),
        size: r.range(o.size, `${path}.size`, 0.3, 8),
        look: o.look === undefined ? undefined : r.oneOf(o.look, `${path}.look`, { sandstone: true, basalt: true }), seed: seed(),
      });
    case "ramp":
      return defined({
        kind: "ramp" as const, ...at(), yaw: r.angle(o.yaw, `${path}.yaw`),
        width: len("width", 1, 40), length: len("length", 1, 80), rise: len("rise", 0.1, 30), base: r.height(o.base, `${path}.base`),
      });
    case "bridge":
      return defined({
        kind: "bridge" as const, from: r.point(o.from, `${path}.from`), to: r.point(o.to, `${path}.to`), width: len("width", 2, 30),
        y: r.height(o.y, `${path}.y`), parapets: r.bool(o.parapets, `${path}.parapets`),
        piers: r.optNum(o.piers, `${path}.piers`, 0, L.piers, true), look: o.look === undefined ? undefined : r.oneOf(o.look, `${path}.look`, BOX_LOOKS),
      });
    case "containers":
      return defined({
        kind: "containers" as const, ...at(), y: r.height(o.y, `${path}.y`), yaw: r.angle(o.yaw, `${path}.yaw`),
        count: r.optNum(o.count, `${path}.count`, 1, L.containers, true), levels: r.optNum(o.levels, `${path}.levels`, 1, L.levels, true),
      });
    default:
      r.bad(`${path}.kind`);
      return null;
  }
}

function readZone(r: Reader, v: unknown, i: number): MapZone {
  const path = `zones[${i}]`;
  const o = r.obj(v, path) ?? {};
  const label = typeof o.label === "string" && ZONE_LABEL.test(o.label) ? o.label : "";
  if (!label) r.bad(`${path}.label`);
  return defined({ label, x: r.coord(o.x, `${path}.x`), z: r.coord(o.z, `${path}.z`), y: r.height(o.y, `${path}.y`), radius: r.num(o.radius, `${path}.radius`, 2, 30) });
}

function readPlace(r: Reader, v: unknown, i: number): MapPlace {
  const path = `places[${i}]`;
  const o = r.obj(v, path) ?? {};
  return defined({
    name: r.text(o.name, `${path}.name`, MAP_LIMITS.place, true) ?? "",
    names: r.texts(o.names, `${path}.names`, MAP_LIMITS.place),
    x: r.coord(o.x, `${path}.x`), z: r.coord(o.z, `${path}.z`),
  });
}

function readSpawn(r: Reader, v: unknown, team: "blue" | "red"): MapSpawn {
  const path = `spawns.${team}`;
  const o = r.obj(v, path) ?? {};
  return {
    x: r.coord(o.x, `${path}.x`), z: r.coord(o.z, `${path}.z`), facing: r.angle(o.facing, `${path}.facing`) ?? 0,
    width: r.num(o.width, `${path}.width`, MAP_LIMITS.minSpawnWidth, MAP_LIMITS.maxSpawnWidth),
  };
}

/** Les lignes de départ libres : les deux équipes, ou aucune. */
function readSpawns(r: Reader, v: unknown): MapSpawns | undefined {
  if (v === undefined) return undefined;
  const o = r.obj(v, "spawns") ?? {};
  // (une équipe absente : `obj` le note)
  return { blue: readSpawn(r, o.blue, "blue"), red: readSpawn(r, o.red, "red") };
}

/**
 * Amène une carte brute à la version du format de ce code : d'abord la version qu'elle déclare,
 * puis chaque migration (`migrations[n]` : de n à n + 1). Une carte faite pour une version plus
 * récente du jeu est refusée.
 */
export function upgradeMap(raw: Raw, migrations: Readonly<Record<number, MapMigration>> = MAP_MIGRATIONS, target = MAP_FORMAT): { raw: Raw } | { issue: MapIssue } {
  let version = raw.format;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return { issue: { code: "format" } };
  if (version > target) return { issue: { code: "formatTooNew", version } };
  let out = raw;
  while (version < target) {
    const step = migrations[version];
    if (!step) return { issue: { code: "format" } };
    out = { ...step(out), format: version + 1 };
    version++;
  }
  return { raw: out };
}

/**
 * Lit une carte (le JSON déjà décodé) : la migre, la vérifie et la recopie (voir plus haut). Ne
 * vérifie que sa forme et ses bornes ; ce qui demande de construire l'arène (lignes de départ
 * dégagées, zones atteignables) est dans `validateMap` (map/validate.ts).
 */
export function readMap(input: unknown, migrations: Readonly<Record<number, MapMigration>> = MAP_MIGRATIONS): ReadResult {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, issues: [{ code: "json" }] };
    const up = upgradeMap(input as Raw, migrations);
    if ("issue" in up) return { ok: false, issues: [up.issue] };
    return readCurrent(up.raw);
  } catch {
    // Rien ne devrait lever ici ; une entrée qui y parviendrait est refusée, sans faire tomber le serveur
    return { ok: false, issues: [{ code: "json" }] };
  }
}

/** Lit une carte depuis son texte (un fichier, un message) : taille bornée, puis `readMap`. */
export function readMapText(text: string, migrations?: Readonly<Record<number, MapMigration>>): ReadResult {
  if (text.length > MAP_LIMITS.bytes) return { ok: false, issues: [{ code: "tooLarge", size: Math.ceil(text.length / 1024), max: MAP_LIMITS.bytes / 1024 }] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ code: "json" }] };
  }
  return readMap(raw, migrations);
}

function readCurrent(o: Raw): ReadResult {
  const r = new Reader();
  const L = MAP_LIMITS;
  const meta = readMeta(r, o.meta);
  const terrain = readTerrain(r, o.terrain);
  const bounds = readBounds(r, o.bounds);
  let limits: MapFile["limits"];
  if (o.limits !== undefined) {
    const l = r.obj(o.limits, "limits") ?? {};
    limits = defined({ walls: r.bool(l.walls, "limits.walls"), bound: r.optNum(l.bound, "limits.bound", 0, L.reach) });
  }
  let sky: MapFile["sky"];
  if (o.sky !== undefined) {
    const s = r.obj(o.sky, "sky") ?? {};
    sky = defined({ color: r.color(s.color, "sky.color"), fog: r.num(s.fog, "sky.fog", 0, 0.05), dust: r.optNum(s.dust, "sky.dust", 0, 200), night: r.bool(s.night, "sky.night") || undefined });
  }
  let water: MapFile["water"];
  if (o.water !== undefined) {
    const w = r.obj(o.water, "water") ?? {};
    water = defined({ level: r.num(w.level, "water.level", L.minHeight, L.maxHeight), deep: r.optNum(w.deep, "water.deep", 0.3, 50), color: r.optColor(w.color, "water.color") });
  }
  let nav: MapFile["nav"];
  if (o.nav === false) nav = false;
  else if (o.nav !== undefined) {
    const n = r.obj(o.nav, "nav") ?? {};
    nav = defined({ cell: r.optNum(n.cell, "nav.cell", L.minNavCell, L.maxNavCell), maxSlope: r.optNum(n.maxSlope, "nav.maxSlope", 5, 45) });
  }
  const rawProps = r.list(o.props, "props", L.props, "props");
  const map: MapFile = defined({
    format: MAP_FORMAT,
    meta,
    terrain,
    bounds,
    limits,
    sky,
    ground: readGround(r, o.ground),
    water,
    lava: optList(o.lava, r.list(o.lava, "lava", L.lava, "lava").map((v, i) => readLava(r, v, i))),
    vents: optList(o.vents, r.list(o.vents, "vents", L.vents, "vents").map((v, i) => readVent(r, v, i))),
    falls: optList(o.falls, r.list(o.falls, "falls", L.falls, "falls").map((v, i) => readFall(r, v, i))),
    paths: optList(o.paths, r.list(o.paths, "paths", L.paths, "paths").map((v, i) => readPath(r, v, i))),
    urban: r.bool(o.urban, "urban"),
    ambience: o.ambience === undefined ? undefined : r.oneOf<ArenaId>(o.ambience, "ambience", Object.fromEntries(ARENA_IDS.map((id) => [id, true])) as Record<ArenaId, true>),
    nav,
    boxes: optList(o.boxes, r.list(o.boxes, "boxes", L.boxes, "boxes").map((v, i) => readBox(r, v, i))),
    props: optList(o.props, rawProps.map((v, i) => readProp(r, v, i, rawProps.length))),
    prefabs: optList(o.prefabs, r.list(o.prefabs, "prefabs", L.prefabs, "prefabs").map((v, i) => readPrefab(r, v, i)).filter((p): p is MapPrefab => p !== null)),
    zones: r.list(o.zones, "zones", L.zones, "zones").map((v, i) => readZone(r, v, i)),
    places: optList(o.places, r.list(o.places, "places", L.places, "places").map((v, i) => readPlace(r, v, i))),
    spawns: readSpawns(r, o.spawns),
  });
  if (o.zones === undefined) r.bad("zones");
  // Ce que sèment tous les bois et les tas de rochers ensemble ; les points de tous les chemins, de toutes les coulées
  const scattered = (map.prefabs ?? []).reduce((n, p) => n + (p.kind === "woods" || p.kind === "rocks" ? p.count : 0), 0);
  if (scattered > L.scattered) r.fail({ code: "tooMany", what: "scattered", count: scattered, max: L.scattered });
  const pathPoints = (map.paths ?? []).reduce((n, p) => n + p.points.length, 0);
  if (pathPoints > L.pathPoints) r.fail({ code: "tooMany", what: "points", count: pathPoints, max: L.pathPoints });
  const lavaPoints = (map.lava ?? []).reduce((n, s) => n + (s.kind === "flow" ? s.points.length : 1), 0);
  if (lavaPoints > L.lavaPoints) r.fail({ code: "tooMany", what: "points", count: lavaPoints, max: L.lavaPoints });
  return r.issues.length ? { ok: false, issues: r.issues } : { ok: true, map };
}

/** Une liste facultative : absente dans l'entrée, absente dans la sortie. */
function optList<T>(raw: unknown, list: T[]): T[] | undefined {
  return raw === undefined ? undefined : list;
}
