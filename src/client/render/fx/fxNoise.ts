/*
 * Textures des effets réalistes, calculées au démarrage (sans Babylon : ce module ne fait que des
 * tableaux d'octets, que render/fx/sprites.ts envoie au GPU ; les tests le font tourner dans Node).
 *
 * - L'atlas des volutes : quatre bouffées de fumée différentes (2 × 2 cases), chacune faite de
 *   boules qui se chevauchent comme un chou-fleur, au bord effiloché par un bruit. Rouge et vert :
 *   la normale de sa surface (le shader l'éclaire par le soleil : le côté au soleil plus clair, le
 *   dessous plus sombre) ; bleu : l'occlusion (creux entre les boules plus sombres) ; alpha : la
 *   densité, nulle au bord de chaque case.
 * - Le bruit : trois bruits pavables (rouge, vert, bleu) de finesses différentes, que les shaders
 *   font défiler (flammes qui montent, volutes qui roulent, bords des jets qui tremblent).
 *
 * Le hasard est celui d'un générateur à graine fixe : les mêmes textures à chaque chargement.
 */

/** Côté d'une case de l'atlas des volutes (px) ; l'atlas en fait 2 × 2. */
export const PUFF_CELL = 128;
export const PUFF_FRAMES = 4;
/** Côté de la texture de bruit (px). */
export const NOISE_SIZE = 128;

/** Générateur pseudo-aléatoire à graine (mulberry32), dans [0, 1[. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bruit de valeurs pavable : une grille de `period` × `period` valeurs, interpolées en douceur. */
class ValueNoise {
  private readonly period: number;
  private readonly values: Float32Array;
  constructor(period: number, random: () => number) {
    this.period = period;
    this.values = new Float32Array(period * period);
    for (let i = 0; i < this.values.length; i++) this.values[i] = random();
  }

  /** Valeur en (u, v) (une période = 1), dans [0, 1]. */
  at(u: number, v: number): number {
    const p = this.period;
    const x = u * p;
    const y = v * p;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const i0 = ((x0 % p) + p) % p;
    const j0 = ((y0 % p) + p) % p;
    const i1 = (i0 + 1) % p;
    const j1 = (j0 + 1) % p;
    const v00 = this.values[j0 * p + i0];
    const v10 = this.values[j0 * p + i1];
    const v01 = this.values[j1 * p + i0];
    const v11 = this.values[j1 * p + i1];
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
  }
}

/** Somme d'octaves pavable (chaque octave double la période), dans [0, 1]. */
function fbm(octaves: ValueNoise[], u: number, v: number): number {
  let sum = 0;
  let weight = 0;
  let w = 1;
  for (const n of octaves) {
    sum += n.at(u, v) * w;
    weight += w;
    w *= 0.5;
  }
  return sum / weight;
}

function octavesOf(base: number, count: number, random: () => number): ValueNoise[] {
  return Array.from({ length: count }, (_, i) => new ValueNoise(base << i, random));
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * L'atlas des volutes : RGBA, `2 × PUFF_CELL` de côté, une bouffée par case (rangées du bas vers le
 * haut : la case 0 en bas à gauche, comme les coordonnées de texture).
 */
export function puffAtlas(): Uint8Array {
  const cell = PUFF_CELL;
  const side = cell * 2;
  const out = new Uint8Array(side * side * 4);
  const random = seeded(7);
  const detail = octavesOf(4, 4, random);
  const warpX = octavesOf(2, 3, random);
  const warpY = octavesOf(2, 3, random);
  const height = new Float32Array(cell * cell);
  const wisp = new Float32Array(cell * cell);
  const blurred = new Float32Array(cell * cell);
  for (let frame = 0; frame < PUFF_FRAMES; frame++) {
    // Les boules : une grosse au milieu, d'autres autour, de toutes tailles, fondues les unes dans
    // les autres (union adoucie : pas de pli net entre deux boules)
    const blobs: { x: number; y: number; r: number }[] = [{ x: 0, y: -0.02, r: 0.17 + random() * 0.04 }];
    const count = 12 + Math.floor(random() * 6);
    for (let i = 0; i < count; i++) {
      const a = random() * Math.PI * 2;
      const d = 0.06 + random() * 0.2;
      blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d * 0.9 + 0.02, r: 0.06 + random() * 0.11 });
    }
    const shiftU = random() * 7;
    const shiftV = random() * 7;
    let peak = 0;
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const u = (i + 0.5) / cell;
        const v = (j + 0.5) / cell;
        // Le domaine se tord : les boules perdent leur contour rond
        const wx = (fbm(warpX, u * 0.8 + shiftU, v * 0.8 + shiftV) - 0.5) * 0.24;
        const wy = (fbm(warpY, u * 0.8 + shiftV, v * 0.8 + shiftU) - 0.5) * 0.24;
        const px = u - 0.5 + wx;
        const py = v - 0.5 + wy;
        // Hauteur de la surface : une calotte de sphère par boule, unies en douceur
        let h = 0;
        for (const b of blobs) {
          const dx = px - b.x;
          const dy = py - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < b.r * b.r) h = smoothMax(h, Math.sqrt(b.r * b.r - d2), 0.04);
        }
        // Le détail bosselle la surface et effiloche le bord
        const n = fbm(detail, u * 0.75 + shiftU, v * 0.75 + shiftV);
        h += (n - 0.5) * 0.1;
        // Rien au bord de la case (pas de bavure d'une case sur l'autre)
        const r = Math.hypot(u - 0.5, v - 0.5);
        const window = smoothstep(0.5, 0.4, r);
        h = Math.max(0, h * window);
        height[j * cell + i] = h;
        // Une frange de fumée légère autour de la bouffée
        wisp[j * cell + i] = smoothstep(0.46, 0.18, r) * Math.max(0, n - 0.35) * 1.6 * window;
        peak = Math.max(peak, h);
      }
    }
    // Occlusion : un creux plus bas que ses environs est à l'ombre de ses voisins
    blur(height, blurred, cell, 6);
    const ox = (frame % 2) * cell;
    const oy = Math.floor(frame / 2) * cell;
    const at = (i: number, j: number): number => height[Math.min(cell - 1, Math.max(0, j)) * cell + Math.min(cell - 1, Math.max(0, i))];
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const h = height[j * cell + i];
        // Normale : la pente de la surface (en unités de la case), adoucie (la fumée n'a pas
        // d'arête : une pente trop forte cernerait chaque boule d'un trait sombre)
        const dhdu = ((at(i + 1, j) - at(i - 1, j)) * cell) / 2;
        const dhdv = ((at(i, j + 1) - at(i, j - 1)) * cell) / 2;
        let nx = -dhdu * NORMAL_STRENGTH;
        let ny = -dhdv * NORMAL_STRENGTH;
        const nz = 1;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        const ao = smoothstep(-0.05, 0.035, h - blurred[j * cell + i]);
        // Densité : pleine au cœur, plus mince au bord, inégale (des trouées plus claires)
        const patchy = 1 + 0.6 * (fbm(detail, ((i + 0.5) / cell) * 1.5 + shiftV, ((j + 0.5) / cell) * 1.5 + shiftU) - 0.5);
        const body = Math.min(1, smoothstep(0, 0.12, h) * (0.45 + 0.55 * smoothstep(0, peak * 0.7, h)) * patchy);
        const density = Math.min(1, body + wisp[j * cell + i] * (1 - body));
        const o = ((oy + j) * side + ox + i) * 4;
        out[o] = Math.round((nx * 0.5 + 0.5) * 255);
        out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        out[o + 2] = Math.round((0.35 + 0.65 * ao) * 255);
        out[o + 3] = Math.round(density * 255);
      }
    }
  }
  return out;
}

/** Raideur des normales des volutes (1 : celle de leur surface). */
const NORMAL_STRENGTH = 0.55;

/** Maximum adouci (polynomial) : `a` et `b` se fondent l'un dans l'autre sur une largeur `k`. */
function smoothMax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/** Flou en boîte (séparable) d'un champ carré de côté `n`, de rayon `r` px. */
function blur(src: Float32Array, dst: Float32Array, n: number, r: number): void {
  const tmp = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++, c++) s += src[j * n + k];
      tmp[j * n + i] = s / c;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, j - r); k <= Math.min(n - 1, j + r); k++, c++) s += tmp[k * n + i];
      dst[j * n + i] = s / c;
    }
  }
}

/** La texture de bruit : RGBA, `NOISE_SIZE` de côté, pavable ; trois bruits de finesses différentes. */
export function noiseTexture(): Uint8Array {
  const n = NOISE_SIZE;
  const out = new Uint8Array(n * n * 4);
  const random = seeded(11);
  const coarse = octavesOf(4, 4, random);
  const medium = octavesOf(8, 3, random);
  const fine = octavesOf(16, 3, random);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const v = j / n;
      const o = (j * n + i) * 4;
      out[o] = Math.round(contrast(fbm(coarse, u, v)) * 255);
      out[o + 1] = Math.round(contrast(fbm(medium, u, v)) * 255);
      out[o + 2] = Math.round(contrast(fbm(fine, u, v)) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Une somme d'octaves se tasse autour de 0,5 : on l'étire pour que le bruit ait du relief. */
function contrast(x: number): number {
  return Math.min(1, Math.max(0, 0.5 + (x - 0.5) * 1.8));
}
