import type { RewardLine } from "../../../../shared/design/progression";
import type { Refusal } from "../../../../shared/net/protocol";
import type { Message, ZoneOf } from "../../i18n";
import type { net as fr } from "../fr/net";
import { section } from "../section";

export const net = {
  ...section("refusal", {
    version: "Your game version differs from the server's: reload the page.",
    token: "Unreadable player ID: reload the page.",
    invalidRobot: "This robot isn't accepted: its design isn't valid.",
    locked: "Parts to unlock on this server: {parts} ({price} credits, you have {credits}). Earn credits with a preset robot.",
    full: "The room is full.",
  } as const satisfies Record<Refusal["code"], Message>),
  ...section("reward", {
    played: "Match played",
    win: "Victory",
    draw: "Draw",
    kills: { one: "{n} kill", other: "{n} kills" },
    captures: { one: "{n} zone captured", other: "{n} zones captured" },
  } as const satisfies Record<RewardLine["kind"], Message>),
  "net.credits": { one: "{n} credit on this server", other: "{n} credits on this server" },
  "net.earned": "+{total} credits ({lines}) · {credits}",
  "net.unlocked": "Unlocked on this server: {parts} (−{price}) · {credits}",
  "net.lost": "The connection to the server was lost.",
  "net.restarted": "A simulation error stopped the match: the server started a new one.",
  "net.corrupt": "A frame from the server couldn't be read: the connection was closed.",
  "net.unreachable": "Can't reach the server {url}.",
} as const satisfies ZoneOf<typeof fr>;
