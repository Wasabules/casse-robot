import { weaponDef } from "../catalog/weapons";
import { liveTurrets } from "../combat/turrets";
import { blockDef } from "../catalog/blocks";
import { AIR_DENSITY, GRAVITY } from "../config";
import { clamp } from "../math/scalar";
import { add, cross, dot, norm, qrot, scale, sub, vec3, type Vec3 } from "../math/vec";
import { liveFlaps, steerSurfaces } from "../robot/aero";
import { runEngines } from "../robot/propulsion";
import { liveThrusters } from "../robot/queries";
import { groundLevel } from "../arena/layout";
import type { AiState, Bot } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/** Guidage L1 : distance du point visé sur le circuit (m), et distance minimale prise en compte. */
const L1_DISTANCE = 30;
const L1_MIN = 12;
/**
 * Inclinaison maximale en virage du pilote automatique (rad : circuit, passes de bombardement) ;
 * assiette maximale en montée et en descente (rad).
 */
const MAX_BANK = 0.75;
/** Inclinaison au plus pour ramener un avion piloté de sa limite (rad, 60°) : il lui faut virer court. */
const RETURN_BANK = 1.05;
/**
 * Pilotage manuel : amortissement du roulis, du tangage et du lacet (part du manche par rad/s de
 * rotation : manche lâché, l'avion cesse de tourner), et vitesse à laquelle le trim de profondeur
 * annule le tangage quand le manche est au neutre.
 */
const ROLL_DAMP = 0.35;
const PITCH_DAMP = 0.5;
const YAW_DAMP = 0.6;
const AUTO_TRIM = 0.8;
/**
 * Virage à plat (palonnier, A et E) : vitesse de lacet voulue à la souris, touche tenue
 * (rad/s ; les ailes restent à plat). L'aide contre le dérapage (`slipAssist`) ramène la trajectoire
 * dans l'axe du nez : elle tourne la vitesse horizontale vers le nez (la vitesse de côté baisse au
 * rythme `SLIP_GRIP`, 1/s), sans la ralentir, sans dépasser l'accélération latérale `SLIP_MAX`
 * (m/s²), et retombe en `SLIP_FADE` s après la touche lâchée. Sans elle, la dérive ramenait le nez
 * face au vent : l'avion glissait de côté et tournait à peine ; en retirant la vitesse de côté sans
 * la reporter vers l'avant, il ralentissait, portait moins et s'enfonçait (20 m en 4 s en manuel).
 */
const FLAT_TURN_RATE = 0.7;
/** Raideur de la dérive en virage à plat (part du palonnier par rad/s d'écart) : sa gouverne seule tourne lentement. */
const FLAT_TURN_GAIN = 3;
const SLIP_GRIP = 6;
const SLIP_MAX = 10;
const SLIP_FADE = 0.8;
/** L'inclinaison diminue à partir de LOW_START m sous l'altitude voulue, jusqu'au quart LOW_SPAN m plus bas. */
const LOW_START = 2;
const LOW_SPAN = 6;
/** Profondeur tirée en virage, par unité de facteur de charge au-delà de 1 (voir `fly`). */
const TURN_PULL = 0.5;
/**
 * En virage incliné de φ, l'aile doit porter 1/cos φ fois le poids : on ne s'incline pas plus
 * que ce que ses ailes peuvent porter à la vitesse du moment (avec cette marge), sans quoi l'avion
 * s'enfonce et pique. Une grande aile, ou de la vitesse, permettent de virer plus serré.
 */
const LIFT_MARGIN = 0.9;
const MIN_BANK = 0.3;
const MAX_PITCH = 0.3;
/** Assiette de plané sans moteur (rad) : le nez un peu bas, pour garder de la vitesse. */
const GLIDE_PITCH = -0.1;
/** Inclinaison maximale en plané : sans moteur, un virage serré fait perdre trop d'altitude. */
const GLIDE_BANK = 0.3;
/**
 * Moteurs affaiblis (abîmés, ou un raté : voir `wearEngines`, robot/propulsion.ts) : sous cette
 * part de sa vitesse de croisière, la vitesse passe avant l'altitude, et il prend peu à peu
 * l'assiette de plané (toute à `WEAK_SLOW - 0.2`). Sans quoi il cabrait pour tenir son altitude
 * jusqu'au décrochage : l'Avion au moteur à 25 % s'écrasait sept fois sur huit.
 */
const WEAK_SLOW = 0.9;
/**
 * Atterrissage forcé : à moins de `GROUNDED` m du sol sans la poussée de remonter (moteurs abîmés, à
 * moins de `TAKEOFF_POWER` de leur pleine poussée ; sans moteur, il plane jusqu'au bout), il se pose : gaz coupés, ailes à
 * plat, le nez un peu levé (`FLARE`), puis il s'arrête. Sans quoi il rasait le sol à pleine vitesse
 * et percutait le décor, ou roulait sur son circuit jusqu'à un mur. Au sol, il est échoué (`stranded`).
 */
const GROUNDED = 1.6;
const TAKEOFF_POWER = 0.9;
const FLARE = 0.06;
/**
 * Près du sol, le pilote limite l'inclinaison : en virage, l'aile porte moins et l'avion s'enfonce.
 * Toute l'inclinaison permise à partir de FLOOR + FLOOR_MARGIN m, un cinquième au ras de FLOOR ;
 * de même quand l'avion descend déjà vite (SINK_RATE m/s).
 */
const FLOOR = 3;
const FLOOR_MARGIN = 6;
const SINK_RATE = 3;

/**
 * Pilotage à la souris (`flyMouse`) : l'instructeur. Presque droit devant (moins de `LEVEL_OFF` rad
 * d'écart), il corrige à la profondeur et à la direction, ailes à plat ; au-delà (tout à
 * `LEVEL_OFF + BANK_SPAN`), il s'incline pour mettre la direction voulue au-dessus du nez, et tire.
 * Une direction sous le nez, à moins de `PUSH_MAX` rad, se prend en poussant plutôt qu'en passant
 * sur le dos. Gains du roulis et de la profondeur (part du manche par radian d'écart) ; la direction
 * accompagne le virage (virage coordonné, comme le pilote automatique) et, presque droit devant,
 * vise un peu (`RUDDER_AIM`) ; le trim de profondeur annule l'écart qui reste en vol presque droit
 * (`TRIM_OFF`, `TRIM_RATE`).
 */
const LEVEL_OFF = 0.08;
const BANK_SPAN = 0.22;
const PUSH_MAX = 0.8;
const ROLL_GAIN = 2.5;
const PITCH_GAIN = 2.5;
const RUDDER_AIM = 0.5;
const TRIM_OFF = 0.25;
const TRIM_RATE = 1.5;
/** Presque droit devant, la trajectoire se corrige plus franchement que le nez (part de plus du manche). */
const PATH_GAIN = 2;
/** Incidence (rad) au-delà de laquelle l'instructeur ne tire (ni ne pousse) plus, et part du manche qu'il garde par radian en deçà. */
const AOA_LIMIT = 0.24;
const AOA_GAIN = 4;
/**
 * Au clavier, sans regard (touches de virage et de tangage) : la direction visée est la route,
 * tournée de `KEY_TURN` rad du côté du virage (l'instructeur s'incline et tire : un virage
 * coordonné), et levée de `KEY_PULL` rad au-dessus du nez pour cabrer (tenu : une boucle), ou
 * baissée de `KEY_PUSH` rad pour piquer.
 */
const KEY_TURN = 0.9;
const KEY_PULL = 1;
const KEY_PUSH = 0.45;
/** Au-dessous de cette inclinaison du nez sur l'horizon (sinus), l'instructeur remet les ailes à plat ; nez presque vertical, plus. */
const LEVEL_NOSE = 0.95;
/**
 * Une direction de côté ou derrière, à peu près à l'horizontale (sinus de sa pente au-dessus de
 * -`STEEP_DIVE`), qui demande de rouler de plus de `ROLL_FREE` rad : l'instructeur ne s'incline pas
 * plus que ce que ses ailes portent à sa vitesse, entre `MIN_HARD_BANK` et `HARD_BANK` rad.
 */
const ROLL_FREE = 0.35;
const STEEP_DIVE = 0.5;
const MIN_HARD_BANK = 0.6;
const HARD_BANK = 1.3;
/** Sa trajectoire plus basse que la direction voulue de SINK_SPAN rad : il ne s'incline plus qu'à MIN_SINK_BANK de cette limite. */
const SINK_SPAN = 0.2;
const MIN_SINK_BANK = 0.3;
/**
 * À la souris, les gaz (0 à 1) règlent une vitesse voulue : de SLOW_SPEED (0) à FAST_SPEED (1) fois
 * sa vitesse de croisière (`CRUISE_POWER`, 0,4 : sa croisière) ; sous ENGINE_CUT, moteur coupé. Des
 * gaz bruts, d'un avion à l'autre, ne voulaient rien dire : à 60 %, le Chasseur et ses deux
 * turboréacteurs filait trois fois plus vite que l'Avion.
 */
const SLOW_SPEED = 0.6;
const FAST_SPEED = 1.6;
const ENGINE_CUT = 0.02;
/** Altitude au moins (m) que tient le pilote automatique qui ramène un avion piloté à la souris. */
const RETURN_ALT = 8;
/** En revenant de sa limite : la direction visée, un peu au-dessus de l'horizon (pente, en sinus), et les gaz de la croisière (`CRUISE_POWER`, sim/player.ts). */
const RETURN_CLIMB = 0.08;
const CRUISE_SETTING = 0.4;
/**
 * Au-delà de sa limite, le pilote automatique reprend peu à peu la main (toute la main
 * BOUNDARY_MARGIN m plus loin) tant que l'avion s'éloigne, et le ramène vers l'arène : le joueur ne
 * peut pas s'en aller. La limite : les murs de l'arène, mais au moins CIRCUIT_ROOM m au-delà du
 * circuit (dans une petite arène, le circuit longe les murs : le pilote automatique reprenait la
 * main dès qu'on virait vers l'extérieur, et l'avion ne tournait presque pas).
 */
const BOUNDARY_MARGIN = 14;
/** À la souris, la limite compte où l'avion sera dans ce temps (s), s'il s'éloigne. */
const BOUNDARY_LEAD = 2;
const CIRCUIT_ROOM = 18;
/**
 * L'altitude se compte au-dessus du relief, sous l'avion et devant lui (à LOOKAHEAD s de vol) : il
 * monte avant une colline.
 */
const LOOKAHEAD = [1.5, 3];
/**
 * Circuit d'attaque d'un bombardier (voir `bombingRun`) : il vise droit sur sa cible tant qu'elle
 * est à plus de RUN_TRACK m devant lui, puis tient sa ligne ; la passe finit quand elle est
 * RUN_PASSED m derrière lui ; il s'éloigne tout droit jusqu'à RUN_OUT m d'elle, fait demi-tour, et
 * repasse une fois qu'elle est devant lui, à moins de RUN_ALIGN rad de sa route ; si elle se
 * retrouve à moins de RUN_CLOSE m sans qu'il soit aligné, il s'éloigne de nouveau.
 */
const RUN_TRACK = 25;
const RUN_PASSED = 5;
const RUN_OUT = 45;
const RUN_CLOSE = 30;
const RUN_ALIGN = 0.25;
/**
 * Altitude minimale d'un bombardier en attaque (m) : il passe au-dessus de ses cibles et de leurs
 * armes, plus haut que le circuit des avions (dans les batailles, à 10-14 m, il vivait deux fois moins longtemps).
 */
const BOMB_ALT = 16;
/**
 * Sortie de virage anticipée (s) : l'avion met à peu près ce temps à se remettre à plat, en
 * continuant de tourner ; il quitte son demi-tour d'autant plus tôt qu'il tourne vite.
 */
const ROLL_LEAD = 0.8;
/** Cible presque droit derrière (rad) : il fait demi-tour du côté du centre de l'arène, pour ne pas s'en éloigner. */
const BEHIND = 2.6;

/** Ce que le pilote lit de ses instruments. */
interface Instruments {
  com: Vec3;
  /** Hauteur du relief sous l'avion et devant lui (m) : ses altitudes se comptent à partir d'elle. */
  ground: number;
  /** Hauteur de l'avion au-dessus du relief juste sous lui (m). */
  height: number;
  /** Murs de l'arène (m du centre) : au-delà, le pilote automatique le ramène. */
  boundary: number;
  /** Rayon du circuit des avions (m). */
  circuit: number;
  /** Altitude plancher de l'IA dans cette arène (m au-dessus du relief). */
  airFloor: number;
  v: Vec3;
  w: Vec3;
  forward: Vec3;
  up: Vec3;
  left: Vec3;
  right: Vec3;
  airspeed: number;
  /** Le moteur de propulsion tourne encore (sinon, il plane). */
  engines: boolean;
  /** Part de leur pleine poussée que ses moteurs de propulsion peuvent donner (1 intacts ; voir `Thruster.output`). */
  power: number;
  /** Inclinaison permise au pilote automatique (rad), réduite près du sol et quand l'avion s'enfonce. */
  maxBank: number;
  /** Ce qu'il peut s'incliner pour revenir de sa limite (rad) : ce que ses ailes portent, au plus `RETURN_BANK`, réduit de même. */
  returnBank: number;
  /** Part de l'inclinaison permise qui reste, près du sol ou quand l'avion s'enfonce (0,2 à 1). */
  low: number;
}

function instruments(sim: Simulation, bot: Bot): Instruments {
  const rb = bot.cockpit.part.rb;
  const com = rb.worldCom();
  bot.lastPos = com;
  const v = rb.linvel();
  const below = groundLevel(sim.arena, com.x, com.z);
  let ground = below;
  for (const t of LOOKAHEAD) ground = Math.max(ground, groundLevel(sim.arena, com.x + v.x * t, com.z + v.z * t));
  const q = rb.rotation();
  const forward = qrot(q, vec3(0, 0, 1));
  const left = qrot(q, vec3(1, 0, 0));
  const cruise = liveThrusters(bot, "cruise");
  const engines = cruise.length > 0;
  const power = engines ? cruise.reduce((s, t) => s + t.output, 0) / cruise.length : 0;
  // Près du sol (celui d'en dessous : le relief devant lui le fait monter, mais ne l'empêche pas de virer)
  const low = clamp((com.y - below - FLOOR) / FLOOR_MARGIN, 0.2, 1);
  const sinking = clamp(1 + (v.y + SINK_RATE) / SINK_RATE, 0.2, 1);
  return {
    com, ground, height: com.y - below,
    boundary: Math.max(sim.arena.bounds.half, sim.arena.bounds.circuit + CIRCUIT_ROOM), circuit: sim.arena.bounds.circuit,
    airFloor: sim.arena.bounds.airFloor ?? 0,
    v, w: rb.angvel(), forward, up: qrot(q, vec3(0, 1, 0)), left, right: scale(left, -1),
    airspeed: Math.max(3, dot(v, forward)), engines, power,
    maxBank: Math.min(engines ? MAX_BANK : GLIDE_BANK, sustainableBank(bot, dot(v, forward))) * Math.min(low, sinking),
    // (à sa vitesse de croisière, comme le pilote automatique ; lancé plus vite, jusqu'à RETURN_BANK)
    low: Math.min(low, sinking),
    returnBank: Math.min(engines ? MAX_BANK + (RETURN_BANK - MAX_BANK) * clamp((dot(v, forward) / bot.profile.speed - 1) * 2, 0, 1) : GLIDE_BANK, sustainableBank(bot, dot(v, forward))) * Math.min(low, sinking),
  };
}

/**
 * Pilote automatique d'avion, qui agit comme un pilote : il choisit un cap et une altitude
 * (tourner autour de l'arène, passer sur un ennemi pour le bombarder, ou fuir en montant), en déduit l'inclinaison et l'assiette
 * voulues, puis pousse le manche (roulis, tangage, lacet, de -1 à 1) et règle les gaz. Le
 * mélangeur (robot/aero.ts) braque les gouvernes, et c'est l'aérodynamique qui fait voler
 * l'avion. Sans moteur, il plane ; sans gouvernes ou sans ailes, il ne peut plus rien faire.
 */
export function thinkPlane(sim: Simulation, bot: Bot, dt: number): void {
  const ai = bot.ai;
  const f = instruments(sim, bot);
  ai.modeT -= dt;
  if (f.engines && f.height < GROUNDED && f.power < TAKEOFF_POWER) {
    ai.mode = "stranded";
    const bank = Math.asin(clamp(f.left.y, -1, 1));
    const pitch = Math.asin(clamp(f.forward.y, -1, 1));
    applyControls(bot, f, [-2.5 * bank - 1.2 * dot(f.w, f.forward), 2.5 * (FLARE - pitch) - 0.6 * dot(f.w, f.right) + ai.trim, 0], 0);
    return;
  }
  if (!f.engines) ai.mode = "gliding";
  else if (ai.mode !== "flee" || ai.modeT <= 0) ai.mode = "patrol";
  // Navigation : tourner autour de l'arène, passer sur la cible de ses bombes, ou s'éloigner du tireur en fuite.
  // Son circuit d'attaque se poursuit si la cible disparaît un moment de sa vue (voir `bombingRun`)
  const prey = ai.mode === "flee" ? null : bombingTarget(bot);
  const target = ai.mode === "flee" ? ai.target : prey ? bombingRun(ai, f, prey) : circuitPoint(f.com, f.circuit);
  fly(bot, f, dt, bankToward(f, target), Math.max(prey ? Math.max(ai.alt, BOMB_ALT) : ai.alt, f.airFloor), bot.profile.speed);
}

/**
 * Avion du joueur que tient le pilote automatique (pendant qu'il pilote son ogive) : il file droit, à
 * plat, à l'altitude où il volait et à sa vitesse de croisière ; au-delà de sa limite, il revient.
 */
export function holdPlane(sim: Simulation, bot: Bot, dt: number): void {
  const f = instruments(sim, bot);
  bot.ai.mode = f.engines ? "patrol" : "gliding";
  fly(bot, f, dt, bankToward(f, circuitPoint(f.com, f.circuit)) * awayFrom(f), bot.ai.alt, bot.profile.speed);
}

/** Ce que le joueur commande à un avion piloté à la souris (voir `flyMouse`). */
export interface MouseFlight {
  /** Direction où il regarde (le rayon du réticule), ou null : au clavier, ou rien. */
  look: Vec3 | null;
  /** Au clavier : virer (> 0 : à gauche) ; cabrer (> 0) ou piquer (< 0) ; palonnier (> 0 : à gauche). */
  turn: number;
  pitch: number;
  yaw: number;
  /** Gaz (0 à 1 ; 0 : moteur coupé). */
  power: number;
}

/**
 * Avion piloté à la souris, comme dans Robocraft : il va là où regarde le joueur (`look`). Un
 * instructeur, comme un pilote, s'incline pour mettre cette direction au-dessus du nez et tire sur la
 * profondeur (le virage incliné vient de lui) ; presque droit devant, il corrige à la profondeur et à
 * la direction, ailes à plat. Il ne vise ni une altitude ni une inclinaison bornée : regarder vers le
 * haut et continuer fait passer l'avion sur le dos puis le ramène (une boucle) ; regarder derrière,
 * il fait demi-tour. Les gaz sont ceux du joueur, à part : ils ne changent pas l'assiette.
 * Au clavier (sans regard) : virer, cabrer (tenu : une boucle), piquer, et le palonnier (un virage à
 * plat, ailes à l'horizontale). Sans rien, il file droit, à plat. Au-delà de sa limite, le pilote
 * automatique reprend peu à peu la main, comme en pilotage manuel.
 */
export function flyMouse(sim: Simulation, bot: Bot, command: MouseFlight, dt: number): void {
  const ai = bot.ai;
  const f = instruments(sim, bot);
  ai.mode = f.engines ? "patrol" : "gliding";
  // Au-delà de sa limite (ou bientôt, à sa vitesse : `awayFrom`), l'instructeur ne suit plus le
  // regard du joueur mais revient vers le circuit des avions (toute la main à mi-chemin), un peu
  // au-dessus de l'horizon, à sa vitesse de croisière ; il vire aussi serré que ses ailes le
  // permettent sans s'enfoncer. (Le pilote automatique, qui donne la priorité à l'altitude au pied
  // des montagnes, virait trop large : l'avion heurtait la limite invisible de la Vallée.)
  const away = awayFrom(f, true);
  const handover = clamp(away * 2, 0, 1);
  // (l'altitude que tiendra le pilote automatique s'il prend la main, pendant le vol d'une ogive : celle où il vole)
  if (away === 0) ai.alt = Math.max(RETURN_ALT, f.height);
  let want = mouseTarget(f, command);
  if (handover > 0) {
    const goal = circuitPoint(f.com, f.circuit);
    const flat = Math.hypot(goal.x - f.com.x, goal.z - f.com.z) || 1;
    const back = norm(vec3((goal.x - f.com.x) / flat, RETURN_CLIMB, (goal.z - f.com.z) / flat));
    want = norm(add(scale(want, 1 - handover), scale(back, handover)));
  }
  const stick = instructor(bot, f, want, dt, handover === 0);
  // Palonnier : un virage à plat (la direction visée, la route, tourne avec lui : l'instructeur ne le contre pas)
  const yaw = clamp(command.yaw, -1, 1) * (1 - handover);
  if (Math.abs(yaw) > 0.05) stick[2] = FLAT_TURN_GAIN * (yaw * FLAT_TURN_RATE - dot(f.w, f.up));
  // Les gaz du joueur : une vitesse voulue, de SLOW_SPEED à FAST_SPEED fois sa vitesse de croisière,
  // que les moteurs tiennent (plus en montée : il ne cale pas dans une boucle) ; à zéro, coupés
  const power = clamp(command.power, 0, 1);
  const speed = bot.profile.speed * (SLOW_SPEED + (FAST_SPEED - SLOW_SPEED) * (power + (CRUISE_SETTING - power) * handover));
  const throttle = power < ENGINE_CUT && handover === 0 ? 0 : clamp(0.4 + 0.3 * (speed - f.airspeed) + 1.2 * Math.max(0, f.forward.y), 0, 1);
  applyControls(bot, f, stick, throttle);
  slipAssist(bot, f, yaw, dt);
}


/**
 * Direction que vise l'instructeur (unitaire) : le regard du joueur ; sinon la route, à
 * l'horizontale (il file droit, à plat), tournée du côté du virage demandé au clavier, et levée
 * au-dessus du nez (cabrer) ou baissée (piquer).
 */
function mouseTarget(f: Instruments, c: MouseFlight): Vec3 {
  const turn = clamp(c.turn, -1, 1);
  const pitch = clamp(c.pitch, -1, 1);
  if (c.look && Math.abs(turn) < 0.05 && Math.abs(pitch) < 0.05) {
    const l = Math.hypot(c.look.x, c.look.y, c.look.z);
    if (l > 1e-6) return scale(c.look, 1 / l);
  }
  // La route (au palonnier aussi : elle tourne avec le nez, et l'instructeur juge sur elle)
  const track = Math.hypot(f.v.x, f.v.z) > 2 ? vec3(f.v.x, 0, f.v.z) : vec3(f.forward.x, 0, f.forward.z);
  const tl = Math.hypot(track.x, track.z);
  let d = tl > 1e-6 ? scale(track, 1 / tl) : f.forward;
  if (Math.abs(turn) >= 0.05) {
    // Autour de la verticale, > 0 vers la gauche : l'avant (0, 0, 1) va vers (1, 0, 0)
    const a = turn * KEY_TURN;
    d = vec3(d.x * Math.cos(a) + d.z * Math.sin(a), 0, -d.x * Math.sin(a) + d.z * Math.cos(a));
  }
  if (Math.abs(pitch) >= 0.05) {
    // Dans le plan du nez et du haut de l'avion : au-dessus pour cabrer, dessous pour piquer
    const a = pitch * (pitch > 0 ? KEY_PULL : KEY_PUSH);
    const nose = Math.abs(turn) >= 0.05 ? norm(add(f.forward, scale(sub(d, f.forward), 0.5))) : f.forward;
    d = norm(add(scale(nose, Math.cos(a)), scale(f.up, Math.sin(a))));
  }
  return d;
}

/**
 * Le manche de l'instructeur vers la direction `d` (unitaire) : roulis, tangage, lacet (voir
 * `flyMouse`). Il juge l'écart sur la trajectoire (la vitesse), pas sur le nez : en palier, l'aile
 * porte avec le nez un peu haut, et une direction droit devant semblait sous le nez (il roulait pour
 * la « pousser », du mauvais côté, et partait en spirale). Dans ce repère, `d` a une part à droite
 * (x), en haut (y) et devant (z).
 */
function instructor(bot: Bot, f: Instruments, d: Vec3, dt: number, trimming = true): number[] {
  const ai = bot.ai;
  const speed = Math.hypot(f.v.x, f.v.y, f.v.z);
  const ahead = speed > 3 ? scale(f.v, 1 / speed) : f.forward;
  const lifted = sub(f.up, scale(ahead, dot(f.up, ahead)));
  const ll = Math.hypot(lifted.x, lifted.y, lifted.z);
  const up = ll > 0.2 ? scale(lifted, 1 / ll) : f.up;
  const right = cross(ahead, up);
  const x = dot(d, right);
  const y = dot(d, up);
  const z = dot(d, ahead);
  // Écart à la trajectoire (0 à π), et part du virage incliné (rien presque droit devant)
  const off = Math.atan2(Math.hypot(x, y), z);
  const w = clamp((off - LEVEL_OFF) / BANK_SPAN, 0, 1);
  // Roulis qui met la direction au-dessus (> 0 : à droite) ; ou dessous, pour pousser
  const pull = Math.atan2(x, y);
  const push = Math.atan2(Math.sin(pull - Math.PI), Math.cos(pull - Math.PI));
  const pushing = off < PUSH_MAX && Math.abs(push) < Math.abs(pull);
  let rollTo = pushing ? push : pull;
  // Une direction à peu près à l'horizontale, de côté ou derrière : il ne s'incline pas plus que ce
  // que ses ailes portent à sa vitesse (moins près du sol), et vire en tenant son altitude, au lieu
  // de se coucher sur la tranche ou de passer sur le dos (une spirale, une demi-boucle vers le bas :
  // au sol). Pas dans une boucle : la direction y est déjà au-dessus de lui, il n'a pas à rouler
  const vertical = sub(vec3(0, 1, 0), scale(ahead, ahead.y));
  const vl = Math.hypot(vertical.x, vertical.y, vertical.z);
  if (!pushing && Math.abs(rollTo) > ROLL_FREE && d.y > -STEEP_DIVE && vl > 0.3) {
    const upright = scale(vertical, 1 / vl);
    const aside = cross(ahead, upright);
    const across = sub(d, scale(ahead, z));
    // Le côté de la direction (droit derrière : celui où elle penche, sinon la droite)
    const lean = Math.atan2(dot(across, aside), dot(across, upright));
    // (et moins s'il s'enfonce sous la direction voulue : l'altitude d'abord)
    const sinking = clamp(1 - (Math.asin(clamp(d.y, -1, 1)) - Math.asin(clamp(ahead.y, -1, 1))) / SINK_SPAN, MIN_SINK_BANK, 1);
    const limit = clamp(sustainableBank(bot, f.airspeed), MIN_HARD_BANK, HARD_BANK) * f.low * sinking;
    if (Math.abs(lean) > limit) {
      const b = (lean >= 0 ? 1 : -1) * limit;
      const lift = add(scale(upright, Math.cos(b)), scale(aside, Math.sin(b)));
      rollTo = Math.atan2(dot(lift, right), dot(lift, up));
    }
  }
  // Ailes à plat presque droit devant (inclinaison sur tout le tour, > 0 : à droite), sauf nez presque vertical
  const bank = Math.atan2(f.left.y, f.up.y);
  const level = clamp((LEVEL_NOSE - Math.abs(f.forward.y)) / 0.3, 0, 1);
  const rollError = w * rollTo - (1 - w) * level * bank;
  // Profondeur : une fois la direction au-dessus (ou dessous), tirer (pousser) de son écart ; presque
  // droit devant, l'écart de la trajectoire en tangage. Le trim annule ce qui reste en vol presque droit
  const aligned = Math.max(0, Math.cos(rollTo));
  const direct = Math.atan2(y, z);
  // Incidence : la vitesse sous le nez (> 0) ; voir AOA_LIMIT
  const aoa = speed > 3 ? Math.atan2(-dot(f.v, f.up), dot(f.v, f.forward)) : 0;
  const elevator = w * (pushing ? -1 : 1) * off * aligned + (1 - w) * PATH_GAIN * direct;
  // (pas pendant que le pilote automatique a la main : il règle ce trim lui-même)
  if (trimming && off < TRIM_OFF) ai.trim = clamp(ai.trim + TRIM_RATE * direct * dt, -0.6, 0.6);
  // Direction : le lacet d'un virage coordonné à son inclinaison (rien au-delà de la verticale, sur le
  // dos ou dans une boucle), et presque droit devant, un peu vers la direction voulue (> 0 : à gauche)
  const coordinated = Math.abs(bank) < 1.3 ? (-GRAVITY * Math.tan(bank)) / f.airspeed : 0;
  const rudder = 1.2 * (coordinated - dot(f.w, f.up)) + (1 - w) * RUDDER_AIM * Math.atan2(-x, z);
  return [
    ROLL_GAIN * rollError - 1.2 * dot(f.w, f.forward),
    // (pas au-delà de AOA_LIMIT d'incidence : tirer plus fait décrocher, la vitesse fond et il s'enfonce)
    clamp(PITCH_GAIN * elevator - 0.6 * dot(f.w, f.right), -AOA_GAIN * (AOA_LIMIT + aoa), AOA_GAIN * (AOA_LIMIT - aoa)) + ai.trim,
    rudder,
  ];
}

/**
 * Aide au virage à plat : tant que le joueur tient le palonnier (et un moment après), la vitesse
 * horizontale de l'avion tourne vers son nez, sans changer de valeur : la trajectoire suit le nez au
 * lieu que l'avion glisse de côté. Une poussée au centre de masse, sans couple : le fuselage et la
 * dérive qui « portent » de côté, en plus franc que ne le fait le modèle de plaques.
 */
function slipAssist(bot: Bot, f: Instruments, rudder: number, dt: number): void {
  const ai = bot.ai;
  ai.slip = Math.max(Math.abs(rudder), ai.slip - dt / SLIP_FADE);
  if (ai.slip <= 0) return;
  // À l'horizontale seulement : l'aile droite d'un avion incliné pointe vers le haut ou le bas, et une
  // poussée le long d'elle le plaquait vers le sol
  const flat = Math.hypot(f.forward.x, f.forward.z);
  if (flat < 0.3) return;
  const nose = vec3(f.forward.x / flat, 0, f.forward.z / flat);
  const side = vec3(-nose.z, 0, nose.x);
  const along = dot(f.v, nose);
  const across = dot(f.v, side);
  const speed = Math.hypot(along, across);
  if (along <= 0 || speed < 1) return;
  // La vitesse de côté baisse, et ce qu'elle perd passe vers l'avant : la vitesse horizontale garde sa valeur
  const nextAcross = across + clamp(-SLIP_GRIP * across, -SLIP_MAX, SLIP_MAX) * ai.slip * dt;
  const nextAlong = Math.sqrt(Math.max(0, speed * speed - nextAcross * nextAcross));
  const rb = bot.cockpit.part.rb;
  const m = rb.mass();
  rb.applyImpulse(vec3((nose.x * (nextAlong - along) + side.x * (nextAcross - across)) * m, 0, (nose.z * (nextAlong - along) + side.z * (nextAcross - across)) * m), true);
}

/**
 * Inclinaison la plus forte que ses ailes peuvent tenir à la vitesse `airspeed` (rad) : la
 * portance maximale des surfaces à plat (juste avant le décrochage), rapportée à son poids.
 */
function sustainableBank(bot: Bot, airspeed: number): number {
  const q = 0.5 * AIR_DENSITY * airspeed * airspeed;
  let lift = 0;
  for (const s of bot.surfaces) {
    if (!s.block.alive || s.block.part !== bot.cockpit.part || Math.abs(s.block.up.y) < 0.7) continue;
    const spec = blockDef(s.block.type).aero!;
    lift += q * spec.area * spec.liftSlope * spec.stallAngle;
  }
  const load = (LIFT_MARGIN * lift) / (bot.cockpit.part.rb.mass() * GRAVITY);
  return load <= 1 ? MIN_BANK : Math.max(MIN_BANK, Math.acos(1 / load));
}

/**
 * Guidage L1 : viser un point de la route à quelque distance devant, et virer avec l'accélération
 * latérale 2·V²·sin(η)/distance, où η est l'angle vers ce point. Renvoie l'inclinaison voulue (rad,
 * > 0 : aile droite basse, virage à droite).
 */
function bankToward(f: Instruments, target: Vec3, limit = f.maxBank): number {
  // Cap mesuré sur la trajectoire (la vitesse), plus fiable que le nez quand l'avion dérape
  const track = Math.hypot(f.v.x, f.v.z) > 2 ? vec3(f.v.x, 0, f.v.z) : f.forward;
  const fl = Math.hypot(track.x, track.z) || 1;
  const tx = target.x - f.com.x;
  const tz = target.z - f.com.z;
  const eta = bearing(track.x / fl, track.z / fl, tx, tz); // > 0 : le point est à gauche
  const lateral = (2 * f.airspeed * f.airspeed * Math.sin(clamp(eta, -Math.PI / 2, Math.PI / 2))) / Math.max(L1_MIN, Math.hypot(tx, tz));
  return clamp(-Math.atan(lateral / GRAVITY), -limit, limit);
}

/**
 * Avion en pilotage manuel : le joueur tient le manche (tangage > 0 : cabrer ; roulis > 0 : vers
 * la droite ; lacet > 0 : vers la gauche) et les gaz (0 à 1 ; 0 : moteur coupé, l'avion plane).
 * Aucune aide, sinon un amortissement : manche lâché, l'avion cesse de tourner et garde son
 * attitude (le trim de profondeur se règle seul pour cela) ; manche tenu, il tourne autant que ses
 * gouvernes le permettent (boucles, tonneaux, virage à plat au palonnier). Au-delà de sa limite, le
 * pilote automatique reprend peu à peu la main, comme à la souris.
 */
export function flyManual(sim: Simulation, bot: Bot, command: { pitch: number; roll: number; yaw: number; power: number }, dt: number): void {
  const ai = bot.ai;
  const f = instruments(sim, bot);
  ai.mode = f.engines ? "patrol" : "gliding";
  // (l'altitude que tiendra le pilote automatique s'il reprend la main : celle où il vole)
  if (awayFrom(f, true) === 0) ai.alt = Math.max(RETURN_ALT, f.height);
  const pitchRate = dot(f.w, f.right);
  // Manche au neutre en tangage : le trim annule peu à peu la rotation (l'avion garde son assiette)
  if (Math.abs(command.pitch) < 0.05) ai.trim = clamp(ai.trim - AUTO_TRIM * pitchRate * dt, -0.6, 0.6);
  let stick = [
    clamp(command.roll, -1, 1) - ROLL_DAMP * dot(f.w, f.forward),
    clamp(command.pitch, -1, 1) - PITCH_DAMP * pitchRate + ai.trim,
    clamp(command.yaw, -1, 1) - YAW_DAMP * dot(f.w, f.up),
  ];
  let throttle = clamp(command.power, 0, 1);
  const away = awayFrom(f);
  if (away > 0) {
    // (aussi serré que ses ailes le permettent : lancé à pleine vitesse, il virait trop large)
    const auto = flightControls(bot, f, dt, bankToward(f, circuitPoint(f.com, f.circuit), f.returnBank), ai.alt, bot.profile.speed);
    stick = stick.map((s, i) => s + (auto.stick[i] - s) * away);
    throttle += (auto.throttle - throttle) * away;
  }
  applyControls(bot, f, stick, throttle);
  slipAssist(bot, f, clamp(command.yaw, -1, 1) * (1 - away), dt);
}

/**
 * Part (0 à 1) de la main que reprend le pilote automatique : l'avion s'éloigne au-delà de sa limite
 * (`always` : il est au-delà, quoi qu'il fasse ; à la souris, l'instructeur, qui vise alors le
 * circuit, finit son demi-tour au lieu de filer le long de la limite).
 */
function awayFrom(f: Instruments, always = false): number {
  const r = Math.hypot(f.com.x, f.com.z) || 1;
  const outward = (f.v.x * f.com.x + f.v.z * f.com.z) / (r * Math.max(1, Math.hypot(f.v.x, f.v.z)));
  if (!always) return clamp((r - f.boundary) / BOUNDARY_MARGIN, 0, 1) * clamp(outward * 3, 0, 1);
  // Où il sera dans BOUNDARY_LEAD s, s'il s'éloigne : plus il va vite, plus tôt il fait demi-tour
  const ahead = r + Math.max(0, (f.v.x * f.com.x + f.v.z * f.com.z) / r) * BOUNDARY_LEAD;
  return clamp((ahead - f.boundary) / BOUNDARY_MARGIN, 0, 1);
}

/** Manche et gaz : les gouvernes braquées d'après le manche (robot/aero.ts), les moteurs réglés. */
function applyControls(bot: Bot, f: Instruments, stick: readonly number[], throttle: number): void {
  if (liveFlaps(bot).length) steerSurfaces(bot, stick, [f.forward, f.right, f.up], [1, 1, 0.3]);
  runEngines(bot, throttle);
}

/**
 * Vol vers une inclinaison (`bankWanted`), une altitude au-dessus du relief et une vitesse voulues :
 * assiette, manche (roulis, tangage, lacet qui accompagne le virage), trim de profondeur, gaz.
 */
function fly(bot: Bot, f: Instruments, dt: number, bankWanted: number, alt: number, speed: number): void {
  const { stick, throttle } = flightControls(bot, f, dt, bankWanted, alt, speed);
  applyControls(bot, f, stick, throttle);
}

/**
 * Le manche et les gaz du pilote automatique (voir `fly`) ; `flatTurn` : vitesse de lacet voulue en
 * plus de celle du virage coordonné (rad/s, > 0 : vers la gauche), pour un virage à plat au palonnier.
 */
function flightControls(bot: Bot, f: Instruments, dt: number, bankWanted: number, alt: number, speed: number, flatTurn = 0): { stick: number[]; throttle: number } {
  const ai = bot.ai;
  // Trop bas sous l'altitude voulue : l'altitude passe avant le virage (un virage tenu trop serré
  // finissait au sol)
  const deficit = f.ground + alt - f.com.y;
  bankWanted *= 1 - clamp((deficit - LOW_START) / LOW_SPAN, 0, 0.75);
  let pitchWanted = f.engines ? clamp(0.1 * (f.ground + alt - f.com.y) - 0.15 * f.v.y + 0.05, -MAX_PITCH, MAX_PITCH) : GLIDE_PITCH;
  // Moteurs affaiblis et trop lent : la vitesse d'abord (voir WEAK_SLOW)
  if (f.engines && f.power < 1) {
    const slow = clamp((speed * WEAK_SLOW - f.airspeed) / (speed * 0.2), 0, 1);
    pitchWanted += (Math.min(pitchWanted, GLIDE_PITCH) - pitchWanted) * slow;
  }
  const bank = Math.asin(clamp(f.left.y, -1, 1));
  const pitch = Math.asin(clamp(f.forward.y, -1, 1));

  // Manche : roulis autour de l'avant, tangage autour de la droite (> 0 : cabrer), lacet qui
  // accompagne le virage (virage coordonné). Le trim de profondeur s'ajuste lentement.
  const pitchError = pitchWanted - pitch;
  ai.trim = clamp(ai.trim + 0.6 * pitchError * dt, -0.6, 0.6);
  const turnRate = (-GRAVITY * Math.tan(bank)) / f.airspeed;
  // En virage, l'aile doit porter 1/cos(inclinaison) fois le poids : le pilote tire sur la
  // profondeur d'autant (sans quoi, incliné à 60°, l'avion s'enfonce et pique)
  const loadPull = TURN_PULL * (1 / Math.max(0.35, Math.cos(bank)) - 1);
  const stick = [
    2.5 * (bankWanted - bank) - 1.2 * dot(f.w, f.forward),
    2.5 * pitchError - 0.6 * dot(f.w, f.right) + ai.trim + loadPull,
    (flatTurn ? FLAT_TURN_GAIN : 1.2) * (turnRate + flatTurn - dot(f.w, f.up)),
  ];
  // Gaz : tenir la vitesse voulue, avec un supplément pour monter
  const throttle = clamp(0.4 + 0.3 * (speed - f.airspeed) + 1.2 * pitchWanted, 0, 1);
  return { stick, throttle };
}

/** Ennemi que visent ses soutes à bombes encore chargées (le choix de la cible est celui de ai/gunner.ts), s'il en a. */
function bombingTarget(bot: Bot): Vec3 | null {
  for (const t of liveTurrets(bot)) {
    if (weaponDef(t.weapon).dropped && t.arm.ammo > 0 && t.target?.cockpit.alive) return t.target.lastPos;
  }
  return null;
}

/**
 * Circuit d'attaque d'un bombardier, en trois temps. La passe : il suit une ligne droite qui passe
 * par la cible (guidage L1 vers le point de la ligne à L1_DISTANCE devant lui) ; tant qu'elle est
 * loin, la ligne part de lui (il vise droit sur elle), puis elle ne bouge plus (sans quoi il
 * tournerait autour d'elle en la survolant). L'éloignement : la cible dépassée, il file tout droit
 * jusqu'à en être assez loin pour avoir la place de s'aligner au retour. Le demi-tour : toujours du
 * même côté (celui de la cible au début du virage : cible droit derrière, le guidage vers elle
 * hésiterait d'un côté à l'autre), jusqu'à l'avoir devant lui. Près des murs, s'il s'éloigne encore
 * de l'arène, il fait demi-tour aussitôt. Les soutes larguent d'elles-mêmes (ai/gunner.ts), quand
 * leurs bombes tomberaient sur la cible.
 */
function bombingRun(ai: AiState, f: Instruments, target: Vec3): Vec3 {
  const toX = target.x - f.com.x;
  const toZ = target.z - f.com.z;
  const dist = Math.hypot(toX, toZ) || 1;
  const toward = vec3(toX / dist, 0, toZ / dist);
  // Route suivie (la vitesse), ou le nez à très basse vitesse
  const track = Math.hypot(f.v.x, f.v.z) > 2 ? vec3(f.v.x, 0, f.v.z) : f.forward;
  const tl = Math.hypot(track.x, track.z) || 1;
  const fx = track.x / tl;
  const fz = track.z / tl;
  const eta = bearing(fx, fz, toX, toZ);
  const outward = f.v.x * f.com.x + f.v.z * f.com.z > 0 && Math.hypot(f.com.x, f.com.z) > f.boundary;
  // Au début : droit sur la cible si elle est devant, sinon il s'éloigne ou fait demi-tour
  // Côté du demi-tour : celui de la cible, ou celui du centre de l'arène si elle est droit derrière
  const side = (): number => (Math.abs(eta) > BEHIND ? bearing(fx, fz, -f.com.x, -f.com.z) : eta) >= 0 ? 1 : -1;
  const run = (ai.bombRun ??= {
    phase: Math.abs(eta) < RUN_ALIGN ? "pass" : dist < RUN_OUT ? "out" : "turn", dir: toward, turn: side(),
  });
  if (run.phase === "pass") {
    const ahead = toX * run.dir.x + toZ * run.dir.z;
    if (ahead < -RUN_PASSED || outward) run.phase = "out";
    else if (ahead > RUN_TRACK) run.dir = toward;
  }
  if (run.phase === "out" && (dist >= RUN_OUT || outward)) {
    run.phase = "turn";
    run.turn = side();
  }
  // Fin du demi-tour : la cible (du côté où il tourne) est presque dans l'axe, compte tenu de ce qu'il tournera encore en se remettant à plat
  if (run.phase === "turn" && eta * run.turn < RUN_ALIGN + Math.abs(f.w.y) * ROLL_LEAD && !outward) {
    run.phase = "pass";
    run.dir = toward;
  } else if (run.phase === "turn" && dist < RUN_CLOSE && !outward) {
    run.phase = "out"; // trop près pour s'aligner : la cible est dans son virage
  }
  switch (run.phase) {
    case "out":
      return vec3(f.com.x + fx * L1_DISTANCE, 0, f.com.z + fz * L1_DISTANCE);
    case "turn":
      // Un point sur le côté choisi, à angle droit de la route (à gauche : (z, -x))
      return vec3(f.com.x + fz * L1_DISTANCE * run.turn, 0, f.com.z - fx * L1_DISTANCE * run.turn);
    case "pass": {
      const along = L1_DISTANCE - (toX * run.dir.x + toZ * run.dir.z);
      return vec3(target.x + run.dir.x * along, 0, target.z + run.dir.z * along);
    }
  }
}

/** Angle entre le cap horizontal (fx, fz) et la direction (x, z) : > 0 si elle est à gauche. */
function bearing(fx: number, fz: number, x: number, z: number): number {
  return Math.atan2(fz * x - fx * z, fx * x + fz * z);
}

/**
 * Point du circuit à la distance L1 de l'avion, en avant dans le sens où les avions tournent
 * (loi des cosinus). Si l'avion est trop loin ou trop près du cercle, le point le plus proche,
 * un peu en avant.
 */
function circuitPoint(p: Vec3, R: number): Vec3 {
  const r = Math.hypot(p.x, p.z) || 0.001;
  const cos = clamp((r * r + R * R - L1_DISTANCE * L1_DISTANCE) / (2 * r * R), -1, 1);
  const angle = Math.atan2(p.z, p.x) + Math.max(Math.acos(cos), 0.35);
  return vec3(Math.cos(angle) * R, 0, Math.sin(angle) * R);
}
