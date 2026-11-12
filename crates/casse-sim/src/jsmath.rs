//! Les fonctions de `Math` de JavaScript, calculées comme V8 les calcule : le TypeScript de la
//! simulation s'en sert partout (`Math.hypot`, `Math.sin`, `Math.atan2`, `x ** 2`…), et un module
//! porté doit rendre les mêmes nombres au bit près. tests/native.test.ts les compare à celles de V8
//! sur des centaines de milliers de valeurs ; une fonction de Rust qui ne rend pas les mêmes est
//! réécrite ici comme V8 la calcule (`hypot`, `round`, `min`, `max`, `sign`), ou n'est plus employée
//! par la simulation, qui a les siennes (sin, cos, log, pow : det.rs, src/shared/math/det.ts).

/// `Math.hypot(...values)` : comme V8 (src/builtins/math.tq, `MathHypot`) : les valeurs ramenées à
/// la plus grande, puis une somme de Kahan de leurs carrés (pas `f64::hypot`, plus précise).
pub fn hypot(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut max = 0.0f64;
    let mut nan = false;
    for &v in values {
        if v.is_nan() {
            nan = true;
        } else if v.abs() > max {
            max = v.abs();
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for &v in values {
        let n = v.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

#[inline]
pub fn hypot2(a: f64, b: f64) -> f64 {
    hypot(&[a, b])
}

#[inline]
pub fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    hypot(&[a, b, c])
}

/// `Math.round` : l'entier le plus proche, les demis vers +∞ (-2,5 → -2 ; `f64::round` donnerait
/// -3), le signe d'un zéro gardé (-0,4 → -0). Comme V8 (`Float64Round`) : l'entier au-dessus, moins
/// un s'il est à plus d'un demi.
pub fn round(x: f64) -> f64 {
    let up = x.ceil();
    if up - 0.5 <= x { up } else { up - 1.0 }
}

/// `Math.sign`.
pub fn sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        x
    } else if x > 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// `Math.max(a, b)` : NaN si l'un l'est, +0 plutôt que -0 (`f64::max` ignore NaN).
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { b } else { a }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)` : NaN si l'un l'est, -0 plutôt que +0.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// Une fonction de `Math` désignée par son numéro (l'ordre de `MATH_OPS`, src/shared/native/native.ts).
pub fn eval(op: u32, a: f64, b: f64, c: f64) -> f64 {
    match op {
        0 => a.sin(),
        1 => a.cos(),
        2 => a.tan(),
        3 => a.asin(),
        4 => a.acos(),
        5 => a.atan(),
        6 => a.atan2(b),
        7 => a.exp(),
        8 => a.ln(),
        9 => a.powf(b),
        10 => a.sqrt(),
        11 => hypot2(a, b),
        12 => hypot3(a, b, c),
        13 => round(a),
        14 => sign(a),
        15 => max(a, b),
        16 => min(a, b),
        17 => a.floor(),
        18 => a.ceil(),
        19 => crate::det::dsin(a),
        20 => crate::det::dcos(a),
        21 => crate::det::dlog(a),
        22 => crate::det::dpow(a, b),
        _ => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrondi_comme_javascript() {
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert!(round(-0.4).is_sign_negative());
        assert_eq!(round(-0.6), -1.0);
    }

    #[test]
    fn hypotenuse() {
        assert_eq!(hypot3(3.0, 4.0, 12.0), 13.0);
        assert_eq!(hypot2(0.0, 0.0), 0.0);
        assert!(hypot2(f64::NAN, 1.0).is_nan());
        assert_eq!(hypot2(f64::NAN, f64::INFINITY), f64::INFINITY);
    }
}
