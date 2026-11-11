/*
 * Le choix des lumières d'une image (sans Babylon : testé dans Node, tests/nightLights.test.ts).
 * Tout ce qui éclaire en demande une à chaque image (render/nightLights.ts : lampadaires, phares,
 * projectiles, explosions, flammes…) ; la réserve n'en a qu'un nombre fixe : les plus utiles à la
 * caméra passent, une lumière déjà choisie gardant un avantage (elle ne clignote pas d'une image à
 * l'autre quand deux se disputent la dernière place).
 */

/** Une lumière demandée pour cette image. */
export interface LightRequest {
  /**
   * Ce qui l'émet, le même d'une image à l'autre (un bloc, un accessoire, un projectile, un
   * éclair) : une lumière qui reste choisie garde la même lumière de la réserve.
   */
  key: unknown;
  x: number;
  y: number;
  z: number;
  /** Couleur (0 à 1). */
  r: number;
  g: number;
  b: number;
  /** Force (1 : environ la lumière du soleil, au pied de la lampe). */
  intensity: number;
  /** Portée (m) : elle s'éteint jusqu'à cette distance. */
  range: number;
  /** Un cône (projecteur, phare) : sa direction (unitaire) et son angle total (rad) ; sans eux, tout autour. */
  dir?: { x: number; y: number; z: number };
  angle?: number;
  /** Elle s'allume d'un coup (un éclair) ; sinon, elle apparaît en un instant quand elle entre dans le choix (`FADE_IN`). */
  sudden?: boolean;
  /** Un cône : la nuit, l'air qu'il éclaire se voit sur cette longueur (m ; render/lightBeams.ts). */
  beam?: number;
}

/** Une lumière déjà choisie pèse d'autant plus (elle ne cède sa place qu'à une nettement plus utile). */
export const KEEP = 1.5;
/** Au-delà de cette distance (m) entre la caméra et ce qu'elle éclaire, on ne la voit plus (le brouillard). */
export const LIGHT_SIGHT = 150;

/**
 * Ce que vaut une lumière pour la caméra en `eye` : sa force fois sa portée, divisées par la
 * distance de la caméra à ce qu'elle éclaire (sa sphère). Une lampe forte et proche passe avant un
 * éclair lointain ; une lumière dont la caméra est dans la portée vaut le plus.
 */
export function lightScore(r: LightRequest, eye: { x: number; y: number; z: number }): number {
  const d = Math.hypot(r.x - eye.x, r.y - eye.y, r.z - eye.z);
  const gap = d - r.range;
  if (gap > LIGHT_SIGHT || r.intensity <= 0 || r.range <= 0) return 0;
  return (r.intensity * r.range) / Math.max(1, gap);
}

/**
 * Les lumières à allumer : au plus `budget`, les plus utiles d'abord (voir `lightScore`), celles de
 * `kept` (choisies à l'image précédente, par leur `key`) pesant `KEEP` fois plus.
 */
export function chooseLights(requests: readonly LightRequest[], eye: { x: number; y: number; z: number }, budget: number, kept: ReadonlySet<unknown>): LightRequest[] {
  if (budget <= 0) return [];
  const scored: { r: LightRequest; s: number }[] = [];
  for (const r of requests) {
    const s = lightScore(r, eye) * (kept.has(r.key) ? KEEP : 1);
    if (s > 0) scored.push({ r, s });
  }
  if (scored.length > budget) scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, budget).map((e) => e.r);
}
