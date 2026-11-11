import { blockDef } from "../../shared/catalog/blocks";
import { meleeDef, wielded, type ArmId } from "../../shared/catalog/melee";
import { wheelDef } from "../../shared/catalog/wheels";
import { designCost } from "../../shared/design/budget";
import { designMass } from "../../shared/design/flight";
import type { BotProfile } from "../../shared/design/presets";
import type { Part } from "../../shared/design/progression";
import { compareText, fold } from "../i18n/format";
import { t } from "../i18n/i18n";
import { armName, botName, botTrait } from "../i18n/names";

/*
 * Fiches des robots qu'on peut choisir (écran de choix du robot) : ce qui les fait avancer, leurs
 * armes, leur coût et leur masse, d'après leur plan ; et les filtres et tris de la liste. Rien
 * n'est écrit robot par robot : un nouveau robot prédéfini y trouve sa place tout seul. Les textes
 * (noms, propulsions, armes) sont ceux de la langue affichée : la recherche porte sur eux.
 */

/** Ce qui fait avancer un robot : les filtres de la liste. */
export const LOCOMOTIONS = ["wheels", "tracks", "legs", "pads", "hover", "plane"] as const;
export type Locomotion = (typeof LOCOMOTIONS)[number];

/** Nom de la propulsion d'un robot, dans sa fiche (« Patins anti-gravité »). */
export const locomotionName = (l: Locomotion): string => t(`locomotion.${l}`);
/** Nom d'un filtre de la liste, au pluriel (« Patins »). */
export const locomotionFilter = (l: Locomotion): string => t(`locomotionFilter.${l}`);

/** Tris de la liste : l'ordre du jeu (le garage d'abord, puis les robots prédéfinis), le coût, le nom. */
export const SORTS = ["order", "costUp", "costDown", "name"] as const;
export type RobotSort = (typeof SORTS)[number];
export const sortName = (s: RobotSort): string => t(`sort.${s}`);

export interface RobotCard {
  profile: BotProfile;
  /** Robot du garage du joueur. */
  own: boolean;
  /** Pièces qui lui manquent pour être joué, vide s'il est jouable. */
  locked: readonly Part[];
  locomotion: Locomotion;
  cost: number;
  /** Masse (kg). */
  mass: number;
  /** Armes (de tourelle ou de contact), dans l'ordre de leur premier bloc, et combien il en porte. */
  weapons: readonly { id: ArmId; count: number }[];
  /** Place dans l'ordre du jeu. */
  order: number;
}

/**
 * Propulsion d'un robot : un avion, un robot volant ; au sol, ses pattes, ses patins, ses chenilles
 * ou ses roues (dans cet ordre : un robot à pattes qui a aussi des roues est un robot à pattes).
 */
export function locomotionOf(profile: BotProfile): Locomotion {
  if (profile.mobility === "plane") return "plane";
  if (profile.mobility === "hover") return "hover";
  const { blocks, wheels } = profile.design;
  const supports = blocks.map((b) => blockDef(b.type).support?.kind);
  if (supports.includes("leg")) return "legs";
  if (supports.includes("hover")) return "pads";
  if (wheels.some((w) => wheelDef(w.type).track)) return "tracks";
  return "wheels";
}

/** Les armes d'un plan : une par sorte, avec le nombre de ses tourelles (ou de ses armes de contact). */
export function weaponsOf(profile: BotProfile): RobotCard["weapons"] {
  const counts = new Map<ArmId, number>();
  for (const b of profile.design.blocks) {
    const def = blockDef(b.type);
    // (une hélice tranche ce qu'elle frôle, mais c'est un moteur : pas une arme du robot)
    const weapon = def.turret?.weapon ?? (def.melee && wielded(meleeDef(def.melee)) ? def.melee : undefined);
    if (weapon) counts.set(weapon, (counts.get(weapon) ?? 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, count }));
}

/** Fiche d'un robot. `locked` : les pièces qui lui manquent. */
export function robotCard(profile: BotProfile, own: boolean, order: number, locked: readonly Part[] = []): RobotCard {
  return {
    profile,
    own,
    locked,
    locomotion: locomotionOf(profile),
    cost: designCost(profile.design),
    mass: designMass(profile.design),
    weapons: weaponsOf(profile),
    order,
  };
}

/** Filtre de la liste : une propulsion (ou tous), le garage seul, et un texte à chercher. */
export interface RobotFilter {
  locomotion: Locomotion | "all" | "own";
  query: string;
}

/**
 * Le robot passe-t-il le filtre ? Le texte se cherche (sans accents) dans son nom, sa description,
 * ses armes et sa propulsion, tels qu'ils s'affichent dans la langue du joueur.
 */
export function matches(card: RobotCard, filter: RobotFilter): boolean {
  if (filter.locomotion === "own" ? !card.own : filter.locomotion !== "all" && card.locomotion !== filter.locomotion) return false;
  const words = fold(filter.query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fold([botName(card.profile), botTrait(card.profile), locomotionName(card.locomotion), ...card.weapons.map((w) => armName(w.id))].join(" "));
  return words.every((w) => text.includes(w));
}

/** La liste triée (sans toucher à l'originale) ; les noms dans l'ordre alphabétique de la langue affichée. */
export function sortCards(cards: readonly RobotCard[], sort: RobotSort): RobotCard[] {
  const byName = (a: RobotCard, b: RobotCard): number => compareText(botName(a.profile), botName(b.profile));
  const list = [...cards];
  switch (sort) {
    case "order": return list.sort((a, b) => a.order - b.order);
    case "costUp": return list.sort((a, b) => a.cost - b.cost || byName(a, b));
    case "costDown": return list.sort((a, b) => b.cost - a.cost || byName(a, b));
    case "name": return list.sort(byName);
  }
}
