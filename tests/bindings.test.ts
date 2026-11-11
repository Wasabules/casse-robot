import { describe, expect, it } from "vitest";
import {
  ACTION_CATEGORIES, ACTION_IDS, actionDef, actionDetail, actionLabel, actionsFor, assignBinding, axisDeadzone, bindingName, categoryLabel, chordCode,
  codeLabel, contextsOverlap, DEFAULT_BINDINGS, eventChords, isDefault, isEditable, isKeyCode, isPadCode, migrateBindings, padLabel, padStyle,
  parseBindings, resetAction, slotCode, stickDeadzone,
  type ActionId, type Bindings, type InputContext, type Slot,
} from "../src/client/input/bindings";
import { setLocale } from "../src/client/i18n/state";

/** Les paires d'actions qui portent la même touche (clavier ou manette) et valent au même moment. */
function conflicts(b: Bindings): string[] {
  const found: string[] = [];
  for (const a of ACTION_IDS) {
    for (const c of ACTION_IDS) {
      if (a >= c || !contextsOverlap(actionDef(a).context, actionDef(c).context)) continue;
      for (const code of [...b[a].keys, b[a].pad]) {
        if (code !== null && ([...b[c].keys, b[c].pad] as (string | null)[]).includes(code)) found.push(`${a} · ${c} : ${code}`);
      }
    }
  }
  return found;
}

describe("table des actions", () => {
  it("chaque action a sa rubrique, et ses touches par défaut sont valables", () => {
    const categories = new Set<string>(ACTION_CATEGORIES);
    for (const id of ACTION_IDS) {
      const def = actionDef(id);
      expect(categories.has(def.category), id).toBe(true);
      for (const k of def.keys) if (k !== null) expect(isKeyCode(k), `${id} : ${k}`).toBe(true);
      if (def.pad !== null) expect(isPadCode(def.pad), `${id} : ${def.pad}`).toBe(true);
    }
  });

  it("aucun conflit dans les touches par défaut, sauf entre moments qui ne vont pas ensemble", () => {
    expect(conflicts(DEFAULT_BINDINGS)).toEqual([]);
    // Espace freine au sol et fait monter en vol ; E fait sauter les mines au sol et pivoter en vol
    expect(DEFAULT_BINDINGS.brake.keys[0]).toBe("Space");
    expect(DEFAULT_BINDINGS.climb.keys[0]).toBe("Space");
    expect(DEFAULT_BINDINGS.detonate.keys[0]).toBe(DEFAULT_BINDINGS.yawRight.keys[0]);
    // Au garage, les chiffres et R reprennent leurs touches de la partie : jamais en même temps
    expect(DEFAULT_BINDINGS.garageRecent1.keys[0]).toBe(DEFAULT_BINDINGS.weapon1.keys[0]);
    expect(DEFAULT_BINDINGS.garageSpin.keys[0]).toBe(DEFAULT_BINDINGS.newWave.keys[0]);
  });

  it("la table suit le schéma de Robocraft : ZQSD (ou WASD), Espace monte, C descend, clic gauche, clic droit, 1 à 0", () => {
    const keys = (id: ActionId): readonly (string | null)[] => DEFAULT_BINDINGS[id].keys;
    expect(keys("forward")).toEqual(["KeyW", "ArrowUp"]);
    expect(keys("back")).toEqual(["KeyS", "ArrowDown"]);
    expect(keys("left")[0]).toBe("KeyA");
    expect(keys("right")[0]).toBe("KeyD");
    expect(keys("climb")[0]).toBe("Space");
    // Plus Ctrl : tenue en vol, avec la touche des gaz, elle faisait Ctrl+W (le navigateur ferme l'onglet)
    expect(keys("descend")).toEqual(["KeyC", null]);
    for (const id of ACTION_IDS) if (actionDef(id).context !== "garage") expect(DEFAULT_BINDINGS[id].keys, id).not.toContain("ControlLeft");
    expect(keys("fire")[0]).toBe("Mouse0");
    expect(keys("scope")[0]).toBe("Mouse2");
    expect(keys("map")[0]).toBe("KeyM");
    expect(keys("scoreboard")[0]).toBe("Tab");
  });

  it("les touches d'avant ces réglages restent les mêmes par défaut", () => {
    const keys = (id: ActionId): readonly (string | null)[] => DEFAULT_BINDINGS[id].keys;
    expect(keys("forward")).toEqual(["KeyW", "ArrowUp"]);
    expect(keys("boost")).toEqual(["ShiftLeft", "ShiftRight"]);
    expect(keys("yawLeft")[0]).toBe("KeyQ");
    expect(keys("flares")[0]).toBe("KeyF");
    expect(keys("detonateAir")[0]).toBe("KeyG");
    expect(keys("fire")[0]).toBe("Mouse0");
    expect(keys("scope")[0]).toBe("Mouse2");
    expect(keys("weapon10")).toEqual(["Digit0", "Numpad0"]);
    // La carte : la position du M en QWERTY (« , » en AZERTY), et celle du M en AZERTY
    expect(keys("map")).toEqual(["KeyM", "Semicolon"]);
  });

  it("les moments du jeu : au sol et en vol ne vont pas ensemble, la caméra libre non plus avec le pilotage", () => {
    const yes: [InputContext, InputContext][] = [["any", "free"], ["pilot", "ground"], ["flight", "pilot"], ["ground", "ground"]];
    const no: [InputContext, InputContext][] = [["ground", "flight"], ["free", "pilot"], ["free", "ground"]];
    for (const [a, b] of yes) expect(contextsOverlap(a, b), `${a} · ${b}`).toBe(true);
    for (const [a, b] of no) expect(contextsOverlap(a, b), `${a} · ${b}`).toBe(false);
    // Les actions qu'une touche porte, selon le moment
    const ground = (c: InputContext): boolean => c === "any" || c === "pilot" || c === "ground";
    const flight = (c: InputContext): boolean => c === "any" || c === "pilot" || c === "flight";
    expect(actionsFor(DEFAULT_BINDINGS, "Space", false, ground)).toEqual(["brake"]);
    expect(actionsFor(DEFAULT_BINDINGS, "Space", false, flight)).toEqual(["climb"]);
    expect(actionsFor(DEFAULT_BINDINGS, "Pad3", true, flight)).toEqual(["detonateAir"]);
  });
});

describe("lecture tolérante des touches enregistrées", () => {
  it("rien d'enregistré, ou n'importe quoi : les touches par défaut", () => {
    for (const raw of [undefined, null, 42, "texte", [], { forward: 3 }]) expect(parseBindings(raw)).toEqual(DEFAULT_BINDINGS);
  });

  it("garde les touches valables, remplace les autres, oublie les actions inconnues", () => {
    const b = parseBindings({
      forward: { keys: ["KeyZ", null], pad: null },
      boost: { keys: ["Pad3", "Escape"], pad: "Pad99" },
      brake: { keys: ["KeyB"] },
      fire: { keys: ["Mouse4", "Mouse4"], pad: "Pad5" },
      nextWeapon: { keys: ["WheelUp", "WheelDown"] },
      back: { keys: ["WheelDown", "KeyJ"] },
      inconnue: { keys: ["KeyK", null] },
    });
    expect(b.forward).toEqual({ keys: ["KeyZ", null], pad: null });
    // Un code de manette au clavier, Échap, un bouton qui n'existe pas : la valeur par défaut
    expect(b.boost).toEqual({ keys: DEFAULT_BINDINGS.boost.keys, pad: DEFAULT_BINDINGS.boost.pad });
    // Pas deux touches : celles par défaut
    expect(b.brake).toEqual(DEFAULT_BINDINGS.brake);
    // La même touche deux fois : une suffit
    expect(b.fire).toEqual({ keys: ["Mouse4", null], pad: "Pad5" });
    // La molette pour une action d'un coup, oui ; pour une action qu'on tient, non
    expect(b.nextWeapon.keys).toEqual(["WheelUp", "WheelDown"]);
    expect(b.back.keys).toEqual([DEFAULT_BINDINGS.back.keys[0], "KeyJ"]);
    expect(b).not.toHaveProperty("inconnue");
  });

  it("les touches fixes ne se changent pas, même enregistrées", () => {
    const b = parseBindings({ pause: { keys: ["KeyP", null], pad: "Pad2" }, forward: { keys: ["KeyW", "ArrowUp"], pad: "Pad2" } });
    expect(b.pause).toEqual(DEFAULT_BINDINGS.pause);
    expect(b.forward.pad).toBeNull();
    expect(isEditable("pause", 0)).toBe(false);
    expect(isEditable("forward", "pad")).toBe(false);
    expect(isEditable("forward", 0)).toBe(true);
  });
});

describe("attribution d'une touche", () => {
  it("une touche libre : elle est prise, rien d'autre ne change", () => {
    const r = assignBinding(DEFAULT_BINDINGS, "nextWeapon", 0, "KeyB");
    expect(r.refused).toBeNull();
    expect(r.displaced).toEqual([]);
    expect(r.bindings.nextWeapon.keys).toEqual(["KeyB", null]);
    expect(conflicts(r.bindings)).toEqual([]);
    // R (nouvelle vague, à la caméra libre) : l'arme suivante vaut aussi là, R lui est retirée
    const s = assignBinding(DEFAULT_BINDINGS, "nextWeapon", 0, "KeyR");
    expect(s.displaced).toEqual([{ action: "newWave", slot: 0, code: "KeyR", replacement: null }]);
  });

  it("une touche déjà prise au même moment : échangée avec l'ancienne de l'action réglée", () => {
    // Freiner (au sol) sur F, que prennent les leurres (en pilotant) : les leurres reçoivent Espace
    const r = assignBinding(DEFAULT_BINDINGS, "brake", 0, "KeyF");
    expect(r.bindings.brake.keys[0]).toBe("KeyF");
    expect(r.displaced).toEqual([{ action: "flares", slot: 0, code: "KeyF", replacement: null }]);
    // Espace ne pouvait pas aller aux leurres (ils valent aussi en vol, où Espace fait monter) : retirée
    expect(r.bindings.flares.keys[0]).toBeNull();
    expect(conflicts(r.bindings)).toEqual([]);
    // Avancer sur S (reculer) : reculer prend W
    const s = assignBinding(DEFAULT_BINDINGS, "forward", 0, "KeyS");
    expect(s.bindings.forward.keys[0]).toBe("KeyS");
    expect(s.bindings.back.keys[0]).toBe("KeyW");
    expect(s.displaced).toEqual([{ action: "back", slot: 0, code: "KeyS", replacement: "KeyW" }]);
    expect(conflicts(s.bindings)).toEqual([]);
  });

  it("une action qui ne vaut jamais au même moment garde la touche", () => {
    // Freiner (au sol) sur G : G fait sauter les mines en vol ; les deux la gardent
    const r = assignBinding(DEFAULT_BINDINGS, "brake", 0, "KeyG");
    expect(r.displaced).toEqual([]);
    expect(r.bindings.detonateAir.keys[0]).toBe("KeyG");
    expect(conflicts(r.bindings)).toEqual([]);
  });

  it("dans la même action, les deux cases s'échangent ; la manette a ses propres conflits", () => {
    const r = assignBinding(DEFAULT_BINDINGS, "forward", 1, "KeyW");
    expect(r.bindings.forward.keys).toEqual(["ArrowUp", "KeyW"]);
    const p = assignBinding(DEFAULT_BINDINGS, "flares", "pad", "Pad7");
    expect(p.bindings.flares.pad).toBe("Pad7");
    expect(p.bindings.fire.pad).toBe("Pad2");
    expect(conflicts(p.bindings)).toEqual([]);
  });

  it("refusé : Échap, le bouton Menu, une case fixe, la molette pour une action qu'on tient, un code inconnu", () => {
    expect(assignBinding(DEFAULT_BINDINGS, "fire", 0, "Escape").refused).toBe("reserved");
    expect(assignBinding(DEFAULT_BINDINGS, "fire", "pad", "Pad9").refused).toBe("reserved");
    expect(assignBinding(DEFAULT_BINDINGS, "pause", 0, "KeyP").refused).toBe("fixed");
    expect(assignBinding(DEFAULT_BINDINGS, "forward", "pad", "Pad3").refused).toBe("fixed");
    expect(assignBinding(DEFAULT_BINDINGS, "forward", 1, "WheelUp").refused).toBe("wheel");
    expect(assignBinding(DEFAULT_BINDINGS, "fire", 0, "Pad3").refused).toBe("invalid");
    expect(assignBinding(DEFAULT_BINDINGS, "fire", "pad", "KeyF").refused).toBe("invalid");
    // Refusé : rien ne change
    expect(assignBinding(DEFAULT_BINDINGS, "fire", 0, "Escape").bindings).toBe(DEFAULT_BINDINGS);
  });

  it("retirer une touche, puis remettre celles par défaut d'une action (en les reprenant)", () => {
    const cleared = assignBinding(DEFAULT_BINDINGS, "map", 0, null).bindings;
    expect(cleared.map.keys[0]).toBeNull();
    expect(isDefault(cleared, "map")).toBe(false);
    // La carte n'a plus de touche ; le tableau prend M ; puis on remet la carte par défaut : elle reprend M au tableau
    const taken = assignBinding(cleared, "scoreboard", 0, "KeyM").bindings;
    const reset = resetAction(taken, "map");
    expect(isDefault(reset.bindings, "map")).toBe(true);
    expect(reset.displaced.map((d) => d.action)).toEqual(["scoreboard"]);
    expect(conflicts(reset.bindings)).toEqual([]);
  });

  it("au hasard, des attributions ne créent jamais de conflit", () => {
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 16807) % 2147483647;
      return seed % n;
    };
    const keys = ["KeyW", "KeyS", "KeyF", "KeyE", "KeyG", "KeyQ", "Space", "KeyR", "Mouse0", "Mouse2", "Tab", "KeyM", "ShiftLeft", "Digit1"];
    const pads = Array.from({ length: 17 }, (_, i) => `Pad${i}`);
    let b: Bindings = DEFAULT_BINDINGS;
    for (let i = 0; i < 400; i++) {
      const action = ACTION_IDS[random(ACTION_IDS.length)];
      const slot = ([0, 1, "pad"] as Slot[])[random(3)];
      const code = slot === "pad" ? pads[random(pads.length)] : keys[random(keys.length)];
      b = assignBinding(b, action, slot, code).bindings;
      expect(conflicts(b), `${i} : ${action} ${slot} ${code}`).toEqual([]);
    }
    expect(slotCode(b.pause, "pad")).toBeNull();
  });
});

describe("noms des touches", () => {
  it("selon le clavier du joueur : Z en AZERTY, W sans le connaître ; les chiffres restent des chiffres", () => {
    const azerty = new Map([["KeyW", "z"], ["KeyQ", "a"], ["Digit1", "&"], ["Semicolon", "m"]]);
    expect(codeLabel("KeyW")).toBe("W");
    expect(codeLabel("KeyW", azerty)).toBe("Z");
    expect(codeLabel("KeyQ", azerty)).toBe("A");
    expect(codeLabel("Digit1", azerty)).toBe("1");
    expect(codeLabel("Semicolon", azerty)).toBe("M");
    expect(codeLabel("Semicolon")).toBe(";");
    expect(codeLabel("Space")).toBe("Espace");
    expect(codeLabel("ShiftLeft")).toBe("Maj g.");
    expect(codeLabel("Mouse2")).toBe("Clic droit");
    expect(codeLabel("WheelUp")).toBe("Molette ↑");
    expect(codeLabel("Numpad4")).toBe("Pavé 4");
    expect(codeLabel("F5")).toBe("F5");
  });

  it("les touches qui n'écrivent rien ont leur nom dans la langue du joueur ; les autres suivent son clavier", () => {
    setLocale("en");
    try {
      expect(codeLabel("Space")).toBe("Space");
      expect(codeLabel("ShiftLeft")).toBe("L Shift");
      expect(codeLabel("Mouse2")).toBe("Right click");
      expect(codeLabel("Numpad4")).toBe("Num 4");
      expect(codeLabel("KeyW", new Map([["KeyW", "z"]]))).toBe("Z");
      expect(padLabel("Pad12")).toBe("D-pad ↑");
      expect(padLabel("Pad8")).toBe("View");
      expect(padLabel("Pad8", "playstation")).toBe("Share");
      expect(actionLabel("brake")).toBe("Brake");
      expect(categoryLabel("free")).toBe("Free camera");
    } finally {
      setLocale("fr");
    }
    expect(actionLabel("brake")).toBe("Freiner");
    expect(actionDetail("boost")).toContain("Propulseurs");
    // Toutes les actions n'ont pas de précision ; une précision peut nommer une touche de modification
    expect(actionDetail("weapon2")).toBeUndefined();
    expect(actionDetail("weapon1")).toBe("Avec Maj : arme 11, et ainsi de suite.");
  });

  it("boutons de la manette, Xbox ou PlayStation selon son nom", () => {
    expect(padStyle("Xbox 360 Controller (XInput STANDARD GAMEPAD)")).toBe("xbox");
    expect(padStyle("Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)")).toBe("playstation");
    expect(padStyle(null)).toBe("xbox");
    expect(padLabel("Pad0")).toBe("A");
    expect(padLabel("Pad0", "playstation")).toBe("✕");
    expect(padLabel("Pad7")).toBe("RT");
    expect(padLabel("Pad7", "playstation")).toBe("R2");
    expect(padLabel("StickLUp")).toBe("Stick g. ↑");
  });
});

describe("garage : ses actions, ses combinaisons", () => {
  it("une rubrique à part, sans manette, qui ne gêne jamais la partie", () => {
    const garage = ACTION_IDS.filter((id) => actionDef(id).category === "garage");
    expect(garage.length).toBeGreaterThan(20);
    for (const id of garage) {
      expect(actionDef(id).context, id).toBe("garage");
      expect(isEditable(id, "pad"), id).toBe(false);
      expect(DEFAULT_BINDINGS[id].pad, id).toBeNull();
    }
    for (const c of ["any", "pilot", "ground", "flight", "free"] as const) expect(contextsOverlap("garage", c)).toBe(false);
    // M (symétrie) au garage, M (carte) en partie : chacun la sienne
    const r = assignBinding(DEFAULT_BINDINGS, "garageMirror", 0, "Tab");
    expect(r.displaced).toEqual([]);
    expect(r.bindings.scoreboard.keys[0]).toBe("Tab");
  });

  it("les combinaisons : Ctrl, Maj, Alt, dans cet ordre, sur une touche ou un bouton ; au garage seulement", () => {
    for (const ok of ["Control+KeyZ", "Shift+KeyR", "Control+Shift+KeyZ", "Shift+Mouse0", "Alt+Digit1"]) expect(isKeyCode(ok), ok).toBe(true);
    for (const bad of ["Shift+Control+KeyZ", "Control+Control+KeyZ", "Super+KeyZ", "Shift+ShiftLeft", "Control+WheelUp", "Control+"]) expect(isKeyCode(bad), bad).toBe(false);
    expect(assignBinding(DEFAULT_BINDINGS, "garageUndo", 1, "Control+KeyU").bindings.garageUndo.keys).toEqual(["Control+KeyZ", "Control+KeyU"]);
    expect(assignBinding(DEFAULT_BINDINGS, "fire", 0, "Control+KeyU").refused).toBe("invalid");
    expect(parseBindings({ fire: { keys: ["Control+KeyU", null], pad: null } }).fire.keys).toEqual(DEFAULT_BINDINGS.fire.keys);
    // Pivoter (R) et basculer (Maj+R) : deux codes, deux actions
    expect(actionsFor(DEFAULT_BINDINGS, "KeyR", false, (c) => c === "garage")).toEqual(["garageSpin"]);
    expect(actionsFor(DEFAULT_BINDINGS, "Shift+KeyR", false, (c) => c === "garage")).toEqual(["garageTilt"]);
    expect(actionsFor(DEFAULT_BINDINGS, chordCode("Mouse0", { ctrlKey: false, shiftKey: true, altKey: false }), false, (c) => c === "garage")).toEqual(["garageSelect"]);
    // Une touche de modification seule reste elle-même ; Cmd (Mac) compte comme Ctrl
    expect(chordCode("ShiftLeft", { ctrlKey: false, shiftKey: true, altKey: false })).toBe("ShiftLeft");
    expect(chordCode("KeyC", { ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe("Control+KeyC");
  });

  it("Ctrl+Z annule sur un clavier AZERTY : avec Ctrl, une lettre se lit d'abord comme celle qu'elle tape", () => {
    const none = { ctrlKey: false, shiftKey: false, altKey: false };
    // La touche marquée Z d'un AZERTY est à la place du W d'un QWERTY
    expect(eventChords({ code: "KeyW", key: "z", ...none, ctrlKey: true })).toEqual(["Control+KeyZ", "Control+KeyW"]);
    expect(eventChords({ code: "KeyZ", key: "z", ...none, ctrlKey: true })).toEqual(["Control+KeyZ"]);
    // Sans Ctrl, la position (comme toute la table) ; un clavier cyrillique : la position aussi
    expect(eventChords({ code: "KeyW", key: "z", ...none })).toEqual(["KeyW"]);
    expect(eventChords({ code: "KeyZ", key: "я", ...none, ctrlKey: true })).toEqual(["Control+KeyZ"]);
    // Le nom d'une combinaison avec Ctrl : sa lettre, quel que soit le clavier
    const azerty = new Map([["KeyW", "z"], ["KeyZ", "w"], ["KeyQ", "a"], ["KeyM", ","], ["Semicolon", "m"]]);
    expect(codeLabel("Control+KeyZ", azerty)).toBe("Ctrl+Z");
    expect(codeLabel("Shift+KeyR")).toBe("Maj+R");
    expect(codeLabel("Shift+Mouse0")).toBe("Maj+Clic gauche");
  });

  it("le nom d'une action : la touche qui écrit sa lettre (M en AZERTY comme en QWERTY)", () => {
    const azerty = new Map([["KeyW", "z"], ["KeyQ", "a"], ["KeyM", ","], ["Semicolon", "m"]]);
    expect(bindingName("garageMirror", DEFAULT_BINDINGS.garageMirror, azerty)).toBe("M");
    expect(bindingName("garageMirror", DEFAULT_BINDINGS.garageMirror)).toBe("M");
    expect(bindingName("map", DEFAULT_BINDINGS.map, azerty)).toBe("M");
    expect(bindingName("forward", DEFAULT_BINDINGS.forward, azerty)).toBe("Z");
    expect(bindingName("garageUndo", DEFAULT_BINDINGS.garageUndo, azerty)).toBe("Ctrl+Z");
    expect(bindingName("pause", DEFAULT_BINDINGS.pause)).toBe("Échap");
    // Une touche choisie : la sienne
    const b = assignBinding(DEFAULT_BINDINGS, "garageMirror", 0, "KeyY").bindings;
    expect(bindingName("garageMirror", b.garageMirror)).toBe("Y");
    expect(bindingName("garageMirror", { keys: [null, null], pad: null })).toBe("—");
  });
});

describe("touches d'une version précédente de la table", () => {
  it("une action gardée par défaut prend les nouvelles ; une action changée garde les siennes", () => {
    const v1 = { ...DEFAULT_BINDINGS, descend: { keys: ["KeyC", "ControlLeft"], pad: "Pad1" } };
    expect(migrateBindings(v1, 1).descend).toEqual(DEFAULT_BINDINGS.descend);
    expect(migrateBindings(v1, 2).descend.keys).toEqual(["KeyC", "ControlLeft"]);
    const own = { ...v1, descend: { keys: ["KeyV", "ControlLeft"], pad: "Pad1" } };
    expect(migrateBindings(own, 1).descend.keys).toEqual(["KeyV", "ControlLeft"]);
    expect(conflicts(migrateBindings(v1, 1))).toEqual([]);
  });
});

describe("zone morte de la manette", () => {
  it("rien en deçà, puis la course restante ramenée de 0 à 1, sans saut", () => {
    expect(stickDeadzone(0.1, 0.05, 0.15)).toEqual([0, 0]);
    const [x, y] = stickDeadzone(1, 0, 0.15);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBe(0);
    // Juste au-delà de la zone morte : presque rien
    expect(Math.hypot(...stickDeadzone(0.16, 0, 0.15))).toBeLessThan(0.02);
    // La direction est gardée
    const [dx, dy] = stickDeadzone(0.5, 0.5, 0.2);
    expect(dx).toBeCloseTo(dy, 9);
    expect(Math.hypot(dx, dy)).toBeCloseTo((Math.SQRT1_2 - 0.2) / 0.8, 6);
    expect(axisDeadzone(-0.1, 0.15)).toBe(0);
    expect(axisDeadzone(-1, 0.15)).toBe(-1);
    expect(axisDeadzone(0.575, 0.15)).toBeCloseTo(0.5, 6);
  });
});

describe("éditeur de cartes : ses actions", () => {
  it("une rubrique à part, sans manette, qui ne gêne ni la partie ni le garage ; ses combinaisons", () => {
    const editor = ACTION_IDS.filter((id) => actionDef(id).category === "editor");
    expect(editor.length).toBeGreaterThan(25);
    for (const id of editor) {
      expect(actionDef(id).context, id).toBe("editor");
      expect(isEditable(id, "pad"), id).toBe(false);
    }
    for (const c of ["any", "pilot", "ground", "flight", "free", "garage"] as const) expect(contextsOverlap("editor", c)).toBe(false);
    expect(contextsOverlap("editor", "editor")).toBe(true);
    // Ctrl+Z annule dans l'éditeur comme au garage, chacun la sienne
    expect(actionsFor(DEFAULT_BINDINGS, "Control+KeyZ", false, (c) => c === "editor")).toEqual(["editorUndo"]);
    expect(actionsFor(DEFAULT_BINDINGS, "Shift+KeyR", false, (c) => c === "editor")).toEqual(["editorRotateBack"]);
    expect(assignBinding(DEFAULT_BINDINGS, "editorSave", 1, "Alt+KeyS").bindings.editorSave.keys).toEqual(["Control+KeyS", "Alt+KeyS"]);
    // Une touche de l'éditeur prise par une autre de l'éditeur : échangée ; pas chez le garage
    const r = assignBinding(DEFAULT_BINDINGS, "editorTopView", 0, "KeyF");
    expect(r.displaced.map((d) => d.action)).toEqual(["editorFocus"]);
    expect(r.bindings.editorFocus.keys[0]).toBe("KeyT");
  });
});
