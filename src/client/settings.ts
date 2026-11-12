import { detectLocale, isLocale, type Locale } from "./i18n/state";
import { BINDINGS_VERSION, DEFAULT_BINDINGS, migrateBindings, type Bindings } from "./input/bindings";

/**
 * Moteur de rendu (render/engine.ts) : WebGPU (si le navigateur le permet, sinon WebGL) ou WebGL.
 * Pris au chargement de la page.
 */
export const RENDERERS = ["webgpu", "webgl"] as const;
export type Renderer = (typeof RENDERERS)[number];
/** Le rendu demandé par l'adresse de la page (`?renderer=webgpu`, `?renderer=webgl`), sinon celui des réglages. */
export function requestedRenderer(chosen: Renderer, search = typeof location === "undefined" ? "" : location.search): Renderer {
  const forced = new URLSearchParams(search).get("renderer");
  return forced === "webgpu" || forced === "webgl" ? forced : chosen;
}
/** Qualité des ombres : taille de la carte d'ombre et finesse du filtrage. */
export const SHADOW_QUALITIES = ["low", "medium", "high"] as const;
export type ShadowQuality = (typeof SHADOW_QUALITIES)[number];
/** Échelles de rendu proposées (part de la résolution de l'écran). */
export const RENDER_SCALES = [0.5, 0.75, 1] as const;
/** Effets : complets, ou réduits (moins d'effets à l'écran en même temps). */
export const EFFECT_LEVELS = ["full", "reduced"] as const;
export type EffectLevel = (typeof EFFECT_LEVELS)[number];
/** Fumée et flammes : réalistes (volutes éclairées, flammes animées) ou simples (des sphères, plus légères). */
export const FX_LOOKS = ["realistic", "simple"] as const;
export type FxLook = (typeof FX_LOOKS)[number];
/**
 * Direction au sol et en vol stationnaire : au clavier (de char ; un robot volant ne pivote qu'au
 * lacet) ou à la caméra, comme dans Robocraft (le robot va vers où elle regarde, un robot volant se
 * tourne vers elle).
 */
export const DRIVE_MODES = ["tank", "camera"] as const;
export type DriveMode = (typeof DRIVE_MODES)[number];
/**
 * Avion : à la souris (il va là où l'on regarde, comme dans Robocraft ; les gaz à part) ou manuel
 * (le manche au clavier). L'ancien pilotage assisté (« assisted ») est devenu celui à la souris.
 */
export const FLIGHT_MODES = ["mouse", "manual"] as const;
export type FlightMode = (typeof FLIGHT_MODES)[number];
/** Bornes du champ de vision vertical (degrés) et de la sensibilité de la souris. */
export const FOV_RANGE = { min: 38, max: 70 } as const;
export const SENSITIVITY_RANGE = { min: 0.25, max: 3 } as const;
/** Bornes de la zone morte des sticks de la manette (part de leur course). */
export const DEADZONE_RANGE = { min: 0.05, max: 0.4 } as const;
/**
 * Visée au doigt : en glissant le doigt sur l'écran (comme les jeux de tir sur téléphone), ou avec
 * un second manche à droite, qui tourne la caméra en vitesse comme le stick droit d'une manette
 * (glisser ailleurs sur l'écran la tourne toujours : voir input/touchPad.ts).
 */
export const TOUCH_AIMS = ["swipe", "stick"] as const;
export type TouchAim = (typeof TOUCH_AIMS)[number];
/** Bornes de la taille des commandes à l'écran (1 : celle d'origine) et de leur opacité. */
export const TOUCH_SIZE_RANGE = { min: 0.7, max: 1.4 } as const;
export const TOUCH_OPACITY_RANGE = { min: 0.3, max: 1 } as const;

/** Réglages du joueur, gardés dans le navigateur d'une visite à l'autre. */
export interface Settings {
  // --- Graphismes ---
  /** Moteur de rendu (render/engine.ts) : pris au chargement de la page. */
  renderer: Renderer;
  /** Ombres portées (coûteuses sur les petites machines). */
  shadows: boolean;
  shadowQuality: ShadowQuality;
  /** Part de la résolution de l'écran à laquelle l'image est calculée (1 : pleine résolution). */
  renderScale: number;
  effects: EffectLevel;
  /** Allure de la fumée et des flammes (render/fx/sprites.ts). */
  fxLook: FxLook;
  /** Halo autour de ce qui brille (flammes, lasers, traçantes, voyants). */
  glow: boolean;
  /** Brèves lumières des explosions et des gros coups de canon, lueur des feux. */
  lights: boolean;
  /** Distorsion de l'air chaud au-dessus des feux et derrière les tuyères (coûteuse). */
  heatHaze: boolean;
  /** Champ de vision vertical de la caméra (degrés). */
  fov: number;
  /** Compteur d'images par seconde, dans un coin de l'écran. */
  showFps: boolean;
  // --- Contrôles ---
  /** Regard à la souris : vitesse (1 : normale), et axes inversés. */
  sensitivity: number;
  invertX: boolean;
  invertY: boolean;
  /** Viseur : clic droit à maintenir (false) ou qui bascule (true). */
  scopeToggle: boolean;
  /** Direction au sol et en vol stationnaire : au clavier (de char) ou à la caméra. */
  drive: DriveMode;
  /** Pilotage de l'avion (sa touche le bascule en vol). */
  flight: FlightMode;
  /** Touches choisies : deux par action au clavier et à la souris, une à la manette (input/bindings.ts). */
  bindings: Bindings;
  /** Version de la table des touches de ces réglages (`BINDINGS_VERSION` ; absente : 1), pour reprendre celles par défaut qui ont changé. */
  bindingsVersion: number;
  /** Manette : regard au stick droit (vitesse, axes inversés), et zone morte des sticks. */
  padSensitivity: number;
  padInvertX: boolean;
  padInvertY: boolean;
  padDeadzone: number;
  // --- Tactile (en jouant au doigt) ---
  /** Visée : en glissant le doigt, ou au manche de visée. */
  touchAim: TouchAim;
  /** Sensibilité du glissé (1 : normale ; input/touchLook.ts) et du manche de visée. */
  touchSensitivity: number;
  touchStickSensitivity: number;
  /** Axe vertical inversé : glisser (ou pousser le manche) vers le haut fait regarder vers le bas. */
  touchInvertY: boolean;
  /** Bouton du viseur : un appui le met, un autre l'enlève (true), ou à tenir (false). */
  touchScopeToggle: boolean;
  /** Taille des commandes à l'écran (1 : celle d'origine), et leur opacité (1 : opaques). */
  touchSize: number;
  touchOpacity: number;
  /** Gaucher : le manche de déplacement à droite, la visée et les boutons à gauche. */
  touchLeftHanded: boolean;
  // --- Son ---
  sound: boolean;
  /** Volume général (0 à 1). */
  volume: number;
  /** Volume de la musique (0 à 1), par-dessus le volume général. */
  music: number;
  // --- Profil ---
  /** Langue des textes du jeu (i18n/) ; par défaut, celle du navigateur. */
  language: Locale;
  /** Bac à sable : toutes les pièces du garage sont disponibles, sans crédits. */
  allParts: boolean;
  /** Affiche le nom des sons joués (pour repérer un son et le régler). */
  soundLog: boolean;
  /** Multijoueur : nom du joueur, et adresse du serveur (vide : celui de la page, port par défaut). */
  name: string;
  server: string;
}

/** Les réglages qui sont des nombres (curseurs), et ceux qui sont des interrupteurs. */
export type NumberSetting = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BooleanSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

/** Les langues préférées du navigateur (aucune hors du navigateur : les tests). */
function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  renderer: "webgl",
  shadows: true,
  shadowQuality: "medium",
  renderScale: 1,
  effects: "full",
  fxLook: "realistic",
  glow: true,
  lights: true,
  heatHaze: false,
  fov: 46,
  showFps: false,
  sensitivity: 1,
  invertX: false,
  invertY: false,
  scopeToggle: false,
  drive: "camera",
  flight: "mouse",
  bindings: DEFAULT_BINDINGS,
  bindingsVersion: BINDINGS_VERSION,
  padSensitivity: 1,
  padInvertX: false,
  padInvertY: false,
  padDeadzone: 0.15,
  touchAim: "swipe",
  touchSensitivity: 1,
  touchStickSensitivity: 1,
  touchInvertY: false,
  // (au doigt, tenir le viseur bloquerait le pouce qui vise : il bascule, comme dans les jeux de tir sur téléphone)
  touchScopeToggle: true,
  touchSize: 1,
  touchOpacity: 1,
  touchLeftHanded: false,
  sound: true,
  volume: 0.8,
  music: 0.5,
  language: detectLocale(browserLanguages()),
  allParts: false,
  soundLog: false,
  name: "",
  server: "",
};

/** Préréglages graphiques : ce qu'ils fixent, du plus léger au plus beau. */
export const GRAPHICS_PRESETS = {
  low: { shadows: false, shadowQuality: "low", renderScale: 0.75, effects: "reduced", fxLook: "simple", glow: false, lights: false, heatHaze: false },
  medium: { shadows: true, shadowQuality: "medium", renderScale: 1, effects: "full", fxLook: "realistic", glow: true, lights: true, heatHaze: false },
  high: { shadows: true, shadowQuality: "high", renderScale: 1, effects: "full", fxLook: "realistic", glow: true, lights: true, heatHaze: true },
} as const satisfies Record<string, Pick<Settings, "shadows" | "shadowQuality" | "renderScale" | "effects" | "fxLook" | "glow" | "lights" | "heatHaze">>;
export type GraphicsPreset = keyof typeof GRAPHICS_PRESETS;

/** Le préréglage auquel correspondent ces réglages, ou null (réglages personnalisés). */
export function graphicsPreset(s: Settings): GraphicsPreset | null {
  for (const [id, preset] of Object.entries(GRAPHICS_PRESETS) as [GraphicsPreset, (typeof GRAPHICS_PRESETS)[GraphicsPreset]][]) {
    // Sans ombres, leur qualité n'importe pas
    const shadowsMatch = s.shadows === preset.shadows && (!s.shadows || s.shadowQuality === preset.shadowQuality);
    const lightMatch = s.glow === preset.glow && s.lights === preset.lights && s.heatHaze === preset.heatHaze;
    if (shadowsMatch && lightMatch && s.renderScale === preset.renderScale && s.effects === preset.effects && s.fxLook === preset.fxLook) return id;
  }
  return null;
}

/** Ce qu'on sait de la machine, pour choisir les graphismes du premier lancement. */
export interface DeviceInfo {
  /** Le pointeur principal est un doigt (téléphone, tablette). */
  coarse: boolean;
  /** Plus petit côté de l'écran (px CSS). */
  screen: number;
  /** Mémoire (Go : `navigator.deviceMemory`, de 0,25 à 8 ; absente : inconnue, Firefox et Safari ne la donnent pas). */
  memory?: number;
  /** Cœurs du processeur (`navigator.hardwareConcurrency`). */
  cores?: number;
}

/** Un téléphone : un doigt, et un écran dont le plus petit côté ne dépasse pas cette taille (px CSS). */
const PHONE_SCREEN = 600;

/**
 * Le préréglage graphique du premier lancement : le plus léger sur un téléphone, sur une tablette
 * modeste (4 Go de mémoire ou 4 cœurs au plus) et sur une très petite machine (2 Go ou 2 cœurs) ;
 * le moyen ailleurs (celui par défaut).
 */
export function firstRunPreset(device: DeviceInfo): GraphicsPreset {
  const memory = device.memory ?? Infinity;
  const cores = device.cores ?? Infinity;
  if (device.coarse && (device.screen <= PHONE_SCREEN || memory <= 4 || cores <= 4)) return "low";
  if (memory <= 2 || cores <= 2) return "low";
  return "medium";
}

/** La machine de ce navigateur (hors du navigateur : un ordinateur ordinaire). */
export function deviceInfo(): DeviceInfo {
  if (typeof window === "undefined") return { coarse: false, screen: 1080 };
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    coarse: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    screen: Math.min(window.screen?.width ?? 1080, window.screen?.height ?? 1080),
    memory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
    cores: typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : undefined,
  };
}

/** Les réglages par défaut pour cette machine : ceux de `DEFAULT_SETTINGS`, aux graphismes de `firstRunPreset`. */
export function defaultSettings(device: DeviceInfo = deviceInfo()): Settings {
  return { ...DEFAULT_SETTINGS, ...GRAPHICS_PRESETS[firstRunPreset(device)] };
}

const KEY = "casse-robot.settings";

/**
 * Réglages lus depuis un texte JSON : chaque valeur absente, du mauvais type ou hors de ses choix
 * reprend sa valeur par défaut (réglages d'une ancienne version, stockage abîmé).
 */
export function parseSettings(json: string | null): Settings {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(json ?? "{}");
    if (parsed && typeof parsed === "object") saved = parsed as Record<string, unknown>;
  } catch {
    // Texte illisible : réglages par défaut
  }
  const s: Settings = { ...DEFAULT_SETTINGS };
  const bool = (key: BooleanSetting): void => {
    const v = saved[key];
    if (typeof v === "boolean") s[key] = v;
  };
  const text = (key: "name" | "server"): void => {
    const v = saved[key];
    if (typeof v === "string") s[key] = v;
  };
  const number = (key: NumberSetting, min: number, max: number): void => {
    const v = saved[key];
    if (typeof v === "number" && Number.isFinite(v)) s[key] = Math.min(max, Math.max(min, v));
  };
  const pick = <T extends string | number>(choices: readonly T[], v: unknown): T | undefined => choices.find((c) => c === v);
  for (const key of [
    "shadows", "glow", "lights", "heatHaze", "showFps", "invertX", "invertY", "scopeToggle", "sound", "allParts", "soundLog", "padInvertX", "padInvertY",
    "touchInvertY", "touchScopeToggle", "touchLeftHanded",
  ] as const) bool(key);
  text("name");
  text("server");
  number("fov", FOV_RANGE.min, FOV_RANGE.max);
  number("sensitivity", SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max);
  number("volume", 0, 1);
  number("music", 0, 1);
  number("padSensitivity", SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max);
  number("padDeadzone", DEADZONE_RANGE.min, DEADZONE_RANGE.max);
  number("touchSensitivity", SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max);
  number("touchStickSensitivity", SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max);
  number("touchSize", TOUCH_SIZE_RANGE.min, TOUCH_SIZE_RANGE.max);
  number("touchOpacity", TOUCH_OPACITY_RANGE.min, TOUCH_OPACITY_RANGE.max);
  // Touches : celles d'avant ces réglages (absentes) sont celles par défaut ; d'une version
  // précédente de la table, celles par défaut qui ont changé sont reprises (`migrateBindings`)
  const version = typeof saved.bindingsVersion === "number" && Number.isFinite(saved.bindingsVersion) ? saved.bindingsVersion : 1;
  s.bindings = migrateBindings(saved.bindings, version);
  s.bindingsVersion = BINDINGS_VERSION;
  s.renderer = pick(RENDERERS, saved.renderer) ?? s.renderer;
  s.shadowQuality = pick(SHADOW_QUALITIES, saved.shadowQuality) ?? s.shadowQuality;
  s.renderScale = pick(RENDER_SCALES, saved.renderScale) ?? s.renderScale;
  s.effects = pick(EFFECT_LEVELS, saved.effects) ?? s.effects;
  // (des réglages d'avant celui-ci : la fumée et les flammes réalistes, sauf au préréglage le plus léger)
  s.fxLook = pick(FX_LOOKS, saved.fxLook) ?? (saved.effects === "reduced" && saved.glow === false ? "simple" : s.fxLook);
  s.drive = pick(DRIVE_MODES, saved.drive) ?? s.drive;
  s.touchAim = pick(TOUCH_AIMS, saved.touchAim) ?? s.touchAim;
  // L'ancien pilotage assisté : à la souris
  s.flight = pick(FLIGHT_MODES, saved.flight === "assisted" ? "mouse" : saved.flight) ?? s.flight;
  if (isLocale(saved.language)) s.language = saved.language;
  return s;
}

/**
 * Les réglages enregistrés ; au premier lancement (rien d'enregistré), ceux par défaut pour cette
 * machine (un téléphone part sur les graphismes les plus légers). Le stockage du navigateur peut
 * être indisponible (navigation privée) : on retombe alors sur les réglages par défaut.
 */
export function loadSettings(): Settings {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === null ? defaultSettings() : parseSettings(saved);
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Pas de stockage : le réglage vaut pour cette visite seulement
  }
}
