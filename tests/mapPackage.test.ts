import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ARENAS } from "../src/shared/arena/layout";
import {
  decodePng, mapFromArena, mapKey, mapText, packageImage, packMap, readMapText, terrainCodes, unpackMap, type MapFile,
} from "../src/shared/map";
import { licenseText } from "../tools/maps/packages";

/*
 * Paquets de cartes (shared/map/pack.ts, `npm run map:pack` et `map:unpack`) : un dossier avec
 * map.json (la carte, son relief nommant son image), terrain.png (le relief en 16 bits) et
 * LICENSE.txt. Une carte mise en paquet puis refaite est la même, au texte près ; l'image se lit
 * comme une image de relief (le nord en haut, l'ouest à gauche) ; un paquet abîmé est refusé.
 */

const BUNDLED = import.meta.glob<string>("../maps/*.casse-map.json", { query: "?raw", import: "default", eager: true });
const deflate = (d: Uint8Array): Uint8Array => new Uint8Array(deflateSync(d));
const inflate = (d: Uint8Array): Uint8Array => new Uint8Array(inflateSync(d));

/** Une carte lue d'après son texte. */
function read(text: string): MapFile {
  const r = readMapText(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.map;
}

/** Une carte mise en paquet, son map.json écrit en texte puis relu comme le fait l'outil, et refaite. */
async function roundTrip(map: MapFile): Promise<{ text: string; json: string; png: Uint8Array | null }> {
  const parts = await packMap(map, deflate);
  const json = mapText(parts.map);
  const r = await unpackMap(JSON.parse(json), parts.terrain, inflate);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return { text: mapText(r.map), json, png: parts.terrain };
}

describe("paquets de cartes", () => {
  it("une carte livrée, mise en paquet puis refaite, redonne le même fichier et le même identifiant", async () => {
    expect(Object.keys(BUNDLED).length).toBeGreaterThan(0);
    for (const [path, text] of Object.entries(BUNDLED)) {
      const map = read(text);
      const back = await roundTrip(map);
      expect(back.text === mapText(map), path).toBe(true);
      expect(mapKey(read(back.text))).toBe(mapKey(map));
      // La carte du paquet nomme son image, sans ses hauteurs
      const packed = JSON.parse(back.json) as { terrain: Record<string, unknown> };
      expect(packed.terrain).toEqual({ cells: map.terrain!.cells, step: map.terrain!.step, min: map.terrain!.min, max: map.terrain!.max, image: "terrain.png" });
    }
  });

  it("une arène du jeu (relief au pas de 1,25 m, orientations exactes) aussi", async () => {
    const map = mapFromArena(ARENAS.island);
    expect((await roundTrip(map)).text === mapText(map)).toBe(true);
    // Sans relief : pas d'image
    const flat = mapFromArena(ARENAS.depot);
    const parts = await packMap(flat, deflate);
    expect(parts.terrain).toBeNull();
    expect((await roundTrip(flat)).text === mapText(flat)).toBe(true);
  });

  it("l'image du relief se lit comme une image importée : le nord en haut, l'ouest à gauche, un code par pixel", async () => {
    const map = read(Object.values(BUNDLED)[0]);
    const t = map.terrain!;
    const codes = terrainCodes(t)!;
    const img = await decodePng((await packMap(map, deflate)).terrain!, inflate);
    const n = t.cells + 1;
    expect([img.width, img.height, img.bits]).toEqual([n, n, 16]);
    const code = (row: number, col: number): number => Math.round(img.data[row * n + col] * 65535);
    // Le coin en haut à gauche : le nord-ouest (+x, +z) ; en bas à droite : le sud-est (-x, -z)
    expect(code(0, 0)).toBe(codes[t.cells * n + t.cells]);
    expect(code(n - 1, n - 1)).toBe(codes[0]);
    expect(code(0, n - 1)).toBe(codes[t.cells]);
    expect(code(n - 1, 0)).toBe(codes[t.cells * n]);
  });

  it("un paquet abîmé est refusé : image absente, illisible, d'une autre taille ; un nom d'image hors du paquet est ignoré", async () => {
    const map = read(Object.values(BUNDLED)[0]);
    const parts = await packMap(map, deflate);
    const json = JSON.parse(mapText(parts.map)) as { terrain: Record<string, unknown> };
    expect(await unpackMap(json, null, inflate)).toEqual({ ok: false, issues: [{ code: "terrainData" }] });
    expect(await unpackMap(json, new Uint8Array([1, 2, 3]), inflate)).toEqual({ ok: false, issues: [{ code: "terrainData" }] });
    const small = await packMap(mapFromArena(ARENAS.island), deflate);
    expect(await unpackMap(json, small.terrain, inflate)).toEqual({ ok: false, issues: [{ code: "terrainData" }] });
    // Une taille de relief hors des bornes : la lecture le dit, sans lire l'image
    const huge = { ...json, terrain: { ...json.terrain, cells: 5000 } };
    const r = await unpackMap(huge, parts.terrain, inflate);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain("terrainSize");
    expect(await unpackMap("pas une carte", null, inflate)).toEqual({ ok: false, issues: [{ code: "json" }] });
    expect(packageImage(json)).toBe("terrain.png");
    for (const name of ["../terrain.png", "/etc/terrain.png", "a/b.png", "terrain.exe", ".png", 5]) {
      expect(packageImage({ terrain: { image: name } }), String(name)).toBeNull();
    }
  });

  it("LICENSE.txt dit la licence de la carte et son auteur", () => {
    const meta = { name: "Val du Lac", author: "Moi", license: "CC-BY-4.0" };
    const text = licenseText(meta);
    expect(text).toContain("CC-BY-4.0");
    expect(text).toContain("Moi");
    expect(text).toContain("https://spdx.org/licenses/CC-BY-4.0.html");
    expect(licenseText({ ...meta, license: "Tous droits réservés" })).not.toContain("spdx.org");
  });
});
