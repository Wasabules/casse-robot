import type { ActionId } from "../input/bindings";

/*
 * Les outils de l'éditeur de cartes, dans l'ordre de leur barre, et la touche qui choisit chacun
 * (la table des actions, input/bindings.ts). Un outil de plus : une entrée ici, son action
 * (`editorTool<Nom>`), son nom et son aide dans chaque langue (`editor.tool.<id>`,
 * `editor.toolHint.<id>`), et son panneau (editor/editorUi.ts).
 */

export type ToolId = "select" | "terrain" | "place" | "trace" | "water" | "settings" | "file";

export const TOOLS: readonly ToolId[] = ["select", "terrain", "place", "trace", "water", "settings", "file"];

export const TOOL_ACTIONS: Readonly<Record<ToolId, ActionId>> = {
  select: "editorToolSelect",
  terrain: "editorToolTerrain",
  place: "editorToolPlace",
  trace: "editorToolTrace",
  water: "editorToolWater",
  settings: "editorToolSettings",
  file: "editorToolFile",
};
