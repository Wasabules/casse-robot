import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mendForeignLoop } from "../src/client/audio/samples";
import { withAsset } from "../src/client/editor/editor";
import { httpOrigin, MapAssetStore } from "../src/client/maps/assets";
import { blankMap, mapKey, modelPath, PACKAGE_FILES, type AssetEntry, type MapFile } from "../src/shared/map";
import { sha256 } from "../src/shared/media/sha256";
import { MAP_ASSET_PATH } from "../src/shared/net/protocol";
import { crateModel } from "../tools/models/crate";
import { writeGlb } from "../tools/models/glb";

/*
 * Les ressources des cartes dans le navigateur (client/maps/assets.ts) : celles d'une carte reçue d'un
 * serveur se téléchargent chez lui (`MAP_ASSET_PATH`, d'après l'adresse de sa WebSocket), et ne sont
 * rendues que vérifiées (taille, empreinte, sorte) ; un serveur qui envoie autre chose, ou trop, est
 * ignoré. Dans Node, sans IndexedDB : rien n'est gardé d'une page à l'autre, rien ne casse. Et
 * l'éditeur de cartes ajoute ou retire une ressource (`withAsset`) : sans ressources, la carte est
 * celle d'avant.
 */

const CRATE = writeGlb(crateModel());
const AMBIENCE = new Uint8Array(readFileSync(join(__dirname, "..", "public", "sounds", "amb-valley-1.ogg")));
const asset = (bytes: Uint8Array): { sha256: string; bytes: number } => ({ sha256: sha256(bytes), bytes: bytes.length });
const crateEntry: AssetEntry = { path: modelPath("crate"), asset: asset(CRATE), type: "crate" };

/** Un serveur simulé : les ressources qu'il sert d'après leur adresse, et les adresses demandées. */
function serve(files: Record<string, Uint8Array>): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    const bytes = files[url];
    return bytes ? new Response(bytes.slice()) : new Response("", { status: 404 });
  });
  return asked;
}

describe("ressources des cartes dans le navigateur", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => {
    vi.unstubAllGlobals();
    warn.mockClear();
  });

  it("l'origine HTTP d'un serveur d'après sa WebSocket", () => {
    expect(httpOrigin("ws://192.168.1.10:8787")).toBe("http://192.168.1.10:8787");
    expect(httpOrigin("wss://exemple.trycloudflare.com")).toBe("https://exemple.trycloudflare.com");
    expect(httpOrigin("http://x")).toBeNull();
    expect(httpOrigin("pas une adresse")).toBeNull();
  });

  it("une carte reçue d'un serveur : ses ressources se téléchargent chez lui, une fois, vérifiées", async () => {
    const origin = "http://serveur:8787";
    const asked = serve({ [`${origin}${MAP_ASSET_PATH}${crateEntry.asset.sha256}`]: CRATE });
    const store = new MapAssetStore();
    const map: MapFile = { ...blankMap({ name: "Essai", author: "Tests", half: 40 }), assets: { models: { crate: crateEntry.asset } } };
    store.fetchFrom(origin, map);
    expect(await store.bytes(crateEntry)).toEqual(CRATE);
    expect(await store.bytes(crateEntry)).toEqual(CRATE);
    expect(asked).toEqual([`${origin}${MAP_ASSET_PATH}${crateEntry.asset.sha256}`]);
    // Le paquet de la carte se refait avec ses ressources
    expect((await store.shelfOf(map))?.get(crateEntry.asset.sha256)).toEqual(CRATE);
  });

  it("un serveur qui envoie autre chose, ou plus que la taille dite, est ignoré ; une ressource inconnue rend null", async () => {
    const origin = "http://hostile:8787";
    const forged = CRATE.slice();
    forged[200] ^= 1;
    serve({
      [`${origin}${MAP_ASSET_PATH}${crateEntry.asset.sha256}`]: forged,
      [`${origin}${MAP_ASSET_PATH}${sha256(AMBIENCE)}`]: new Uint8Array(AMBIENCE.length + 10_000),
    });
    const store = new MapAssetStore();
    const ambienceEntry: AssetEntry = { path: PACKAGE_FILES.ambience, asset: asset(AMBIENCE), type: null };
    store.fetchFrom(origin, { assets: { models: { crate: crateEntry.asset }, ambience: ambienceEntry.asset } });
    expect(await store.bytes(crateEntry)).toBeNull();
    expect(await store.bytes(ambienceEntry)).toBeNull();
    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said.some((s) => s.startsWith("Ressource de carte refusée"))).toBe(true);
    expect(said.some((s) => s.startsWith("Ressource de carte introuvable"))).toBe(true);
    expect(await new MapAssetStore().bytes(crateEntry)).toBeNull();
  });

  it("l'ambiance d'une carte : ramenée au niveau des boucles du jeu, sa fin fondue dans son début, sans à-coup au raccord", () => {
    const rate = 8000;
    const length = rate * 3;
    // Une boucle mal raccordée et trop forte : un son qui ne retombe pas sur son début
    const data = Float32Array.from({ length }, (_, i) => 0.9 * Math.sin((2 * Math.PI * 110 * i) / rate + i / length));
    const buffer = { sampleRate: rate, length, numberOfChannels: 1, duration: 3, getChannelData: () => data } as unknown as AudioBuffer;
    const loopStart = mendForeignLoop(buffer);
    expect(loopStart).toBeCloseTo(0.25, 6);
    const rms = Math.sqrt(data.reduce((s, x) => s + x * x, 0) / length);
    expect(20 * Math.log10(rms)).toBeCloseTo(-16, 0);
    // Au raccord, le dernier échantillon mène à celui de `loopStart` comme deux voisins du son
    const start = Math.round(loopStart * rate);
    const step = Math.max(...Array.from({ length: 200 }, (_, i) => Math.abs(data[1000 + i + 1] - data[1000 + i])));
    expect(Math.abs(data[start] - data[length - 1])).toBeLessThan(step * 1.5);
  });

  it("l'éditeur ajoute, remplace et retire une ressource ; sans ressources, la carte redevient celle d'avant", () => {
    const map = blankMap({ name: "Essai", author: "Tests", half: 40 });
    const one = withAsset(map, "crate", crateEntry.asset);
    const two = withAsset(withAsset(one, null, asset(AMBIENCE)), "barrel", crateEntry.asset);
    expect(Object.keys(two.assets!.models!)).toEqual(["barrel", "crate"]);
    expect(two.assets!.ambience).toEqual(asset(AMBIENCE));
    expect(mapKey(two)).not.toBe(mapKey(one));
    const back = withAsset(withAsset(withAsset(two, "barrel", null), null, null), "crate", null);
    expect(back.assets).toBeUndefined();
    expect(mapKey(back)).toBe(mapKey(map));
  });
});
