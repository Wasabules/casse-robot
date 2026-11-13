import type { ArmId } from "../catalog/melee";
import type { Vec3 } from "../math/vec";

/*
 * Les commandes du joueur (`PlayerInput`), seules : ce que lit sim/player.ts à chaque pas, ce que le
 * client envoie au serveur, ce que la session de la simulation portée en Rust (src/shared/native/)
 * recopie dans son module. À part de sim/player.ts, qui fait le pilotage (et entraîne toute la
 * simulation du TypeScript, Rapier compris) : la session Rust n'a besoin que de leur forme.
 */

/** Commandes du joueur. */
export interface PlayerInput {
  /**
   * Avancer (1) ou reculer (-1), et tourner (> 0 : à gauche) ; un robot volant se déplace ainsi par
   * rapport à sa caméra. En avion, `steer` vire (à la souris : l'instructeur s'incline et tire) ou
   * roule (manuel) ; `throttle` n'y sert pas (les gaz : `power`).
   */
  throttle: number;
  steer: number;
  /**
   * Monter (1) ou descendre (-1), pour un robot volant ; en avion, cabrer (1) ou piquer (-1) : à la
   * souris, l'instructeur tire ou pousse (tenu, une boucle) ; en manuel, le manche.
   */
  climb: number;
  /**
   * Boost : les propulseurs poussent à fond, les moteurs des roues et des appuis sprintent (voir
   * `SPRINT`, robot/propulsion.ts) ; rien ne retient le robot (roue libre au-delà de leur vitesse).
   * En avion manuel, plein gaz (le client le traduit en `power`).
   */
  boost: boolean;
  /**
   * Frein, de 0 à 1, au sol : les roues et les chenilles freinent dans la limite de leur adhérence
   * (sans basculer le robot), patins et pattes s'arrêtent ; il prime sur les gaz et le boost. Un
   * robot volant s'arrête sur place. En avion : rien.
   */
  brake: number;
  /** Point visé (monde), ou null. */
  aim: Vec3 | null;
  /** Gâchette pressée, et arme choisie (null : toutes les tourelles tirent). */
  trigger: boolean;
  /** Au viseur (clic droit) : les tirs se dispersent moins, et les armes de précision peuvent tirer. */
  scope: boolean;
  /**
   * Conduite à la caméra, comme dans Robocraft : au sol, `throttle` et `steer` donnent une direction
   * à l'écran, le robot tourne vers elle et avance (ou recule s'il lui tourne le dos) ; un robot
   * volant se tourne vers où regarde la caméra (`heading`). Sinon, au clavier : conduite de char, et
   * un robot volant ne pivote qu'au lacet (`yaw`).
   */
  relative: boolean;
  /** Arme choisie : celle d'une tourelle, ou une arme de contact (une toupie tourne tant qu'elle est choisie). */
  weapon: ArmId | null;
  /** Cap de la caméra (rad) : sa direction horizontale est (sin, 0, cos). Les robots volants avancent par rapport à elle. */
  heading: number;
  /**
   * Direction du regard (unitaire, le rayon du réticule), ou null : un avion piloté à la souris va
   * par là (`flyMouse`). Le client la retire pendant qu'on vire ou cabre au clavier (l'avion garde
   * alors sa route, et la caméra le suit).
   */
  look: Vec3 | null;
  /** Faire sauter ses mines télécommandées (touche tenue). */
  detonate: boolean;
  /** Lancer des leurres (touche tenue : une salve toutes les 1,5 s, tant qu'il en reste). */
  flares: boolean;
  /**
   * Avion : pilotage manuel (le manche : `climb` cabre, `steer` roule (> 0 : à gauche), `yaw` est le
   * palonnier), sinon à la souris (`look`, voir `flyMouse`). Lacet (> 0 : à gauche) : le palonnier
   * d'un avion, le pivot d'un robot volant. Gaz d'un avion (0 à 1 ; 0 : moteur coupé), dans les
   * deux pilotages : à part de la direction.
   */
  manual: boolean;
  yaw: number;
  power: number;
}

/** Gaz d'un avion tant que le joueur n'y a pas touché. */
export const CRUISE_POWER = 0.4;

export const newInput = (): PlayerInput => ({
  throttle: 0, steer: 0, climb: 0, boost: false, brake: 0, aim: null, trigger: false, scope: false, relative: false, weapon: null, heading: 0, look: null,
  detonate: false, flares: false, manual: false, yaw: 0, power: CRUISE_POWER,
});
