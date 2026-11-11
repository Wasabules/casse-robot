import { deflateSync, inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { arenaById, isMapKey, type ArenaLayout } from "../src/shared/arena/layout";
import { bridgeDecks, navGrid, passable } from "../src/shared/arena/navgrid";
import { terrainHeight } from "../src/shared/arena/terrain";
import {
  blankMap, canonicalJson, checkMap, decodePng, decodeRaw16, decodeTerrain, encodePng, encodeTerrain, fromBase64, heightsFromImage,
  imageFromBytes, imageFromHeights, isHeightmapError, MAP_FORMAT, MAP_LIMITS, mapKey, readMap, readMapText, registerMap, terrainFromImage, toBase64,
  upgradeMap, validateMap, type HeightImage, type MapFile, type MapIssue, type MapPrefab,
} from "../src/shared/map";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { GAME_MODES, pickRoster } from "../src/shared/modes";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * Le moteur de cartes communautaires (shared/map/) : le format et son aller-retour, la migration,
 * la lecture d'entrées malformées ou hostiles (refusées sans planter ni geler), l'import d'un relief
 * (PNG 16 et 8 bits, RAW 16 bits), la conversion en arène (préfabriqués, sol, limites) et la
 * validation (lignes de départ, zones atteignables, dangers).
 */

const inflate = (data: Uint8Array): Uint8Array => new Uint8Array(inflateSync(data));
const deflate = (data: Uint8Array): Uint8Array => new Uint8Array(deflateSync(data));
const codes = (issues: readonly MapIssue[]): string[] => issues.map((i) => i.code);

/** Une carte de départ, valide. */
const base = (): MapFile => blankMap({ name: "Essai", author: "Tests", half: 70 });
/** La même, avec des changements. */
const withFields = (changes: Partial<MapFile>): MapFile => ({ ...base(), ...changes });

describe("cartes : format", () => {
  it("base64 : aller-retour, longueurs de 0 à 5 octets et au-delà", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 255);
      expect(Array.from(fromBase64(toBase64(bytes))!)).toEqual(Array.from(bytes));
    }
    expect(toBase64(new Uint8Array([77, 97, 110]))).toBe("TWFu");
    expect(fromBase64("TWE=")).toEqual(new Uint8Array([77, 97]));
    expect(fromBase64("T@E=")).toBeNull();
    expect(fromBase64("TWE")).toBeNull();
  });

  it("le relief : ses hauteurs codées en Uint16 reviennent au millimètre près", () => {
    const cells = 20;
    const heights = Float32Array.from({ length: 21 * 21 }, (_, i) => 3 + 10 * Math.sin(i / 7));
    const terrain = decodeTerrain(encodeTerrain(heights, cells, 2))!;
    expect(terrain.size).toBe(40);
    expect(terrain.cells).toBe(cells);
    for (let i = 0; i < heights.length; i++) expect(Math.abs(terrain.heights[i] - heights[i])).toBeLessThan(0.002);
  });

  it("aller-retour : une carte écrite en JSON puis relue est la même, avec le même identifiant", () => {
    const map = base();
    const read = readMapText(JSON.stringify(map, null, 2));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(canonicalJson(read.map)).toBe(canonicalJson(map));
    expect(mapKey(read.map)).toBe(mapKey(map));
    expect(isMapKey(mapKey(map))).toBe(true);
    // L'ordre des champs ne change pas l'identifiant ; un champ inconnu est ignoré
    const shuffled = Object.fromEntries(Object.entries({ ...map, extra: "?" }).reverse());
    const again = readMap(shuffled);
    expect(again.ok && mapKey(again.map)).toBe(mapKey(map));
    // La moindre modification fait une autre carte
    expect(mapKey({ ...map, meta: { ...map.meta, name: "Essai 2" } })).not.toBe(mapKey(map));
  });

  it("migration : une carte d'un format plus ancien passe par les migrations ; une plus récente est refusée", () => {
    const old = { ...base(), format: 0, titre: "Ancienne" } as unknown as Record<string, unknown>;
    // Une migration fictive du format 0 au format 1 : elle renomme un champ
    const migrations = { 0: (raw: Record<string, unknown>) => ({ ...raw, meta: { ...(raw.meta as object), name: raw.titre } }) };
    const up = upgradeMap(old, migrations);
    expect("raw" in up && up.raw.format).toBe(MAP_FORMAT);
    const read = readMap(old, migrations);
    expect(read.ok && read.map.meta.name).toBe("Ancienne");
    // Sans migration pour ce format : refusée
    expect(codes(validateMap(old))).toEqual(["format"]);
    expect(validateMap({ ...base(), format: MAP_FORMAT + 1 })).toEqual([{ code: "formatTooNew", version: MAP_FORMAT + 1 }]);
    expect(codes(validateMap({ ...base(), format: "1" }))).toEqual(["format"]);
  });
});

describe("cartes : entrées malformées ou hostiles", () => {
  /** Lit sans lever, en un temps raisonnable, et refuse. */
  const refused = (input: unknown): MapIssue[] => {
    const start = performance.now();
    let issues: readonly MapIssue[] = [];
    expect(() => (issues = validateMap(input))).not.toThrow();
    expect(performance.now() - start).toBeLessThan(2000);
    expect(issues.length).toBeGreaterThan(0);
    return [...issues];
  };

  it("ce qui n'est pas une carte", () => {
    for (const input of [null, undefined, 42, "carte", [], [base()], true]) refused(input);
    expect(readMapText("{ pas du json")).toEqual({ ok: false, issues: [{ code: "json" }] });
    expect(codes(refused({ format: 1 }))).toContain("field");
  });

  it("des nombres non finis, hors bornes, des types inattendus", () => {
    refused(withFields({ bounds: { half: Infinity } }));
    refused(withFields({ bounds: { half: NaN } }));
    refused(withFields({ bounds: { half: 1e12 } }));
    refused(withFields({ bounds: { half: "100" as unknown as number } }));
    refused(withFields({ zones: [{ label: "A", x: 1e9, z: 0, radius: 5 }] }));
    refused(withFields({ props: [{ type: "dragon" as never, x: 0, z: 0 }] }));
    refused(withFields({ boxes: [{ kind: "pillar", x: 0, z: 0, size: [1, -2, 1] }] }));
    refused(withFields({ water: { level: -Infinity } }));
    refused(withFields({ prefabs: [{ kind: "castle" } as unknown as MapPrefab] }));
  });

  it("des textes trop longs, des caractères de contrôle, des clés piégées", () => {
    const issues = refused(withFields({ meta: { name: "x".repeat(10_000), author: "a", license: "CC0-1.0" } }));
    expect(issues).toContainEqual({ code: "text", path: "meta.name", max: MAP_LIMITS.name });
    // Les caractères de contrôle deviennent des espaces
    const read = readMap(withFields({ meta: { name: "A\u0000B\nC", author: "a", license: "CC0-1.0" } }));
    expect(read.ok && read.map.meta.name).toBe("A B C");
    // Une clé « __proto__ » ou un code de langue farfelu ne passe pas
    const hostile = JSON.parse(`{"format":1,"meta":{"name":"n","author":"a","license":"l","names":{"__proto__":"x","toString":"y"}},"bounds":{"half":50},"zones":[]}`);
    refused(hostile);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("des tailles énormes : refusées sans les parcourir", () => {
    const many = Array.from({ length: 1_000_000 }, () => ({ type: "crate", x: 0, z: 0 }));
    expect(refused(withFields({ props: many as never }))).toContainEqual({ code: "tooMany", what: "props", count: 1_000_000, max: MAP_LIMITS.props });
    refused(withFields({ terrain: { cells: 100_000, step: 1, min: 0, max: 10, heights: "" } }));
    refused(withFields({ terrain: { cells: 64, step: 1.375, min: 0, max: 10, heights: "" } }));
    refused(withFields({ terrain: { ...base().terrain!, heights: "!!!!" } }));
    refused(withFields({ terrain: { ...base().terrain!, heights: toBase64(new Uint8Array(10)) } }));
    expect(codes(refused("x".repeat(MAP_LIMITS.bytes + 1)))).toEqual(["json"]);
    expect(readMapText("x".repeat(MAP_LIMITS.bytes + 1))).toMatchObject({ ok: false, issues: [{ code: "tooLarge" }] });
    // Un JSON très imbriqué
    expect(readMapText("[".repeat(100_000) + "]".repeat(100_000)).ok).toBe(false);
  });

  it("des bois qui ne trouvent pas de place : bornés, la vérification reste rapide", () => {
    // Trop d'arbres semés en tout : refusé avant de semer
    const many: MapPrefab[] = Array.from({ length: MAP_LIMITS.prefabs }, () => ({ kind: "woods", x: 0, z: 0, radius: 2, count: 200 }));
    expect(refused(withFields({ prefabs: many }))).toContainEqual({ code: "tooMany", what: "scattered", count: 60_000, max: MAP_LIMITS.scattered });
    // Au plus permis, le pire cas : chaque essai parcourt tous les chemins (des carrés qui font le tour de la carte, loin
    // du bois : leur emprise le couvre), puis bute sur une plateforme qui couvre le bois ; aucun arbre posé, en peu de temps
    const around = (side: number, n: number): [number, number][] => Array.from({ length: n }, (_, k) => {
      const t = (4 * k) / (n - 1);
      const u = -side + 2 * side * (t % 1);
      return t < 1 ? [u, -side] : t < 2 ? [side, u] : t < 3 ? [-u, side] : [-side, -u];
    });
    const paths = Array.from({ length: MAP_LIMITS.pathPoints / MAP_LIMITS.points }, (_, i) => ({ width: 1, points: around(64 - i * 0.05, MAP_LIMITS.points) }));
    // (plus de points en tout : refusé)
    expect(codes(refused(withFields({ paths: [...paths, ...paths] })))).toContain("tooMany");
    const woods: MapPrefab[] = Array.from({ length: 6 }, () => ({ kind: "woods", x: 30, z: 45, radius: 6, count: 200 }));
    const platform = { kind: "platform" as const, x: 30, z: 45, size: [20, 1, 20] as const };
    const start = performance.now();
    const check = checkMap(withFields({ paths, prefabs: woods, boxes: [platform] }));
    expect(performance.now() - start).toBeLessThan(5000);
    expect(check.arena?.props.filter((p) => p.type === "pine" || p.type === "oak")).toHaveLength(0);
  });

  it("la plus grande carte, une grille de passage fine et toute la lave permise : vérifiée en peu de temps", () => {
    const big = blankMap({ name: "Grande", author: "Tests", half: 195 });
    // Des coulées en zigzag sur toute la carte : chaque case de la grille les parcourt toutes
    const lava = Array.from({ length: MAP_LIMITS.lava }, (_, i) => ({
      kind: "flow" as const, width: 1,
      points: Array.from({ length: MAP_LIMITS.lavaPoints / MAP_LIMITS.lava }, (_, k): [number, number] => [k % 2 ? 190 : -190, -190 + i * 11 + (k % 3)]),
    }));
    const start = performance.now();
    const issues = validateMap({ ...big, lava, nav: { cell: MAP_LIMITS.minNavCell, maxSlope: 30 } });
    expect(performance.now() - start).toBeLessThan(8000);
    expect(issues.length).toBeGreaterThan(0); // (la lave coupe tout)
  });

  it("des préfabriqués qui déplieraient trop d'accessoires : arrêtés, et signalés", () => {
    const houses: MapPrefab[] = Array.from({ length: MAP_LIMITS.prefabs }, (_, i) => ({
      kind: "tenement", x: -60 + (i % 10) * 12, z: -60 + Math.floor(i / 10) * 4, width: 10, depth: 4, floors: 8, wall: "facade",
    }));
    const start = performance.now();
    const issues = validateMap(withFields({ prefabs: houses }));
    expect(performance.now() - start).toBeLessThan(3000);
    expect(issues).toContainEqual(expect.objectContaining({ code: "tooMany", what: "props" }));
  });
});

describe("cartes : import d'un relief", () => {
  /** Un PNG gris de `bits` bits, chaque ligne avec son filtre (0 à 4, en boucle), que `decodePng` doit défaire. */
  function filteredPng(width: number, height: number, values: number[], bits: 8 | 16): Uint8Array {
    const bpp = bits / 8;
    const stride = width * bpp;
    const rows: Uint8Array[] = [];
    const plain = (y: number): Uint8Array => {
      const row = new Uint8Array(stride);
      for (let x = 0; x < width; x++) {
        const v = values[y * width + x];
        if (bits === 16) {
          row[x * 2] = v >> 8;
          row[x * 2 + 1] = v & 255;
        } else row[x] = v;
      }
      return row;
    };
    for (let y = 0; y < height; y++) {
      const cur = plain(y);
      const prev = y > 0 ? plain(y - 1) : new Uint8Array(stride);
      const filter = y % 5;
      const out = new Uint8Array(stride + 1);
      out[0] = filter;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        const up = prev[i];
        const corner = i >= bpp ? prev[i - bpp] : 0;
        const p = left + up - corner;
        const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
        const pred = [0, left, up, (left + up) >> 1, paeth][filter];
        out[i + 1] = (cur[i] - pred) & 255;
      }
      rows.push(out);
    }
    const raw = new Uint8Array(rows.reduce((n, r) => n + r.length, 0));
    let o = 0;
    for (const r of rows) {
      raw.set(r, o);
      o += r.length;
    }
    const header = new Uint8Array(13);
    new DataView(header.buffer).setUint32(0, width);
    new DataView(header.buffer).setUint32(4, height);
    header[8] = bits;
    const chunk = (type: string, data: Uint8Array): Uint8Array => {
      const c = new Uint8Array(12 + data.length);
      new DataView(c.buffer).setUint32(0, data.length);
      for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
      c.set(data, 8);
      return c; // (CRC laissé à zéro : le décodeur ne le vérifie pas)
    };
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflate(raw)), chunk("IEND", new Uint8Array(0))];
    const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    o = 0;
    for (const p of parts) {
      png.set(p, o);
      o += p.length;
    }
    return png;
  }

  it("PNG 16 bits : chaque filtre de ligne est défait, les valeurs gardent leurs 16 bits", async () => {
    const width = 7;
    const height = 10;
    const values = Array.from({ length: width * height }, (_, i) => (i * 1031 + 17) % 65536);
    const img = await decodePng(filteredPng(width, height, values, 16), inflate);
    expect([img.width, img.height, img.bits]).toEqual([width, height, 16]);
    values.forEach((v, i) => expect(Math.round(img.data[i] * 65535)).toBe(v));
  });

  it("PNG 8 bits, et PNG écrit par `encodePng` (16 bits, CRC compris)", async () => {
    const values = Array.from({ length: 30 }, (_, i) => (i * 29) % 256);
    const img = await decodePng(filteredPng(5, 6, values, 8), inflate);
    expect(img.bits).toBe(8);
    values.forEach((v, i) => expect(Math.round(img.data[i] * 255)).toBe(v));
    const source: HeightImage = { width: 9, height: 4, data: Float32Array.from({ length: 36 }, (_, i) => i / 35), bits: 16 };
    const round = await decodePng(await encodePng(source, deflate), inflate);
    source.data.forEach((v, i) => expect(round.data[i]).toBeCloseTo(v, 4));
  });

  it("ce qui n'est pas un PNG lisible : une erreur avec son code", async () => {
    const fails = async (bytes: Uint8Array): Promise<string> => {
      try {
        await decodePng(bytes, inflate);
      } catch (e) {
        return isHeightmapError(e) ? e.code : "autre";
      }
      return "aucune";
    };
    expect(await fails(new Uint8Array([1, 2, 3]))).toBe("notPng");
    const png = filteredPng(3, 3, Array(9).fill(5), 8);
    expect(await fails(png.subarray(0, 40))).toBe("corrupt");
  });

  it("RAW 16 bits carré, petit- ou gros-boutiste ; pas carré : refusé", () => {
    const bytes = new Uint8Array(3 * 3 * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 9; i++) view.setUint16(i * 2, i * 1000, true);
    const little = decodeRaw16(bytes);
    expect([little.width, little.height]).toEqual([3, 3]);
    expect(Math.round(little.data[4] * 65535)).toBe(4000);
    const big = decodeRaw16(bytes, false);
    expect(Math.round(big.data[1] * 65535)).toBe(((1000 & 255) << 8) | (1000 >> 8));
    expect(() => decodeRaw16(new Uint8Array(10))).toThrow();
  });

  it("l'image se lit comme la carte : le haut au nord (+z), la gauche à l'ouest (+x) ; échelle verticale et montagnes au bord", () => {
    // Une image noire, sauf son coin en haut à gauche (blanc)
    const img = imageFromBytes(4, 4, [255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const cells = 40;
    const terrain = decodeTerrain(terrainFromImage(img, { cells, step: 2, low: 1, high: 21, smooth: 0 }))!;
    expect(terrainHeight(terrain, 39, 39)).toBeGreaterThan(15); // nord-ouest
    expect(terrainHeight(terrain, -39, -39)).toBeCloseTo(1, 1);
    expect(terrainHeight(terrain, -39, 39)).toBeCloseTo(1, 1);
    // Montagnes : le bord monte, le centre ne bouge pas
    const flat = imageFromBytes(2, 2, [0, 0, 0, 0]);
    const heights = heightsFromImage(flat, { cells, step: 2, low: 2, high: 2, mountains: { from: 25, height: 30 } });
    const t = { size: 80, cells, heights };
    expect(terrainHeight(t, 0, 0)).toBeCloseTo(2, 3);
    expect(terrainHeight(t, 40, 0)).toBeGreaterThan(25);
    // Une image 8 bits est lissée : ses marches disparaissent
    const steps = imageFromBytes(16, 1, Array.from({ length: 16 }, (_, i) => (i < 8 ? 10 : 11)));
    const smooth = heightsFromImage(steps, { cells: 16, step: 1, low: 0, high: 255 });
    expect(smooth.some((h) => h > 10.1 && h < 10.9)).toBe(true);
    // Et l'inverse : le relief en image, orientée pareil
    const back = imageFromHeights(terrain.heights, cells);
    expect(back.image.data[0]).toBeGreaterThan(0.7);
    expect(back.image.data[back.image.data.length - 1]).toBeLessThan(0.05);
  });
});

describe("cartes : arène et validation", () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it("une carte de départ se joue : relief, zones, grille de passage, limites", () => {
    const check = checkMap(base());
    expect(check.issues).toEqual([]);
    const arena = check.arena!;
    expect(arena.id).toBe(check.key);
    expect(arena.community?.name).toBe("Essai");
    expect(arena.terrain?.cells).toBe(base().terrain!.cells);
    expect(arena.zones.map((z) => z.label)).toEqual(["A", "B", "C"]);
    expect(arena.zones[1].pos.y).toBeCloseTo(2, 1);
    expect(navGrid(arena)).not.toBeNull();
    expect(arena.boxes.filter((b) => b.kind === "bound")).toHaveLength(4);
    expect(arena.bounds.spawnLine).toBe(56);
    expect(arena.ambience).toBe("valley");
  });

  it("la carte minimale du guide (docs/maps.md) se joue : plate, sans grille de passage", () => {
    const check = checkMap({
      format: 1,
      meta: { name: "Ma carte", author: "Moi", license: "CC-BY-4.0" },
      bounds: { half: 60 },
      zones: [{ label: "A", x: 0, z: 0, radius: 6 }],
    });
    expect(check.issues).toEqual([]);
    expect(check.arena?.terrain).toBeUndefined();
    expect(navGrid(check.arena!)).toBeNull();
    expect(check.arena?.bounds).toMatchObject({ half: 60, spawnLine: 48, spawnSpread: 18 });
  });

  it("les préfabriqués se déplient : maison, immeuble, clôture, bois, rochers, rampe, pont, conteneurs", () => {
    const prefabs: MapPrefab[] = [
      { kind: "house", x: 20, z: 20, width: 8, depth: 6, height: 3, wall: "brick", roof: "roof", door: 2, yaw: 30 },
      { kind: "tenement", x: -20, z: 20, width: 12, depth: 8, floors: 3, wall: "tenement", ruin: 0.3, seed: 4 },
      { kind: "fence", points: [[0, -20], [10, -20], [10, -10]], material: "plank" },
      { kind: "woods", x: -30, z: -25, radius: 18, count: 10, trees: ["pine", "oak"], seed: 3 },
      { kind: "rocks", x: 30, z: -25, radius: 10, count: 5, seed: 2 },
      { kind: "ramp", x: 0, z: 30, width: 4, length: 6, rise: 1.5, yaw: 90 },
      { kind: "bridge", from: [-10, 0], to: [10, 0], width: 6 },
      { kind: "containers", x: 40, z: 0, count: 3, levels: 2 },
    ];
    const map = withFields({ prefabs, props: [{ type: "barrel", x: 5, z: 5 }] });
    const check = checkMap(map);
    expect(check.issues).toEqual([]);
    const arena = check.arena!;
    // La maison : des pans de briques et un toit, un seul bâtiment, qui repose sur ses murs
    const house = arena.props.filter((p) => p.type === "brick" || p.type === "roof");
    expect(house.length).toBeGreaterThan(6);
    expect(new Set(house.map((p) => p.building)).size).toBe(1);
    expect(arena.props.some((p) => p.type === "roof" && p.rests?.length)).toBe(true);
    // L'immeuble : des étages de façade, un toit de béton ; un autre bâtiment
    const tenement = arena.props.filter((p) => p.type === "tenement");
    expect(tenement.length).toBeGreaterThan(10);
    expect(tenement[0].building).not.toBe(house[0].building);
    // La clôture : des planches, au plus 2,5 m chacune
    expect(arena.props.filter((p) => p.type === "plank").length).toBe(8);
    // Le bois : dix arbres, toujours les mêmes ; les rochers
    const trees = arena.props.filter((p) => p.type === "pine" || p.type === "oak");
    expect(trees).toHaveLength(10);
    expect(checkMap(map).arena!.props.filter((p) => p.type === "pine" || p.type === "oak")).toEqual(trees);
    expect(arena.boxes.filter((b) => b.kind === "rock")).toHaveLength(5);
    expect(arena.boxes.filter((b) => b.kind === "ramp")).toHaveLength(1);
    expect(arena.boxes.filter((b) => b.kind === "container")).toHaveLength(6);
    // Le pont : un tablier que la grille de passage reconnaît comme un pont
    expect(bridgeDecks(arena)).toHaveLength(1);
    // L'accessoire de la carte est posé sur le sol, en premier
    expect(arena.props[0].type).toBe("barrel");
    expect(arena.props[0].pos.y).toBeCloseTo(2 + 0.5 + 0.03, 2);
  });

  it("une boîte, un accessoire sans hauteur sont posés sur le relief ; avec, à leur hauteur", () => {
    const map = withFields({
      boxes: [{ kind: "platform", x: 10, z: 10, size: [4, 2, 4] }, { kind: "pillar", x: -10, z: 10, y: 9, size: [1, 2, 1] }],
      props: [{ type: "pine", x: 0, z: 10 }, { type: "crate", x: 3, z: 3, y: 6 }, { type: "brick", x: 6, z: 6, size: [3, 2, 0.3], yaw: 45 }, { type: "brick", x: 8, z: 8, size: [3, 0.2, 3], y: 4, rests: [2], group: 1 }],
    });
    const check = checkMap(map);
    expect(check.issues).toEqual([]);
    const arena = check.arena!;
    expect(arena.boxes[0].pos.y).toBeCloseTo(3, 1);
    expect(arena.boxes[1].pos.y).toBe(9);
    // Un sapin : son pied au sol (2 m), son centre à mi-hauteur de son tronc
    expect(arena.props[0].pos.y).toBeCloseTo(2 + 4.5, 1);
    expect(arena.props[1].pos.y).toBeCloseTo(6.5, 3);
    expect(arena.props[3].rests).toEqual([2]);
    expect(arena.props[3].building).toBe(0);
    // Une dalle sans dimensions est refusée
    expect(validateMap(withFields({ props: [{ type: "brick", x: 0, z: 0 }] }))).toContainEqual({ code: "field", path: "props[0].size" });
  });

  it("la palette du sol part d'une arène du jeu ; le ciel, l'eau, la lave, les lieux nommés passent", () => {
    const map = withFields({
      ground: { preset: "canyon", rock: "#112233" },
      sky: { color: "#aabbcc", fog: 0.003 },
      water: { level: 1, deep: 0.8, color: "#224466" },
      lava: [{ kind: "pool", x: 40, z: 40, r: 4 }],
      places: [{ name: "Le moulin", names: { en: "The mill" }, x: 10, z: 10 }],
      ambience: "canyon",
      falls: [{ x: 0, z: 40, top: 8, bottom: 2, width: 3, dir: 90 }],
    });
    const check = checkMap(map);
    expect(check.issues).toEqual([]);
    const arena = check.arena!;
    expect(arena.ground?.rock).toBe("#112233");
    expect(arena.ground?.strata?.length).toBeGreaterThan(0);
    expect(arena.sky).toEqual({ color: "#aabbcc", fog: 0.003 });
    expect([arena.water, arena.deepWater, arena.waterColor]).toEqual([1, 0.8, "#224466"]);
    expect(arena.places).toEqual([{ name: "Le moulin", names: { en: "The mill" }, x: 10, z: 10 }]);
    expect(arena.falls?.[0].dir).toBeCloseTo(Math.PI / 2, 6);
    expect(arena.ambience).toBe("canyon");
    // La lave ferme la grille de passage
    expect(passable(arena, 40, 40)).toBe(false);
  });

  it("validation : lignes de départ encombrées ou dangereuses, zones inaccessibles, dimensions incohérentes", () => {
    const line = base().bounds.half * 0.8;
    // Un mur tout le long de la ligne des rouges
    const wall = withFields({ boxes: [{ kind: "wall", x: 0, z: line, size: [60, 3, 2] }] });
    expect(validateMap(wall)).toContainEqual({ code: "spawnBlocked", team: "red" });
    // Un baril tout près de la ligne des bleus
    const barrel = withFields({ props: [{ type: "barrel", x: 0, z: -line - 4 }] });
    expect(validateMap(barrel)).toContainEqual({ code: "spawnHazard", team: "blue" });
    // Une zone au milieu d'un lac de lave
    const lava = withFields({ lava: [{ kind: "pool", x: 30, z: 0, r: 12 }], zones: [...base().zones, { label: "D", x: 30, z: 0, radius: 4 }] });
    expect(validateMap(lava)).toContainEqual({ code: "zoneUnreachable", zone: "D" });
    // Deux zones de la même lettre
    expect(codes(validateMap(withFields({ zones: [{ label: "A", x: 0, z: 0, radius: 5 }, { label: "A", x: 10, z: 0, radius: 5 }] })))).toContain("zones");
    // Une ligne de départ hors de la zone de jeu, une zone hors de la carte
    expect(validateMap(withFields({ bounds: { half: 70, spawnLine: 90 } }))).toContainEqual({ code: "bounds", path: "bounds.spawnLine" });
    expect(validateMap(withFields({ zones: [{ label: "A", x: 100, z: 0, radius: 5 }] }))).toContainEqual({ code: "outside", path: "zones[0]" });
    // Un relief trop petit pour la zone de jeu
    expect(codes(validateMap(withFields({ bounds: { half: 150 } })))).toContain("terrainSmall");
  });

  it("une carte se charge dans la simulation comme une arène du jeu, et une bataille s'y déroule", () => {
    seedRandom(5);
    const sim = new Simulation();
    const events: string[] = [];
    sim.on((e) => e.type === "arenaChanged" && events.push(e.arena));
    const arena: ArenaLayout = registerMap(base());
    expect(arenaById(arena.id)).toBe(arena);
    sim.loadArena(arena.id);
    expect(events).toEqual([arena.id]);
    expect(sim.arena).toBe(arena);
    const bots = spawnTeams(sim, pickRoster(GAME_MODES.battle).map((profile, i) => ({ profile, team: i % 2 ? "red" : "blue" })));
    for (let i = 0; i < 60 * 4; i++) sim.step();
    for (const bot of bots) {
      if (!bot.cockpit.alive || bot.profile.mobility === "plane") continue;
      const p = bot.cockpit.part.rb.translation();
      expect(Math.abs(p.x)).toBeLessThan(arena.bounds.half + 40);
      expect(p.y).toBeGreaterThan(0);
    }
    // Et revenir à une arène du jeu
    sim.loadArena("depot");
    expect(sim.arena.id).toBe("depot");
    sim.dispose();
  });
});
