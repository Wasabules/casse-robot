import type { ZonePart } from "../../../../shared/design/clearance";
import type { DesignIssue } from "../../../../shared/design/robotDesign";
import type { Message } from "../../i18n";
import { section } from "../section";

/*
 * Ce que le code partagé dit d'un plan de robot, en codes (shared/design/) : ses défauts
 * (`validateDesign`), ce que réserve chaque pièce au-delà de sa case et pourquoi une pose gêne
 * (shared/design/clearance.ts). `{at}` : une case, « x,y,z ».
 */
export const design = {
  ...section("designIssue", {
    fractional: "coordonnées non entières en {at}",
    unknownBlock: "type de bloc inconnu « {type} » en {at}",
    doubleBlock: "deux blocs en {at}",
    badFacing: "orientation invalide en {at}",
    cockpits: { one: "{n} cockpit au lieu d'un seul", other: "{n} cockpits au lieu d'un seul" },
    detached: { one: "{n} bloc détaché du reste", other: "{n} blocs détachés du reste" },
    noSupport: "roue sans bloc support en {at}",
    badSide: "flanc de roue invalide en {at}",
    underOccupied: "roue sous un bloc, mais la case du dessous est occupée ({at})",
    badShift: "décalage de roue invalide en {at}",
    unknownWheel: "type de roue inconnu « {type} » en {at}",
    oldSteer: "case « directrice » d'un ancien plan en {at}",
    stackSide: "seul un galet de chenille, sur un flanc gauche ou droit, s'empile ({at})",
    badStack: "empilement de galets invalide en {at}",
    wheelsOverlap: "deux roues se chevauchent ({at} et {other})",
    overBudget: "coût {cost} au-delà du budget ({budget})",
  } as const satisfies Record<DesignIssue["code"], Message>),
  /** Ce que réserve une pièce au-delà de sa case, avec son article (« le canon » ; en tête de phrase : `{Zone}`). */
  ...section("zonePart", {
    head: "la tête",
    bombDrop: "le passage des bombes",
    mineExit: "la sortie des mines",
    barrel: "le canon",
    rotorBlades: "les pales du rotor",
    propeller: "l'hélice",
    tailRotor: "l'hélice de queue",
    nacelle: "la nacelle",
    leg: "la patte",
    wheel: "la roue",
    roller: "le galet",
    track: "la chenille",
    bar: "la barre de la toupie",
    hammer: "le bras du marteau",
    disc: "le disque de la toupie",
    drum: "le tambour",
    shell: "l'anneau",
    saber: "l'arc de la lame laser",
    whip: "le filament du fouet",
    lance: "la course de la lance",
    field: "le champ",
    saw: "le disque de la scie",
    drill: "la mèche de la foreuse",
    plate: "le plateau du flipper",
    flail: "le tour de la boule du fléau",
    jaw: "les mâchoires",
  } as const satisfies Record<ZonePart, Message>),
  /**
   * Pourquoi une pièce qu'on pose gêne (`{other}` : le nom de l'autre pièce). `n` : 1, ou 2 si ce que
   * réserve la pièce est fait de plusieurs pièces (« les mâchoires entreraient »).
   */
  "conflict.occupied": "Case occupée ({other})",
  "conflict.overlapsWheel": "Chevauche une roue ({other})",
  "conflict.blocks": "Gêne {zone} ({other})",
  "conflict.enters": { one: "{Zone} entrerait dans un bloc ({other})", other: "{Zone} entreraient dans un bloc ({other})" },
  "conflict.hits": { one: "{Zone} heurterait {otherZone} ({other})", other: "{Zone} heurteraient {otherZone} ({other})" },
  /** Une pièce dont on ne connaît pas le type. */
  "conflict.piece": "pièce",
  /** Les pièces d'un plan qui se gênent, une ligne chacune (`{a}`, `{b}` : « Nom (x,y,z) »). */
  "conflictLine.piece": "{name} ({at})",
  "conflictLine.wheels": "{a} et {b} se chevauchent",
  "conflictLine.blocks": "{a} gêne {otherZone} de {b}",
  "conflictLine.zone": "{Zone} de {a} gêne {b}",
  "conflictLine.zones": "{Zone} de {a} gêne {otherZone} de {b}",
} as const;
