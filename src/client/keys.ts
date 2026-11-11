import { t } from "./i18n/i18n";
import { codeLabel, padLabel, type ActionId } from "./input/bindings";

/** Une touche (ou un geste) et son effet, pour l'aide du HUD et l'écran des commandes. */
export type KeyHelp = readonly [key: string, effect: string];

/** Nom de la touche choisie pour une action (« — » s'il n'y en a pas). */
export type KeyNames = (id: ActionId) => string;

/** Les touches de deux actions jumelles : « A · E ». */
const pair = (k: KeyNames, a: ActionId, b: ActionId): string => `${k(a)} · ${k(b)}`;
/** Les touches des quatre directions. */
const moves = (k: KeyNames): string => `${k("forward")} ${k("left")} ${k("back")} ${k("right")}`;
/** La touche Maj (armes au-delà de dix), dans la langue du joueur. */
const shift = (): string => t("key.mod.Shift");

/**
 * Commandes quand on pilote un robot, avec les touches choisies par le joueur (input/bindings.ts) :
 * `k` au clavier et à la souris, `pad` à la manette (ses boutons, ses sticks).
 */
export function pilotKeys(k: KeyNames, pad: KeyNames): KeyHelp[] {
  const lines: KeyHelp[] = [
    [moves(k), t("help.drive")],
    [k("brake"), t("help.brake")],
    [k("boost"), t("help.boost")],
    [pair(k, "climb", "descend"), t("help.climb")],
    [t("help.mouse"), t("help.mouseAim")],
    [k("fire"), t("help.fire")],
    [k("scope"), t("help.scope")],
    [t("help.range", { from: k("weapon1"), to: k("weapon10") }), t("help.weapons", { shift: shift() })],
    [pair(k, "prevWeapon", "nextWeapon"), t("help.cycleWeapons")],
    [pair(k, "yawLeft", "yawRight"), t("help.yaw")],
    [k("detonate"), t("help.detonate", { air: k("detonateAir") })],
    [k("flightMode"), t("help.flightMode")],
    [
      t("help.mousePlane"),
      t("help.mousePlaneKeys", {
        throttle: pair(k, "forward", "back"), boost: k("boost"), cut: k("cutEngine"),
        turn: pair(k, "left", "right"), pitch: pair(k, "climb", "descend"), yaw: pair(k, "yawLeft", "yawRight"),
      }),
    ],
    [
      t("help.manualPlane"),
      t("help.manualPlaneKeys", {
        pitch: pair(k, "climb", "descend"), roll: pair(k, "left", "right"), yaw: pair(k, "yawLeft", "yawRight"),
        throttle: pair(k, "forward", "back"), boost: k("boost"), cut: k("cutEngine"),
      }),
    ],
    [k("flares"), t("help.flares")],
    [t("help.wheel"), t("help.zoom", { drag: t("help.rightDrag", { button: codeLabel("Mouse2") }) })],
    [k("selfDestruct"), t("help.selfDestruct")],
    [k("scoreboard"), t("help.scoreboard")],
    [k("map"), t("help.map")],
    [t("help.pad"), t("help.padPilot", { move: padLabel("StickL"), look: padLabel("StickR"), scope: pad("scope"), fire: pad("fire"), pause: pad("pause") })],
    [t("help.touch"), t("help.touchPilot")],
    [codeLabel("Escape"), t("help.escape")],
  ];
  // Une action sans touche n'a pas sa ligne
  return lines.filter(([key]) => key !== "—" && key !== "— · —");
}

/** Commandes à la caméra libre (arène libre, stand de tir). */
export function freeKeys(k: KeyNames, pad: KeyNames): KeyHelp[] {
  return [
    [codeLabel("Mouse0"), t("help.freeFire")],
    [t("help.rightDrag", { button: codeLabel("Mouse2") }), t("help.turnCamera")],
    [t("help.wheel"), t("help.freeZoom")],
    [moves(k), t("help.moveCamera")],
    [t("help.rangeShift", { from: k("weapon1"), to: k("weapon10"), shift: shift() }), t("help.freeWeapons", { shift: shift() })],
    [k("followNext"), t("help.followNext")],
    [`${k("newWave")} · ${k("freezeAi")} · ${k("slowmo")}`, t("help.freeTools")],
    [`${k("scoreboard")} · ${k("map")}`, t("help.freeBoard")],
    [t("help.pad"), t("help.padFree", { move: padLabel("StickL"), look: padLabel("StickR"), fire: pad("fire") })],
    [t("help.touch"), t("help.touchFree")],
    [codeLabel("Escape"), t("help.pause")],
  ];
}

/** Commandes du garage (l'écran « Commandes ») : ses touches, choisies par le joueur. */
export function garageKeys(k: KeyNames): KeyHelp[] {
  const list = (...ids: ActionId[]): string => ids.map(k).join(" · ");
  return [
    [list("garagePlace", "garageRemove", "garageEyedrop"), t("help.garagePlace")],
    [list("garageSpin", "garageTilt", "garageAutoOrient"), t("help.garageOrient")],
    [list("garageUndo", "garageRedo"), t("help.garageEdit")],
    [list("garageSelect", "garageCopy", "garagePaste", "garageClear"), t("help.garageZone")],
    [list("garageMirror", "garageLayers", "garageLayerUp", "garageLayerDown"), t("help.garageLayers")],
    [`${k("garageSearch")} · ${t("help.range", { from: k("garageRecent1"), to: k("garageRecent9") })}`, t("help.garageInventory")],
  ];
}

/** Commandes de l'éditeur de cartes (son aide, et l'écran « Commandes ») : ses touches, choisies par le joueur. */
export function editorKeys(k: KeyNames): KeyHelp[] {
  const list = (...ids: ActionId[]): string => ids.map(k).join(" · ");
  return [
    [list("editorPick", "editorAddPick"), t("help.editorPick")],
    [list("editorOrbit", "editorPan", "editorTopView", "editorFocus"), t("help.editorView")],
    [list("editorForward", "editorLeft", "editorBack", "editorRight"), t("help.editorMove")],
    [t("help.wheel"), t("help.editorWheel")],
    [list("editorRotate", "editorDuplicate", "editorDelete", "editorSnap"), t("help.editorEdit")],
    [list("editorUndo", "editorRedo", "editorSave"), t("help.editorHistory")],
    [list("editorFinish", "editorRemovePoint"), t("help.editorTrace")],
    [list("editorBrushSmaller", "editorBrushBigger"), t("help.editorBrush")],
    [t("help.range", { from: k("editorToolSelect"), to: k("editorToolFile") }), t("help.editorTools")],
    [list("editorTest", "editorIssues"), t("help.editorTest")],
    [codeLabel("Escape"), t("help.editorEscape")],
  ];
}
