/**
 * Constantes de la simulation, communes au client et au futur serveur.
 * Unités : mètres, kilogrammes, secondes, radians.
 */

/** Pas fixe de la physique (s). */
export const STEP = 1 / 60;
export const GRAVITY = 9.81;
/** Itérations du solveur de contraintes de Rapier. */
export const SOLVER_ITERATIONS = 4;

/** Côté d'une case de la grille des robots (m). */
export const BLOCK_SIZE = 0.5;
/** Demi-côté du collider d'un bloc : on laisse un petit jeu entre blocs voisins. */
export const BLOCK_HALF = BLOCK_SIZE * 0.49;
export const BLOCK_FRICTION = 0.45;
export const BLOCK_RESTITUTION = 0.02;
/** Épaisseur des blocs en plaque (ailes, gouvernes) (m). */
export const PLATE_THICKNESS = 0.1;

/** Masse volumique de l'air (kg/m³). */
export const AIR_DENSITY = 1.225;

/**
 * Amortissement des morceaux de robot, au sol et en vol. En vol, l'air freine à peine les
 * rotations : c'est le pilote automatique qui tient l'assiette, avec les réacteurs.
 */
export const PART_DAMPING = {
  ground: { linear: 0.05, angular: 0.15 },
  hover: { linear: 0.3, angular: 0.3 },
  /** Avion : la traînée et l'amortissement viennent de ses ailes (aérodynamique), pas d'un réglage. */
  plane: { linear: 0.01, angular: 0.05 },
} as const;

/** Jeu entre une roue et son bloc support (m). Les caractéristiques des roues sont dans catalog/wheels.ts. */
export const WHEEL_GAP = 0.06;
export const WHEEL_ANGULAR_DAMPING = 0.05;
/**
 * Adhérence latérale d'une roue directrice dont la direction n'est plus alimentée (morceau détaché
 * du cockpit, paralysie) : sa fusée pivote librement, et elle glisse de côté.
 */
export const LOOSE_STEER_GRIP = 0.5;
/**
 * Adhérence latérale d'une roulette, en part de celle de son pneu : elle pivote pour suivre le
 * mouvement, et ne retient presque pas le robot de côté.
 */
export const CASTER_SIDE_GRIP = 0.1;
/**
 * Variateur des moteurs de roue : la tension appliquée suit la commande avec cette rampe
 * (fraction de la pleine tension par seconde), pour éviter les à-coups qui renversent les robots hauts.
 */
export const DRIVE_RAMP = 1.2;
/** Frein d'une roue en roue libre (N·m par rad/s). */
export const FREEWHEEL_DRAG = 0.5;

/**
 * Turbulence de l'air sur les robots volants : marche aléatoire de la vitesse angulaire
 * (rad/s par √s) et de la vitesse (m/s par √s). Le pilote automatique la corrige tant qu'il
 * contrôle tous les axes ; sinon, le robot dérive.
 */
export const TURBULENCE = { angular: 0.3, linear: 0.4 } as const;

/**
 * Énergie : le cockpit contient une petite batterie (kJ) et un générateur (kW) qui recharge les
 * batteries en continu. Les réacteurs et les propulseurs consomment plus qu'il ne produit.
 */
export const COCKPIT_BATTERY = 20;
export const GENERATOR_POWER = 1.2;

/** Portée de la vue (m) : au-delà, et derrière un mur ou de la fumée, il faut un radar pour repérer un ennemi. */
export const SIGHT_RANGE = 70;

/** Nombre maximal de débris simultanés : au-delà, les plus anciens disparaissent. */
export const MAX_DEBRIS = 220;
