/*
 * Touches du jeu : la table des actions (ce qu'on peut faire, à quel moment, et ses touches par
 * défaut), les touches choisies par le joueur (`Bindings`, gardées dans les réglages), leurs
 * conflits et leurs noms à l'écran. Logique pure (ni DOM ni navigateur) : tests/bindings.test.ts.
 *
 * Une touche se désigne par un code :
 * - clavier : sa position physique (`KeyboardEvent.code`) : "KeyW" est la touche Z d'un clavier
 *   AZERTY, W d'un QWERTY ; le nom affiché suit le clavier du joueur (`codeLabel`) ;
 * - souris : "Mouse0" (gauche), "Mouse1" (milieu), "Mouse2" (droit), "Mouse3" et "Mouse4" (boutons
 *   latéraux), et la molette, "WheelUp" et "WheelDown" (pour une action d'un coup seulement) ;
 * - manette, disposition standard de la Gamepad API : "Pad0" (A, ✕) à "Pad16" (bouton central) ;
 * - au garage et dans l'éditeur de cartes seulement, une combinaison : des touches de modification puis une touche ou un bouton,
 *   dans cet ordre, "Control+KeyZ", "Shift+KeyR", "Control+Shift+KeyZ", "Shift+Mouse0" (`chordCode`).
 *   Une combinaison avec Ctrl sur une lettre suit la lettre tapée, comme dans toutes les applications
 *   (Ctrl+Z annule sur un clavier AZERTY comme QWERTY : `eventChords`) ; le reste, la position.
 *
 * Chaque action vaut à un moment du jeu (`InputContext`) : au sol, en vol, en pilotant, à la caméra
 * libre, ou toujours (en partie) ; au garage, les siennes. Deux actions peuvent partager une touche
 * si elles ne valent jamais en même temps : Espace freine au sol et fait monter en vol.
 *
 * Les libellés (actions, rubriques, noms des touches qui n'écrivent rien, boutons de la manette)
 * sont dans chaque langue : i18n/locales/<langue>/keys.ts.
 */
import { t, tMaybe } from "../i18n/i18n";

/**
 * Moment où une action vaut : toujours en partie, en pilotant (au sol ou en vol), au sol, en vol
 * (robot volant, avion), à la caméra libre ; ou au garage (l'éditeur de robots, hors de la partie),
 * ou dans l'éditeur de cartes (hors de la partie aussi).
 */
export type InputContext = "any" | "pilot" | "ground" | "flight" | "free" | "garage" | "editor";

/** Rubriques de l'écran des touches, dans l'ordre (leur titre : `keyCategory.<id>` des catalogues de messages). */
export const ACTION_CATEGORIES = ["ground", "flight", "weapons", "interface", "free", "garage", "editor"] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

/** Deux touches (clavier ou souris) au plus par action : la principale, et une autre. */
export type KeyPair = readonly [string | null, string | null];

/**
 * Une action. Son libellé est dans chaque langue (`action.<id>`), et sa précision, si elle en a une,
 * sous le libellé (`actionDetail.<id>`) : `actionLabel`, `actionDetail`.
 */
export interface ActionDef {
  readonly category: ActionCategory;
  readonly context: InputContext;
  /** Action qu'on tient (avancer, tirer) ; sinon, d'un coup (changer d'arme). La molette ne sert qu'aux secondes. */
  readonly hold?: boolean;
  /** Touches par défaut (clavier, souris). */
  readonly keys: KeyPair;
  /** Bouton par défaut de la manette. */
  readonly pad: string | null;
  /** Touche fixe, qui ne se change pas (Échap : la pause) ; les cases du clavier ne s'éditent pas. */
  readonly fixedKey?: string;
  /** Commande fixe de la manette (un stick, le bouton Menu) ; sa case ne s'édite pas. */
  readonly fixedPad?: string;
}

const hold = true;

/** Toutes les actions qu'on peut attribuer à une touche. */
export const ACTIONS = {
  // --- Au sol (et déplacement en général) ---
  forward: { category: "ground", context: "any", hold, keys: ["KeyW", "ArrowUp"], pad: null, fixedPad: "StickLUp" },
  back: { category: "ground", context: "any", hold, keys: ["KeyS", "ArrowDown"], pad: null, fixedPad: "StickLDown" },
  left: { category: "ground", context: "any", hold, keys: ["KeyA", "ArrowLeft"], pad: null, fixedPad: "StickLLeft" },
  right: { category: "ground", context: "any", hold, keys: ["KeyD", "ArrowRight"], pad: null, fixedPad: "StickLRight" },
  boost: { category: "ground", context: "pilot", hold, keys: ["ShiftLeft", "ShiftRight"], pad: "Pad10" },
  brake: { category: "ground", context: "ground", hold, keys: ["Space", null], pad: "Pad0" },
  // --- En vol ---
  climb: { category: "flight", context: "flight", hold, keys: ["Space", null], pad: "Pad0" },
  // (pas Ctrl : tenue en vol, avec la touche des gaz, elle faisait Ctrl+W, qui ferme l'onglet)
  descend: { category: "flight", context: "flight", hold, keys: ["KeyC", null], pad: "Pad1" },
  yawLeft: { category: "flight", context: "flight", hold, keys: ["KeyQ", null], pad: "Pad14" },
  yawRight: { category: "flight", context: "flight", hold, keys: ["KeyE", null], pad: "Pad15" },
  flightMode: { category: "flight", context: "flight", keys: ["KeyV", null], pad: "Pad13" },
  cutEngine: { category: "flight", context: "flight", keys: ["KeyX", null], pad: "Pad11" },
  // --- Armes ---
  fire: { category: "weapons", context: "any", hold, keys: ["Mouse0", null], pad: "Pad7" },
  scope: { category: "weapons", context: "pilot", hold, keys: ["Mouse2", null], pad: "Pad6" },
  weapon1: { category: "weapons", context: "any", keys: ["Digit1", "Numpad1"], pad: null },
  weapon2: { category: "weapons", context: "any", keys: ["Digit2", "Numpad2"], pad: null },
  weapon3: { category: "weapons", context: "any", keys: ["Digit3", "Numpad3"], pad: null },
  weapon4: { category: "weapons", context: "any", keys: ["Digit4", "Numpad4"], pad: null },
  weapon5: { category: "weapons", context: "any", keys: ["Digit5", "Numpad5"], pad: null },
  weapon6: { category: "weapons", context: "any", keys: ["Digit6", "Numpad6"], pad: null },
  weapon7: { category: "weapons", context: "any", keys: ["Digit7", "Numpad7"], pad: null },
  weapon8: { category: "weapons", context: "any", keys: ["Digit8", "Numpad8"], pad: null },
  weapon9: { category: "weapons", context: "any", keys: ["Digit9", "Numpad9"], pad: null },
  weapon10: { category: "weapons", context: "any", keys: ["Digit0", "Numpad0"], pad: null },
  nextWeapon: { category: "weapons", context: "any", keys: [null, null], pad: "Pad5" },
  prevWeapon: { category: "weapons", context: "any", keys: [null, null], pad: "Pad4" },
  flares: { category: "weapons", context: "pilot", hold, keys: ["KeyF", null], pad: "Pad2" },
  detonate: { category: "weapons", context: "ground", hold, keys: ["KeyE", null], pad: "Pad3" },
  detonateAir: { category: "weapons", context: "flight", hold, keys: ["KeyG", null], pad: "Pad3" },
  // --- Interface ---
  scoreboard: { category: "interface", context: "any", keys: ["Tab", null], pad: "Pad8" },
  // M : la position du M d'un clavier QWERTY (« , » en AZERTY), et celle du M d'un AZERTY (« ; » en QWERTY)
  map: { category: "interface", context: "any", keys: ["KeyM", "Semicolon"], pad: "Pad12" },
  selfDestruct: { category: "interface", context: "pilot", keys: ["Backspace", null], pad: null },
  pause: { category: "interface", context: "any", keys: [null, null], pad: null, fixedKey: "Escape", fixedPad: "Pad9" },
  // --- Caméra libre ---
  followNext: { category: "free", context: "free", keys: ["KeyF", null], pad: "Pad3" },
  newWave: { category: "free", context: "free", keys: ["KeyR", null], pad: null },
  freezeAi: { category: "free", context: "free", keys: ["KeyP", null], pad: null },
  slowmo: { category: "free", context: "free", keys: ["KeyT", null], pad: null },
  // --- Garage (pas de manette ; des combinaisons) ---
  garagePlace: { category: "garage", context: "garage", keys: ["Mouse0", null], pad: null },
  garageRemove: { category: "garage", context: "garage", keys: ["Mouse2", null], pad: null },
  garageEyedrop: { category: "garage", context: "garage", keys: ["Mouse1", null], pad: null },
  garageSelect: { category: "garage", context: "garage", keys: ["Shift+Mouse0", null], pad: null },
  garageSpin: { category: "garage", context: "garage", keys: ["KeyR", null], pad: null },
  garageTilt: { category: "garage", context: "garage", keys: ["Shift+KeyR", null], pad: null },
  garageAutoOrient: { category: "garage", context: "garage", keys: ["KeyO", null], pad: null },
  // M : sa position en QWERTY, et celle du M d'un AZERTY (comme la carte)
  garageMirror: { category: "garage", context: "garage", keys: ["KeyM", "Semicolon"], pad: null },
  garageLayers: { category: "garage", context: "garage", keys: ["KeyL", null], pad: null },
  garageLayerUp: { category: "garage", context: "garage", keys: ["PageUp", null], pad: null },
  garageLayerDown: { category: "garage", context: "garage", keys: ["PageDown", null], pad: null },
  garageCopy: { category: "garage", context: "garage", keys: ["Control+KeyC", null], pad: null },
  garagePaste: { category: "garage", context: "garage", keys: ["Control+KeyV", null], pad: null },
  garageUndo: { category: "garage", context: "garage", keys: ["Control+KeyZ", null], pad: null },
  garageRedo: { category: "garage", context: "garage", keys: ["Control+KeyY", "Control+Shift+KeyZ"], pad: null },
  garageClear: { category: "garage", context: "garage", keys: ["Delete", "Backspace"], pad: null },
  garageSearch: { category: "garage", context: "garage", keys: ["Slash", "NumpadDivide"], pad: null },
  garageRecent1: { category: "garage", context: "garage", keys: ["Digit1", "Numpad1"], pad: null },
  garageRecent2: { category: "garage", context: "garage", keys: ["Digit2", "Numpad2"], pad: null },
  garageRecent3: { category: "garage", context: "garage", keys: ["Digit3", "Numpad3"], pad: null },
  garageRecent4: { category: "garage", context: "garage", keys: ["Digit4", "Numpad4"], pad: null },
  garageRecent5: { category: "garage", context: "garage", keys: ["Digit5", "Numpad5"], pad: null },
  garageRecent6: { category: "garage", context: "garage", keys: ["Digit6", "Numpad6"], pad: null },
  garageRecent7: { category: "garage", context: "garage", keys: ["Digit7", "Numpad7"], pad: null },
  garageRecent8: { category: "garage", context: "garage", keys: ["Digit8", "Numpad8"], pad: null },
  garageRecent9: { category: "garage", context: "garage", keys: ["Digit9", "Numpad9"], pad: null },
  // --- Éditeur de cartes (pas de manette ; des combinaisons, comme au garage) ---
  editorPick: { category: "editor", context: "editor", keys: ["Mouse0", null], pad: null },
  editorAddPick: { category: "editor", context: "editor", keys: ["Shift+Mouse0", "Control+Mouse0"], pad: null },
  editorOrbit: { category: "editor", context: "editor", hold, keys: ["Mouse2", null], pad: null },
  editorPan: { category: "editor", context: "editor", hold, keys: ["Mouse1", "Shift+Mouse2"], pad: null },
  editorForward: { category: "editor", context: "editor", hold, keys: ["KeyW", "ArrowUp"], pad: null },
  editorBack: { category: "editor", context: "editor", hold, keys: ["KeyS", "ArrowDown"], pad: null },
  editorLeft: { category: "editor", context: "editor", hold, keys: ["KeyA", "ArrowLeft"], pad: null },
  editorRight: { category: "editor", context: "editor", hold, keys: ["KeyD", "ArrowRight"], pad: null },
  editorTopView: { category: "editor", context: "editor", keys: ["KeyT", null], pad: null },
  editorFocus: { category: "editor", context: "editor", keys: ["KeyF", null], pad: null },
  editorRotate: { category: "editor", context: "editor", keys: ["KeyR", null], pad: null },
  editorRotateBack: { category: "editor", context: "editor", keys: ["Shift+KeyR", null], pad: null },
  editorSnap: { category: "editor", context: "editor", keys: ["KeyG", null], pad: null },
  editorDuplicate: { category: "editor", context: "editor", keys: ["Control+KeyD", null], pad: null },
  editorDelete: { category: "editor", context: "editor", keys: ["Delete", null], pad: null },
  editorUndo: { category: "editor", context: "editor", keys: ["Control+KeyZ", null], pad: null },
  editorRedo: { category: "editor", context: "editor", keys: ["Control+KeyY", "Control+Shift+KeyZ"], pad: null },
  editorSave: { category: "editor", context: "editor", keys: ["Control+KeyS", null], pad: null },
  editorTest: { category: "editor", context: "editor", keys: ["KeyP", null], pad: null },
  editorFinish: { category: "editor", context: "editor", keys: ["Enter", "NumpadEnter"], pad: null },
  editorRemovePoint: { category: "editor", context: "editor", keys: ["Backspace", null], pad: null },
  editorBrushSmaller: { category: "editor", context: "editor", keys: ["BracketLeft", "NumpadSubtract"], pad: null },
  editorBrushBigger: { category: "editor", context: "editor", keys: ["BracketRight", "NumpadAdd"], pad: null },
  editorIssues: { category: "editor", context: "editor", keys: ["KeyI", null], pad: null },
  editorSearch: { category: "editor", context: "editor", keys: ["Slash", "NumpadDivide"], pad: null },
  editorToolSelect: { category: "editor", context: "editor", keys: ["Digit1", "Numpad1"], pad: null },
  editorToolTerrain: { category: "editor", context: "editor", keys: ["Digit2", "Numpad2"], pad: null },
  editorToolPlace: { category: "editor", context: "editor", keys: ["Digit3", "Numpad3"], pad: null },
  editorToolTrace: { category: "editor", context: "editor", keys: ["Digit4", "Numpad4"], pad: null },
  editorToolWater: { category: "editor", context: "editor", keys: ["Digit5", "Numpad5"], pad: null },
  editorToolSettings: { category: "editor", context: "editor", keys: ["Digit6", "Numpad6"], pad: null },
  editorToolFile: { category: "editor", context: "editor", keys: ["Digit7", "Numpad7"], pad: null },
} as const satisfies Record<string, ActionDef>;

export type ActionId = keyof typeof ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[];
/** Définition d'une action, typée largement (les littéraux de la table ne servent qu'à ses identifiants). */
export const actionDef = (id: ActionId): ActionDef => ACTIONS[id];
/** Libellé d'une action, dans la langue affichée. */
export const actionLabel = (id: ActionId): string => t(`action.${id}`);
/** Précision d'une action, sous son libellé (toutes n'en ont pas) ; elle peut citer la touche Maj (`{shift}`). */
export const actionDetail = (id: ActionId): string | undefined => tMaybe(`actionDetail.${id}`, { shift: t("key.mod.Shift") });
/** Titre d'une rubrique de l'écran des touches. */
export const categoryLabel = (category: ActionCategory): string => t(`keyCategory.${category}`);
/** Les dix actions de choix d'arme, dans l'ordre des emplacements. */
export const WEAPON_SLOTS = ["weapon1", "weapon2", "weapon3", "weapon4", "weapon5", "weapon6", "weapon7", "weapon8", "weapon9", "weapon10"] as const satisfies readonly ActionId[];
/** Les neuf pièces récentes du garage, dans l'ordre. */
export const RECENT_SLOTS = [
  "garageRecent1", "garageRecent2", "garageRecent3", "garageRecent4", "garageRecent5", "garageRecent6", "garageRecent7", "garageRecent8", "garageRecent9",
] as const satisfies readonly ActionId[];
/** Les actions du garage : sans manette, et leurs touches peuvent être des combinaisons (Ctrl+Z). */
export const isGarageAction = (id: ActionId): boolean => actionDef(id).context === "garage";
/** Les actions de l'éditeur de cartes : de même. */
export const isEditorAction = (id: ActionId): boolean => actionDef(id).context === "editor";
/** Une action hors de la partie (garage, éditeur de cartes) : sans manette, des combinaisons permises. */
export const isToolAction = (id: ActionId): boolean => isGarageAction(id) || isEditorAction(id);

/** Les touches d'une action : deux au clavier (ou à la souris), une à la manette. */
export interface Binding {
  readonly keys: KeyPair;
  readonly pad: string | null;
}
export type Bindings = Readonly<Record<ActionId, Binding>>;
/** Une case de l'écran des touches : la première ou la seconde touche, ou le bouton de la manette. */
export type Slot = 0 | 1 | "pad";

export const DEFAULT_BINDINGS: Bindings = Object.freeze(
  Object.fromEntries(ACTION_IDS.map((id) => [id, Object.freeze({ keys: ACTIONS[id].keys, pad: ACTIONS[id].pad })])) as Record<ActionId, Binding>,
);

/** Touches qu'on ne peut pas attribuer : Échap (pause, annuler), les touches du système. */
const RESERVED_KEYS = new Set(["Escape", "MetaLeft", "MetaRight", "OSLeft", "OSRight", "ContextMenu"]);
/** Bouton Menu (Start) : la pause, fixe. */
const RESERVED_PAD = new Set(["Pad9"]);
/** Nombre de boutons de la disposition standard. */
const PAD_BUTTONS = 17;

/** Touches de modification d'une combinaison, dans l'ordre où elles s'écrivent (`key.mod.<nom>` : leur nom). */
export const MODIFIERS = ["Control", "Shift", "Alt"] as const;
export type Modifier = (typeof MODIFIERS)[number];
/** Les touches de modification elles-mêmes : seules, ce sont des touches comme les autres (le boost : Maj). */
const MODIFIER_KEYS = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);
export const isModifierKey = (code: string): boolean => MODIFIER_KEYS.has(code);

/** Une combinaison (« Control+KeyZ ») : ses touches de modification, et sa touche. */
export function splitChord(code: string): { mods: string[]; base: string } {
  const parts = code.split("+");
  const base = parts.pop() ?? "";
  return { mods: parts, base };
}

/** Code d'une touche, d'un bouton de la souris ou de la molette, sans modification. */
function isPlainKey(code: string): boolean {
  if (/^(Pad\d|Stick)/.test(code)) return false;
  return /^Mouse[0-4]$/.test(code) || code === "WheelUp" || code === "WheelDown" || /^[A-Z][A-Za-z0-9]{1,30}$/.test(code);
}

/**
 * Code d'une touche du clavier, d'un bouton de la souris ou de la molette ; ou une combinaison :
 * des touches de modification, chacune une fois et dans l'ordre de `MODIFIERS`, puis une touche ou
 * un bouton qui n'en est pas une (pas la molette).
 */
export function isKeyCode(code: unknown): code is string {
  if (typeof code !== "string") return false;
  const { mods, base } = splitChord(code);
  if (!isPlainKey(base)) return false;
  if (!mods.length) return true;
  const order = mods.map((m) => (MODIFIERS as readonly string[]).indexOf(m));
  if (order.some((o, i) => o < 0 || (i > 0 && o <= order[i - 1]))) return false;
  return !isModifierKey(base) && !isWheel(base);
}

/** Une combinaison ? */
export const isChord = (code: string): boolean => code.includes("+");

/** Touches de modification tenues pendant un appui (Cmd d'un Mac compte comme Ctrl). */
export interface HeldModifiers {
  readonly ctrlKey: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Le code de cette touche (ou de ce bouton) avec les modifications tenues ; une modification seule reste elle-même. */
export function chordCode(base: string, held: HeldModifiers): string {
  if (isModifierKey(base) || isWheel(base)) return base;
  const mods = [(held.ctrlKey || held.metaKey) && "Control", held.shiftKey && "Shift", held.altKey && "Alt"].filter((m): m is Modifier => !!m);
  return [...mods, base].join("+");
}

/**
 * Les codes qu'un appui du clavier peut porter au garage, du plus probable au moins probable : avec
 * Ctrl, une lettre se lit d'abord comme celle qu'elle tape (Ctrl+Z, sur un AZERTY, est la touche
 * marquée Z, à la position du W d'un QWERTY), puis par sa position ; sinon, par sa position.
 */
export function eventChords(e: HeldModifiers & { readonly code: string; readonly key: string }): string[] {
  const byPlace = chordCode(e.code, e);
  const letter = e.key.length === 1 ? e.key.toUpperCase() : "";
  if ((e.ctrlKey || e.metaKey) && /^[A-Z]$/.test(letter) && `Key${letter}` !== e.code) return [chordCode(`Key${letter}`, e), byPlace];
  return [byPlace];
}

/** Code d'un bouton de la manette. */
export function isPadCode(code: unknown): code is string {
  const m = typeof code === "string" ? /^Pad(\d{1,2})$/.exec(code) : null;
  return !!m && Number(m[1]) < PAD_BUTTONS;
}

const isWheel = (code: string): boolean => code === "WheelUp" || code === "WheelDown";

/** Cette case de cette action se change-t-elle (pas les touches fixes : la pause, les sticks ; pas de manette au garage) ? */
export function isEditable(id: ActionId, slot: Slot): boolean {
  const def = actionDef(id);
  return slot === "pad" ? !def.fixedPad && !isToolAction(id) : !def.fixedKey;
}

/** Ce code convient-il à cette action (une combinaison, seulement au garage) ? */
const fitsAction = (id: ActionId, code: string): boolean => !isChord(code) || isToolAction(id);

/** Deux moments du jeu peuvent-ils valoir en même temps ? (Le garage et l'éditeur de cartes ne sont jamais la partie, ni l'un l'autre.) */
export function contextsOverlap(a: InputContext, b: InputContext): boolean {
  if (a === "garage" || b === "garage" || a === "editor" || b === "editor") return a === b;
  if (a === "any" || b === "any" || a === b) return true;
  const piloting = (c: InputContext): boolean => c === "pilot" || c === "ground" || c === "flight";
  if (a === "pilot") return piloting(b);
  if (b === "pilot") return piloting(a);
  // Au sol et en vol, en pilotant et à la caméra libre : jamais ensemble
  return false;
}

/** Le code d'une case (null : aucune touche). */
export function slotCode(b: Binding, slot: Slot): string | null {
  return slot === "pad" ? b.pad : b.keys[slot];
}

function withSlot(b: Binding, slot: Slot, code: string | null): Binding {
  if (slot === "pad") return { keys: b.keys, pad: code };
  return { keys: slot === 0 ? [code, b.keys[1]] : [b.keys[0], code], pad: b.pad };
}

/** Cases de la même sorte (clavier et souris, ou manette) qu'une case. */
const sameDevice = (slot: Slot): readonly Slot[] => (slot === "pad" ? ["pad"] : [0, 1]);

/**
 * Touches lues depuis les réglages enregistrés (n'importe quoi : une version précédente, un
 * stockage abîmé) : chaque case reprend sa touche par défaut si elle est absente ou n'est pas un
 * code valable (null, enregistré, veut dire « aucune touche ») ; les cases fixes gardent la leur.
 */
export function parseBindings(raw: unknown): Bindings {
  const saved = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<ActionId, Binding>;
  for (const id of ACTION_IDS) {
    const def = actionDef(id);
    const entry = saved[id] && typeof saved[id] === "object" ? (saved[id] as Record<string, unknown>) : null;
    const read = (v: unknown, fallback: string | null, valid: (c: unknown) => c is string, reserved: Set<string>): string | null => {
      if (v === null) return null;
      if (!valid(v) || reserved.has(v) || !fitsAction(id, v)) return fallback;
      // La molette ne se tient pas : pas pour une action qu'on maintient
      return def.hold && isWheel(v) ? fallback : v;
    };
    const keys = entry && Array.isArray(entry.keys) && entry.keys.length === 2 && !def.fixedKey
      ? [read(entry.keys[0], def.keys[0], isKeyCode, RESERVED_KEYS), read(entry.keys[1], def.keys[1], isKeyCode, RESERVED_KEYS)] as const
      : def.keys;
    const pad = entry && "pad" in entry && isEditable(id, "pad") ? read(entry.pad, def.pad, isPadCode, RESERVED_PAD) : def.pad;
    // Deux fois la même touche dans une action : une suffit
    out[id] = { keys: keys[0] !== null && keys[0] === keys[1] ? [keys[0], null] : keys, pad };
  }
  return out;
}

/**
 * Version de la table des touches : elle augmente quand des touches par défaut changent ; les
 * réglages enregistrés portent la leur (`Settings.bindingsVersion`), voir `migrateBindings`.
 */
export const BINDINGS_VERSION = 2;
/**
 * Les touches par défaut d'avant chaque version, pour les actions où elles ont changé. Version 2 :
 * Ctrl ne fait plus descendre (en vol, Ctrl tenu, la touche des gaz devenait Ctrl+W, et le
 * navigateur fermait l'onglet).
 */
const FORMER_DEFAULTS: Readonly<Record<number, Partial<Record<ActionId, Binding>>>> = {
  1: { descend: { keys: ["KeyC", "ControlLeft"], pad: "Pad1" } },
};

/**
 * Touches enregistrées avec une version précédente de la table : une action dont le joueur avait
 * gardé les touches par défaut (au clavier et à la souris, ou à la manette) prend les nouvelles ;
 * celles qu'il avait changées restent les siennes. Une nouvelle touche par défaut déjà prise par une
 * autre de ses actions au même moment reste à celle-ci (la case reste vide). Lecture tolérante
 * d'abord (`parseBindings`).
 */
export function migrateBindings(raw: unknown, version: number): Bindings {
  let b = parseBindings(raw);
  if (!(version < BINDINGS_VERSION) || !raw || typeof raw !== "object") return b;
  // Les cases reprises, par action (au clavier : les deux ; à la manette : la sienne)
  const changed = new Map<ActionId, Slot[]>();
  for (let v = Math.max(1, Math.floor(version)); v < BINDINGS_VERSION; v++) {
    for (const [id, former] of Object.entries(FORMER_DEFAULTS[v] ?? {}) as [ActionId, Binding][]) {
      const now = b[id];
      const keys = now.keys[0] === former.keys[0] && now.keys[1] === former.keys[1];
      const pad = now.pad === former.pad;
      if (!keys && !pad) continue;
      b = { ...b, [id]: { keys: keys ? DEFAULT_BINDINGS[id].keys : now.keys, pad: pad ? DEFAULT_BINDINGS[id].pad : now.pad } };
      changed.set(id, [...(changed.get(id) ?? []), ...(keys ? [0, 1] as const : []), ...(pad ? ["pad"] as const : [])]);
    }
  }
  for (const [id, slots] of changed) {
    for (const slot of slots) {
      const code = slotCode(b[id], slot);
      const taken = code !== null && holders(b, code, slot === "pad", actionDef(id).context, id).some((h) => !changed.get(h.action)?.includes(h.slot));
      if (taken) b = { ...b, [id]: withSlot(b[id], slot, null) };
    }
  }
  return b;
}

/** Une touche retirée à une autre action pour être donnée à celle qu'on règle. */
export interface Displaced {
  readonly action: ActionId;
  readonly slot: Slot;
  /** La touche prise. */
  readonly code: string;
  /** Ce qui la remplace : l'ancienne touche de l'action réglée (un échange), ou null. */
  readonly replacement: string | null;
}

export interface AssignResult {
  readonly bindings: Bindings;
  readonly displaced: readonly Displaced[];
  /** Refusé : touche réservée (Échap, Menu), case fixe, code inconnu, molette pour une action qu'on tient. */
  readonly refused: "reserved" | "fixed" | "invalid" | "wheel" | null;
}

/** Les actions (sauf `except`) qui portent ce code dans une case de cette sorte et valent en même temps que `context`. */
function holders(b: Bindings, code: string, pad: boolean, context: InputContext, except: ActionId): { action: ActionId; slot: Slot }[] {
  const found: { action: ActionId; slot: Slot }[] = [];
  for (const id of ACTION_IDS) {
    if (id === except || !contextsOverlap(context, actionDef(id).context)) continue;
    for (const slot of sameDevice(pad ? "pad" : 0)) if (slotCode(b[id], slot) === code) found.push({ action: id, slot });
  }
  return found;
}

/**
 * Donne `code` à la case `slot` de l'action (null : la vide). Une touche déjà prise par une action
 * qui vaut au même moment lui est retirée, et cette action reçoit en échange l'ancienne touche de
 * celle qu'on règle, si cela ne crée pas d'autre conflit (sinon sa case reste vide) : le joueur ne
 * perd jamais une commande sans le savoir (`displaced` le dit). Deux actions qui ne valent jamais
 * ensemble (freiner au sol, monter en vol) gardent la même touche.
 */
export function assignBinding(b: Bindings, action: ActionId, slot: Slot, code: string | null): AssignResult {
  const refuse = (refused: AssignResult["refused"]): AssignResult => ({ bindings: b, displaced: [], refused });
  const def = actionDef(action);
  if (!isEditable(action, slot)) return refuse("fixed");
  const pad = slot === "pad";
  if (code !== null) {
    if (pad ? !isPadCode(code) : !isKeyCode(code) || !fitsAction(action, code)) return refuse("invalid");
    if ((pad ? RESERVED_PAD : RESERVED_KEYS).has(code)) return refuse("reserved");
    if (def.hold && isWheel(code)) return refuse("wheel");
  }
  const old = slotCode(b[action], slot);
  if (code === old) return { bindings: b, displaced: [], refused: null };
  const next = { ...b } as Record<ActionId, Binding>;
  // Déjà sur l'autre case de la même action : les deux cases s'échangent
  if (code !== null && !pad && b[action].keys[1 - slot] === code) {
    next[action] = { keys: [b[action].keys[1], b[action].keys[0]], pad: b[action].pad };
    return { bindings: next, displaced: [], refused: null };
  }
  next[action] = withSlot(b[action], slot, code);
  const displaced: Displaced[] = [];
  if (code !== null) {
    for (const h of holders(b, code, pad, def.context, action)) {
      const other = actionDef(h.action);
      // L'action qui perd sa touche reçoit l'ancienne de celle qu'on règle, si elle y est permise et libre
      const fits = old !== null && !(other.hold && isWheel(old))
        && !sameDevice(h.slot).some((s) => s !== h.slot && slotCode(next[h.action], s) === old)
        && holders(next, old, pad, other.context, h.action).length === 0;
      const replacement = fits ? old : null;
      next[h.action] = withSlot(next[h.action], h.slot, replacement);
      displaced.push({ action: h.action, slot: h.slot, code, replacement });
    }
  }
  return { bindings: next, displaced, refused: null };
}

/** Remet les touches par défaut d'une action (en les reprenant, s'il le faut, à celles qui les avaient prises). */
export function resetAction(b: Bindings, action: ActionId): { bindings: Bindings; displaced: Displaced[] } {
  let bindings = b;
  const displaced: Displaced[] = [];
  const def = actionDef(action);
  // On vide d'abord ses cases : ses anciennes touches ne partent pas en échange chez les autres
  for (const slot of [0, 1, "pad"] as const) if (isEditable(action, slot)) bindings = assignBinding(bindings, action, slot, null).bindings;
  for (const slot of [0, 1, "pad"] as const) {
    const code = slot === "pad" ? def.pad : def.keys[slot];
    if (!isEditable(action, slot) || code === null) continue;
    const r = assignBinding(bindings, action, slot, code);
    bindings = r.bindings;
    displaced.push(...r.displaced);
  }
  return { bindings, displaced };
}

/** Les touches de cette action sont-elles celles par défaut ? */
export function isDefault(b: Bindings, id: ActionId): boolean {
  const d = DEFAULT_BINDINGS[id];
  return b[id].keys[0] === d.keys[0] && b[id].keys[1] === d.keys[1] && b[id].pad === d.pad;
}

/** Les actions qui valent à ce moment (`active`) et portent ce code (clavier et souris, ou manette). */
export function actionsFor(b: Bindings, code: string, pad: boolean, active: (context: InputContext) => boolean): ActionId[] {
  const found: ActionId[] = [];
  for (const id of ACTION_IDS) {
    if (!active(actionDef(id).context)) continue;
    if (pad ? b[id].pad === code : b[id].keys[0] === code || b[id].keys[1] === code) found.push(id);
  }
  return found;
}

// --- Noms à l'écran ---

/**
 * Touches qui n'écrivent pas de caractère, et la souris : leur nom est dans chaque langue
 * (`key.<code>` : « Espace », « Space »).
 */
export const NAMED_KEYS = [
  "Space", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "Tab", "Enter", "NumpadEnter",
  "Backspace", "Escape", "CapsLock", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ContextMenu", "MetaLeft", "MetaRight", "NumLock", "ScrollLock", "Pause", "PrintScreen",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal",
  "Mouse0", "Mouse1", "Mouse2", "Mouse3", "Mouse4", "WheelUp", "WheelDown",
] as const;
export type NamedKey = (typeof NAMED_KEYS)[number];
const isNamedKey = (code: string): code is NamedKey => (NAMED_KEYS as readonly string[]).includes(code);
/** Ponctuation d'un clavier QWERTY américain : le nom quand on ne connaît pas le clavier du joueur. */
const US_PUNCTUATION: Readonly<Record<string, string>> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", IntlBackslash: "<",
};

/**
 * Nom d'une touche du clavier ou de la souris, selon le clavier du joueur : `layout` donne le
 * caractère de chaque touche (`navigator.keyboard.getLayoutMap()`, ou appris en jouant) ; sans lui,
 * celui d'un clavier QWERTY. Les chiffres restent des chiffres (sur un clavier AZERTY, la touche 1
 * écrit « & », mais c'est le 1 qu'on y lit).
 */
export function codeLabel(code: string, layout?: ReadonlyMap<string, string>): string {
  if (isChord(code)) {
    const { mods, base } = splitChord(code);
    const ctrl = mods.includes("Control");
    // Avec Ctrl, une lettre suit la lettre tapée (voir `eventChords`) : son nom est cette lettre
    const key = ctrl && /^Key[A-Z]$/.test(base) ? base.slice(3) : codeLabel(base, layout);
    return [...mods.map((m) => ((MODIFIERS as readonly string[]).includes(m) ? t(`key.mod.${m as Modifier}`) : m)), key].join("+");
  }
  if (isNamedKey(code)) return t(`key.${code}`);
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return t("key.numpad", { n: Number(numpad[1]) });
  if (/^F\d{1,2}$/.test(code)) return code;
  const typed = layout?.get(code)?.trim();
  if (typed) return typed.length === 1 ? typed.toUpperCase() : typed;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  return US_PUNCTUATION[code] ?? code;
}

/**
 * Nom à l'écran des touches (clavier, souris) d'une action, pour une aide : sa touche fixe, sinon
 * celle qui écrit la lettre qu'évoque l'action (celle de sa touche par défaut sur un QWERTY : la
 * carte, M, est la touche marquée M en AZERTY comme en QWERTY), sinon la seconde si elle seule écrit
 * une lettre ou un chiffre, sinon la première ; « — » si elle n'en a pas.
 */
export function bindingName(id: ActionId, b: Binding, layout?: ReadonlyMap<string, string>): string {
  const def = actionDef(id);
  if (def.fixedKey) return codeLabel(def.fixedKey, layout);
  const names = b.keys.filter((c): c is string => c !== null).map((c) => codeLabel(c, layout));
  if (!names.length) return "—";
  const mnemonic = def.keys[0] ? codeLabel(def.keys[0]) : null;
  if (mnemonic && names.includes(mnemonic)) return mnemonic;
  const plain = (name: string): boolean => /^[A-Z0-9]$/.test(name);
  return names.length > 1 && !plain(names[0]) && plain(names[1]) ? names[1] : names[0];
}

/**
 * Qui nomme les touches choisies par le joueur, pour les textes du jeu qui en citent une (fiche d'une
 * pièce, trait d'un robot…) : les commandes du jeu (`Controls.keyName`), une fois créées ; avant, ou
 * hors du navigateur (les essais), les touches par défaut sur un clavier QWERTY.
 */
let namer: (id: ActionId) => string = (id) => bindingName(id, DEFAULT_BINDINGS[id]);
export function setKeyNamer(name: (id: ActionId) => string): void {
  namer = name;
}
/** Nom de la touche choisie pour cette action (la manette, si l'on joue avec). */
export const keyLabel = (id: ActionId): string => namer(id);

/** Disposition de la manette : les noms de ses boutons. */
export type PadStyle = "xbox" | "playstation";

/** Disposition d'après le nom que le navigateur donne à la manette (Sony : 054c). */
export function padStyle(id: string | null): PadStyle {
  return id && /054c|playstation|dualshock|dualsense|sony/i.test(id) ? "playstation" : "xbox";
}

/**
 * Noms des boutons, dans l'ordre de la disposition standard : ceux qu'on lit sur la manette ; les
 * autres (le bouton Vue, la croix) ont leur nom dans chaque langue (`pad.<nom>`).
 */
const PAD_NAMES: Readonly<Record<PadStyle, readonly (string | { readonly key: PadName })[]>> = {
  xbox: ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", { key: "view" }, "Menu", "L3", "R3", { key: "dpadUp" }, { key: "dpadDown" }, { key: "dpadLeft" }, { key: "dpadRight" }, "Xbox"],
  playstation: ["✕", "○", "□", "△", "L1", "R1", "L2", "R2", "Share", "Options", "L3", "R3", { key: "dpadUp" }, { key: "dpadDown" }, { key: "dpadLeft" }, { key: "dpadRight" }, "PS"],
};
/** Commandes fixes de la manette (les sticks), et ce qui a un nom dans chaque langue. */
export const PAD_NAMED = ["view", "dpadUp", "dpadDown", "dpadLeft", "dpadRight", "StickL", "StickLUp", "StickLDown", "StickLLeft", "StickLRight", "StickR"] as const;
export type PadName = (typeof PAD_NAMED)[number];
const isPadName = (code: string): code is PadName => (PAD_NAMED as readonly string[]).includes(code);

/** Nom d'un bouton de la manette (ou d'un stick), selon sa disposition. */
export function padLabel(code: string, style: PadStyle = "xbox"): string {
  if (code.startsWith("Stick") && isPadName(code)) return t(`pad.${code}`);
  const m = /^Pad(\d{1,2})$/.exec(code);
  const name = m ? PAD_NAMES[style][Number(m[1])] : undefined;
  if (name === undefined) return code;
  return typeof name === "string" ? name : t(`pad.${name.key}`);
}

// --- Manette : sticks ---

/**
 * Zone morte d'un stick, radiale : en deçà de `deadzone`, rien ; au-delà, la course restante est
 * ramenée de 0 à 1 (sans saut au bord de la zone morte), dans la même direction.
 */
export function stickDeadzone(x: number, y: number, deadzone: number): [number, number] {
  const m = Math.hypot(x, y);
  if (!(m > deadzone)) return [0, 0];
  const k = Math.min(1, (m - deadzone) / (1 - deadzone)) / m;
  return [x * k, y * k];
}

/** Zone morte d'un seul axe (gâchette), de même. */
export function axisDeadzone(v: number, deadzone: number): number {
  const a = Math.abs(v);
  if (!(a > deadzone)) return 0;
  return Math.sign(v) * Math.min(1, (a - deadzone) / (1 - deadzone));
}
