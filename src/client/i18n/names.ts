import { arenaById, isArenaId, type ArenaKey, type ArenaLayout, type ArenaPlace, type CommunityMeta, type PlaceId } from "../../shared/arena/layout";
import type { MapIssue } from "../../shared/map/format";
import type { HeightmapErrorCode } from "../../shared/map/heightmap";
import type { GlbProblem } from "../../shared/media/glb";
import type { OpusProblem } from "../../shared/media/ogg";
import type { BlockType } from "../../shared/catalog/blocks";
import { isMeleeId, type ArmId, type MeleeId } from "../../shared/catalog/melee";
import type { PropType } from "../../shared/catalog/props";
import type { DamageType, KillCause, WeaponId } from "../../shared/catalog/weapons";
import type { WheelType } from "../../shared/catalog/wheels";
import { piecePart, type Clash, type ConflictReason, type ZoneName } from "../../shared/design/clearance";
import { isPresetId, type BotProfile } from "../../shared/design/presets";
import type { Part, RewardLine } from "../../shared/design/progression";
import type { DesignIssue, RobotDesign } from "../../shared/design/robotDesign";
import type { GameModeId } from "../../shared/modes";
import type { Refusal } from "../../shared/net/protocol";
import type { AiMode } from "../../shared/sim/entities";
import { capitalize } from "./format";
import { t, tMaybe } from "./i18n";
import { keyLabel } from "../input/bindings";
import { locale } from "./state";

/*
 * Les noms et les messages de ce qui vient du code partagé, dans la langue affichée : les catalogues
 * n'ont que des identifiants, le serveur n'envoie que des codes ; c'est ici qu'ils deviennent du
 * texte (d'après les rubriques des catalogues de messages : `block.<type>`, `refusal.<code>`…).
 */

export const blockName = (type: BlockType): string => t(`block.${type}`);
export const weaponName = (id: WeaponId): string => t(`weapon.${id}`);
export const meleeName = (id: MeleeId): string => t(`melee.${id}`);
/** Une arme de la barre : de tourelle ou de contact. */
export const armName = (id: ArmId): string => (isMeleeId(id) ? meleeName(id) : weaponName(id));
export const wheelName = (type: WheelType): string => t(`wheel.${type}`);
export const propName = (type: PropType): string => t(`prop.${type}`);
/** Une pièce du garage : un type de bloc ou de roue. */
export const partName = (part: Part): string => (part.kind === "block" ? blockName(part.type) : wheelName(part.type));
/** Une nature de dégâts, en un mot (« balles », « feu »). */
export const damageWord = (type: DamageType): string => t(`damage.${type}`);

/**
 * Ce qu'une personne a écrit, dans la langue affichée s'il l'a écrit dans celle-ci (un nom de carte,
 * de lieu), sinon tel quel.
 */
export const authored = (text: string, byLanguage?: Readonly<Record<string, string>>): string => byLanguage?.[locale()] ?? text;

/**
 * Nom d'une arène (son identifiant, ou l'arène elle-même : une carte reçue d'un serveur n'est connue
 * que de la réplique) : celui d'une arène du jeu dans la langue affichée, ou celui que l'auteur d'une
 * carte communautaire lui a donné.
 */
export function arenaName(arena: ArenaKey | ArenaLayout): string {
  const id = typeof arena === "string" ? arena : arena.id;
  if (isArenaId(id)) return t(`arena.${id}`);
  const meta = typeof arena === "string" ? arenaById(arena)?.community : arena.community;
  return meta ? authored(meta.name, meta.names) : id;
}

/** La phrase d'une arène pour le menu ; pour une carte communautaire, sa description et son auteur. */
export function arenaInfo(id: ArenaKey): string {
  if (isArenaId(id)) return t(`arenaInfo.${id}`);
  const meta = arenaById(id)?.community;
  return meta ? communityInfo(meta) : "";
}

/** « Par Untel · description » d'une carte communautaire. */
export function communityInfo(meta: CommunityMeta): string {
  const by = t("maps.by", { author: meta.author });
  const description = meta.description && authored(meta.description, meta.descriptions);
  return description ? `${by} · ${description}` : by;
}

export const placeName = (id: PlaceId): string => t(`place.${id}`);
/** Nom d'un lieu de la carte : traduit pour une arène du jeu, celui de l'auteur pour une carte communautaire. */
export const placeLabel = (p: ArenaPlace): string => ("place" in p ? placeName(p.place) : authored(p.name, p.names));

/** Pourquoi une carte est refusée, en une ligne. */
export function mapIssueText(issue: MapIssue): string {
  switch (issue.code) {
    case "json": return t("mapIssue.json");
    case "tooLarge": return t("mapIssue.tooLarge", { size: issue.size, max: issue.max });
    case "format": return t("mapIssue.format");
    case "formatTooNew": return t("mapIssue.formatTooNew", { version: issue.version });
    case "field": return t("mapIssue.field", { path: issue.path });
    case "text": return t("mapIssue.text", { path: issue.path, max: issue.max });
    case "tooMany": return t("mapIssue.tooMany", { what: t(`mapCounted.${issue.what}`), count: issue.count, max: issue.max });
    case "terrainSize": return t("mapIssue.terrainSize", { cells: issue.cells, step: issue.step });
    case "terrainData": return t("mapIssue.terrainData");
    case "terrainSmall": return t("mapIssue.terrainSmall", { side: issue.side, need: issue.need });
    case "outside": return t("mapIssue.outside", { path: issue.path });
    case "bounds": return t("mapIssue.bounds", { path: issue.path });
    case "zones": return t("mapIssue.zones");
    case "zoneUnreachable": return t("mapIssue.zoneUnreachable", { zone: issue.zone });
    case "spawnBlocked": return t("mapIssue.spawnBlocked", { team: t(`team.${issue.team}`) });
    case "spawnHazard": return t("mapIssue.spawnHazard", { team: t(`team.${issue.team}`) });
    case "spawnOutside": return t("mapIssue.spawnOutside", { team: t(`team.${issue.team}`) });
    case "spawnClose": return t("mapIssue.spawnClose", { distance: issue.distance, min: issue.min });
    case "archive": return t("mapIssue.archive");
    case "packagePath": return t("mapIssue.packagePath", { path: issue.path });
    case "packageMap": return t("mapIssue.packageMap");
    case "assetSize": return t("mapIssue.assetSize", { path: issue.path, size: issue.size, max: issue.max });
    case "assetName": return t("mapIssue.assetName", { path: issue.path });
    case "assetModel": return t("mapIssue.assetModel", { path: issue.path, why: glbProblemText(issue.problem) });
    case "assetSound": return t("mapIssue.assetSound", { path: issue.path, why: opusProblemText(issue.problem) });
  }
}

/** Ce qui ne va pas dans un modèle glTF d'un paquet de carte. */
export function glbProblemText(problem: GlbProblem): string {
  switch (problem.code) {
    case "short": return t("glbProblem.short");
    case "magic": return t("glbProblem.magic");
    case "container": return t("glbProblem.container", { version: problem.version });
    case "length": return t("glbProblem.length", { declared: problem.declared, actual: problem.actual });
    case "jsonChunk": return t("glbProblem.jsonChunk");
    case "json": return t("glbProblem.json");
    case "version": return t("glbProblem.version", { version: problem.version });
    case "externalBuffer": return t("glbProblem.externalBuffer");
    case "bufferSize": return t("glbProblem.bufferSize", { buffer: problem.buffer, bin: problem.bin });
    case "externalImage": return t("glbProblem.externalImage");
    case "noMesh": return t("glbProblem.noMesh");
    case "extensions": return t("glbProblem.extensions", { list: problem.list.join(", ") });
  }
}

/** Ce qui ne va pas dans l'ambiance d'un paquet de carte. */
export function opusProblemText(problem: OpusProblem): string {
  switch (problem.code) {
    case "format": return t("opusProblem.format");
    case "channels": return t("opusProblem.channels", { channels: problem.channels });
    case "duration": return t("opusProblem.duration", { seconds: problem.seconds, min: problem.min, max: problem.max });
  }
}

/** Pourquoi une image ne fait pas un relief. */
export const heightmapErrorText = (code: HeightmapErrorCode): string => t(`heightmap.${code}`);
export const modeName = (id: GameModeId): string => t(`mode.${id}`);
export const modeInfo = (id: GameModeId): string => t(`modeInfo.${id}`);
export const aiModeName = (mode: AiMode): string => t(`aiMode.${mode}`);

/** Cause d'une destruction, en minuscules (fil des destructions) : l'arme, ou ce qui l'a causée. */
export function causeName(cause: KillCause): string {
  return isMeleeId(cause) || isWeaponCause(cause) ? armName(cause).toLocaleLowerCase(locale()) : t(`cause.${cause}`);
}
const OTHER_CAUSES = new Set<string>(["impact", "fire", "blast", "self", "lava", "drown", "exhaust"]);
const isWeaponCause = (cause: KillCause): cause is WeaponId => !OTHER_CAUSES.has(cause);

/**
 * Nom d'un robot : celui qu'une personne lui a donné (robot du garage, joueur en multijoueur), sinon
 * celui du robot prédéfini dans la langue affichée.
 */
export function botName(profile: Pick<BotProfile, "id" | "name">): string {
  if (profile.name) return profile.name;
  return isPresetId(profile.id) ? t(`bot.${profile.id}`) : profile.id;
}

/** Courte description d'un robot : celle du robot prédéfini (qui peut citer la touche du boost, `{boost}`), ou « construit au garage ». */
export function botTrait(profile: Pick<BotProfile, "id">): string {
  return isPresetId(profile.id) ? tMaybe(`botTrait.${profile.id}`, { boost: keyLabel("boost") }) ?? profile.id : t("botTrait.garage");
}

/** Un défaut d'un plan (`validateDesign`), en une ligne. */
export function designIssueText(issue: DesignIssue): string {
  switch (issue.code) {
    case "cockpits":
    case "detached":
      return t(`designIssue.${issue.code}`, { n: issue.n });
    case "unknownBlock":
    case "unknownWheel":
      return t(`designIssue.${issue.code}`, { at: issue.at, type: issue.type });
    case "wheelsOverlap":
      return t("designIssue.wheelsOverlap", { at: issue.at, other: issue.other });
    case "overBudget":
      return t("designIssue.overBudget", { cost: issue.cost, budget: issue.budget });
    default:
      return t(`designIssue.${issue.code}`, { at: issue.at });
  }
}

/** Ce que réserve une pièce au-delà de sa case (« le canon »). */
export const zonePartName = (zone: ZoneName): string => t(`zonePart.${zone.part}`);
/** Le nombre qui accorde une phrase à une zone : 2 si elle est faite de plusieurs pièces (« les mâchoires »). */
const zoneCount = (zone: ZoneName): number => (zone.plural ? 2 : 1);
/** Nom d'une pièce d'un conflit (son type), ou « pièce » si on ne le connaît pas. */
const pieceName = (part: Part | null): string => (part ? partName(part) : t("conflict.piece"));

/** Pourquoi une pièce qu'on pose gêne, en une ligne (« Gêne le canon (Tourelle mitrailleuse) »). */
export function conflictText(reason: ConflictReason): string {
  const other = pieceName(reason.other);
  switch (reason.code) {
    case "occupied":
      return t("conflict.occupied", { other });
    case "overlapsWheel":
      return t("conflict.overlapsWheel", { other });
    case "blocks":
      return t("conflict.blocks", { zone: zonePartName(reason.zone), other });
    case "enters":
      return t("conflict.enters", { n: zoneCount(reason.zone), Zone: capitalize(zonePartName(reason.zone)), other });
    case "hits":
      return t("conflict.hits", { n: zoneCount(reason.zone), Zone: capitalize(zonePartName(reason.zone)), otherZone: zonePartName(reason.otherZone), other });
  }
}

/** Une paire de pièces d'un plan qui se gênent, en une ligne (le garage les liste). */
export function conflictLine(design: RobotDesign, clash: Clash): string {
  const piece = (key: string): string => {
    const name = pieceName(piecePart(design, key));
    return key.startsWith("b:") ? t("conflictLine.piece", { name, at: key.slice(2) }) : name;
  };
  const [a, b] = [piece(clash.a), piece(clash.b)];
  if (clash.wheels) return t("conflictLine.wheels", { a, b });
  if (!clash.zone) return t("conflictLine.blocks", { a, b, otherZone: zonePartName(clash.other!) });
  const Zone = capitalize(zonePartName(clash.zone));
  return clash.other ? t("conflictLine.zones", { Zone, a, b, otherZone: zonePartName(clash.other) }) : t("conflictLine.zone", { Zone, a, b });
}

/** Pourquoi le serveur refuse le joueur, en une phrase. */
export function refusalText(refusal: Refusal): string {
  if (refusal.code === "locked") {
    return t("refusal.locked", { parts: refusal.parts.map(partName).join(", "), price: refusal.price, credits: refusal.credits });
  }
  return t(`refusal.${refusal.code}`);
}

/** Une ligne du détail des crédits d'une partie (« 2 destructions »). */
export const rewardLineText = (line: RewardLine): string => t(`reward.${line.kind}`, { n: line.n });
