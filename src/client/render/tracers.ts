import type { Projectile } from "../../shared/sim/entities";

/** Une balle de fusil sur `TRACER_EVERY` est une traçante (d'après son identifiant, le même sur la réplique). */
export const TRACER_EVERY = 4;
export const isTracer = (p: Projectile): boolean => p.weapon === "rifle" && p.id % TRACER_EVERY === 0;
