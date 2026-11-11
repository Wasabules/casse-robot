/**
 * Groupes de collision de Rapier : 16 bits d'appartenance (poids forts) et 16 bits de filtre
 * (poids faibles). Deux colliders se heurtent si chacun appartient à un groupe que l'autre filtre.
 * Les débris ne heurtent que le décor fixe : ils ne rebondissent ni sur les robots ni entre eux,
 * ce qui épargne au moteur physique des centaines de contacts. Une roue montée ne heurte que ce
 * qui bouge (robots, accessoires) : sur le sol et le décor fixe, c'est le rayon de sa suspension
 * qui la porte (voir robot/wheels.ts).
 */
const STATIC = 0x0001;
const ROBOT = 0x0002;
const PROP = 0x0004;
const DEBRIS = 0x0008;
const HITBOX = 0x0010;
const EVERYTHING = 0xffff;

const groups = (membership: number, filter: number): number => ((membership << 16) | filter) >>> 0;

export const COLLISION_GROUPS = {
  static: groups(STATIC, EVERYTHING),
  robot: groups(ROBOT, EVERYTHING),
  prop: groups(PROP, EVERYTHING),
  debris: groups(DEBRIS, STATIC),
  /**
   * Un arbre qu'un robot vient de coucher en passant : le temps de sa chute, il ne heurte plus les
   * robots (debout et libéré, il arrêtait net celui qui venait de l'abattre ; voir `fellProp`).
   */
  felled: groups(PROP, STATIC | PROP),
  wheel: groups(ROBOT, ROBOT | PROP),
  /**
   * Zone touchable (tête et canon d'une tourelle) : elle ne heurte rien (filtre vide : ni sol, ni
   * robot, ni accessoire), mais les tirs et les rayons sans filtre de groupe la voient.
   */
  hitbox: groups(HITBOX, 0),
  /** Rayon d'une roue : il ne voit que le sol et le décor fixe (filtré dans Rapier, sans rappel en JavaScript). */
  groundRay: groups(EVERYTHING, STATIC),
} as const;
