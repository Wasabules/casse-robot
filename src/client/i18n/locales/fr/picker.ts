import type { Locomotion, RobotSort } from "../../../menu/robotCatalog";
import type { Message } from "../../i18n";
import { section } from "../section";

/** L'écran de choix du robot (client/menu/robotPicker.ts, robotCatalog.ts). */
export const picker = {
  /** La propulsion d'un robot, dans sa fiche. */
  ...section("locomotion", {
    wheels: "Roues",
    tracks: "Chenilles",
    legs: "Pattes",
    pads: "Patins anti-gravité",
    hover: "Vol stationnaire",
    plane: "Avion",
  } as const satisfies Record<Locomotion, Message>),
  /** Les filtres de la liste, au pluriel. */
  ...section("locomotionFilter", {
    wheels: "Roues",
    tracks: "Chenilles",
    legs: "Pattes",
    pads: "Patins",
    hover: "Volants",
    plane: "Avions",
  } as const satisfies Record<Locomotion, Message>),
  ...section("sort", {
    order: "Ordre du jeu",
    costUp: "Coût croissant",
    costDown: "Coût décroissant",
    name: "Nom",
  } as const satisfies Record<RobotSort, Message>),
  "picker.filters": "Filtrer par propulsion",
  "picker.all": "Tous",
  "picker.own": "Mon garage",
  "picker.searchHint": "Chercher : nom, arme…",
  "picker.search": "Chercher un robot",
  "picker.sort": "Trier",
  "picker.list": "Robots",
  "picker.noMatch": "Aucun robot ne correspond.",
  "picker.tagGarage": "garage",
  "picker.tagLast": "dernier",
  "picker.unarmed": "sans arme",
  "picker.line": "{locomotion} · {weapons}",
  "picker.lockedLine": "à débloquer · {parts}",
  "picker.rowTitle": "{name} : {trait}",
  "picker.nothing": "Aucun robot à montrer.",
  "picker.cost": "Coût",
  "picker.budget": "{cost} / {budget}",
  "picker.mass": "Masse",
  "picker.locomotion": "Propulsion",
  "picker.speed": "Vitesse",
  "picker.weapons": "Armes",
  "picker.weaponCount": "{name} ×{n}",
  "picker.noWeapon": "Sans arme",
  "picker.unlockFirst": "À débloquer au garage",
  "picker.ownTrait": { one: "{trait} · {n} bloc", other: "{trait} · {n} blocs" },
  "picker.lockedParts": "Pièces à débloquer : {parts}",
} as const;
