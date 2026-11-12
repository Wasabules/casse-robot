//! Fonctions mathématiques déterministes de la simulation : `dsin`, `dcos`, `dlog`, `dpow`, écrites
//! deux fois, ici et dans src/shared/math/det.ts, opération par opération (mêmes bits : vérifié par
//! tests/native.test.ts). Celles de Rust (la libm) et de V8 diffèrent sur le dernier bit d'une valeur
//! sur deux cents : la simulation n'emploie ni les unes ni les autres.
//!
//! Algorithmes de FreeBSD (msun, d'après fdlibm de Sun : k_sin.c, k_cos.c, e_rem_pio2.c, e_log.c).
//! Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved. Developed at SunSoft, a Sun
//! Microsystems, Inc. business. Permission to use, copy, modify, and distribute this software is
//! freely granted, provided that this notice is preserved.
//!
//! Pour |x| ≥ 2²⁰·π/2, sin et cos ramènent d'abord x dans un tour (`x % 2π`, exact) au lieu de la
//! réduction sur 1 200 bits de π.

#[inline]
fn high(x: f64) -> u32 {
    (x.to_bits() >> 32) as u32
}

#[inline]
fn low(x: f64) -> u32 {
    x.to_bits() as u32
}

#[inline]
fn from_words(hi: u32, lo: u32) -> f64 {
    f64::from_bits(((hi as u64) << 32) | lo as u64)
}

// --- sin, cos ---

const S1: f64 = -1.66666666666666324348e-1;
const S2: f64 = 8.33333333332248946124e-3;
const S3: f64 = -1.98412698298579493134e-4;
const S4: f64 = 2.75573137070700676789e-6;
const S5: f64 = -2.50507602534068634195e-8;
const S6: f64 = 1.58969099521155010221e-10;

fn k_sin(x: f64, y: f64, iy: i32) -> f64 {
    let z = x * x;
    let w = z * z;
    let r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
    let v = z * x;
    if iy == 0 { x + v * (S1 + z * r) } else { x - ((z * (0.5 * y - v * r) - y) - v * S1) }
}

const C1: f64 = 4.16666666666666019037e-2;
const C2: f64 = -1.38888888888741095749e-3;
const C3: f64 = 2.48015872894767294178e-5;
const C4: f64 = -2.75573143513906633035e-7;
const C5: f64 = 2.08757232129817482790e-9;
const C6: f64 = -1.13596475577881948265e-11;

fn k_cos(x: f64, y: f64) -> f64 {
    let z = x * x;
    let w = z * z;
    let r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
    let hz = 0.5 * z;
    let v = 1.0 - hz;
    v + (((1.0 - v) - hz) + (z * r - x * y))
}

const TO_INT: f64 = 1.5 / 2.2204460492503131e-16;
const INV_PIO2: f64 = 6.36619772367581382433e-1;
const PIO2_1: f64 = 1.57079632673412561417;
const PIO2_1T: f64 = 6.07710050650619224932e-11;
const PIO2_2: f64 = 6.07710050630396597660e-11;
const PIO2_2T: f64 = 2.02226624879595063154e-21;
const PIO2_3: f64 = 2.02226624871116645580e-21;
const PIO2_3T: f64 = 8.47842766036889956997e-32;
/// Un tour (pour ramener les angles énormes).
const TWO_PI: f64 = 6.283185307179586;

fn medium(x: f64, ix: u32) -> (i32, f64, f64) {
    let f_n = x * INV_PIO2 + TO_INT - TO_INT;
    let n = f_n as i32;
    let mut r = x - f_n * PIO2_1;
    let mut w = f_n * PIO2_1T;
    let mut y0 = r - w;
    let ex = (ix >> 20) as i32;
    if ex - ((high(y0) >> 20) & 0x7ff) as i32 > 16 {
        let t = r;
        w = f_n * PIO2_2;
        r = t - w;
        w = f_n * PIO2_2T - ((t - r) - w);
        y0 = r - w;
        if ex - ((high(y0) >> 20) & 0x7ff) as i32 > 49 {
            let t = r;
            w = f_n * PIO2_3;
            r = t - w;
            w = f_n * PIO2_3T - ((t - r) - w);
            y0 = r - w;
        }
    }
    (n, y0, (r - y0) - w)
}

/// Les petits multiples de π/2 (k de 1 à 4), du côté du signe de x.
fn near(x: f64, k: f64, positive: bool) -> (i32, f64, f64) {
    if positive {
        let z = x - k * PIO2_1;
        let y0 = z - k * PIO2_1T;
        (k as i32, y0, (z - y0) - k * PIO2_1T)
    } else {
        let z = x + k * PIO2_1;
        let y0 = z + k * PIO2_1T;
        (-(k as i32), y0, (z - y0) + k * PIO2_1T)
    }
}

/// x = n·π/2 + y0 + y1, |x| < 2²⁰·π/2.
fn rem_pio2(x: f64, ix: u32) -> (i32, f64, f64) {
    let positive = high(x) >> 31 == 0;
    if ix <= 0x400f6a7a {
        if (ix & 0xfffff) == 0x921fb {
            return medium(x, ix);
        }
        return if ix <= 0x4002d97c { near(x, 1.0, positive) } else { near(x, 2.0, positive) };
    }
    if ix <= 0x401c463b {
        if ix <= 0x4015fdbc {
            return if ix == 0x4012d97c { medium(x, ix) } else { near(x, 3.0, positive) };
        }
        return if ix == 0x401921fb { medium(x, ix) } else { near(x, 4.0, positive) };
    }
    medium(x, ix)
}

/// Sinus déterministe.
pub fn dsin(x: f64) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return if ix < 0x3e500000 { x } else { k_sin(x, 0.0, 0) };
    }
    if ix >= 0x7ff00000 {
        return x - x;
    }
    if ix >= 0x413921fb {
        return dsin(x % TWO_PI);
    }
    let (n, y0, y1) = rem_pio2(x, ix);
    match n & 3 {
        0 => k_sin(y0, y1, 1),
        1 => k_cos(y0, y1),
        2 => -k_sin(y0, y1, 1),
        _ => -k_cos(y0, y1),
    }
}

/// Cosinus déterministe.
pub fn dcos(x: f64) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return if ix < 0x3e46a09e { 1.0 } else { k_cos(x, 0.0) };
    }
    if ix >= 0x7ff00000 {
        return x - x;
    }
    if ix >= 0x413921fb {
        return dcos(x % TWO_PI);
    }
    let (n, y0, y1) = rem_pio2(x, ix);
    match n & 3 {
        0 => k_cos(y0, y1),
        1 => -k_sin(y0, y1, 1),
        2 => -k_cos(y0, y1),
        _ => k_sin(y0, y1, 1),
    }
}

// --- log ---

const LN2_HI: f64 = 6.93147180369123816490e-1;
const LN2_LO: f64 = 1.90821492927058770002e-10;
const LG1: f64 = 6.666666666666735130e-1;
const LG2: f64 = 3.999999999940941908e-1;
const LG3: f64 = 2.857142874366239149e-1;
const LG4: f64 = 2.222219843214978396e-1;
const LG5: f64 = 1.818357216161805012e-1;
const LG6: f64 = 1.531383769920937332e-1;
const LG7: f64 = 1.479819860511658591e-1;
const TWO54: f64 = 18014398509481984.0;

/// Logarithme népérien déterministe.
pub fn dlog(mut x: f64) -> f64 {
    let mut hx = high(x);
    let mut lo = low(x);
    let mut k: i32 = 0;
    if hx < 0x00100000 || hx >> 31 != 0 {
        if (hx & 0x7fffffff) == 0 && lo == 0 {
            return -1.0 / (x * x);
        }
        if hx >> 31 != 0 {
            return (x - x) / 0.0;
        }
        // Sous-normal : remis à l'échelle
        k -= 54;
        x *= TWO54;
        hx = high(x);
        lo = low(x);
    } else if hx >= 0x7ff00000 {
        return x;
    } else if hx == 0x3ff00000 && lo == 0 {
        return 0.0;
    }
    // Ramené dans [√2/2, √2]
    hx = hx.wrapping_add(0x3ff00000 - 0x3fe6a09e);
    k += (hx >> 20) as i32 - 0x3ff;
    hx = (hx & 0x000fffff) + 0x3fe6a09e;
    x = from_words(hx, lo);
    let f = x - 1.0;
    let hfsq = 0.5 * f * f;
    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    let r = t2 + t1;
    let dk = k as f64;
    s * (hfsq + r) + dk * LN2_LO - hfsq + f + dk * LN2_HI
}

// --- pow ---

/// Puissance déterministe : 2, 3, 1, 0 et ½ exactement, les autres par exp(y·dlog(x)).
pub fn dpow(x: f64, y: f64) -> f64 {
    if y == 2.0 {
        return x * x;
    }
    if y == 3.0 {
        return x * x * x;
    }
    if y == 1.0 {
        return x;
    }
    if y == 0.0 {
        return 1.0;
    }
    if y == 0.5 && x >= 0.0 {
        return x.sqrt();
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    if x == 0.0 {
        return if y > 0.0 { 0.0 } else { f64::INFINITY };
    }
    if x < 0.0 {
        if y.floor() != y {
            return f64::NAN;
        }
        let r = (y * dlog(-x)).exp();
        return if y % 2.0 == 0.0 { r } else { -r };
    }
    (y * dlog(x)).exp()
}
