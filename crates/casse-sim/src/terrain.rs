//! Relief d'une arène (porté de src/shared/arena/terrain.ts) : un carré de `size` m de côté, centré
//! sur l'origine, découpé en `cells` cases par côté, avec une hauteur à chaque sommet. Les calculs
//! suivent ceux du TypeScript opération par opération : mêmes résultats au bit près (vérifié par
//! tests/native.test.ts, qui compare les deux).

/// Le relief : hauteurs aux sommets (m), colonne par colonne, une colonne par x (de -size/2 à
/// size/2), et dans chacune les z croissants (indice ix·(cells+1) + iz), comme Rapier les attend.
pub struct Terrain {
    pub size: f64,
    pub cells: usize,
    pub heights: Vec<f32>,
}

/// `Math.max(lo, Math.min(hi, v))` (src/shared/math/scalar.ts).
#[inline]
pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    lo.max(hi.min(v))
}

impl Terrain {
    /// Hauteur d'un sommet (indices bornés à la grille).
    #[inline]
    fn vertex(&self, ix: i64, iz: i64) -> f64 {
        let n = self.cells + 1;
        let last = self.cells as i64;
        let ix = ix.clamp(0, last) as usize;
        let iz = iz.clamp(0, last) as usize;
        self.heights[ix * n + iz] as f64
    }

    /// Hauteur du sol en (x, z) (m), interpolée comme le fait Rapier : chaque case est coupée en
    /// deux triangles le long de sa diagonale. Hors du carré, celle de son bord.
    pub fn height(&self, x: f64, z: f64) -> f64 {
        let step = self.size / self.cells as f64;
        let fx = clamp((x + self.size / 2.0) / step, 0.0, self.cells as f64 - 1e-6);
        let fz = clamp((z + self.size / 2.0) / step, 0.0, self.cells as f64 - 1e-6);
        let ix = fx.floor();
        let iz = fz.floor();
        let u = fx - ix;
        let v = fz - iz;
        let (ix, iz) = (ix as i64, iz as i64);
        let h00 = self.vertex(ix, iz);
        let h10 = self.vertex(ix + 1, iz);
        let h01 = self.vertex(ix, iz + 1);
        let h11 = self.vertex(ix + 1, iz + 1);
        // Diagonale de (ix+1, iz) à (ix, iz+1)
        if u + v < 1.0 {
            h00 + (h10 - h00) * u + (h01 - h00) * v
        } else {
            h11 + (h01 - h11) * (1.0 - u) + (h10 - h11) * (1.0 - v)
        }
    }

    /// Distance le long du rayon (`dir` unitaire) où il entre dans le relief, au plus `max_dist` m ;
    /// None s'il ne le touche pas. Par pas d'un mètre, puis affiné par dichotomie.
    pub fn ray(&self, origin: [f64; 3], dir: [f64; 3], max_dist: f64) -> Option<f64> {
        let below = |d: f64| origin[1] + dir[1] * d < self.height(origin[0] + dir[0] * d, origin[2] + dir[2] * d);
        if below(0.0) {
            return None;
        }
        const STEP: f64 = 1.0;
        let mut d = STEP;
        while d <= max_dist + STEP {
            let end = d.min(max_dist);
            if !below(end) {
                if end >= max_dist {
                    return None;
                }
                d += STEP;
                continue;
            }
            // Entre end - STEP (au-dessus) et end (dessous) : dichotomie
            let mut lo = end - STEP;
            let mut hi = end;
            for _ in 0..8 {
                let mid = (lo + hi) / 2.0;
                if below(mid) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            return Some(lo);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_incline() {
        // h = x : la hauteur suit x, des deux côtés de la diagonale
        let cells = 4;
        let size = 8.0;
        let n = cells + 1;
        let mut heights = vec![0f32; n * n];
        for ix in 0..n {
            for iz in 0..n {
                heights[ix * n + iz] = (-size / 2.0 + ix as f64 * 2.0) as f32;
            }
        }
        let t = Terrain { size, cells, heights };
        assert!((t.height(1.3, -0.7) - 1.3).abs() < 1e-9);
        assert!((t.height(-2.9, 3.1) + 2.9).abs() < 1e-9);
        // Hors du carré : la hauteur du bord
        assert!((t.height(10.0, 0.0) - (4.0 - 2e-6)).abs() < 1e-5);
    }

    #[test]
    fn rayon_vers_le_sol() {
        let t = Terrain { size: 10.0, cells: 2, heights: vec![0.0; 9] };
        let d = t.ray([0.0, 5.0, 0.0], [0.0, -1.0, 0.0], 20.0).unwrap();
        assert!((d - 5.0).abs() < 0.01);
        assert!(t.ray([0.0, 5.0, 0.0], [0.0, 1.0, 0.0], 20.0).is_none());
    }
}
