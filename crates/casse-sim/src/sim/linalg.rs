//! L'algèbre linéaire du pilote (src/shared/math/linalg.ts) : un système carré résolu par élimination
//! de Gauss avec pivot partiel (`solveLinear`), et les moindres carrés pondérés bornés
//! (`boundedLeastSquares`) avec lesquels le vol stationnaire répartit la poussée entre ses moteurs et
//! le mélangeur braque les gouvernes. Les mêmes opérations dans le même ordre.

use crate::jsmath;

/// Résout le système carré m·x = b (`solveLinear`) ; rien si m est singulière.
pub fn solve_linear(m: &[Vec<f64>], b: &[f64]) -> Option<Vec<f64>> {
    let n = b.len();
    let mut a: Vec<Vec<f64>> = m.iter().enumerate().map(|(i, row)| row.iter().copied().chain([b[i]]).collect()).collect();
    for col in 0..n {
        let mut pivot = col;
        for r in col + 1..n {
            if a[r][col].abs() > a[pivot][col].abs() {
                pivot = r;
            }
        }
        if a[pivot][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, pivot);
        for r in col + 1..n {
            let k = a[r][col] / a[col][col];
            for c in col..=n {
                let v = k * a[col][c];
                a[r][c] -= v;
            }
        }
    }
    let mut x = vec![0.0; n];
    for r in (0..n).rev() {
        let mut s = a[r][n];
        for c in r + 1..n {
            s -= a[r][c] * x[c];
        }
        x[r] = s / a[r][r];
    }
    Some(x)
}

/// Moindres carrés pondérés avec bornes (`boundedLeastSquares`) : minimise Σₖ wₖ·(Aₖ·x − bₖ)² +
/// reg·|x|², avec lo ≤ x ≤ hi ; on résout, on bloque sur leur borne les variables qui en sortent,
/// puis on résout à nouveau pour les autres.
pub fn bounded_least_squares(rows: &[Vec<f64>], b: &[f64], w: &[f64], lo: &[f64], hi: &[f64], reg: f64) -> Vec<f64> {
    let n = lo.len();
    let mut x = vec![0.0; n];
    let mut free: Vec<usize> = (0..n).collect();
    while !free.is_empty() {
        // Ce qui reste à obtenir une fois retirée la contribution des variables bloquées
        let is_free = |j: usize| free.contains(&j);
        let rest: Vec<f64> = rows
            .iter()
            .enumerate()
            .map(|(k, row)| b[k] - row.iter().enumerate().fold(0.0, |s, (j, &a)| if is_free(j) { s } else { s + a * x[j] }))
            .collect();
        let f = free.len();
        let mut normal = vec![vec![0.0; f]; f];
        let mut rhs = vec![0.0; f];
        for (k, row) in rows.iter().enumerate() {
            for i in 0..f {
                let ai = row[free[i]] * w[k];
                rhs[i] += ai * rest[k];
                for j in 0..f {
                    normal[i][j] += ai * row[free[j]];
                }
            }
        }
        for (i, line) in normal.iter_mut().enumerate() {
            line[i] += reg;
        }
        let sol = solve_linear(&normal, &rhs).unwrap_or_else(|| vec![0.0; f]);

        let mut out: Vec<usize> = Vec::new();
        for (i, &value) in sol.iter().enumerate() {
            let j = free[i];
            x[j] = value;
            if value < lo[j] || value > hi[j] {
                out.push(j);
            }
        }
        if out.is_empty() {
            break;
        }
        for &j in &out {
            x[j] = jsmath::min(hi[j], jsmath::max(lo[j], x[j]));
        }
        free.retain(|j| !out.contains(j));
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resout_et_borne() {
        let x = solve_linear(&[vec![2.0, 1.0], vec![1.0, 3.0]], &[3.0, 5.0]).expect("inversible");
        assert!((x[0] - 0.8).abs() < 1e-12 && (x[1] - 1.4).abs() < 1e-12);
        assert!(solve_linear(&[vec![1.0, 2.0], vec![2.0, 4.0]], &[1.0, 2.0]).is_none());
        // (deux variables qui voudraient 3 et -1, bornées à [0, 2])
        let x = bounded_least_squares(&[vec![1.0, 0.0], vec![0.0, 1.0]], &[3.0, -1.0], &[1.0, 1.0], &[0.0, 0.0], &[2.0, 2.0], 1e-6);
        assert_eq!(x, vec![2.0, 0.0]);
    }
}
