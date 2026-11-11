import type { Mobility } from "../../../../shared/design/presets";
import type { AxisWord, MarkSide } from "../../../garage/garage";
import type { Message } from "../../i18n";
import { section } from "../section";

/*
 * Le garage (client/garage/garage.ts, inventory.ts) : panneau de gauche, inventaire, repères au
 * sol et boussole, messages. Ses raccourcis sont ceux que le joueur a choisis (la rubrique Garage
 * de la table des actions) : `{key}`, `{spin}`… sont leurs noms, jamais écrits ici.
 */
export const garage = {
  /** Comptes qui reviennent dans les messages (« 3 blocs, 2 roues »). */
  "garage.count.blocks": { one: "{n} bloc", other: "{n} blocs" },
  "garage.count.wheels": { one: "{n} roue", other: "{n} roues" },
  "garage.count.parts": { one: "{n} pièce", other: "{n} pièces" },
  "garage.count.leftOut": { one: "{n} laissée de côté", other: "{n} laissées de côté" },
  /** Une pièce du plan et sa case (« Tourelle mitrailleuse (1,2,0) »). */
  "garage.blockAt": "{name} ({at})",
  /** Nom d'un nouveau robot, et d'un robot dont on a effacé le nom. */
  "garage.starterName": "Mon robot",
  "garage.unnamed": "Sans nom",
  /** Ce qu'est le robot, d'après ses organes. */
  ...section("garage.mobility", {
    ground: "au sol",
    hover: "volant",
    plane: "avion",
  } as const satisfies Record<Mobility, Message>),
  /** Vers où pointe un axe du bloc à poser (« haut vers le haut, avant vers l'avant »). */
  ...section("garage.axis", {
    up: "le haut",
    down: "le bas",
    front: "l'avant",
    back: "l'arrière",
    left: "la gauche",
    right: "la droite",
  } as const satisfies Record<AxisWord, Message>),
  /** Repères peints au sol autour du robot. */
  ...section("garage.mark", {
    front: "AVANT",
    back: "ARRIÈRE",
    left: "GAUCHE",
    right: "DROITE",
  } as const satisfies Record<MarkSide, Message>),
  /** Boussole à l'écran (initiales). */
  ...section("garage.compass", {
    front: "AV",
    back: "AR",
    left: "G",
    right: "D",
  } as const satisfies Record<MarkSide, Message>),
  /** Messages brefs du panneau. */
  "garage.note.unlocked": "{part} débloqué",
  "garage.note.locked": { one: "{part} : à débloquer ({n} crédit)", other: "{part} : à débloquer ({n} crédits)" },
  "garage.note.copyLayerHint": "Pour copier un étage, passe en vue par étage ({key})",
  "garage.note.layerCopied": "Étage {layer} copié : {blocks}, {wheels}",
  "garage.note.pasted": "Collé : {pasted}",
  "garage.note.pastedSome": "Collé : {pasted} ; {left} : {reason}",
  "garage.note.zoneCopied": "Zone copiée : {blocks}, {wheels} ({key} : sous le pointeur)",
  "garage.note.pasteZoneHint": "Vise l'endroit où coller la zone, puis {key}",
  "garage.note.twinRefused": "Symétrique non posé : {reason}",
  "garage.note.copied": "Copie : {part} ({key} pour poser)",
  "garage.note.manualOrientation": "Orientation manuelle ({key} : revenir à l'orientation selon la face)",
  /** Pourquoi le symétrique de la pièce visée ne passe pas. */
  "garage.clash.twin": "Symétrique : {reason}",
  /** Panneau de gauche. */
  "garage.panel.nameLabel": "Nom du robot",
  "garage.panel.colorLabel": "Couleur du robot",
  "garage.panel.sandbox": "Bac à sable : toutes les pièces",
  "garage.panel.credits": { one: "{n} crédit", other: "{n} crédits" },
  "garage.panel.part": "Pièce",
  "garage.panel.price": { one: "🔒 {n} crédit", other: "🔒 {n} crédits" },
  "garage.panel.mirror": "Symétrie ({key})",
  "garage.panel.faceOrient": "Orientation selon la face ({key})",
  "garage.panel.spin": "Pivoter",
  "garage.panel.tilt": "Basculer",
  "garage.panel.undo": "Annuler",
  "garage.panel.redo": "Rétablir",
  "garage.panel.layerView": "Vue par étage ({key})",
  "garage.panel.layer": "Étage {n}",
  "garage.panel.copyLayer": "Copier l'étage",
  "garage.panel.paste": "Coller",
  "garage.panel.zone": "Zone {size} · {blocks}",
  "garage.panel.copyZone": "Copier",
  "garage.panel.clearZone": "Effacer",
  "garage.panel.deselect": "Désélectionner",
  "garage.panel.zoneHint": "Zone : {key} sur deux blocs opposés",
  /** Au survol du bouton qui désélectionne la zone : le geste qui le fait aussi. */
  "garage.panel.deselectHint": "{key} à côté",
  "garage.help.title": "Commandes du garage",
  /** Les pièces récentes : « 1 à 9 ». */
  "garage.help.range": "{from} à {to}",
  "garage.help.text": "Inventaire à droite : {search} pour chercher, {recent} : pièces récentes, {eyedrop} : copier la pièce visée (avec son orientation) · {place} : poser (une roue va vers le bord de la face visé, ou dessous ; un galet de chenille sur un autre : dessus, dessous, ou côté extérieur pour l'élargir) · {spin} : pivoter · {tilt} : basculer · {orient} : orientation selon la face · {mirror} : symétrie · {remove} : enlever · {select} : zone · {copy} / {paste} : copier, coller (une zone, sous le pointeur) · {clear} : vider la zone · {layers} : vue par étage, {up} / {down} : changer d'étage · glisser : tourner la vue · molette : zoom · {undo} / {redo} : annuler, rétablir · boule rouge : centre de masse",
  "garage.action.test": "Essayer",
  "garage.action.save": "Enregistrer",
  "garage.action.browse": "Mes robots",
  "garage.action.new": "Nouveau",
  /** L'orientation du bloc à poser. */
  "garage.facing.wheel": "Une roue se pose sur un flanc, vers le bord visé",
  "garage.facing.words": "haut vers {up}, avant vers {forward}",
  "garage.facing.thrust": " (il pousse vers son haut : flèche jaune)",
  "garage.facing.auto": "Orientation selon la face visée (sous un bloc : tête en bas) · {spin} : pivoter",
  "garage.facing.autoSpin": "Orientation selon la face visée (sous un bloc : tête en bas) · {spin} : pivoter ({deg}°)",
  "garage.facing.copied": "Orientation copiée : {words}{thrust} · {spin} : pivoter · {tilt} : basculer · {orient} : selon la face",
  "garage.facing.manual": "Orientation : {words}{thrust} · {spin} : pivoter · {tilt} : basculer",
  /** Caractéristiques et défauts du robot. */
  "garage.stats.cost": "Coût {cost} / {budget} · {blocks} · {wheels}",
  "garage.stats.mass": "Masse {mass} · {mobility}",
  "garage.stats.ready": "Prêt à rouler",
  "garage.com.line": "Centre de masse (boule rouge) : {depth} · à {height} du sol",
  "garage.com.lineSide": "Centre de masse (boule rouge) : {depth} · {side} · à {height} du sol",
  "garage.com.center": "au centre",
  "garage.com.front": "{d} devant",
  "garage.com.behind": "{d} derrière",
  "garage.com.left": "{d} à gauche",
  "garage.com.right": "{d} à droite",
  "garage.flight.noLift": "ne décolle pas",
  "garage.flight.unlimited": "autonomie illimitée",
  "garage.flight.endurance": "autonomie {time} en vol",
  "garage.flight.lift": "Portance ×{ratio} le poids · {time} · batteries {battery}",
  "garage.flight.thrust": "Poussée ×{ratio} le poids ({thrust})",
  "garage.warn.buried": "Enfouie sous un bloc, elle ne tirera pas : {names}",
  "garage.warn.scorched": "Dans le jet d'un moteur, il brûlera : {names}",
  "garage.warn.clashes": "Pièces qui se gênent : {list}",
  "garage.warn.clashesMore": "Pièces qui se gênent : {list} (+{n})",
  "garage.warn.locked": "À débloquer pour jouer en partie : {parts}",
  /** Inventaire (panneau de droite). */
  "garage.inventory.title": "Pièces",
  "garage.inventory.allAvailable": "toutes disponibles",
  "garage.inventory.credits": { one: "{n} crédit", other: "{n} crédits" },
  "garage.inventory.searchHint": "Rechercher (nom, arme, rôle…)  {key}",
  "garage.inventory.search": "Rechercher une pièce",
  "garage.inventory.all": "Tout",
  "garage.inventory.recent": "Récentes",
  "garage.inventory.noMatch": "Aucune pièce ne correspond.",
  "garage.inventory.cardTitle": "{name} — {summary}",
  "garage.inventory.cardPrice": "🔒 {n} cr.",
  "garage.inventory.price": { one: "🔒 {n} crédit", other: "🔒 {n} crédits" },
  "garage.inventory.unlock": "Débloquer",
  "garage.inventory.missing": "Il manque {n}",
} as const;
