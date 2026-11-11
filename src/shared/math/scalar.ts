export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Nombre aléatoire uniforme dans [a, b[. */
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);

/** Tirage d'une loi normale centrée réduite (méthode de Box-Muller). */
export const randNormal = (): number => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

/** -1 ou 1, au hasard. */
export const randSign = (): number => (Math.random() < 0.5 ? -1 : 1);
