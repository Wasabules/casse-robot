import { describe, expect, it } from "vitest";
import { assignBinding, BINDINGS_VERSION, DEFAULT_BINDINGS } from "../src/client/input/bindings";
import {
  DEFAULT_SETTINGS, defaultMusicPlayer, defaultSettings, firstRunPreset, GRAPHICS_PRESETS, graphicsPreset, parseSettings, requestedRenderer,
} from "../src/client/settings";

describe("Réglages du joueur", () => {
  it("sans réglages enregistrés, ou illisibles : les réglages par défaut", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{pas du json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("42")).toEqual(DEFAULT_SETTINGS);
  });

  it("garde les valeurs valides, et remplace les autres par leur valeur par défaut", () => {
    const s = parseSettings(JSON.stringify({
      shadows: false, name: "Ada", sensitivity: 1.5, drive: "camera", renderScale: 0.75,
      // Invalides : mauvais type, hors des choix, hors des bornes
      sound: "oui", shadowQuality: "ultra", effects: 3, fov: 500, volume: -2, renderScale2: 1,
    }));
    expect(s).toMatchObject({ shadows: false, name: "Ada", sensitivity: 1.5, drive: "camera", renderScale: 0.75 });
    expect(s.sound).toBe(DEFAULT_SETTINGS.sound);
    expect(s.shadowQuality).toBe(DEFAULT_SETTINGS.shadowQuality);
    expect(s.effects).toBe(DEFAULT_SETTINGS.effects);
    expect(s.fov).toBe(70);
    expect(s.volume).toBe(0);
    expect(s).not.toHaveProperty("renderScale2");
  });

  it("reconnaît les préréglages graphiques, et les réglages personnalisés", () => {
    expect(graphicsPreset(DEFAULT_SETTINGS)).toBe("medium");
    for (const id of ["low", "medium", "high"] as const) expect(graphicsPreset({ ...DEFAULT_SETTINGS, ...GRAPHICS_PRESETS[id] })).toBe(id);
    // Sans ombres, leur finesse n'importe pas
    expect(graphicsPreset({ ...DEFAULT_SETTINGS, ...GRAPHICS_PRESETS.low, shadowQuality: "high" })).toBe("low");
    expect(graphicsPreset({ ...DEFAULT_SETTINGS, renderScale: 0.5 })).toBeNull();
    // Halo, éclairs et distorsion de chaleur font partie des préréglages
    expect(graphicsPreset({ ...DEFAULT_SETTINGS, ...GRAPHICS_PRESETS.high, heatHaze: false })).toBeNull();
    expect(graphicsPreset({ ...DEFAULT_SETTINGS, glow: false })).toBeNull();
  });

  it("des réglages d'avant les touches et la manette : touches par défaut, manette par défaut", () => {
    const old = parseSettings(JSON.stringify({ sensitivity: 1.4, drive: "camera", flight: "manual", scopeToggle: true }));
    expect(old.bindings).toEqual(DEFAULT_BINDINGS);
    expect(old).toMatchObject({ sensitivity: 1.4, drive: "camera", scopeToggle: true, padSensitivity: 1, padInvertY: false, padDeadzone: 0.15 });
  });

  it("garde les touches choisies et les réglages de la manette, bornés", () => {
    const bindings = assignBinding(DEFAULT_BINDINGS, "brake", 0, "KeyB").bindings;
    const s = parseSettings(JSON.stringify({ bindings, padSensitivity: 2.5, padInvertX: true, padDeadzone: 0.9 }));
    expect(s.bindings.brake.keys[0]).toBe("KeyB");
    expect(s.bindings).toEqual(bindings);
    expect(s.padSensitivity).toBe(2.5);
    expect(s.padInvertX).toBe(true);
    expect(s.padDeadzone).toBe(0.4);
    // Une table de touches abîmée ne fait pas perdre les autres réglages
    const broken = parseSettings(JSON.stringify({ bindings: "zqsd", fov: 50 }));
    expect(broken.bindings).toEqual(DEFAULT_BINDINGS);
    expect(broken.fov).toBe(50);
  });

  it("le pilotage de l'avion : l'ancien assisté devient celui à la souris ; par défaut, à la souris et à la caméra", () => {
    expect(DEFAULT_SETTINGS.flight).toBe("mouse");
    expect(DEFAULT_SETTINGS.drive).toBe("camera");
    expect(parseSettings(JSON.stringify({ flight: "assisted" })).flight).toBe("mouse");
    expect(parseSettings(JSON.stringify({ flight: "manual" })).flight).toBe("manual");
    // Un joueur qui conduisait en char le garde
    expect(parseSettings(JSON.stringify({ drive: "tank" })).drive).toBe("tank");
  });

  it("des touches d'une version précédente de la table : celles par défaut qui ont changé sont reprises, les siennes gardées", () => {
    // Version 1 : descendre sur C et Ctrl gauche (par défaut), freiner sur B (son choix)
    const old = { ...DEFAULT_BINDINGS, descend: { keys: ["KeyC", "ControlLeft"], pad: "Pad1" }, brake: { keys: ["KeyB", null], pad: "Pad0" } };
    const s = parseSettings(JSON.stringify({ bindings: old }));
    expect(s.bindings.descend).toEqual(DEFAULT_BINDINGS.descend);
    expect(s.bindings.brake.keys).toEqual(["KeyB", null]);
    expect(s.bindingsVersion).toBe(BINDINGS_VERSION);
    // Descendre changé par le joueur (C et X) : il le garde
    const own = parseSettings(JSON.stringify({ bindings: { ...old, descend: { keys: ["KeyC", "KeyX"], pad: "Pad1" } } }));
    expect(own.bindings.descend.keys).toEqual(["KeyC", "KeyX"]);
    // Des réglages déjà de cette version : rien n'est repris (Ctrl gauche, son choix, reste)
    const recent = parseSettings(JSON.stringify({ bindings: old, bindingsVersion: BINDINGS_VERSION }));
    expect(recent.bindings.descend.keys).toEqual(["KeyC", "ControlLeft"]);
  });

  it("fumée et flammes : réalistes par défaut, simples au préréglage le plus léger, lues avec tolérance", () => {
    expect(DEFAULT_SETTINGS.fxLook).toBe("realistic");
    expect(GRAPHICS_PRESETS.low.fxLook).toBe("simple");
    expect(GRAPHICS_PRESETS.medium.fxLook).toBe("realistic");
    expect(GRAPHICS_PRESETS.high.fxLook).toBe("realistic");
    // L'allure fait partie des préréglages
    expect(graphicsPreset({ ...DEFAULT_SETTINGS, fxLook: "simple" })).toBeNull();
    expect(graphicsPreset({ ...DEFAULT_SETTINGS, ...GRAPHICS_PRESETS.low, fxLook: "realistic" })).toBeNull();
    // Gardée si elle est valide, sinon celle par défaut
    expect(parseSettings(JSON.stringify({ fxLook: "simple" })).fxLook).toBe("simple");
    expect(parseSettings(JSON.stringify({ fxLook: "volumétrique" })).fxLook).toBe("realistic");
    expect(parseSettings(JSON.stringify({ fxLook: 1 })).fxLook).toBe("realistic");
  });

  it("des réglages d'avant la fumée réaliste restent sur leur préréglage", () => {
    // Le préréglage « Basse » d'avant (sans l'allure) reste « Basse » : la fumée simple
    const { fxLook: _low, ...low } = { ...DEFAULT_SETTINGS, ...GRAPHICS_PRESETS.low };
    const oldLow = parseSettings(JSON.stringify(low));
    expect(oldLow.fxLook).toBe("simple");
    expect(graphicsPreset(oldLow)).toBe("low");
    // Les autres passent à la fumée réaliste, et restent sur leur préréglage
    const { fxLook: _high, ...high } = { ...DEFAULT_SETTINGS, ...GRAPHICS_PRESETS.high };
    const oldHigh = parseSettings(JSON.stringify(high));
    expect(oldHigh.fxLook).toBe("realistic");
    expect(graphicsPreset(oldHigh)).toBe("high");
  });

  it("garde les réglages d'éclairage, et ignore une valeur qui n'est pas un booléen", () => {
    const s = parseSettings(JSON.stringify({ glow: false, lights: false, heatHaze: "oui" }));
    expect(s.glow).toBe(false);
    expect(s.lights).toBe(false);
    expect(s.heatHaze).toBe(DEFAULT_SETTINGS.heatHaze);
  });

  it("au premier lancement, les graphismes les plus légers sur un téléphone ou une petite machine, les moyens ailleurs", () => {
    // Un téléphone : un doigt, un petit écran, quelle que soit sa puissance
    expect(firstRunPreset({ coarse: true, screen: 390, memory: 8, cores: 8 })).toBe("low");
    expect(firstRunPreset({ coarse: true, screen: 412 })).toBe("low");
    // Une tablette : légère si elle est modeste, moyenne sinon (mémoire inconnue : Safari)
    expect(firstRunPreset({ coarse: true, screen: 820, memory: 4, cores: 8 })).toBe("low");
    expect(firstRunPreset({ coarse: true, screen: 820, cores: 4 })).toBe("low");
    expect(firstRunPreset({ coarse: true, screen: 1024, memory: 8, cores: 8 })).toBe("medium");
    expect(firstRunPreset({ coarse: true, screen: 1024 })).toBe("medium");
    // Un ordinateur : moyen, sauf une très petite machine
    expect(firstRunPreset({ coarse: false, screen: 1080, memory: 8, cores: 8 })).toBe("medium");
    expect(firstRunPreset({ coarse: false, screen: 1080, memory: 4, cores: 4 })).toBe("medium");
    expect(firstRunPreset({ coarse: false, screen: 768 })).toBe("medium");
    expect(firstRunPreset({ coarse: false, screen: 768, memory: 2 })).toBe("low");
    expect(firstRunPreset({ coarse: false, screen: 768, cores: 2 })).toBe("low");
    // Les réglages par défaut de cette machine : ceux de toujours, aux graphismes choisis (et au lecteur de musique du doigt)
    const phone = defaultSettings({ coarse: true, screen: 390 });
    expect(graphicsPreset(phone)).toBe("low");
    expect({ ...phone, ...GRAPHICS_PRESETS.medium, musicPlayer: DEFAULT_SETTINGS.musicPlayer }).toEqual(DEFAULT_SETTINGS);
    expect(defaultSettings({ coarse: false, screen: 1080, memory: 8, cores: 8 })).toEqual(DEFAULT_SETTINGS);
  });

  it("le lecteur de musique : au doigt, il se réduit tout seul ; sur ordinateur, toujours affiché ; des réglages d'avant prennent celui de la machine", () => {
    const phone = { coarse: true, screen: 390 };
    const tablet = { coarse: true, screen: 1024, memory: 8, cores: 8 };
    const desktop = { coarse: false, screen: 1080 };
    expect(defaultMusicPlayer(phone)).toBe("auto");
    expect(defaultMusicPlayer(tablet)).toBe("auto");
    expect(defaultMusicPlayer(desktop)).toBe("always");
    expect(DEFAULT_SETTINGS.musicPlayer).toBe("always");
    expect(defaultSettings(phone).musicPlayer).toBe("auto");
    expect(defaultSettings(tablet).musicPlayer).toBe("auto");
    expect(defaultSettings(desktop).musicPlayer).toBe("always");
    // Des réglages enregistrés avant ce réglage : celui de la machine, le reste gardé
    const old = JSON.stringify({ volume: 0.4, music: 0.3, touchAim: "stick" });
    expect(parseSettings(old, phone)).toMatchObject({ volume: 0.4, music: 0.3, touchAim: "stick", musicPlayer: "auto" });
    expect(parseSettings(old, desktop)).toMatchObject({ volume: 0.4, music: 0.3, musicPlayer: "always" });
    // (sans machine donnée, hors du navigateur : un ordinateur)
    expect(parseSettings(old).musicPlayer).toBe("always");
    // Le choix du joueur est gardé, quelle que soit la machine ; une valeur inconnue prend celui de la machine
    for (const mode of ["always", "auto", "hidden"] as const) {
      expect(parseSettings(JSON.stringify({ musicPlayer: mode }), phone).musicPlayer).toBe(mode);
      expect(parseSettings(JSON.stringify({ musicPlayer: mode }), desktop).musicPlayer).toBe(mode);
    }
    expect(parseSettings(JSON.stringify({ musicPlayer: "mini" }), phone).musicPlayer).toBe("auto");
    expect(parseSettings(JSON.stringify({ musicPlayer: 2 }), desktop).musicPlayer).toBe("always");
    // Enregistré puis relu : le même
    const s = { ...defaultSettings(phone), musicPlayer: "hidden" as const };
    expect(parseSettings(JSON.stringify(s), desktop)).toMatchObject({ musicPlayer: "hidden" });
  });

  it("le jeu au doigt : par défaut, visée en glissant, viseur qui bascule ; des réglages d'avant restent lisibles", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      touchAim: "swipe", touchSensitivity: 1, touchStickSensitivity: 1, touchInvertY: false,
      touchScopeToggle: true, touchSize: 1, touchOpacity: 1, touchLeftHanded: false,
    });
    // Des réglages enregistrés avant l'onglet Tactile : celui-ci par défaut, le reste gardé
    const old = parseSettings(JSON.stringify({ sensitivity: 1.4, drive: "tank", scopeToggle: false }));
    expect(old).toMatchObject({ sensitivity: 1.4, drive: "tank", scopeToggle: false, touchAim: "swipe", touchScopeToggle: true, touchSize: 1 });
    // Gardés s'ils sont valides, bornés, sinon ceux par défaut
    const s = parseSettings(JSON.stringify({
      touchAim: "stick", touchSensitivity: 2.2, touchStickSensitivity: 9, touchInvertY: true,
      touchScopeToggle: false, touchSize: 0.2, touchOpacity: 0.55, touchLeftHanded: true,
    }));
    expect(s).toMatchObject({
      touchAim: "stick", touchSensitivity: 2.2, touchStickSensitivity: 3, touchInvertY: true,
      touchScopeToggle: false, touchSize: 0.7, touchOpacity: 0.55, touchLeftHanded: true,
    });
    const bad = parseSettings(JSON.stringify({ touchAim: "gyro", touchSensitivity: "vite", touchOpacity: Infinity, touchLeftHanded: 1 }));
    expect(bad).toMatchObject({ touchAim: "swipe", touchSensitivity: 1, touchOpacity: 1, touchLeftHanded: false });
  });

  it("le moteur de rendu : WebGL par défaut, WebGPU gardé, une valeur inconnue ignorée ; l'adresse peut l'imposer", () => {
    expect(parseSettings(null).renderer).toBe("webgl");
    expect(parseSettings(JSON.stringify({ renderer: "webgpu" })).renderer).toBe("webgpu");
    expect(parseSettings(JSON.stringify({ renderer: "vulkan" })).renderer).toBe("webgl");
    expect(requestedRenderer("webgl", "?renderer=webgpu")).toBe("webgpu");
    expect(requestedRenderer("webgpu", "?sim=page&renderer=webgl")).toBe("webgl");
    expect(requestedRenderer("webgpu", "?renderer=metal")).toBe("webgpu");
    expect(requestedRenderer("webgl", "")).toBe("webgl");
  });
});
