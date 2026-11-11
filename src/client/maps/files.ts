import { MAP_EXTENSION, type MapFile } from "../../shared/map/format";
import { decodePng, decodeRaw16, imageFromBytes, MAX_IMAGE_SIDE, type HeightImage } from "../../shared/map/heightmap";
import { encodePng } from "../../shared/map/png";
import { fold } from "../i18n/format";

/*
 * Les fichiers des cartes dans le navigateur : choisir un fichier, enregistrer une carte (pour la
 * partager ou la proposer au dépôt), et importer un relief (PNG 8 ou 16 bits décodé à la main,
 * RAW 16 bits, ou n'importe quelle image que le navigateur sait lire, ramenée à 8 bits par le
 * canvas). L'éditeur de cartes s'en sert aussi.
 */

/** Décompression zlib par le navigateur (les données d'un PNG). */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Compression zlib par le navigateur (pour écrire un PNG). */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
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

/** Le nom d'un fichier de carte d'après son nom (sans accents ni signes : « Val du Lac » → val-du-lac.casse-map.json). */
export function mapFileName(map: MapFile): string {
  const slug = fold(map.meta.name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "carte"; // i18n-ignore
  return `${slug}${MAP_EXTENSION}`;
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
  download(mapFileName(map), `${JSON.stringify(map, null, 2)}\n`, "application/json");
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
