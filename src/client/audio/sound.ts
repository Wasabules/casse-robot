import type * as B from "../babylon";
import { blockDef } from "../../shared/catalog/blocks";
import { propDef, type PropType } from "../../shared/catalog/props";
import { wheelDef } from "../../shared/catalog/wheels";
import { weaponDef, type ExplosionLook, type WeaponId } from "../../shared/catalog/weapons";
import { meleeDef, type MeleeId, type MeleeSpec } from "../../shared/catalog/melee";
import type { MeleeArm, SwingPhase } from "../../shared/sim/entities";
import { clamp } from "../../shared/math/scalar";
import { add, distance, dot, norm, scale, sub, type Vec3 } from "../../shared/math/vec";
import { blockWorldPos, drivenWheels, integrity } from "../../shared/robot/queries";
import { energyFraction } from "../../shared/robot/energy";
import type { Block, Bot, GroundFire, Projectile, Prop } from "../../shared/sim/entities";
import type { ImpactSurface, SimEvent } from "../../shared/sim/events";
import type { World } from "../../shared/sim/world";
import { Music, type MusicListener, type MusicNow, type MusicTheme } from "./music";
import { cueAllowed, soundScene, STINGER_DUCK, type SoundScene, type SoundScreen } from "./soundScene";
import { canPlayOpus, LOOP_PAD, mendForeignLoop, SampleBank, SAMPLES, type SampleKey } from "./samples";
import type { MapAsset } from "../../shared/arena/layout";
import { PACKAGE_FILES } from "../../shared/map/pack";
import { mapAssets } from "../maps/assets";
// (en espace de noms : `t` est ici le temps)
import * as i18n from "../i18n/i18n";

/*
 * Sons du jeu, placés dans l'espace : chaque son part de son point dans l'arène, l'auditeur suit
 * la caméra. Les événements de la simulation (tirs, impacts, explosions, chocs…) déclenchent des
 * sons brefs ; des sons en boucle suivent ce qui dure : le moteur des robots les plus proches
 * (selon ce qui les fait avancer : roues, chenilles, pattes, patins, rotors, hélice), les armes à
 * tir continu, les projectiles en vol (avec l'effet Doppler), les feux, et l'ambiance de l'arène.
 * Les sons enregistrés (audio/samples.ts) sont joués dès qu'ils sont chargés ; jusque-là, ou si
 * le navigateur ne lit pas l'Opus, chaque son a son équivalent synthétisé avec Web Audio.
 */

/**
 * Un son enregistré d'une arme de contact : sa clé (un son de `SAMPLES`), ou sa clé avec une hauteur
 * (`rate` : un son fait pour autre chose, joué plus grave ou plus aigu) et un volume relatif (`gain`).
 */
type MeleeSample = SampleKey | { readonly key: SampleKey; readonly rate?: number; readonly gain?: number };

/** Clé, hauteur et volume relatif d'un son d'arme de contact. */
function meleeSample(s: MeleeSample): { key: SampleKey; rate: number; gain: number } {
  return typeof s === "string" ? { key: s, rate: 1, gain: 1 } : { key: s.key, rate: s.rate ?? 1, gain: s.gain ?? 1 };
}

/**
 * Armes de contact (shared/combat/melee.ts) : leurs sons enregistrés (des sons de `SAMPLES`, générés
 * comme les autres : voir tools/sounds) ; null : le jeu le synthétise (et il le synthétise aussi tant
 * qu'un fichier n'est pas chargé). `whine` : le sifflement d'un rotor (ou le bourdon d'une arme
 * d'énergie, le tournoiement d'un fléau), en boucle, plus aigu et plus fort avec le régime ; `hit` :
 * le coup de la lame ou de la tête, plus fort et plus grave avec son énergie (une boucle, comme la
 * découpe de la lame laser, dure tant que les coups se suivent) ; `swing` : le bras qui part (le
 * vérin qui se détend, le fouet qui claque, la lance qui sort) ; `crush` : une mâchoire qui écrase ce
 * qu'elle tient (une boucle, tenue tant que les tranches d'écrasement se suivent). TypeScript refuse
 * une arme sans les siens.
 */
interface MeleeSounds {
  whine: MeleeSample | null;
  hit: MeleeSample | null;
  swing: MeleeSample | null;
  crush?: MeleeSample | null;
  /** Voix synthétisée de secours de la boucle (`whine`) ; sans elle, le sifflement d'une toupie (`WHINE`). */
  tone?: RotorTone;
  /** Une lame qui mord : la coupe qui grince, en boucle, plus forte avec sa puissance. */
  bite?: MeleeSample | null;
}

/**
 * Boucle synthétisée d'une arme qui tourne (deux oscillateurs filtrés) : fréquence (Hz) à l'arrêt et
 * par rad/s de régime, forme d'onde, rapport de la seconde voix à la première, filtre (sorte, rapport
 * de sa fréquence à celle de la voix, résonance), volume à plein régime, battement (Hz : le volume
 * tremble ; 0 : rien). Une lame qui mord a aussi le grincement de sa coupe (`grind`) : un bruit
 * filtré autour de `freq` Hz (résonance `q`), à `level` pour GRIND_POWER kW de coupe, qui tremble
 * (les dents accrochent).
 */
interface RotorTone {
  base: number;
  perRad: number;
  wave: OscillatorType;
  overtone: number;
  filter: BiquadFilterType;
  cutoff: number;
  q: number;
  level: number;
  beat: number;
  grind?: { freq: number; q: number; level: number };
}

/** Une scie : un sifflement aigu (2,8 kHz à plein régime), qui grince en mordant (et descend quand le régime baisse sous la charge). */
const SAW_TONE: RotorTone = {
  base: 220, perRad: 17, wave: "sawtooth", overtone: 2.01, filter: "bandpass", cutoff: 1.2, q: 5, level: 0.05, beat: 0,
  grind: { freq: 3600, q: 1.6, level: 0.2 },
};
/** Une foreuse : un grondement grave (le volant derrière son réducteur), qui broie en mordant. */
const DRILL_TONE: RotorTone = {
  base: 34, perRad: 1.3, wave: "sawtooth", overtone: 2.01, filter: "lowpass", cutoff: 4, q: 1.2, level: 0.12, beat: 0,
  grind: { freq: 380, q: 0.8, level: 0.32 },
};

/** Allure d'une arme de contact (elle choisit son coup synthétisé). */
type MeleeLook = MeleeSpec["look"];

/** Sifflement d'une toupie : une barre d'acier qui fend l'air, plus aigu avec le régime. */
const WHINE: RotorTone = { base: 90, perRad: 15, wave: "sawtooth", overtone: 2.01, filter: "bandpass", cutoff: 1.4, q: 3, level: 0.07, beat: 0 };

/*
 * Armes d'énergie : la lame laser bourdonne (un sabre : grave, une quinte au-dessus, qui monte un peu
 * avec sa charge et ondule), le champ broyeur vrombit (un bourdon carré, qui bat). Leurs coups (la
 * lame qui grésille, le fouet qui claque, la lance qui crépite, le champ qui crache) et leurs départs
 * ont aussi leur version synthétisée, dans `meleeHit` et `updateMelee`.
 *
 * Sons empruntés : le coup du plateau d'un flipper et celui d'une mâchoire qui saisit sont le choc
 * d'un robot (« collision » : leur départ, le vérin ou le claquement des mâchoires, a son son à lui) ;
 * le champ broyeur qu'on touche, l'impact sur un bouclier, plus grave ; l'hélice tranchante siffle
 * avec son moteur (`propeller-big`), seul le coup de ses pales est à elle. La scie et la foreuse
 * mordent au lieu de frapper (pas de `meleeHit`) : leur coupe est `bite`.
 */
const MELEE_SOUNDS: Record<MeleeId, MeleeSounds> = {
  spinner: { whine: "spinner-whine", hit: "spinner-hit", swing: null },
  hammer: { whine: null, hit: "hammer-hit", swing: "hammer-swing" },
  verticalSpinner: { whine: "disc-whine", hit: "disc-hit", swing: null },
  drum: { whine: "drum-whine", hit: "drum-hit", swing: null },
  shellSpinner: { whine: "shell-whine", hit: "shell-hit", swing: null },
  propeller: { whine: null, hit: "propeller-hit", swing: null },
  flipper: { whine: null, hit: { key: "collision", rate: 0.9 }, swing: "flipper-swing" },
  flail: { whine: "flail-whirl", hit: "flail-hit", swing: null },
  // (le claquement enregistré est aigu pour des mâchoires de ce poids : joué plus grave)
  jaw: { whine: null, hit: { key: "collision", rate: 1.1, gain: 0.8 }, swing: { key: "jaw-swing", rate: 0.85 }, crush: "jaw-crush" },
  laserBlade: {
    whine: "saber-hum", hit: "saber-cut", swing: null,
    tone: { base: 72, perRad: 1.8, wave: "sawtooth", overtone: 1.5, filter: "lowpass", cutoff: 4, q: 2, level: 0.12, beat: 7 },
  },
  plasmaWhip: { whine: null, hit: "whip-hit", swing: "whip-swing" },
  shockLance: { whine: null, hit: "lance-hit", swing: "lance-swing" },
  crusherField: {
    whine: "field-hum", hit: { key: "shield-hit", rate: 0.8 }, swing: null,
    tone: { base: 46, perRad: 2, wave: "square", overtone: 3.01, filter: "bandpass", cutoff: 5, q: 5, level: 0.09, beat: 5 },
  },
  saw: { whine: "saw-whine", hit: null, swing: null, bite: "saw-bite", tone: SAW_TONE },
  drill: { whine: "drill-whine", hit: null, swing: null, bite: "drill-bite", tone: DRILL_TONE },
};
/**
 * Un coup ou un écrasement joué en boucle (la découpe de la lame laser, toutes les 0,08 s au plus ;
 * l'écrasement d'une mâchoire, toutes les 0,25 s) se tait ce temps (s) après le dernier : assez pour
 * ne pas se couper entre deux.
 */
const MELEE_HOLD = 0.35;
/**
 * Sous le coup enregistré d'une lourde masse d'acier (d'au moins 0,45 kJ), un coup sourd synthétisé
 * de cette fréquence (Hz ; plus grave au sol), plus fort avec l'énergie : les enregistrements ont peu
 * de graves, et le choc doit se sentir.
 */
const STEEL_THUMP: Partial<Record<MeleeLook, number>> = { bar: 70, disc: 80, drum: 95, shell: 55, hammer: 65, flail: 75 };
/** Sifflement synthétisé de la boule d'un fléau : volume à plein régime (il passe deux fois par tour près de l'oreille). */
const FLAIL_LEVEL = 0.09;
/** Sous la chaîne enregistrée (des aigus seulement), ce souffle grave garde cette part de son volume. */
const FLAIL_UNDER = 0.6;
/** Une tranche d'écrasement d'une mâchoire s'annonce avec moins d'énergie que cela (J) : un broiement, pas un claquement. */
const CRUSH_BELOW = 500;
/** Rotors entendus à la fois (les plus proches), et l'intervalle entre deux choix (s). */
const MELEE_VOICES = 3;
const MELEE_PICK = 0.25;
/** Puissance de coupe (kW) d'une morsure qui grince à plein volume. */
const GRIND_POWER = 3;

/** Au-delà de cette distance (m), un son bref n'est pas joué. */
const HEARING = 90;
/** Sons brefs simultanés au plus : au-delà, les nouveaux sont ignorés. */
const MAX_VOICES = 32;
/** Fondus des bus du monde et de l'ambiance quand l'écran change : ils se taisent vite, reviennent en douceur (constantes de temps, s). */
const SCENE_FADE_OUT = 0.08;
const SCENE_FADE_IN = 0.35;
/** Variation de hauteur d'un son enregistré à l'autre (±4 %) : une rafale ne sonne pas mécanique. */
const PITCH_SPREAD = 0.08;
/** Au plus un bruit d'impact enregistré tous les IMPACT_GAP s : une rafale touche plusieurs fois par pas. */
const IMPACT_GAP = 0.04;
/** Nombre de moteurs entendus en même temps (les robots les plus proches). */
const ENGINE_VOICES = 5;
/** Les moteurs, projectiles en vol et feux entendus sont choisis à nouveau à cette cadence (s). */
const ENGINE_PICK = 0.3;
const FLIGHT_PICK = 0.1;
/** Projectiles en vol entendus en même temps, et jusqu'où (m). */
const FLIGHT_VOICES = 8;
const FLIGHT_HEARING = 110;
/** Armes à tir continu entendues en même temps ; le son se tait HOLD s après le dernier tir. */
const SUSTAIN_VOICES = 4;
const SUSTAIN_HOLD = 0.18;
/** Feux entendus en même temps. */
const FIRE_VOICES = 3;
/** Vitesse du son (m/s), pour l'effet Doppler d'un projectile qui passe. */
const SOUND_SPEED = 343;
/** Une balle qui passe à moins de FLYBY_RADIUS m de la caméra ou du robot du joueur siffle à l'oreille. */
const FLYBY_RADIUS = 3;
const FLYBY_GAP = 0.06;
/** Volume de l'ambiance de l'arène (non spatialisée). */
const AMBIENCE_LEVEL = 1;
/** Alertes du robot du joueur : intégrité critique (part de ses blocs de départ), batteries presque vides, et leur rythme (s). */
const CRITICAL_INTEGRITY = 0.35;
const CRITICAL_EVERY = 3;
const LOW_BATTERY = 0.15;
const BATTERY_EVERY = 4;
/** Alerte missile : un missile ennemi à moins de WARNING_RANGE m qui file vers le robot du joueur (cosinus de l'écart). */
const WARNING_RANGE = 45;
const WARNING_AIM = 0.85;
const WARNING_EVERY = 0.9;
/** Missiles et roquettes guidés qui déclenchent l'alerte. */
const GUIDED: ReadonlySet<WeaponId> = new Set<WeaponId>(["missile", "lockon", "rockets", "warhead", "flak"]);
/** Accessoires qui sifflent (mèche d'un baril, gaz d'une bouteille percée) entendus en même temps. */
const PROP_VOICES = 3;
/** Au plus un son de réapparition tous les RESPAWN_GAP s (toute une équipe apparaît d'un coup). */
const RESPAWN_GAP = 0.25;
/**
 * Tirs du joueur : un tir qui part à moins de OWN_SHOT_RADIUS m d'une de ses tourelles est le sien,
 * joué sans spatialisation (la caméra est à une dizaine de mètres : il s'entendait à moitié), à ce volume.
 */
const OWN_SHOT_RADIUS = 1.5;
const OWN_SHOT_GAIN = 0.7;

/** Timbre d'un tir synthétisé : bruit filtré (fréquence, type de filtre, durée, volume) et coup sourd éventuel. */
interface ShotTone {
  freq: number;
  filter: BiquadFilterType;
  decay: number;
  gain: number;
  thump?: number;
}

const SHOT_TONES: Record<WeaponId, ShotTone> = {
  rifle: { freq: 1400, filter: "highpass", decay: 0.07, gain: 0.3 },
  sniper: { freq: 900, filter: "highpass", decay: 0.25, gain: 0.55, thump: 110 },
  cannon: { freq: 500, filter: "lowpass", decay: 0.4, gain: 0.8, thump: 55 },
  missile: { freq: 700, filter: "bandpass", decay: 0.7, gain: 0.4 },
  flak: { freq: 900, filter: "bandpass", decay: 0.5, gain: 0.4 },
  mine: { freq: 2400, filter: "highpass", decay: 0.04, gain: 0.25 },
  flamer: { freq: 450, filter: "lowpass", decay: 0.12, gain: 0.12 },
  emp: { freq: 2000, filter: "bandpass", decay: 0.3, gain: 0.35, thump: 180 },
  smoke: { freq: 350, filter: "highpass", decay: 0.35, gain: 0.3 },
  laser: { freq: 3400, filter: "bandpass", decay: 0.05, gain: 0.16 },
  rail: { freq: 1700, filter: "bandpass", decay: 0.55, gain: 0.7, thump: 70 },
  shotgun: { freq: 650, filter: "lowpass", decay: 0.32, gain: 0.75, thump: 85 },
  rockets: { freq: 1100, filter: "bandpass", decay: 0.35, gain: 0.3 },
  plasma: { freq: 520, filter: "bandpass", decay: 0.09, gain: 0.13 },
  lockon: { freq: 820, filter: "bandpass", decay: 0.6, gain: 0.4 },
  warhead: { freq: 260, filter: "lowpass", decay: 1.1, gain: 0.8, thump: 45 },
  bombs: { freq: 320, filter: "lowpass", decay: 0.15, gain: 0.35, thump: 90 },
  empMine: { freq: 2400, filter: "highpass", decay: 0.04, gain: 0.25 },
  fireMine: { freq: 2400, filter: "highpass", decay: 0.04, gain: 0.25 },
  smokeMine: { freq: 2400, filter: "highpass", decay: 0.04, gain: 0.25 },
  bounceMine: { freq: 2400, filter: "highpass", decay: 0.04, gain: 0.25 },
  aaMine: { freq: 2400, filter: "highpass", decay: 0.04, gain: 0.25 },
  remoteMine: { freq: 2400, filter: "highpass", decay: 0.04, gain: 0.25 },
  sensorMine: { freq: 2400, filter: "highpass", decay: 0.04, gain: 0.25 },
  stickyMine: { freq: 2400, filter: "highpass", decay: 0.04, gain: 0.25 },
  repair: { freq: 1800, filter: "bandpass", decay: 0.05, gain: 0.1 },
  flare: { freq: 1200, filter: "bandpass", decay: 0.3, gain: 0.3 },
  nanites: { freq: 2600, filter: "bandpass", decay: 0.12, gain: 0.15 },
  barrier: { freq: 320, filter: "lowpass", decay: 0.5, gain: 0.35, thump: 70 },
};

/**
 * Son enregistré du tir de chaque arme (TypeScript refuse une arme sans le sien) ; `sustain` :
 * une boucle qui dure tant que l'arme tire (lance-flammes, plasma), plutôt qu'un son par tir.
 */
const SHOT_SOUNDS: Record<WeaponId, { key: SampleKey; sustain?: true }> = {
  rifle: { key: "rifle-shot" },
  sniper: { key: "sniper-shot" },
  cannon: { key: "cannon-shot" },
  missile: { key: "missile-launch" },
  flak: { key: "flak-shot" },
  mine: { key: "mine-drop" },
  flamer: { key: "flamer-loop", sustain: true },
  emp: { key: "emp-shot" },
  smoke: { key: "smoke-shot" },
  laser: { key: "laser-shot" },
  rail: { key: "rail-shot" },
  shotgun: { key: "shotgun-shot" },
  rockets: { key: "rocket-launch" },
  plasma: { key: "plasma-loop", sustain: true },
  lockon: { key: "lockon-launch" },
  warhead: { key: "warhead-launch" },
  bombs: { key: "bomb-release" },
  empMine: { key: "mine-drop" },
  fireMine: { key: "mine-drop" },
  smokeMine: { key: "mine-drop" },
  bounceMine: { key: "mine-drop" },
  aaMine: { key: "mine-drop" },
  remoteMine: { key: "mine-drop" },
  sensorMine: { key: "mine-drop" },
  stickyMine: { key: "mine-drop" },
  repair: { key: "repair-beam", sustain: true },
  flare: { key: "flare-launch" },
  nanites: { key: "nanite-launch" },
  // Le départ du projecteur ; le mur, lui, s'entend quand il se déploie (`barrierAdded`)
  barrier: { key: "emp-shot" },
};

/** Son du projectile en vol (propulseur, sifflement d'obus) ; les autres volent en silence. */
const FLIGHT_SOUNDS: Partial<Record<WeaponId, SampleKey>> = {
  missile: "missile-flight",
  flak: "missile-flight",
  lockon: "missile-flight",
  rockets: "rocket-flight",
  warhead: "warhead-flight",
  cannon: "shell-whistle",
  emp: "shell-whistle",
  smoke: "shell-whistle",
  bombs: "bomb-whistle",
  flare: "flare-burn",
};

/**
 * Sifflement qui descend pendant la chute (une bombe) : sa hauteur passe de 1 + d/2 à 1 − d/2 en
 * FALL_WHISTLE s, en plus de l'effet Doppler.
 */
const FLIGHT_FALL: Partial<Record<WeaponId, number>> = { bombs: 0.35 };
const FALL_WHISTLE = 2.5;

/** Intervalle des bips d'une mine ventouse collée à un robot (s). */
const LIMPET_BEEP = 0.35;

/** Bruit de chaque allure d'explosion (TypeScript refuse une allure sans le sien). */
const EXPLOSION_SOUNDS: Record<ExplosionLook, SampleKey> = {
  shell: "explosion",
  missile: "explosion",
  rocket: "explosion-small",
  flak: "explosion-small",
  mine: "explosion",
  bomb: "explosion-bomb",
  napalm: "napalm-burst",
  warhead: "explosion-huge",
  barrel: "explosion",
  gas: "explosion-small",
  car: "explosion",
};

/** Balles qui sifflent à l'oreille en passant tout près. */
const FLYBY_WEAPONS: ReadonlySet<WeaponId> = new Set<WeaponId>(["rifle", "sniper", "shotgun", "rail"]);

/** Bruit d'un impact selon ce qu'il touche. */
/** Bruit d'un accessoire qui cède, selon sa matière ; ceux qui explosent font le bruit de leur explosion. */
const BREAK_SOUNDS: Record<PropType, SampleKey | null> = {
  crate: "crate-break", barrel: null, gas: null, tank: null,
  brick: "wall-collapse", concrete: "wall-collapse", roof: "wall-collapse", plank: "crate-break", sheet: "metal-crash",
  pine: "crate-break", oak: "crate-break", palm: "crate-break", kapok: "crate-break", cactus: "crate-break", watertank: "crate-break",
  facade: "wall-collapse", tenement: "wall-collapse",
  // Une voiture explose (son bruit vient avec), puis sa carcasse s'effondre
  car: "metal-crash", wreck: "metal-crash", lamppost: "metal-crash", floodlight: "metal-crash",
};

const IMPACT_SAMPLES: Record<ImpactSurface, SampleKey> = { robot: "impact-metal", prop: "impact-prop", scenery: "impact-ground", projectile: "missile-intercepted" };

/** Sons d'interface (sans spatialisation). */
export type UiKind =
  | "hit" | "crit" | "kill" | "hurt" | "capture" | "lost" | "lock" | "locking"
  | "overheat" | "dry" | "reload" | "missile" | "critical" | "battery" | "start" | "tick" | "hill" | "respawn"
  | "click" | "hover" | "back" | "unlock" | "credits" | "place" | "remove" | "rotate" | "wheel" | "error" | "save" | "detonate";
/** Leur son enregistré ; absent : synthétisé (le bip du verrouillage en cours, net et régulier). */
const UI_SAMPLES: Partial<Record<UiKind, { key: SampleKey; gain?: number; rate?: number }>> = {
  hit: { key: "hit-marker" },
  crit: { key: "hit-marker", gain: 1.5, rate: 0.8 },
  kill: { key: "kill-confirm" },
  hurt: { key: "hurt" },
  capture: { key: "zone-captured" },
  lost: { key: "zone-lost" },
  lock: { key: "lock-acquired" },
  overheat: { key: "overheat-alarm" },
  dry: { key: "dry-fire" },
  reload: { key: "reload-ready" },
  missile: { key: "missile-warning" },
  critical: { key: "integrity-alarm" },
  battery: { key: "battery-low" },
  start: { key: "match-start" },
  tick: { key: "countdown-tick" },
  hill: { key: "hill-moved" },
  respawn: { key: "respawn" },
  click: { key: "menu-click" },
  hover: { key: "menu-hover" },
  back: { key: "menu-back" },
  unlock: { key: "unlock" },
  credits: { key: "credits" },
  place: { key: "garage-place" },
  remove: { key: "garage-remove" },
  rotate: { key: "garage-rotate" },
  wheel: { key: "garage-wheel" },
  error: { key: "garage-error" },
  save: { key: "garage-save" },
  detonate: { key: "remote-detonator" },
};
/** Sons d'interface qui ne se répètent pas plus vite que cela (s) : une rafale, un survol rapide des boutons. */
const UI_GAP: Partial<Record<UiKind, number>> = { hit: 0.06, hover: 0.05, dry: 0.25, click: 0.03 };

/** Volume de base de l'ambiance d'une carte (ramenée au niveau des boucles du jeu : `mendForeignLoop`), celui des ambiances du jeu. */
const MAP_AMBIENCE_GAIN = 0.25;

/** L'ambiance d'une carte venue d'un paquet : son empreinte, son décodage, la boucle décodée. */
interface OwnAmbience {
  readonly hash: string;
  state: "loading" | "ready" | "failed";
  buffer: AudioBuffer | null;
  loopStart: number;
}

/** Ambiance de chaque arène (une arène sans la sienne reste silencieuse). */
const AMBIENCES: Readonly<Record<string, SampleKey>> = {
  depot: "amb-depot",
  fort: "amb-fortress",
  trenches: "amb-trenches",
  yard: "amb-yard",
  valley: "amb-valley",
  // Faute d'une ambiance à elle : le vent, l'eau et les oiseaux de la Vallée
  island: "amb-valley",
  // Pas encore d'ambiance de désert enregistrée : le vent de la Forteresse, ce qui s'en rapproche le plus
  canyon: "amb-fortress",
  // (la Cité n'a pas encore la sienne : le vent et la canonnade lointaine des tranchées lui vont)
  city: "amb-trenches",
  // Pas encore d'ambiance de port (mouettes, ressac, corne de brume) : celle du dépôt, industrielle
  port: "amb-depot",
};

/** Fréquence du contexte audio (Hz) : celle des sons du jeu, encodés en Opus. */
const SAMPLE_RATE = 48000;

/** Un nœud de spatialisation (à placer ensuite avec `placePanner`). */
function makePanner(ctx: AudioContext): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = "equalpower";
  p.distanceModel = "inverse";
  p.refDistance = 5;
  p.maxDistance = 200;
  p.rolloffFactor = 1;
  return p;
}

function placePanner(p: PannerNode, at: Vec3): void {
  if (p.positionX) {
    p.positionX.value = at.x;
    p.positionY.value = at.y;
    p.positionZ.value = at.z;
  } else {
    p.setPosition(at.x, at.y, at.z);
  }
}

/**
 * Un son enregistré en boucle, qu'on remplace à volonté (un fondu sur l'ancien), avec son
 * volume et sa place dans l'arène (ou sans spatialisation : ambiance, ou voix déjà placée).
 */
class LoopVoice {
  readonly gain: GainNode;
  readonly panner: PannerNode | null;
  /** Ce qui joue : un son du jeu (`SampleKey`), ou l'ambiance d'une carte (« map: » et son empreinte). */
  key: string | null = null;
  private readonly ctx: AudioContext;
  private src: AudioBufferSourceNode | null = null;
  private srcGain: GainNode | null = null;

  constructor(ctx: AudioContext, out: AudioNode, spatial: boolean) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.panner = spatial ? makePanner(ctx) : null;
    if (this.panner) this.gain.connect(this.panner).connect(out);
    else this.gain.connect(out);
  }

  get playing(): boolean {
    return this.src !== null;
  }

  /**
   * Fait jouer ce son en boucle (s'il ne joue pas déjà), à partir d'un point au hasard, entre les
   * marges de son fichier (`LOOP_PAD` ; une boucle qui ne vient pas du jeu : de `loopStart` à sa fin,
   * voir `mendForeignLoop`).
   */
  play(key: string, buffer: AudioBuffer, loopStart = LOOP_PAD, loopEnd = buffer.duration - LOOP_PAD): void {
    if (this.key === key && this.src) return;
    this.release();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = loopStart;
    src.loopEnd = loopEnd;
    const g = this.ctx.createGain();
    src.connect(g).connect(this.gain);
    src.start(this.ctx.currentTime, loopStart + Math.random() * (loopEnd - loopStart));
    this.src = src;
    this.srcGain = g;
    this.key = key;
  }

  /** Volume et vitesse de lecture visés, rejoints en `tc` s environ. */
  set(level: number, rate = 1, tc = 0.15): void {
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(level, t, tc);
    this.src?.playbackRate.setTargetAtTime(rate, t, tc);
  }

  place(at: Vec3): void {
    if (this.panner) placePanner(this.panner, at);
  }

  /** Se tait en douceur, puis libère sa source. */
  release(): void {
    if (!this.src || !this.srcGain) return;
    const t = this.ctx.currentTime;
    this.srcGain.gain.setTargetAtTime(0, t, 0.06);
    this.src.stop(t + 0.4);
    this.src = null;
    this.srcGain = null;
    this.key = null;
  }
}

/**
 * Voix d'un rotor qui tourne : sifflement synthétisé (deux oscillateurs filtrés), ou enregistré en
 * boucle ; et le grincement d'une lame qui mord (un bruit filtré, ou enregistré en boucle).
 */
interface MeleeVoice {
  arm: MeleeArm | null;
  osc: OscillatorNode;
  overtone: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  loop: LoopVoice;
  grindFilter: BiquadFilterNode;
  grindGain: GainNode;
  biteLoop: LoopVoice;
}

interface EngineVoice {
  bot: Bot | null;
  /** Moteur synthétisé (tant que les sons enregistrés ne sont pas chargés, et pour les robots sans le sien). */
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  /** Moteur enregistré, en boucle, dans la même voix. */
  loop: LoopVoice;
}

/** Arme à tir continu qui tire (ou vient de tirer) ici. */
interface SustainVoice {
  loop: LoopVoice;
  at: Vec3;
  until: number;
}

/** Projectile en vol et la voix qui le suit. */
interface FlightVoice {
  loop: LoopVoice;
  projectile: Projectile | null;
}

/** Ce qui fait avancer un robot, et comment l'entendre : son boucle, volume et vitesse de lecture. */
interface Locomotion {
  key: SampleKey;
  level: number;
  rate: number;
}

/**
 * Le son du moteur d'un robot, d'après ce qui le fait avancer : des turboréacteurs (en vol, ou au
 * sol quand ils poussent) ; un rotor orientable, c'est un hélicoptère ; des hélices d'avion ; un
 * propulseur qui tire vers l'avant avec des ailes, un petit avion ; des rotors de sustentation, un
 * drone ; sinon ses pattes, ses patins, ses chenilles ou ses roues. `speed` : sa vitesse (m/s) ;
 * `power` : sa poussée, en part de la poussée maximale de ses réacteurs.
 */
/** Poussée (part de la poussée maximale) au-dessous de laquelle le moteur d'un avion se tait. */
const ENGINE_OFF = 0.04;

function locomotion(bot: Bot, speed: number, power: number, driving: boolean): Locomotion {
  const thrusters = bot.thrusters;
  const look = (t: Bot["thrusters"][number]) => blockDef(t.block.type).thruster?.look;
  // Un avion aux gaz coupés plane en silence (son moteur s'éteint quand ses moteurs s'arrêtent)
  const running = bot.profile.mobility === "plane" ? clamp(power / ENGINE_OFF, 0, 1) : 1;
  if (thrusters.some((t) => look(t) === "jet") && (bot.profile.mobility !== "ground" || power > 0.05)) {
    return { key: "jet-engine", level: (0.3 + 0.7 * power) * running, rate: 0.75 + 0.5 * power };
  }
  if (thrusters.some((t) => look(t) === "rotor")) {
    return { key: "rotor-heli", level: 0.35 + 0.65 * power, rate: 0.85 + 0.3 * power };
  }
  if (thrusters.some((t) => look(t) === "propeller")) {
    return { key: "propeller-big", level: (0.35 + 0.65 * power) * running, rate: 0.75 + 0.45 * power };
  }
  if (bot.surfaces.length > 0 && thrusters.some((t) => t.role === "cruise")) {
    return { key: "propeller-plane", level: (0.3 + 0.7 * power) * running, rate: 0.7 + 0.6 * power };
  }
  if (thrusters.some((t) => t.role === "lift")) {
    return { key: "rotor-drone", level: 0.35 + 0.65 * power, rate: 0.8 + 0.5 * power };
  }
  const support = bot.supports[0];
  if (support) {
    if (blockDef(support.block.type).support?.kind === "leg") {
      return { key: "legs-servo", level: speed > 0.3 ? 0.3 + Math.min(0.7, speed * 0.2) : 0.04, rate: 0.8 + Math.min(0.6, speed * 0.15) };
    }
    return { key: "hover-pad", level: 0.55 + Math.min(0.45, speed * 0.05), rate: 0.9 + Math.min(0.4, speed * 0.04) };
  }
  if (bot.wheels.some((w) => w.part && wheelDef(w.type).track)) {
    return { key: "tracks", level: Math.min(1, speed * 0.25), rate: 0.6 + Math.min(0.9, speed * 0.12) };
  }
  // Roues : le roulement (pneus sur le gravier, transmission, moteur en fond) suit la vitesse, en
  // roue libre aussi ; à l'arrêt, il ne reste que le moteur, à peine (un peu plus s'il pousse)
  return { key: "wheels-roll", level: Math.min(1, (driving ? 0.25 : 0.08) + speed * 0.12), rate: 0.7 + Math.min(1, speed * 0.08) };
}

/** Distance (m) de `p` au segment [a, b]. */
function segmentDistance(a: Vec3, b: Vec3, p: Vec3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? clamp(dot(sub(p, a), ab) / l2, 0, 1) : 0;
  return distance(add(a, scale(ab, t)), p);
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /**
   * Bus du monde (tirs, explosions, moteurs, feux, projectiles, accessoires) et de l'ambiance de
   * l'arène, entre ces sons et le volume général : l'écran en règle le volume (`setScreen`). Les
   * sons d'interface et la musique n'y passent pas.
   */
  private worldBus: GainNode | null = null;
  private ambienceBus: GainNode | null = null;
  /** L'écran en cours et ce qu'il laisse sonner (voir audio/soundScene.ts). */
  private screen: SoundScreen = "menu";
  private online = false;
  private scene: SoundScene = soundScene("menu");
  private noise: AudioBuffer | null = null;
  private voices = 0;
  private enabled: boolean;
  /** Volume général (0 à 1). */
  private volume = 0.8;
  private readonly engines: EngineVoice[] = [];
  private pickTimer = 0;
  /** Rotors des armes de contact les plus proches, et la phase des bras à l'image précédente (pour le bruit du vérin). */
  private readonly meleeVoices: MeleeVoice[] = [];
  private meleeTimer = 0;
  private readonly swingPhases = new WeakMap<MeleeArm, SwingPhase>();
  private flightTimer = 0;
  /** Dernier bruit de bloc détruit (s, horloge audio) : on n'en joue pas des dizaines à la fois. */
  private lastCrunch = 0;
  /** Dernier tir encaissé par un mur d'énergie, dernier bloc qui a repoussé (temps audio) : pas plus d'un son à la fois. */
  private lastShieldHit = 0;
  private lastRegrow = 0;
  private lastImpact = 0;
  private lastFlyby = 0;
  /** Sons enregistrés (null tant que le son n'est pas permis, ou si le navigateur ne lit pas l'Opus). */
  private samples: SampleBank | null = null;
  private readonly sustains: SustainVoice[] = [];
  private readonly flights: FlightVoice[] = [];
  /** Projectiles en vol qui ont un son, et balles qui peuvent siffler à l'oreille (avec leur position précédente). */
  private readonly flying = new Set<Projectile>();
  private readonly whizzing = new Map<Projectile, Vec3>();
  /**
   * Feux : blocs, accessoires en bois qui brûlent, flaques au sol ; et les voix qui entendent les
   * plus proches (`source` : le bloc, l'accessoire ou la flaque qu'elle suit).
   */
  private readonly burning = new Set<Block>();
  private readonly burningProps = new Set<Prop>();
  private readonly groundFires = new Set<GroundFire>();
  private readonly fires: { loop: LoopVoice; source: Block | Prop | GroundFire | null }[] = [];
  private ambience: LoopVoice | null = null;
  /** Accessoires présents (mèche, fuite de gaz), et les voix qui en entendent les plus proches. */
  private readonly props = new Set<Prop>();
  /** Dernière position connue de chaque accessoire, relevée à chaque image (voir `propRemoved`). */
  private readonly propAt = new WeakMap<Prop, Vec3>();
  private readonly propVoices: { loop: LoopVoice; prop: Prop | null }[] = [];
  /** Mines lancées, pas encore posées (on entend leur armement quand elles se posent). */
  private readonly mines = new Set<Projectile>();
  /** Mines ventouses collées à un robot : leur prochain bip (compte à rebours jusqu'à l'explosion). */
  private readonly limpets = new Map<Projectile, number>();
  /** Par robot entendu : son redressement en cours, et le pas de sa marche (pour les bruits de pas). */
  private readonly walked = new WeakMap<Bot, { righting: number; step: number }>();
  private readonly lastUi = new Map<UiKind, number>();
  private lastCritical = 0;
  private lastBattery = 0;
  private lastWarning = 0;
  private lastRespawn = 0;
  /** Robots apparus depuis la dernière image (voir `updateSpawns`). */
  private spawned: Bot[] = [];
  private failed = false;
  /** Partie suivie : son départ, la dernière seconde annoncée du compte à rebours, la colline en jeu. */
  private match: object | null = null;
  private countdown = -1;
  private hill = -1;
  private music: Music | null = null;
  /** Chargement de tous les sons, une fois (voir `preload`). */
  private preloading: Promise<void> | null = null;
  private musicTheme: MusicTheme | null = null;
  private musicVolume = 0.5;
  /** Le lecteur de musique (hud/nowPlaying.ts), qui écoute ce qui change. */
  private musicListener: MusicListener | null = null;
  /** Relevé des sons joués (réglage « Afficher les sons joués ») : le nom de chacun, et sa distance. */
  private trace: ((label: string) => void) | null = null;
  private sim: World;
  private unsubscribe: () => void;
  private listener: Vec3 = { x: 0, y: 10, z: 0 };

  constructor(sim: World, enabled: boolean) {
    this.sim = sim;
    this.enabled = enabled;
    this.unsubscribe = sim.on((e) => this.listen(e));
    // Le navigateur n'autorise le son qu'après un geste de l'utilisateur
    const unlock = (): void => this.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  /** Écoute un autre monde (partie locale, ou réplique d'une partie en réseau). */
  setWorld(world: World): void {
    this.unsubscribe();
    this.sim = world;
    this.unsubscribe = world.on((e) => this.listen(e));
    // Rien de l'ancien monde ne continue : ses boucles se taisent, ses projectiles et ses mines
    // sont oubliés (leurs retraits n'arriveront plus)
    this.releaseWorld();
    this.flying.clear();
    this.whizzing.clear();
    this.burning.clear();
    this.burningProps.clear();
    this.groundFires.clear();
    this.props.clear();
    this.mines.clear();
    this.limpets.clear();
    this.spawned = [];
    this.match = null;
    this.countdown = -1;
    this.hill = -1;
  }

  /**
   * L'écran change (partie, pause, fin de partie, menu, garage) : le monde et l'ambiance prennent
   * le volume qu'il leur laisse, en fondu ; arène en veille (garage), toutes les boucles du monde
   * sont libérées. `online` : partie en réseau (en pause, elle continue sur le serveur).
   */
  setScreen(screen: SoundScreen, online = false): void {
    if (screen === this.screen && online === this.online) return;
    this.screen = screen;
    this.online = online;
    this.scene = soundScene(screen, online);
    this.applyScene();
    if (!this.scene.live) this.releaseWorld();
  }

  /** Volume des bus du monde et de l'ambiance d'après l'écran (le monde, un peu plus vite quand il se tait). */
  private applyScene(): void {
    const ctx = this.ctx;
    if (!ctx || !this.worldBus || !this.ambienceBus) return;
    const t = ctx.currentTime;
    for (const [bus, level] of [[this.worldBus, this.scene.world], [this.ambienceBus, this.scene.ambience]] as const) {
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(bus.gain.value, t);
      bus.gain.setTargetAtTime(level, t, level < bus.gain.value ? SCENE_FADE_OUT : SCENE_FADE_IN);
    }
  }

  /**
   * Toutes les voix du monde se taisent et oublient ce qu'elles suivaient : moteurs, projectiles
   * en vol, feux, accessoires, tirs continus, ambiance. Elles repartent d'elles-mêmes, dans `update`,
   * quand le monde sonne de nouveau.
   */
  private releaseWorld(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const v of this.engines) {
      v.bot = null;
      v.gain.gain.setTargetAtTime(0, t, 0.05);
      v.loop.release();
    }
    for (const v of this.flights) {
      v.projectile = null;
      v.loop.release();
    }
    for (const v of this.fires) {
      v.source = null;
      v.loop.release();
    }
    for (const v of this.propVoices) {
      v.prop = null;
      v.loop.release();
    }
    for (const v of this.sustains) v.loop.release();
    for (const v of this.meleeVoices) {
      v.arm = null;
      v.gain.gain.setTargetAtTime(0, t, 0.05);
      v.grindGain.gain.setTargetAtTime(0, t, 0.05);
      v.loop.release();
      v.biteLoop.release();
    }
    this.ambience?.release();
    // Le prochain choix des moteurs se fait tout de suite, au retour
    this.pickTimer = 0;
    this.flightTimer = 0;
    this.meleeTimer = 0;
  }

  /** La musique d'un écran (accueil, garage, partie), ses morceaux enchaînés ; null : silence. */
  playMusic(theme: MusicTheme | null): void {
    this.musicTheme = theme;
    this.music?.play(theme);
  }

  /** Un motif de fin de partie ; la musique en cours s'efface. */
  stinger(kind: "victory" | "defeat"): void {
    this.musicTheme = null;
    this.music?.stinger(kind);
    // Sous le motif, le monde baisse encore un moment, puis revient au volume de l'écran
    const ctx = this.ctx;
    const bus = this.worldBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(bus.gain.value, t);
    bus.gain.setTargetAtTime(this.scene.world * STINGER_DUCK.level, t, SCENE_FADE_OUT);
    bus.gain.setTargetAtTime(this.scene.world, t + STINGER_DUCK.seconds, SCENE_FADE_IN);
  }

  /** Relevé des sons joués : chaque son ponctuel joué est annoncé (null : rien). */
  setTrace(trace: ((label: string) => void) | null): void {
    this.trace = trace;
  }

  /** Volume de la musique (0 à 1), par-dessus le volume général. */
  setMusicVolume(volume: number): void {
    this.musicVolume = volume;
    this.music?.setVolume(volume);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyGain();
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.applyGain();
  }

  private applyGain(): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.05);
  }

  /** L'auditeur suit la caméra ; les sons en boucle suivent ce qu'ils font entendre. */
  update(camera: B.Camera, dt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.scene.live) return;
    const p = camera.globalPosition;
    const f = camera.getForwardRay(1).direction;
    this.listener = { x: p.x, y: p.y, z: p.z };
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = f.x;
      l.forwardY.value = f.y;
      l.forwardZ.value = f.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
    this.updateEngines(dt);
    this.updateMelee(dt);
    this.updateSustains();
    this.updateFlights(dt);
    this.updateFlybys();
    this.updateFires();
    this.updateAmbience();
    this.updateProps();
    this.updateMines();
    this.updateAlerts();
    this.updateMatch();
    this.updateSpawns();
  }

  /**
   * Ce qui sonne (essais, console : `__casse.game.sound.debugState()`) : l'écran, le volume des bus,
   * les voix ponctuelles en cours et les boucles qui jouent.
   */
  debugState(): { screen: SoundScreen; world: number; ambience: number; voices: number; loops: number; engines: number } {
    const loops = [
      ...this.engines.map((v) => v.loop), ...this.flights.map((v) => v.loop), ...this.fires.map((v) => v.loop),
      ...this.propVoices.map((v) => v.loop), ...this.sustains.map((v) => v.loop), ...(this.ambience ? [this.ambience] : []),
    ].filter((l) => l.playing).length;
    return {
      screen: this.screen,
      world: this.worldBus?.gain.value ?? this.scene.world,
      ambience: this.ambienceBus?.gain.value ?? this.scene.ambience,
      voices: this.voices,
      loops,
      engines: this.engines.filter((v) => v.bot !== null).length,
    };
  }

  /** Les robots apparus : toute une équipe apparaît d'un coup au début d'une partie, un seul son. */
  private updateSpawns(): void {
    const spawned = this.spawned;
    this.spawned = [];
    const t = this.ctx!.currentTime;
    const bot = spawned.find((b) => b === this.sim.player) ?? spawned.find((b) => b.cockpit?.alive);
    if (!bot || t - this.lastRespawn < RESPAWN_GAP) return;
    this.lastRespawn = t;
    if (bot === this.sim.player) this.ui("respawn");
    else this.sample(bot.lastPos, "respawn");
  }

  /**
   * Charge tout le son d'avance (écran de chargement) : le contexte audio est créé tout de suite,
   * suspendu tant que le joueur n'a pas fait de geste (il décode quand même), puis tous les sons
   * enregistrés et les motifs de fin sont décodés, et le premier morceau de l'accueil préparé (lu en
   * flux) ; ceux de la partie et du garage suivent en arrière-plan. `progress` reçoit la part faite
   * (0 à 1).
   */
  preload(progress: (done: number) => void = () => {}): Promise<void> {
    this.preloading ??= this.loadAll(progress);
    return this.preloading;
  }

  private async loadAll(progress: (done: number) => void): Promise<void> {
    if (!this.createContext()) {
      progress(1);
      return;
    }
    const bank = this.samples;
    const music = this.music;
    if (!bank || !music) {
      progress(1);
      return;
    }
    let sounds = 0;
    let tunes = 0;
    // La musique de l'accueil d'abord : elle ne doit pas attendre derrière les ~290 bruitages ;
    // ensuite les bruitages, avec les motifs de fin
    const report = (): void => progress(0.15 * tunes + 0.85 * sounds);
    await music.prepare("menu");
    tunes = 0.5;
    report();
    await Promise.all([
      music.preload((done) => { tunes = 0.5 + done / 2; report(); }),
      bank.load(import.meta.env.BASE_URL, (done) => { sounds = done; report(); }),
    ]);
  }

  /** Le navigateur attend-il un geste du joueur pour jouer le son (contexte créé mais suspendu) ? */
  get needsGesture(): boolean {
    return !!this.ctx && this.ctx.state !== "running";
  }

  /** Débloque le son (à appeler pendant un geste du joueur) : la musique déjà préparée part aussitôt. */
  resume(): Promise<void> {
    this.unlock();
    return this.ctx && this.ctx.state !== "running" ? this.ctx.resume().catch(() => undefined) : Promise.resolve();
  }

  /** Prépare la musique de cet écran (écran de chargement d'une partie) ; rien sans musique. */
  prepareMusic(theme: MusicTheme): Promise<void> {
    return this.music?.prepare(theme) ?? Promise.resolve();
  }

  /**
   * Mémoire de la musique (Mo), pour les mesures (console : `__casse.game.sound.musicMegabytes()`) :
   * les motifs décodés et les fichiers compressés des morceaux lus en flux.
   */
  async musicMegabytes(): Promise<{ decoded: number; compressed: number }> {
    return { decoded: (await this.music?.decodedMegabytes()) ?? 0, compressed: this.music?.compressedMegabytes() ?? 0 };
  }

  /** Ce que joue la musique et ce qui est prêt (console : `__casse.game.sound.musicState()`). */
  musicState(): ReturnType<Music["debugState"]> | null {
    return this.music?.debugState() ?? null;
  }

  /**
   * Morceau suivant de l'écran (le lecteur des menus, la touche en partie), en fondu ; faux sans
   * musique d'écran. Console : `__casse.game.sound.nextMusic()` (`skipMusic`, son ancien nom).
   */
  nextMusic(): boolean {
    return this.music?.next() ?? false;
  }

  /** L'ancien nom de `nextMusic` (essais, console). */
  skipMusic(): boolean {
    return this.nextMusic();
  }

  /** Revient au morceau précédent de l'écran (son historique), en fondu ; faux s'il n'y en a pas. */
  previousMusic(): boolean {
    return this.music?.previous() ?? false;
  }

  /** Ce que joue la musique (le lecteur, les paramètres) ; null sans musique (pas d'Opus, pas encore de son). */
  musicNow(): MusicNow | null {
    return this.music?.now() ?? null;
  }

  /** La musique s'entend-elle (son activé, volume général et volume de la musique non nuls) ? */
  get musicAudible(): boolean {
    return this.enabled && this.volume > 0 && this.musicVolume > 0;
  }

  /** Le lecteur de musique écoute ce qui change (un morceau commence, se prépare, est illisible ; la musique se tait). */
  set onMusic(listener: MusicListener | null) {
    this.musicListener = listener;
    if (this.music) this.music.onChange = listener;
  }

  private unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    // Pas de chargement d'avance (essais) : on crée le contexte au premier geste, et on charge tout
    if (this.createContext()) void this.preload();
  }

  /** Crée le contexte audio, ses bus et ses voix (une fois) ; faux si le navigateur n'a pas de Web Audio. */
  private createContext(): boolean {
    if (this.ctx) return true;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    // À 48 kHz, la fréquence des fichiers (Opus) : sinon le navigateur décode tout à celle de la
    // carte son, jusqu'à 192 kHz (quatre fois plus de mémoire pour rien : la musique de l'accueil
    // pesait 130 Mo au lieu de 33) ; il rééchantillonne à la sortie
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    } catch {
      ctx = new Ctor();
    }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(ctx.destination);
    this.worldBus = ctx.createGain();
    this.worldBus.gain.value = this.scene.world;
    this.worldBus.connect(this.master);
    this.ambienceBus = ctx.createGain();
    this.ambienceBus.gain.value = this.scene.ambience;
    this.ambienceBus.connect(this.master);
    // Une seconde de bruit blanc, pour tous les sons de bruit
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = noise;
    for (let i = 0; i < ENGINE_VOICES; i++) this.engines.push(this.engineVoice(ctx));
    for (let i = 0; i < MELEE_VOICES; i++) this.meleeVoices.push(this.meleeVoice(ctx));
    for (let i = 0; i < FLIGHT_VOICES; i++) this.flights.push({ loop: new LoopVoice(ctx, this.worldBus, true), projectile: null });
    for (let i = 0; i < FIRE_VOICES; i++) this.fires.push({ loop: new LoopVoice(ctx, this.worldBus, true), source: null });
    this.ambience = new LoopVoice(ctx, this.ambienceBus, false);
    for (let i = 0; i < PROP_VOICES; i++) this.propVoices.push({ loop: new LoopVoice(ctx, this.worldBus, true), prop: null });
    if (canPlayOpus()) {
      this.music = new Music(ctx, this.master, import.meta.env.BASE_URL);
      this.music.onChange = this.musicListener;
      this.music.setVolume(this.musicVolume);
      this.music.play(this.musicTheme);
      this.samples = new SampleBank(ctx);
    }
    return true;
  }

  /**
   * Les événements sont émis au milieu d'un pas de simulation (certains pendant la construction
   * d'un robot) : une erreur du son ne doit pas remonter jusqu'à elle. Signalée une fois.
   */
  private listen(e: SimEvent): void {
    try {
      this.onEvent(e);
    } catch (err) {
      if (!this.failed) console.error("Son : erreur sur l'événement", e.type, err);
      this.failed = true;
    }
  }

  private onEvent(e: SimEvent): void {
    // Les projectiles se suivent même sans son (ils peuvent voler quand il est permis)
    if (e.type === "projectileAdded") {
      if (FLIGHT_SOUNDS[e.projectile.weapon]) this.flying.add(e.projectile);
      if (FLYBY_WEAPONS.has(e.projectile.weapon)) this.whizzing.set(e.projectile, e.projectile.pos);
      if (weaponDef(e.projectile.weapon).projectile.mine && !e.projectile.landed) this.mines.add(e.projectile);
      return;
    }
    if (e.type === "projectileRemoved") {
      this.flying.delete(e.projectile);
      this.whizzing.delete(e.projectile);
      this.mines.delete(e.projectile);
      this.limpets.delete(e.projectile);
      return;
    }
    if (e.type === "mine" && e.action === "stick") this.limpets.set(e.projectile, 0);
    if (e.type === "propAdded") this.props.add(e.prop);
    if (e.type === "propRemoved") {
      this.props.delete(e.prop);
      this.burningProps.delete(e.prop);
    }
    if (e.type === "fireStarted") this.burning.add(e.block);
    if (e.type === "fireEnded") this.burning.delete(e.block);
    // Le bois qui prend feu, une flaque qui s'allume : on entend l'allumage (plus bas), puis le crépitement
    const kindled = (e.type === "propFire" && e.prop.burn > 0 && !this.burningProps.has(e.prop)) || e.type === "groundFireAdded";
    if (e.type === "propFire") {
      if (e.prop.burn > 0) this.burningProps.add(e.prop);
      else this.burningProps.delete(e.prop);
    }
    if (e.type === "groundFireAdded") this.groundFires.add(e.fire);
    if (e.type === "groundFireRemoved") this.groundFires.delete(e.fire);
    if (kindled && this.ctx && this.enabled) {
      const at = e.type === "propFire" ? e.prop.rb.translation() : e.type === "groundFireAdded" ? e.fire.pos : null;
      if (at) this.sample(at, "fire-ignite", 0.7);
    }
    if (!this.ctx || !this.enabled) return;
    switch (e.type) {
      case "shot": {
        const sound = SHOT_SOUNDS[e.weapon];
        const own = !sound.sustain && this.ownShot(e.origin);
        if (sound.sustain ? this.sustain(e.origin, sound.key) : this.sample(own ? null : e.origin, sound.key, own ? OWN_SHOT_GAIN : 1, 1, true, this.worldBus)) break;
        const tone = SHOT_TONES[e.weapon];
        this.burst(e.origin, tone.freq, tone.filter, tone.decay, tone.gain);
        if (tone.thump) this.thump(e.origin, tone.thump, tone.decay, tone.gain * 0.8);
        break;
      }
      case "impact": {
        const key = IMPACT_SAMPLES[e.surface];
        if (this.samples?.has(key)) {
          if (this.ctx.currentTime - this.lastImpact < IMPACT_GAP) break;
          this.lastImpact = this.ctx.currentTime;
          this.sample(e.point, key);
          break;
        }
        this.burst(e.point, 2600, "highpass", 0.03, 0.15);
        break;
      }
      case "explosion": {
        // Selon ce qui explose ; plus grosse, plus forte et plus grave
        const key = EXPLOSION_SOUNDS[e.look];
        if (this.sample(e.point, key, Math.min(1.3, 0.6 + e.radius * 0.25), 1.08 - Math.min(0.2, e.radius * 0.04))) {
          // Une couche de basses dessous : le souffle se sent autant qu'il s'entend
          this.thump(e.point, 42, 0.45 + e.radius * 0.12, Math.min(0.8, 0.25 + e.radius * 0.12), (SAMPLES[key] as { reach?: number }).reach);
          break;
        }
        this.burst(e.point, 380, "lowpass", 0.5 + e.radius * 0.2, Math.min(1, 0.35 + e.radius * 0.2));
        this.thump(e.point, 48, 0.6 + e.radius * 0.1, Math.min(1, 0.3 + e.radius * 0.15));
        break;
      }
      case "collision": {
        const k = Math.min(1, e.strength / 120);
        if (this.sample(e.point, "collision", 0.3 + 0.7 * k)) break;
        this.burst(e.point, 260, "lowpass", 0.18, 0.2 + 0.5 * k);
        this.thump(e.point, 75, 0.2, 0.2 + 0.4 * k);
        break;
      }
      case "meleeHit": {
        // Le coup d'une lame ou d'une tête : un claquement métallique, plus grave et plus fort avec l'énergie
        const weapon = blockDef(e.block.type).melee;
        const k = clamp(e.energy / 1500, 0.15, 2);
        // Une mâchoire qui écrase ce qu'elle tient : un broiement de tôle, grave (enregistré : une
        // boucle, tenue tant que les tranches se suivent)
        if (weapon && meleeDef(weapon).motion === "grip" && e.energy < CRUSH_BELOW) {
          const crush = MELEE_SOUNDS[weapon].crush;
          if (crush && this.meleeSample(e.point, crush, 1, 1)) break;
          this.burst(e.point, 380, "bandpass", 0.22, 0.45);
          this.sweep(e.point, "sawtooth", 230, 85, 0.2, 0.1, 6);
          break;
        }
        const ground = e.surface === "scenery";
        const look = weapon ? meleeDef(weapon).look : "bar";
        const hit = weapon ? MELEE_SOUNDS[weapon].hit : null;
        // Plus fort avec l'énergie, plus grave aussi (et au sol) ; moins fort s'il glisse
        const pitch = clamp(1.12 - 0.12 * k, 0.88, 1.1) * (ground ? 0.85 : 1);
        if (hit && this.meleeSample(e.point, hit, Math.min(1.3, 0.5 + 0.5 * k) * (e.glance ? 0.6 : 1), pitch)) {
          // Une lourde masse d'acier : une couche de basses dessous, qui suit l'énergie du coup
          const low = STEEL_THUMP[look];
          if (low && k > 0.3) this.thump(e.point, ground ? low * 0.75 : low, 0.18 + 0.08 * k, Math.min(0.45, 0.2 * k), 8);
          break;
        }
        // Une arme d'énergie ne claque pas comme l'acier : elle grésille, crépite, crache
        if (weapon && this.energyHit(e.point, look, k)) break;
        if (look === "propeller") {
          // Des pales qui fauchent : un claquement sec, puis le craquement de ce qui casse
          this.burst(e.point, 2200, "bandpass", 0.09, Math.min(0.8, 0.3 + 0.3 * k));
          this.sweep(e.point, "sawtooth", 520, 140, 0.18, 0.1 * k, 6);
          break;
        }
        if (look === "drum") {
          // Un tambour : des chocs brefs et rapprochés, plus secs
          this.burst(e.point, ground ? 1600 : 3800, "highpass", 0.07, Math.min(0.7, 0.2 + 0.3 * k));
          this.thump(e.point, ground ? 70 : 110, 0.12, Math.min(0.6, 0.15 + 0.3 * k), 8);
          break;
        }
        if (look === "shell") {
          // Un anneau lourd : un coup de cloche sourd
          this.thump(e.point, ground ? 45 : 60, 0.4, Math.min(0.9, 0.3 + 0.3 * k), 8);
          this.sweep(e.point, "triangle", 420, 300, 0.5, 0.08 * k, 8);
        }
        this.burst(e.point, ground ? 1400 : 3400, "highpass", 0.12 + 0.08 * k, Math.min(0.9, 0.25 + 0.3 * k) * (e.glance ? 0.5 : 1));
        this.sweep(e.point, "square", ground ? 700 : 1900 - 300 * k, 260, 0.16 + 0.06 * k, (e.glance ? 0.06 : 0.14) * k, 8);
        this.thump(e.point, ground ? 55 : 80, 0.25 + 0.1 * k, Math.min(0.8, 0.2 + 0.3 * k), 8);
        break;
      }
      case "linkBroken":
        if (this.sample(e.point, "link-snap")) break;
        this.sweep(e.point, "square", 420, 140, 0.12, 0.18);
        this.burst(e.point, 1800, "highpass", 0.06, 0.2);
        break;
      case "blockDestroyed": {
        if (this.ctx.currentTime - this.lastCrunch < 0.05) break;
        this.lastCrunch = this.ctx.currentTime;
        const at = e.block.part.rb.translation();
        if (this.sample(at, "block-break")) break;
        this.burst(at, 700, "bandpass", 0.12, 0.18);
        break;
      }
      case "botKilled":
        this.sample(e.bot.lastPos, "robot-destroyed");
        break;
      case "mine":
        // Une mine qui bondit, une ventouse qui se colle, un capteur qui repère un ennemi
        this.sample(e.projectile.pos, e.action === "bounce" ? "mine-jump" : e.action === "stick" ? "limpet-attach" : "sensor-ping");
        break;
      case "empBurst":
        if (this.sample(e.point, "emp-burst")) break;
        this.sweep(e.point, "sawtooth", 1400, 90, 0.6, 0.35);
        break;
      case "stunned":
        this.sample(e.bot.lastPos, "stun-crackle");
        break;
      case "organsStunned": {
        // Une décharge locale (lance électrique) : le grésillement de la paralysie, plus bref
        const at = e.point ?? e.bot.lastPos;
        if (this.sample(at, "stun-crackle", 0.6)) break;
        this.burst(at, 5000, "highpass", 0.3, 0.25);
        break;
      }
      case "smokeAdded":
        if (this.sample(e.cloud.pos, "smoke-hiss")) break;
        this.burst(e.cloud.pos, 300, "highpass", 1.2, 0.2);
        break;
      case "fireStarted": {
        const at = e.block.part.rb.translation();
        if (this.sample(at, "fire-ignite")) break;
        this.burst(at, 500, "lowpass", 0.35, 0.12);
        break;
      }
      case "barrierAdded": {
        const at = e.barrier.center;
        if (this.sample(at, "barrier-deploy")) break;
        this.sweep(at, "sine", 180, 720, 0.35, 0.18);
        this.burst(at, 900, "bandpass", 0.3, 0.08);
        break;
      }
      case "barrierHit": {
        if (this.ctx.currentTime - this.lastShieldHit < 0.05) break;
        this.lastShieldHit = this.ctx.currentTime;
        if (this.sample(e.point, "shield-hit")) break;
        this.sweep(e.point, "sine", 900, 1500, 0.12, 0.12);
        break;
      }
      case "barrierRemoved":
        if (!e.broken || this.sample(e.barrier.center, "barrier-break")) break;
        this.burst(e.barrier.center, 2600, "highpass", 0.4, 0.25);
        this.sweep(e.barrier.center, "sawtooth", 900, 120, 0.35, 0.12);
        break;
      case "blockRebuilt": {
        if (this.ctx.currentTime - this.lastRegrow < 0.08) break;
        this.lastRegrow = this.ctx.currentTime;
        const at = e.block.part.rb.translation();
        if (this.sample(at, "block-regrow")) break;
        this.sweep(at, "triangle", 300, 1200, 0.18, 0.12);
        break;
      }
      case "shieldHit": {
        const at = e.block.part.rb.translation();
        if (this.sample(at, "shield-hit")) break;
        this.sweep(at, "sine", 900, 1500, 0.12, 0.12);
        break;
      }
      case "botAdded":
        // Émis pendant sa construction (il n'a pas encore son cockpit) : on l'entend à l'image suivante
        this.spawned.push(e.bot);
        break;
      case "propRemoved": {
        // Un accessoire qui a cédé (pas ceux qu'on retire en changeant d'arène). Son corps est déjà
        // retiré du monde physique : le relire planterait Rapier, et avec lui toute la partie. On
        // prend sa dernière position connue
        const at = this.propAt.get(e.prop);
        const key = BREAK_SOUNDS[e.prop.type];
        if (key && e.prop.state.kind !== "intact" && at) this.sample(at, key);
        break;
      }
      case "propReleased":
        // Un arbre abattu bascule ; un lampadaire tombe ; un toit, un étage qui n'est plus porté s'effondre
        this.sample(e.prop.rb.translation(), e.prop.type === "lamppost" ? "metal-crash" : propDef(e.prop.type).topples !== undefined ? "tree-fall" : "wall-collapse");
        break;
      default:
        break;
    }
  }

  /**
   * Son d'interface, sans spatialisation : confirmation d'une touche (`hit`), de blocs détruits
   * (`crit`), d'un robot détruit (`kill`), dégâts reçus (`hurt`), zone prise par son équipe
   * (`capture`) ou par l'adversaire (`lost`), verrouillage acquis (`lock`).
   */
  ui(kind: UiKind): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || this.voices >= MAX_VOICES) return;
    // Hors partie (pause, fin de partie, menu, garage), les signaux de combat se taisent
    if (!cueAllowed(kind, this.scene)) return;
    const t = ctx.currentTime;
    const gap = UI_GAP[kind];
    if (gap !== undefined) {
      if (t - (this.lastUi.get(kind) ?? -Infinity) < gap) return;
      this.lastUi.set(kind, t);
    }
    const sound = UI_SAMPLES[kind];
    if (sound && this.sample(null, sound.key, sound.gain, sound.rate)) return;
    this.trace?.(i18n.t("hud.soundLog.synth", { sound: kind }));
    const tone = (type: OscillatorType, from: number, to: number, start: number, decay: number, gain: number): void => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t + start);
      osc.frequency.exponentialRampToValueAtTime(to, t + start + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.setValueAtTime(gain, t + start);
      g.gain.exponentialRampToValueAtTime(0.001, t + start + decay);
      osc.connect(g).connect(this.master!);
      osc.start(t);
      this.track(osc, t + start + decay + 0.05);
    };
    switch (kind) {
      case "hit":
        tone("sine", 1900, 1500, 0, 0.05, 0.12);
        break;
      case "crit":
        tone("triangle", 950, 620, 0, 0.09, 0.16);
        break;
      case "kill":
        tone("triangle", 660, 640, 0, 0.1, 0.18);
        tone("triangle", 990, 980, 0.1, 0.16, 0.18);
        break;
      case "hurt":
        tone("sine", 170, 80, 0, 0.18, 0.28);
        break;
      case "capture":
        tone("triangle", 520, 520, 0, 0.14, 0.16);
        tone("triangle", 780, 780, 0.12, 0.22, 0.16);
        break;
      case "lost":
        tone("triangle", 620, 600, 0, 0.14, 0.15);
        tone("triangle", 410, 400, 0.12, 0.24, 0.15);
        break;
      case "lock":
        tone("square", 1250, 1240, 0, 0.07, 0.06);
        tone("square", 1250, 1240, 0.1, 0.12, 0.06);
        break;
      case "locking":
        tone("square", 1150, 1150, 0, 0.035, 0.045);
        break;
      default:
        // Les autres n'ont pas d'équivalent synthétisé : rien tant que leur son n'est pas chargé
        break;
    }
  }

  /** Mèches de barils et fuites de gaz : les plus proches sifflent en boucle, et suivent l'accessoire. */
  private updateProps(): void {
    for (const p of this.props) this.propAt.set(p, p.rb.translation());
    const bank = this.samples;
    if (!bank) return;
    const loud = [...this.props]
      .filter((p) => p.state.kind !== "intact" && distance(p.rb.translation(), this.listener) < HEARING)
      .sort((a, b) => distance(a.rb.translation(), this.listener) - distance(b.rb.translation(), this.listener))
      .slice(0, PROP_VOICES);
    const heard = new Set(loud);
    for (const v of this.propVoices) {
      if (v.prop && (!heard.has(v.prop) || !this.props.has(v.prop))) {
        v.loop.release();
        v.prop = null;
      }
    }
    for (const prop of loud) {
      const key: SampleKey = prop.state.kind === "fuse" ? "fuse-hiss" : "gas-leak";
      let v = this.propVoices.find((x) => x.prop === prop);
      if (!v) {
        v = this.propVoices.find((x) => !x.prop);
        const buffer = bank.pick(key);
        if (!v || !buffer) continue;
        v.prop = prop;
        v.loop.play(key, buffer);
      }
      v.loop.place(prop.rb.translation());
      v.loop.set(SAMPLES[key].gain, 1, 0.1);
    }
  }

  /** Une mine qui se pose s'arme d'un bip ; une ventouse collée bipe jusqu'à son explosion. */
  private updateMines(): void {
    for (const p of this.mines) {
      if (!p.landed) continue;
      this.mines.delete(p);
      this.sample(p.pos, "mine-arm");
    }
    const t = this.ctx!.currentTime;
    for (const [p, next] of this.limpets) {
      if (t < next) continue;
      this.limpets.set(p, t + LIMPET_BEEP);
      this.sample(p.pos, "mine-arm", 1.6, 1.4);
    }
  }

  /**
   * Alertes du robot du joueur : dégâts critiques, batteries presque vides (robot volant), et un
   * missile ennemi proche qui file droit sur lui (d'après sa trajectoire : le verrou d'un ennemi
   * ne passe pas par le réseau).
   */
  private updateAlerts(): void {
    const t = this.ctx!.currentTime;
    const player = this.sim.player;
    if (!player?.cockpit.alive || !this.scene.cues) return;
    if (t - this.lastCritical > CRITICAL_EVERY && integrity(player) < CRITICAL_INTEGRITY) {
      this.lastCritical = t;
      this.ui("critical");
    }
    if (t - this.lastBattery > BATTERY_EVERY && player.thrusters.length > 0 && energyFraction(player) < LOW_BATTERY) {
      this.lastBattery = t;
      this.ui("battery");
    }
    if (t - this.lastWarning > WARNING_EVERY) {
      const target = player.lastPos;
      const threat = [...this.flying].some((p) => {
        if (!GUIDED.has(p.weapon) || !p.shooter || p.shooter.team === player.team) return false;
        const to = sub(target, p.pos);
        const d = Math.hypot(to.x, to.y, to.z);
        const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
        return d < WARNING_RANGE && speed > 1 && dot(to, p.vel) / (d * speed) > WARNING_AIM;
      });
      if (threat) {
        this.lastWarning = t;
        this.ui("missile");
      }
    }
  }

  /** La partie : sirène de départ, compte à rebours des dix dernières secondes, colline qui se déplace. */
  private updateMatch(): void {
    const match = this.sim.match;
    if (match !== this.match) {
      // Une partie qui se prépare (écran de chargement) n'a pas encore commencé : sa sirène attend
      // l'écran de jeu, où les signaux de combat passent
      if (match && !this.scene.cues) return;
      this.match = match;
      this.countdown = -1;
      this.hill = match ? match.zones.findIndex((z) => z.active) : -1;
      if (match && match.elapsed < 2) this.ui("start");
    }
    if (!match || match.winner !== null) return;
    const limit = match.rules.timeLimit;
    if (limit > 0) {
      const left = Math.ceil(limit - match.elapsed);
      if (left <= 10 && left > 0 && left !== this.countdown) {
        this.countdown = left;
        this.ui("tick");
      }
    }
    const hill = match.zones.findIndex((z) => z.active);
    if (match.rules.capture?.hill && hill !== this.hill) {
      if (this.hill >= 0 && hill >= 0) this.ui("hill");
      this.hill = hill;
    }
  }

  /**
   * Joue un son enregistré, une variante au hasard : en `at` (hauteur un peu variée), ou sans
   * spatialisation (null : interface). Faux s'il n'est pas chargé : on joue alors son équivalent
   * synthétisé. Vrai aussi quand il est trop loin pour être entendu (rien à jouer).
   */
  private sample(at: Vec3 | null, key: SampleKey, gain = 1, rate = 1, vary = at !== null, out: AudioNode | null = this.master): boolean {
    const buffer = this.samples?.pick(key);
    if (!buffer) return false;
    const def: { gain: number; reach?: number; hearing?: number } = SAMPLES[key];
    if (at ? !this.audible(at, def.hearing) : this.voices >= MAX_VOICES) return true;
    this.trace?.(at ? i18n.t("hud.soundLog.at", { sound: key, distance: i18n.measure(distance(at, this.listener), "m") }) : key);
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = vary ? rate * (1 + (Math.random() - 0.5) * PITCH_SPREAD) : rate;
    const g = ctx.createGain();
    g.gain.value = gain * def.gain;
    src.connect(g).connect(at ? this.panner(at, def.reach) : out!);
    const t = ctx.currentTime;
    src.start(t);
    this.track(src, t + buffer.duration / src.playbackRate.value + 0.05);
    return true;
  }

  /**
   * Une arme à tir continu tire en `at` : sa boucle y joue (celle qui jouait déjà à côté, pour la
   * même arme, continue) et se tait `hold` s après son dernier tir. Faux si la boucle n'est pas chargée.
   */
  private sustain(at: Vec3, key: SampleKey, hold = SUSTAIN_HOLD, gain = 1): boolean {
    const buffer = this.samples?.pick(key);
    if (!buffer) return false;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    let v = this.sustains.find((s) => s.loop.key === key && distance(s.at, at) < 4);
    if (!v) {
      if (distance(at, this.listener) > HEARING) return true;
      v = this.sustains.find((s) => !s.loop.playing);
      if (!v && this.sustains.length < SUSTAIN_VOICES) {
        v = { loop: new LoopVoice(ctx, this.worldBus!, true), at, until: 0 };
        this.sustains.push(v);
      }
      // Toutes occupées : la plus ancienne change d'arme
      v ??= this.sustains.reduce((a, b) => (a.until < b.until ? a : b));
      v.loop.play(key, buffer);
    }
    v.at = at;
    v.until = t + hold;
    v.loop.place(at);
    v.loop.set(SAMPLES[key].gain * gain, 1, 0.02);
    return true;
  }

  private updateSustains(): void {
    const t = this.ctx!.currentTime;
    for (const v of this.sustains) if (v.loop.playing && t > v.until) v.loop.release();
  }

  /**
   * Les projectiles en vol les plus proches font entendre leur propulseur ou leur sifflement, qui
   * les suit ; plus aigu quand ils approchent, plus grave quand ils s'éloignent (effet Doppler).
   */
  private updateFlights(dt: number): void {
    const bank = this.samples;
    if (!bank) return;
    this.flightTimer -= dt;
    if (this.flightTimer <= 0) {
      this.flightTimer = FLIGHT_PICK;
      const near = [...this.flying]
        .filter((p) => !p.landed && distance(p.pos, this.listener) < FLIGHT_HEARING)
        .sort((a, b) => distance(a.pos, this.listener) - distance(b.pos, this.listener))
        .slice(0, FLIGHT_VOICES);
      const heard = new Set(near);
      for (const v of this.flights) {
        if (v.projectile && !heard.has(v.projectile)) {
          v.loop.release();
          v.projectile = null;
        }
      }
      for (const p of near) {
        if (this.flights.some((v) => v.projectile === p)) continue;
        const v = this.flights.find((f) => !f.projectile);
        const key = FLIGHT_SOUNDS[p.weapon];
        const buffer = key && bank.pick(key);
        if (!v || !key || !buffer) continue;
        v.projectile = p;
        v.loop.play(key, buffer);
        v.loop.place(p.pos);
        v.loop.set(0, 1, 0.01);
      }
    }
    for (const v of this.flights) {
      const p = v.projectile;
      if (!p || !v.loop.key) continue;
      if (!this.flying.has(p)) {
        v.loop.release();
        v.projectile = null;
        continue;
      }
      const toward = dot(p.vel, norm(sub(this.listener, p.pos)));
      const doppler = clamp(SOUND_SPEED / (SOUND_SPEED - clamp(toward, -200, 200)), 0.6, 1.7);
      const fall = FLIGHT_FALL[p.weapon] ?? 0;
      const pitch = 1 + fall / 2 - fall * Math.min(1, p.age / FALL_WHISTLE);
      v.loop.place(p.pos);
      v.loop.set(SAMPLES[v.loop.key as SampleKey].gain, doppler * pitch, 0.05);
    }
  }

  /** Une balle d'un autre qui passe tout près de la caméra ou de son robot siffle à l'oreille. */
  private updateFlybys(): void {
    const t = this.ctx!.currentTime;
    const player = this.sim.player;
    const ears = player?.cockpit.alive ? [this.listener, player.lastPos] : [this.listener];
    for (const [p, last] of this.whizzing) {
      // Ses propres tirs ne sifflent pas (ceux de la caméra libre n'ont pas de tireur : ils partent d'elle)
      const mine = p.shooter === null || p.shooter === player;
      const near = !mine && ears.some((ear) => segmentDistance(last, p.pos, ear) < FLYBY_RADIUS);
      if (near) {
        this.whizzing.delete(p);
        if (t - this.lastFlyby > FLYBY_GAP && this.sample(p.pos, "bullet-flyby")) this.lastFlyby = t;
      } else {
        this.whizzing.set(p, p.pos);
      }
    }
  }

  /** Les feux les plus proches crépitent : blocs, bois du décor (plus fort), flaques au sol. */
  private updateFires(): void {
    const bank = this.samples;
    if (!bank) return;
    for (const b of this.burning) if (!b.alive) this.burning.delete(b);
    const all: { source: Block | Prop | GroundFire; at: Vec3; gain: number }[] = [
      ...[...this.burning].map((block) => ({ source: block, at: blockWorldPos(block), gain: 1 })),
      // (un accessoire en feu est encore là : on peut lire son corps ; un arbre brûle surtout dans son feuillage)
      ...[...this.burningProps].map((prop) => {
        const c = prop.rb.translation();
        return { source: prop, at: { x: c.x, y: c.y + prop.half.y * 0.4, z: c.z }, gain: 1.4 };
      }),
      ...[...this.groundFires].map((fire) => ({ source: fire, at: fire.pos, gain: 0.8 })),
    ];
    const near = all
      .filter((f) => distance(f.at, this.listener) < HEARING)
      .sort((a, b) => distance(a.at, this.listener) - distance(b.at, this.listener))
      .slice(0, FIRE_VOICES);
    const heard = new Set(near.map((f) => f.source));
    for (const v of this.fires) {
      if (v.source && !heard.has(v.source)) {
        v.loop.release();
        v.source = null;
      }
    }
    for (const f of near) {
      let v = this.fires.find((x) => x.source === f.source);
      if (!v) {
        v = this.fires.find((x) => !x.source);
        const buffer = bank.pick("fire-loop");
        if (!v || !buffer) continue;
        v.source = f.source;
        v.loop.play("fire-loop", buffer);
      }
      v.loop.place(f.at);
      v.loop.set(SAMPLES["fire-loop"].gain * f.gain, 1, 0.3);
    }
  }

  /**
   * L'ambiance de l'arène en place, en boucle, sans spatialisation. Une carte venue d'un paquet peut
   * avoir la sienne (`MapAssets.ambience`) : décodée une fois (ses octets viennent de ses ressources,
   * client/maps/assets.ts), elle remplace celle d'une arène du jeu, qui joue en attendant ou si elle
   * ne se lit pas.
   */
  private updateAmbience(): void {
    const ambience = this.ambience;
    const bank = this.samples;
    if (!ambience || !bank) return;
    const own = this.sim.arena.assets?.ambience;
    const mine = own ? this.mapAmbience(own) : null;
    if (mine && own) {
      const key = `map:${own.sha256}`;
      if (key === ambience.key) return;
      ambience.play(key, mine.buffer, mine.loopStart, mine.buffer.duration);
      ambience.set(AMBIENCE_LEVEL * MAP_AMBIENCE_GAIN, 1, 1);
      return;
    }
    // Une carte communautaire prend l'ambiance d'une arène du jeu (`ArenaLayout.ambience`)
    const key = AMBIENCES[this.sim.arena.ambience ?? this.sim.arena.id] ?? null;
    if (key === ambience.key) return;
    const buffer = key && bank.pick(key);
    if (!key || !buffer) {
      ambience.release();
      return;
    }
    ambience.play(key, buffer);
    ambience.set(AMBIENCE_LEVEL * SAMPLES[key].gain, 1, 1);
  }

  /** L'ambiance de la carte en place, décodée (une seule à la fois : ~0,4 Mo par seconde de son). */
  private ownAmbience: OwnAmbience | null = null;

  /** L'ambiance d'une carte, si elle est décodée ; sinon null (son décodage commence, s'il n'est pas en cours ou raté). */
  private mapAmbience(asset: MapAsset): { buffer: AudioBuffer; loopStart: number } | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const known = this.ownAmbience;
    if (known?.hash === asset.sha256) return known.state === "ready" && known.buffer ? { buffer: known.buffer, loopStart: known.loopStart } : null;
    const state: OwnAmbience = { hash: asset.sha256, state: "loading", buffer: null, loopStart: 0 };
    this.ownAmbience = state;
    void (async () => {
      try {
        const bytes = await mapAssets.bytes({ path: PACKAGE_FILES.ambience, asset, type: null });
        if (!bytes) throw new Error("ressource absente ou fautive");
        // (decodeAudioData détache le tampon qu'on lui donne : une copie)
        const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
        state.loopStart = mendForeignLoop(buffer);
        state.buffer = buffer;
        state.state = "ready";
      } catch (e) {
        console.warn(`Ambiance de la carte illisible (${asset.sha256}) : celle d'une arène du jeu la remplace`, e);
        state.state = "failed";
      }
    })();
    return null;
  }

  /** Le tir part-il d'une tourelle du robot du joueur ? (Il s'entend alors pleinement, voir OWN_SHOT_RADIUS.) */
  private ownShot(origin: Vec3): boolean {
    const player = this.sim.player;
    if (!player?.cockpit.alive) return false;
    return player.turrets.some((t) => t.block.alive && distance(blockWorldPos(t.block), origin) < OWN_SHOT_RADIUS);
  }

  /** Un nœud de spatialisation en `at`, relié au bus du monde ; `reach` : distance de plein volume (m). */
  private panner(at: Vec3, reach = 5): PannerNode {
    const p = makePanner(this.ctx!);
    p.refDistance = reach;
    placePanner(p, at);
    p.connect(this.worldBus!);
    return p;
  }

  /** Peut-on jouer un son de plus, à cet endroit (jusqu'à `hearing` m) ? */
  private audible(at: Vec3, hearing = HEARING): boolean {
    return this.voices < MAX_VOICES && distance(at, this.listener) < hearing;
  }

  private track(node: AudioScheduledSourceNode, until: number): void {
    this.voices++;
    node.onended = () => this.voices--;
    node.stop(until);
  }

  /** Bruit filtré qui s'éteint en `decay` s : détonation, impact, souffle. */
  private burst(at: Vec3, freq: number, type: BiquadFilterType, decay: number, gain: number): void {
    if (!this.audible(at)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(filter).connect(g).connect(this.panner(at));
    src.start(t, Math.random() * 0.5);
    this.track(src, t + decay + 0.05);
  }

  /** Coup sourd : une sinusoïde grave qui retombe. */
  private thump(at: Vec3, freq: number, decay: number, gain: number, reach = 5): void {
    this.sweep(at, "sine", freq * 1.6, freq, decay, gain, reach);
  }

  /** Oscillateur dont la fréquence glisse de `from` à `to` pendant `decay` s. */
  private sweep(at: Vec3, type: OscillatorType, from: number, to: number, decay: number, gain: number, reach = 5): void {
    if (!this.audible(at, reach > 5 ? HEARING * 2.5 : HEARING)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    osc.connect(g).connect(this.panner(at, reach));
    osc.start(t);
    this.track(osc, t + decay + 0.05);
  }

  /**
   * Ce qu'on entend d'un robot proche en plus de son moteur : le gyroscope qui le redresse, et
   * ses pas s'il marche. Deux groupes de pattes alternent (voir `LocomotionView`) : un pied se pose
   * chaque fois que la phase de la marche passe un demi-tour.
   */
  private stepSounds(bot: Bot, speed: number): void {
    let state = this.walked.get(bot);
    const leg = bot.supports.find((s) => blockDef(s.block.type).support?.kind === "leg");
    const step = leg ? Math.floor((leg.phase + Math.PI / 2) / Math.PI) : 0;
    if (!state) {
      state = { righting: bot.righting, step };
      this.walked.set(bot, state);
    }
    if (bot.righting > 0 && state.righting <= 0) this.sample(bot.lastPos, "righting");
    state.righting = bot.righting;
    if (leg && step !== state.step && speed > 0.2) this.sample(bot.lastPos, "footstep", Math.min(1, 0.4 + speed * 0.15));
    state.step = step;
  }

  // --- Armes de contact ---

  /**
   * Le son enregistré d'un coup ou d'un départ d'arme de contact, en `at` : un son bref (volume
   * `gain`, hauteur `rate`, multipliés par ceux de `s`), ou une boucle tenue tant que les coups se
   * suivent (`MELEE_HOLD`). Faux s'il n'est pas chargé : on joue alors le son synthétisé.
   */
  private meleeSample(at: Vec3, s: MeleeSample, gain: number, rate: number): boolean {
    const { key, rate: own, gain: level } = meleeSample(s);
    if ("loop" in SAMPLES[key]) return this.sustain(at, key, MELEE_HOLD, gain * level);
    return this.sample(at, key, gain * level, rate * own);
  }

  /**
   * Le coup d'une arme d'énergie, synthétisé (selon son allure) : la lame laser grésille (un souffle
   * aigu et une note qui retombe), le fouet claque et brûle, la lance crépite, le champ crache (un
   * bourdon qui s'écrase). Faux pour une arme d'acier (son coup est celui de `meleeHit`).
   */
  private energyHit(at: Vec3, look: MeleeLook, k: number): boolean {
    const g = Math.min(1, 0.4 + 0.6 * k);
    switch (look) {
      case "saber":
        this.burst(at, 4200, "highpass", 0.09, 0.22 * g);
        this.sweep(at, "sawtooth", 680, 420, 0.1, 0.05 * g);
        return true;
      case "whip":
        this.burst(at, 3200, "highpass", 0.05, 0.45 * g);
        this.burst(at, 900, "bandpass", 0.35, 0.25 * g);
        this.thump(at, 70, 0.18, 0.2 * g);
        return true;
      case "lance":
        this.sweep(at, "square", 3000, 400, 0.16, 0.07 * g);
        this.burst(at, 6000, "highpass", 0.25, 0.3 * g);
        return true;
      case "field":
        this.sweep(at, "square", 240, 70, 0.14, 0.05 * g);
        this.burst(at, 1500, "bandpass", 0.12, 0.2 * g);
        return true;
      default:
        return false;
    }
  }

  private meleeVoice(ctx: AudioContext): MeleeVoice {
    const osc = ctx.createOscillator();
    osc.type = WHINE.wave;
    osc.frequency.value = WHINE.base;
    const overtone = ctx.createOscillator();
    overtone.type = "sine";
    overtone.frequency.value = WHINE.base * WHINE.overtone;
    const filter = ctx.createBiquadFilter();
    filter.type = WHINE.filter;
    filter.Q.value = WHINE.q;
    filter.frequency.value = 600;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = this.panner(this.listener, 6);
    osc.connect(filter);
    overtone.connect(filter);
    filter.connect(gain).connect(panner);
    osc.start();
    overtone.start();
    // Le grincement d'une lame qui mord : du bruit, en boucle, filtré autour de sa fréquence
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    const grindFilter = ctx.createBiquadFilter();
    grindFilter.type = "bandpass";
    grindFilter.frequency.value = 1000;
    const grindGain = ctx.createGain();
    grindGain.gain.value = 0;
    noise.connect(grindFilter).connect(grindGain).connect(panner);
    noise.start();
    return {
      arm: null, osc, overtone, filter, gain, panner, loop: new LoopVoice(ctx, panner, false),
      grindFilter, grindGain, biteLoop: new LoopVoice(ctx, panner, false),
    };
  }

  /**
   * Les rotors des armes de contact les plus proches sifflent, plus aigu et plus fort avec leur
   * régime (un rotor déséquilibré bat : son volume tremble), chacun de son ton (`MeleeSounds.tone` :
   * une lame laser bourdonne, un champ vrombit, la scie siffle aigu, la foreuse gronde) ; une lame
   * qui mord grince (sa coupe, d'autant plus fort qu'elle y met de la puissance, qui accroche et
   * tremble ; son régime, qui baisse sous la charge, fait descendre son sifflement). Un bras qui part
   * fait entendre son vérin (marteau) ou claque (fouet) ; une lance qui sort crépite.
   */
  private updateMelee(dt: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.meleeTimer -= dt;
    if (this.meleeTimer <= 0) {
      this.meleeTimer = MELEE_PICK;
      const spinning: MeleeArm[] = [];
      for (const bot of this.sim.bots) {
        for (const arm of bot.melee) {
          // (une hélice s'entend avec son moteur)
          const spec = meleeDef(arm.weapon);
          if (arm.block.alive && spec.motion !== "driven" && (spec.spin || spec.flail) && arm.spin > 1 && distance(bot.lastPos, this.listener) < HEARING) spinning.push(arm);
        }
      }
      spinning.sort((a, b) => distance(a.block.bot.lastPos, this.listener) - distance(b.block.bot.lastPos, this.listener));
      this.meleeVoices.forEach((v, i) => (v.arm = spinning[i] ?? null));
    }
    for (const v of this.meleeVoices) {
      const arm = v.arm;
      const flail = arm ? meleeDef(arm.weapon).flail : undefined;
      if (arm && flail && arm.block.alive) {
        // La boule d'un fléau : un souffle grave qui passe deux fois par tour, plus aigu avec le régime
        placePanner(v.panner, arm.ball?.pos ?? arm.block.bot.lastPos);
        const ratio = clamp(arm.spin / flail.speed, 0, 1.2);
        const swoosh = 0.3 + 0.7 * Math.abs(Math.sin(arm.angle));
        const whine = MELEE_SOUNDS[arm.weapon].whine;
        const s = whine ? meleeSample(whine) : null;
        const buffer = s ? this.samples?.variant(s.key, arm.block.id) : null;
        if (s && buffer) {
          // Enregistré : la chaîne qui tournoie (des aigus seulement), qui enfle deux fois par tour
          // quand la boule passe ; le souffle grave synthétisé reste dessous, plus bas
          v.loop.play(s.key, buffer);
          v.loop.set(ratio * ratio * SAMPLES[s.key].gain * s.gain * (0.45 + 0.55 * swoosh), s.rate * (0.6 + 0.6 * ratio), 0.04);
        } else v.loop.release();
        // (les voix servent à toutes les armes qui tournent : la sienne, une dent de scie filtrée)
        if (v.osc.type !== "sawtooth") v.osc.type = "sawtooth";
        if (v.filter.type !== "bandpass") v.filter.type = "bandpass";
        v.filter.Q.setTargetAtTime(3, t, 0.05);
        const freq = 55 + 160 * ratio;
        v.osc.frequency.setTargetAtTime(freq, t, 0.08);
        v.overtone.frequency.setTargetAtTime(freq * 1.51, t, 0.08);
        v.filter.frequency.setTargetAtTime(freq * 2.2, t, 0.08);
        v.gain.gain.setTargetAtTime(FLAIL_LEVEL * ratio * ratio * swoosh * (buffer ? FLAIL_UNDER : 1), t, 0.03);
        continue;
      }
      const spin = arm ? meleeDef(arm.weapon).spin : undefined;
      if (!arm || !spin || !arm.block.alive) {
        v.gain.gain.setTargetAtTime(0, t, 0.08);
        v.grindGain.gain.setTargetAtTime(0, t, 0.08);
        v.loop.release();
        v.biteLoop.release();
        continue;
      }
      placePanner(v.panner, arm.block.bot.lastPos);
      const sounds = MELEE_SOUNDS[arm.weapon];
      const tone = sounds.tone ?? WHINE;
      const ratio = clamp(arm.spin / spin.speed, 0, 1.2);
      const health = arm.block.hp / blockDef(arm.block.type).hp;
      const beat = health < 0.5 ? 1 - 0.5 * (0.5 - health) * 2 * (0.5 + 0.5 * Math.sin(t * arm.spin)) : 1;
      // La coupe : un grincement qui accroche (son volume et sa hauteur tremblent), plus fort avec sa puissance
      const bite = arm.bite;
      const biting = bite ? Math.min(1.3, bite.power / GRIND_POWER) * (bite.glance ? 0.6 : 1) : 0;
      const biteSound = sounds.bite ? meleeSample(sounds.bite) : null;
      const biteBuffer = biteSound && biting > 0 ? this.samples?.variant(biteSound.key, arm.block.id) : null;
      if (biteSound && biteBuffer) {
        v.grindGain.gain.setTargetAtTime(0, t, 0.05);
        v.biteLoop.play(biteSound.key, biteBuffer);
        // (son volume tremble un peu, comme le grincement synthétisé : les dents accrochent)
        v.biteLoop.set(biting * SAMPLES[biteSound.key].gain * biteSound.gain * (0.85 + 0.3 * Math.random()), biteSound.rate * (0.8 + 0.3 * ratio), 0.05);
      } else {
        v.biteLoop.release();
        const grind = tone.grind;
        if (grind) {
          v.grindFilter.Q.value = grind.q;
          v.grindFilter.frequency.setTargetAtTime(grind.freq * (0.75 + 0.35 * ratio) * (0.9 + 0.2 * Math.random()), t, 0.02);
        }
        v.grindGain.gain.setTargetAtTime((grind?.level ?? 0) * biting * (0.65 + 0.7 * Math.random()), t, 0.025);
      }
      const whine = sounds.whine ? meleeSample(sounds.whine) : null;
      const buffer = whine ? this.samples?.variant(whine.key, arm.block.id) : null;
      if (whine && buffer) {
        v.gain.gain.setTargetAtTime(0, t, 0.1);
        v.loop.play(whine.key, buffer);
        v.loop.set(ratio * ratio * SAMPLES[whine.key].gain * whine.gain * beat, whine.rate * (0.5 + 0.7 * ratio));
        continue;
      }
      v.loop.release();
      if (v.osc.type !== tone.wave) v.osc.type = tone.wave;
      if (v.filter.type !== tone.filter) v.filter.type = tone.filter;
      v.filter.Q.setTargetAtTime(tone.q, t, 0.05);
      const freq = tone.base + tone.perRad * arm.spin;
      const pulse = tone.beat ? 1 - 0.35 * (0.5 + 0.5 * Math.sin(2 * Math.PI * tone.beat * t)) : 1;
      v.osc.frequency.setTargetAtTime(freq, t, 0.08);
      v.overtone.frequency.setTargetAtTime(freq * tone.overtone, t, 0.08);
      v.filter.frequency.setTargetAtTime(freq * tone.cutoff, t, 0.08);
      v.gain.gain.setTargetAtTime(tone.level * ratio * ratio * beat * pulse, t, 0.06);
    }
    // Un bras ou une pointe qui part : le vérin qui se détend (marteau), le claquement du fouet, la
    // lance qui crépite ; le plateau d'un flipper, une détonation pneumatique ; une mâchoire qui se
    // ferme, un claquement hydraulique
    for (const bot of this.sim.bots) {
      for (const arm of bot.melee) {
        const spec = meleeDef(arm.weapon);
        if (!spec.swing && !spec.thrust && !spec.plate && !spec.jaw) continue;
        const was = this.swingPhases.get(arm);
        this.swingPhases.set(arm, arm.phase);
        if (arm.phase !== "strike" || was === "strike" || was === undefined || !arm.block.alive) continue;
        const at = bot.lastPos;
        const swing = MELEE_SOUNDS[arm.weapon].swing;
        if (swing && this.meleeSample(at, swing, 1, 1)) continue;
        switch (spec.look) {
          case "plate":
            // Le vérin du flipper qui se vide d'un coup
            this.burst(at, 520, "bandpass", 0.32, 0.75);
            this.thump(at, 48, 0.3, 0.7, 8);
            this.burst(at, 3200, "highpass", 0.5, 0.18);
            break;
          case "jaw":
            // Les mâchoires qui claquent
            this.burst(at, 300, "lowpass", 0.14, 0.4);
            this.thump(at, 90, 0.16, 0.45, 6);
            break;
          case "whip":
            // Un souffle qui monte, puis le claquement du plasma
            this.sweep(at, "sawtooth", 220, 1400, 0.18, 0.06);
            this.burst(at, 3800, "highpass", 0.06, 0.4);
            this.burst(at, 1800, "bandpass", 0.3, 0.18);
            break;
          case "lance":
            // Une décharge qui grésille en sortant
            this.sweep(at, "square", 2600, 900, 0.12, 0.05);
            this.burst(at, 5200, "highpass", 0.14, 0.22);
            break;
          default:
            this.burst(at, 900, "bandpass", 0.28, 0.35);
            this.sweep(at, "sawtooth", 160, 70, 0.22, 0.08);
        }
      }
    }
  }

  // --- Moteurs ---

  private engineVoice(ctx: AudioContext): EngineVoice {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 50;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 400;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = this.panner(this.listener);
    osc.connect(filter).connect(gain).connect(panner);
    osc.start();
    return { bot: null, osc, filter, gain, panner, loop: new LoopVoice(ctx, panner, false) };
  }

  /**
   * Les moteurs des robots les plus proches, chacun selon ce qui le fait avancer (`locomotion`),
   * avec une variante par robot : enregistrés une fois chargés ; jusque-là, un ronflement
   * synthétisé (plus aigu avec la vitesse) ou un bourdonnement pour les rotors.
   */
  private updateEngines(dt: number): void {
    const ctx = this.ctx!;
    this.pickTimer -= dt;
    if (this.pickTimer <= 0) {
      this.pickTimer = ENGINE_PICK;
      const near = this.sim.bots
        .filter((b) => b.cockpit.alive)
        .sort((a, b) => distance(a.lastPos, this.listener) - distance(b.lastPos, this.listener))
        .slice(0, ENGINE_VOICES);
      this.engines.forEach((v, i) => (v.bot = near[i] ?? null));
    }
    const t = ctx.currentTime;
    for (const v of this.engines) {
      const bot = v.bot;
      if (!bot || !bot.cockpit.alive) {
        v.gain.gain.setTargetAtTime(0, t, 0.1);
        v.loop.release();
        continue;
      }
      placePanner(v.panner, bot.lastPos);
      const vel = bot.cockpit.part.rb.linvel();
      const speed = Math.hypot(vel.x, vel.y, vel.z);
      const thrust = bot.thrusters.reduce((s, x) => s + x.thrust, 0);
      const maxThrust = bot.thrusters.reduce((s, x) => s + (blockDef(x.block.type).thruster?.maxThrust ?? 0), 0);
      const power = maxThrust > 0 ? clamp(thrust / maxThrust, 0, 1) : 0;
      const rotor = bot.thrusters.length > 0 && thrust > 1;
      const driving = drivenWheels(bot).some((w) => Math.abs(w.drive) > 0.05) || bot.supports.length > 0;
      this.stepSounds(bot, speed);
      const sound = locomotion(bot, speed, power, driving);
      const buffer = this.samples?.variant(sound.key, bot.id);
      if (buffer) {
        v.gain.gain.setTargetAtTime(0, t, 0.15);
        v.loop.play(sound.key, buffer);
        v.loop.set(sound.level * SAMPLES[sound.key].gain, sound.rate);
        continue;
      }
      v.loop.release();
      const freq = rotor ? 85 + Math.min(140, thrust / 4) : 38 + speed * 11;
      const level = rotor ? 0.07 : driving ? 0.04 + Math.min(0.06, speed * 0.01) : 0.015;
      v.osc.frequency.setTargetAtTime(freq, t, 0.1);
      v.filter.frequency.setTargetAtTime(rotor ? 900 : 300 + speed * 60, t, 0.1);
      v.gain.gain.setTargetAtTime(level, t, 0.15);
    }
  }
}
