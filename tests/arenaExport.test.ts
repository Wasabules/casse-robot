import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { VALLEY_GROUND } from "../src/shared/arena/features";
import { ARENA_IDS, ARENAS, PLAIN_SKY, type ArenaId, type ArenaLayout, type PropSpot, type StaticBox } from "../src/shared/arena/layout";
import { propHalf } from "../src/shared/catalog/props";
import { BATTLE_ROSTER } from "../src/shared/design/presets";
import { arenaFromMap, checkMapText, MAP_EXTENSION, mapFromArena, mapText, readMapText, type MapFile } from "../src/shared/map";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { ARENA_CONTENT, arenaMap } from "../tools/maps/arenas";
import { seedRandom } from "./seed";

/*
 * Les arènes du jeu en cartes (`mapFromArena`, shared/map/export.ts) : chacune, exportée, écrite en
 * texte (`mapText`), relue (`readMapText`) et reconstruite (`arenaFromMap`), redonne la même arène,
 * champ par champ, au bit près (le relief, à la précision de son encodage sur 16 bits) ; chaque carte
 * exportée se joue (`checkMap`) ; les fichiers de content/arenas/ sont ceux que fait l'export
 * (`npm run map:export -- all`) ; une bataille sur l'arène rebâtie donne le même monde que sur celle
 * du code.
 */

/** Deux valeurs égales : les nombres au bit près (signe des zéros compris), un champ indéfini comme absent. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = (o: object): string[] => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined);
    const ka = keys(a);
    const kb = keys(b);
    return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

type Compare<T> = (a: T, b: T) => boolean;
const flag = (a: unknown, b: unknown): boolean => !!a === !!b;

/** Chaque champ d'une boîte du décor (TypeScript réclame tout champ nouveau : l'export doit l'écrire). */
const BOX_FIELDS: { [K in keyof StaticBox]-?: Compare<StaticBox> } = {
  kind: (a, b) => a.kind === b.kind,
  pos: (a, b) => same(a.pos, b.pos),
  half: (a, b) => same(a.half, b.half),
  rot: (a, b) => same(a.rot, b.rot),
  look: (a, b) => a.look === b.look,
  round: (a, b) => flag(a.round, b.round),
  underpass: (a, b) => flag(a.underpass, b.underpass),
  approach: (a, b) => a.approach === b.approach,
};

/** Chaque champ d'un accessoire. */
const PROP_FIELDS: { [K in keyof PropSpot]-?: Compare<PropSpot> } = {
  type: (a, b) => a.type === b.type,
  pos: (a, b) => same(a.pos, b.pos),
  // Une orientation, même droite, n'est pas l'absence d'orientation (sim/wave.ts)
  rot: (a, b) => (a.rot === undefined) === (b.rot === undefined) && same(a.rot, b.rot),
  // Les dimensions que le jeu lui donne (une dalle sans `half` a celles par défaut)
  half: (a, b) => same(propHalf(a.type, a), propHalf(b.type, b)),
  scale: (a, b) => a.scale === b.scale,
  rests: (a, b) => same(a.rests?.length ? a.rests : undefined, b.rests?.length ? b.rests : undefined),
  building: (a, b) => a.building === b.building,
  diamond: (a, b) => flag(a.diamond, b.diamond),
};

/** Écart permis entre deux hauteurs du relief : la moitié d'un pas du codage sur 16 bits, et l'arrondi en Float32. */
function terrainSlack(a: ArenaLayout): number {
  if (!a.terrain) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of a.terrain.heights) {
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return (hi - lo + 0.02) / 65535 / 2 + 1e-5;
}

/** Ce qu'on attend de chaque champ d'une arène, rebâtie d'après sa carte (TypeScript réclame tout champ nouveau). */
const ARENA_FIELDS: { [K in keyof ArenaLayout]-?: Compare<ArenaLayout> | null } = {
  // (l'identifiant d'une carte est celui de son contenu ; ce qu'en dit son auteur n'est pas une arène du jeu)
  id: null,
  community: null,
  ambience: (a, b) => (a.ambience ?? a.id) === (b.ambience ?? b.id),
  bounds: (a, b) => same({ ...a.bounds, airFloor: a.bounds.airFloor ?? 0, hoverFloor: a.bounds.hoverFloor ?? 0 }, { ...b.bounds, airFloor: b.bounds.airFloor ?? 0, hoverFloor: b.bounds.hoverFloor ?? 0 }),
  boxes: null,
  props: null,
  zones: (a, b) => same(a.zones, b.zones),
  terrain: (a, b) => {
    if (!a.terrain || !b.terrain) return !a.terrain && !b.terrain;
    if (a.terrain.size !== b.terrain.size || a.terrain.cells !== b.terrain.cells || a.terrain.heights.length !== b.terrain.heights.length) return false;
    const slack = terrainSlack(a);
    return a.terrain.heights.every((h, i) => Math.abs(h - b.terrain!.heights[i]) <= slack);
  },
  water: (a, b) => a.water === b.water,
  paths: (a, b) => same(a.paths?.length ? a.paths : undefined, b.paths?.length ? b.paths : undefined),
  urban: (a, b) => flag(a.urban, b.urban),
  sky: (a, b) => {
    const sky = (l: ArenaLayout): object => ({ ...(l.sky ?? PLAIN_SKY), night: l.sky?.night || undefined });
    return same(sky(a), sky(b));
  },
  places: (a, b) => same(a.places?.length ? a.places : undefined, b.places?.length ? b.places : undefined),
  deepWater: (a, b) => a.deepWater === b.deepWater,
  lava: (a, b) => same(a.lava, b.lava),
  navGrid: (a, b) => same(a.navGrid, b.navGrid),
  nav: (a, b) => same(a.nav, b.nav),
  ground: (a, b) => same(a.ground ?? VALLEY_GROUND, b.ground ?? VALLEY_GROUND),
  waterColor: (a, b) => a.waterColor === b.waterColor,
  vents: (a, b) => same(a.vents?.map((v) => ({ ...v, steam: v.steam || undefined })), b.vents?.map((v) => ({ ...v, steam: v.steam || undefined }))),
  // La direction d'une cascade s'écrit en degrés : un angle quelconque (un atan2) n'a pas toujours de
  // degrés qui le redonnent au bit près ; seul le rendu la lit (le rideau d'eau)
  falls: (a, b) => same(a.falls?.map((f) => ({ ...f, dir: 0 })), b.falls?.map((f) => ({ ...f, dir: 0 })))
    && (a.falls ?? []).every((f, i) => Math.abs(f.dir - b.falls![i].dir) <= 1e-12),
};

/** Ce qui diffère entre une arène et sa copie rebâtie d'après sa carte : une ligne par champ. */
function arenaDiff(a: ArenaLayout, b: ArenaLayout): string[] {
  const out: string[] = [];
  for (const [key, compare] of Object.entries(ARENA_FIELDS) as [keyof ArenaLayout, Compare<ArenaLayout> | null][]) {
    if (compare && !compare(a, b)) out.push(key);
  }
  // Aucun champ que la comparaison ne connaît pas
  for (const key of Object.keys(b)) if (!(key in ARENA_FIELDS)) out.push(`${key} (inconnu)`);
  if (a.boxes.length !== b.boxes.length) out.push(`boxes : ${a.boxes.length} → ${b.boxes.length}`);
  else {
    a.boxes.forEach((box, i) => {
      for (const key of Object.keys(box)) if (!(key in BOX_FIELDS)) out.push(`boxes[${i}].${key} (inconnu)`);
      for (const [key, compare] of Object.entries(BOX_FIELDS)) if (!compare(box, b.boxes[i])) out.push(`boxes[${i}].${key}`);
    });
  }
  if (a.props.length !== b.props.length) out.push(`props : ${a.props.length} → ${b.props.length}`);
  else {
    a.props.forEach((spot, i) => {
      for (const key of Object.keys(spot)) if (!(key in PROP_FIELDS)) out.push(`props[${i}].${key} (inconnu)`);
      for (const [key, compare] of Object.entries(PROP_FIELDS)) if (!compare(spot, b.props[i])) out.push(`props[${i}].${key}`);
    });
  }
  return out;
}

/** Une arène en carte (celle de l'outil : ses noms dans chaque langue), écrite en texte (`mapText`, celui des fichiers) puis relue, comme un fichier. */
function exported(id: ArenaId): { map: MapFile; text: string; read: MapFile } {
  const map = arenaMap(id);
  const text = mapText(map);
  const read = readMapText(text);
  if (!read.ok) throw new Error(`${id} : ${JSON.stringify(read.issues)}`);
  return { map, text, read: read.map };
}

describe("arènes du jeu en cartes", () => {
  let maps: Record<ArenaId, ReturnType<typeof exported>>;
  // (le Canyon bâtit son relief, son décor et son réseau à la première lecture : une seconde ou plus)
  beforeAll(() => {
    maps = Object.fromEntries(ARENA_IDS.map((id) => [id, exported(id)])) as typeof maps;
  }, 120_000);

  it("chaque arène, exportée, écrite, relue et reconstruite, redonne la même arène, champ par champ", { timeout: 120_000 }, () => {
    for (const id of ARENA_IDS) {
      const rebuilt = arenaFromMap(maps[id].read);
      expect(arenaDiff(ARENAS[id], rebuilt), id).toEqual([]);
    }
  });

  it("les fichiers de content/arenas/ sont ceux que fait l'export", () => {
    for (const id of ARENA_IDS) {
      let file = "";
      try {
        file = readFileSync(new URL(`../${ARENA_CONTENT}/${id}${MAP_EXTENSION}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
      } catch {
        // (absent : la comparaison le dit)
      }
      expect(file === maps[id].text, `${ARENA_CONTENT}/${id}${MAP_EXTENSION} n'est plus celui que fait l'export : lancer \`npm run map:export -- all\``).toBe(true);
    }
    // Et rien d'autre dans le dossier
    const files = readdirSync(new URL(`../${ARENA_CONTENT}/`, import.meta.url)).sort();
    expect(files).toEqual(ARENA_IDS.map((id) => `${id}${MAP_EXTENSION}`).sort());
  });

  it("une arène exportée sans ses noms (mapFromArena seul) est la même carte, à ce qu'en dit la carte près", () => {
    const plain = mapFromArena(ARENAS.depot);
    const unnamed = (m: MapFile): object => ({ ...m, meta: undefined });
    expect(same(unnamed(plain), unnamed(maps.depot.map))).toBe(true);
    expect(plain.meta).toEqual({ name: "depot", author: "Casse-Robot", license: "AGPL-3.0-or-later" });
  });

  it("la lecture garde toute la carte exportée (rien n'est borné ni arrondi, pas même le signe d'un zéro)", () => {
    for (const id of ARENA_IDS) expect(same(maps[id].read, maps[id].map), id).toBe(true);
  });

  it("chaque carte exportée se joue (checkMap)", { timeout: 120_000 }, () => {
    for (const id of ARENA_IDS) expect(checkMapText(maps[id].text).issues, id).toEqual([]);
  });

  it("une bataille sur l'arène rebâtie donne le même monde, au bit près, que sur celle du code (même graine)", { timeout: 600_000 }, async () => {
    await initPhysics();
    for (const id of ARENA_IDS) {
      const original = ARENAS[id];
      const rebuilt = arenaFromMap(maps[id].read);
      // Le relief n'est le même qu'à la précision de son codage : l'arène du code prend celui de la carte,
      // tout le reste (boîtes, accessoires, zones, bornes, grille ou réseau de passage) est le sien. Une
      // copie, pour que les deux simulations la chargent de la même façon (le Dépôt est l'arène par
      // défaut : `loadArena` ne referait pas son décor, et la physique numéroterait autrement ses corps)
      const reference: ArenaLayout = { ...original, ...(original.terrain ? { terrain: rebuilt.terrain } : {}) };
      const a = fingerprint(reference, 7, BATTLE_SECONDS);
      const b = fingerprint(rebuilt, 7, BATTLE_SECONDS);
      expect(a.events, id).toBeGreaterThan(0);
      expect(b, id).toEqual(a);
    }
  });
});

/** Durée des batailles comparées (s) : de quoi rouler, tirer, faire tomber des accessoires. */
const BATTLE_SECONDS = 2;

/**
 * Empreinte du monde après `seconds` s de bataille à douze robots sur cette arène (comme
 * tests/determinism.test.ts) : poses et vitesses exactes des morceaux, points des blocs, accessoires,
 * projectiles, événements.
 */
function fingerprint(arena: ArenaLayout, seed: number, seconds: number): { hash: string; events: number } {
  seedRandom(seed);
  const sim = new Simulation();
  sim.loadArena(arena);
  spawnWave(sim, BATTLE_ROSTER);
  let events = 0;
  sim.on(() => events++);
  for (let i = 0; i < seconds * 60; i++) sim.step();
  let h = 0x811c9dc5;
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  const mix = (x: number): void => {
    view.setFloat64(0, x);
    for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193);
  };
  for (const bot of sim.bots) {
    mix(bot.blocks.size);
    for (const part of bot.parts) {
      if (!part.rb.isValid()) continue;
      const t = part.rb.translation(), r = part.rb.rotation(), v = part.rb.linvel(), w = part.rb.angvel();
      for (const x of [t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z]) mix(x);
    }
    for (const block of bot.blocks.values()) mix(block.hp);
  }
  for (const prop of sim.props) {
    if (!prop.rb.isValid()) continue;
    const t = prop.rb.translation(), r = prop.rb.rotation();
    for (const x of [prop.spot, prop.hp, t.x, t.y, t.z, r.x, r.y, r.z, r.w]) mix(x);
  }
  for (const p of sim.projectiles) for (const x of [p.pos.x, p.pos.y, p.pos.z]) mix(x);
  mix(events);
  sim.dispose();
  return { hash: (h >>> 0).toString(16).padStart(8, "0"), events };
}
