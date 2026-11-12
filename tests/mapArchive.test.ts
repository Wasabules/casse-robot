import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, deflateSync, inflateRawSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assetEntries, assetMatches, checkMap, folderSource, isArchive, mapKey, mapText, modelPath, PACKAGE_FILES, PACKAGE_LIMITS, packageEntries, packMap,
  readMap, readMapArchive, readMapText, readPackage, writeMapArchive, type AssetShelf, type FolderAccess, type MapFile, type MapIssue, type PackageRead,
} from "../src/shared/map";
import { inspectGlb } from "../src/shared/media/glb";
import { inspectOpus } from "../src/shared/media/ogg";
import { sha256 } from "../src/shared/media/sha256";
import { openZip, safeEntryName, writeZip, type ZipEntry } from "../src/shared/media/zip";
import { crateModel } from "../tools/models/crate";
import { writeGlb } from "../tools/models/glb";
import { licenseText } from "../tools/maps/packages";

/*
 * Paquets de cartes en un fichier (shared/map/pack.ts, shared/media/) : l'archive zip lue et écrite
 * sans dépendance, l'empreinte SHA-256, les contrôles d'un modèle glTF et d'un Ogg Opus, et un paquet
 * avec ses ressources (modèles d'accessoires, ambiance) : il se relit à l'identique, l'identifiant de
 * la carte couvre ses ressources (et ne change pas sans elles), et tout ce qui vient de n'importe qui
 * est borné et refusé sans lever d'exception. `PACKAGE_REPORT=1 … --silent=false` : les mesures.
 */

const ROOT = join(__dirname, "..");
const LAKE = readFileSync(join(ROOT, "maps", "val-du-lac.casse-map.json"), "utf8");
const AMBIENCE = new Uint8Array(readFileSync(join(ROOT, "public", "sounds", "amb-valley-1.ogg")));
const CRATE = writeGlb(crateModel());

const deflate = (d: Uint8Array): Uint8Array => new Uint8Array(deflateSync(d, { level: 9 }));
const inflate = (d: Uint8Array): Uint8Array => new Uint8Array(inflateSync(d));
const deflateRaw = (d: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(d, { level: 9 }));
/** Comme dans le serveur : au-delà de la taille annoncée, la décompression s'arrête. */
const inflateRaw = (d: Uint8Array, max: number): Uint8Array => new Uint8Array(inflateRawSync(d, { maxOutputLength: Math.max(1, max) }));
const report = process.env.PACKAGE_REPORT === "1";

function read(text: string): MapFile {
  const r = readMapText(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.map;
}

const shelfOf = (...files: Uint8Array[]): AssetShelf => new Map(files.map((f) => [sha256(f), f]));
const asset = (bytes: Uint8Array): { sha256: string; bytes: number } => ({ sha256: sha256(bytes), bytes: bytes.length });

/** Val du Lac avec un modèle de caisse et une ambiance. */
function lakeWithAssets(model = CRATE, ambience: Uint8Array | null = AMBIENCE): MapFile {
  return { ...read(LAKE), assets: { models: { crate: asset(model) }, ...(ambience ? { ambience: asset(ambience) } : {}) } };
}

const codes = (r: PackageRead): string[] => (r.ok ? [] : r.issues.map((i) => i.code));
/** Où commencent les en-têtes d'une sorte dans une archive (« PK » puis ces deux octets : 3, 4 l'en-tête local ; 1, 2 le répertoire central). */
function headers(bytes: Uint8Array, a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i++) if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === a && bytes[i + 3] === b) out.push(i);
  return out;
}
const archive = (entries: ZipEntry[]): Promise<Uint8Array> => writeZip(entries, deflateRaw);
const mapEntry = (map: unknown): ZipEntry => ({ name: PACKAGE_FILES.map, data: new TextEncoder().encode(JSON.stringify(map)), deflate: true });

describe("SHA-256", () => {
  it("donne l'empreinte de Node, de 0 à 200 octets et sur un gros fichier", () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 131 + n * 7) & 255);
      expect(sha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(sha256(AMBIENCE)).toBe(createHash("sha256").update(AMBIENCE).digest("hex"));
    // Une vue au milieu d'un tampon
    const view = AMBIENCE.subarray(13, 9000);
    expect(sha256(view)).toBe(createHash("sha256").update(view).digest("hex"));
  });
});

describe("archive zip", () => {
  it("se relit à l'identique : entrées rangées ou dégonflées, noms en UTF-8, les mêmes fichiers donnent les mêmes octets", async () => {
    const entries: ZipEntry[] = [
      { name: "map.json", data: new TextEncoder().encode("{\"a\": 1}".repeat(100)), deflate: true },
      { name: "models/props/crate.glb", data: CRATE, deflate: true },
      { name: "sounds/ambience.ogg", data: AMBIENCE },
      { name: "notes/é.txt", data: new Uint8Array(0), deflate: true },
    ];
    const zip = await archive(entries);
    expect(await archive(entries)).toEqual(zip);
    const open = openZip(zip, { bytes: 1e8, entries: 16 });
    if (!open.ok) throw new Error(JSON.stringify(open.problem));
    expect(open.archive.names).toEqual(entries.map((e) => e.name));
    for (const e of entries) {
      expect(open.archive.size(e.name)).toBe(e.data.length);
      expect(await open.archive.read(e.name, inflateRaw), e.name).toEqual(e.data);
    }
    expect(await open.archive.read("absent", inflateRaw)).toBeNull();
    // L'archive de Node se lit aussi : un outil d'archives ordinaire ferait de même (un dossier, une date, un commentaire)
    expect(isArchive(zip)).toBe(true);
    expect(isArchive(new TextEncoder().encode(LAKE))).toBe(false);
  });

  it("refuse ce qui viendrait de n'importe qui : trop gros, trop d'entrées, noms dangereux, doublons, chiffrée, abîmée", async () => {
    const one = await archive([{ name: "map.json", data: new Uint8Array(1000).fill(65), deflate: true }]);
    expect(openZip(one, { bytes: 100, entries: 4 })).toEqual({ ok: false, problem: { code: "tooLarge", size: one.length, max: 100 } });
    const many = await archive(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(1) })));
    expect(openZip(many, { bytes: 1e6, entries: 4 })).toEqual({ ok: false, problem: { code: "entries", count: 5, max: 4 } });
    for (const name of ["../map.json", "/map.json", "a/../b", "C:/x", "a\\b", "a//b", "./a", ""]) expect(safeEntryName(name), name).toBe(false);
    for (const name of ["map.json", "models/props/crate.glb", "sounds/", "é.txt"]) expect(safeEntryName(name), name).toBe(true);
    // Un nom dangereux écrit à la main dans l'archive (writeZip refuse de l'écrire)
    const evil = await archive([{ name: "xx/map.json", data: new Uint8Array(3) }]);
    const bytes = evil.slice();
    const at = (n: number): number => bytes.findIndex((_, i) => bytes[i] === 0x78 && bytes[i + 1] === 0x78 && i > n);
    for (let i = at(-1); i >= 0; i = at(i)) bytes.set([0x2e, 0x2e], i);
    expect(openZip(bytes, { bytes: 1e6, entries: 4 })).toEqual({ ok: false, problem: { code: "path", name: "../map.json" } });
    // Doublon : le nom de la seconde entrée devient celui de la première (en-tête local et répertoire central)
    const twice = await archive([{ name: "a", data: new Uint8Array(1) }, { name: "b", data: new Uint8Array(1) }]);
    const dup = twice.slice();
    dup[headers(dup, 3, 4)[1] + 30] = 0x61;
    dup[headers(dup, 1, 2)[1] + 46] = 0x61;
    expect(openZip(dup, { bytes: 1e6, entries: 4 })).toEqual({ ok: false, problem: { code: "format" } });
    // Chiffrée (drapeau 0 du répertoire central)
    const locked = one.slice();
    locked[headers(locked, 1, 2)[0] + 8] |= 1;
    expect(openZip(locked, { bytes: 1e6, entries: 4 })).toEqual({ ok: false, problem: { code: "format" } });
    // Une entrée qui se décompresse plus grande que ce qu'elle annonce (une « bombe ») : abîmée, et la décompression s'arrête
    const bomb = await archive([{ name: "map.json", data: new Uint8Array(4_000_000), deflate: true }]);
    expect(bomb.length).toBeLessThan(10_000);
    const small = bomb.slice();
    new DataView(small.buffer).setUint32(headers(small, 1, 2)[0] + 24, 1000, true);
    const opened = openZip(small, { bytes: 1e8, entries: 4 });
    expect(opened.ok && (await opened.archive.read("map.json", inflateRaw))).toBeNull();
    // Une somme de contrôle fausse
    const bad = one.slice();
    new DataView(bad.buffer).setUint32(headers(bad, 1, 2)[0] + 16, 1234, true);
    const badOpen = openZip(bad, { bytes: 1e6, entries: 4 });
    expect(badOpen.ok && (await badOpen.archive.read("map.json", inflateRaw))).toBeNull();
    // Pas une archive, tronquée
    expect(openZip(new Uint8Array(30), { bytes: 1e6, entries: 4 }).ok).toBe(false);
    expect(openZip(one.subarray(0, one.length - 5), { bytes: 1e6, entries: 4 }).ok).toBe(false);
  });

  it("des octets abîmés au hasard ne lèvent jamais d'exception", async () => {
    const zip = await writeMapArchive(lakeWithAssets(), shelfOf(CRATE, AMBIENCE), { deflate, deflateRaw, license: "x" });
    let seed = 7;
    const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 60; k++) {
      const bytes = zip.slice();
      for (let n = 0; n < 1 + Math.floor(random() * 8); n++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      const r = await readMapArchive(k % 7 ? bytes : bytes.subarray(0, Math.floor(random() * bytes.length)), inflate, inflateRaw);
      if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("contrôle des ressources", () => {
  it("un modèle glTF : celui du jeu passe ; un .gltf, une extension inconnue, un fichier tronqué sont refusés", () => {
    expect(inspectGlb(CRATE).problems).toEqual([]);
    expect(inspectGlb(new TextEncoder().encode("{\"asset\":{\"version\":\"2.0\"}}")).problems[0].code).toBe("magic");
    expect(inspectGlb(CRATE.subarray(0, 100)).problems[0].code).toBe("length");
    const draco = writeGlb({ ...crateModel(), extensionsRequired: ["KHR_draco_mesh_compression"] });
    expect(inspectGlb(draco).problems).toEqual([{ code: "extensions", list: ["KHR_draco_mesh_compression"] }]);
  });

  it("une ambiance Ogg Opus : une du jeu passe (stéréo, ~19 s) ; une page abîmée, un autre format, une durée hors des bornes sont refusés", () => {
    const ok = inspectOpus(AMBIENCE, { min: 2, max: 60 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.info.channels).toBe(2);
      expect(ok.info.seconds).toBeGreaterThan(15);
      expect(ok.info.seconds).toBeLessThan(25);
    }
    const damaged = AMBIENCE.slice();
    damaged[5000] ^= 0x55;
    expect(inspectOpus(damaged, { min: 2, max: 60 })).toEqual({ ok: false, problem: { code: "format" } });
    expect(inspectOpus(CRATE, { min: 2, max: 60 })).toEqual({ ok: false, problem: { code: "format" } });
    expect(inspectOpus(AMBIENCE.subarray(0, 4000), { min: 2, max: 60 }).ok).toBe(false);
    const long = inspectOpus(AMBIENCE, { min: 2, max: 10 });
    expect(long.ok ? null : long.problem.code).toBe("duration");
    const mono = inspectOpus(AMBIENCE, { min: 2, max: 60, maxChannels: 1 });
    expect(mono).toEqual({ ok: false, problem: { code: "channels", channels: 2 } });
  });
});

describe("paquet en un fichier", () => {
  it("Val du Lac avec un modèle et une ambiance : écrit, relu, la même carte et les mêmes ressources", async () => {
    const map = lakeWithAssets();
    const start = performance.now();
    const zip = await writeMapArchive(map, shelfOf(CRATE, AMBIENCE), { deflate, deflateRaw, license: licenseText(map.meta) });
    const written = performance.now() - start;
    const begin = performance.now();
    const back = await readMapArchive(zip, inflate, inflateRaw);
    const readTime = performance.now() - begin;
    if (!back.ok) throw new Error(JSON.stringify(back.issues));
    expect(mapText(back.map) === mapText(map)).toBe(true);
    expect(mapKey(back.map)).toBe(mapKey(map));
    expect(back.assets.get(sha256(CRATE))).toEqual(CRATE);
    expect(back.assets.get(sha256(AMBIENCE))).toEqual(AMBIENCE);
    expect(new TextDecoder().decode(back.license!)).toBe(licenseText(map.meta));
    // La carte se joue (les ressources ne changent rien à la simulation)
    const check = checkMap(back.map);
    expect(check.issues).toEqual([]);
    expect(check.arena!.assets).toEqual(map.assets);
    // Les fichiers de l'archive sont ceux du dossier, octet pour octet
    const open = openZip(zip, { bytes: PACKAGE_LIMITS.archive, entries: PACKAGE_LIMITS.entries });
    if (!open.ok) throw new Error("archive");
    const folder = packageEntries(await packMap(map, deflate, shelfOf(CRATE, AMBIENCE)), licenseText(map.meta));
    expect(open.archive.names).toEqual(["map.json", "terrain.png", "LICENSE.txt", "models/props/crate.glb", "sounds/ambience.ogg"]);
    for (const e of folder) expect(await open.archive.read(e.name, inflateRaw), e.name).toEqual(e.data);
    // Le map.json du paquet ne porte pas les empreintes : la lecture les refait d'après les fichiers
    expect(JSON.parse(new TextDecoder().decode(folder[0].data)).assets).toBeUndefined();
    if (report) {
      const plain = await writeMapArchive(read(LAKE), new Map(), { deflate, deflateRaw, license: licenseText(map.meta) });
      console.log(`Val du Lac : fichier ${Math.round(LAKE.length / 1024)} Ko, paquet sans ressources ${Math.round(plain.length / 1024)} Ko, `
        + `avec un modèle (${Math.round(CRATE.length / 1024)} Ko) et une ambiance (${Math.round(AMBIENCE.length / 1024)} Ko) ${Math.round(zip.length / 1024)} Ko ; `
        + `écrit en ${written.toFixed(0)} ms, relu en ${readTime.toFixed(0)} ms`);
    }
  });

  it("l'identifiant couvre les ressources : un octet changé dans un modèle, une autre carte ; sans ressources, celui d'avant", async () => {
    const lake = read(LAKE);
    const withAssets = lakeWithAssets();
    expect(mapKey(withAssets)).not.toBe(mapKey(lake));
    const other = CRATE.slice();
    // (un octet de la matière : le .glb reste lisible)
    const at = new TextDecoder("latin1").decode(other).indexOf("\"roughnessFactor\":0.8");
    other[at + 20] = "7".charCodeAt(0);
    expect(inspectGlb(other).problems).toEqual([]);
    expect(mapKey(lakeWithAssets(other))).not.toBe(mapKey(withAssets));
    expect(mapKey(lakeWithAssets(CRATE, null))).not.toBe(mapKey(withAssets));
    // Sans ressources, le paquet redonne la carte et son identifiant d'avant les paquets
    const zip = await writeMapArchive(lake, new Map(), { deflate, deflateRaw, license: null });
    const back = await readMapArchive(zip, inflate, inflateRaw);
    if (!back.ok) throw new Error(JSON.stringify(back.issues));
    expect(back.map.assets).toBeUndefined();
    expect(mapText(back.map) === mapText(lake)).toBe(true);
    expect(mapKey(back.map)).toBe(mapKey(lake));
    expect(back.assets.size).toBe(0);
    // Un `assets` vide ou absent : la même carte
    const empty = readMap({ ...JSON.parse(LAKE), assets: {} });
    expect(empty.ok && mapKey(empty.map)).toBe(mapKey(lake));
  });

  it("une archive faite en compressant le dossier du paquet (tout dans un dossier) se lit aussi", async () => {
    const pkg = await packMap(lakeWithAssets(), deflate, shelfOf(CRATE, AMBIENCE));
    const entries = packageEntries(pkg, "licence").map((e) => ({ ...e, name: `val-du-lac/${e.name}` }));
    const r = await readMapArchive(await archive([{ name: "val-du-lac/", data: new Uint8Array(0) }, ...entries]), inflate, inflateRaw);
    expect(r.ok && mapKey(r.map)).toBe(mapKey(lakeWithAssets()));
  });

  it("le map.json d'un paquet ne décide pas des ressources : les fichiers, seuls", async () => {
    const pkg = await packMap(read(LAKE), deflate);
    const forged = { ...JSON.parse(mapText(pkg.map)), assets: { models: { crate: asset(CRATE) } } };
    const r = await readMapArchive(await archive([mapEntry(forged), { name: "terrain.png", data: pkg.terrain! }]), inflate, inflateRaw);
    expect(r.ok && r.map.assets).toBeUndefined();
  });

  it("refuse ce qui ne va pas, chaque problème à sa ressource", async () => {
    const pkg = await packMap(read(LAKE), deflate);
    const base = [mapEntry(JSON.parse(mapText(pkg.map))), { name: "terrain.png", data: pkg.terrain! }];
    const tryWith = async (...more: ZipEntry[]): Promise<PackageRead> => readMapArchive(await archive([...base, ...more]), inflate, inflateRaw);
    // Un modèle pour un type d'accessoire inconnu, pour un bloc, un autre son, un dossier inattendu
    expect(codes(await tryWith({ name: "models/props/dragon.glb", data: CRATE }))).toEqual(["assetName"]);
    expect(codes(await tryWith({ name: "models/blocks/armor.glb", data: CRATE }))).toEqual(["assetName"]);
    expect(codes(await tryWith({ name: "sounds/music.ogg", data: AMBIENCE }))).toEqual(["assetName"]);
    // Des notes et des fichiers de travail de l'auteur sont ignorés
    expect(codes(await tryWith({ name: "models/props/README.md", data: new Uint8Array(3) }, { name: "sources/crate.blend", data: new Uint8Array(9) }))).toEqual([]);
    // Un modèle que le jeu ne lit pas, une ambiance qui n'est pas de l'Opus
    const draco = writeGlb({ ...crateModel(), extensionsRequired: ["KHR_draco_mesh_compression"] });
    const issues = await tryWith({ name: modelPath("barrel"), data: draco }, { name: PACKAGE_FILES.ambience, data: CRATE });
    expect(issues.ok ? [] : issues.issues).toEqual([
      { code: "assetModel", path: "models/props/barrel.glb", problem: { code: "extensions", list: ["KHR_draco_mesh_compression"] } },
      { code: "assetSound", path: "sounds/ambience.ogg", problem: { code: "format" } },
    ] satisfies MapIssue[]);
    // Trop gros (d'après le répertoire, sans rien décompresser)
    const huge = new Uint8Array(PACKAGE_LIMITS.model + 1);
    const tooBig = await tryWith({ name: modelPath("crate"), data: huge, deflate: true });
    expect(tooBig.ok ? [] : tooBig.issues).toEqual([{ code: "assetSize", path: "models/props/crate.glb", size: 4097, max: 4096 }]);
    // Pas de map.json
    expect(codes(await readMapArchive(await archive([{ name: "terrain.png", data: pkg.terrain! }]), inflate, inflateRaw))).toEqual(["packageMap"]);
    // Pas une archive
    expect(codes(await readMapArchive(new TextEncoder().encode(LAKE), inflate, inflateRaw))).toEqual(["archive"]);
    // Trop de fichiers
    const crowd = Array.from({ length: PACKAGE_LIMITS.entries }, (_, i) => ({ name: `n/${i}.txt`, data: new Uint8Array(0) }));
    expect(codes(await tryWith(...crowd))).toEqual(["tooMany"]);
  });

  it("une ressource reçue se vérifie contre la carte : sa taille, son empreinte, sa sorte", () => {
    const [model, ambience] = assetEntries(lakeWithAssets().assets);
    expect(model).toEqual({ path: "models/props/crate.glb", asset: asset(CRATE), type: "crate" });
    expect(ambience.type).toBeNull();
    expect(assetMatches(model, CRATE)).toBe(true);
    expect(assetMatches(ambience, AMBIENCE)).toBe(true);
    expect(assetMatches(model, AMBIENCE)).toBe(false);
    const flipped = CRATE.slice();
    flipped[100] ^= 1;
    expect(assetMatches(model, flipped)).toBe(false);
  });

  it("un paquet en dossier se lit comme son archive (les mêmes fichiers)", async () => {
    const map = lakeWithAssets();
    const files = new Map(packageEntries(await packMap(map, deflate, shelfOf(CRATE, AMBIENCE)), "licence").map((e) => [e.name, e.data]));
    files.set("sources/crate.blend", new Uint8Array(5));
    const access: FolderAccess = {
      list: (dir) => {
        const inside = [...files.keys()].filter((n) => (dir ? n.startsWith(`${dir}/`) : true)).map((n) => n.slice(dir ? dir.length + 1 : 0));
        const names = [...new Set(inside.map((n) => n.split("/")[0]))];
        return names.map((name) => ({ name, dir: inside.some((n) => n.startsWith(`${name}/`)) }));
      },
      size: (path) => files.get(path)?.length ?? Infinity,
      read: (path) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(path);
        return bytes;
      },
    };
    const source = folderSource(access);
    expect([...source.names].sort()).toEqual(["LICENSE.txt", "map.json", "models/props/crate.glb", "sounds/ambience.ogg", "terrain.png"]);
    const r = await readPackage(source, inflate);
    expect(r.ok && mapKey(r.map)).toBe(mapKey(map));
  });

  it("le champ `assets` d'une carte se lit borné : une empreinte, une taille, un type d'accessoire connu", () => {
    const lake = JSON.parse(LAKE) as Record<string, unknown>;
    const fields = (assets: unknown): string[] => {
      const r = readMap({ ...lake, assets });
      return r.ok ? [] : r.issues.map((i) => ("path" in i ? i.path : i.code));
    };
    expect(fields({ models: { crate: asset(CRATE) } })).toEqual([]);
    expect(fields({ models: { crate: { sha256: "ABC", bytes: 3 } } })).toEqual(["assets.models.crate.sha256"]);
    expect(fields({ models: { dragon: asset(CRATE) } })).toEqual(["assets.models.dragon"]);
    // (une clé piégée, comme JSON.parse l'écrit)
    expect(fields(JSON.parse(`{"models":{"__proto__":${JSON.stringify(asset(CRATE))}}}`))).toEqual(["assets.models.__proto__"]);
    expect(fields({ ambience: { sha256: sha256(AMBIENCE), bytes: PACKAGE_LIMITS.ambience + 1 } })).toEqual(["assets.ambience.bytes"]);
    expect(fields([])).toEqual(["assets"]);
    // Rangés par type : le même manifeste écrit dans un autre ordre donne la même carte
    const a = readMap({ ...lake, assets: { models: { crate: asset(CRATE), barrel: asset(AMBIENCE) } } });
    const b = readMap({ ...lake, assets: { models: { barrel: asset(AMBIENCE), crate: asset(CRATE) } } });
    expect(a.ok && b.ok && mapText(a.map) === mapText(b.map)).toBe(true);
  });
});
