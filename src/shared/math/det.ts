/*
 * Fonctions mathématiques déterministes de la simulation : `dsin`, `dcos`, `dlog`, `dpow`, à la place
 * de `Math.sin`, `Math.cos`, `Math.log` et `Math.pow` (ou `**`), dont le dernier bit dépend du moteur
 * JavaScript (V8 calcule sin et cos comme la glibc, Rust comme FreeBSD : ils diffèrent sur une
 * valeur sur deux cents). Celles-ci sont écrites deux fois, ici et dans la simulation compilée
 * (crates/casse-sim/src/det.rs), opération par opération : mêmes bits partout (tests/native.test.ts).
 *
 * Les algorithmes sont ceux de FreeBSD (msun, d'après fdlibm de Sun : k_sin.c, k_cos.c,
 * e_rem_pio2.c, e_log.c ; « Permission to use, copy, modify, and distribute this software is freely
 * granted, provided that this notice is preserved. » Copyright (C) 1993 by Sun Microsystems, Inc.),
 * tels que le crate libm de Rust les porte. Pour |x| ≥ 2²⁰·π/2, sin et cos ramènent d'abord x dans
 * un tour (`x % 2π`, exact) au lieu de la réduction sur 1 200 bits de π : moins précis pour ces
 * angles énormes, qu'aucun calcul du jeu ne fait, mais aussi déterministe.
 *
 * Les autres fonctions de `Math` dont se sert la simulation (tan, asin, acos, atan, atan2, exp,
 * sqrt, hypot, round, floor, ceil, min, max, sign) rendent les mêmes bits en V8 et dans le module
 * compilé (tests/native.test.ts) : elles restent celles de `Math`.
 */

// Les deux mots d'un nombre (petit-boutiste : [bas, haut])
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

function high(x: number): number {
  F64[0] = x;
  return U32[1];
}

function fromWords(hi: number, lo: number): number {
  U32[0] = lo;
  U32[1] = hi;
  return F64[0];
}

// --- sin, cos (k_sin.c, k_cos.c, e_rem_pio2.c) ---

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

function kSin(x: number, y: number, iy: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  return iy === 0 ? x + v * (S1 + z * r) : x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

function kCos(x: number, y: number): number {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const v = 1.0 - hz;
  return v + (((1.0 - v) - hz) + (z * r - x * y));
}

const TO_INT = 1.5 / 2.2204460492503131e-16;
const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;
/** Un tour (pour ramener les angles énormes). */
const TWO_PI = 6.283185307179586;

// Le résultat de la réduction : x = n·π/2 + y0 + y1
let remN = 0;
let remY0 = 0;
let remY1 = 0;

function medium(x: number, ix: number): void {
  const fN = x * INV_PIO2 + TO_INT - TO_INT;
  const n = fN | 0;
  let r = x - fN * PIO2_1;
  let w = fN * PIO2_1T;
  let y0 = r - w;
  const ex = ix >> 20;
  if (ex - ((high(y0) >>> 20) & 0x7ff) > 16) {
    let t = r;
    w = fN * PIO2_2;
    r = t - w;
    w = fN * PIO2_2T - ((t - r) - w);
    y0 = r - w;
    if (ex - ((high(y0) >>> 20) & 0x7ff) > 49) {
      t = r;
      w = fN * PIO2_3;
      r = t - w;
      w = fN * PIO2_3T - ((t - r) - w);
      y0 = r - w;
    }
  }
  remN = n;
  remY0 = y0;
  remY1 = (r - y0) - w;
}

/** Les petits multiples de π/2 (k de 1 à 4), du côté du signe de x. */
function near(x: number, k: number, positive: boolean): void {
  if (positive) {
    const z = x - k * PIO2_1;
    remY0 = z - k * PIO2_1T;
    remY1 = (z - remY0) - k * PIO2_1T;
    remN = k;
  } else {
    const z = x + k * PIO2_1;
    remY0 = z + k * PIO2_1T;
    remY1 = (z - remY0) + k * PIO2_1T;
    remN = -k;
  }
}

/** x = n·π/2 + y0 + y1, |x| < 2²⁰·π/2 (e_rem_pio2.c). */
function remPio2(x: number, ix: number): void {
  const positive = high(x) >>> 31 === 0;
  if (ix <= 0x400f6a7a) {
    if ((ix & 0xfffff) === 0x921fb) medium(x, ix);
    else if (ix <= 0x4002d97c) near(x, 1, positive);
    else near(x, 2, positive);
    return;
  }
  if (ix <= 0x401c463b) {
    if (ix <= 0x4015fdbc) {
      if (ix === 0x4012d97c) medium(x, ix);
      else near(x, 3, positive);
    } else if (ix === 0x401921fb) medium(x, ix);
    else near(x, 4, positive);
    return;
  }
  medium(x, ix);
}

/** Sinus déterministe (le même dans la simulation compilée). */
export function dsin(x: number): number {
  const ix = high(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return ix < 0x3e500000 ? x : kSin(x, 0, 0);
  if (ix >= 0x7ff00000) return x - x;
  if (ix >= 0x413921fb) return dsin(x % TWO_PI);
  remPio2(x, ix);
  switch (remN & 3) {
    case 0: return kSin(remY0, remY1, 1);
    case 1: return kCos(remY0, remY1);
    case 2: return -kSin(remY0, remY1, 1);
    default: return -kCos(remY0, remY1);
  }
}

/** Cosinus déterministe (le même dans la simulation compilée). */
export function dcos(x: number): number {
  const ix = high(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return ix < 0x3e46a09e ? 1.0 : kCos(x, 0);
  if (ix >= 0x7ff00000) return x - x;
  if (ix >= 0x413921fb) return dcos(x % TWO_PI);
  remPio2(x, ix);
  switch (remN & 3) {
    case 0: return kCos(remY0, remY1);
    case 1: return -kSin(remY0, remY1, 1);
    case 2: return -kCos(remY0, remY1);
    default: return kSin(remY0, remY1, 1);
  }
}

// --- log (e_log.c) ---

const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;
const TWO54 = 18014398509481984;

/** Logarithme népérien déterministe (le même dans la simulation compilée). */
export function dlog(x: number): number {
  F64[0] = x;
  let hx = U32[1];
  let lo = U32[0];
  let k = 0;
  if (hx < 0x00100000 || hx >>> 31 !== 0) {
    if ((hx & 0x7fffffff) === 0 && lo === 0) return -1 / (x * x);
    if (hx >>> 31 !== 0) return (x - x) / 0;
    // Sous-normal : remis à l'échelle
    k -= 54;
    x *= TWO54;
    F64[0] = x;
    hx = U32[1];
    lo = U32[0];
  } else if (hx >= 0x7ff00000) return x;
  else if (hx === 0x3ff00000 && lo === 0) return 0;
  // Ramené dans [√2/2, √2]
  hx = (hx + (0x3ff00000 - 0x3fe6a09e)) >>> 0;
  k += (hx >>> 20) - 0x3ff;
  hx = (hx & 0x000fffff) + 0x3fe6a09e;
  x = fromWords(hx, lo);
  const f = x - 1.0;
  const hfsq = 0.5 * f * f;
  const s = f / (2.0 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1;
  const dk = k;
  return s * (hfsq + r) + dk * LN2_LO - hfsq + f + dk * LN2_HI;
}

// --- pow ---

/**
 * Puissance déterministe : les exposants de la simulation (2, 3, 1, 0, ½) exactement (x·x, x·x·x,
 * √x), les autres par exp(y·dlog(x)) (`Math.exp` rend les mêmes bits en V8 et dans le module).
 */
export function dpow(x: number, y: number): number {
  if (y === 2) return x * x;
  if (y === 3) return x * x * x;
  if (y === 1) return x;
  if (y === 0) return 1;
  if (y === 0.5 && x >= 0) return Math.sqrt(x);
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) {
    // Seulement pour un exposant entier : le signe suit sa parité
    if (Math.floor(y) !== y) return NaN;
    const r = Math.exp(y * dlog(-x));
    return y % 2 === 0 ? r : -r;
  }
  return Math.exp(y * dlog(x));
}
