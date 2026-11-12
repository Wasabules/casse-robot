import { noise2, smoothstep } from "../arena/terrain";
import { encodeTerrain, vertexCount } from "./codec";
import { MAP_LIMITS, type MapTerrain } from "./format";

/*
 * Import d'un relief : ce que produisent les outils de terrain courants (Gaea, World Machine,
 * Blender, terrain.party, l'export « terrain » de Unity) devient la grille de hauteurs d'une carte.
 * - une image PNG en niveaux de gris, 8 ou 16 bits (le canvas des navigateurs ramène tout à 8
 *   bits : on décode donc le PNG soi-même ; la décompression est fournie par l'appelant,
 *   `DecompressionStream("deflate")` dans le navigateur, `zlib.inflateSync` dans Node) ;
 * - un fichier RAW 16 bits carré (`.r16`, `.raw`) ;
 * - une image 8 bits passée par le canvas (client/maps/) : un lissage efface ses marches.
 * Puis le relief est rééchantillonné au pas de la carte, mis à l'échelle verticale, et, si l'auteur
 * le veut, son bord monte en montagnes infranchissables (comme la Vallée).
 *
 * L'image se lit comme la carte (et la mini-carte) : le haut est au nord (+z), la gauche à l'ouest
 * (+x). Des fonctions pures, sans DOM : elles servent au client (l'éditeur), aux outils
 * (tools/maps/) et aux tests.
 */

/** Une image de hauteurs : des valeurs de 0 (noir) à 1 (blanc), ligne par ligne, du haut vers le bas. */
export interface HeightImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
  /** Bits par valeur de la source : 8 (des marches, à lisser) ou 16. */
  readonly bits: number;
}

/**
 * Décompression zlib (le format des données d'un PNG). `max` : la taille au plus qu'on attend (celle
 * de l'image) ; une décompression qui la respecte s'arrête au-delà (une image hostile ne remplit pas
 * la mémoire), en levant ou en rendant plus que `max` octets (refusés ensuite).
 */
export type Inflate = (data: Uint8Array, max?: number) => Uint8Array | Promise<Uint8Array>;

/** Pourquoi une image ne fait pas un relief : le client le dit dans la langue du joueur (`heightmap.<code>`). */
export type HeightmapErrorCode = "notPng" | "unsupported" | "tooLarge" | "corrupt" | "rawSize";

/** Une erreur d'import : son code, et un message pour les développeurs. */
export type HeightmapError = Error & { readonly code: HeightmapErrorCode };

const failure = (code: HeightmapErrorCode, error: Error): HeightmapError => Object.assign(error, { code });

/** L'erreur vient-elle de l'import d'un relief (et a-t-elle un code à dire au joueur) ? */
export const isHeightmapError = (e: unknown): e is HeightmapError => e instanceof Error && typeof (e as { code?: unknown }).code === "string";

/** Côté d'une image de hauteurs au plus (pixels) : 4097 couvre les exports courants (1025, 2049, 4097). */
export const MAX_IMAGE_SIDE = 4097;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Valeurs par pixel selon le type de couleur du PNG : gris, RVB, palette, gris + alpha, RVBA. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Décode un PNG en image de hauteurs (niveaux de gris 8 ou 16 bits ; une image en couleurs donne la moyenne de ses canaux). */
export async function decodePng(bytes: Uint8Array, inflate: Inflate): Promise<HeightImage> {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw failure("notPng", new Error("Ce n'est pas une image PNG"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = at + 8;
    if (data + length > bytes.length) throw failure("corrupt", new Error(`Morceau ${type} tronqué`));
    if (type === "IHDR") {
      width = view.getUint32(data);
      height = view.getUint32(data + 4);
      depth = bytes[data + 8];
      color = bytes[data + 9];
      interlace = bytes[data + 12];
    } else if (type === "PLTE") palette = bytes.subarray(data, data + length);
    else if (type === "IDAT") idat.push(bytes.subarray(data, data + length));
    else if (type === "IEND") break;
    at = data + length + 4;
  }
  if (!width || !height || !(color in CHANNELS)) throw failure("corrupt", new Error("En-tête PNG absent ou invalide"));
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) throw failure("tooLarge", new Error(`Image de ${width} × ${height} pixels (au plus ${MAX_IMAGE_SIDE})`));
  if ((depth !== 8 && depth !== 16) || interlace !== 0 || (color === 3 && (!palette || depth !== 8))) {
    throw failure("unsupported", new Error(`PNG non pris en charge : ${depth} bits, couleur ${color}, entrelacement ${interlace}`));
  }
  const total = idat.reduce((n, c) => n + c.length, 0);
  const packed = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    packed.set(c, o);
    o += c.length;
  }
  const channels = CHANNELS[color];
  const bpp = Math.max(1, (channels * depth) / 8);
  const stride = (width * channels * depth) / 8;
  let raw: Uint8Array;
  try {
    raw = await inflate(packed, height * (stride + 1));
  } catch {
    throw failure("corrupt", new Error("Données PNG illisibles"));
  }
  if (raw.length < height * (stride + 1)) throw failure("corrupt", new Error("Données PNG trop courtes"));
  // Défiltrage, ligne par ligne (filtres Aucun, Sub, Up, Average, Paeth)
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? pixels[row + i - bpp] : 0;
      const up = y > 0 ? pixels[prev + i] : 0;
      const corner = y > 0 && i >= bpp ? pixels[prev + i - bpp] : 0;
      let v = raw[src + i];
      switch (filter) {
        case 0: break;
        case 1: v += left; break;
        case 2: v += up; break;
        case 3: v += (left + up) >> 1; break;
        case 4: {
          const p = left + up - corner;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - corner);
          v += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
          break;
        }
        default: throw failure("corrupt", new Error(`Filtre PNG inconnu : ${filter}`));
      }
      pixels[row + i] = v & 255;
    }
  }
  // Une valeur de 0 à 1 par pixel
  const data = new Float32Array(width * height);
  const max = depth === 16 ? 65535 : 255;
  const sample = (k: number): number => (depth === 16 ? (pixels[k * 2] << 8) | pixels[k * 2 + 1] : pixels[k]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const first = (y * stride) / (depth / 8) + x * channels;
      let v: number;
      if (color === 3) {
        const i = pixels[y * stride + x] * 3;
        v = ((palette![i] ?? 0) + (palette![i + 1] ?? 0) + (palette![i + 2] ?? 0)) / (3 * 255);
      } else if (color === 2 || color === 6) v = (sample(first) + sample(first + 1) + sample(first + 2)) / (3 * max);
      else v = sample(first) / max;
      data[p] = v;
    }
  }
  return { width, height, data, bits: color === 3 ? 8 : depth };
}

/**
 * Décode un RAW 16 bits carré (l'export « terrain » de Unity, de World Machine) : `side` × `side`
 * valeurs, ligne par ligne ; petit-boutiste par défaut (« Windows » dans Unity ; « Mac » : gros-boutiste).
 */
export function decodeRaw16(bytes: Uint8Array, littleEndian = true): HeightImage {
  const side = Math.round(Math.sqrt(bytes.length / 2));
  if (side < 2 || side * side * 2 !== bytes.length) throw failure("rawSize", new Error(`Un RAW 16 bits carré : ${bytes.length} octets ne font pas un carré`));
  if (side > MAX_IMAGE_SIDE) throw failure("tooLarge", new Error(`RAW de ${side} × ${side} (au plus ${MAX_IMAGE_SIDE})`));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Float32Array(side * side);
  for (let i = 0; i < data.length; i++) data[i] = view.getUint16(i * 2, littleEndian) / 65535;
  return { width: side, height: side, data, bits: 16 };
}

/** Image de hauteurs d'après des valeurs de 0 à 255 (les pixels d'un canvas, ramenés à une valeur par pixel). */
export function imageFromBytes(width: number, height: number, values: ArrayLike<number>, bits = 8): HeightImage {
  const max = bits === 16 ? 65535 : 255;
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = (values[i] ?? 0) / max;
  return { width, height, data, bits };
}

/** Flou en boîte de rayon `r` pixels (deux passes, une par axe) : il efface les marches d'une image 8 bits. */
export function smoothImage(img: HeightImage, r: number): HeightImage {
  const radius = Math.max(0, Math.round(r));
  if (!radius) return img;
  const { width: w, height: h } = img;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const pass = (src: Float32Array, dst: Float32Array, n: number, lines: number, at: (line: number, i: number) => number): void => {
    for (let line = 0; line < lines; line++) {
      let sum = 0;
      let count = 0;
      for (let i = -radius; i <= radius; i++) if (i >= 0 && i < n) { sum += src[at(line, i)]; count++; }
      for (let i = 0; i < n; i++) {
        dst[at(line, i)] = sum / count;
        const drop = i - radius;
        const take = i + radius + 1;
        if (drop >= 0) { sum -= src[at(line, drop)]; count--; }
        if (take < n) { sum += src[at(line, take)]; count++; }
      }
    }
  };
  pass(img.data, tmp, w, h, (y, x) => y * w + x);
  pass(tmp, out, h, w, (x, y) => y * w + x);
  return { ...img, data: out };
}

/** Valeur de l'image en (u, v) ∈ [0, 1]² (bilinéaire ; u vers la droite, v vers le bas). */
export function sampleImage(img: HeightImage, u: number, v: number): number {
  const fx = Math.min(Math.max(u, 0), 1) * (img.width - 1);
  const fy = Math.min(Math.max(v, 0), 1) * (img.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = img.data;
  const top = d[y0 * img.width + x0] * (1 - tx) + d[y0 * img.width + x1] * tx;
  const bottom = d[y1 * img.width + x0] * (1 - tx) + d[y1 * img.width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Ce que l'import fait d'une image de hauteurs. */
export interface TerrainImport {
  /** Cases par côté, pas (m : 1 ou 2) : le relief fait `cells × step` m de côté. */
  readonly cells: number;
  readonly step: number;
  /** Hauteur du noir et du blanc (m) : l'échelle verticale. */
  readonly low: number;
  readonly high: number;
  /** Lissage (rayon en pixels de l'image) : par défaut aucun pour une image 16 bits, 2 pour une image 8 bits. */
  readonly smooth?: number;
  /**
   * Montagnes au bord, infranchissables : le relief monte de `height` m (à peu près, il varie un
   * peu) entre `from` m du centre (en distance « carrée », comme la zone de jeu) et le bord du relief.
   */
  readonly mountains?: { readonly from: number; readonly height: number };
}

/** Les hauteurs du relief (m, dans l'ordre de `Terrain.heights` : colonne par x, z croissants) d'après une image. */
export function heightsFromImage(source: HeightImage, options: TerrainImport): Float32Array {
  const { cells, step } = options;
  const n = cells + 1;
  const side = cells * step;
  const smooth = options.smooth ?? (source.bits <= 8 ? 2 : 0);
  const img = smoothImage(source, smooth);
  const heights = new Float32Array(vertexCount(cells));
  const m = options.mountains;
  const top = side / 2;
  for (let ix = 0; ix < n; ix++) {
    const x = -side / 2 + ix * step;
    for (let iz = 0; iz < n; iz++) {
      const z = -side / 2 + iz * step;
      // Le haut de l'image au nord (+z), sa gauche à l'ouest (+x)
      let h = options.low + sampleImage(img, (side / 2 - x) / side, (side / 2 - z) / side) * (options.high - options.low);
      if (m && m.height > 0 && m.from < top) {
        const edge = Math.max(Math.abs(x), Math.abs(z)) + 4 * noise2(x / 30 - 7, z / 30 + 2);
        h += smoothstep(m.from, top, edge) * m.height * (0.85 + 0.25 * noise2(x / 45 + 9, z / 45 + 3));
      }
      heights[ix * n + iz] = Math.min(MAP_LIMITS.maxHeight, Math.max(MAP_LIMITS.minHeight, h));
    }
  }
  return heights;
}

/**
 * L'inverse : les hauteurs d'un relief (dans l'ordre de `Terrain.heights`) en image, orientée comme
 * la carte, d'un pixel par sommet ; `low` et `high` : les hauteurs du noir et du blanc (m). Pour
 * reprendre le relief d'une carte dans un outil de terrain (`encodePng`).
 */
export function imageFromHeights(heights: Float32Array, cells: number): { image: HeightImage; low: number; high: number } {
  const n = cells + 1;
  let low = Infinity;
  let high = -Infinity;
  for (const h of heights) {
    low = Math.min(low, h);
    high = Math.max(high, h);
  }
  if (!(high > low)) high = low + 1;
  const data = new Float32Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) data[row * n + col] = (heights[(cells - col) * n + (cells - row)] - low) / (high - low);
  }
  return { image: { width: n, height: n, data, bits: 16 }, low, high };
}

/** Le relief d'une carte d'après une image de hauteurs (voir `TerrainImport`). */
export function terrainFromImage(source: HeightImage, options: TerrainImport): MapTerrain {
  return encodeTerrain(heightsFromImage(source, options), options.cells, options.step);
}
