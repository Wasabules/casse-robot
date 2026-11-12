import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { upgradeDesign, validateDesign, type RobotDesign } from "../src/shared/design/robotDesign";
import {
  canonicalJson, checkMap, encodeTerrain, MAP_LIMITS, MAP_RANGES, mapKey, MAX_ANGLE, readMap, type MapFile, type MapPrefab,
} from "../src/shared/map";
import { MAP_SCHEMA_ID, mapSchema, robotSchema, schemaFiles } from "../tools/schemas/schemas";
import { unsupportedKeywords, validateSchema } from "./jsonSchema";

/*
 * Les schémas JSON des formats ouverts du jeu (schemas/, faits par tools/schemas/) : les fichiers
 * livrés sont ceux que fait le générateur d'après le code ; les cartes livrées, la carte minimale du
 * guide des auteurs et les robots prédéfinis s'y conforment ; le schéma des cartes dit ce que dit la
 * lecture (`readMap`) : une carte d'essai qui a tous les champs du format, puis chacun de ses champs
 * changé (autre type, nombres autour de chaque borne, textes, choix inconnus), sont acceptés ou
 * refusés de même par le schéma et par la lecture ; le schéma des robots refuse ce que refuse
 * `validateDesign`, pour ce qu'un schéma sait dire.
 */

const MAP = mapSchema();
const ROBOT = robotSchema();
const BUNDLED = import.meta.glob<string>("../maps/*.casse-map.json", { query: "?raw", import: "default", eager: true });

/** Une valeur JSON brute (le document tel qu'un outil l'écrirait). */
type Json = unknown;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const strict = { unknownProperties: true };

/** Chaque champ, facultatif ou non, à toutes les profondeurs (et dans chaque élément d'une liste). */
type Full<T> = T extends readonly (infer U)[] ? readonly Full<U>[] : T extends object ? { readonly [K in keyof T]-?: Full<T[K]> } : T;

/** Un préfabriqué de chaque sorte, avec tous ses champs (TypeScript réclame toute sorte et tout champ nouveaux). */
const PREFABS = {
  house: { kind: "house", x: 20, z: 20, y: 0.5, yaw: 30, width: 8, depth: 6, height: 3, wall: "brick", roof: "roof", roofKind: "flat", door: 2, through: true },
  tenement: { kind: "tenement", x: -20, z: 20, y: 0, yaw: 90, width: 12, depth: 10, floors: 3, wall: "facade", doors: [["s", 0], ["e", 1]], ruin: 0.3, seed: 7 },
  fence: { kind: "fence", points: [[-30, -5], [-30, 5], [-25, 8]], height: 1.2, material: "plank" },
  woods: { kind: "woods", x: 30, z: -20, radius: 10, count: 8, trees: ["pine", "oak"], scale: [0.8, 1.2], spacing: 4, seed: 3 },
  rocks: { kind: "rocks", x: -30, z: -20, radius: 6, count: 4, size: [0.5, 1.5], look: "basalt", seed: 2 },
  ramp: { kind: "ramp", x: 10, z: -30, yaw: 180, width: 4, length: 8, rise: 2, base: 0 },
  bridge: { kind: "bridge", from: [0, -10], to: [0, 10], width: 6, y: 2, parapets: false, piers: 2, look: "timber" },
  containers: { kind: "containers", x: -10, z: -30, y: 0, yaw: 45, count: 3, levels: 2 },
} as const satisfies { readonly [K in MapPrefab["kind"]]: Full<Extract<MapPrefab, { kind: K }>> };

/** Une carte qui a tous les champs du format (pas forcément jouable : seule la lecture la juge). */
const FULL = {
  format: 1,
  meta: { name: "Sample", names: { en: "Sample", fr: "Essai" }, author: "Tester", description: "A map with every field.", descriptions: { en: "Every field." }, license: "CC0-1.0" },
  terrain: encodeTerrain(Array.from({ length: 17 * 17 }, (_, i) => (i % 17) * 0.25), 16, 1),
  bounds: { half: 60, roam: 50, spawnLine: 45, spawnSpread: 18, circuit: 40, airFloor: 20, hoverFloor: 5 },
  limits: { walls: true, bound: 90 },
  sky: { color: "#bfd0db", fog: 0.0045, dust: 10, night: true },
  ground: {
    preset: "canyon", base: ["#112233", "#445566"], dirt: "#776655", sand: "#ccbb99", mud: "#443322", rock: "#888888", peak: "#ffffff",
    rockLine: 20, peakLine: 40, beach: 1, basalt: "#222222", basaltWidth: 3, strata: ["#aa0000", "#00aa00"], strataStep: 2,
    patches: [{ x: 5, z: 5, r: 4, color: "#00ff00" }], grain: 9, stains: 0.25, slope: { color: "#665544", from: 0.8, span: 0.2 }, rockSpan: 10, lawn: "#77aa55",
  },
  water: { level: 1, deep: 1.2, color: "#2b8a9c" },
  lava: [{ kind: "flow", width: 5, points: [[0, 0], [10, 10], [12, 20]] }, { kind: "pool", x: -10, z: -10, r: 4 }],
  vents: [{ x: 1, z: 2, y: 3, size: 1, steam: true }],
  falls: [{ x: 3, z: 4, top: 10, bottom: 2, width: 3, dir: 90 }],
  paths: [{ width: 4, points: [[-20, 0], [20, 0]], surface: "gravel" }],
  urban: true,
  ambience: "fort",
  nav: { cell: 2.5, maxSlope: 26 },
  navGraph: { points: [[-20, -20], [0, -20], [0, 0]], links: [[0, 1], [1, 2]] },
  boxes: [{ kind: "wall", x: 10, z: 10, y: 1, size: [4, 2, 0.5], yaw: 30, pitch: 5, roll: -5, quat: [0.6, 0, 0, 0.8], look: "timber", round: false, underpass: true, approach: 6 }],
  props: [
    { type: "brick", x: 0, z: 5, y: 0, yaw: 90, pitch: 0, roll: 0, quat: [0, 0, 0, 1], size: [4, 3, 0.3], scale: 1, rests: [], group: 1, diamond: false, centered: false },
    { type: "roof", x: 0, z: 5, y: 3, yaw: 90, pitch: 10, roll: 0, quat: [0, 0.6, 0, 0.8], size: [4, 0.2, 4], scale: 1.2, rests: [0], group: 1, diamond: true, centered: true },
  ],
  prefabs: Object.values(PREFABS),
  zones: [{ label: "A", x: 0, z: 0, y: 0.5, radius: 6 }, { label: "C", x: 20, z: 0, y: 1, radius: 8 }],
  places: [{ name: "Village", names: { en: "Village" }, place: "village", x: 20, z: 20 }],
  spawns: { blue: { x: 0, z: -45, facing: 0, width: 30 }, red: { x: 0, z: 45, facing: 180, width: 30 } },
} as const satisfies Full<MapFile>;

/** La carte minimale du guide des auteurs (le premier bloc JSON après « A minimal map »). */
function docsMinimalMap(): Json {
  const guide = readFileSync(new URL("../docs/maps.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const block = /A minimal map:\s*```json\n([\s\S]*?)```/.exec(guide);
  if (!block) throw new Error("docs/maps.md : la carte minimale est introuvable");
  return JSON.parse(block[1]);
}

/** Chaque nœud d'un document (sauf la racine), avec son chemin. */
function nodes(value: Json, path: (string | number)[] = []): [(string | number)[], Json][] {
  const out: [(string | number)[], Json][] = [];
  const children: [string | number, Json][] = Array.isArray(value)
    ? value.map((v, i) => [i, v])
    : value && typeof value === "object" ? Object.entries(value) : [];
  for (const [key, v] of children) {
    const here = [...path, key];
    out.push([here, v], ...nodes(v, here));
  }
  return out;
}

const pathText = (path: readonly (string | number)[]): string =>
  path.map((k, i) => (typeof k === "number" ? `[${k}]` : i ? `.${k}` : k)).join("");

/** Des valeurs d'un autre type JSON que celle-ci. */
function otherTypes(v: Json): Json[] {
  const all: Json[] = ["zz", 5, null, true, [], {}];
  const kind = (x: Json): string => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x);
  return all.filter((x) => kind(x) !== kind(v));
}

/** Des nombres de part et d'autre de chaque borne des cartes (et les bornes elles-mêmes). */
function numberCandidates(): number[] {
  const bounds = new Set<number>([0, 0.5, MAX_ANGLE, -MAX_ANGLE, 1e7, -1e7]);
  const walk = (o: unknown): void => {
    if (typeof o === "number") bounds.add(o);
    else if (o && typeof o === "object") Object.values(o).forEach(walk);
  };
  walk(MAP_RANGES);
  walk(MAP_LIMITS);
  const out = new Set<number>();
  for (const b of bounds) {
    const d = 0.001 * Math.max(1, Math.abs(b));
    for (const v of [b, b - d, b + d]) out.add(v);
  }
  return [...out];
}

const STRING_CANDIDATES = ["zz-unknown", "", " ", "x".repeat(32), "x".repeat(33), "x".repeat(48), "x".repeat(49), "x".repeat(400), "x".repeat(401)];

/**
 * Champs dont la lecture juge la valeur d'après un autre champ (le schéma ne le peut pas : voir sa
 * description) : le relief (hauteurs et taille), le bas d'une cascade sous son haut, les appuis d'un
 * accessoire sous le nombre d'accessoires, les paires [min, max], la norme d'un quaternion (ses
 * quatre composantes ensemble), les liaisons d'un réseau de passage sous le nombre de ses points.
 */
const RELATIVE = [
  /^terrain\./, /^falls\[\d+\]\.(top|bottom)$/, /^props\[\d+\]\.rests\[\d+\]$/, /^prefabs\[\d+\]\.(scale|size)\[\d+\]$/,
  /^(boxes|props)\[\d+\]\.quat\[\d+\]$/, /^navGraph\.links\[\d+\]\[\d+\]$/,
];

describe("schémas JSON des formats ouverts", () => {
  it("les fichiers de schemas/ sont ceux que fait le générateur d'après le code", () => {
    for (const [path, text] of Object.entries(schemaFiles())) {
      let file = "";
      try {
        file = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
      } catch {
        // (absent : la comparaison le dit)
      }
      expect(file === text, `${path} n'est plus celui que fait le générateur d'après le code : lancer \`npm run schemas\``).toBe(true);
    }
  });

  it("les schémas n'emploient que les mots-clés que connaît le validateur des essais", () => {
    expect(unsupportedKeywords(MAP)).toEqual([]);
    expect(unsupportedKeywords(ROBOT)).toEqual([]);
  });

  it("les cartes livrées et la carte minimale du guide suivent le schéma des cartes, sans champ qu'il ignore", () => {
    expect(Object.keys(BUNDLED).length).toBeGreaterThan(0);
    for (const [path, text] of Object.entries(BUNDLED)) expect(validateSchema(MAP, JSON.parse(text), strict), path).toEqual([]);
    const minimal = docsMinimalMap();
    expect(validateSchema(MAP, minimal, strict)).toEqual([]);
    expect(readMap(minimal).ok).toBe(true);
  });

  it("les robots prédéfinis suivent le schéma des robots, sans champ qu'il ignore", () => {
    for (const bot of PRESET_BOTS) expect(validateSchema(ROBOT, json(bot.design), strict), bot.id).toEqual([]);
  });

  it("une carte qui a tous les champs du format suit le schéma, et la lecture les garde tous", () => {
    const doc = json(FULL);
    expect(validateSchema(MAP, doc, strict)).toEqual([]);
    const read = readMap(doc);
    expect(read.ok ? [] : read.issues).toEqual([]);
    expect(read.ok && canonicalJson(read.map)).toBe(canonicalJson(doc));
  });

  it("chaque champ changé : le schéma accepte ou refuse comme la lecture", () => {
    const numbers = numberCandidates();
    const mismatches: string[] = [];
    let tried = 0;
    // Champ de premier niveau par champ de premier niveau, dans une carte qui n'a que lui de plus que
    // les champs obligatoires : chaque essai lit et valide une petite carte
    const full = json(FULL) as Record<string, unknown>;
    const required = ["format", "meta", "bounds", "zones"];
    for (const top of Object.keys(full)) {
      const doc: Record<string, unknown> = Object.fromEntries([...required, top].map((k) => [k, json(full[k])]));
      for (const [path, value] of nodes(doc)) {
        if (path[0] !== top) continue;
        const parent = path.slice(0, -1).reduce<Record<string | number, unknown>>((o, k) => o[k] as Record<string | number, unknown>, doc);
        const key = path[path.length - 1];
        const relative = RELATIVE.some((re) => re.test(pathText(path)));
        const tries: Json[] = otherTypes(value);
        if (!relative && typeof value === "number") tries.push(...numbers);
        if (!relative && typeof value === "string") tries.push(...STRING_CANDIDATES);
        if (typeof value === "boolean") tries.push(!value);
        for (const v of tries) {
          parent[key] = v;
          const bySchema = validateSchema(MAP, doc).length === 0;
          const byReader = readMap(doc).ok;
          tried++;
          if (bySchema !== byReader) mismatches.push(`${pathText(path)} = ${JSON.stringify(v)?.slice(0, 20)} : schéma ${bySchema ? "oui" : "non"}, lecture ${byReader ? "oui" : "non"}`);
        }
        parent[key] = value;
      }
    }
    expect(tried).toBeGreaterThan(10_000);
    expect(mismatches).toEqual([]);
  });

  it("des cartes invalides sont refusées par le schéma comme par la lecture", () => {
    const base = docsMinimalMap() as Record<string, Record<string, unknown>>;
    const variants: Record<string, (m: Record<string, unknown>) => void> = {
      "un nombre écrit en texte": (m) => ((m.bounds as Record<string, unknown>).half = "60"),
      "une zone de jeu trop petite": (m) => ((m.bounds as Record<string, unknown>).half = 10),
      "une zone trop grande": (m) => (m.zones = [{ label: "A", x: 0, z: 0, radius: 31 }]),
      "une lettre de zone inconnue": (m) => (m.zones = [{ label: "F", x: 0, z: 0, radius: 6 }]),
      "une sorte de boîte inconnue": (m) => (m.boxes = [{ kind: "castle", x: 0, z: 0, size: [1, 1, 1] }]),
      "une sorte d'accessoire inconnue": (m) => (m.props = [{ type: "dragon", x: 0, z: 0 }]),
      "une sorte de préfabriqué inconnue": (m) => (m.prefabs = [{ kind: "tower", x: 0, z: 0 }]),
      "une maison sans ses murs": (m) => (m.prefabs = [{ kind: "house", x: 0, z: 0, width: 8, depth: 6, height: 3, roof: "roof" }]),
      "une carte sans auteur": (m) => delete (m.meta as Record<string, unknown>).author,
      "une carte sans zones": (m) => delete m.zones,
      "un format plus récent": (m) => (m.format = 2),
      "une langue mal écrite": (m) => ((m.meta as Record<string, unknown>).names = { english: "My map" }),
      "une couleur mal écrite": (m) => (m.sky = { color: "blue", fog: 0.004 }),
      "trop d'accessoires": (m) => (m.props = Array.from({ length: MAP_LIMITS.props + 1 }, () => ({ type: "crate", x: 0, z: 0 }))),
    };
    for (const [what, change] of Object.entries(variants)) {
      const map = json(base);
      change(map);
      expect(validateSchema(MAP, map).length, `schéma : ${what}`).toBeGreaterThan(0);
      expect(readMap(map).ok, `lecture : ${what}`).toBe(false);
    }
    // Ce que dit la validation (et le schéma), pas la lecture : une dalle sans dimensions
    const slab = json(base) as Record<string, unknown>;
    slab.props = [{ type: "brick", x: 0, z: 0 }];
    expect(validateSchema(MAP, slab).length).toBeGreaterThan(0);
    expect(checkMap(slab).issues).toContainEqual({ code: "field", path: "props[0].size" });
  });

  it("« $schema » dans une carte : le schéma le connaît, la lecture l'ignore, l'identifiant de la carte n'en dépend pas", () => {
    const plain = docsMinimalMap() as Record<string, unknown>;
    const linked = { $schema: MAP_SCHEMA_ID, ...plain };
    expect(validateSchema(MAP, linked, strict)).toEqual([]);
    const a = readMap(plain);
    const b = readMap(linked);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.map).not.toHaveProperty("$schema");
    expect(mapKey(b.map)).toBe(mapKey(a.map));
    expect(checkMap(linked).key).toBe(checkMap(plain).key);
  });

  /** Un petit robot jouable qui a tous les champs d'un plan : orientation, roulette dessous, décalage, chenille haute et large. */
  const SAMPLE_ROBOT: RobotDesign = {
    blocks: [
      ...[-1, 0, 1].flatMap((x) => [-2, -1, 0, 1, 2].map((z) => ({ x, y: 0, z, type: "frame" as const }))),
      { x: 0, y: 1, z: 0, type: "cockpit" },
      { x: 0, y: 1, z: 2, type: "wedge", facing: { up: "+y", forward: "+z" } },
      { x: 0, y: 1, z: -2, type: "wedge", facing: { up: "+x", forward: "-z" } },
    ],
    wheels: [
      { x: 1, y: 0, z: -2, dx: 1, dz: 0, type: "track" },
      { x: 1, y: 0, z: 0, dx: 1, dz: 0, type: "track", layer: 1 },
      { x: 1, y: 0, z: 2, dx: 1, dz: 0, type: "track", rise: 1 },
      { x: -1, y: 0, z: -2, dx: -1, dz: 0, type: "track" },
      { x: -1, y: 0, z: 2, dx: -1, dz: 0, type: "track" },
      { x: 0, y: 0, z: 2, dx: 0, dz: 0, dy: -1, type: "caster", shift: 1 },
      { x: 0, y: 0, z: -2, dx: 0, dz: -1, type: "small" },
    ],
  };

  it("un robot qui a tous les champs d'un plan suit le schéma et se joue", () => {
    expect(validateDesign(SAMPLE_ROBOT)).toEqual([]);
    expect(validateSchema(ROBOT, json(SAMPLE_ROBOT), strict)).toEqual([]);
    // Un plan d'avant (une roue fixe « directrice ») : le schéma l'accepte, le jeu le remet au format du jour
    const old = json(PRESET_BOTS[0].design) as RobotDesign;
    (old.wheels[0] as { steer?: boolean }).steer = true;
    expect(validateSchema(ROBOT, old, strict)).toEqual([]);
    expect(validateDesign(upgradeDesign(old))).toEqual([]);
  });

  it("des robots invalides sont refusés par le schéma comme par validateDesign", () => {
    const variants: Record<string, (d: RobotDesign) => void> = {
      "une coordonnée écrite en texte": (d) => ((d.blocks[0] as unknown as Record<string, unknown>).x = "1"),
      "une coordonnée qui n'est pas entière": (d) => (d.blocks[0].x = 0.5),
      "un bloc inconnu": (d) => ((d.blocks[0] as unknown as Record<string, unknown>).type = "laserSword"),
      "une roue inconnue": (d) => ((d.wheels[0] as unknown as Record<string, unknown>).type = "zz"),
      "une roue sans type": (d) => delete (d.wheels[0] as unknown as Record<string, unknown>).type,
      "une roue sur deux faces": (d) => (d.wheels[0].dz = 1),
      "une roue sur aucune face": (d) => (d.wheels[0].dx = 0),
      "une roue au-dessus du bloc": (d) => Object.assign(d.wheels[0], { dx: 0, dz: 0, dy: 1 }),
      "un décalage trop grand": (d) => (d.wheels[0].shift = 2),
      "une chenille trop haute": (d) => (d.wheels[0].rise = 3),
      "une chenille trop large": (d) => (d.wheels[0].layer = 3),
      "une roue ordinaire empilée": (d) => (d.wheels[d.wheels.length - 1].rise = 1),
      "une orientation impossible": (d) => (d.blocks[d.blocks.length - 1].facing = { up: "+x", forward: "-x" }),
      "un axe inconnu": (d) => ((d.blocks[d.blocks.length - 1] as unknown as Record<string, unknown>).facing = { up: "+w", forward: "+z" }),
      "sans cockpit": (d) => (d.blocks.find((b) => b.type === "cockpit")!.type = "armor"),
      "deux cockpits": (d) => (d.blocks[0].type = "cockpit"),
    };
    for (const [what, change] of Object.entries(variants)) {
      const design = json(SAMPLE_ROBOT);
      change(design);
      expect(validateSchema(ROBOT, design).length, `schéma : ${what}`).toBeGreaterThan(0);
      expect(validateDesign(design).length, `validateDesign : ${what}`).toBeGreaterThan(0);
    }
  });
});
