/** Résout le système carré m·x = b (élimination de Gauss avec pivot partiel). Null si m est singulière. */
export function solveLinear(m: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const n = b.length;
  const a = m.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = col + 1; r < n; r++) {
      const k = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= k * a[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r][n];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

/**
 * Moindres carrés pondérés avec bornes : minimise Σₖ wₖ·(Aₖ·x − bₖ)² + reg·|x|², avec lo ≤ x ≤ hi.
 * Méthode des contraintes actives simplifiée : on résout, on bloque sur leur borne les variables
 * qui en sortent, puis on résout à nouveau pour les autres.
 * `rows` : les lignes Aₖ de la matrice (chacune de longueur n).
 */
export function boundedLeastSquares(
  rows: readonly (readonly number[])[], b: readonly number[], w: readonly number[],
  lo: readonly number[], hi: readonly number[], reg = 1e-6,
): number[] {
  const n = lo.length;
  const x = new Array<number>(n).fill(0);
  let free = [...Array(n).keys()];
  while (free.length) {
    // Ce qui reste à obtenir une fois retirée la contribution des variables bloquées
    const isFree = new Set(free);
    const rest = rows.map((row, k) => b[k] - row.reduce((s, a, j) => (isFree.has(j) ? s : s + a * x[j]), 0));
    const f = free.length;
    const normal = Array.from({ length: f }, () => new Array<number>(f).fill(0));
    const rhs = new Array<number>(f).fill(0);
    rows.forEach((row, k) => {
      for (let i = 0; i < f; i++) {
        const ai = row[free[i]] * w[k];
        rhs[i] += ai * rest[k];
        for (let j = 0; j < f; j++) normal[i][j] += ai * row[free[j]];
      }
    });
    for (let i = 0; i < f; i++) normal[i][i] += reg;
    const sol = solveLinear(normal, rhs) ?? new Array<number>(f).fill(0);

    const out: number[] = [];
    sol.forEach((value, i) => {
      const j = free[i];
      x[j] = value;
      if (value < lo[j] || value > hi[j]) out.push(j);
    });
    if (!out.length) break;
    for (const j of out) x[j] = Math.min(hi[j], Math.max(lo[j], x[j]));
    free = free.filter((j) => !out.includes(j));
  }
  return x;
}
