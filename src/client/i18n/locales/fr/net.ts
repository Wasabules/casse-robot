import type { RewardLine } from "../../../../shared/design/progression";
import type { Refusal } from "../../../../shared/net/protocol";
import type { Message } from "../../i18n";
import { section } from "../section";

/*
 * Ce que le serveur dit au joueur, en codes (shared/net/protocol.ts : il n'envoie pas de texte), et
 * les crédits d'une partie (shared/design/progression.ts) ; la liaison avec le serveur.
 */
export const net = {
  /** Le serveur refuse le joueur (`{parts}` : les pièces à débloquer, leur nom). */
  ...section("refusal", {
    version: "Version du jeu différente de celle du serveur : recharge la page.",
    token: "Identifiant de joueur illisible : recharge la page.",
    invalidRobot: "Ce robot n'est pas accepté : son plan n'est pas valide.",
    locked: "Pièces à débloquer sur ce serveur : {parts} ({price} crédits, tu en as {credits}). Gagne des crédits avec un robot prédéfini.",
    full: "La salle est pleine.",
  } as const satisfies Record<Refusal["code"], Message>),
  /** Ce qui rapporte des crédits en fin de partie (`n` : combien). */
  ...section("reward", {
    played: "Partie jouée",
    win: "Victoire",
    draw: "Égalité",
    kills: { one: "{n} destruction", other: "{n} destructions" },
    captures: { one: "{n} zone prise", other: "{n} zones prises" },
  } as const satisfies Record<RewardLine["kind"], Message>),
  "net.credits": { one: "{n} crédit sur ce serveur", other: "{n} crédits sur ce serveur" },
  "net.earned": "+{total} crédits ({lines}) · {credits}",
  "net.unlocked": "Débloqué sur ce serveur : {parts} (−{price}) · {credits}",
  "net.lost": "La liaison avec le serveur est coupée.",
  "net.unreachable": "Impossible de joindre le serveur {url}.",
} as const;
