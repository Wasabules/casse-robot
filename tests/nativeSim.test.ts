import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { avoidMines, navigate, obstacles } from "../src/shared/ai/navigation";
import { ARENAS, deepWaterAt, groundLevel, type ArenaId, type ArenaLayout, type PropSpot, type StaticBox } from "../src/shared/arena/layout";
import { LAVA_HEIGHT, lavaAt } from "../src/shared/arena/features";
import { navGrid } from "../src/shared/arena/navgrid";
import { resetProps } from "../src/shared/arena/props";
import { rockShape } from "../src/shared/arena/rocks";
import { checkMapText } from "../src/shared/map";
import { blockDef } from "../src/shared/catalog/blocks";
import { propHalf, type PropType } from "../src/shared/catalog/props";
import { SHAPE_IDS, shapePieces } from "../src/shared/catalog/shapes";
import type { ArmId } from "../src/shared/catalog/melee";
import { WEAPONS, type WeaponId } from "../src/shared/catalog/weapons";
import { groundBelow, PUDDLE_REACH, spawnGroundFire } from "../src/shared/combat/burning";
import { explode } from "../src/shared/combat/damage";
import { stunOrgans } from "../src/shared/combat/emp";
import { spawnProjectile } from "../src/shared/combat/projectiles";
import { regrowable } from "../src/shared/combat/repair";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { cellKey, NEIGHBORS } from "../src/shared/design/robotDesign";
import { add, distance, norm, qrot, scale, vec3, type Vec3 } from "../src/shared/math/vec";
import { dcos, dsin } from "../src/shared/math/det";
import { smokeBlocks } from "../src/shared/combat/smoke";
import { vibration } from "../src/shared/combat/melee";
import { groundHeight, setBotVelocity, spawnBot } from "../src/shared/robot/lifecycle";
import { blockWorldPos } from "../src/shared/robot/queries";
import type { AiMode, Barrier, Block, Bot, MeleeArm, Projectile, Prop, Team, Turret } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { CRUISE_POWER, newInput, takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { probePath } from "./probe";
import { seedRandom } from "./seed";

/*
 * La simulation portée en Rust, propriétaire de son monde (crates/casse-sim/src/sim/, temps 4 du
 * plan moteur), contre celle du TypeScript : les mêmes robots préfabriqués, aux mêmes endroits du
 * Dépôt, pilotés sans IA avec les mêmes commandes (gaz, virage, boost, frein) et le même hasard
 * (`Math.random` à graine fixe), doivent faire exactement la même chose, au bit près, à chaque
 * seconde : la pose et la vitesse de chacun de leurs morceaux, la pose et l'état de chacune de leurs
 * roues (montée, arrachée ou retirée), les points de structure et le morceau de chacun de leurs
 * blocs, leurs liaisons rompues, la pose et la vitesse de chaque débris, et ce qui s'est passé
 * (chocs, lots de dégâts, blocs détruits, liaisons rompues, robots hors de combat, roues retirées,
 * tirages du hasard). Sautée si la sonde n'est pas construite (`npm run native -- --probe`).
 *
 * Trois sortes de parcours : rouler (sans heurter quoi que ce soit plus vite que `SAFE_SPEED`), se
 * heurter (un mur, un pilier, un autre robot, au-dessus de `SAFE_SPEED` : blocs détruits, liaisons
 * rompues, morceaux séparés, robots hors de combat), et heurter des accessoires (les caisses, les
 * barils et les bouteilles de gaz du Dépôt ; des arbres, des murs et un toit ancrés posés pour
 * l'essai : caisses brisées, barils qui explosent en chaîne, bouteilles qui fuient et s'envolent,
 * blocs et bois en feu, arbres abattus, murs percés, toit qui tombe). Là, on compare aussi l'état
 * de chaque accessoire (présent ou non, pose, vitesse, points de structure, état, feu…). Et la
 * réparation et les flaques de feu : le Camion, le Mécanicien et le Gardien abîmés par un choc ou
 * par le napalm d'une mine qui saute, puis qui se réparent et font repousser leurs blocs perdus ;
 * des flaques de feu au sol (napalm, jet du lance-flammes) sous des robots et des caisses, avec ou
 * sans eau. Là, on compare aussi les flaques (centre, rayon, fin, auteur), les blocs perdus, et ce
 * que la réparation regarde (le dernier coup reçu, le prochain bloc qui repousse, l'ordre des blocs
 * vivants). Et l'IA qui conduit, hors combat (`sim.combat` faux, comme au stand de tir et à l'essai
 * du garage : ni tactique, ni tourelles) : des robots de deux équipes qui
 * patrouillent dans les petites arènes (Dépôt, Forteresse, Tranchées, Chantier), contournent les
 * piliers et les murets, montent sur les plateformes par leurs rampes, se coincent et se dégagent,
 * fuient ou foncent sur qui les heurte ; là, on compare aussi l'état de leur IA (mode, destination,
 * minuterie, compteurs de blocage, sens de la marche arrière, dernière position), le point vers
 * lequel la navigation les ferait rouler, et ce que chaque équipe a repéré (sim/detection.ts). Et
 * les batailles, au combat : la tactique de l'IA, ses tourelles et leurs projectiles (tir direct,
 * missiles et leurres, mines et capteurs, lance-flammes) ; là, on compare aussi chaque tourelle
 * (angles, chauffe, munitions, cible, visée, verrou), la tactique de chaque robot (adversaire, sens,
 * couvert, dernier attaquant, leurres) et chaque projectile (pose, vitesse, dégâts, guidage, coque,
 * leurre, mine posée, repérée, collée, sa mèche). Et les armes spéciales : l'impulsion
 * électromagnétique, la fumée, les mines qui bondissent, se collent ou se télécommandent, le rayon
 * réparateur et les nanites, les murs d'énergie ; là, on compare aussi la paralysie de chaque robot et
 * l'ordre de ses blocs perdus, chaque nuage de fumée et chaque mur. Et les moteurs, les appuis et le
 * vol (chaque moteur, chaque appui, chaque gouverne, l'état du pilote). Et les armes de contact,
 * pilotées et conduites par l'IA, contre une cible arrêtée, contre le décor et dans des batailles ;
 * et les tirs du pilote : là, on compare aussi chaque arme de contact (régime, angle, phase, bras,
 * morsure, boule et chaîne du fléau, prise de la mâchoire), la paralysie locale de chaque bloc et de
 * chaque roue, et qui a soulevé chaque robot. Et les grandes arènes et les cartes, lues d'après leurs
 * fichiers comme le jeu les lit, données champ par champ à la simulation portée (`rustArena`) : des
 * batailles de l'IA sur le relief, ses ponts, sa grille et son réseau de passage, dans la ville ; des
 * pilotes qui traversent un pont, entrent dans la lave, se noient, glissent sur la mer. Le pas du
 * TypeScript fait encore autre chose (la partie) : le test vérifie, par ses événements, que rien de
 * tel n'est intervenu côté TypeScript, et que rien de ce que le Rust ne sait pas encore faire ne serait
 * arrivé de son côté (`unported`). `SIM_REPORT=1` : le coût d'un pas, ici et là.
 */

// (une sonde d'avant les grandes arènes n'a pas `sim_set_terrain`, et sait moins de choses : sautée)
const PROBE = probePath("sim_set_terrain");

interface SimProbe {
  memory: { buffer: ArrayBuffer };
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  sim_new(): number;
  sim_free(id: number): void;
  sim_seed(id: number, seed: number): void;
  sim_add_box(
    id: number, kind: number, len: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, qx: number, qy: number, qz: number, qw: number, round: number,
  ): void;
  sim_clear_scenery(id: number): void;
  sim_set_bounds(id: number, half: number, roam: number, circuit: number): void;
  sim_add_prop(
    id: number, name: number, len: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, hx: number, hy: number, hz: number, scale: number,
  ): number;
  sim_prop_rest(id: number, prop: number, on: number): void;
  sim_prop_count(id: number): number;
  sim_prop_state(id: number, i: number, out: number): void;
  sim_spawn(id: number, name: number, len: number, x: number, y: number, z: number, yaw: number): number;
  sim_spawn_ai(id: number, name: number, len: number, x: number, y: number, z: number, yaw: number, team: number): number;
  sim_ai_state(id: number, bot: number, out: number): void;
  sim_nav_goal(id: number, bot: number, out: number): void;
  sim_detected(id: number, team: number): number;
  sim_error(out: number, cap: number): number;
  sim_ground_height(name: number, len: number): number;
  sim_shape_piece(name: number, len: number, piece: number, out: number, cap: number): number;
  sim_control(id: number, bot: number, throttle: number, steer: number, brake: number, boost: number): void;
  sim_step(id: number, n: number): void;
  sim_part_count(id: number, bot: number): number;
  sim_part_state(id: number, bot: number, part: number, out: number): void;
  sim_wheel_count(id: number, bot: number): number;
  sim_wheel_state(id: number, bot: number, wheel: number, out: number): void;
  sim_block_count(id: number, bot: number): number;
  sim_block_state(id: number, bot: number, block: number, out: number): void;
  sim_cut_count(id: number, bot: number): number;
  sim_debris_count(id: number): number;
  sim_debris_state(id: number, i: number, out: number): void;
  sim_stats(id: number, out: number): void;
  sim_set_water(id: number, level: number): void;
  sim_explode(id: number, name: number, len: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, owner: number): number;
  sim_puddle(id: number, name: number, len: number, x: number, y: number, z: number, owner: number): number;
  sim_bot_state(id: number, bot: number, out: number): void;
  sim_ground_fire_count(id: number): number;
  sim_ground_fire_state(id: number, i: number, out: number): void;
  sim_set_combat(id: number, on: number): void;
  sim_turret_count(id: number, bot: number): number;
  sim_turret_state(id: number, bot: number, turret: number, out: number): void;
  sim_tactics_state(id: number, bot: number, out: number): void;
  sim_projectile_count(id: number): number;
  sim_projectile_state(id: number, i: number, out: number): void;
  sim_fire(id: number, name: number, len: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, shooter: number, homing: number): number;
  sim_detonate(id: number, bot: number, on: number): void;
  sim_smoke_count(id: number): number;
  sim_smoke_state(id: number, i: number, out: number): void;
  sim_barrier_count(id: number): number;
  sim_barrier_state(id: number, i: number, out: number): void;
  sim_stage(id: number, k: number): void;
  sim_stage_count(): number;
  sim_thruster_count(id: number, bot: number): number;
  sim_thruster_state(id: number, bot: number, t: number, out: number): void;
  sim_support_count(id: number, bot: number): number;
  sim_support_state(id: number, bot: number, i: number, out: number): void;
  sim_flight(id: number, bot: number, climb: number, yaw: number, heading: number, relative: number, manual: number, power: number, lx: number, ly: number, lz: number): void;
  sim_launch(id: number, bot: number, vx: number, vy: number, vz: number): void;
  sim_surface_count(id: number, bot: number): number;
  sim_surface_state(id: number, bot: number, i: number, out: number): void;
  sim_melee_count(id: number, bot: number): number;
  sim_melee_state(id: number, bot: number, i: number, out: number): void;
  sim_pilot_state(id: number, bot: number, out: number): void;
  sim_arm(id: number, bot: number, trigger: number, weapon: number, len: number): void;
  sim_set_team(id: number, bot: number, team: number): void;
  sim_aim(id: number, bot: number, x: number, y: number, z: number, scope: number, flares: number): void;
  sim_stun(id: number, bot: number, x: number, y: number, z: number, radius: number, duration: number): void;
  sim_set_terrain(id: number, size: number, cells: number, heights: number, n: number): void;
  sim_set_deck(id: number, i: number, underpass: number, approach: number): void;
  sim_set_floors(id: number, air: number, hover: number): void;
  sim_set_deep_water(id: number, depth: number): void;
  sim_add_lava_pool(id: number, x: number, z: number, r: number): void;
  sim_add_lava_flow(id: number, width: number, points: number, n: number): void;
  sim_set_urban(id: number, on: number): void;
  sim_set_nav_grid(id: number, cell: number, n: number, min: number, open: number): void;
  sim_set_nav_graph(id: number, points: number, n: number, links: number, m: number): void;
  sim_prop_building(id: number, prop: number, building: number): void;
  sim_rock_shape(hx: number, hy: number, hz: number, x: number, z: number, out: number, cap: number): number;
}

/** Un point où l'essai fait quelque chose (`y` : sa hauteur, 0,3 m par défaut), et le robot à qui on le doit (son rang ; aucun par défaut). */
interface Spot {
  x: number;
  z: number;
  y?: number;
  by?: number;
}

/**
 * Un projectile que l'essai fait partir (`spawnProjectile`, sans vitesse héritée) : son arme, d'où, dans
 * quelle direction (vers le bas par défaut : une mine qu'on pose, un obus qu'on fait éclater au sol),
 * tiré par le robot `by` (son rang ; aucun par défaut : l'ennemi de tous), sa tête chercheuse sur le
 * robot `homing` (son rang).
 */
interface Shot extends Spot {
  weapon: WeaponId;
  dir?: Vec3;
  homing?: number;
}

/**
 * Ce que l'essai fait au début d'une phase : faire sauter une mine incendiaire (l'explosion de son
 * projectile, comme `stepMine` : dégâts, blocs enflammés, flaque de napalm, souffle), laisser la
 * flaque du jet du lance-flammes là où il arrive (`groundBelow`, `spawnGroundFire`), faire partir
 * des projectiles (un fumigène, une mine télécommandée, des nanites…), ou paralyser localement les
 * organes d'un robot autour d'un point (`stunOrgans`, comme la décharge d'une lance électrique ; `by` :
 * le rang du robot paralysé).
 */
interface Act {
  napalm?: readonly Spot[];
  flames?: readonly Spot[];
  fire?: readonly Shot[];
  stun?: readonly (Spot & { by: number; radius: number; duration: number })[];
}

/**
 * Des commandes tenues `seconds` s ; `act` : ce que l'essai fait au début de la phase ; `detonate` :
 * le pilote tient la touche qui fait sauter ses mines télécommandées ; `flight` : ses commandes de vol ;
 * `trigger` : il tient la gâchette ; `weapon` : l'arme qu'il a choisie (aucune par défaut : toutes) ;
 * `aim` : le point qu'il vise (aucun par défaut : ses tourelles ne visent pas) ; `scope` : au viseur ;
 * `flares` : il tient la touche des leurres.
 */
interface Phase {
  seconds: number;
  throttle: number;
  steer: number;
  brake?: number;
  boost?: boolean;
  detonate?: boolean;
  trigger?: boolean;
  aim?: Vec3;
  scope?: boolean;
  flares?: boolean;
  weapon?: ArmId;
  act?: Act;
  flight?: Flight;
}

/**
 * Les commandes de vol d'un pilote (`PlayerInput`) : monter ou descendre (en avion : cabrer ou piquer),
 * lacet, cap de la caméra, conduite à la caméra, pilotage manuel d'un avion, ses gaz (0,4 par défaut,
 * `CRUISE_POWER`), la direction de son regard (un avion à la souris).
 */
interface Flight {
  climb?: number;
  yaw?: number;
  heading?: number;
  relative?: boolean;
  manual?: boolean;
  power?: number;
  look?: Vec3;
}

/**
 * D'où part un robot (tourné de `yaw`) ; `still` : il reste arrêté, sans commandes ; `ai` : l'IA le
 * conduit, dans cette équipe (sinon, un pilote, chez les rouges, ou dans l'équipe `team`) ; `launch` :
 * un avion lancé en vol, à `PLANE_SPAWN_Y` m, à sa vitesse de croisière, droit devant lui (comme
 * `launchPlane`).
 */
interface Start {
  id: string;
  x: number;
  z: number;
  yaw: number;
  still?: boolean;
  ai?: Team;
  team?: Team;
  launch?: boolean;
  /** Le sol sous lui (m) : un tablier, une plateforme (sinon le relief, ou le sol plat). */
  ground?: number;
}

/** Hauteur où apparaît un avion lancé en vol (`PLANE_SPAWN_Y`, sim/wave.ts). */
const PLANE_SPAWN_Y = 12;

/** La vitesse d'un avion lancé en vol : sa vitesse de croisière, droit devant lui (tourné de `yaw`). */
const launchVelocity = (s: Start): Vec3 => scale(vec3(dsin(s.yaw), 0, dcos(s.yaw)), profileOf(s.id).speed);

/** Un parcours : d'où part le robot piloté (tourné de `yaw`), et ses commandes. */
interface Scenario {
  start: { x: number; z: number; yaw: number };
  phases: readonly Phase[];
}

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  // Au bout de la longue allée dégagée du Dépôt, le long du mur sud, tourné vers -x (comme
  // tests/brake.test.ts) : il se pose, gaz à fond, virage à gauche, boost en contre-braquant, frein
  allée: {
    start: { x: 28, z: -27, yaw: -Math.PI / 2 },
    phases: [
      { seconds: 1, throttle: 0, steer: 0 },
      { seconds: 3, throttle: 1, steer: 0 },
      { seconds: 2, throttle: 1, steer: 0.6 },
      { seconds: 1, throttle: 1, steer: -0.3, boost: true },
      { seconds: 1, throttle: 0, steer: 0, brake: 1 },
    ],
  },
  // Au pied de la rampe ouest, tourné vers +x : il y monte (les rayons des roues touchent une boîte
  // tournée du décor), s'arrête au frein dans la pente, puis redescend en marche arrière
  rampe: {
    start: { x: -32, z: -8, yaw: Math.PI / 2 },
    phases: [
      { seconds: 1, throttle: 0, steer: 0 },
      { seconds: 3, throttle: 0.7, steer: 0 },
      { seconds: 2, throttle: 0, steer: 0, brake: 1 },
      { seconds: 3, throttle: -0.6, steer: 0 },
    ],
  },
  // Face au mur sud, tourné vers -z : il s'y appuie doucement (le solveur de contacts de Rapier, avec
  // les colliders fusionnés du robot, sans dégâts : sous SAFE_SPEED, le choc ne fait rien), puis recule
  mur: {
    start: { x: 0, z: -30, yaw: Math.PI },
    phases: [
      { seconds: 1, throttle: 0, steer: 0 },
      { seconds: 5, throttle: 0.35, steer: 0 },
      { seconds: 2, throttle: -0.4, steer: 0 },
    ],
  },
};

/**
 * Les robots préfabriqués que la simulation portée sait faire rouler : au sol, sur des roues ou des
 * chenilles, sans moteur, appui, aile ni arme de contact (les autres sont refusés).
 */
const GROUND = [
  "scarab", "stilt", "trike", "centi", "ram", "crane", "truck", "tank", "buggy", "bulwark", "lancer", "brawler", "swarm",
  "tracker", "furnace", "carrier", "sapper", "mechanic", "guardian", "scout", "bastion",
  // (à moteurs et à appuis : le huitième jalon)
  "rocket", "dragster", "hovercraft", "manta", "spider",
];

/** Les robots volants (en vol stationnaire) que la simulation portée sait faire voler. */
const HOVER = ["drone", "hexa", "heli", "angel", "frigate"];

/** Les avions que la simulation portée sait faire voler. */
const PLANES = ["fighter", "plane", "bomber"];

/**
 * Les robots à arme de contact (le neuvième jalon) : les toupies (Faucheur, Culbuteur, Tambour,
 * Tourbillon), le marteau (Cogneur), les armes d'énergie (Duelliste, Oursin), les lames qui mordent
 * (Scieur, Foreur), les frappes à mécanique (Catapulte, Broyeur, Batteur).
 */
const MELEE = ["reaper", "pounder", "duelist", "urchin", "sawyer", "borer", "catapult", "crusher", "thresher", "tumbler", "drummer", "whirlwind"];

const PORTED = [...GROUND, ...HOVER, ...PLANES, ...MELEE];

/**
 * Des avions pilotés, lancés en vol au-dessus du Dépôt : à la souris (il va là où regarde le pilote :
 * à gauche et un peu vers le haut, droit vers le haut, une boucle, derrière lui) ; au clavier (virer,
 * cabrer, piquer, le palonnier ; les gaz) ; en manuel (le manche : roulis, tangage, palonnier ; moteur
 * coupé, il plane).
 */
const SORTIES: Readonly<Record<string, { start: Omit<Start, "id">; phases: readonly Phase[] }>> = {
  "à la souris": {
    start: { x: 0, z: -24, yaw: 0, launch: true },
    phases: [
      { seconds: 2, throttle: 0, steer: 0 },
      { seconds: 4, throttle: 0, steer: 0, flight: { look: norm(vec3(1, 0.2, 1)) } },
      { seconds: 4, throttle: 0, steer: 0, flight: { look: norm(vec3(0, 1, 0.3)), power: 1 } },
      { seconds: 4, throttle: 0, steer: 0, flight: { look: norm(vec3(-1, -0.1, -1)), power: 0.6 } },
    ],
  },
  "au clavier": {
    start: { x: 20, z: -10, yaw: -Math.PI / 2, launch: true },
    phases: [
      { seconds: 3, throttle: 0, steer: 1 },
      { seconds: 2, throttle: 0, steer: 0, flight: { climb: 1, power: 0.8 } },
      { seconds: 2, throttle: 0, steer: 0, flight: { climb: -1 } },
      { seconds: 3, throttle: 0, steer: 0, flight: { yaw: 1 } },
      { seconds: 3, throttle: 0, steer: -0.6, flight: { power: 0.01 } },
    ],
  },
  "en manuel": {
    start: { x: -10, z: 20, yaw: Math.PI, launch: true },
    phases: [
      { seconds: 2, throttle: 0, steer: 0, flight: { manual: true } },
      { seconds: 2, throttle: 0, steer: -1, flight: { manual: true, power: 1 } },
      { seconds: 2, throttle: 0, steer: 0, flight: { manual: true, climb: 1, power: 1 } },
      { seconds: 2, throttle: 0, steer: 0, flight: { manual: true, yaw: -1 } },
      { seconds: 4, throttle: 0, steer: 0, flight: { manual: true, power: 0 } },
    ],
  },
};

/**
 * Des vols pilotés, au milieu du Dépôt : il décolle (jusqu'à l'altitude que vise son IA, tirée au
 * hasard), avance, glisse de côté, monte, pivote au lacet, s'arrête au frein, redescend ; ou il se
 * tourne vers où regarde la caméra (`relative`) en avançant.
 */
const FLIGHTS: Readonly<Record<string, Scenario>> = {
  "décolle, avance, glisse, monte, pivote, freine": {
    start: { x: 0, z: -12, yaw: 0 },
    phases: [
      { seconds: 2, throttle: 0, steer: 0 },
      { seconds: 3, throttle: 1, steer: 0 },
      { seconds: 2, throttle: 0, steer: 0.8 },
      { seconds: 2, throttle: 0.3, steer: 0, flight: { climb: 1 } },
      { seconds: 2, throttle: 0, steer: 0, flight: { yaw: 1 } },
      { seconds: 2, throttle: 1, steer: 0, brake: 1 },
      { seconds: 3, throttle: 0, steer: 0, flight: { climb: -1 } },
    ],
  },
  "à la caméra": {
    start: { x: 6, z: -6, yaw: Math.PI / 2 },
    phases: [
      { seconds: 2, throttle: 0, steer: 0, flight: { relative: true } },
      { seconds: 3, throttle: 0.6, steer: 0, flight: { relative: true, heading: Math.PI } },
      { seconds: 3, throttle: 0.4, steer: -0.5, flight: { relative: true, heading: -Math.PI / 2 } },
      { seconds: 2, throttle: 0, steer: 0, flight: { relative: true, heading: -Math.PI / 2, yaw: -1 } },
    ],
  },
};

/** Lancé à fond (boost) après une seconde posé. */
const RUSH: readonly Phase[] = [
  { seconds: 1, throttle: 0, steer: 0 },
  { seconds: 8, throttle: 1, steer: 0, boost: true },
];

/** Le bélier lancé, puis arrêté assez longtemps pour que les épaves des roues arrachées disparaissent (30 s). */
const RUSH_AND_WAIT: readonly Phase[] = [...RUSH, { seconds: 27, throttle: 0, steer: 0 }];

/** Une cible arrêtée en travers de l'allée sud, et un robot lancé contre son flanc depuis l'est. */
const sideRam = (rammer: string, target: string): readonly Start[] => [
  { id: target, x: -8, z: -27, yaw: 0, still: true },
  { id: rammer, x: 20, z: -27, yaw: -Math.PI / 2 },
];

/**
 * Les chocs : un robot lancé contre le mur sud (25 m d'élan, tourné vers -z), contre le pilier
 * (14, -14), face au Char le long de l'allée sud, ou contre le flanc d'un robot arrêté ; chacun avec
 * ce qu'il y casse (vérifié côté TypeScript : des blocs détruits, des liaisons rompues et des
 * morceaux séparés, un robot hors de combat par la règle de structure, des roues arrachées, leurs
 * épaves retirées au bout de 30 s, des dégâts amortis par le bouclier du Rempart). Aucun de ces
 * robots n'a de module de réparation : ceux qui en ont un se heurtent plus bas (`REPAIRS`).
 */
const CRASHES: Readonly<Record<string, { bots: readonly Start[]; phases: readonly Phase[] }>> = {
  "rempart contre le pilier": { bots: [{ id: "bulwark", x: 14, z: 8, yaw: Math.PI }], phases: RUSH },
  "char contre le flanc du rempart": { bots: sideRam("tank", "bulwark"), phases: RUSH },
  "char contre le flanc du scarabée": { bots: sideRam("tank", "scarab"), phases: RUSH },
  "bastion contre le flanc du mille-pattes": { bots: sideRam("bastion", "centi"), phases: RUSH },
  "bélier contre le flanc de la grue": { bots: sideRam("ram", "crane"), phases: RUSH },
  "bélier contre le flanc de l'éclaireur, puis l'attente": { bots: sideRam("ram", "scout"), phases: RUSH_AND_WAIT },
  "mille-pattes contre le mur": { bots: [{ id: "centi", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "buggy contre le mur": { bots: [{ id: "buggy", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "sapeur contre le mur": { bots: [{ id: "sapper", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "tricycle contre le mur": { bots: [{ id: "trike", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "bélier contre le mur": { bots: [{ id: "ram", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "éclaireur contre le mur": { bots: [{ id: "scout", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "grue contre le pilier": { bots: [{ id: "crane", x: 14, z: 8, yaw: Math.PI }], phases: RUSH },
  "char contre le pilier": { bots: [{ id: "tank", x: 14, z: 8, yaw: Math.PI }], phases: RUSH },
  "cogneur contre le pilier": { bots: [{ id: "brawler", x: 14, z: 8, yaw: Math.PI }], phases: RUSH },
  "bastion contre le char": {
    bots: [{ id: "bastion", x: -14, z: -27, yaw: Math.PI / 2 }, { id: "tank", x: 14, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH,
  },
  "échassier contre le char": {
    bots: [{ id: "stilt", x: -14, z: -27, yaw: Math.PI / 2 }, { id: "tank", x: 14, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH,
  },
  "scarabée contre le char": {
    bots: [{ id: "scarab", x: -14, z: -27, yaw: Math.PI / 2 }, { id: "tank", x: 14, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH,
  },
};

/** Un emplacement d'accessoire posé sur le sol plat, centré en (`x`, `z`) (une dalle : `half` ; un cylindre : `scale`). */
function spot(type: PropType, x: number, z: number, more: { half?: Vec3; scale?: number; rests?: number[]; rot?: PropSpot["rot"] } = {}): PropSpot {
  const h = propHalf(type, more);
  return { type, pos: vec3(x, h.y, z), ...more };
}

/** Les petites arènes, sans relief (des boîtes, des accessoires). */
type SmallArena = Extract<ArenaId, "depot" | "fort" | "trenches" | "yard">;
/** Les arènes que joue la simulation portée : celles du jeu, et la carte communautaire livrée avec lui. */
type ArenaName = ArenaId | "val-du-lac";

/** Val du Lac (maps/), lue et construite comme le jeu la lit (`checkMapText` : son arène, sa grille de passage faite). */
let lake: ArenaLayout | null = null;
/** L'arène de ce nom : une arène du jeu (d'après son fichier, content/arenas/), ou Val du Lac. */
function arenaOf(name: ArenaName): ArenaLayout {
  if (name !== "val-du-lac") return ARENAS[name];
  lake ??= checkMapText(readFileSync(new URL("../maps/val-du-lac.casse-map.json", import.meta.url), "utf8")).arena!;
  return lake;
}

/**
 * Un parcours : une arène (le Dépôt par défaut) ; des robots et leurs commandes ; des accessoires
 * (ceux de l'arène, `arena`, ou ceux d'un petit agencement posé pour l'essai, sur son sol) ; de l'eau
 * (son niveau : elle éteint les flaques de feu).
 */
interface Run {
  arena?: ArenaName;
  bots: readonly Start[];
  phases: readonly Phase[];
  props?: "arena" | readonly PropSpot[];
  water?: number;
  /** Au combat (`sim.combat`) : l'IA engage, vise et tire (sinon, comme au stand de tir). */
  combat?: boolean;
}

/** Des accessoires heurtés. */
interface PropRun extends Run {
  props: "arena" | readonly PropSpot[];
}

/** Lancé plus doucement (pour pousser sans casser). */
const NUDGE: readonly Phase[] = [
  { seconds: 1, throttle: 0, steer: 0 },
  { seconds: 6, throttle: 0.5, steer: 0 },
];

/** Lancé à fond, puis arrêté : le temps que le feu brûle et que les épaves tombent. */
const RUSH_AND_BURN: readonly Phase[] = [...RUSH, { seconds: 6, throttle: 0, steer: 0 }];

/**
 * Les accessoires : ceux du Dépôt (des caisses en tas, des barils dont trois serrés au pied d'un
 * pilier, des bouteilles de gaz), où les robots partent face à un groupe ; et des agencements posés
 * pour l'essai sur le sol du Dépôt, droit devant un robot parti 12 m plus au sud : un sapin, une
 * palissade, un mur de briques portant un toit, un baril à côté d'un sapin.
 */
const PROP_RUNS: Readonly<Record<string, PropRun>> = {
  "bélier contre les caisses": { bots: [{ id: "ram", x: 20, z: -4, yaw: -Math.PI / 2 }], phases: RUSH, props: "arena" },
  "scarabée qui pousse une caisse": { bots: [{ id: "scarab", x: -20, z: 13, yaw: 0 }], phases: NUDGE, props: "arena" },
  "char contre un baril": { bots: [{ id: "tank", x: 1.5, z: -4, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  // (son bouclier amortit une part de l'explosion)
  "rempart contre un baril": { bots: [{ id: "bulwark", x: 1.5, z: -4, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  // (en marche arrière : ses batteries, à l'arrière, détruites par l'explosion, allument leurs voisines)
  "lancier à reculons contre un baril au pied du mur": {
    bots: [{ id: "lancer", x: 0, z: -22, yaw: 0 }],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 8, throttle: -1, steer: 0, boost: true }, { seconds: 6, throttle: 0, steer: 0 }],
    props: [spot("barrel", 0, -35.1)],
  },
  "bélier contre les barils du pilier": { bots: [{ id: "ram", x: 9.6, z: -2, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  "buggy contre une bouteille de gaz": { bots: [{ id: "buggy", x: 4, z: -18, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  "mille-pattes contre la bouteille et les caisses": { bots: [{ id: "centi", x: -5.5, z: -6, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  "bélier contre un sapin": { bots: [{ id: "ram", x: 0, z: -12, yaw: 0 }], phases: RUSH_AND_BURN, props: [spot("pine", 0, 0)] },
  "buggy contre un sapin": { bots: [{ id: "buggy", x: 0, z: -12, yaw: 0 }], phases: RUSH, props: [spot("pine", 0, 0)] },
  // (le toit, posé sur la palissade, tombe quand elle cède)
  "bélier contre une palissade qui porte un toit": {
    bots: [{ id: "ram", x: 0, z: -12, yaw: 0 }],
    phases: RUSH_AND_BURN,
    props: [spot("plank", 0, 0, { half: vec3(1.2, 0.9, 0.08) }), { ...spot("roof", 0, 0.72, { half: vec3(1.2, 0.06, 0.8), rests: [0] }), pos: vec3(0, 1.86, 0.72) }],
  },
  "char contre un baril près d'un sapin": { bots: [{ id: "tank", x: 0, z: -12, yaw: 0 }], phases: RUSH_AND_BURN, props: [spot("barrel", 0, 0), spot("pine", 1.8, 0.5)] },
  // (le baril coincé contre le mur sud, qui ne peut pas fuir devant le char ; des caisses assez loin
  // pour tenir, assez près pour prendre feu, puis se gagner l'une l'autre et brûler le char)
  "char contre un baril au pied du mur, entre des caisses": {
    bots: [{ id: "tank", x: 0, z: -22, yaw: Math.PI }],
    phases: [...RUSH_AND_BURN, { seconds: 6, throttle: 0, steer: 0 }],
    props: [spot("barrel", 0, -35.1), spot("crate", 2.8, -35), spot("crate", -2.8, -35), spot("crate", 2.8, -33.6), spot("crate", -2.8, -33.6)],
  },
};

/** Lancé à fond, un peu de recul, puis arrêté : le temps de se réparer (la réparation attend 3 s sans coup). */
const RUSH_AND_REPAIR: readonly Phase[] = [...RUSH, { seconds: 2, throttle: -0.5, steer: 0 }, { seconds: 12, throttle: 0, steer: 0 }];

/**
 * La réparation : le Mécanicien, le Camion et le Gardien (un module de réparation chacun) lancés
 * contre le mur sud ou le pilier, ou heurtés au flanc ; puis, au calme, ils réparent leurs blocs et
 * leurs roues abîmés et font repousser leurs blocs perdus, sauf ceux qui ne peuvent pas (hors de
 * portée du module, sans voisin sur le morceau du cockpit, ou dont la case est prise par le robot qui
 * les a heurtés : vérifié côté TypeScript, sur l'ensemble).
 */
const REPAIRS: Readonly<Record<string, Run>> = {
  "mécanicien contre le mur, puis la réparation": { bots: [{ id: "mechanic", x: 0, z: -14, yaw: Math.PI }], phases: RUSH_AND_REPAIR },
  "camion contre le pilier, puis la réparation": { bots: [{ id: "truck", x: 15.5, z: 8, yaw: Math.PI }], phases: RUSH_AND_REPAIR },
  "gardien contre le mur, puis la réparation": { bots: [{ id: "guardian", x: 0, z: -14, yaw: Math.PI }], phases: RUSH_AND_REPAIR },
  "bélier contre le flanc du gardien, puis la réparation": {
    bots: [{ id: "guardian", x: -8, z: -27, yaw: Math.PI / 2, still: true }, { id: "ram", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH_AND_REPAIR,
  },
  "rempart contre le flanc du camion, puis la réparation": {
    bots: [{ id: "truck", x: -8, z: -27, yaw: Math.PI / 2, still: true }, { id: "bulwark", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH_AND_REPAIR,
  },
  // (ses roues touchées par les chenilles du char, qu'il répare)
  "char contre le flanc du mécanicien, puis la réparation": {
    bots: [{ id: "mechanic", x: -8, z: -27, yaw: 0, still: true }, { id: "tank", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH_AND_REPAIR,
  },
  // Des cases prises : par le mur contre lequel il reste appuyé (sans le heurter : sous SAFE_SPEED),
  // par les blocs ou une roue d'un robot qui reste collé à lui
  "camion de biais contre le mur, qui y reste appuyé": {
    bots: [{ id: "truck", x: 0, z: -14, yaw: Math.PI - 0.3 }],
    phases: [...RUSH, { seconds: 14, throttle: 0.6, steer: 0 }],
  },
  "rempart contre le camion, qui y reste collé": {
    bots: [{ id: "truck", x: -8, z: -27, yaw: Math.PI / 2, still: true }, { id: "bulwark", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: [...RUSH, { seconds: 14, throttle: 0.4, steer: 0 }],
  },
  "mille-pattes contre le flanc du mécanicien, qui y reste collé": {
    bots: [{ id: "mechanic", x: -8, z: -27, yaw: Math.PI / 2, still: true }, { id: "centi", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: [...RUSH, { seconds: 14, throttle: 0.4, steer: 0 }],
  },
};

/** Posé une seconde, puis l'essai fait quelque chose, et on attend. */
const settleThen = (act: Act, seconds: number, ...more: Phase[]): Phase[] => [
  { seconds: 1, throttle: 0, steer: 0 },
  { seconds, throttle: 0, steer: 0, act },
  ...more,
];

/** Une grille de points du coin sud-ouest du Dépôt, sur le sol plat (2,2 m entre deux). */
const grid = (columns: number, rows: number): Spot[] =>
  Array.from({ length: columns * rows }, (_, i) => ({ x: -30 + (i % columns) * 2.2, z: -32 + Math.floor(i / columns) * 2.2 }));

/**
 * Les flaques de feu : une mine incendiaire qui saute près d'un robot réparateur (ses blocs en feu,
 * la flaque de napalm sous lui, puis la réparation, des blocs restés sur un morceau qui s'est
 * détaché qui y reviennent), ou entre un robot et celui qui l'a posée (sa flaque ne le brûle pas) ;
 * des jets de flammes sous des robots (dont un sous son auteur), contre des caisses, en l'air, en
 * grand nombre (au-delà de 40, refusés), là où une flaque brûle déjà (elle est ravivée) ; et de
 * l'eau, qui éteint ce qui tombe dedans (sur le sol, pas sur le pilier).
 */
const FIRES: Readonly<Record<string, Run>> = {
  "napalm près du mécanicien": { bots: [{ id: "mechanic", x: 0, z: -20, yaw: 0, still: true }], phases: settleThen({ napalm: [{ x: 1.5, z: -17.5 }] }, 30) },
  "napalm près du gardien": { bots: [{ id: "guardian", x: 0, z: -20, yaw: 0, still: true }], phases: settleThen({ napalm: [{ x: 2.5, z: -17.5 }] }, 30) },
  "napalm près du camion": { bots: [{ id: "truck", x: 0, z: -20, yaw: 0, still: true }], phases: settleThen({ napalm: [{ x: 2.5, z: -20 }] }, 30) },
  "napalm du scarabée, entre lui et le mécanicien": {
    bots: [{ id: "mechanic", x: -3, z: -20, yaw: 0, still: true }, { id: "scarab", x: 0, z: -20, yaw: 0, still: true }],
    phases: settleThen({ napalm: [{ x: -1.5, z: -20, by: 1 }] }, 16),
  },
  "jets de flammes sous des robots, contre des caisses, en nombre": {
    bots: [
      { id: "scarab", x: 0, z: -20, yaw: 0, still: true },
      { id: "trike", x: 3, z: -20, yaw: 0, still: true },
      { id: "mechanic", x: -4, z: -20, yaw: 0, still: true },
    ],
    props: "arena",
    phases: settleThen(
      {
        flames: [
          { x: 0, z: -20, by: 0 },
          { x: 3, z: -19.6, by: 0 },
          { x: -4, z: -20 },
          { x: 7.5, z: -3 },
          { x: -5, y: 3, z: -28 },
          { x: 0.3, z: -20, by: 1 },
          ...grid(9, 5),
        ],
      },
      3,
      { seconds: 5, throttle: 0, steer: 0, act: { flames: [{ x: 3.2, z: -19.6 }, { x: -20, z: -14 }] } },
      { seconds: 12, throttle: 0, steer: 0, act: { flames: [{ x: 3, z: -20.4, by: 2 }, { x: 7.5, z: -3.1 }] } },
    ),
  },
  "flaques et eau": {
    bots: [{ id: "trike", x: 3, z: -20, yaw: 0, still: true }],
    water: 0.4,
    phases: settleThen(
      {
        napalm: [{ x: -20, z: -28 }, { x: 14, y: 3.3, z: -14 }],
        flames: [{ x: 3, z: -20 }, { x: -10, y: 3.3, z: -18 }, { x: 0, y: 2, z: 23.5 }, { x: 0, y: 2, z: 16.7 }],
      },
      8,
    ),
  },
};

/**
 * Une ligne de départ de robots de l'IA, 8 m entre deux : les rouges au sud, tournés vers le nord ;
 * les bleus au nord, tournés vers le sud (comme `spawnTeams`).
 */
const line = (team: Team, ids: readonly string[]): Start[] =>
  ids.map((id, i) => ({ id, x: (i - (ids.length - 1) / 2) * 8, z: team === "red" ? -27 : 27, yaw: team === "red" ? 0 : Math.PI, ai: team }));

/** Une minute, sans commandes (l'IA conduit). */
const MINUTE: readonly Phase[] = [{ seconds: 60, throttle: 0, steer: 0 }];

/**
 * L'IA qui conduit, hors combat : deux équipes face à face dans chacune des petites arènes, avec
 * leurs accessoires (des robots à roues fixes, directrices, à chenilles ; qui fuient ou qui foncent
 * quand on les heurte ; avec un radar, un brouilleur) ; le pilote d'un char qui tourne au milieu de
 * l'IA (l'essai du garage) ; une mine incendiaire qui saute au milieu de robots de l'IA (ceux qui
 * foncent dessus, ceux qui fuient).
 */
const AI_RUNS: Readonly<Record<string, Run>> = {
  "dépôt, quatre contre quatre": {
    bots: [...line("red", ["tank", "trike", "scarab", "stilt"]), ...line("blue", ["buggy", "truck", "tracker", "ram"])],
    phases: MINUTE,
    props: "arena",
  },
  "forteresse, quatre contre quatre": {
    arena: "fort",
    bots: [...line("red", ["crane", "centi", "lancer", "bastion"]), ...line("blue", ["scout", "sapper", "bulwark", "brawler"])],
    phases: MINUTE,
    props: "arena",
  },
  "chantier, quatre contre quatre": {
    arena: "yard",
    bots: [...line("red", ["mechanic", "guardian", "swarm", "furnace"]), ...line("blue", ["carrier", "scarab", "trike", "tank"])],
    phases: MINUTE,
    props: "arena",
  },
  "tranchées, trois contre trois": {
    arena: "trenches",
    bots: [...line("red", ["tank", "buggy", "centi"]), ...line("blue", ["truck", "scout", "ram"])],
    phases: MINUTE,
    props: "arena",
  },
  // (l'essai du garage : un pilote parmi des robots de l'IA qui ne tirent pas)
  "le pilote d'un char tourne au milieu de l'IA": {
    bots: [
      { id: "tank", x: 0, z: -14, yaw: 0 },
      { id: "scarab", x: -6, z: -10, yaw: 0, ai: "red" },
      { id: "trike", x: 6, z: -10, yaw: 0, ai: "red" },
      { id: "ram", x: -4, z: -2, yaw: Math.PI, ai: "blue" },
      { id: "buggy", x: 4, z: -2, yaw: Math.PI, ai: "blue" },
    ],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 25, throttle: 1, steer: 0.5, boost: true }, { seconds: 10, throttle: 0, steer: 0 }],
    props: "arena",
  },
  "une mine incendiaire au milieu de l'IA": {
    bots: [
      { id: "tank", x: -2.5, z: -18, yaw: 0, ai: "red" },
      { id: "truck", x: 2.5, z: -18, yaw: 0, ai: "blue" },
      { id: "scarab", x: -2.5, z: -24, yaw: Math.PI, ai: "red" },
      { id: "trike", x: 2.5, z: -24, yaw: Math.PI, ai: "blue" },
    ],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 20, throttle: 0, steer: 0, act: { napalm: [{ x: 0, z: -21 }] } }],
  },
};

/**
 * Les robots dont l'IA sait manier toutes les armes au combat dans la simulation portée : tous ceux
 * qu'elle sait faire rouler. Le tir direct (fusil, canon, fusil de précision, laser, canon électrique,
 * fusil à pompe, plasma), les missiles guidés (téléguidés de la Grue, roquettes en salve de l'Essaim,
 * à verrouillage du Traqueur, l'ogive du Porte-ogive), le lance-flammes et la mine du Bélier, le
 * capteur et la mine anti-aérienne de l'Éclaireur ; le canon IEM du Mille-pattes ; les mines IEM,
 * ventouse et bondissante du Sapeur ; le rayon réparateur du Mécanicien et du Gardien, et le
 * projecteur de bouclier du Gardien.
 */
const COMBAT = PORTED;

/** Une bataille d'une minute et demie, sans commandes (l'IA conduit, vise et tire). */
const BATTLE: readonly Phase[] = [{ seconds: 90, throttle: 0, steer: 0 }];

/**
 * Les batailles, au combat : trois contre trois dans chacune des petites arènes, avec leurs
 * accessoires (elles engagent à leur portée préférée, tournent autour de l'ennemi, chargent, se
 * mettent à couvert pour recharger ou se réparer) ; des duels (le fusil à pompe du Cogneur, qui
 * charge, contre le Camion ; le canon électrique du Lancier, qui perce, contre le Rempart et son
 * bouclier ; le fusil de précision de l'Échassier contre le Char) ; et le pilote d'un Char qui tourne
 * au milieu de l'IA, qui lui tire dessus.
 */
const BATTLES: Readonly<Record<string, Run>> = {
  "dépôt, trois contre trois": {
    combat: true,
    bots: [...line("red", ["tank", "trike", "stilt"]), ...line("blue", ["buggy", "scarab", "lancer"])],
    phases: BATTLE,
    props: "arena",
  },
  "forteresse, trois contre trois": {
    arena: "fort",
    combat: true,
    bots: [...line("red", ["bastion", "furnace", "brawler"]), ...line("blue", ["truck", "bulwark", "trike"])],
    phases: BATTLE,
    props: "arena",
  },
  "tranchées, trois contre trois": {
    arena: "trenches",
    combat: true,
    bots: [...line("red", ["scarab", "lancer", "buggy"]), ...line("blue", ["stilt", "tank", "furnace"])],
    phases: BATTLE,
    props: "arena",
  },
  "chantier, trois contre trois": {
    arena: "yard",
    combat: true,
    bots: [...line("red", ["bulwark", "brawler", "stilt"]), ...line("blue", ["bastion", "trike", "lancer"])],
    phases: BATTLE,
    props: "arena",
  },
  "le cogneur contre le camion": {
    combat: true,
    bots: [{ id: "brawler", x: 0, z: -12, yaw: 0, ai: "red" }, { id: "truck", x: 0, z: 12, yaw: Math.PI, ai: "blue" }],
    phases: [{ seconds: 40, throttle: 0, steer: 0 }],
  },
  "le lancier contre le rempart": {
    combat: true,
    bots: [{ id: "lancer", x: -6, z: -20, yaw: 0, ai: "red" }, { id: "bulwark", x: 6, z: 20, yaw: Math.PI, ai: "blue" }],
    phases: [{ seconds: 40, throttle: 0, steer: 0 }],
  },
  "l'échassier contre le char": {
    combat: true,
    bots: [{ id: "stilt", x: -20, z: -26, yaw: 0, ai: "red" }, { id: "tank", x: 20, z: 26, yaw: Math.PI, ai: "blue" }],
    phases: [{ seconds: 40, throttle: 0, steer: 0 }],
  },
  // Les missiles : des leurres (le Char, le Bastion), la défense rapprochée (fusils, laser), des
  // missiles abattus en vol ou par une explosion, détournés, perdus de vue
  "dépôt, missiles contre leurres": {
    combat: true,
    bots: [...line("red", ["crane", "tracker", "swarm"]), ...line("blue", ["tank", "bastion", "bulwark"])],
    phases: BATTLE,
    props: "arena",
  },
  "forteresse, l'ogive et les missiles": {
    arena: "fort",
    combat: true,
    bots: [...line("red", ["carrier", "trike", "scarab"]), ...line("blue", ["crane", "buggy", "tracker"])],
    phases: BATTLE,
    props: "arena",
  },
  "tranchées, les roquettes": {
    arena: "trenches",
    combat: true,
    bots: [...line("red", ["swarm", "tank", "stilt"]), ...line("blue", ["tracker", "furnace", "bastion"])],
    phases: BATTLE,
    props: "arena",
  },
  "chantier, missiles et ogive": {
    arena: "yard",
    combat: true,
    bots: [...line("red", ["crane", "lancer", "swarm"]), ...line("blue", ["carrier", "bastion", "bulwark"])],
    phases: BATTLE,
    props: "arena",
  },
  // Les mines et le lance-flammes : le Bélier sème ses mines derrière lui et charge, flammes devant ;
  // l'Éclaireur pose ses capteurs, qui font repérer l'ennemi à travers tout
  "dépôt, les mines et les flammes": {
    combat: true,
    bots: [...line("red", ["ram", "scout", "tank"]), ...line("blue", ["buggy", "truck", "scarab"])],
    phases: BATTLE,
    props: "arena",
  },
  "forteresse, deux béliers": {
    arena: "fort",
    combat: true,
    bots: [...line("red", ["ram", "stilt", "swarm"]), ...line("blue", ["ram", "scout", "bulwark"])],
    phases: BATTLE,
    props: "arena",
  },
  // (un char piloté fonce droit derrière le Bélier, sur les mines qu'il sème)
  "le bélier sème ses mines devant un char piloté": {
    combat: true,
    bots: [{ id: "tank", x: 0, z: -19, yaw: 0 }, { id: "ram", x: 0, z: -5, yaw: 0, ai: "blue" }],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 8, throttle: 1, steer: 0 }, { seconds: 10, throttle: 0, steer: 0 }],
  },
  // (un tricycle piloté s'enfuit devant le Bélier : ses flammes ne le rattrapent pas et tombent au sol)
  "le bélier et un tricycle piloté qui s'enfuit": {
    combat: true,
    bots: [{ id: "trike", x: 0, z: -6, yaw: 0 }, { id: "ram", x: 0, z: -14, yaw: 0, ai: "blue" }],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 5, throttle: 1, steer: 0 }, { seconds: 10, throttle: 0, steer: 0 }],
  },
  // (un tricycle piloté, arrêté juste derrière un baril du Dépôt : les flammes du Bélier frappent le
  // baril, et laissent des flaques à son pied)
  "le bélier et un tricycle derrière un baril": {
    combat: true,
    bots: [{ id: "trike", x: -8, z: -17.1, yaw: 0, still: true }, { id: "ram", x: -8, z: -5, yaw: Math.PI, ai: "blue" }],
    phases: [{ seconds: 20, throttle: 0, steer: 0 }],
    props: "arena",
  },
  // (deux robots qui chargent : le Camion contourne les mines que le Bélier sème)
  "le bélier contre le camion": {
    combat: true,
    bots: [{ id: "ram", x: 0, z: -12, yaw: 0, ai: "red" }, { id: "truck", x: 0, z: 12, yaw: Math.PI, ai: "blue" }],
    phases: [{ seconds: 40, throttle: 0, steer: 0 }],
  },
  "tranchées, l'éclaireur et le bélier": {
    arena: "trenches",
    combat: true,
    bots: [...line("red", ["scout", "brawler", "lancer"]), ...line("blue", ["ram", "tracker", "trike"])],
    phases: BATTLE,
    props: "arena",
  },
  // (le pilote d'un Char va et vient derrière un muret du Chantier : les missiles du Traqueur, qui
  // l'a verrouillé, le perdent de vue)
  "le traqueur et un char derrière un muret": {
    arena: "yard",
    combat: true,
    bots: [{ id: "tank", x: -7, z: 12, yaw: Math.PI / 2 }, { id: "tracker", x: 0, z: -25, yaw: 0, ai: "blue" }],
    phases: [
      { seconds: 1, throttle: 0, steer: 0 },
      ...Array.from({ length: 12 }, (_, i): Phase => ({ seconds: 2, throttle: i % 2 ? -1 : 1, steer: 0 })),
    ],
  },
  "l'IA tire sur le pilote d'un char qui tourne": {
    combat: true,
    bots: [
      { id: "tank", x: 0, z: -14, yaw: 0 },
      { id: "trike", x: -6, z: 10, yaw: Math.PI, ai: "blue" },
      { id: "furnace", x: 6, z: 10, yaw: Math.PI, ai: "blue" },
      { id: "scarab", x: 8, z: -24, yaw: 0, ai: "red" },
    ],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 30, throttle: 1, steer: 0.5, boost: true }],
    props: "arena",
  },
};

/** Une phase d'attente, sans commandes ; `act` : ce que l'essai fait à son début. */
const wait = (seconds: number, act?: Act, detonate?: boolean): Phase => ({ seconds, throttle: 0, steer: 0, act, detonate });

/** Un projectile qui part de (`x`, `y`, `z`) vers (`tx`, `ty`, `tz`). */
const aimed = (weapon: WeaponId, x: number, y: number, z: number, tx: number, ty: number, tz: number, more: Partial<Shot> = {}): Shot => ({
  weapon, x, y, z, dir: norm(vec3(tx - x, ty - y, tz - z)), ...more,
});

/**
 * Les armes spéciales (le septième jalon), au combat : l'impulsion électromagnétique du Mille-pattes
 * (des robots de l'IA et le pilote d'un Char paralysés : roue libre, tourelles muettes, batteries
 * qui ne se rechargent plus) ; les mines du Sapeur (IEM, ventouse, bondissante), semées devant l'IA et
 * devant un Char piloté ; le rayon réparateur du Mécanicien et du Gardien (le soutien d'un allié abîmé,
 * le vol de vie d'un ennemi) et le mur d'énergie du Gardien, déployé quand il est touché. Et ce que
 * l'essai fait partir : des fumigènes entre deux équipes et devant un Traqueur qui verrouille (la vue,
 * la détection, les têtes chercheuses coupées), une mine fumigène ; des mines télécommandées (celles
 * d'un pilote, qu'il fait sauter l'une après l'autre ; celle de l'IA, qui saute sous un ennemi), une
 * mine ventouse, une bondissante et une IEM sous un robot arrêté ; des nanites et un rayon réparateur
 * sur un allié abîmé, des nanites sur un ennemi ; un mur d'énergie devant un robot sur qui un canon
 * tire (les obus s'y écrasent, le souffle ne passe pas, il se brise).
 */
const SPECIALS: Readonly<Record<string, Run>> = {
  "dépôt, le mille-pattes et l'IEM": {
    combat: true,
    bots: [...line("red", ["centi", "tank", "stilt"]), ...line("blue", ["buggy", "scarab", "centi"])],
    phases: BATTLE,
    props: "arena",
  },
  "le mille-pattes contre un char piloté": {
    combat: true,
    bots: [{ id: "tank", x: 0, z: -22, yaw: 0 }, { id: "centi", x: 0, z: 10, yaw: Math.PI, ai: "blue" }],
    phases: [wait(1), { seconds: 12, throttle: 0.6, steer: 0 }, wait(10)],
  },
  "dépôt, le sapeur": {
    combat: true,
    bots: [...line("red", ["sapper", "tank", "trike"]), ...line("blue", ["buggy", "truck", "ram"])],
    phases: BATTLE,
    props: "arena",
  },
  // (un char piloté fonce droit derrière le Sapeur, sur les mines qu'il sème)
  "le sapeur sème ses mines devant un char piloté": {
    combat: true,
    bots: [{ id: "tank", x: 0, z: -19, yaw: 0 }, { id: "sapper", x: 0, z: -5, yaw: 0, ai: "blue" }],
    phases: [wait(1), { seconds: 8, throttle: 1, steer: 0 }, wait(10)],
  },
  "tranchées, le mille-pattes, le sapeur et le mécanicien": {
    arena: "trenches",
    combat: true,
    bots: [...line("red", ["centi", "sapper", "scarab"]), ...line("blue", ["mechanic", "tank", "stilt"])],
    phases: BATTLE,
    props: "arena",
  },
  "chantier, le mécanicien et le gardien": {
    arena: "yard",
    combat: true,
    bots: [...line("red", ["mechanic", "guardian", "tank"]), ...line("blue", ["lancer", "trike", "scarab"])],
    phases: BATTLE,
    props: "arena",
  },
  "forteresse, deux gardiens": {
    arena: "fort",
    combat: true,
    bots: [...line("red", ["guardian", "bastion", "mechanic"]), ...line("blue", ["guardian", "furnace", "swarm"])],
    phases: BATTLE,
    props: "arena",
  },
  // (le napalm abîme le pilote d'un Char arrêté ; le Mécanicien, de son équipe, vient le soigner)
  "le mécanicien soigne un char piloté": {
    combat: true,
    bots: [{ id: "tank", x: 0, z: -10, yaw: 0, still: true }, { id: "mechanic", x: 8, z: -24, yaw: 0, ai: "red" }],
    phases: [wait(1, { napalm: [{ x: 1.5, z: -8.5 }, { x: -1.5, z: -11.5 }] }), wait(25)],
  },
  "des fumigènes entre deux équipes": {
    combat: true,
    bots: [...line("red", ["tank", "stilt", "lancer"]), ...line("blue", ["buggy", "scarab", "trike"])],
    phases: [
      wait(8),
      wait(20, { fire: [-8, 0, 8].map((x): Shot => ({ weapon: "smoke", x, y: 4, z: 0 })) }),
      wait(20, { fire: [{ weapon: "smokeMine", x: -3, z: -12, by: 3 }, { weapon: "smokeMine", x: 5, z: 12, by: 0 }] }),
    ],
    props: "arena",
  },
  // (le Traqueur verrouille le pilote d'un Char ; un fumigène les sépare ; une mine fumigène du
  // Traqueur sur le chemin du Char)
  "le traqueur, un char piloté et un fumigène": {
    combat: true,
    bots: [{ id: "tank", x: -6, z: 14, yaw: Math.PI / 2 }, { id: "tracker", x: 0, z: -24, yaw: 0, ai: "blue" }],
    phases: [
      wait(1, { fire: [{ weapon: "smokeMine", x: -2.5, z: 14, by: 1 }] }),
      { seconds: 5, throttle: 0.5, steer: 0 },
      { seconds: 12, throttle: -0.5, steer: 0, act: { fire: [{ weapon: "smoke", x: -3, y: 4, z: -6 }] } },
    ],
  },
  // (un Char piloté, arrêté, que l'IA d'en face mine : IEM, ventouse, bondissante, télécommandée ; ses
  // propres mines télécommandées, qu'il fait sauter plus loin, l'une après l'autre)
  "des mines sous un char piloté": {
    bots: [{ id: "tank", x: 0, z: -20, yaw: 0 }, { id: "buggy", x: 20, z: 20, yaw: Math.PI, ai: "blue" }],
    phases: [
      wait(1, {
        fire: [
          { weapon: "remoteMine", x: 10, z: 8, by: 0 }, { weapon: "remoteMine", x: 12, z: 8, by: 0 }, { weapon: "remoteMine", x: 14, z: 8, by: 0 },
          { weapon: "empMine", x: -1.2, z: -21, by: 1 },
        ],
      }),
      wait(4, { fire: [{ weapon: "remoteMine", x: 0.4, z: -17.8, by: 1 }] }),
      wait(4, { fire: [{ weapon: "stickyMine", x: 1.2, z: -19.4, by: 1 }, { weapon: "bounceMine", x: -1.4, z: -18.6, by: 1 }] }),
      wait(3, undefined, true),
      wait(4),
    ],
  },
  // (le napalm abîme un Mécanicien arrêté ; un tricycle de son équipe lui envoie des nanites, puis un
  // rayon réparateur, et des nanites au Buggy d'en face)
  "des nanites et un rayon réparateur sur un mécanicien abîmé": {
    bots: [{ id: "mechanic", x: 0, z: -20, yaw: 0, still: true }, { id: "trike", x: 8, z: -20, yaw: 0, still: true }, { id: "buggy", x: 8, z: 0, yaw: 0, ai: "blue" }],
    phases: [
      wait(1, { napalm: [{ x: 1.5, z: -17.5 }] }),
      wait(4, { fire: [aimed("nanites", 7, 1.5, -20, 0, 1, -20, { by: 1, homing: 0 }), aimed("nanites", 8, 1.5, -18, 8, 1, 0, { by: 1, homing: 2 })] }),
      wait(3, { fire: [aimed("repair", 6.5, 0.9, -20, 0, 0.6, -20, { by: 1 }), aimed("repair", 6.5, 0.9, -20.4, 0, 0.6, -20.6, { by: 1 })] }),
      wait(3),
    ],
  },
  // (un tricycle piloté sur qui le canon du Scarabée tire : un mur d'énergie déployé devant lui)
  "un mur d'énergie devant un tricycle piloté": {
    combat: true,
    bots: [{ id: "trike", x: 0, z: -20, yaw: 0, still: true }, { id: "scarab", x: 0, z: 6, yaw: Math.PI, ai: "blue" }],
    phases: [wait(6), wait(20, { fire: [aimed("barrier", 0, 1, -18.5, 0, 1, -10, { by: 0 })] })],
  },
};

/** Le boost du pilote : gaz et propulseurs à fond. */
const boostFor = (seconds: number): Phase => ({ seconds, throttle: 1, steer: 0, boost: true });

/**
 * Les moteurs et les appuis (le huitième jalon), au sol : le jet de flamme du Dragster piloté, le nez
 * contre le mur sud, sur des caisses posées derrière lui (le bois prend feu) ; celui du Dragster de
 * l'IA, qui allume ses turboréacteurs sur le Char collé à son arrière (`foeInJet`) ; la Fusée de l'IA,
 * qu'un napalm fait fuir au boost ; un obus sur les turboréacteurs d'un Dragster, qui s'usent, ont des
 * ratés et prennent feu, puis il fonce ; le napalm sous l'Aéroglisseur et la Mante (leurs patins), et
 * l'Araignée qui marche ; un Aéroglisseur piloté paralysé (ses patins retombent).
 */
const ENGINES: Readonly<Record<string, Run>> = {
  "le dragster piloté pousse contre le mur, des caisses derrière lui": {
    bots: [{ id: "dragster", x: 0, z: -32.2, yaw: Math.PI }],
    props: [spot("crate", 0.8, -26), spot("crate", -0.8, -26.4)],
    phases: [wait(1), boostFor(8), wait(6)],
  },
  "le dragster de l'IA, un char collé à son arrière": {
    bots: [{ id: "dragster", x: 0, z: -10, yaw: 0, ai: "blue" }, { id: "tank", x: 0, z: -16.5, yaw: 0, still: true }],
    phases: [wait(12)],
  },
  "la fusée de l'IA fuit au boost": {
    bots: [{ id: "rocket", x: 0, z: -20, yaw: 0, ai: "red" }],
    phases: [wait(1), wait(14, { napalm: [{ x: 2.5, z: -21 }] })],
  },
  "un obus sur les turboréacteurs d'un dragster, puis il fonce": {
    bots: [{ id: "dragster", x: 0, z: -20, yaw: 0 }],
    phases: [wait(1, { fire: [{ weapon: "cannon", x: 0, y: 3, z: -23.2 }] }), wait(2), boostFor(6), wait(3)],
  },
  "le napalm sous l'aéroglisseur, la mante et l'araignée": {
    bots: [
      { id: "hovercraft", x: -6, z: -20, yaw: 0, ai: "red" },
      { id: "manta", x: 0, z: -20, yaw: 0, ai: "blue" },
      { id: "spider", x: 6, z: -20, yaw: 0, ai: "red" },
    ],
    phases: [wait(2), wait(20, { napalm: [{ x: -3, z: -20 }, { x: 3, z: -20 }] })],
  },
  "un aéroglisseur piloté paralysé": {
    bots: [{ id: "hovercraft", x: 0, z: -20, yaw: 0 }],
    phases: [wait(1), { seconds: 2, throttle: 1, steer: 0.3 }, { seconds: 6, throttle: 1, steer: 0.3, act: { fire: [{ weapon: "emp", x: 0, y: 4, z: -10 }] } }],
  },
  "dépôt, moteurs et appuis, trois contre trois": {
    combat: true,
    bots: [...line("red", ["rocket", "dragster", "hovercraft"]), ...line("blue", ["manta", "spider", "tank"])],
    phases: BATTLE,
    props: "arena",
  },
  "tranchées, moteurs et appuis": {
    arena: "trenches",
    combat: true,
    bots: [...line("red", ["spider", "manta", "lancer"]), ...line("blue", ["dragster", "rocket", "scarab"])],
    phases: BATTLE,
    props: "arena",
  },
};

/**
 * Les robots volants (le huitième jalon) : un Drone piloté qu'un obus IEM paralyse en vol (il tombe,
 * puis repart) ; des robots volants de l'IA qui patrouillent, se posent pour recharger leurs batteries
 * et repartent ; des batailles où ils engagent, se mettent à couvert, fuient en montant, et où l'on
 * leur tire dessus.
 */
const FLYERS: Readonly<Record<string, Run>> = {
  "un drone piloté paralysé en vol": {
    bots: [{ id: "drone", x: 0, z: -12, yaw: 0 }],
    phases: [wait(3), wait(10, { fire: [{ weapon: "emp", x: 0, y: 12, z: -12 }] })],
  },
  "des robots volants patrouillent et se posent pour recharger": {
    bots: [
      { id: "drone", x: -10, z: -24, yaw: 0, ai: "red" },
      { id: "heli", x: 0, z: -24, yaw: 0, ai: "red" },
      { id: "frigate", x: 10, z: -24, yaw: 0, ai: "blue" },
      { id: "angel", x: 0, z: 24, yaw: Math.PI, ai: "blue" },
    ],
    phases: [wait(90)],
    props: "arena",
  },
  // Les pales d'une hélice tranchante : l'Avion de l'IA qui roule au sol droit sur un Char arrêté, sur
  // des caisses, contre le mur sud
  "l'hélice d'un avion de l'IA contre un char arrêté": {
    bots: [{ id: "plane", x: 0, z: -22, yaw: 0, ai: "blue" }, { id: "tank", x: 0, z: -16.5, yaw: Math.PI / 2, still: true }],
    phases: [wait(10)],
  },
  "l'hélice d'un avion de l'IA dans des caisses": {
    bots: [{ id: "bomber", x: 0, z: -22, yaw: 0, ai: "red" }],
    props: [spot("crate", 0, -17.5), spot("crate", 1.2, -17.5), spot("crate", -1.2, -17.5)],
    phases: [wait(10)],
  },
  "l'hélice d'un avion de l'IA contre le mur sud": {
    bots: [{ id: "plane", x: 6, z: -31, yaw: Math.PI, ai: "red" }],
    phases: [wait(10)],
  },
  // (une mine anti-aérienne posée sous un Drone piloté : elle lance son missile, qui éclate près de lui)
  "une mine anti-aérienne sous un drone piloté": {
    bots: [{ id: "drone", x: 0, z: -12, yaw: 0 }, { id: "buggy", x: 20, z: 20, yaw: Math.PI, ai: "blue" }],
    phases: [wait(1, { fire: [{ weapon: "aaMine", x: 4, z: -12, by: 1 }, { weapon: "aaMine", x: -14, z: 4, by: 1 }] }), wait(10)],
  },
  "dépôt, des robots volants contre des robots au sol": {
    combat: true,
    bots: [...line("red", ["drone", "heli", "angel"]), ...line("blue", ["tank", "truck", "scarab"])],
    phases: BATTLE,
    props: "arena",
  },
  "forteresse, volants contre volants": {
    arena: "fort",
    combat: true,
    bots: [...line("red", ["frigate", "drone", "trike"]), ...line("blue", ["heli", "angel", "stilt"])],
    phases: BATTLE,
    props: "arena",
  },
  "chantier, volants, appuis et moteurs": {
    arena: "yard",
    combat: true,
    bots: [...line("red", ["frigate", "spider", "rocket"]), ...line("blue", ["drone", "hovercraft", "crane"])],
    phases: BATTLE,
    props: "arena",
  },
  // Les avions : lancés en vol sur le circuit, comme `launchPlane` (un quart de tour entre deux)
  "dépôt, des avions contre des robots au sol": {
    combat: true,
    bots: [
      { id: "fighter", x: 35, z: 0, yaw: 0, ai: "red", launch: true },
      { id: "plane", x: -35, z: 0, yaw: Math.PI, ai: "red", launch: true },
      { id: "tank", x: -8, z: 27, yaw: Math.PI, ai: "blue" },
      { id: "scarab", x: 8, z: 27, yaw: Math.PI, ai: "blue" },
    ],
    phases: BATTLE,
    props: "arena",
  },
  // Le Bombardier : sa passe sur une cible au sol, ses bombes ; la Flak de l'Hexacoptère et la mine
  // anti-aérienne de l'Éclaireur contre les robots en vol
  "forteresse, le bombardier, la flak et la mine anti-aérienne": {
    arena: "fort",
    combat: true,
    bots: [
      { id: "bomber", x: 0, z: -35, yaw: -Math.PI / 2, ai: "red", launch: true },
      { id: "drone", x: -8, z: -27, yaw: 0, ai: "red" },
      { id: "hexa", x: -8, z: 27, yaw: Math.PI, ai: "blue" },
      { id: "scout", x: 8, z: 27, yaw: Math.PI, ai: "blue" },
      { id: "truck", x: 0, z: 27, yaw: Math.PI, ai: "blue" },
    ],
    phases: BATTLE,
    props: "arena",
  },
  "dépôt, avions contre avions": {
    combat: true,
    bots: [
      { id: "fighter", x: 0, z: 35, yaw: Math.PI / 2, ai: "red", launch: true },
      { id: "bomber", x: 0, z: -35, yaw: -Math.PI / 2, ai: "red", launch: true },
      { id: "plane", x: 35, z: 0, yaw: 0, ai: "blue", launch: true },
      { id: "hexa", x: 0, z: 0, yaw: 0, ai: "blue" },
    ],
    phases: BATTLE,
  },
};

/** Une cible arrêtée : un pilote chez les bleus, sans commandes (les rouges, pilotes ou IA, l'attaquent). */
const target = (id: string, x: number, z: number, yaw = Math.PI / 2): Start => ({ id, x, z, yaw, still: true, team: "blue" });

/**
 * Le pilote d'un robot à arme de contact (aucune arme choisie : toutes) : il lance ses rotors, fonce
 * gâchette tenue (un bras, une pointe, un flipper frappent dès qu'ils sont réarmés ; une mâchoire se
 * ferme et tient), appuie, recule sans lâcher (une mâchoire traîne sa proie), puis lâche.
 */
const ASSAULT: readonly Phase[] = [
  { seconds: 2, throttle: 0, steer: 0 },
  { seconds: 3, throttle: 0.6, steer: 0, trigger: true },
  { seconds: 1.5, throttle: 0.2, steer: 0, trigger: true },
  { seconds: 1.5, throttle: -0.6, steer: 0, trigger: true },
  { seconds: 1, throttle: 0, steer: 0 },
];

/**
 * La cible de chaque robot à arme de contact, dans les essais un contre un (de flanc ; le Bastion, ses
 * glacis de face : une lame y glisse).
 */
const PREY: Readonly<Record<string, string>> = {
  reaper: "bastion", pounder: "truck", duelist: "bulwark", urchin: "truck", sawyer: "tank", borer: "truck", catapult: "trike", crusher: "trike",
  thresher: "truck", tumbler: "trike", drummer: "buggy", whirlwind: "bastion",
};
const preyAt = (id: string, z: number): Start => target(PREY[id], 0, z, PREY[id] === "bastion" ? Math.PI : Math.PI / 2);

/** Une bataille de trois quarts de minute, sans commandes (l'IA conduit, lance ses rotors, frappe). */
const BRAWL: readonly Phase[] = [{ seconds: 45, throttle: 0, steer: 0 }];

/**
 * Les armes de contact : chaque robot à arme de contact piloté contre une cible arrêtée (`ASSAULT`),
 * puis conduit par l'IA au combat contre elle ; contre le décor (une toupie, une scie, une foreuse,
 * un disque et un anneau contre le mur sud du Dépôt ; un fléau dont la chaîne s'enroule autour d'un
 * pilier ; le marteau et le fouet contre des caisses, qui s'allument ; le flipper sous un baril ; la
 * lame laser sous l'eau, qui ne s'allume pas) ; et des batailles dans les petites arènes, entre eux et
 * contre des robots à tourelles, à bouclier, à patins et à moteurs (la lance électrique les paralyse).
 */
const MELEE_RUNS: Readonly<Record<string, Run>> = {
  ...Object.fromEntries(MELEE.map((id) => [`${id} piloté contre ${PREY[id]}`, { bots: [{ id, x: 0, z: -24, yaw: 0 }, preyAt(id, -17.5)], phases: ASSAULT }])),
  ...Object.fromEntries(MELEE.map((id) => [
    `${id} de l'IA contre ${PREY[id]}`,
    { combat: true, bots: [{ id, x: 0, z: -24, yaw: 0, ai: "red" }, preyAt(id, -13)], phases: [wait(12)] },
  ])),
  // La lance du Duelliste piloté sur des patins (un Aéroglisseur), sur les propulseurs d'une Fusée (de
  // dos), et contre un Char de l'IA, qui lui tire dessus (sa tourelle paralysée se tait)
  "duelist piloté contre hovercraft": { bots: [{ id: "duelist", x: 0, z: -24, yaw: 0 }, target("hovercraft", 0, -17.5)], phases: ASSAULT },
  "duelist piloté contre rocket, de dos": { bots: [{ id: "duelist", x: 0, z: -24, yaw: 0 }, target("rocket", 0, -18, 0)], phases: ASSAULT },
  "duelist piloté contre le char de l'IA": {
    combat: true,
    bots: [{ id: "duelist", x: 0, z: -24, yaw: 0 }, { id: "tank", x: 0, z: -17, yaw: Math.PI, ai: "blue" }],
    phases: ASSAULT,
  },
  // (la lance passe sous les patins et les pattes, et ne monte pas jusqu'au générateur d'un bouclier :
  // une décharge posée par l'essai, sur un aéroglisseur et une araignée pilotés qui partent, et sur un
  // Rempart qu'un tir touche aussitôt, son bouclier coupé)
  "des patins, des pattes et un bouclier paralysés": {
    bots: [{ id: "hovercraft", x: -8, z: -24, yaw: 0 }, { id: "spider", x: 0, z: -24, yaw: 0 }, target("bulwark", 8, -20, 0)],
    phases: [
      wait(1),
      {
        seconds: 4, throttle: 0.6, steer: 0,
        act: {
          stun: [{ by: 0, x: -8, y: 1.2, z: -24, radius: 2, duration: 2.5 }, { by: 1, x: 0, y: 1.3, z: -24, radius: 1.5, duration: 2.5 }, { by: 2, x: 8, y: 1.6, z: -20, radius: 1.1, duration: 2.5 }],
          fire: [aimed("rifle", 8, 1.4, -27, 8, 1.4, -20), aimed("laser", 8.2, 1.5, -27, 8.2, 1.5, -20)],
        },
      },
      wait(2),
    ],
  },
  ...Object.fromEntries(["reaper", "sawyer", "borer", "tumbler", "whirlwind"].map((id) => [
    `${id} contre le mur sud`,
    { bots: [{ id, x: 0, z: -31.5, yaw: Math.PI }], phases: [wait(2.5), { seconds: 4, throttle: 0.35, steer: 0 }, { seconds: 1, throttle: -0.4, steer: 0 }] },
  ])),
  // (un sapin mince dans le tour de la boule, à côté du robot : la chaîne s'y enroule, le retient, puis
  // se déroule)
  "le fléau du batteur autour d'un sapin": {
    bots: [{ id: "thresher", x: 0, z: -24, yaw: 0 }],
    props: [spot("pine", 1.5, -24, { scale: 0.35 })],
    phases: [wait(8), { seconds: 3, throttle: -0.5, steer: 0 }],
  },
  "le marteau et le fouet contre des caisses": {
    bots: [{ id: "pounder", x: -4, z: -30, yaw: 0 }, { id: "urchin", x: 5, z: -30, yaw: 0 }],
    props: [spot("crate", -4, -27.6), spot("crate", -4, -26.5), spot("crate", 5, -27.4), spot("crate", 6.1, -27.4), spot("crate", 5.5, -26.3)],
    phases: [wait(1), { seconds: 2, throttle: 0.4, steer: 0, trigger: true }, { seconds: 5, throttle: 0, steer: 0, trigger: true }],
  },
  "le flipper sous un baril et une caisse": {
    bots: [{ id: "catapult", x: 0, z: -24, yaw: 0 }],
    props: [spot("barrel", 0, -21.2), spot("crate", 3, -21.4)],
    phases: [wait(1), { seconds: 2, throttle: 0.4, steer: 0 }, { seconds: 4, throttle: 0, steer: 0, trigger: true }],
  },
  "la lame laser sous l'eau": {
    water: 2.5,
    bots: [{ id: "duelist", x: 0, z: -24, yaw: 0 }, target("truck", 0, -17.5)],
    phases: ASSAULT,
  },
  "dépôt, armes de contact, trois contre trois": {
    combat: true,
    bots: [...line("red", ["reaper", "pounder", "duelist"]), ...line("blue", ["urchin", "tumbler", "drummer"])],
    phases: BRAWL,
    props: "arena",
  },
  "forteresse, armes de contact, trois contre trois": {
    arena: "fort",
    combat: true,
    bots: [...line("red", ["sawyer", "borer", "whirlwind"]), ...line("blue", ["catapult", "crusher", "thresher"])],
    phases: BRAWL,
    props: "arena",
  },
  "chantier, armes de contact contre tourelles, bouclier et patins": {
    arena: "yard",
    combat: true,
    bots: [...line("red", ["duelist", "crusher", "sawyer"]), ...line("blue", ["tank", "guardian", "hovercraft"])],
    phases: BRAWL,
    props: "arena",
  },
  "tranchées, armes de contact contre moteurs et réparation": {
    arena: "trenches",
    combat: true,
    bots: [...line("red", ["reaper", "catapult", "thresher"]), ...line("blue", ["truck", "rocket", "mechanic"])],
    phases: BRAWL,
    props: "arena",
  },
};

/** Le point que visent les pilotes des essais de tir : une cible arrêtée au bout de l'allée du Dépôt. */
const MARK = vec3(0, 1.1, -8);

/** Le pilote vise `MARK`, gâchette tenue, `seconds` s (et ce que `more` y ajoute). */
const shoot = (seconds: number, more: Partial<Phase> = {}): Phase => ({ seconds, throttle: 0, steer: 0, aim: MARK, trigger: true, ...more });

/**
 * Les tirs du pilote (`operatePlayerTurrets`) : chaque sorte d'arme, contre un Camion arrêté chez les
 * bleus (un tir en cloche, dont le pilote choisit la hausse ; le fusil de précision, qui ne tire
 * qu'au viseur ; une arme choisie, les autres au repos ; des missiles téléguidés, un verrou pris au
 * viseur, des roquettes ; l'ogive pilotée, guidée vers le point visé puis qu'un nouveau clic fait
 * sauter ; des mines semées en roulant ; les leurres ; le canon électrique, le plasma, le fusil à
 * pompe ; le rayon réparateur qui vole la vie, le mur d'énergie ; les bombes d'un avion) ; une tourelle
 * paralysée qui se tait ; et la conduite à la caméra au sol (`cameraDrive`).
 */
const PILOT_RUNS: Readonly<Record<string, Run>> = {
  "le scarabée piloté tire au canon, en cloche ; sa tourelle paralysée se tait": {
    bots: [{ id: "scarab", x: 0, z: -24, yaw: 0 }, target("truck", 0, -8)],
    phases: [wait(1), shoot(4), shoot(3, { act: { stun: [{ by: 0, x: 0, y: 1, z: -24, radius: 1.6, duration: 2 }] } })],
  },
  "l'échassier piloté tire au fusil de précision, au viseur seulement": {
    bots: [{ id: "stilt", x: 0, z: -24, yaw: 0 }, target("truck", 0, -8)],
    phases: [wait(1), shoot(2), shoot(4, { scope: true })],
  },
  "le bélier piloté change d'arme : lance-flammes, fusil, mine": {
    bots: [{ id: "ram", x: 0, z: -20, yaw: 0 }, target("truck", 0, -12)],
    phases: [shoot(3, { weapon: "flamer" }), shoot(3, { weapon: "rifle" }), shoot(2, { weapon: "mine" })],
  },
  "la grue pilotée tire ses missiles téléguidés": { bots: [{ id: "crane", x: 0, z: -24, yaw: 0 }, target("truck", 0, -8)], phases: [shoot(6)] },
  "le traqueur piloté verrouille au viseur et tire": {
    bots: [{ id: "tracker", x: 0, z: -24, yaw: 0 }, target("truck", 0, -8)],
    phases: [shoot(2), shoot(6, { scope: true })],
  },
  "l'essaim piloté tire ses roquettes": { bots: [{ id: "swarm", x: 0, z: -24, yaw: 0 }, target("truck", 0, -8)], phases: [shoot(5, { weapon: "rockets" })] },
  "le porte-ogive piloté guide son ogive, puis la fait sauter": {
    bots: [{ id: "carrier", x: 0, z: -26, yaw: 0 }, target("truck", 0, -8)],
    phases: [
      shoot(0.5, { weapon: "warhead", aim: vec3(0, 14, -14) }),
      { seconds: 1, throttle: 0, steer: 0, aim: vec3(14, 12, -12), weapon: "warhead" },
      shoot(0.5, { weapon: "warhead", aim: vec3(14, 12, -12) }),
      wait(2),
    ],
  },
  "le sapeur piloté sème ses mines en roulant": { bots: [{ id: "sapper", x: 0, z: -26, yaw: 0 }, target("truck", 0, -8)], phases: [shoot(4, { throttle: 0.5 }), wait(2)] },
  "le char piloté lance ses leurres et tire, conduit à la caméra": {
    bots: [{ id: "tank", x: 0, z: -26, yaw: 0 }, target("truck", 0, -8)],
    phases: [
      { seconds: 2, throttle: 0.6, steer: 0, flares: true, flight: { relative: true, heading: 0.6 } },
      shoot(3, { throttle: 0.5, flight: { relative: true, heading: -2.6 } }),
      shoot(2, { throttle: 0.4, steer: 0.5, flight: { relative: true, heading: 0 } }),
    ],
  },
  "trois pilotes tirent sur un camion : canon électrique, plasma, fusil à pompe": {
    bots: [{ id: "lancer", x: -6, z: -22, yaw: 0 }, { id: "furnace", x: 0, z: -20, yaw: 0 }, { id: "brawler", x: 6, z: -18, yaw: 0 }, target("truck", 0, -8)],
    phases: [shoot(5)],
  },
  "le mécanicien et le gardien pilotés : rayon réparateur, puis mur d'énergie (sa cadence : 12 s)": {
    bots: [{ id: "mechanic", x: -4, z: -22, yaw: 0 }, { id: "guardian", x: 4, z: -22, yaw: 0 }, target("truck", 0, -8)],
    phases: [shoot(4), shoot(9, { weapon: "barrier" })],
  },
  "le bombardier piloté largue ses bombes et ses leurres": {
    bots: [{ id: "bomber", x: 0, z: -30, yaw: 0, launch: true }, target("truck", 0, -8)],
    phases: [shoot(3, { flares: true }), wait(3)],
  },
};

/**
 * Une ligne de robots de l'IA dans une grande arène : centrée en (`x`, `z`), 8 m entre deux, le long
 * de x, tournés vers `yaw` (vers le nord, +z, par défaut ; π : vers le sud).
 */
const lineAt = (team: Team, ids: readonly string[], x: number, z: number, yaw = team === "red" ? 0 : Math.PI): Start[] =>
  ids.map((id, i) => ({ id, x: x + (i - (ids.length - 1) / 2) * 8, z, yaw, ai: team }));

/**
 * Les grandes arènes et les cartes : des batailles d'IA courtes dans chacune (le relief, ses rochers,
 * ses ponts et ses bâtiments ; la grille de passage, l'eau profonde et la lave ; le réseau de passage ;
 * la ville), des robots qui roulent sur le relief, traversent un pont, se noient, brûlent dans la lave,
 * des avions au-dessus du plancher de l'arène.
 */
const ARENA_RUNS: Readonly<Record<string, Run>> = {
  // La Vallée : le relief, ses rochers, son pont de pierre, ses maisons faites d'accessoires (des
  // bâtiments d'un bloc), sa rivière peu profonde ; des avions au-dessus de son plancher de vol
  "vallée, trois contre trois autour du pont": {
    arena: "valley",
    combat: true,
    bots: [...lineAt("red", ["tank", "trike", "scarab"], 0, -22), ...lineAt("blue", ["buggy", "truck", "lancer"], 0, 22)],
    phases: [{ seconds: 20, throttle: 0, steer: 0 }],
    props: "arena",
  },
  "vallée, un camion piloté traverse le pont": {
    arena: "valley",
    bots: [{ id: "truck", x: 0, z: -27, yaw: 0 }],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 12, throttle: 0.6, steer: 0 }, { seconds: 2, throttle: 0, steer: 0, brake: 1 }],
    props: "arena",
  },
  "vallée, des avions et des robots volants": {
    arena: "valley",
    combat: true,
    bots: [
      { id: "plane", x: 72, z: 0, yaw: 0, ai: "red", launch: true }, { id: "fighter", x: -72, z: 0, yaw: Math.PI, ai: "blue", launch: true },
      ...lineAt("red", ["drone", "tank"], 30, -30), ...lineAt("blue", ["heli", "truck"], 30, 30),
    ],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
  // L'Île volcanique : la grille de passage (le volcan, les gorges, la mer), la lave, l'eau profonde
  "île, trois contre trois sur la piste": {
    arena: "island",
    combat: true,
    bots: [...lineAt("red", ["tank", "scarab", "drone"], 60, -80), ...lineAt("blue", ["buggy", "truck", "heli"], 60, -40)],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
  // (le Bélier charge le Camion, de l'autre côté de la gorge : par le pont)
  "île, un bélier charge par-dessus la gorge": {
    arena: "island",
    combat: true,
    bots: [{ id: "ram", x: -78, z: -58, yaw: 0, ai: "red" }, { id: "truck", x: -78, z: -2, yaw: Math.PI, ai: "blue" }],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
  "île, un char piloté entre dans la lave": {
    arena: "island",
    bots: [{ id: "tank", x: 66, z: -34, yaw: 0 }],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 4, throttle: 0.5, steer: 0 }, { seconds: 8, throttle: 0, steer: 0 }],
    props: "arena",
  },
  "île, un char piloté se noie dans la mer": {
    arena: "island",
    bots: [{ id: "tank", x: 80, z: -72, yaw: 2.42 }],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 10, throttle: 0.7, steer: 0 }, { seconds: 8, throttle: 0, steer: 0 }],
    props: "arena",
  },
  "île, un aéroglisseur piloté glisse sur la mer": {
    arena: "island",
    bots: [{ id: "hovercraft", x: 80, z: -72, yaw: 2.42 }],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 7, throttle: 1, steer: 0 }, { seconds: 3, throttle: 0, steer: 0 }],
    props: "arena",
  },
  // Le Port : la grille de passage, les quais au-dessus de l'eau profonde, les entrepôts, les silos
  // ronds, le cargo et ses passerelles, la pile de conteneurs et sa haute rampe
  "port, trois contre trois sur les quais": {
    arena: "port",
    combat: true,
    bots: [...lineAt("red", ["tank", "trike", "lancer"], 50, 52), ...lineAt("blue", ["buggy", "truck", "scarab"], 50, 20)],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
  // (un Char sur le pont du cargo, que relient au quai deux passerelles, et les autres sur les quais)
  "port, le cargo et ses passerelles": {
    arena: "port",
    combat: true,
    bots: [
      { id: "tank", x: -25, z: 0, yaw: Math.PI / 2, ai: "red", ground: 7.2 }, { id: "trike", x: -35, z: -28, yaw: 0, ai: "red" },
      { id: "buggy", x: -20, z: 30, yaw: Math.PI, ai: "blue" }, { id: "scarab", x: -32, z: 32, yaw: Math.PI, ai: "blue" },
    ],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
  // Le Canyon : le réseau de passage (sentiers, viaduc, arche), les tunnels, les falaises
  "canyon, trois contre trois par le viaduc": {
    arena: "canyon",
    combat: true,
    bots: [...lineAt("red", ["tank", "trike", "scarab"], 0, -32), ...lineAt("blue", ["buggy", "truck", "lancer"], 0, 32)],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
  "canyon, au fond du canyon, près de l'oasis": {
    arena: "canyon",
    combat: true,
    bots: [...lineAt("red", ["duelist", "tank"], -45, 2, -Math.PI / 2), ...lineAt("blue", ["ram", "truck"], -80, -4, Math.PI / 2)],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
  // La Ville : les rues (bâtiments faits d'accessoires : en sortir, ne pas y viser, longer leurs
  // murs), la voie express (on passe dessous), le parking à étage (hautes rampes), les toits que
  // survolent les robots volants
  "ville, trois contre trois dans les rues": {
    arena: "city",
    combat: true,
    bots: [...lineAt("red", ["tank", "trike", "drone"], 0, -72), ...lineAt("blue", ["buggy", "truck", "heli"], 0, 72)],
    phases: [{ seconds: 30, throttle: 0, steer: 0 }],
    props: "arena",
  },
  // (de part et d'autre de la voie express : on passe dessous, entre ses piles)
  "ville, sous la voie express": {
    arena: "city",
    combat: true,
    bots: [
      { id: "tank", x: -40, z: 0, yaw: -Math.PI / 2, ai: "red" }, { id: "trike", x: -40, z: 10, yaw: -Math.PI / 2, ai: "red" },
      { id: "buggy", x: -80, z: 0, yaw: Math.PI / 2, ai: "blue" }, { id: "scarab", x: -80, z: 10, yaw: Math.PI / 2, ai: "blue" },
    ],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
  "ville, autour du parking à étage": {
    arena: "city",
    combat: true,
    bots: [...lineAt("red", ["scarab", "tank"], 34, -22), ...lineAt("blue", ["truck", "trike"], 34, -84)],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
  "ville de nuit, deux contre deux": {
    arena: "cityNight",
    combat: true,
    bots: [...lineAt("red", ["tank", "trike"], -20, -72), ...lineAt("blue", ["buggy", "scarab"], -20, 72)],
    phases: [{ seconds: 15, throttle: 0, steer: 0 }],
    props: "arena",
  },
  // Val du Lac : une carte communautaire (préfabriqués, grille de passage par défaut, lac profond)
  "val du lac, trois contre trois au bord du lac": {
    arena: "val-du-lac",
    combat: true,
    bots: [...lineAt("red", ["tank", "trike", "scarab"], 20, -40), ...lineAt("blue", ["buggy", "truck", "lancer"], 20, 40)],
    phases: [{ seconds: 25, throttle: 0, steer: 0 }],
    props: "arena",
  },
};

/** Les événements du TypeScript que la simulation portée sait produire ; un autre : quelque chose de pas porté. */
const PORTED_EVENTS = new Set<SimEvent["type"]>([
  "botAdded", "partAdded", "partRemoved", "wheelAdded", "wheelRemoved", "blockAttached", "blockDamaged", "blockDestroyed",
  "botKilled", "collision", "damage", "debrisAdded", "debrisRemoved", "linkBroken", "shieldHit",
  "propAdded", "propRemoved", "propReleased", "propFire", "explosion", "fireStarted", "fireEnded",
  "blockRebuilt", "blockRepaired", "groundFireAdded", "groundFireRemoved",
  "shot", "projectileAdded", "projectileRemoved", "impact", "hit", "mine",
  "empBurst", "stunned", "smokeAdded", "smokeRemoved", "barrierAdded", "barrierHit", "barrierRemoved",
  // (les armes de contact : leurs coups, et la paralysie locale de la décharge d'une lance électrique)
  "meleeHit", "organsStunned",
]);

/**
 * L'état d'un robot relevé chaque seconde : ses morceaux, ses roues, ses blocs, ses liaisons rompues,
 * ce que regarde la réparation (`sim_bot_state`), l'état de son IA (`sim_ai_state`, sans ses rayons
 * d'évitement, que le TypeScript garde pour lui) et le point vers lequel sa navigation le ferait
 * rouler, de sa dernière position à sa destination (`sim_nav_goal`, `navigate`).
 */
interface BotSample {
  parts: number[][];
  wheels: number[][];
  blocks: number[];
  cuts: number;
  state: number[];
  ai: number[];
  nav: number[];
  turrets: number[][];
  tactics: number[];
  thrusters: number[][];
  supports: number[][];
  pilot: number[];
  surfaces: number[][];
  melee: number[][];
}

/**
 * Les robots, les débris, les accessoires (par emplacement), les flaques de feu, les projectiles, les
 * nuages de fumée, les murs d'énergie, ce que chaque équipe a repéré (rouges, bleus : `sim_detected`),
 * et ce qui s'est passé (comme `sim_stats`).
 */
interface Sample {
  bots: BotSample[];
  debris: number[][];
  props: number[][];
  groundFires: number[][];
  projectiles: number[][];
  smokes: number[][];
  barriers: number[][];
  detected: number[];
  stats: number[];
}

const FIELDS_BODY = ["x", "y", "z", "qx", "qy", "qz", "qw", "vx", "vy", "vz", "wx", "wy", "wz"];
const FIELDS_WHEEL = ["x", "y", "z", "qx", "qy", "qz", "qw", "steer", "travel", "spin", "spinRate", "load", "drive", "hp", "où", "coupée jusqu'à"];
const FIELDS_BLOCK = ["hp", "vivant", "morceau", "feu", "perdu", "coupé jusqu'à"];
const FIELDS_BOT = [
  "dernier coup", "repousse après", "énergie", "ordre des blocs vivants", "ordre des blocs perdus", "paralysé jusqu'à", "soulevé par", "soulevé jusqu'à",
];
const FIELDS_PROP = [
  "présent", ...FIELDS_BODY, "ancré", "hp", "état", "reste", "fuite x", "fuite z", "feu", "noirci", "laisse passer", "éclats x", "éclats y", "éclats z",
];
const FIELDS_GROUND_FIRE = ["x", "y", "z", "rayon", "jusqu'à", "auteur"];
const FIELDS_AI = ["mode", "destination x", "destination y", "destination z", "minuterie", "reste du mode", "coincé", "bloqué", "sens", "x", "y", "z"];
const FIELDS_NAV = ["vers x", "vers y", "vers z"];
const FIELDS_DETECTED = ["repérés par les rouges", "repérés par les bleus"];
const FIELDS_TURRET = [
  "lacet", "site", "cadence", "chaleur", "surchauffe", "coups", "rechargement", "cible", "reste avant de changer de cible", "visée x", "visée y", "visée z",
  "erreur x", "erreur y", "erreur z", "dernier tir", "prochain tir de son arme", "verrouillé", "verrou depuis", "verrou caché depuis",
];
const FIELDS_TACTICS = [
  "adversaire", "vu à", "sens", "reste avant de revoir son plan", "à couvert depuis", "pas de couvert avant", "dernier attaquant", "salves de leurres",
  "leurres en recharge depuis", "pas de salve avant",
];
const FIELDS_PROJECTILE = [
  "tireur", "départ x", "départ y", "départ z", "x", "y", "z", "vx", "vy", "vz", "âge", "dégâts", "tourelle", "cible", "coque", "abattu", "perdu", "aveugle depuis",
  "leurre", "leurres vus", "posée", "repérée par", "prochain signal", "collée au robot", "collée au bloc", "mèche",
];
const FIELDS_THRUSTER = ["bloc", "rôle", "sens", "poussée", "inclinaison a", "inclinaison b", "part de poussée", "fin du raté"];
const FIELDS_SUPPORT = ["bloc", "contact", "force", "phase"];
const FIELDS_SURFACE = ["bloc", "braquage"];
const FIELDS_MELEE = [
  "bloc", "régime", "angle", "dernier coup", "phase", "depuis", "bras", "revient de", "fatigue",
  "mord", "morsure x", "morsure y", "morsure z", "lame x", "lame y", "lame z", "surface mordue", "puissance", "glisse",
  "dégâts accumulés", "énergie coupée", "tranche depuis",
  "boule", "boule x", "boule y", "boule z", "boule vx", "boule vy", "boule vz", "chaîne enroulée au moyeu",
  "chaîne enroulée", "appui x", "appui y", "appui z", "longueur jusqu'à l'appui", "enroulée depuis",
  "proie", "bloc tenu", "glissement", "écrasement", "prise x", "prise y", "prise z",
];
/** Les phases d'une arme de contact (`SwingPhase`), dans l'ordre de `melee::Phase`. */
const PHASES = ["ready", "strike", "recover", "hold"];
/** Ce que mord une lame (`ImpactSurface`), dans l'ordre de `melee::Surface`. */
const SURFACES = ["robot", "prop", "scenery"];
const FIELDS_PILOT = ["altitude visée", "trim", "lacet piloté", "phase du bombardement", "passe x", "passe y", "passe z", "côté du demi-tour"];
/** Les phases du circuit d'attaque d'un bombardier, dans l'ordre de `brain::RunPhase`. */
const RUN_PHASES = ["pass", "out", "turn"];
/** Les rôles des moteurs (`Thruster.role`), dans l'ordre de `robot::Role` (le Rust donne leur rang). */
const ROLES = ["lift", "cruise", "trim"];
const FIELDS_SMOKE = ["x", "y", "z", "rayon", "né à", "durée"];
const FIELDS_BARRIER = ["équipe", "x", "y", "z", "normale x", "normale y", "normale z", "largeur", "hauteur", "hp", "jusqu'à"];
/** Les modes de l'IA (`AiMode`), dans l'ordre de `brain::Mode` (le Rust donne leur rang). */
const MODES: readonly AiMode[] = [
  "patrol", "engage", "cover", "flee", "charge", "reverse", "hover", "paused", "gliding", "landing", "stunned", "flipped", "stranded", "falling", "dead", "support",
];
const TEAMS: readonly Team[] = ["red", "blue"];
const FIELDS_STATS = [
  "chocs", "lots de dégâts", "blocs détruits", "liaisons rompues", "robots hors de combat", "roues arrachées", "roues retirées", "pas porté", "tirages",
  "explosions", "accessoires retirés", "accessoires libérés", "blocs allumés", "blocs éteints", "feu des accessoires",
  "blocs repoussés", "blocs réparés", "flaques allumées", "flaques éteintes",
  "tirs", "projectiles lancés", "projectiles finis", "impacts", "robots touchés par une arme", "signaux des capteurs",
  "mines qui bondissent", "mines qui se collent", "impulsions électromagnétiques", "robots paralysés", "nuages lâchés", "nuages dissipés",
  "murs déployés", "murs touchés", "murs éteints ou brisés", "coups des armes de contact", "paralysies locales",
];

let probe: SimProbe;

/** Un texte dans la mémoire du module, le temps d'un appel. */
function withText<T>(text: string, use: (ptr: number, len: number) => T): T {
  const bytes = new TextEncoder().encode(text);
  const ptr = probe.alloc(bytes.length);
  try {
    new Uint8Array(probe.memory.buffer, ptr, bytes.length).set(bytes);
    return use(ptr, bytes.length);
  } finally {
    probe.dealloc(ptr, bytes.length);
  }
}

function lastError(): string {
  const ptr = probe.alloc(512);
  const n = probe.sim_error(ptr, 512);
  const text = new TextDecoder().decode(new Uint8Array(probe.memory.buffer, ptr, n));
  probe.dealloc(ptr, 512);
  return text;
}

function profileOf(id: string) {
  const profile = PRESET_BOTS.find((p) => p.id === id);
  if (!profile) throw new Error(`robot inconnu : ${id}`);
  return profile;
}

const startHeight = (id: string): number => groundHeight(profileOf(id).design) + 0.03;
/** La hauteur où part un robot : posé au sol, ou en vol (un avion lancé). */
const startY = (s: Start, arena: ArenaLayout): number => (s.ground ?? groundUnder(arena, s.x, s.z)) + (s.launch ? PLANE_SPAWN_Y : startHeight(s.id));

/** Le sol sous un robot qui part en (x, z) : le plus haut du relief sous lui et à 2,5 m autour (comme `spawnHeight`, sim/wave.ts) ; 0 sans relief. */
function groundUnder(arena: ArenaLayout, x: number, z: number): number {
  let ground = groundLevel(arena, x, z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ground = Math.max(ground, groundLevel(arena, x + dcos(a) * 2.5, z + dsin(a) * 2.5));
  }
  return ground;
}

/** Un robot du TypeScript, aux commandes d'un pilote, et tous ses blocs (dans l'ordre du plan, vivants ou non). */
interface TsBot {
  bot: Bot;
  input: PlayerInput;
  blocks: Block[];
}

/**
 * Des robots dans une Simulation du TypeScript (avec le décor du Dépôt, ou celui d'une autre arène
 * qui le remplace, `loadArena`), aux commandes d'un pilote ou de l'IA ; et des accessoires (ceux de
 * l'arène, ou d'un agencement d'essai), créés avant les robots, comme le fait le jeu (`loadArena`,
 * `spawnWave`). `props` : tous ceux qui ont été créés (présents ou non). `water` : le niveau de l'eau
 * (ces arènes n'en ont pas ; elle n'y sert qu'à éteindre les flaques). L'IA est hors combat (le stand
 * de tir, l'essai du garage : `GameMode.combat`), sauf dans une bataille (`Run.combat`).
 */
function tsWorld(run: Pick<Run, "arena" | "bots" | "props" | "water" | "combat">): { sim: Simulation; bots: TsBot[]; props: Prop[] } {
  const sim = new Simulation();
  sim.combat = run.combat ?? false;
  const arrangement = run.props;
  const base = arenaOf(run.arena ?? "depot");
  let arena: ArenaLayout = base;
  if (arrangement && arrangement !== "arena") arena = { ...arena, props: arrangement };
  if (run.water !== undefined) arena = { ...arena, water: run.water };
  if (run.arena) {
    // (une Simulation neuve a le décor du Dépôt : le changer d'arène le remplace, et crée ses accessoires)
    sim.loadArena(arrangement ? arena : { ...arena, props: [] });
  } else {
    if (arena !== base) sim.arena = arena;
    if (arrangement) resetProps(sim);
  }
  const props = [...sim.props];
  const bots = run.bots.map((s) => {
    const bot = spawnBot(sim, profileOf(s.id), vec3(s.x, startY(s, base), s.z), s.yaw, s.ai ?? s.team ?? "red");
    sim.bots.push(bot);
    if (s.launch) setBotVelocity(bot, launchVelocity(s));
    const input = newInput();
    if (!s.ai) takeControl(bot, input);
    return { bot, input, blocks: [...bot.blocks.values()] };
  });
  return { sim, bots, props };
}

/** L'état de l'IA d'un robot, comme `sim_ai_state` (sans ses rayons d'évitement). */
function aiState(bot: Bot): number[] {
  const { ai, lastPos: p } = bot;
  return [MODES.indexOf(ai.mode), ai.target.x, ai.target.y, ai.target.z, ai.timer, ai.modeT, ai.stuckT, ai.blockedT, ai.flip, p.x, p.y, p.z];
}

/** Ce que l'équipe a repéré, comme `sim_detected` : la somme de 2 à la puissance du rang de chaque robot repéré (-1 : la détection n'a pas tourné). */
function detectedMask(sim: Simulation, bots: TsBot[], team: Team): number {
  const seen = sim.detected.get(team);
  return seen ? bots.reduce((sum, { bot }, i) => sum + (seen.has(bot) ? 2 ** i : 0), 0) : -1;
}

/** Le rang d'un robot parmi ceux de l'essai (-1 : aucun), comme le Rust donne son numéro. */
const rankOf = (bots: TsBot[], bot: Bot | null): number => (bot ? bots.findIndex((b) => b.bot === bot) : -1);

/** L'état d'une tourelle, comme `sim_turret_state`. */
function turretState(bots: TsBot[], bot: Bot, t: Turret): number[] {
  const a = t.arm;
  const aim = t.aim ?? vec3(NaN, NaN, NaN);
  return [
    t.yaw, t.pitch, a.cooldown, a.heat, a.overheated ? 1 : 0, a.ammo, a.restock, rankOf(bots, t.target), t.retarget, aim.x, aim.y, aim.z,
    t.wobble.x, t.wobble.y, t.wobble.z, t.firedAt, bot.nextShot.get(t.weapon) ?? -Infinity, rankOf(bots, t.lockOn), t.lockTime, t.lockHidden,
  ];
}

/** La tactique d'un robot, comme `sim_tactics_state`. */
function tacticsState(bots: TsBot[], bot: Bot): number[] {
  const t = bot.ai.tactics;
  const f = bot.flares;
  return [rankOf(bots, t.foe), t.seenAt, t.orbit, t.planT, t.coverT, t.coverBan, rankOf(bots, bot.lastAttacker), f.charges, f.restock, f.readyAt];
}

/** L'état d'un projectile, comme `sim_projectile_state`. */
function projectileState(sim: Simulation, bots: TsBot[], p: Projectile): number[] {
  const stuckBot = p.stuck ? rankOf(bots, p.stuck.block.bot) : -1;
  return [
    rankOf(bots, p.shooter), p.origin.x, p.origin.y, p.origin.z, p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.age, p.damage,
    p.commander && p.shooter ? p.shooter.turrets.indexOf(p.commander) : -1, rankOf(bots, p.homing), p.hp, p.blown ? 1 : 0, p.lost ? 1 : 0, p.blind,
    p.decoy ? sim.projectiles.indexOf(p.decoy) : -1, p.tried.length,
    p.landed ? 1 : 0, TEAMS.reduce((m, team, i) => m + (p.spotted.includes(team) ? 2 ** i : 0), 0), p.pingAt,
    stuckBot, p.stuck && stuckBot >= 0 ? bots[stuckBot].blocks.indexOf(p.stuck.block) : -1, p.fuse ?? NaN,
  ];
}

/** L'état d'un mur d'énergie, comme `sim_barrier_state`. */
const barrierState = (b: Barrier): number[] => [
  TEAMS.indexOf(b.team), b.center.x, b.center.y, b.center.z, b.normal.x, b.normal.y, b.normal.z, b.width, b.height, b.hp, b.until,
];

/** L'état d'un accessoire, comme `sim_prop_state` (retiré : des zéros). */
function propState(sim: Simulation, p: Prop): number[] {
  if (!sim.props.includes(p)) return new Array<number>(FIELDS_PROP.length).fill(0);
  const s = p.state;
  const kind = s.kind === "intact" ? 0 : s.kind === "fuse" ? 1 : 2;
  const left = s.kind === "intact" ? 0 : s.left;
  const leak = s.kind === "venting" ? s.leak : vec3(0, 0, 0);
  const struck = p.struck ?? vec3(0, 0, 0);
  return [1, ...bodyState(p.rb), p.fixed ? 1 : 0, p.hp, kind, left, leak.x, leak.z, p.burn, p.charred, p.yielding ?? 0, struck.x, struck.y, struck.z];
}

/** L'état d'un corps de Rapier, comme `body_state`. */
function bodyState(rb: { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number }; linvel(): { x: number; y: number; z: number }; angvel(): { x: number; y: number; z: number } }): number[] {
  const [t, r, v, w] = [rb.translation(), rb.rotation(), rb.linvel(), rb.angvel()];
  return [t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z];
}

/**
 * L'ordre de blocs d'un robot (ses blocs vivants, `bot.blocks`, ou perdus, `bot.lost` : des `Map`)
 * résumé en un nombre, comme `sim_bot_state` : la somme des rangs des blocs dans le plan, pondérés par
 * leur rang dans la `Map`.
 */
const orderOf = (map: Map<string, Block>, blocks: readonly Block[]): number => [...map.values()].reduce((s, b, rank) => s + (rank + 1) * (blocks.indexOf(b) + 1), 0);

/**
 * L'état d'une arme de contact, comme `sim_melee_state` : régime, angle, dernier coup, phase, bras ;
 * sa morsure et ce qu'elle a accumulé ; la boule d'un fléau et sa chaîne ; la prise d'une mâchoire.
 */
function meleeState(bots: TsBot[], blocks: readonly Block[], a: MeleeArm): number[] {
  const { bite, gnaw, ball, grip } = a;
  const wrap = ball?.wrap ?? null;
  const prey = grip ? rankOf(bots, grip.block.bot) : -1;
  return [
    blocks.indexOf(a.block), a.spin, a.angle, a.hitAt, PHASES.indexOf(a.phase), a.phaseT, a.swing, a.from, a.fatigue,
    ...(bite
      ? [1, bite.point.x, bite.point.y, bite.point.z, bite.dir.x, bite.dir.y, bite.dir.z, SURFACES.indexOf(bite.surface), bite.power, bite.glance ? 1 : 0]
      : [0, NaN, NaN, NaN, NaN, NaN, NaN, -1, NaN, 0]),
    ...(gnaw ? [gnaw.damage, gnaw.cut, gnaw.since] : [NaN, NaN, NaN]),
    ...(ball ? [1, ball.pos.x, ball.pos.y, ball.pos.z, ball.vel.x, ball.vel.y, ball.vel.z, ball.wound] : [0, NaN, NaN, NaN, NaN, NaN, NaN, NaN]),
    ...(wrap ? [1, wrap.point.x, wrap.point.y, wrap.point.z, wrap.length, wrap.since] : [0, NaN, NaN, NaN, NaN, NaN]),
    ...(grip
      ? [prey, prey >= 0 ? bots[prey].blocks.indexOf(grip.block) : -1, grip.slip, grip.crush, grip.local.x, grip.local.y, grip.local.z]
      : [-1, -1, NaN, NaN, NaN, NaN, NaN]),
  ];
}

/** L'état du monde du TypeScript, comme le relève le Rust. */
function tsSample(sim: Simulation, bots: TsBot[], props: Prop[], counts: Record<string, number>, draws: number): Sample {
  return {
    bots: bots.map(({ bot, blocks }) => {
      const parts = [...bot.parts];
      return {
        parts: parts.map((p) => bodyState(p.rb)),
        wheels: bot.wheels.map((w) => {
          const p = w.rb.translation();
          const q = w.rb.rotation();
          const at = w.part ? parts.indexOf(w.part) : w.body ? -1 : -2;
          return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, w.steer, w.travel, w.spin, w.spinRate, w.load, w.drive, w.hp, at, w.stunnedUntil];
        }),
        blocks: blocks.flatMap((b) => [
          b.hp, b.alive ? 1 : 0, b.alive ? parts.indexOf(b.part) : -1, b.burn, bot.lost.get(b.key) === b ? 1 : 0, b.stunnedUntil,
        ]),
        cuts: bot.cuts.size,
        state: [
          bot.lastHit, bot.rebuildAt, bot.energy, orderOf(bot.blocks, blocks), orderOf(bot.lost, blocks), bot.stunnedUntil,
          bot.thrownBy ? rankOf(bots, bot.thrownBy.by) : -1, bot.thrownBy ? bot.thrownBy.until : 0,
        ],
        ai: aiState(bot),
        nav: ((g) => [g.x, g.y, g.z])(navigate(sim, bot, bot.lastPos, bot.ai.target)),
        turrets: bot.turrets.map((t) => turretState(bots, bot, t)),
        tactics: tacticsState(bots, bot),
        thrusters: bot.thrusters.map((t) => [
          blocks.indexOf(t.block), ROLES.indexOf(t.role), t.spin, t.thrust, t.tiltA, t.tiltB, t.output, t.misfireUntil,
        ]),
        supports: bot.supports.map((s) => [blocks.indexOf(s.block), s.contact, s.force, s.phase]),
        pilot: ((ai, run) => [
          ai.alt, ai.trim, ai.slip, run ? RUN_PHASES.indexOf(run.phase) : -1, run?.dir.x ?? 0, run?.dir.y ?? 0, run?.dir.z ?? 0, run?.turn ?? 0,
        ])(bot.ai, bot.ai.bombRun),
        surfaces: bot.surfaces.map((s) => [blocks.indexOf(s.block), s.deflection]),
        melee: bot.melee.map((a) => meleeState(bots, blocks, a)),
      };
    }),
    debris: sim.debris.map((d) => bodyState(d.rb)),
    props: props.map((p) => propState(sim, p)),
    groundFires: sim.groundFires.map((f) => [f.pos.x, f.pos.y, f.pos.z, f.radius, f.until, f.owner ? bots.findIndex((b) => b.bot === f.owner) : -1]),
    projectiles: sim.projectiles.map((p) => projectileState(sim, bots, p)),
    smokes: sim.smokes.map((c) => [c.pos.x, c.pos.y, c.pos.z, c.radius, c.born, c.life]),
    barriers: sim.barriers.map(barrierState),
    detected: TEAMS.map((team) => detectedMask(sim, bots, team)),
    stats: [
      counts.collision ?? 0, counts.damage ?? 0, counts.blockDestroyed ?? 0, counts.linkBroken ?? 0, counts.botKilled ?? 0,
      // (une roue arrachée n'a pas d'événement : celles qui ont un corps, ou n'en ont plus)
      bots.reduce((s, { bot }) => s + bot.wheels.filter((w) => !w.part).length, 0),
      counts.wheelRemoved ?? 0, 0, draws,
      counts.explosion ?? 0, counts.propRemoved ?? 0, counts.propReleased ?? 0, counts.fireStarted ?? 0, counts.fireEnded ?? 0, counts.propFire ?? 0,
      counts.blockRebuilt ?? 0, counts.blockRepaired ?? 0, counts.groundFireAdded ?? 0, counts.groundFireRemoved ?? 0,
      counts.shot ?? 0, counts.projectileAdded ?? 0, counts.projectileRemoved ?? 0, counts.impact ?? 0, counts.hit ?? 0, counts["mine:ping"] ?? 0,
      counts["mine:bounce"] ?? 0, counts["mine:stick"] ?? 0, counts.empBurst ?? 0, counts.stunned ?? 0, counts.smokeAdded ?? 0, counts.smokeRemoved ?? 0,
      counts.barrierAdded ?? 0, counts.barrierHit ?? 0, counts.barrierRemoved ?? 0, counts.meleeHit ?? 0, counts.organsStunned ?? 0,
    ],
  };
}

/** Le point d'une action de l'essai (`y` : 0,3 m par défaut, une mine posée au sol). */
const spotAt = (s: Spot, shift = 0): Vec3 => vec3(s.x + shift, s.y ?? 0.3, s.z);
const UP = vec3(0, 1, 0);
const DOWN = vec3(0, -1, 0);

/**
 * Ce que l'essai fait au début d'une phase, côté TypeScript (`act`), en comptant ce qui arrive aux
 * flaques : pas de sol dessous (`air`), refusée sous l'eau (`drowned`) ou faute de place (`full`),
 * une flaque qui brûlait déjà là ravivée (`merged`), une nouvelle (`lit`) ; et les blocs de son
 * auteur qui se tiennent dans une flaque de napalm qu'il a allumée (`ownerInside`, qu'elle ne brûle
 * pas). (`groundBelow` n'est qu'une requête à Rapier : la relancer pour compter ne change rien.)
 */
function actTs(sim: Simulation, bots: TsBot[], act: Act, counts: Record<string, number>): void {
  const bump = (what: string, n = 1): void => {
    counts[what] = (counts[what] ?? 0) + n;
  };
  const water = sim.arena.water;
  for (const n of act.napalm ?? []) {
    const point = spotAt(n);
    const owner = n.by === undefined ? null : bots[n.by].bot;
    const before = sim.groundFires.length;
    const ground = groundBelow(sim, point, PUDDLE_REACH);
    explode(sim, point, WEAPONS.fireMine.projectile.explosion!, UP, point, owner, null);
    if (ground && water !== undefined && ground.y < water) bump("drowned");
    const fire = sim.groundFires.length > before ? sim.groundFires[sim.groundFires.length - 1] : null;
    if (fire && owner) {
      const inside = [...owner.blocks.values()].filter((b) => {
        const p = blockWorldPos(b);
        return Math.hypot(p.x - fire.pos.x, p.z - fire.pos.z) < fire.radius && p.y - fire.pos.y < 1.1;
      });
      bump("ownerInside", inside.length);
    }
  }
  for (const f of act.flames ?? []) {
    const ground = groundBelow(sim, spotAt(f), PUDDLE_REACH);
    if (!ground) {
      bump("air");
      continue;
    }
    const known = new Set(sim.groundFires);
    const fire = spawnGroundFire(sim, ground, WEAPONS.flamer.projectile.puddle!, f.by === undefined ? null : bots[f.by].bot);
    if (!fire) bump(water !== undefined && ground.y < water ? "drowned" : "full");
    else bump(known.has(fire) ? "merged" : "lit");
  }
  for (const s of act.fire ?? []) {
    const by = (rank: number | undefined): Bot | null => (rank === undefined ? null : bots[rank].bot);
    spawnProjectile(sim, s.weapon, spotAt(s), s.dir ?? DOWN, { shooter: by(s.by), homing: by(s.homing), inherit: vec3(0, 0, 0) });
  }
  for (const s of act.stun ?? []) stunOrgans(sim, bots[s.by].bot, spotAt(s), s.radius, s.duration);
}

/**
 * Les blocs perdus d'un robot qu'un de ses modules de réparation ferait repousser (à sa portée, contre
 * un bloc du morceau du cockpit) si leur case n'était pas prise (par le décor, un accessoire, un autre
 * robot) : le module en a, mais `regrowable` (une requête, sans effet) n'en trouve aucun dont la case
 * soit libre.
 */
function blockedCells(sim: Simulation, bot: Bot): number {
  if (!bot.cockpit.alive) return 0;
  const core = bot.cockpit.part;
  let blocked = 0;
  for (const m of [...core.blocks].filter((b) => blockDef(b.type).repair)) {
    const center = blockWorldPos(m);
    const radius = blockDef(m.type).repair!.radius;
    const candidates = [...bot.lost.values()].filter((lost) => {
      const at = add(core.rb.translation(), qrot(core.rb.rotation(), lost.local));
      const touches = NEIGHBORS.some(([dx, dy, dz]) => bot.blocks.get(cellKey(lost.x + dx, lost.y + dy, lost.z + dz))?.part === core);
      return touches && distance(at, center) < radius;
    });
    if (candidates.length && !regrowable(sim, bot, center, radius)) blocked += candidates.length;
  }
  return blocked;
}

/** Ce que l'IA d'un robot était avant un pas : son mode, sa destination, son redressement. */
interface Mind {
  mode: AiMode;
  target: Vec3;
  righting: number;
}

/**
 * Ce que l'IA a fait pendant un pas (côté TypeScript, pour le bilan) : les modes où elle est entrée
 * (`mode:reverse`…), les destinations de patrouille tirées (`wander`), les bonds pour se dégager
 * (`unstick` : le gyroscope qui se met en marche sans que le robot soit renversé), les pas passés sur
 * une plateforme (`platform`, montée par une rampe).
 */
function watchAi(sim: Simulation, bots: TsBot[], minds: readonly Mind[], counts: Record<string, number>): void {
  const bump = (what: string): void => {
    counts[what] = (counts[what] ?? 0) + 1;
  };
  for (const [i, { bot }] of bots.entries()) {
    if (bot.controller !== "ai") continue;
    const before = minds[i];
    const ai = bot.ai;
    if (ai.mode !== before.mode) bump(`mode:${ai.mode}`);
    if (ai.mode === "patrol" && ai.target !== before.target) bump("wander");
    if (before.righting <= 0 && bot.righting > 0 && ai.mode !== "flipped") bump("unstick");
    const p = bot.lastPos;
    const aboard = sim.arena.boxes.some((b) => b.kind === "platform" && Math.abs(p.x - b.pos.x) < b.half.x && Math.abs(p.z - b.pos.z) < b.half.z && p.y > b.pos.y + b.half.y);
    if (aboard) bump("platform");
  }
}

/**
 * Ce que les robots ont fait du relief pendant un pas (pour le bilan des grandes arènes) : sur le
 * tablier d'un pont (`deck`), dessous (`underDeck` : une voie surélevée), sur une haute rampe
 * (`tallRamp`), dans un bâtiment (`inBuilding`), au bord de la lave ou dedans (`nearLava`), le centre
 * sous la surface d'une eau profonde (`underwater`), un patin au-dessus de l'eau profonde (`skimming`),
 * un robot volant ou un avion au-dessus du plancher de vol de l'arène (`aboveFloor`).
 */
function watchArena(sim: Simulation, bots: TsBot[], counts: Record<string, number>): void {
  const arena = sim.arena;
  const bump = (what: string): void => {
    counts[what] = (counts[what] ?? 0) + 1;
  };
  const list = obstacles(sim);
  for (const { bot } of bots) {
    if (!bot.cockpit.alive) continue;
    const p = bot.lastPos;
    for (const b of arena.boxes) {
      if (Math.abs(p.x - b.pos.x) > b.half.x || Math.abs(p.z - b.pos.z) > b.half.z) continue;
      if (b.kind === "deck" && Math.min(b.half.x, b.half.z) >= 1) bump(p.y > b.pos.y + b.half.y - 1.5 ? "deck" : "underDeck");
      const along = qrot(b.rot, b.half.x > b.half.z ? vec3(b.half.x, 0, 0) : vec3(0, 0, b.half.z));
      if (b.kind === "ramp" && Math.abs(2 * along.y) >= 2) bump("tallRamp");
    }
    if (list.some((o) => o.walls && p.x > o.rect.minX && p.x < o.rect.maxX && p.z > o.rect.minZ && p.z < o.rect.maxZ)) bump("inBuilding");
    if (lavaAt(arena.lava, p.x, p.z, bot.radius) > -bot.radius) bump("nearLava");
    const burning = (q: Vec3): boolean => lavaAt(arena.lava, q.x, q.z) > 0 && q.y - groundLevel(arena, q.x, q.z) < LAVA_HEIGHT;
    if ([...bot.blocks.values()].some((b) => burning(blockWorldPos(b)))) bump("inLava");
    if (arena.water !== undefined && p.y < arena.water && deepWaterAt(arena, p.x, p.z)) bump("underwater");
    if (bot.supports.some((s) => Number.isFinite(s.contact)) && deepWaterAt(arena, p.x, p.z)) bump("skimming");
    if (bot.profile.mobility !== "ground" && p.y - groundLevel(arena, p.x, p.z) > (arena.bounds.airFloor ?? 0)) bump("aboveFloor");
  }
}

/**
 * Ce que la détection a fait dans un relevé (pour le bilan) : des ennemis repérés (`spotted`) ; des
 * ennemis à moins de 60 m d'un robot vivant de l'équipe (de quoi le voir, même avec une position
 * vieille d'un quart de seconde) et pas repérés (`hidden` : le décor les cachait) ; et les relevés où
 * la navigation vise autre chose que la destination (`corner` : le coin d'un obstacle, le pied ou le
 * haut d'une rampe).
 */
function countSight(starts: readonly Start[], sample: Sample, counts: Record<string, number>): void {
  const DEAD = MODES.indexOf("dead");
  const at = (i: number): Vec3 => vec3(sample.bots[i].ai[9], sample.bots[i].ai[10], sample.bots[i].ai[11]);
  const alive = (i: number): boolean => sample.bots[i].ai[0] !== DEAD;
  for (const [t, team] of TEAMS.entries()) {
    const mask = sample.detected[t];
    for (const [e, enemy] of starts.entries()) {
      if ((enemy.ai ?? enemy.team ?? "red") === team || !alive(e)) continue;
      const spotted = mask >= 0 && Math.floor(mask / 2 ** e) % 2 === 1;
      if (spotted) counts.spotted = (counts.spotted ?? 0) + 1;
      const near = starts.some((o, i) => (o.ai ?? o.team ?? "red") === team && alive(i) && distance(at(i), at(e)) < 60);
      if (!spotted && near) counts.hidden = (counts.hidden ?? 0) + 1;
    }
  }
  for (const [i, s] of starts.entries()) {
    const b = sample.bots[i];
    if (s.ai && alive(i) && (b.nav[0] !== b.ai[1] || b.nav[2] !== b.ai[3])) counts.corner = (counts.corner ?? 0) + 1;
  }
}

/** Des robots (et des accessoires) dans la simulation du TypeScript, chaque seconde ; et les événements qui n'y sont pas portés. */
function runTs(run: Run, seed: number): { samples: Sample[]; unported: string[]; counts: Record<string, number> } {
  const { bots: starts, phases } = run;
  seedRandom(seed);
  const random = vi.mocked(Math.random);
  const drawn = random.mock.calls.length;
  const { sim, bots, props } = tsWorld(run);
  const counts: Record<string, number> = {};
  const unported = new Set<string>();
  // (les blocs détruits, pour reconnaître un bloc qui repousse d'un bloc resté sur un morceau arraché)
  const dead = new Set<Block>();
  // (les projectiles lancés : ceux qui ont perdu des dégâts ont percé un bloc et continué)
  const launched: Projectile[] = [];
  // (l'étape du pas en cours : un bloc réparé pendant celle des projectiles l'est par un tir réparateur)
  let stage = "";
  const measure = sim.measure.bind(sim);
  sim.measure = (name, work): void => {
    stage = name;
    measure(name, work);
  };
  sim.on((e) => {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === "shot") counts[`shot:${e.weapon}`] = (counts[`shot:${e.weapon}`] ?? 0) + 1;
    // (un robot touché par une arme : le vol de vie du rayon réparateur, `hit:repair`)
    if (e.type === "hit" && e.cause) counts[`hit:${e.cause}`] = (counts[`hit:${e.cause}`] ?? 0) + 1;
    if (e.type === "blockRepaired" && stage === "projectiles") counts.beamRepaired = (counts.beamRepaired ?? 0) + 1;
    // (ce que brûle le jet de flamme d'un moteur : un lot de dégâts, un bloc ou du bois qui prend feu)
    if (stage === "jets" && e.type === "damage") counts.jetDamage = (counts.jetDamage ?? 0) + 1;
    if (stage === "jets" && (e.type === "fireStarted" || (e.type === "propFire" && e.prop.burn > 0))) counts.jetFire = (counts.jetFire ?? 0) + 1;
    // (un moteur à bout touché qui prend feu, hors du feu et des jets)
    if (e.type === "fireStarted" && blockDef(e.block.type).thruster && stage !== "jets" && stage !== "feu, fumée, réparation") {
      counts.engineFire = (counts.engineFire ?? 0) + 1;
    }
    if (e.type === "projectileAdded") launched.push(e.projectile);
    // (un capteur qui signale un ennemi, une mine qui bondit, qui se colle)
    if (e.type === "mine") counts[`mine:${e.action}`] = (counts[`mine:${e.action}`] ?? 0) + 1;
    // (le missile anti-aérien qu'une mine lance sur un robot en vol)
    if (e.type === "projectileAdded" && e.projectile.weapon === "flak" && e.projectile.commander === null) counts.aaLaunch = (counts.aaLaunch ?? 0) + 1;
    // (une impulsion qui paralyse un robot piloté)
    if (e.type === "stunned" && e.bot.controller === "player") counts.stunnedPilot = (counts.stunnedPilot ?? 0) + 1;
    // (un mur brisé par les tirs, plutôt qu'éteint au bout de sa durée)
    if (e.type === "barrierRemoved" && e.broken) counts.barrierBroken = (counts.barrierBroken ?? 0) + 1;
    if (e.type === "explosion") counts[`explosion:${e.look}`] = (counts[`explosion:${e.look}`] ?? 0) + 1;
    // (un coup d'arme de contact : sur un robot, un accessoire, le décor ; qui glisse)
    if (e.type === "meleeHit") counts[`melee:${e.surface}`] = (counts[`melee:${e.surface}`] ?? 0) + 1;
    if (e.type === "meleeHit" && e.glance) counts.meleeGlance = (counts.meleeGlance ?? 0) + 1;
    // (une mine télécommandée de l'IA qui saute sous un ennemi : elle éclate là où elle est, sans
    // qu'une explosion l'ait fait sauter avant ; celle-ci la marque ensuite, comme les mines voisines)
    if (e.type === "explosion" && sim.projectiles.some((q) => q.pos === e.point && q.weapon === "remoteMine" && q.shooter?.controller === "ai" && !q.blown)) {
      counts.remoteAi = (counts.remoteAi ?? 0) + 1;
    }
    // (un projectile abattu en vol : une balle, un obus, une explosion)
    if (e.type === "impact" && e.surface === "projectile") counts.intercepted = (counts.intercepted ?? 0) + 1;
    if (e.type === "impact") counts[`impact:${e.surface}`] = (counts[`impact:${e.surface}`] ?? 0) + 1;
    // (un robot détruit, crédité au dernier ennemi qui l'a touché)
    if (e.type === "botKilled" && e.killer) counts.credited = (counts.credited ?? 0) + 1;
    if (e.type === "botKilled") counts[`killed:${e.cause}`] = (counts[`killed:${e.cause}`] ?? 0) + 1;
    if (e.type === "propRemoved") {
      counts[`removed:${e.prop.type}`] = (counts[`removed:${e.prop.type}`] ?? 0) + 1;
      // (brisé par un robot qui passe au travers : ses éclats sont partis devant lui)
      if (e.prop.struck) counts.struck = (counts.struck ?? 0) + 1;
    }
    // (une batterie détruite met le feu à ses voisins)
    if (e.type === "blockDestroyed" && blockDef(e.block.type).battery) counts.battery = (counts.battery ?? 0) + 1;
    if (e.type === "blockDestroyed") dead.add(e.block);
    if (e.type === "blockRebuilt" && !dead.delete(e.block)) counts.rejoined = (counts.rejoined ?? 0) + 1;
    if (!PORTED_EVENTS.has(e.type)) unported.add(e.type);
  });
  const samples: Sample[] = [];
  for (const phase of phases) {
    for (const [i, { input }] of bots.entries()) {
      if (starts[i].still || starts[i].ai) continue;
      input.throttle = phase.throttle;
      input.steer = phase.steer;
      input.brake = phase.brake ?? 0;
      input.boost = phase.boost ?? false;
      input.detonate = phase.detonate ?? false;
      input.trigger = phase.trigger ?? false;
      input.weapon = phase.weapon ?? null;
      input.aim = phase.aim ?? null;
      input.scope = phase.scope ?? false;
      input.flares = phase.flares ?? false;
      const f = phase.flight ?? {};
      input.climb = f.climb ?? 0;
      input.yaw = f.yaw ?? 0;
      input.heading = f.heading ?? 0;
      input.relative = f.relative ?? false;
      input.manual = f.manual ?? false;
      input.power = f.power ?? CRUISE_POWER;
      input.look = f.look ?? null;
    }
    if (phase.act) {
      // (une explosion fait déjà réagir l'IA de ceux qu'elle touche)
      const minds = bots.map(({ bot }) => ({ mode: bot.ai.mode, target: bot.ai.target, righting: bot.righting }));
      actTs(sim, bots, phase.act, counts);
      watchAi(sim, bots, minds, counts);
    }
    for (let s = 0; s < (phase.seconds * 60) / SAMPLE; s++) {
      for (let i = 0; i < SAMPLE; i++) {
        // (une roue montée qui regagne des points : la réparation ; qui en perd pendant un pas sans
        // choc ni explosion : une flaque de feu, le feu des blocs ne touchant pas les roues)
        const before = bots.flatMap(({ bot }) => bot.wheels.map((w) => (w.part ? w.hp : NaN)));
        const blows = (counts.collision ?? 0) + (counts.explosion ?? 0);
        const minds = bots.map(({ bot }) => ({ mode: bot.ai.mode, target: bot.ai.target, righting: bot.righting }));
        sim.step();
        watchAi(sim, bots, minds, counts);
        // (une tête chercheuse qui ne voit plus sa cible ; un verrou dont la cible est cachée)
        if (sim.projectiles.some((p) => p.blind > 0)) counts.blind = (counts.blind ?? 0) + 1;
        // (la fumée sépare deux ennemis à portée de vue ; un robot de l'IA paralysé)
        if (sim.smokes.length) {
          const alive = bots.filter(({ bot }) => bot.cockpit.alive);
          for (const { bot: a } of alive) {
            for (const { bot: b } of alive) {
              if (a.team === "red" && b.team === "blue" && distance(a.lastPos, b.lastPos) < 70 && smokeBlocks(sim, a.lastPos, b.lastPos)) counts.smokeHid = (counts.smokeHid ?? 0) + 1;
            }
          }
        }
        if (bots.some(({ bot }) => bot.ai.mode === "stunned" && bot.controller === "ai")) counts.stunnedAi = (counts.stunnedAi ?? 0) + 1;
        // (les moteurs : un raté, un moteur usé ; l'IA qui allume ses propulseurs ; un robot volant en l'air,
        // un robot sur des pattes qui marche, sur des patins qui flotte)
        for (const { bot } of bots) {
          if (bot.thrusters.some((t) => t.block.alive && t.output === 0)) counts.misfire = (counts.misfire ?? 0) + 1;
          if (bot.thrusters.some((t) => t.block.alive && t.output > 0 && t.output < 1)) counts.worn = (counts.worn ?? 0) + 1;
          if (bot.controller === "ai" && bot.thrusters.some((t) => t.role === "cruise" && t.thrust > 1)) counts.boosted = (counts.boosted ?? 0) + 1;
          if (bot.profile.mobility === "hover" && bot.cockpit.alive && bot.lastPos.y > 2) counts.aloft = (counts.aloft ?? 0) + 1;
          if (bot.supports.some((s) => Number.isFinite(s.contact) && s.force > 0)) counts.supported = (counts.supported ?? 0) + 1;
          // (les armes de contact : une lame qui mord un robot, le décor, en glissant ; une mâchoire qui
          // tient sa proie ; une chaîne de fléau enroulée ; un rotor déséquilibré qui secoue son robot ;
          // un bras, une pointe ou un plateau qui frappe ; un robot soulevé par un flipper ; un organe
          // paralysé localement)
          const bump = (what: string): void => {
            counts[what] = (counts[what] ?? 0) + 1;
          };
          const now = sim.time;
          if (bot.wheels.some((w) => w.part && w.stunnedUntil > now)) bump("stunnedWheel");
          if (bot.turrets.some((t) => t.block.alive && t.block.stunnedUntil > now)) bump("stunnedTurret");
          if (bot.shields.some((g) => g.alive && g.stunnedUntil > now)) bump("stunnedShield");
          if (bot.supports.some((s) => s.block.alive && s.block.stunnedUntil > now)) bump("stunnedSupport");
          if (bot.thrusters.some((t) => t.block.alive && t.block.stunnedUntil > now)) bump("stunnedEngine");
          if (!bot.melee.length) continue;
          if (bot.melee.some((a) => a.bite?.surface === "robot")) bump("biting");
          if (bot.melee.some((a) => a.bite?.surface === "scenery")) bump("bitingScenery");
          if (bot.melee.some((a) => a.bite?.glance)) bump("biteGlance");
          if (bot.melee.some((a) => a.grip)) bump("gripping");
          if (bot.melee.some((a) => a.ball?.wrap)) bump("wrapped");
          if (vibration(bot) > 0) bump("vibrating");
          if (bot.melee.some((a) => a.phase === "strike")) bump("striking");
        }
        if (bots.some(({ bot }) => bot.thrownBy && bot.thrownBy.until > sim.time)) counts.thrown = (counts.thrown ?? 0) + 1;
        if (bots.some(({ bot }) => [...bot.blocks.values()].some((b) => b.stunnedUntil > sim.time) || bot.wheels.some((w) => w.stunnedUntil > sim.time))) {
          counts.organStunned = (counts.organStunned ?? 0) + 1;
        }
        if (bots.some(({ bot }) => bot.turrets.some((t) => t.lockHidden > 0))) counts.lockHidden = (counts.lockHidden ?? 0) + 1;
        if (sim.arena.terrain) watchArena(sim, bots, counts);
        // (un robot de l'IA qui contourne une mine ennemie repérée, `avoidMines` ; pas là où la navigation
        // garde quelque chose d'un pas à l'autre, une grille de passage, un réseau, une ville : la
        // demander ici la changerait, côté TypeScript seulement)
        const statefulNav = !!(sim.arena.navGrid || sim.arena.nav || sim.arena.urban);
        if (!statefulNav && sim.projectiles.some((q) => q.landed && q.spotted.length)) {
          for (const { bot } of bots) {
            if (bot.controller !== "ai" || !bot.cockpit.alive) continue;
            const goal = navigate(sim, bot, bot.lastPos, bot.ai.target);
            if (avoidMines(sim, bot, bot.lastPos, goal) !== goal) counts.detour = (counts.detour ?? 0) + 1;
          }
        }
        const after = bots.flatMap(({ bot }) => bot.wheels.map((w) => w.hp));
        if (before.some((hp, k) => after[k] > hp)) counts.wheelRepaired = (counts.wheelRepaired ?? 0) + 1;
        if (blows === (counts.collision ?? 0) + (counts.explosion ?? 0) && before.some((hp, k) => after[k] < hp)) {
          counts.wheelBurnt = (counts.wheelBurnt ?? 0) + 1;
        }
      }
      samples.push(tsSample(sim, bots, props, counts, random.mock.calls.length - drawn));
    }
  }
  counts.lostLeft = bots.reduce((s, { bot }) => s + bot.lost.size, 0);
  for (const sample of samples) countSight(starts, sample, counts);
  counts.blockedCells = bots.reduce((s, { bot }) => s + blockedCells(sim, bot), 0);
  counts.pierced = launched.filter((p) => p.damage < WEAPONS[p.weapon].projectile.damage).length;
  // (des missiles abattus, détournés par un leurre, perdus : leur cible cachée, ou le leurre éteint)
  counts.blown = launched.filter((p) => p.blown).length;
  counts.decoyed = launched.filter((p) => p.decoy !== null || (p.lost && p.tried.length > 0)).length;
  counts.lost = launched.filter((p) => p.lost).length;
  // (des mines posées, repérées par l'autre équipe, abattues par une balle ou sautées dans une explosion)
  counts.laid = launched.filter((p) => p.landed).length;
  counts.spottedMines = launched.filter((p) => p.landed && p.spotted.length).length;
  counts.blownMines = launched.filter((p) => p.landed && p.blown).length;
  // (des chargeurs vidés, des armes en surchauffe, à un relevé au moins)
  const turrets = samples.flatMap((sample) => sample.bots.flatMap((b) => b.turrets));
  counts.emptied = turrets.filter((t) => t[FIELDS_TURRET.indexOf("coups")] < 1).length;
  counts.overheated = turrets.filter((t) => t[FIELDS_TURRET.indexOf("surchauffe")] === 1).length;
  // (des mines télécommandées qu'un pilote a fait sauter)
  counts.detonated = launched.filter((p) => p.weapon === "remoteMine" && p.shooter?.controller === "player" && p.fuse !== null).length;
  // (une ogive pilotée qu'un nouveau clic a fait sauter : `fuseNow`)
  counts.fused = launched.filter((p) => p.weapon === "warhead" && p.age === Infinity).length;
  sim.dispose();
  return { samples, unported: [...unported], counts };
}

/** Des nombres dans la mémoire du module (de 8 octets, de 4, ou des octets), le temps d'un appel. */
function withArray<T>(values: Float64Array | Float32Array | Uint32Array | Uint8Array, use: (ptr: number) => T): T {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const ptr = probe.alloc(Math.max(1, bytes.length));
  try {
    new Uint8Array(probe.memory.buffer, ptr, bytes.length).set(bytes);
    return use(ptr);
  } finally {
    probe.dealloc(ptr, Math.max(1, bytes.length));
  }
}

/** Les boîtes d'un décor, dans l'ordre, dans un monde de la simulation portée (et ce qu'un tablier dit de plus). */
function rustBoxes(sim: number, boxes: readonly StaticBox[]): void {
  for (const b of boxes) {
    withText(b.kind, (ptr, len) =>
      probe.sim_add_box(sim, ptr, len, b.pos.x, b.pos.y, b.pos.z, b.half.x, b.half.y, b.half.z, b.rot.x, b.rot.y, b.rot.z, b.rot.w, b.round ? 1 : 0));
  }
  for (const [i, b] of boxes.entries()) if (b.underpass || b.approach !== undefined) probe.sim_set_deck(sim, i, b.underpass ? 1 : 0, b.approach ?? NaN);
}

/**
 * L'arène, champ par champ, dans un monde de la simulation portée, comme `loadArena` la met en place
 * (`buildScenery` : ses boîtes, puis son relief) : ses dimensions et ses planchers de vol, son eau
 * (`water` : un autre niveau, pour l'essai), sa lave, si c'est une ville, sa grille de passage (faite
 * par le TypeScript, `navGrid`) et son réseau de passage.
 */
function rustArena(sim: number, arena: ArenaLayout, water: number | undefined): void {
  rustBoxes(sim, arena.boxes);
  const t = arena.terrain;
  if (t) withArray(t.heights, (ptr) => probe.sim_set_terrain(sim, t.size, t.cells, ptr, t.heights.length));
  probe.sim_set_bounds(sim, arena.bounds.half, arena.bounds.roam, arena.bounds.circuit);
  probe.sim_set_floors(sim, arena.bounds.airFloor ?? 0, arena.bounds.hoverFloor ?? 0);
  probe.sim_set_water(sim, water ?? NaN);
  probe.sim_set_deep_water(sim, arena.deepWater ?? NaN);
  for (const shape of arena.lava ?? []) {
    if (shape.kind === "pool") probe.sim_add_lava_pool(sim, shape.x, shape.z, shape.r);
    else withArray(new Float64Array(shape.points.flat()), (ptr) => probe.sim_add_lava_flow(sim, shape.width, ptr, shape.points.length));
  }
  probe.sim_set_urban(sim, arena.urban ? 1 : 0);
  const grid = navGrid(arena);
  if (grid) withArray(grid.open, (ptr) => probe.sim_set_nav_grid(sim, grid.cell, grid.n, grid.min, ptr));
  const nav = arena.nav;
  if (nav) {
    withArray(new Float64Array(nav.points.flat()), (points) =>
      withArray(new Uint32Array(nav.links.flat()), (links) => probe.sim_set_nav_graph(sim, points, nav.points.length, links, nav.links.length)));
  }
}

/**
 * Un monde de la simulation portée, avec le décor du Dépôt (l'arène d'une Simulation neuve), dans le
 * même ordre, remplacé s'il le faut par celui d'une autre arène (comme `loadArena`), et des
 * accessoires ; `propShift` : un décalage du premier accessoire (m, en x).
 */
function rustWorld(run: Pick<Run, "arena" | "props" | "water" | "combat">, seed = 0, propShift = 0): number {
  const sim = probe.sim_new();
  probe.sim_seed(sim, seed);
  probe.sim_set_combat(sim, run.combat ? 1 : 0);
  rustBoxes(sim, ARENAS.depot.boxes);
  const arena = arenaOf(run.arena ?? "depot");
  if (run.arena) probe.sim_clear_scenery(sim);
  rustArena(sim, run.arena ? arena : { ...arena, boxes: [] }, run.water ?? arena.water);
  const arrangement = run.props;
  const spots = arrangement === "arena" ? arena.props : arrangement ?? [];
  for (const [i, s] of spots.entries()) {
    const r = s.rot;
    const h = s.half;
    const x = s.pos.x + (i === 0 ? propShift : 0);
    const prop = withText(s.type, (ptr, len) =>
      probe.sim_add_prop(sim, ptr, len, x, s.pos.y, s.pos.z, r?.x ?? NaN, r?.y ?? NaN, r?.z ?? NaN, r?.w ?? NaN, h?.x ?? NaN, h?.y ?? NaN, h?.z ?? NaN, s.scale ?? NaN));
    if (prop !== i) throw new Error(lastError());
    if (s.building !== undefined) probe.sim_prop_building(sim, i, s.building);
  }
  for (const [i, s] of spots.entries()) for (const on of s.rests ?? []) probe.sim_prop_rest(sim, i, on);
  return sim;
}

function rustBot(sim: number, s: Start, arena: ArenaLayout): number {
  const bot = withText(s.id, (ptr, len) =>
    s.ai
      ? probe.sim_spawn_ai(sim, ptr, len, s.x, startY(s, arena), s.z, s.yaw, TEAMS.indexOf(s.ai))
      : probe.sim_spawn(sim, ptr, len, s.x, startY(s, arena), s.z, s.yaw));
  if (bot < 0) throw new Error(lastError());
  if (!s.ai && s.team) probe.sim_set_team(sim, bot, TEAMS.indexOf(s.team));
  if (s.launch) {
    const v = launchVelocity(s);
    probe.sim_launch(sim, bot, v.x, v.y, v.z);
  }
  return bot;
}

/**
 * Pas entre deux relevés : une seconde (60) ; `SIM_SAMPLE=1` relève chaque pas, pour trouver le premier
 * qui diffère (« seconde » compte alors des pas).
 */
const SAMPLE = Number(process.env.SIM_SAMPLE ?? 60);

/** Taille du tampon des relevés (en nombres de 8 octets). */
const OUT = 48;

/** L'état du monde de la simulation portée. */
function rustSample(sim: number, bots: number[], out: number): Sample {
  const read = (n: number): number[] => Array.from(new Float64Array(probe.memory.buffer, out, n));
  const sample: Sample = { bots: [], debris: [], props: [], groundFires: [], projectiles: [], smokes: [], barriers: [], detected: [], stats: [] };
  for (const bot of bots) {
    const parts: number[][] = [];
    for (let p = 0; p < probe.sim_part_count(sim, bot); p++) {
      probe.sim_part_state(sim, bot, p, out);
      parts.push(read(13));
    }
    const wheels: number[][] = [];
    for (let w = 0; w < probe.sim_wheel_count(sim, bot); w++) {
      probe.sim_wheel_state(sim, bot, w, out);
      wheels.push(read(FIELDS_WHEEL.length));
    }
    const blocks: number[] = [];
    for (let b = 0; b < probe.sim_block_count(sim, bot); b++) {
      probe.sim_block_state(sim, bot, b, out);
      blocks.push(...read(FIELDS_BLOCK.length));
    }
    probe.sim_bot_state(sim, bot, out);
    const state = read(FIELDS_BOT.length);
    probe.sim_ai_state(sim, bot, out);
    const ai = read(FIELDS_AI.length);
    probe.sim_nav_goal(sim, bot, out);
    const nav = read(FIELDS_NAV.length);
    const turrets: number[][] = [];
    for (let t = 0; t < probe.sim_turret_count(sim, bot); t++) {
      probe.sim_turret_state(sim, bot, t, out);
      turrets.push(read(FIELDS_TURRET.length));
    }
    probe.sim_tactics_state(sim, bot, out);
    const tactics = read(FIELDS_TACTICS.length);
    const thrusters: number[][] = [];
    for (let t = 0; t < probe.sim_thruster_count(sim, bot); t++) {
      probe.sim_thruster_state(sim, bot, t, out);
      thrusters.push(read(FIELDS_THRUSTER.length));
    }
    const supports: number[][] = [];
    for (let i = 0; i < probe.sim_support_count(sim, bot); i++) {
      probe.sim_support_state(sim, bot, i, out);
      supports.push(read(FIELDS_SUPPORT.length));
    }
    probe.sim_pilot_state(sim, bot, out);
    const pilot = read(FIELDS_PILOT.length);
    const surfaces: number[][] = [];
    for (let i = 0; i < probe.sim_surface_count(sim, bot); i++) {
      probe.sim_surface_state(sim, bot, i, out);
      surfaces.push(read(FIELDS_SURFACE.length));
    }
    const melee: number[][] = [];
    for (let i = 0; i < probe.sim_melee_count(sim, bot); i++) {
      probe.sim_melee_state(sim, bot, i, out);
      melee.push(read(FIELDS_MELEE.length));
    }
    sample.bots.push({ parts, wheels, blocks, cuts: probe.sim_cut_count(sim, bot), state, ai, nav, turrets, tactics, thrusters, supports, pilot, surfaces, melee });
  }
  for (let i = 0; i < probe.sim_debris_count(sim); i++) {
    probe.sim_debris_state(sim, i, out);
    sample.debris.push(read(13));
  }
  for (let i = 0; i < probe.sim_prop_count(sim); i++) {
    probe.sim_prop_state(sim, i, out);
    sample.props.push(read(FIELDS_PROP.length));
  }
  for (let i = 0; i < probe.sim_ground_fire_count(sim); i++) {
    probe.sim_ground_fire_state(sim, i, out);
    sample.groundFires.push(read(FIELDS_GROUND_FIRE.length));
  }
  for (let i = 0; i < probe.sim_projectile_count(sim); i++) {
    probe.sim_projectile_state(sim, i, out);
    sample.projectiles.push(read(FIELDS_PROJECTILE.length));
  }
  for (let i = 0; i < probe.sim_smoke_count(sim); i++) {
    probe.sim_smoke_state(sim, i, out);
    sample.smokes.push(read(FIELDS_SMOKE.length));
  }
  for (let i = 0; i < probe.sim_barrier_count(sim); i++) {
    probe.sim_barrier_state(sim, i, out);
    sample.barriers.push(read(FIELDS_BARRIER.length));
  }
  sample.detected = TEAMS.map((_, team) => probe.sim_detected(sim, team));
  probe.sim_stats(sim, out);
  sample.stats = read(FIELDS_STATS.length);
  return sample;
}

/** Ce que l'essai fait au début d'une phase, côté Rust ; `shift` : un décalage de chaque point (m, en x). */
function actRust(sim: number, bots: number[], act: Act, shift: number): void {
  const owner = (s: Spot): number => (s.by === undefined ? -1 : bots[s.by]);
  for (const n of act.napalm ?? []) {
    const p = spotAt(n, shift);
    if (withText("fireMine", (ptr, len) => probe.sim_explode(sim, ptr, len, p.x, p.y, p.z, UP.x, UP.y, UP.z, owner(n))) < 0) throw new Error(lastError());
  }
  for (const f of act.flames ?? []) {
    const p = spotAt(f, shift);
    if (withText("flamer", (ptr, len) => probe.sim_puddle(sim, ptr, len, p.x, p.y, p.z, owner(f))) < 0) throw new Error(lastError());
  }
  for (const s of act.fire ?? []) {
    const [p, d] = [spotAt(s, shift), s.dir ?? DOWN];
    const homing = s.homing === undefined ? -1 : bots[s.homing];
    if (withText(s.weapon, (ptr, len) => probe.sim_fire(sim, ptr, len, p.x, p.y, p.z, d.x, d.y, d.z, owner(s), homing)) < 0) throw new Error(lastError());
  }
  for (const s of act.stun ?? []) {
    const p = spotAt(s, shift);
    probe.sim_stun(sim, bots[s.by], p.x, p.y, p.z, s.radius, s.duration);
  }
}

/**
 * Des décalages côté Rust seulement (m, en x) : du départ du premier robot, du premier accessoire, des
 * points des actions de l'essai ; `staged` : le pas fait étape par étape (`sim_stage`, comme pour en
 * mesurer chacune), au lieu d'un coup.
 */
interface Shift {
  bot?: number;
  prop?: number;
  act?: number;
  staged?: boolean;
}

/** Les mêmes robots (et accessoires, et eau, et actions de l'essai) dans la simulation portée. */
function runRust(run: Run, seed: number, shift: Shift = {}): Sample[] {
  const { bots: starts, phases } = run;
  const sim = rustWorld(run, seed, shift.prop ?? 0);
  const out = probe.alloc(OUT * 8);
  try {
    const bots = starts.map((s, i) => rustBot(sim, i === 0 ? { ...s, x: s.x + (shift.bot ?? 0) } : s, arenaOf(run.arena ?? "depot")));
    const samples: Sample[] = [];
    for (const phase of phases) {
      for (const [i, bot] of bots.entries()) {
        if (!starts[i].still && !starts[i].ai) {
          probe.sim_control(sim, bot, phase.throttle, phase.steer, phase.brake ?? 0, phase.boost ? 1 : 0);
          probe.sim_detonate(sim, bot, phase.detonate ? 1 : 0);
          withText(phase.weapon ?? "", (ptr, len) => probe.sim_arm(sim, bot, phase.trigger ? 1 : 0, ptr, len));
          const aim = phase.aim ?? vec3(NaN, NaN, NaN);
          probe.sim_aim(sim, bot, aim.x, aim.y, aim.z, phase.scope ? 1 : 0, phase.flares ? 1 : 0);
          const f = phase.flight ?? {};
          const look = f.look ?? vec3(NaN, NaN, NaN);
          probe.sim_flight(sim, bot, f.climb ?? 0, f.yaw ?? 0, f.heading ?? 0, f.relative ? 1 : 0, f.manual ? 1 : 0, f.power ?? CRUISE_POWER, look.x, look.y, look.z);
        }
      }
      if (phase.act) actRust(sim, bots, phase.act, shift.act ?? 0);
      for (let s = 0; s < (phase.seconds * 60) / SAMPLE; s++) {
        if (shift.staged) {
          for (let i = 0; i < SAMPLE; i++) for (let k = 0; k < probe.sim_stage_count(); k++) probe.sim_stage(sim, k);
        } else probe.sim_step(sim, SAMPLE);
        samples.push(rustSample(sim, bots, out));
      }
    }
    return samples;
  } finally {
    probe.dealloc(out, OUT * 8);
    probe.sim_free(sim);
  }
}

/** Le premier nombre qui diffère d'une liste (au bit près : `Object.is`), nommé ; null s'il n'y en a pas. */
function differ(what: string, fields: readonly string[], a: readonly number[], b: readonly number[]): string | null {
  if (a.length !== b.length) return `${what} : ${a.length} nombres (Rust) contre ${b.length} (TypeScript)`;
  const k = a.findIndex((v, i) => !Object.is(v, b[i]));
  if (k < 0) return null;
  const field = fields[k % fields.length];
  const index = a.length > fields.length ? ` n° ${Math.floor(k / fields.length)}` : "";
  return `${what}${index}, ${field} : ${a[k]} (Rust) contre ${b[k]} (TypeScript)`;
}

/** Le premier nombre qui diffère, pour comprendre ; null s'il n'y en a pas. */
function firstDifference(a: Sample[], b: Sample[]): string | null {
  for (let s = 0; s < Math.max(a.length, b.length); s++) {
    const [x, y] = [a[s], b[s]];
    if (!x || !y) return `seconde ${s + 1} : un relevé manque`;
    const at = `seconde ${s + 1}`;
    for (let r = 0; r < x.bots.length; r++) {
      const [p, q] = [x.bots[r], y.bots[r]];
      if (p.parts.length !== q.parts.length) return `${at}, robot ${r} : ${p.parts.length} morceaux (Rust) contre ${q.parts.length} (TypeScript)`;
      for (let i = 0; i < p.parts.length; i++) {
        const d = differ(`${at}, robot ${r}, morceau ${i}`, FIELDS_BODY, p.parts[i], q.parts[i]);
        if (d) return d;
      }
      if (p.wheels.length !== q.wheels.length) return `${at}, robot ${r} : ${p.wheels.length} roues contre ${q.wheels.length}`;
      for (let w = 0; w < p.wheels.length; w++) {
        const d = differ(`${at}, robot ${r}, roue ${w}`, FIELDS_WHEEL, p.wheels[w], q.wheels[w]);
        if (d) return d;
      }
      const d = differ(`${at}, robot ${r}, bloc`, FIELDS_BLOCK, p.blocks, q.blocks);
      if (d) return d;
      if (p.cuts !== q.cuts) return `${at}, robot ${r} : ${p.cuts} liaisons rompues (Rust) contre ${q.cuts} (TypeScript)`;
      const s = differ(`${at}, robot ${r}`, FIELDS_BOT, p.state, q.state);
      if (s) return s;
      const m = differ(`${at}, robot ${r}, IA`, FIELDS_AI, p.ai, q.ai);
      if (m) return m;
      const n = differ(`${at}, robot ${r}, navigation`, FIELDS_NAV, p.nav, q.nav);
      if (n) return n;
      if (p.turrets.length !== q.turrets.length) return `${at}, robot ${r} : ${p.turrets.length} tourelles (Rust) contre ${q.turrets.length} (TypeScript)`;
      for (let t = 0; t < p.turrets.length; t++) {
        const d = differ(`${at}, robot ${r}, tourelle ${t}`, FIELDS_TURRET, p.turrets[t], q.turrets[t]);
        if (d) return d;
      }
      const k = differ(`${at}, robot ${r}, tactique`, FIELDS_TACTICS, p.tactics, q.tactics);
      if (k) return k;
      if (p.thrusters.length !== q.thrusters.length) return `${at}, robot ${r} : ${p.thrusters.length} moteurs (Rust) contre ${q.thrusters.length} (TypeScript)`;
      for (let t = 0; t < p.thrusters.length; t++) {
        const d = differ(`${at}, robot ${r}, moteur ${t}`, FIELDS_THRUSTER, p.thrusters[t], q.thrusters[t]);
        if (d) return d;
      }
      if (p.supports.length !== q.supports.length) return `${at}, robot ${r} : ${p.supports.length} appuis (Rust) contre ${q.supports.length} (TypeScript)`;
      for (let i = 0; i < p.supports.length; i++) {
        const d = differ(`${at}, robot ${r}, appui ${i}`, FIELDS_SUPPORT, p.supports[i], q.supports[i]);
        if (d) return d;
      }
      const f = differ(`${at}, robot ${r}, pilote`, FIELDS_PILOT, p.pilot, q.pilot);
      if (f) return f;
      if (p.surfaces.length !== q.surfaces.length) return `${at}, robot ${r} : ${p.surfaces.length} surfaces (Rust) contre ${q.surfaces.length} (TypeScript)`;
      for (let i = 0; i < p.surfaces.length; i++) {
        const d = differ(`${at}, robot ${r}, surface ${i}`, FIELDS_SURFACE, p.surfaces[i], q.surfaces[i]);
        if (d) return d;
      }
      if (p.melee.length !== q.melee.length) return `${at}, robot ${r} : ${p.melee.length} armes de contact (Rust) contre ${q.melee.length} (TypeScript)`;
      for (let i = 0; i < p.melee.length; i++) {
        const d = differ(`${at}, robot ${r}, arme de contact ${i}`, FIELDS_MELEE, p.melee[i], q.melee[i]);
        if (d) return d;
      }
    }
    if (x.debris.length !== y.debris.length) return `${at} : ${x.debris.length} débris (Rust) contre ${y.debris.length} (TypeScript)`;
    for (let i = 0; i < x.debris.length; i++) {
      const d = differ(`${at}, débris ${i}`, FIELDS_BODY, x.debris[i], y.debris[i]);
      if (d) return d;
    }
    if (x.props.length !== y.props.length) return `${at} : ${x.props.length} accessoires (Rust) contre ${y.props.length} (TypeScript)`;
    for (let i = 0; i < x.props.length; i++) {
      const d = differ(`${at}, accessoire ${i}`, FIELDS_PROP, x.props[i], y.props[i]);
      if (d) return d;
    }
    if (x.groundFires.length !== y.groundFires.length) return `${at} : ${x.groundFires.length} flaques de feu (Rust) contre ${y.groundFires.length} (TypeScript)`;
    for (let i = 0; i < x.groundFires.length; i++) {
      const d = differ(`${at}, flaque ${i}`, FIELDS_GROUND_FIRE, x.groundFires[i], y.groundFires[i]);
      if (d) return d;
    }
    if (x.projectiles.length !== y.projectiles.length) return `${at} : ${x.projectiles.length} projectiles (Rust) contre ${y.projectiles.length} (TypeScript)`;
    for (let i = 0; i < x.projectiles.length; i++) {
      const d = differ(`${at}, projectile ${i}`, FIELDS_PROJECTILE, x.projectiles[i], y.projectiles[i]);
      if (d) return d;
    }
    if (x.smokes.length !== y.smokes.length) return `${at} : ${x.smokes.length} nuages de fumée (Rust) contre ${y.smokes.length} (TypeScript)`;
    for (let i = 0; i < x.smokes.length; i++) {
      const d = differ(`${at}, nuage ${i}`, FIELDS_SMOKE, x.smokes[i], y.smokes[i]);
      if (d) return d;
    }
    if (x.barriers.length !== y.barriers.length) return `${at} : ${x.barriers.length} murs d'énergie (Rust) contre ${y.barriers.length} (TypeScript)`;
    for (let i = 0; i < x.barriers.length; i++) {
      const d = differ(`${at}, mur ${i}`, FIELDS_BARRIER, x.barriers[i], y.barriers[i]);
      if (d) return d;
    }
    const seen = differ(at, FIELDS_DETECTED, x.detected, y.detected);
    if (seen) return seen;
    const d = differ(at, FIELDS_STATS, x.stats, y.stats);
    if (d) return d;
  }
  return null;
}

/**
 * Le jeu complet (`SIM_ALL=1` : le job `native` de l'intégration continue, et la nuit) ou le jeu courant
 * (`npm test`) : celui-ci ne joue, des familles de parcours les plus longues, que ceux de `CURRENT`,
 * choisis pour couvrir chaque jalon et faire arriver tout ce que leurs bilans demandent (relevé par
 * `SIM_COVERAGE=<fichier>` sur le jeu complet : ce que chaque parcours a fait arriver) ; les
 * comparaisons qui rejouent une longue bataille pour voir un écart d'un micromètre sont raccourcies.
 */
const ALL = !!process.env.SIM_ALL;
const CURRENT = {
  // Un robot de chaque sorte : roues, chenilles, pattes, patins, volant, avion, arme de contact
  patrouille: ["scarab", "ram", "sapper", "tank", "hovercraft", "spider", "drone", "fighter", "borer", "whirlwind"],
  ia: ["chantier, quatre contre quatre", "le pilote d'un char tourne au milieu de l'IA", "une mine incendiaire au milieu de l'IA"],
  // (toutes les armes de l'IA, missiles, leurres, ogive, mines et capteurs, flaques, détours)
  batailles: [
    "tranchées, l'éclaireur et le bélier", "chantier, missiles et ogive", "l'échassier contre le char", "l'IA tire sur le pilote d'un char qui tourne",
    "le traqueur et un char derrière un muret", "le bélier sème ses mines devant un char piloté", "le bélier et un tricycle derrière un baril",
  ],
  spéciales: [
    "dépôt, le mille-pattes et l'IEM", "des mines sous un char piloté", "le traqueur, un char piloté et un fumigène", "un mur d'énergie devant un tricycle piloté",
    "le mécanicien soigne un char piloté", "des nanites et un rayon réparateur sur un mécanicien abîmé",
  ],
  vol: [
    "le dragster piloté pousse contre le mur, des caisses derrière lui", "le dragster de l'IA, un char collé à son arrière", "la fusée de l'IA fuit au boost",
    "un obus sur les turboréacteurs d'un dragster, puis il fonce", "le napalm sous l'aéroglisseur, la mante et l'araignée", "un aéroglisseur piloté paralysé",
    "un drone piloté paralysé en vol", "des robots volants patrouillent et se posent pour recharger", "l'hélice d'un avion de l'IA contre un char arrêté",
    "l'hélice d'un avion de l'IA dans des caisses", "une mine anti-aérienne sous un drone piloté", "forteresse, volants contre volants",
  ],
  contact: [
    // (chaque arme de contact, pilotée)
    ...MELEE.map((id) => `${id} piloté contre ${PREY[id]}`),
    "crusher de l'IA contre trike", "whirlwind de l'IA contre bastion", "drummer de l'IA contre buggy", "duelist piloté contre rocket, de dos",
    "duelist piloté contre le char de l'IA", "des patins, des pattes et un bouclier paralysés", "sawyer contre le mur sud", "le fléau du batteur autour d'un sapin",
    "le marteau et le fouet contre des caisses", "le flipper sous un baril et une caisse", "la lame laser sous l'eau", "tranchées, armes de contact contre moteurs et réparation",
  ],
  arènes: [
    "vallée, un camion piloté traverse le pont", "île, un char piloté entre dans la lave", "île, un char piloté se noie dans la mer", "île, un aéroglisseur piloté glisse sur la mer",
    "ville, trois contre trois dans les rues", "ville, sous la voie express", "canyon, trois contre trois par le viaduc",
  ],
} satisfies Record<string, readonly string[]>;
/**
 * Ce que seuls des parcours longs du jeu complet font arriver : leurs bilans ne le demandent pas au jeu
 * courant (le bombardier de l'IA, des avions au-dessus du plancher de la Vallée, le vol de vie et le
 * mur qui s'éteint de lui-même, un missile qui perd sa cible après un leurre).
 */
const ONLY_ALL: Readonly<Record<keyof typeof CURRENT, readonly string[]>> = {
  patrouille: [],
  ia: [],
  batailles: ["lost"],
  spéciales: ["drained", "barrierGone"],
  vol: ["bombs"],
  contact: [],
  arènes: ["aboveFloor"],
};
/** Les parcours d'une famille à jouer : tous (`SIM_ALL`), ou ceux du jeu courant. */
const chosen = <T extends string>(family: keyof typeof CURRENT, names: readonly T[]): T[] =>
  ALL ? [...names] : names.filter((n) => (CURRENT[family] as readonly string[]).includes(n));
/** Ce qu'un bilan demande et qui n'est arrivé dans aucun parcours joué (sans ce que seul le jeu complet fait arriver). */
const absent = (counters: Record<string, number>, family: keyof typeof CURRENT): string[] =>
  Object.entries(counters).filter(([what, n]) => !(n > 0) && (ALL || !ONLY_ALL[family].includes(what))).map(([what]) => what);
/** Ce que chaque parcours a fait arriver, par famille (`SIM_COVERAGE`) : les clés de ses bilans qui ont augmenté. */
const coverage: Record<string, Record<string, string[]>> = {};
const tally = (counters: readonly (Record<string, number> | Set<string>)[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const c of counters) {
    if (c instanceof Set) for (const x of c) m.set(`arme ${x}`, 1);
    else for (const [k, v] of Object.entries(c)) m.set(k, v);
  }
  return m;
};
/**
 * Joue un parcours, et relève (`SIM_COVERAGE`) ce qu'il a fait arriver dans les bilans `counters` :
 * les compteurs qui ont augmenté, et tout ce qu'il a mis dans un ensemble (les armes qui ont tiré),
 * même si un parcours d'avant l'y avait déjà mis.
 */
const covered = (family: string, counters: readonly (Record<string, number> | Set<string>)[], name: string, run: () => void): void => {
  const sets = counters.filter((c): c is Set<string> => c instanceof Set);
  const kept = sets.map((s) => new Set(s));
  if (process.env.SIM_COVERAGE) for (const s of sets) s.clear();
  const before = tally(counters);
  try {
    run();
  } finally {
    const after = tally(counters);
    if (process.env.SIM_COVERAGE) {
      (coverage[family] ??= {})[name] = [...after].filter(([k, v]) => v > (before.get(k) ?? 0)).map(([k]) => k);
      sets.forEach((s, i) => kept[i].forEach((x) => s.add(x)));
    }
  }
};
/** Une comparaison qui doit voir un écart : sur un parcours raccourci, et un seul, au jeu courant. */
const sensed = (seconds: number): number => (ALL ? seconds : Math.min(seconds, 6));
const few = <T>(list: readonly T[]): T[] => (ALL ? [...list] : list.slice(0, 1));

describe.skipIf(!PROBE)("Simulation portée en Rust : des robots qui roulent et se heurtent, au bit près", () => {
  beforeAll(async () => {
    await initPhysics();
    const { instance } = await WebAssembly.instantiate(readFileSync(PROBE!), {});
    probe = instance.exports as unknown as SimProbe;
  });
  afterAll(() => {
    if (process.env.SIM_COVERAGE) writeFileSync(process.env.SIM_COVERAGE, `${JSON.stringify(coverage, null, 1)}\n`);
  });

  it("le catalogue lu par le Rust donne les mêmes hauteurs de départ", () => {
    for (const p of PRESET_BOTS) {
      const native = withText(p.id, (ptr, len) => probe.sim_ground_height(ptr, len));
      expect(Object.is(native, groundHeight(p.design)), p.id).toBe(true);
    }
  });

  it("les formes de blocs : les mêmes morceaux convexes (sommets, volume), au bit près", () => {
    const cap = 64;
    const out = probe.alloc((3 * cap + 1) * 8);
    for (const shape of SHAPE_IDS) {
      const pieces = shapePieces(shape);
      for (let i = 0; i <= pieces.length; i++) {
        const n = withText(shape, (ptr, len) => probe.sim_shape_piece(ptr, len, i, out, cap));
        if (i === pieces.length) {
          expect(n, `${shape} : un morceau de trop`).toBe(-1);
          continue;
        }
        const native = Array.from(new Float64Array(probe.memory.buffer, out, 3 * n + 1));
        const ts = [...pieces[i].points.flatMap((p) => [p.x, p.y, p.z]), pieces[i].volume];
        expect(native.length, shape).toBe(ts.length);
        expect(native.every((v, k) => Object.is(v, ts[k])), shape).toBe(true);
      }
    }
    probe.dealloc(out, (3 * cap + 1) * 8);
  });

  it("tous les robots préfabriqués sont portés ; un robot inconnu est refusé, pour une raison dite", () => {
    expect(PRESET_BOTS.map((p) => p.id).filter((id) => !PORTED.includes(id))).toEqual([]);
    const sim = probe.sim_new();
    for (const p of PRESET_BOTS) expect(withText(p.id, (ptr, len) => probe.sim_spawn(sim, ptr, len, 0, 3, 0, 0)), p.id).toBeGreaterThanOrEqual(0);
    expect(withText("piano", (ptr, len) => probe.sim_spawn(sim, ptr, len, 0, 3, 0, 0))).toBe(-1);
    expect(lastError()).toMatch(/robot inconnu/);
    probe.sim_free(sim);
  });

  // Roues fixes (Scarabée), une directrice et deux fixes (Tricycle), de petites roues directrices
  // (Buggy), des chenilles (Char), de grosses roues (Camion), des blocs orientés et un poseur de
  // mines tourné vers l'arrière (Bélier), des blocs de forme (Bastion), toutes les tourelles des
  // robots au sol ; sur le plat, sur la rampe, contre un mur
  const cases = GROUND.flatMap((id) => Object.keys(SCENARIOS).map((name) => [id, name] as const));
  it.each(cases)("%s, %s : même chemin, mêmes roues", (id, name) => {
    const { start, phases } = SCENARIOS[name];
    const run = { bots: [{ id, ...start }], phases };
    const ts = runTs(run, 5);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const last = ts.samples[ts.samples.length - 1];
    expect(last.stats[0], "le robot du TypeScript a heurté quelque chose").toBe(0);
    const rust = runRust(run, 5);
    expect(rust.length).toBe(phases.reduce((s, p) => s + p.seconds, 0));
    expect(firstDifference(rust, ts.samples)).toBeNull();
    // (il a bien roulé : à plus d'un mètre de son départ, à un moment ; cinq, sauf contre le mur)
    const far = Math.max(...rust.map((s) => Math.hypot(s.bots[0].parts[0][0] - start.x, s.bots[0].parts[0][2] - start.z)));
    expect(far).toBeGreaterThan(name === "mur" ? 1 : 5);
  });

  // Les robots volants pilotés : décoller, avancer, glisser, monter, pivoter, freiner ; à la caméra
  const flights = HOVER.flatMap((id) => Object.keys(FLIGHTS).map((name) => [id, name] as const));
  // Les avions pilotés : à la souris, au clavier, en manuel
  const sorties = PLANES.flatMap((id) => Object.keys(SORTIES).map((name) => [id, name] as const));
  it.each(sorties)("%s, %s : même vol, mêmes gouvernes", (id, name) => {
    const { start, phases } = SORTIES[name];
    const run = { bots: [{ id, ...start }], phases };
    const ts = runTs(run, 5);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, 5);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    // (il a volé : encore à plus de 4 m au-dessus du sol au bout d'une seconde, et loin de son départ)
    expect(rust[0].bots[0].parts[0][1]).toBeGreaterThan(4);
    const far = Math.max(...rust.map((s) => Math.hypot(s.bots[0].parts[0][0] - start.x, s.bots[0].parts[0][2] - start.z)));
    expect(far).toBeGreaterThan(20);
  });

  it.each(flights)("%s, %s : même vol, mêmes moteurs", (id, name) => {
    const { start, phases } = FLIGHTS[name];
    const run = { bots: [{ id, ...start }], phases };
    const ts = runTs(run, 5);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, 5);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    // (il a bien volé : plus de 2 m au-dessus du sol, à un moment, et à plus de cinq mètres de son départ)
    const high = Math.max(...rust.map((s) => s.bots[0].parts[0][1]));
    expect(high).toBeGreaterThan(2);
    const far = Math.max(...rust.map((s) => Math.hypot(s.bots[0].parts[0][0] - start.x, s.bots[0].parts[0][2] - start.z)));
    expect(far).toBeGreaterThan(5);
  });

  // Ce que les chocs ont fait, sur tous les parcours (côté TypeScript) : chaque sorte de dégât arrive
  const seen = { destroyed: 0, links: 0, split: 0, killed: 0, released: 0, removed: 0, shielded: 0 };
  it.each(Object.keys(CRASHES))("%s : mêmes chocs, mêmes dégâts", (name) => {
    const ts = runTs(CRASHES[name], 11);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const last = ts.samples[ts.samples.length - 1];
    expect(last.stats[0], "un choc au-dessus de SAFE_SPEED").toBeGreaterThan(0);
    const rust = runRust(CRASHES[name], 11);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const [collisions, , destroyed, links, killed, released, removed, , draws] = last.stats;
    seen.destroyed += destroyed;
    seen.links += links;
    seen.killed += killed;
    seen.released += released;
    seen.removed += removed;
    seen.shielded += ts.counts.shieldHit ?? 0;
    seen.split += last.bots.filter((b) => b.parts.length > 1).length;
    if (process.env.SIM_REPORT) {
      const parts = last.bots.map((b) => b.parts.length).join(" et ");
      console.log(
        `${name} : ${collisions} chocs, ${destroyed} blocs détruits, ${links} liaisons rompues, ${parts} morceaux, ${killed} hors de combat,`
          + ` ${released} roues arrachées (${removed} retirées), ${ts.counts.shieldHit ?? 0} coups amortis par un bouclier, ${last.debris.length} débris à la fin, ${draws} tirages`,
      );
    }
  });

  it("les chocs ont détruit des blocs, rompu des liaisons, séparé des morceaux, mis un robot hors de combat, arraché des roues ; un bouclier en a amorti", () => {
    expect(seen.destroyed).toBeGreaterThan(0);
    expect(seen.links).toBeGreaterThan(0);
    expect(seen.split).toBeGreaterThan(0);
    expect(seen.killed).toBeGreaterThan(0);
    expect(seen.released).toBeGreaterThan(0);
    expect(seen.removed).toBeGreaterThan(0);
    expect(seen.shielded).toBeGreaterThan(0);
  });

  // Ce que les accessoires ont fait, sur tous leurs parcours (côté TypeScript)
  const props = { crates: 0, exploded: 0, chain: 0, vented: 0, fires: 0, batteries: 0, woodFires: 0, felled: 0, struck: 0, released: 0 };
  /** Un relevé d'accessoire : `état` (2 : une fuite), `laisse passer` (voir FIELDS_PROP). */
  const STATE = FIELDS_PROP.indexOf("état");
  const YIELDING = FIELDS_PROP.indexOf("laisse passer");
  it.each(Object.keys(PROP_RUNS))("%s : mêmes accessoires, mêmes dégâts", (name) => {
    const ts = runTs(PROP_RUNS[name], 13);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(PROP_RUNS[name], 13);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const last = ts.samples[ts.samples.length - 1];
    const [explosions, removed, released, fires, , woodFires] = last.stats.slice(9);
    const sampled = ts.samples.flatMap((s) => s.props);
    props.crates += ts.counts["removed:crate"] ?? 0;
    props.exploded += explosions;
    props.chain += explosions > 1 ? 1 : 0;
    props.vented += sampled.some((p) => p[STATE] === 2) ? 1 : 0;
    props.fires += fires;
    props.batteries += ts.counts.battery ?? 0;
    props.woodFires += woodFires;
    props.felled += sampled.some((p) => p[YIELDING] > 0) ? 1 : 0;
    props.struck += ts.counts.struck ?? 0;
    props.released += released;
    if (process.env.SIM_REPORT) {
      const [collisions, , destroyed, links, killed] = last.stats;
      console.log(
        `${name} : ${collisions} chocs, ${destroyed} blocs détruits, ${links} liaisons rompues, ${killed} hors de combat ; ${explosions} explosions,`
          + ` ${removed} accessoires retirés, ${released} libérés, ${fires} blocs allumés (${ts.counts.battery ?? 0} batteries détruites),`
          + ` ${woodFires} événements du feu du bois, ${ts.counts.shieldHit ?? 0} coups amortis par un bouclier,`
          + ` ${last.debris.length} débris à la fin, ${last.stats[8]} tirages`,
      );
    }
  });

  it("les accessoires ont cédé : caisses brisées, barils en chaîne, bouteille qui fuit, blocs, batteries et bois en feu, arbre abattu, mur percé, toit tombé", () => {
    // (ce qui n'est arrivé dans aucun parcours)
    expect(Object.entries(props).filter(([, n]) => !(n > 0)).map(([what]) => what)).toEqual([]);
  });

  // Ce que la réparation et les flaques de feu ont fait, sur tous leurs parcours (côté TypeScript)
  const mended = {
    rebuilt: 0, rejoined: 0, repaired: 0, wheels: 0, lostLeft: 0, blockedCells: 0, puddles: 0, puddlesOut: 0, ownerInside: 0,
    merged: 0, air: 0, full: 0, drowned: 0, woodLit: 0, wheelsBurnt: 0, killed: 0,
  };
  const BURN = FIELDS_PROP.indexOf("feu");
  const repairCase = (name: string, run: Run, seed: number): void => {
    const ts = runTs(run, seed);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, seed);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const last = ts.samples[ts.samples.length - 1];
    const c = ts.counts;
    mended.rebuilt += c.blockRebuilt ?? 0;
    mended.rejoined += c.rejoined ?? 0;
    mended.repaired += c.blockRepaired ?? 0;
    mended.wheels += c.wheelRepaired ?? 0;
    mended.lostLeft += (c.blockRebuilt ?? 0) > 0 ? c.lostLeft : 0;
    mended.blockedCells += c.blockedCells;
    mended.puddles += c.groundFireAdded ?? 0;
    mended.puddlesOut += c.groundFireRemoved ?? 0;
    mended.ownerInside += c.ownerInside ?? 0;
    mended.merged += c.merged ?? 0;
    mended.air += c.air ?? 0;
    mended.full += c.full ?? 0;
    mended.drowned += c.drowned ?? 0;
    mended.woodLit += ts.samples.some((s) => s.props.some((p) => p[BURN] > 0)) ? 1 : 0;
    mended.killed += c.botKilled ?? 0;
    mended.wheelsBurnt += c.wheelBurnt ?? 0;
    if (process.env.SIM_REPORT) {
      const [collisions, , destroyed, links, killed] = last.stats;
      console.log(
        `${name} : ${collisions} chocs, ${destroyed} blocs détruits, ${links} liaisons rompues, ${killed} hors de combat, ${c.fireStarted ?? 0} blocs allumés ;`
          + ` ${c.blockRebuilt ?? 0} blocs repoussés (dont ${c.rejoined ?? 0} revenus d'un morceau détaché), ${c.blockRepaired ?? 0} réparations de blocs,`
          + ` ${c.wheelRepaired ?? 0} de roues, ${c.lostLeft} blocs encore perdus (${c.blockedCells} à portée, la case prise) ;`
          + ` ${c.groundFireAdded ?? 0} flaques allumées (${c.merged ?? 0} ravivées,`
          + ` ${c.full ?? 0} refusées faute de place, ${c.drowned ?? 0} sous l'eau, ${c.air ?? 0} sans sol), ${c.ownerInside ?? 0} blocs dans la flaque de`
          + ` leur auteur ; ${last.debris.length} débris à la fin, ${last.stats[8]} tirages`,
      );
    }
  };
  it.each(Object.keys(REPAIRS))("%s : mêmes chocs, mêmes réparations", (name) => repairCase(name, REPAIRS[name], 11));
  it.each(Object.keys(FIRES))("%s : mêmes flaques, mêmes feux, mêmes réparations", (name) => repairCase(name, FIRES[name], 11));

  it("la réparation a refait des blocs et des roues, fait repousser des blocs (dont des blocs restés sur un morceau détaché), en a laissé ; les flaques ont brûlé, se sont éteintes, ravivées, refusées", () => {
    // (ce qui n'est arrivé dans aucun parcours)
    expect(Object.entries(mended).filter(([, n]) => !(n > 0)).map(([what]) => what)).toEqual([]);
  });

  it("la comparaison voit un écart d'un micromètre sur un robot qui se répare, ou sur une flaque", () => {
    const repair = REPAIRS["mécanicien contre le mur, puis la réparation"];
    const ts = runTs(repair, 11);
    expect(firstDifference(runRust(repair, 11), ts.samples)).toBeNull();
    expect(firstDifference(runRust(repair, 11, { bot: 1e-6 }), ts.samples)).not.toBeNull();
    for (const name of ["napalm près du mécanicien", "jets de flammes sous des robots, contre des caisses, en nombre"]) {
      const run = FIRES[name];
      const fire = runTs(run, 11);
      expect(firstDifference(runRust(run, 11), fire.samples), name).toBeNull();
      expect(firstDifference(runRust(run, 11, { act: 1e-6 }), fire.samples), name).not.toBeNull();
    }
  });

  it("la comparaison voit un écart d'un micromètre sur un accessoire ou sur le robot qui le heurte", () => {
    for (const name of ["char contre un baril près d'un sapin", "bélier contre un sapin"]) {
      const run = PROP_RUNS[name];
      const ts = runTs(run, 13);
      expect(firstDifference(runRust(run, 13), ts.samples), name).toBeNull();
      expect(firstDifference(runRust(run, 13, { bot: 1e-6 }), ts.samples), name).not.toBeNull();
      expect(firstDifference(runRust(run, 13, { prop: 1e-6 }), ts.samples), name).not.toBeNull();
    }
  });

  it("la comparaison voit un écart d'un micromètre (le départ du robot décalé, côté Rust seulement)", () => {
    const run = CRASHES["mille-pattes contre le mur"];
    const ts = runTs(run, 11);
    expect(firstDifference(runRust(run, 11), ts.samples)).toBeNull();
    expect(firstDifference(runRust(run, 11, { bot: 1e-6 }), ts.samples)).not.toBeNull();
    // (et une autre graine : d'autres débris)
    expect(firstDifference(runRust(run, 12), ts.samples)).not.toBeNull();
  });

  // L'IA qui conduit, hors combat : chacun des robots portés patrouille seul au Dépôt (sans ses
  // accessoires), puis des équipes dans chacune des petites arènes
  const minds = {
    wander: 0, corner: 0, platform: 0, reverse: 0, unstick: 0, flee: 0, charge: 0, flipped: 0, spotted: 0, hidden: 0, collisions: 0, explosions: 0,
  };
  const aiCase = (name: string, run: Run, seed: number): void => {
    const ts = runTs(run, seed);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, seed);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const c = ts.counts;
    const last = ts.samples[ts.samples.length - 1];
    minds.wander += c.wander ?? 0;
    minds.corner += c.corner ?? 0;
    minds.platform += c.platform ?? 0;
    minds.reverse += c["mode:reverse"] ?? 0;
    minds.unstick += c.unstick ?? 0;
    minds.flee += c["mode:flee"] ?? 0;
    minds.charge += c["mode:charge"] ?? 0;
    minds.flipped += c["mode:flipped"] ?? 0;
    minds.spotted += c.spotted ?? 0;
    minds.hidden += c.hidden ?? 0;
    minds.collisions += last.stats[0];
    minds.explosions += last.stats[9];
    if (process.env.SIM_REPORT) {
      const modes = Object.entries(c).filter(([k]) => k.startsWith("mode:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      console.log(
        `${name} : ${c.wander ?? 0} destinations de patrouille, ${c.corner ?? 0} relevés vers un coin ou une rampe, ${c.platform ?? 0} pas sur une plateforme,`
          + ` ${c.unstick ?? 0} bonds pour se dégager ; modes : ${modes || "aucun changement"} ; ${c.spotted ?? 0} ennemis repérés, ${c.hidden ?? 0} cachés ;`
          + ` ${last.stats[0]} chocs, ${last.stats[2]} blocs détruits, ${last.stats[9]} explosions ; ${last.stats[8]} tirages`,
      );
    }
  };
  it.each(chosen("patrouille", PORTED))("%s patrouille seul au Dépôt : mêmes destinations, même chemin", (id) => {
    covered("patrouille", [minds], id, () => aiCase(`${id} seul`, { bots: [{ id, x: 0, z: -27, yaw: 0, ai: "red" }], phases: [{ seconds: 25, throttle: 0, steer: 0 }] }, 7));
  });
  // (une minute de huit robots : plus d'une minute de calcul sur une machine chargée)
  it.each(chosen("ia", Object.keys(AI_RUNS)))("%s : même IA, même détection, mêmes chocs", { timeout: 300_000 }, (name) => covered("ia", [minds], name, () => aiCase(name, AI_RUNS[name], 7)));

  it("l'IA a patrouillé, contourné, pris les rampes, reculé, bondi, fui, foncé ; les équipes se sont repérées et cachées", () => {
    // (ce qui n'est arrivé dans aucun parcours)
    expect(absent(minds, "ia")).toEqual([]);
  });

  it("la comparaison voit un écart d'un micromètre sur un robot de l'IA, ou une autre graine", { timeout: 300_000 }, () => {
    const run: Run = { ...AI_RUNS["dépôt, quatre contre quatre"], phases: [{ seconds: sensed(20), throttle: 0, steer: 0 }] };
    const ts = runTs(run, 7);
    expect(firstDifference(runRust(run, 7), ts.samples)).toBeNull();
    expect(firstDifference(runRust(run, 7, { bot: 1e-6 }), ts.samples)).not.toBeNull();
    // (une autre graine : d'autres destinations)
    expect(firstDifference(runRust(run, 8), ts.samples)).not.toBeNull();
  });

  it("au combat, l'IA manie les armes de tous les robots portés", () => {
    const sim = probe.sim_new();
    probe.sim_set_combat(sim, 1);
    for (const id of PORTED) {
      const bot = withText(id, (ptr, len) => probe.sim_spawn_ai(sim, ptr, len, 0, 3, 0, 0, 0));
      if (COMBAT.includes(id)) expect(bot, id).toBeGreaterThanOrEqual(0);
      else {
        expect(bot, id).toBe(-1);
        expect(lastError(), id).toMatch(/pas encore porté \(l'arme .* au combat\)/);
      }
    }
    // (piloté, sans point visé ni gâchette, il ne tire pas : il est accepté)
    expect(withText("crane", (ptr, len) => probe.sim_spawn(sim, ptr, len, 0, 3, 0, 0))).toBeGreaterThanOrEqual(0);
    // (une arme inconnue, un tireur inconnu : refusés)
    expect(withText("piano", (ptr, len) => probe.sim_fire(sim, ptr, len, 0, 1, 0, 0, -1, 0, -1, -1))).toBe(-1);
    expect(withText("smoke", (ptr, len) => probe.sim_fire(sim, ptr, len, 0, 1, 0, 0, -1, 0, 99, -1))).toBe(-1);
    probe.sim_free(sim);
  });

  // Ce que les batailles ont fait, sur tous leurs parcours (côté TypeScript)
  const fights = {
    shots: 0, hits: 0, destroyed: 0, killed: 0, credited: 0, pierced: 0, shells: 0, lit: 0, emptied: 0, overheated: 0, engage: 0, cover: 0, charge: 0, flee: 0,
    flares: 0, blown: 0, decoyed: 0, lost: 0, blind: 0, lockHidden: 0, laid: 0, mineBlasts: 0, spottedMines: 0, blownMines: 0, detours: 0, pings: 0,
    puddles: 0,
  };
  const weapons = new Set<string>();
  const battleCase = (name: string, run: Run, seed: number): void => {
    const ts = runTs(run, seed);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, seed);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const c = ts.counts;
    fights.shots += c.shot ?? 0;
    fights.hits += c.hit ?? 0;
    fights.destroyed += c.blockDestroyed ?? 0;
    fights.killed += c.botKilled ?? 0;
    fights.credited += c.credited ?? 0;
    fights.pierced += c.pierced ?? 0;
    fights.shells += c.explosion ?? 0;
    fights.lit += c.fireStarted ?? 0;
    fights.emptied += c.emptied ?? 0;
    fights.overheated += c.overheated ?? 0;
    fights.engage += c["mode:engage"] ?? 0;
    fights.cover += c["mode:cover"] ?? 0;
    fights.charge += c["mode:charge"] ?? 0;
    fights.flee += c["mode:flee"] ?? 0;
    fights.flares += c["shot:flare"] ?? 0;
    fights.blown += c.blown ?? 0;
    fights.decoyed += c.decoyed ?? 0;
    fights.lost += c.lost ?? 0;
    fights.blind += c.blind ?? 0;
    fights.lockHidden += c.lockHidden ?? 0;
    fights.laid += c.laid ?? 0;
    fights.mineBlasts += c["explosion:mine"] ?? 0;
    fights.spottedMines += c.spottedMines ?? 0;
    fights.blownMines += c.blownMines ?? 0;
    fights.detours += c.detour ?? 0;
    fights.pings += c["mine:ping"] ?? 0;
    fights.puddles += c.groundFireAdded ?? 0;
    for (const key of Object.keys(c)) if (key.startsWith("shot:")) weapons.add(key.slice(5));
    if (process.env.SIM_REPORT) {
      const shots = Object.entries(c).filter(([k]) => k.startsWith("shot:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      const modes = Object.entries(c).filter(([k]) => k.startsWith("mode:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      const last = ts.samples[ts.samples.length - 1];
      console.log(
        `${name} : tirs ${shots || "aucun"} ; ${c.hit ?? 0} robots touchés, ${c.blockDestroyed ?? 0} blocs détruits, ${c.pierced ?? 0} tirs qui ont percé,`
          + ` ${c.explosion ?? 0} explosions, ${c.fireStarted ?? 0} blocs allumés, ${c.botKilled ?? 0} robots détruits (${c.credited ?? 0} crédités) ;`
          + ` ${c.blown} projectiles abattus (${c.intercepted ?? 0} coups de balle sur un projectile), ${c.decoyed} détournés par un leurre, ${c.lost} perdus,`
          + ` ${c.blind ?? 0} pas où une tête chercheuse ne voit pas sa cible, ${c.lockHidden ?? 0} où un verrou est caché ;`
          + ` impacts : ${Object.entries(c).filter(([k]) => k.startsWith("impact:")).map(([k, n]) => `${k.slice(7)} ${n}`).join(", ")} ;`
          + ` ${c.laid} mines posées (${c["explosion:mine"] ?? 0} explosions de mines, ${c.spottedMines} repérées, ${c.blownMines} sautées avant d'être déclenchées,`
          + ` ${c.detour ?? 0} relevés de détour, ${c["mine:ping"] ?? 0} signaux de capteurs), ${c.groundFireAdded ?? 0} flaques de feu ;`
          + ` modes : ${modes || "aucun changement"} ; ${c.emptied} relevés d'un chargeur vide, ${c.overheated} d'une arme en surchauffe ;`
          + ` ${last.stats[0]} chocs ; ${last.stats[8]} tirages`,
      );
    }
  };
  it.each(chosen("batailles", Object.keys(BATTLES)))("%s : mêmes tirs, mêmes coups, même tactique", { timeout: 300_000 }, (name) =>
    covered("batailles", [fights, weapons], name, () => battleCase(name, BATTLES[name], 7)));

  it("les batailles : toutes les armes ont tiré, touché, détruit, percé, allumé ; des robots ont engagé, chargé, fui, se sont mis à couvert, ont vidé leur chargeur, surchauffé ; des missiles ont été abattus, détournés, perdus de vue ; des mines posées, repérées, contournées, abattues", () => {
    // (ce qui n'est arrivé dans aucune bataille, et les armes qui n'ont pas tiré)
    expect(absent(fights, "batailles")).toEqual([]);
    const all = ["rifle", "cannon", "sniper", "laser", "rail", "shotgun", "plasma", "missile", "rockets", "lockon", "warhead", "flare", "flamer", "mine", "sensorMine"];
    expect(all.filter((w) => !weapons.has(w) && (ALL || !ONLY_ALL.batailles.includes(`arme ${w}`)))).toEqual([]);
  });

  // Ce que les armes spéciales ont fait, sur tous leurs parcours (côté TypeScript)
  const specials = {
    empBursts: 0, stunned: 0, stunnedAi: 0, stunnedPilot: 0, smokes: 0, smokeGone: 0, smokeHid: 0, bounces: 0, sticks: 0, detonated: 0, remoteAi: 0,
    support: 0, beamRepaired: 0, drained: 0, rebuilt: 0, barriers: 0, barrierHits: 0, barrierBroken: 0, barrierGone: 0,
  };
  const specialCase = (name: string, run: Run, seed: number): void => {
    const ts = runTs(run, seed);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, seed);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const c = ts.counts;
    specials.empBursts += c.empBurst ?? 0;
    specials.stunned += c.stunned ?? 0;
    specials.stunnedAi += c.stunnedAi ?? 0;
    specials.stunnedPilot += c.stunnedPilot ?? 0;
    specials.smokes += c.smokeAdded ?? 0;
    specials.smokeGone += c.smokeRemoved ?? 0;
    specials.smokeHid += c.smokeHid ?? 0;
    specials.bounces += c["mine:bounce"] ?? 0;
    specials.sticks += c["mine:stick"] ?? 0;
    specials.detonated += c.detonated ?? 0;
    specials.remoteAi += c.remoteAi ?? 0;
    specials.support += c["mode:support"] ?? 0;
    specials.beamRepaired += c.beamRepaired ?? 0;
    specials.drained += c["hit:repair"] ?? 0;
    specials.rebuilt += c.blockRebuilt ?? 0;
    specials.barriers += c.barrierAdded ?? 0;
    specials.barrierHits += c.barrierHit ?? 0;
    specials.barrierBroken += c.barrierBroken ?? 0;
    specials.barrierGone += (c.barrierRemoved ?? 0) - (c.barrierBroken ?? 0);
    if (process.env.SIM_REPORT) {
      const shots = Object.entries(c).filter(([k]) => k.startsWith("shot:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      const modes = Object.entries(c).filter(([k]) => k.startsWith("mode:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      const last = ts.samples[ts.samples.length - 1];
      console.log(
        `${name} : tirs ${shots || "aucun"} ; ${c.hit ?? 0} robots touchés, ${c.blockDestroyed ?? 0} blocs détruits, ${c.botKilled ?? 0} robots détruits ;`
          + ` ${c.empBurst ?? 0} impulsions, ${c.stunned ?? 0} paralysies (${c.stunnedPilot ?? 0} d'un pilote, ${c.stunnedAi ?? 0} pas d'une IA paralysée) ;`
          + ` ${c.smokeAdded ?? 0} nuages (${c.smokeRemoved ?? 0} dissipés, ${c.smokeHid ?? 0} pas où la fumée sépare deux ennemis) ;`
          + ` mines : ${c.laid} posées, ${c["mine:bounce"] ?? 0} bonds, ${c["mine:stick"] ?? 0} collées, ${c.detonated} télécommandées sautées par un pilote,`
          + ` ${c.remoteAi ?? 0} par l'IA ; ${c["mode:support"] ?? 0} soutiens, ${c.beamRepaired ?? 0} blocs réparés par un tir, ${c["hit:repair"] ?? 0} vols de vie,`
          + ` ${c.blockRebuilt ?? 0} blocs repoussés ; ${c.barrierAdded ?? 0} murs (${c.barrierHit ?? 0} coups, ${c.barrierBroken ?? 0} brisés) ;`
          + ` modes : ${modes || "aucun changement"} ; ${last.stats[0]} chocs ; ${last.stats[8]} tirages`,
      );
    }
  };
  it.each(chosen("spéciales", Object.keys(SPECIALS)))("%s : mêmes paralysies, mêmes fumées, mêmes mines, mêmes soins, mêmes murs", { timeout: 300_000 }, (name) =>
    covered("spéciales", [specials], name, () => specialCase(name, SPECIALS[name], 7)));

  it("les armes spéciales : impulsions et paralysies (de l'IA, d'un pilote), fumées qui cachent et se dissipent, mines qui bondissent, se collent, sautent sur ordre ; soutien, réparations et vols de vie, blocs repoussés ; murs déployés, touchés, brisés, éteints", () => {
    // (ce qui n'est arrivé dans aucun parcours)
    expect(absent(specials, "spéciales")).toEqual([]);
  });

  it("la comparaison voit un écart d'un micromètre avec les armes spéciales, ou une autre graine", { timeout: 300_000 }, () => {
    for (const name of few(["dépôt, le mille-pattes et l'IEM", "chantier, le mécanicien et le gardien"])) {
      const run: Run = { ...SPECIALS[name], phases: [{ seconds: sensed(30), throttle: 0, steer: 0 }] };
      const ts = runTs(run, 7);
      expect(firstDifference(runRust(run, 7), ts.samples), name).toBeNull();
      expect(firstDifference(runRust(run, 7, { bot: 1e-6 }), ts.samples), name).not.toBeNull();
      expect(firstDifference(runRust(run, 8), ts.samples), name).not.toBeNull();
      // (le pas fait étape par étape, comme pour mesurer chacune : le même monde)
      expect(firstDifference(runRust(run, 7, { staged: true }), ts.samples), name).toBeNull();
    }
    // (les projectiles que l'essai fait partir, décalés d'un micromètre)
    for (const name of few(["des mines sous un char piloté", "des nanites et un rayon réparateur sur un mécanicien abîmé", "des fumigènes entre deux équipes"])) {
      const run = SPECIALS[name];
      const ts = runTs(run, 7);
      expect(firstDifference(runRust(run, 7), ts.samples), name).toBeNull();
      expect(firstDifference(runRust(run, 7, { act: 1e-6 }), ts.samples), name).not.toBeNull();
    }
  });

  it("la comparaison voit un écart d'un micromètre dans une bataille, ou une autre graine", { timeout: 300_000 }, () => {
    for (const name of few(["dépôt, trois contre trois", "dépôt, missiles contre leurres"])) {
      const run: Run = { ...BATTLES[name], phases: [{ seconds: sensed(30), throttle: 0, steer: 0 }] };
      const ts = runTs(run, 7);
      expect(firstDifference(runRust(run, 7), ts.samples), name).toBeNull();
      expect(firstDifference(runRust(run, 7, { bot: 1e-6 }), ts.samples), name).not.toBeNull();
      // (une autre graine : d'autres erreurs de visée, d'autres dispersions, d'autres leurres)
      expect(firstDifference(runRust(run, 8), ts.samples), name).not.toBeNull();
    }
  });

  // Ce que les moteurs, les appuis et les robots volants ont fait, sur tous leurs parcours (côté TypeScript)
  const flown = {
    jetDamage: 0, jetFire: 0, misfire: 0, worn: 0, engineFire: 0, boosted: 0, aloft: 0, supported: 0, landing: 0, falling: 0, fleeing: 0, stunned: 0,
    shots: 0, hits: 0, killed: 0, engage: 0, cover: 0, gliding: 0, bombs: 0, flak: 0, aaLaunch: 0, propellerHits: 0,
  };
  const flightCase = (name: string, run: Run, seed: number): void => {
    const ts = runTs(run, seed);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, seed);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const c = ts.counts;
    flown.jetDamage += c.jetDamage ?? 0;
    flown.jetFire += c.jetFire ?? 0;
    flown.misfire += c.misfire ?? 0;
    flown.worn += c.worn ?? 0;
    flown.engineFire += c.engineFire ?? 0;
    flown.boosted += c.boosted ?? 0;
    flown.aloft += c.aloft ?? 0;
    flown.supported += c.supported ?? 0;
    flown.landing += c["mode:landing"] ?? 0;
    flown.falling += c["mode:falling"] ?? 0;
    flown.fleeing += c["mode:flee"] ?? 0;
    flown.stunned += c.stunned ?? 0;
    flown.shots += c.shot ?? 0;
    flown.hits += c.hit ?? 0;
    flown.killed += c.botKilled ?? 0;
    flown.engage += c["mode:engage"] ?? 0;
    flown.cover += c["mode:cover"] ?? 0;
    flown.gliding += c["mode:gliding"] ?? 0;
    flown.bombs += c["shot:bombs"] ?? 0;
    flown.flak += c["explosion:flak"] ?? 0;
    flown.aaLaunch += c.aaLaunch ?? 0;
    flown.propellerHits += c.meleeHit ?? 0;
    if (process.env.SIM_REPORT) {
      const shots = Object.entries(c).filter(([k]) => k.startsWith("shot:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      const modes = Object.entries(c).filter(([k]) => k.startsWith("mode:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      const last = ts.samples[ts.samples.length - 1];
      console.log(
        `${name} : jets ${c.jetDamage ?? 0} lots de dégâts, ${c.jetFire ?? 0} feux allumés ; ${c.misfire ?? 0} pas d'un raté, ${c.worn ?? 0} d'un moteur usé,`
          + ` ${c.engineFire ?? 0} moteurs en feu ; ${c.boosted ?? 0} pas où l'IA allume ses propulseurs ; ${c.aloft ?? 0} pas en vol,`
          + ` ${c.supported ?? 0} sur des appuis ; tirs ${shots || "aucun"} ; ${c.hit ?? 0} robots touchés, ${c.blockDestroyed ?? 0} blocs détruits,`
          + ` ${c.botKilled ?? 0} robots détruits, ${c.stunned ?? 0} paralysies ; modes : ${modes || "aucun changement"} ; ${last.stats[0]} chocs ; ${last.stats[8]} tirages`,
      );
    }
  };
  it.each(chosen("vol", Object.keys(ENGINES)))("%s : mêmes moteurs, mêmes appuis, mêmes jets", { timeout: 300_000 }, (name) =>
    covered("vol", [flown], name, () => flightCase(name, ENGINES[name], 7)));
  it.each(chosen("vol", Object.keys(FLYERS)))("%s : même vol, mêmes moteurs, mêmes tirs", { timeout: 300_000 }, (name) =>
    covered("vol", [flown], name, () => flightCase(name, FLYERS[name], 7)));

  it("les moteurs, les appuis et le vol : jets qui brûlent et allument, moteurs usés, ratés, en feu ; propulseurs de l'IA ; appuis, vol, atterrissages, chutes, fuites, paralysies ; tirs, coups, couverts", () => {
    if (process.env.SIM_REPORT) console.log(`les moteurs, les appuis et le vol, sur tous leurs parcours : ${JSON.stringify(flown)}`);
    // (ce qui n'est arrivé dans aucun parcours)
    expect(absent(flown, "vol")).toEqual([]);
  });

  it("la comparaison voit un écart d'un micromètre sur un robot à moteurs, volant ou avion, ou une autre graine", { timeout: 300_000 }, () => {
    const runs: [string, Run][] = [
      ["dépôt, moteurs et appuis, trois contre trois", ENGINES["dépôt, moteurs et appuis, trois contre trois"]],
      ["des robots volants patrouillent et se posent pour recharger", FLYERS["des robots volants patrouillent et se posent pour recharger"]],
      ["dépôt, des avions contre des robots au sol", FLYERS["dépôt, des avions contre des robots au sol"]],
    ];
    for (const [name, base] of few(runs)) {
      const run: Run = { ...base, phases: [{ seconds: sensed(20), throttle: 0, steer: 0 }] };
      const ts = runTs(run, 7);
      expect(firstDifference(runRust(run, 7), ts.samples), name).toBeNull();
      expect(firstDifference(runRust(run, 7, { bot: 1e-6 }), ts.samples), name).not.toBeNull();
      // (une autre graine : d'autres rafales, d'autres ratés, d'autres altitudes de patrouille)
      expect(firstDifference(runRust(run, 8), ts.samples), name).not.toBeNull();
      // (le pas fait étape par étape, comme pour mesurer chacune : le même monde)
      expect(firstDifference(runRust(run, 7, { staged: true }), ts.samples), name).toBeNull();
    }
  });

  // Ce que les armes de contact ont fait, sur tous leurs parcours (côté TypeScript)
  const struck = {
    robotHits: 0, propHits: 0, sceneryHits: 0, glances: 0, armedHits: 0, destroyed: 0, wheels: 0, killed: 0, fires: 0, stuns: 0, stunnedSteps: 0,
    biting: 0, bitingScenery: 0, gripping: 0, wrapped: 0, vibrating: 0, striking: 0, thrown: 0, charge: 0, links: 0,
    stunnedWheel: 0, stunnedTurret: 0, stunnedShield: 0, stunnedSupport: 0, stunnedEngine: 0,
  };
  const meleeCase = (name: string, run: Run, seed: number): void => {
    const ts = runTs(run, seed);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, seed);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const c = ts.counts;
    const last = ts.samples[ts.samples.length - 1];
    struck.robotHits += c["melee:robot"] ?? 0;
    struck.propHits += c["melee:prop"] ?? 0;
    struck.sceneryHits += c["melee:scenery"] ?? 0;
    struck.glances += c.meleeGlance ?? 0;
    struck.armedHits += c.hit ?? 0;
    struck.destroyed += c.blockDestroyed ?? 0;
    struck.wheels += last.stats[5];
    struck.killed += c.botKilled ?? 0;
    struck.fires += c.fireStarted ?? 0;
    struck.stuns += c.organsStunned ?? 0;
    struck.stunnedSteps += c.organStunned ?? 0;
    struck.biting += c.biting ?? 0;
    struck.bitingScenery += c.bitingScenery ?? 0;
    struck.gripping += c.gripping ?? 0;
    struck.wrapped += c.wrapped ?? 0;
    struck.vibrating += c.vibrating ?? 0;
    struck.striking += c.striking ?? 0;
    struck.thrown += c.thrown ?? 0;
    struck.charge += c["mode:charge"] ?? 0;
    struck.links += c.linkBroken ?? 0;
    for (const organ of ["stunnedWheel", "stunnedTurret", "stunnedShield", "stunnedSupport", "stunnedEngine"] as const) struck[organ] += c[organ] ?? 0;
    if (process.env.SIM_REPORT) {
      const modes = Object.entries(c).filter(([k]) => k.startsWith("mode:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      console.log(
        `${name} : coups ${c["melee:robot"] ?? 0} sur un robot, ${c["melee:prop"] ?? 0} sur un accessoire, ${c["melee:scenery"] ?? 0} sur le décor (${c.meleeGlance ?? 0} qui glissent) ;`
          + ` ${c.hit ?? 0} robots touchés, ${c.blockDestroyed ?? 0} blocs détruits, ${last.stats[5]} roues arrachées, ${c.botKilled ?? 0} robots détruits,`
          + ` ${c.fireStarted ?? 0} blocs allumés, ${c.organsStunned ?? 0} paralysies locales ; pas où une lame mord ${c.biting ?? 0} (le décor ${c.bitingScenery ?? 0}),`
          + ` où une mâchoire tient ${c.gripping ?? 0}, où une chaîne est enroulée ${c.wrapped ?? 0}, où un rotor vibre ${c.vibrating ?? 0}, où un bras frappe ${c.striking ?? 0},`
          + ` où un robot est soulevé ${c.thrown ?? 0} ; modes : ${modes || "aucun changement"} ; ${last.stats[0]} chocs ; ${last.stats[8]} tirages`,
      );
    }
  };
  it.each(chosen("contact", Object.keys(MELEE_RUNS)))("%s : mêmes armes de contact, mêmes coups", { timeout: 300_000 }, (name) =>
    covered("contact", [struck], name, () => meleeCase(name, MELEE_RUNS[name], 7)));

  it("les armes de contact : coups sur des robots, des accessoires, le décor, qui glissent ; blocs détruits, roues arrachées, robots détruits ; feu, paralysies ; morsures, prises, chaînes enroulées, balourd, frappes, robots soulevés, charges", () => {
    if (process.env.SIM_REPORT) console.log(`les armes de contact, sur tous leurs parcours : ${JSON.stringify(struck)}`);
    // (ce qui n'est arrivé dans aucun parcours)
    expect(absent(struck, "contact")).toEqual([]);
  });

  it("la comparaison voit un écart d'un micromètre avec les armes de contact, ou une autre graine", { timeout: 300_000 }, () => {
    for (const name of few(["dépôt, armes de contact, trois contre trois", "forteresse, armes de contact, trois contre trois"])) {
      const run: Run = { ...MELEE_RUNS[name], phases: [{ seconds: sensed(20), throttle: 0, steer: 0 }] };
      const ts = runTs(run, 7);
      expect(firstDifference(runRust(run, 7), ts.samples), name).toBeNull();
      expect(firstDifference(runRust(run, 7, { bot: 1e-6 }), ts.samples), name).not.toBeNull();
      // (une autre graine : d'autres patrouilles, d'autres feux)
      expect(firstDifference(runRust(run, 8), ts.samples), name).not.toBeNull();
    }
  });

  // Ce que les tirs du pilote ont fait, sur tous leurs parcours (côté TypeScript) : les armes qui ont
  // tiré, les ogives qu'un clic a fait sauter, les pas où une tourelle du pilote est paralysée
  const fired = new Set<string>();
  const piloting = { fused: 0, stunnedTurret: 0, hits: 0 };
  it.each(Object.keys(PILOT_RUNS))("%s : mêmes tirs du pilote", { timeout: 300_000 }, (name) => {
    const run = PILOT_RUNS[name];
    const ts = runTs(run, 7);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, 7);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const c = ts.counts;
    for (const key of Object.keys(c)) if (key.startsWith("shot:")) fired.add(key.slice(5));
    piloting.fused += c.fused ?? 0;
    piloting.stunnedTurret += c.stunnedTurret ?? 0;
    piloting.hits += c.hit ?? 0;
    if (process.env.SIM_REPORT) {
      const shots = Object.entries(c).filter(([k]) => k.startsWith("shot:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      console.log(`${name} : tirs ${shots || "aucun"} ; ${c.hit ?? 0} robots touchés, ${c.blockDestroyed ?? 0} blocs détruits, ${c.fused ?? 0} ogives qu'un clic a fait sauter`);
    }
  });

  it("les tirs du pilote : toutes ses armes ont tiré et touché ; son ogive a sauté sur un clic ; sa tourelle paralysée s'est tue", () => {
    const weapons = [
      "cannon", "sniper", "flamer", "rifle", "mine", "missile", "lockon", "rockets", "warhead", "empMine", "stickyMine", "bounceMine", "flare", "rail", "plasma",
      "shotgun", "repair", "barrier", "bombs",
    ];
    expect(weapons.filter((w) => !fired.has(w))).toEqual([]);
    expect(piloting.fused).toBeGreaterThan(0);
    expect(piloting.stunnedTurret).toBeGreaterThan(0);
    expect(piloting.hits).toBeGreaterThan(0);
  });

  it("les rochers : les mêmes sommets que `rockShape`, au bit près", () => {
    const out = probe.alloc(4 * 4096);
    try {
      for (const id of ["valley", "canyon", "island", "city"] as const) {
        for (const b of ARENAS[id].boxes.filter((box) => box.kind === "rock")) {
          const want = rockShape(b.half, b.pos.x, b.pos.z).vertices;
          const n = probe.sim_rock_shape(b.half.x, b.half.y, b.half.z, b.pos.x, b.pos.z, out, 4096);
          expect(Array.from(new Float32Array(probe.memory.buffer, out, n)), id).toEqual(Array.from(want));
        }
      }
    } finally {
      probe.dealloc(out, 4 * 4096);
    }
  });

  // Ce que les parcours des grandes arènes ont fait (côté TypeScript) : sur un pont, sous une voie
  // surélevée, sur une haute rampe, sur une plateforme, dans un bâtiment, dans la lave, sous l'eau
  // profonde, un patin sur l'eau, des robots volants au-dessus du plancher ; des robots détruits par
  // la lave et noyés ; des tirs ; la navigation qui vise autre chose que la destination
  const terrain = {
    deck: 0, underDeck: 0, tallRamp: 0, platform: 0, inBuilding: 0, nearLava: 0, inLava: 0, underwater: 0, skimming: 0, aboveFloor: 0, drown: 0,
    shots: 0, hits: 0, killed: 0, corner: 0, wander: 0,
  };
  const arenaCase = (name: string, run: Run, seed: number): void => {
    const ts = runTs(run, seed);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, seed);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const c = ts.counts;
    for (const key of ["deck", "underDeck", "tallRamp", "platform", "inBuilding", "nearLava", "inLava", "underwater", "skimming", "aboveFloor", "corner", "wander"] as const) {
      terrain[key] += c[key] ?? 0;
    }
    terrain.drown += c["killed:drown"] ?? 0;
    terrain.shots += c.shot ?? 0;
    terrain.hits += c.hit ?? 0;
    terrain.killed += c.botKilled ?? 0;
    if (process.env.SIM_REPORT) {
      const seen = Object.keys(terrain).filter((k) => (c[k] ?? 0) > 0).map((k) => `${k} ${c[k]}`).join(", ");
      console.log(`${name} : ${seen || "rien de particulier"} ; ${c.shot ?? 0} tirs, ${c.hit ?? 0} robots touchés, ${c.botKilled ?? 0} détruits (${Object.entries(c).filter(([k]) => k.startsWith("killed:")).map(([k, n]) => `${k.slice(7)} ${n}`).join(", ") || "aucun"}) ; ${ts.samples[ts.samples.length - 1].stats[8]} tirages`);
    }
  };
  it.each(chosen("arènes", Object.keys(ARENA_RUNS)))("%s : même relief, même navigation, mêmes dangers", { timeout: 600_000 }, (name) =>
    covered("arènes", [terrain], name, () => arenaCase(name, ARENA_RUNS[name], 7)));

  it("les grandes arènes : des robots sur les ponts, sous la voie express, sur les rampes et les plateformes, dans les bâtiments, dans la lave et la mer, sur l'eau, au-dessus du plancher ; des blocs dans la lave, des robots noyés ; des tirs, des détours", () => {
    if (process.env.SIM_REPORT) console.log(`les grandes arènes, sur tous leurs parcours : ${JSON.stringify(terrain)}`);
    // (ce qui n'est arrivé dans aucun parcours)
    expect(absent(terrain, "arènes")).toEqual([]);
  });

  it("la comparaison voit un écart de dix micromètres dans une grande arène, ou une autre graine", { timeout: 600_000 }, () => {
    for (const name of few(["île, trois contre trois sur la piste", "ville, trois contre trois dans les rues", "canyon, trois contre trois par le viaduc"])) {
      const run: Run = { ...ARENA_RUNS[name], phases: [{ seconds: sensed(10), throttle: 0, steer: 0 }] };
      const ts = runTs(run, 7);
      expect(firstDifference(runRust(run, 7), ts.samples), name).toBeNull();
      // (dix micromètres : à 50 m du centre, un micromètre se perd dans les nombres de 4 octets de Rapier)
      expect(firstDifference(runRust(run, 7, { bot: 1e-5 }), ts.samples), name).not.toBeNull();
      // (une autre graine : d'autres patrouilles, d'autres tirs)
      expect(firstDifference(runRust(run, 8), ts.samples), name).not.toBeNull();
    }
  });

  // (la machine peut être chargée : chaque mesure est refaite, en alternant, et on garde la meilleure)
  it.runIf(process.env.SIM_REPORT)("coût d'un pas (indicatif)", { timeout: 3_600_000 }, () => {
    const steps = 600;
    const ms = (n: number): string => n.toFixed(3);
    const report = (
      label: string, starts: readonly Start[], drive: (inputs: PlayerInput[]) => void, rustDrive: (sim: number, bots: number[]) => void,
      arrangement?: PropRun["props"], act?: Act, arena?: SmallArena, combat = false,
    ): void => {
      const best = { whole: Infinity, same: Infinity, rust: Infinity, ai: Infinity, driving: Infinity, rays: Infinity, turrets: Infinity };
      // (avec des accessoires, même aucun, le Rust fait aussi les feux, les flaques, la réparation et
      // les accessoires : « feu, fumée, réparation » et « accessoires, débris » du TypeScript)
      // (et la détection, que le Rust fait à chaque pas : de l'IA comme des pilotes)
      // (au combat, les projectiles aussi)
      // (et l'air, le contact et les jets, que le Rust fait à chaque pas : les rafales sur les robots
      // volants et les avions, l'hélice tranchante, le jet des moteurs à flamme)
      const stages = [
        "détection", "ia", "air", "roues", "physique", "chocs", "contact", ...(combat ? ["projectiles"] : []), "jets",
        ...(arrangement ? ["feu, fumée, réparation", "accessoires, débris"] : []),
      ];
      // (une bataille : dix secondes, le temps que les robots s'approchent et engagent, avant de mesurer)
      const warm = combat ? 600 : 60;
      for (let run = 0; run < 4; run++) {
        // Le pas entier du TypeScript (il fait aussi tout le reste), et ses étapes « ia », « roues »,
        // « physique » et « chocs », ce que fait celui du Rust
        seedRandom(3);
        const { sim, bots } = tsWorld({ arena, bots: starts, props: arrangement, combat });
        drive(bots.map((b) => b.input));
        for (let i = 0; i < warm; i++) sim.step();
        if (act) actTs(sim, bots, act, {});
        sim.profile = { now: () => performance.now(), times: {} };
        const t0 = performance.now();
        for (let i = 0; i < steps; i++) sim.step();
        best.whole = Math.min(best.whole, (performance.now() - t0) / steps);
        const times = sim.profile.times;
        best.same = Math.min(best.same, stages.reduce((s, stage) => s + (times[stage] ?? 0), 0) / steps);
        // (l'étape « ia », et ce qu'y coûtent la conduite de l'IA et ses rayons d'évitement)
        best.ai = Math.min(best.ai, (times.ia ?? 0) / steps);
        best.driving = Math.min(best.driving, (times["ia › conduite"] ?? 0) / steps);
        best.rays = Math.min(best.rays, (times["ia › rayons"] ?? 0) / steps);
        best.turrets = Math.min(best.turrets, (times["ia › tourelles"] ?? 0) / steps);
        sim.dispose();
        const rs = rustWorld({ arena, props: arrangement, combat }, 3);
        const rbots = starts.map((s) => rustBot(rs, s, arenaOf(arena ?? "depot")));
        rustDrive(rs, rbots);
        probe.sim_step(rs, warm);
        if (act) actRust(rs, rbots, act, 0);
        const t1 = performance.now();
        probe.sim_step(rs, steps);
        best.rust = Math.min(best.rust, (performance.now() - t1) / steps);
        probe.sim_free(rs);
      }
      const guns = best.turrets > 0 ? `, ses tourelles ${ms(best.turrets)} ms` : "";
      const ai = best.driving > 0 ? `, dont « ia » ${ms(best.ai)} ms (sa conduite ${ms(best.driving)} ms, ses rayons ${ms(best.rays)} ms${guns})` : "";
      console.log(
        `${label} : un pas du TypeScript ${ms(best.whole)} ms (${stages.join(", ")} : ${ms(best.same)} ms${ai}),`
          + ` du Rust ${ms(best.rust)} ms (${(best.same / best.rust).toFixed(1)} fois moins) ; sonde ${PROBE}`,
      );
    };
    const start = SCENARIOS.allée.start;
    for (const id of ["scarab", "tank", "truck"]) {
      report(`${id} qui roule`, [{ id, ...start }], ([input]) => {
        input.throttle = 0.4;
        input.steer = 0.5;
      }, (sim, [bot]) => probe.sim_control(sim, bot, 0.4, 0.5, 0, 0));
    }
    // Un choc : le mille-pattes lancé contre le mur (il s'y brise dans les 600 pas mesurés)
    const crash = CRASHES["mille-pattes contre le mur"].bots;
    report("mille-pattes contre le mur", crash, ([input]) => {
      input.throttle = 1;
      input.boost = true;
    }, (sim, [bot]) => probe.sim_control(sim, bot, 1, 0, 0, 1));
    // Les accessoires : le Dépôt et les siens, le char lancé contre un baril (une explosion, des
    // blocs en feu pendant les 600 pas mesurés) ; puis le baril coincé contre le mur entre des caisses
    const rush = ([input]: PlayerInput[]): void => {
      input.throttle = 1;
      input.boost = true;
    };
    const rustRush = (sim: number, [bot]: number[]): void => probe.sim_control(sim, bot, 1, 0, 0, 1);
    for (const name of ["char contre un baril", "char contre un baril au pied du mur, entre des caisses"]) {
      const { bots, props: arrangement } = PROP_RUNS[name];
      report(name, bots, rush, rustRush, arrangement);
    }
    // La réparation : le mécanicien lancé contre le mur, qui y reste appuyé (le choc, puis le module
    // au travail pendant les 600 pas mesurés) ; le napalm près du camion (ses blocs en feu, la flaque,
    // puis le module)
    report("mécanicien contre le mur, puis la réparation", REPAIRS["mécanicien contre le mur, puis la réparation"].bots, rush, rustRush, []);
    const napalm = FIRES["napalm près du camion"];
    report("napalm près du camion", napalm.bots, () => {}, () => {}, [], napalm.phases[1].act);
    // L'IA qui conduit : quatre contre quatre au Dépôt, avec ses accessoires (l'étape « ia » du
    // TypeScript est alors sa conduite, ses rayons et sa navigation), puis douze robots
    const depot = AI_RUNS["dépôt, quatre contre quatre"];
    report("l'IA, quatre contre quatre au Dépôt", depot.bots, () => {}, () => {}, "arena");
    const twelve = [...line("red", ["tank", "trike", "scarab", "stilt", "centi", "lancer"]), ...line("blue", ["buggy", "truck", "tracker", "ram", "scout", "sapper"])];
    report("l'IA, six contre six au Dépôt", twelve, () => {}, () => {}, "arena");
    // Au combat : trois contre trois au Dépôt (le tir direct), les missiles contre les leurres, puis
    // douze robots (tir direct et missiles)
    report("au combat, trois contre trois au Dépôt", BATTLES["dépôt, trois contre trois"].bots, () => {}, () => {}, "arena", undefined, undefined, true);
    report("au combat, missiles contre leurres", BATTLES["dépôt, missiles contre leurres"].bots, () => {}, () => {}, "arena", undefined, undefined, true);
    const army = [...line("red", ["tank", "trike", "scarab", "stilt", "lancer", "crane"]), ...line("blue", ["buggy", "truck", "tracker", "bulwark", "swarm", "bastion"])];
    report("au combat, six contre six au Dépôt", army, () => {}, () => {}, "arena", undefined, undefined, true);
    // Les armes spéciales : trois contre trois (l'IEM, les mines du Sapeur, le rayon réparateur, le
    // mur), puis douze robots, dont le Mille-pattes, le Sapeur, le Mécanicien et le Gardien
    report("au combat, les armes spéciales, trois contre trois", SPECIALS["chantier, le mécanicien et le gardien"].bots, () => {}, () => {}, "arena", undefined, "yard", true);
    const specialArmy = [...line("red", ["centi", "sapper", "mechanic", "tank", "stilt", "lancer"]), ...line("blue", ["guardian", "centi", "mechanic", "buggy", "truck", "swarm"])];
    report("au combat, les armes spéciales, six contre six au Dépôt", specialArmy, () => {}, () => {}, "arena", undefined, undefined, true);
    // Les moteurs, les appuis et le vol : un Drone de l'IA qui patrouille seul (le pilote automatique
    // et ses rafales), trois contre trois au sol à moteurs et à appuis, des robots volants puis des
    // avions contre des robots au sol, des avions entre eux ; puis douze robots, volants, avions,
    // moteurs et appuis
    report("un drone de l'IA patrouille seul", [{ id: "drone", x: 0, z: -24, yaw: 0, ai: "red" }], () => {}, () => {}, "arena");
    report("au combat, moteurs et appuis, trois contre trois", ENGINES["dépôt, moteurs et appuis, trois contre trois"].bots, () => {}, () => {}, "arena", undefined, undefined, true);
    report("au combat, des robots volants contre des robots au sol", FLYERS["dépôt, des robots volants contre des robots au sol"].bots, () => {}, () => {}, "arena", undefined, undefined, true);
    report("au combat, des avions contre des robots au sol", FLYERS["dépôt, des avions contre des robots au sol"].bots, () => {}, () => {}, "arena", undefined, undefined, true);
    report("au combat, avions contre avions", FLYERS["dépôt, avions contre avions"].bots, () => {}, () => {}, "arena", undefined, undefined, true);
    const airArmy: Start[] = [
      ...line("red", ["drone", "heli", "rocket", "hovercraft", "tank"]), ...line("blue", ["angel", "frigate", "spider", "manta", "truck"]),
      { id: "fighter", x: 35, z: 0, yaw: 0, ai: "red", launch: true }, { id: "plane", x: -35, z: 0, yaw: Math.PI, ai: "blue", launch: true },
    ];
    report("au combat, volants, avions, moteurs et appuis, six contre six au Dépôt", airArmy, () => {}, () => {}, "arena", undefined, undefined, true);
    // Les armes de contact : trois contre trois au Dépôt, puis douze robots à arme de contact
    report("au combat, armes de contact, trois contre trois", MELEE_RUNS["dépôt, armes de contact, trois contre trois"].bots, () => {}, () => {}, "arena", undefined, undefined, true);
    const meleeArmy = [
      ...line("red", ["reaper", "pounder", "duelist", "sawyer", "catapult", "tumbler"]), ...line("blue", ["urchin", "borer", "crusher", "thresher", "drummer", "whirlwind"]),
    ];
    report("au combat, armes de contact, six contre six au Dépôt", meleeArmy, () => {}, () => {}, "arena", undefined, undefined, true);

    // Où va le pas à douze robots : chaque étape, ici et là (le TypeScript par `sim.profile` ; le Rust
    // étape par étape, `sim_stage`, la physique coupée entre le pas de Rapier et la pose des roues)
    const RUST_STAGES = [
      "détection", "ia", "air", "roues", "physique (pas de Rapier)", "physique (pose des roues)", "chocs", "contact", "projectiles", "jets",
      "feu, fumée, réparation", "accessoires, débris",
    ];
    // (et dans les grandes arènes : les mêmes douze robots du tir direct et des missiles, face à face,
    // sur le relief et parmi leurs accessoires ; le Canyon a un relief au mètre)
    const ids = (team: "red" | "blue"): string[] => army.filter((s) => s.ai === team).map((s) => s.id);
    const facing = (name: ArenaName, x: number, z: number): [string, readonly Start[], ArenaName] => [
      `douze robots, ${name}`, [...lineAt("red", ids("red"), x, -z), ...lineAt("blue", ids("blue"), x, z)], name,
    ];
    const armies: [string, readonly Start[], ArenaName][] = [
      ["douze robots, tir direct et missiles", army, "depot"], ["douze robots, armes spéciales", specialArmy, "depot"],
      ["douze robots, volants, avions, moteurs et appuis", airArmy, "depot"], ["douze robots à arme de contact", meleeArmy, "depot"],
      facing("valley", 0, 22), facing("canyon", 0, 32), facing("island", 60, 60), facing("city", 0, 72), facing("port", 50, 36),
      facing("val-du-lac", 20, 40),
    ];
    for (const [label, starts, place] of armies) {
      const ts: Record<string, number> = {};
      const rust = new Array<number>(RUST_STAGES.length).fill(Infinity);
      let rustWhole = Infinity;
      let tsWhole = Infinity;
      const arena = place === "depot" ? undefined : place;
      for (let run = 0; run < 4; run++) {
        seedRandom(3);
        const { sim } = tsWorld({ arena, bots: starts, props: "arena", combat: true });
        for (let i = 0; i < 600; i++) sim.step();
        sim.profile = { now: () => performance.now(), times: {} };
        const t0 = performance.now();
        for (let i = 0; i < steps; i++) sim.step();
        tsWhole = Math.min(tsWhole, (performance.now() - t0) / steps);
        for (const [stage, t] of Object.entries(sim.profile.times)) ts[stage] = Math.min(ts[stage] ?? Infinity, t / steps);
        sim.dispose();
        const rs = rustWorld({ arena, props: "arena", combat: true }, 3);
        for (const s of starts) rustBot(rs, s, arenaOf(place));
        probe.sim_step(rs, 600);
        const times = new Array<number>(RUST_STAGES.length).fill(0);
        const t1 = performance.now();
        for (let i = 0; i < steps; i++) {
          for (let k = 0; k < RUST_STAGES.length; k++) {
            const t = performance.now();
            probe.sim_stage(rs, k);
            times[k] += performance.now() - t;
          }
        }
        rustWhole = Math.min(rustWhole, (performance.now() - t1) / steps);
        for (let k = 0; k < RUST_STAGES.length; k++) rust[k] = Math.min(rust[k], times[k] / steps);
        probe.sim_free(rs);
      }
      const tsStages = Object.entries(ts).filter(([stage]) => !stage.includes("›")).map(([stage, t]) => `${stage} ${ms(t)}`).join(", ");
      const tsDetail = Object.entries(ts).filter(([stage]) => stage.includes("›")).map(([stage, t]) => `${stage} ${ms(t)}`).join(", ");
      console.log(
        `où va le pas, ${label} : le TypeScript ${ms(tsWhole)} ms (${tsStages} ; dont ${tsDetail}),`
          + ` le Rust ${ms(rustWhole)} ms étape par étape (${RUST_STAGES.map((stage, k) => `${stage} ${ms(rust[k])}`).join(", ")})`,
      );
    }
  });
});
