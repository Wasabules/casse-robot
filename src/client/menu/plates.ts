import { wheelDef } from "../../shared/catalog/wheels";
import { weaponDef } from "../../shared/catalog/weapons";
import { energyCapacity, energyFraction } from "../../shared/robot/energy";
import { drivenWheelCount, integrity } from "../../shared/robot/queries";
import type { Bot, Team } from "../../shared/sim/entities";
import type { Match } from "../../shared/sim/match";
import { pct } from "../i18n/format";
import { t } from "../i18n/i18n";
import { botName } from "../i18n/names";

/*
 * Les pièces de la casse que posent certains écrans de menu (menu.ts : `corner`, `aside`) :
 * l'étiquette de carton des crédits et le bouton carré d'acier de l'accueil, la plaque du score et
 * le constat du robot de la pause, le reçu des crédits de la fin de partie. Leur apparence :
 * style.css (« La Casse »).
 */

/** Où est une roue arrachée sur le robot : à l'avant ou à l'arrière, à gauche ou à droite (vide : on ne sait pas le dire). */
export type WheelSpot = "frontLeft" | "frontRight" | "backLeft" | "backRight" | "front" | "back" | "left" | "right";

/**
 * La note manuscrite du constat : un fait que le monde affiché connaît (le robot détruit, et par
 * qui ; ses roues ou ses galets arrachés), ou rien.
 */
export type ReportNote =
  | { kind: "destroyed"; by: string | null }
  | { kind: "wheel"; spot: WheelSpot | null }
  | { kind: "wheels"; n: number }
  | { kind: "rollers"; n: number };

/**
 * Ce que le constat de la pause dit du robot du joueur. Rien que ce que la page sait déjà (le
 * monde affiché : la simulation de la page, ou la réplique d'une partie dans un Worker ou en
 * réseau) : ce que lisent le HUD et le tableau (Tab). Rien de plus n'est demandé à la simulation.
 */
export interface RobotReport {
  name: string;
  team: Team;
  alive: boolean;
  /** Part des blocs de départ encore reliés au cockpit (la structure du HUD), de 0 à 1. */
  integrity: number;
  /** Blocs encore reliés au cockpit, et au départ. */
  blocks: readonly [number, number];
  /** Roues (ou galets de chenille) encore montées sur le morceau du cockpit, et au départ ; null sans roue. */
  wheels: { mounted: number; total: number; rollers: boolean } | null;
  /** Charge des batteries, de 0 à 1, pour un robot qui y puise (comme le HUD) ; null sinon. */
  battery: number | null;
  /** Destructions du joueur dans cette partie ; null hors d'une partie. */
  kills: number | null;
  note: ReportNote | null;
}

/** Un écart en profondeur (m) au-delà duquel une roue est à l'avant ou à l'arrière des autres. */
const AXLE_GAP = 0.25;

/** Où est cette roue, par rapport au milieu des roues du robot. */
function wheelSpot(bot: Bot, local: { x: number; z: number }, side: number): WheelSpot | null {
  const middle = bot.wheels.reduce((s, w) => s + w.local.z, 0) / bot.wheels.length;
  const depth = local.z > middle + AXLE_GAP ? "front" : local.z < middle - AXLE_GAP ? "back" : "";
  // (repère du robot : l'avant vers +z, la gauche vers +x)
  const lateral = side > 0 ? "Left" : side < 0 ? "Right" : "";
  if (depth && lateral) return `${depth}${lateral}` as WheelSpot;
  if (depth) return depth as WheelSpot;
  return lateral ? (lateral.toLowerCase() as WheelSpot) : null;
}

/** Le constat du robot du joueur ; `kills` : ses destructions dans la partie (null hors d'une partie). */
export function robotReport(bot: Bot, kills: number | null): RobotReport {
  const alive = bot.cockpit.alive;
  const rollers = bot.wheels.length > 0 && bot.wheels.every((w) => wheelDef(w.type).track);
  // Arrachées : celles qui ne sont plus sur le morceau du cockpit (arrachées seules, ou parties avec leur bloc)
  const torn = alive ? bot.wheels.filter((w) => !w.hub || w.part !== bot.cockpit.part) : [];
  // Les batteries comptent pour un robot qui y puise (le HUD les montre alors) : moteurs, appuis, bouclier, arme de contact ou électrique
  const flies = bot.thrusters.length > 0 || bot.supports.length > 0;
  const powered = flies || bot.shields.length > 0 || bot.melee.length > 0 || bot.turrets.some((tu) => weaponDef(tu.weapon).power);
  let note: ReportNote | null = null;
  if (!alive) note = { kind: "destroyed", by: bot.lastAttacker ? botName(bot.lastAttacker.profile) : null };
  else if (torn.length === 1 && !rollers) note = { kind: "wheel", spot: wheelSpot(bot, torn[0].local, torn[0].side) };
  else if (torn.length) note = { kind: rollers ? "rollers" : "wheels", n: torn.length };
  return {
    name: botName(bot.profile),
    team: bot.team,
    alive,
    integrity: alive ? integrity(bot) : 0,
    blocks: [alive ? bot.cockpit.part.blocks.size : 0, bot.total],
    wheels: bot.wheels.length ? { mounted: drivenWheelCount(bot), total: bot.wheels.length, rollers } : null,
    battery: alive && powered && energyCapacity(bot) > 0 ? energyFraction(bot) : null,
    kills,
    note,
  };
}

/** La note manuscrite du constat, dans la langue affichée. */
export function reportNote(note: ReportNote): string {
  switch (note.kind) {
    case "destroyed": return note.by ? t("menu.report.destroyedBy", { killer: note.by }) : t("menu.report.destroyed");
    case "wheel": return note.spot ? t("menu.report.wheelAt", { spot: t(`menu.report.spot.${note.spot}`) }) : t("menu.report.wheels", { n: 1 });
    case "wheels": return t("menu.report.wheels", { n: note.n });
    case "rollers": return t("menu.report.rollers", { n: note.n });
  }
}

/** Le constat sur son porte-bloc : le nom du robot, sa structure, ses blocs, ses roues, ses batteries, ses destructions, et la note. */
export function constat(report: RobotReport): HTMLElement {
  const board = el("div", "menu-clipboard");
  const sheet = el("div", "menu-sheet");
  sheet.append(el("h2", "menu-sheet-title", t("menu.report.title", { name: report.name })));
  const bar = el("div", "menu-sheet-bar");
  const head = el("div", "menu-sheet-line");
  head.append(el("span", "", t("menu.report.structure")), el("b", "", pct(report.integrity)));
  const gauge = el("div", `menu-gauge ${report.team}`);
  gauge.setAttribute("role", "img");
  gauge.setAttribute("aria-label", t("menu.report.structureLevel", { level: pct(report.integrity) }));
  const fill = el("i", "");
  fill.style.width = `${Math.round(report.integrity * 100)}%`;
  gauge.append(fill);
  bar.append(head, gauge);
  sheet.append(bar);
  const facts = el("dl", "menu-sheet-facts");
  const fact = (label: string, value: string): void => {
    facts.append(el("dt", "", label), el("dd", "", value));
  };
  fact(t("menu.report.blocks"), t("menu.report.of", { n: report.blocks[0], total: report.blocks[1] }));
  if (report.wheels) fact(t(report.wheels.rollers ? "menu.report.rollersLine" : "menu.report.wheelsLine"), t("menu.report.of", { n: report.wheels.mounted, total: report.wheels.total }));
  if (report.battery !== null) fact(t("menu.report.battery"), pct(report.battery));
  if (report.kills !== null) fact(t("menu.report.kills"), String(report.kills));
  sheet.append(facts);
  if (report.note) sheet.append(el("p", "menu-sheet-note", reportNote(report.note)));
  board.append(sheet);
  return board;
}

/** Le temps de la partie (celui qui reste, ou celui écoulé sans limite), comme le HUD : « 4:12 ». */
export function matchClock(match: Match): string {
  const seconds = Math.max(0, Math.ceil(match.rules.timeLimit ? match.rules.timeLimit - match.elapsed : match.elapsed));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** La plaque du score : les deux équipes à leur couleur, leurs points au pochoir, le temps de la partie. */
export function scorePlate(score: Readonly<Record<Team, number>>, clock: string | null): HTMLElement {
  const blue = Math.floor(score.blue);
  const red = Math.floor(score.red);
  const plate = el("div", "menu-score");
  plate.setAttribute("role", "img");
  plate.setAttribute("aria-label", t("menu.result.score", { blue, red }));
  plate.append(
    el("span", "menu-team blue", t("team.blue")), el("b", "", String(blue)),
    el("span", "menu-score-dot", "·"),
    el("b", "", String(red)), el("span", "menu-team red", t("team.red")),
  );
  if (clock) plate.append(el("span", "menu-clock", clock));
  return plate;
}

/** L'étiquette de carton des crédits (l'accueil) : ce qu'elle compte, la valeur au pochoir, une ligne dessous (le nom du joueur). */
export function creditTag(label: string, value: string, line: string): HTMLElement {
  const tag = el("div", "menu-tag");
  tag.append(el("span", "menu-tag-label", label), el("span", "menu-tag-value", value));
  if (line) tag.append(el("span", "menu-tag-line", line));
  return tag;
}

/** Les pictogrammes des boutons d'acier. */
const ICONS = {
  fullscreen: "M2 8V2h6M14 2h6v6M20 14v6h-6M8 20H2v-6",
  exitFullscreen: "M8 2v6H2M20 8h-6V2M14 20v-6h6M2 14h6v6",
} as const;

/** Un petit bouton carré d'acier, à pictogramme (le plein écran) ; `key` : sa clé, pour garder le focus quand l'écran se redessine. */
export function toolButton(icon: keyof typeof ICONS, label: string, key: string, onSelect: () => void): HTMLButtonElement {
  const button = el("button", "menu-tool");
  button.type = "button";
  button.dataset.key = key;
  button.title = label;
  button.setAttribute("aria-label", label);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 22 22");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[icon]);
  svg.append(path);
  button.append(svg);
  button.addEventListener("click", onSelect);
  return button;
}

/** Un groupe de pièces côte à côte (le coin de l'accueil : le bouton d'acier et l'étiquette). */
export function cluster(...parts: HTMLElement[]): HTMLElement {
  const box = el("div", "menu-cluster");
  box.append(...parts);
  return box;
}

/** Le reçu des crédits gagnés, sur une étiquette de carton : une ligne par gain, puis le total. */
export function receipt(title: string, lines: readonly (readonly [string, string])[], total: readonly [string, string]): HTMLElement {
  const ticket = el("div", "menu-receipt");
  ticket.append(el("h2", "menu-receipt-title", title));
  const list = el("dl", "menu-receipt-lines");
  for (const [amount, what] of lines) list.append(el("dt", "", amount), el("dd", "", what));
  const sum = el("dl", "menu-receipt-total");
  sum.append(el("dt", "", total[0]), el("dd", "", total[1]));
  ticket.append(list, sum);
  return ticket;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
