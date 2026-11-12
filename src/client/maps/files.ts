import { MAP_EXTENSION, type MapFile } from "../../shared/map/format";
import { decodePng, decodeRaw16, imageFromBytes, MAX_IMAGE_SIDE, type HeightImage } from "../../shared/map/heightmap";
import { assetEntries, licenseText, PACKAGE_EXTENSION, writeMapArchive } from "../../shared/map/pack";
import { encodePng } from "../../shared/map/png";
import { fold } from "../i18n/format";
import type { MapAssetStore } from "./assets";

/*
 * Les fichiers des cartes dans le navigateur : choisir un fichier, enregistrer une carte (pour la
 * partager ou la proposer au dépôt), et importer un relief (PNG 8 ou 16 bits décodé à la main,
 * RAW 16 bits, ou n'importe quelle image que le navigateur sait lire, ramenée à 8 bits par le
 * canvas). L'éditeur de cartes s'en sert aussi.
 */

/**
 * Lit un flux décompressé jusqu'au bout, mais pas au-delà de `max` octets : une entrée hostile (une
 * « bombe » de quelques Ko qui en ferait des Go) est abandonnée en route.
 */
async function drain(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error(`Décompression au-delà de ${max} octets`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Décompression zlib par le navigateur (les données d'un PNG) ; `max` : au plus autant d'octets. */
export async function inflate(data: Uint8Array, max = Infinity): Promise<Uint8Array> {
  return drain(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")), max);
}

/** Compression zlib par le navigateur (pour écrire un PNG). */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Décompression « deflate » brute (une entrée d'une archive zip), d'au plus `max` octets. */
export async function inflateRaw(data: Uint8Array, max: number): Promise<Uint8Array> {
  return drain(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")), Math.max(0, max));
}

/** Compression « deflate » brute (une entrée d'une archive zip). */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Demande un fichier au joueur (`accept` : les types proposés) ; null s'il renonce. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/**
 * Le nom d'un fichier de carte d'après son nom (sans accents ni signes : « Val du Lac » →
 * val-du-lac.casse-map.json) ; un paquet (une carte qui a des ressources) : val-du-lac.casse-map.zip.
 */
export function mapFileName(map: MapFile, extension = map.assets ? PACKAGE_EXTENSION : MAP_EXTENSION): string {
  const slug = fold(map.meta.name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "carte"; // i18n-ignore
  return `${slug}${extension}`;
}

/** Fait enregistrer un fichier par le navigateur. */
export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Enregistre une carte en `.casse-map.json` (lisible : deux espaces d'indentation). */
export function downloadMap(map: MapFile): void {
  download(mapFileName(map, MAP_EXTENSION), `${JSON.stringify(map, null, 2)}\n`, "application/json");
}

/**
 * Enregistre une carte et ses ressources en un paquet `.casse-map.zip` (map/pack.ts). Faux si ce
 * navigateur n'a pas toutes ses ressources (rien n'est enregistré).
 */
export async function downloadPackage(map: MapFile, assets: MapAssetStore): Promise<boolean> {
  const shelf = await assets.shelfOf(map);
  if (!shelf) return false;
  const license = licenseText(map.meta, assetEntries(map.assets).map((e) => e.path));
  const bytes = await writeMapArchive(map, shelf, { deflate, deflateRaw, license });
  download(mapFileName(map, PACKAGE_EXTENSION), bytes as BlobPart, "application/zip");
  return true;
}

/** Enregistre une image de hauteurs en PNG 16 bits (pour reprendre un relief dans un outil de terrain). */
export async function downloadHeightPng(name: string, image: HeightImage): Promise<void> {
  download(name, (await encodePng(image, deflate)) as BlobPart, "image/png");
}

/**
 * Une image de hauteurs d'après un fichier : un PNG (8 ou 16 bits, décodé ici), un RAW 16 bits
 * (`.r16`, `.raw` ; `littleEndian` : l'ordre de ses octets), ou une autre image (8 bits, par le
 * canvas). Lève une erreur à code (`isHeightmapError`) si le fichier ne fait pas un relief.
 */
export async function heightImageFromFile(file: File, littleEndian = true): Promise<HeightImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith(".r16") || name.endsWith(".raw")) return decodeRaw16(bytes, littleEndian);
  if (name.endsWith(".png") || file.type === "image/png") return decodePng(bytes, inflate);
  const bitmap = await createImageBitmap(file);
  if (bitmap.width > MAX_IMAGE_SIDE || bitmap.height > MAX_IMAGE_SIDE) throw Object.assign(new Error(`Image de ${bitmap.width} × ${bitmap.height} pixels`), { code: "tooLarge" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D indisponible");
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const gray = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round((pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3);
  return imageFromBytes(bitmap.width, bitmap.height, gray, 8);
}
