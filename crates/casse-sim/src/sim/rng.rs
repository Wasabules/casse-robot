//! Le hasard de la simulation : `Math.random` remplacé par un tirage à graine fixe (mulberry32, comme
//! `seedRandom` de tests/seed.ts et la partie solo rejouable, src/shared/net/session.ts), et `rand`
//! (src/shared/math/scalar.ts). La simulation portée tire aux mêmes endroits et dans le même ordre que
//! le TypeScript : la même graine donne alors les mêmes nombres. Le nombre de tirages est compté (le
//! test de parité compare celui du TypeScript).

pub struct Rng {
    state: u32,
    pub draws: u64,
}

impl Rng {
    /// `seed >>> 0`.
    pub fn new(seed: u32) -> Self {
        Rng { state: seed, draws: 0 }
    }

    /// Un nombre de [0, 1[ (mulberry32, en arithmétique sur 32 bits comme `Math.imul` et `>>>`).
    pub fn random(&mut self) -> f64 {
        self.draws += 1;
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }

    /// `rand(a, b)` : uniforme dans [a, b[.
    pub fn rand(&mut self, a: f64, b: f64) -> f64 {
        a + self.random() * (b - a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comme_mulberry32_en_javascript() {
        // Les trois premiers tirages de la graine 7, calculés par tests/seed.ts
        let mut r = Rng::new(7);
        assert_eq!([r.random(), r.random(), r.random()], [0.011704753153026104, 0.06195825757458806, 0.97690763277933]);
        assert_eq!(r.draws, 3);
    }
}
