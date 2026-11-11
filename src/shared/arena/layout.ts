import type { PropType } from "../catalog/props";
import { axisAngle, NO_ROTATION, vec3, type Quat, type Vec3 } from "../math/vec";
import { barrier, box, enclosure, incline, pillar, ramp, spots, zone } from "./builders";
import { CANYON } from "./canyon";
import { CITY, CITY_NIGHT } from "./city";
import type { GroundStyle, LavaShape, NavGridSpec, Vent, Waterfall } from "./features";
import { ISLAND } from "./island";
import { PORT } from "./port";
import { terrainHeight, type Terrain } from "./terrain";
import { VALLEY } from "./valley";

/*
 * Arènes, en données pures : la physique (arena.ts) et le rendu (client/render/arenaView.ts) les
 * lisent toutes les deux. Les petites arènes ont la même enceinte ; elles diffèrent par leur décor,
 * leurs accessoires et leurs zones à capturer. La Vallée (valley.ts) est une grande carte, avec
 * du relief, des bâtiments et des arbres ; le Canyon (canyon.ts) aussi, coupé par ses falaises ;
 * l'Île volcanique (island.ts), sa lave et sa mer ; la Cité (city.ts), une ville en ruines, avec ses
 * rues, ses immeubles, une voie rapide surélevée et une gare en tranchée ; le Port (port.ts), ses
 * quais au bord de la mer, son cargo et ses portiques. Les lignes de départ des
 * équipes (sim/wave.ts, au nord et au sud) restent dégagées.
 */

/** Dimensions d'une arène (m). */
export interface ArenaBounds {
  /** Demi-côté de la zone de jeu : ses murs, ou le pied de ses montagnes. */
  readonly half: number;
  /** Zone où l'IA choisit ses destinations (±roam m). */
  readonly roam: number;
  /**
   * Ligne de départ d'une équipe : à `spawnLine` m du centre, de son côté (les bleus au sud, les
   * rouges au nord), sur ±`spawnSpread` m ; sauf lignes placées ailleurs (`spawns`).
   */
  readonly spawnLine: number;
  readonly spawnSpread: number;
  /** Lignes de départ placées où l'on veut (une carte communautaire, `MapFile.spawns`) : voir `spawnLineOf`. */
  readonly spawns?: { readonly blue: SpawnLine; readonly red: SpawnLine };
  /** Rayon du circuit que tournent les avions. */
  readonly circuit: number;
  /**
   * Altitude au-dessous de laquelle l'IA ne fait pas voler ses avions, au-dessus du relief (m) : les
   * obstacles les plus hauts (cheminée, clocher, arbres). 0 : aucun.
   */
  readonly airFloor?: number;
  /**
   * Altitude au-dessous de laquelle l'IA ne fait pas voler ses robots volants (drones, hélicoptères),
   * au-dessus du relief (m) : les toits d'une ville. Ils ne descendent plus bas que pour se poser ou
   * s'abriter, une fois arrivés (ai/brain.ts). 0 : aucune.
   */
  readonly hoverFloor?: number;
}

/**
 * Une ligne de départ : son milieu (m), la direction où regarde l'équipe en partant (rad autour de la
 * verticale : 0 vers le nord, +z ; π/2 vers l'ouest, +x ; l'angle que prend `spawnBot`) et sa
 * demi-longueur (m).
 */
export interface SpawnLine {
  readonly x: number;
  readonly z: number;
  readonly facing: number;
  readonly spread: number;
}

/** Une équipe, pour sa ligne de départ (la même chose que `Team`, sim/entities.ts). */
export type SpawnTeam = "blue" | "red";

/** La ligne de départ d'une équipe : placée par la carte (`bounds.spawns`), sinon au sud (bleus) ou au nord (rouges). */
export function spawnLineOf(bounds: ArenaBounds, team: SpawnTeam): SpawnLine {
  const placed = bounds.spawns?.[team];
  if (placed) return placed;
  return { x: 0, z: (team === "blue" ? -1 : 1) * bounds.spawnLine, facing: team === "blue" ? 0 : Math.PI, spread: bounds.spawnSpread };
}

/**
 * Un point de la ligne de départ d'une équipe : à `along` m de son milieu le long d'elle, et `back` m
 * derrière elle. Sur les lignes du nord et du sud, `along` est x (calculé tel quel, sans rotation :
 * les apparitions des arènes du jeu restent exactement les mêmes) ; sur une ligne placée, il va vers
 * la gauche de l'équipe.
 */
export function spawnPoint(bounds: ArenaBounds, team: SpawnTeam, along: number, back = 0): { x: number; z: number } {
  const placed = bounds.spawns?.[team];
  if (!placed) return { x: along, z: (team === "blue" ? -1 : 1) * (bounds.spawnLine + back) };
  const c = Math.cos(placed.facing);
  const s = Math.sin(placed.facing);
  // Gauche de l'équipe : (cos, -sin) ; devant elle : (sin, cos)
  return { x: placed.x + c * along - s * back, z: placed.z - s * along - c * back };
}

/** Où est (x, z) par rapport à la ligne de départ d'une équipe : le long d'elle (m, depuis son milieu) et en travers (m, > 0 devant). */
export function spawnLocal(bounds: ArenaBounds, team: SpawnTeam, x: number, z: number): { along: number; across: number } {
  const placed = bounds.spawns?.[team];
  if (!placed) return { along: x, across: team === "blue" ? z + bounds.spawnLine : bounds.spawnLine - z };
  const c = Math.cos(placed.facing);
  const s = Math.sin(placed.facing);
  const dx = x - placed.x;
  const dz = z - placed.z;
  return { along: dx * c - dz * s, across: dx * s + dz * c };
}

/** Les petites arènes : murs d'enceinte à ±36 m, lignes de départ à une soixantaine de mètres l'une de l'autre. */
const SMALL: ArenaBounds = { half: 36, roam: 29, spawnLine: 29, spawnSpread: 24, circuit: 35 };

/** Demi-côté du sol plat, sous le relief (m). */
export const GROUND_HALF = 220;

/**
 * Mur d'enceinte, rampe, pilier, plateforme (on monte dessus), muret (on s'abrite derrière),
 * rocher, conteneur, tablier de pont (on roule dessus), piste (une dalle au ras du sol), limite
 * invisible (au fond des montagnes : rien ne quitte la carte, pas même un robot qui s'envole),
 * immeuble (un bloc qu'on ne détruit pas : la tour en ruine, les immeubles du bord de la ville),
 * voie ferrée (rails sur leur ballast, au ras du sol : on roule dessus).
 */
export type StaticKind = "wall" | "ramp" | "pillar" | "platform" | "barrier" | "rock" | "container" | "deck" | "road" | "bound" | "tower" | "track";

/**
 * Apparence d'une boîte du décor, quand ce n'est pas celle de sa sorte : grès (le toit d'un
 * tunnel, une arche naturelle), bois de charpente (les pieds d'un pont à tréteaux), voie ferrée
 * (traverses et rails), wagon, planches (pont de bois, ponton, pilotis), basalte, acier rouillé
 * (une épave) ; et celles du port : béton de quai, acier peint (portiques, grues), coque, château
 * et panneaux de cale d'un navire, cheminée, phare et sa lanterne, silo, pile de conteneurs. Seul le
 * rendu la lit (client/render/arenaView.ts, client/hud/minimap.ts).
 */
export type BoxLook = "sandstone" | "timber" | "rail" | "wagon" | "wood" | "basalt" | "rust"
  | "quay" | "steel" | "hull" | "superstructure" | "hatch" | "funnel" | "lighthouse" | "lamp" | "silo" | "container";

export interface StaticBox {
  kind: StaticKind;
  pos: Vec3;
  half: Vec3;
  rot: Readonly<Quat>;
  look?: BoxLook;
  /**
   * Un cylindre debout inscrit dans la boîte (rayon `half.x`), pour la physique et le rendu : un
   * silo, un phare, une cheminée. La navigation et les apparitions gardent l'emprise de la boîte.
   */
  round?: boolean;
  /**
   * Un tablier sous lequel on passe (une voie surélevée sur ses piles, au-dessus des rues), et pas
   * un pont au-dessus d'une rivière : une destination sous lui reste en bas (ai/navigation.ts).
   */
  underpass?: boolean;
  /**
   * Un tablier : où l'aborder, au-delà de chacun de ses bouts, dans son axe (m ; 5 par défaut). Au
   * pied de son remblai, quand on y monte par un long remblai aux flancs trop raides.
   */
  approach?: number;
}

/** Accessoire posé dans l'arène au début de chaque vague. */
export interface PropSpot {
  type: PropType;
  pos: Vec3;
  /** Orientation (debout par défaut). */
  rot?: Readonly<Quat>;
  /** Demi-dimensions d'une dalle (pan de mur, toit) (m). */
  half?: Vec3;
  /** Échelle d'un accessoire qui n'est pas une dalle (un arbre plus ou moins grand). */
  scale?: number;
  /**
   * Ce sur quoi il repose (indices dans `ArenaLayout.props`) : quand tous ont disparu, il tombe
   * (un toit sur ses murs).
   */
  rests?: readonly number[];
  /** Bâtiment dont il fait partie : l'IA contourne un bâtiment d'un bloc (ai/navigation.ts). */
  building?: number;
  /** Posé en losange (un pignon, sous un toit à deux pans) : le rendu redresse sa texture. */
  diamond?: boolean;
}

/** Zone à capturer (mode Capture de zones) : un disque au sol, à tenir. */
export interface CaptureZone {
  label: string;
  /** Centre, au niveau du sol de la zone (une zone peut être sur une plateforme). */
  pos: Vec3;
  radius: number;
}

export type ArenaId = "depot" | "fort" | "trenches" | "yard" | "valley" | "canyon" | "island" | "city" | "cityNight" | "port";

/**
 * Identifiant d'une carte communautaire (shared/map/) : « map- » suivi du hachage de son contenu
 * (`mapKey`, shared/map/key.ts). Deux copies de la même carte ont le même identifiant, où qu'elles
 * soient (le serveur, le navigateur) ; la moindre modification en fait une autre carte.
 */
export type MapKey = `map-${string}`;
/** Une arène du jeu, ou une carte communautaire. */
export type ArenaKey = ArenaId | MapKey;

/** Forme d'un identifiant de carte communautaire : 16 chiffres hexadécimaux. */
const MAP_KEY = /^map-[0-9a-f]{16}$/;
export const isMapKey = (id: unknown): id is MapKey => typeof id === "string" && MAP_KEY.test(id);

/**
 * Ce qu'une personne a écrit d'une carte communautaire : affiché tel quel (comme le nom d'un robot du
 * garage), pas traduit. Un nom ou une description par langue (code ISO 639-1 : « en », « de ») peut
 * remplacer celui par défaut dans cette langue.
 */
export interface CommunityMeta {
  readonly name: string;
  readonly names?: Readonly<Record<string, string>>;
  readonly author: string;
  readonly description?: string;
  readonly descriptions?: Readonly<Record<string, string>>;
  /** Licence de la carte (un identifiant SPDX de préférence : « CC-BY-4.0 », « CC0-1.0 »). */
  readonly license: string;
}

/**
 * Revêtement d'un chemin : terre (par défaut), herbe (une pelouse, la bande d'herbe rase d'une piste
 * d'aviation : `GroundStyle.lawn`), sable, route de gravier (de la couleur de la terre et de la
 * roche : elle reste visible sur la roche d'une montagne), gravier (une allée de parc), ballast
 * (sous une voie ferrée), asphalte (une chaussée sur le relief).
 */
export type PathSurface = "dirt" | "grass" | "sand" | "road" | "gravel" | "ballast" | "asphalt";

/** Chemin dessiné sur le relief : une ligne brisée (x, z), large de `width` m. */
export interface TerrainPath {
  readonly width: number;
  readonly points: readonly (readonly [number, number])[];
  /** Son revêtement (terre par défaut). */
  readonly surface?: PathSurface;
}

/**
 * Réseau de passage de l'IA au sol (ai/navigation.ts), pour une arène dont le relief coupe les
 * routes (falaises, canyon) : des points (x, z) et leurs liaisons, praticables en ligne droite
 * (`linkNav`, arena/navGraph.ts) ou déclarées (un pont, une arche). Une arène qui en a un active
 * la navigation selon le relief : on y contourne une falaise par un sentier.
 */
export interface NavGraph {
  readonly points: readonly (readonly [number, number])[];
  /** Liaisons (indices dans `points`), dans les deux sens. */
  readonly links: readonly (readonly [number, number])[];
}

/** Ambiance d'une arène : ciel et brouillard. */
export interface ArenaSky {
  /** Couleur du ciel et du brouillard. */
  readonly color: string;
  /** Densité du brouillard (exponentiel carré, m⁻¹). */
  readonly fog: number;
  /** Poussière en suspension autour de la caméra (grains émis par seconde ; client/render/fx/dustFx.ts). */
  readonly dust?: number;
  /**
   * La nuit : la lune au lieu du soleil, un ciel étoilé, et ce qui éclaire s'allume (les
   * lampadaires et les mâts d'éclairage, les fenêtres, les phares et les balises des robots :
   * client/render/nightLights.ts). Rien ne change pour la simulation : c'est un éclairage.
   */
  readonly night?: boolean;
}

/**
 * Une arène, en données. Son nom et sa phrase pour le menu sont dans chaque langue (`arena.<id>`,
 * `arenaInfo.<id>` : client/i18n/locales/<langue>/world.ts) ; ceux d'une carte communautaire sont
 * dans la carte (`community`).
 */
export interface ArenaLayout {
  readonly id: ArenaKey;
  /** Une carte communautaire (shared/map/) : ce que son auteur en a écrit. */
  readonly community?: CommunityMeta;
  /** L'ambiance sonore : celle de cette arène du jeu (sans elle, celle de l'arène elle-même). */
  readonly ambience?: ArenaId;
  readonly bounds: ArenaBounds;
  readonly boxes: readonly StaticBox[];
  readonly props: readonly PropSpot[];
  readonly zones: readonly CaptureZone[];
  /** Relief ; sans relief, un sol plat à y = 0. */
  readonly terrain?: Terrain;
  /** Niveau de l'eau (m) : seulement dessinée, on roule dedans. */
  readonly water?: number;
  /** Chemins, dessinés seulement. */
  readonly paths?: readonly TerrainPath[];
  /**
   * Une ville : les bâtiments couvrent une bonne part du terrain. L'IA ne prend pas pour
   * destination un point dans un bâtiment ou un obstacle : elle va au plus près, dans la rue
   * (ai/navigation.ts, ai/brain.ts).
   */
  readonly urban?: boolean;
  readonly sky?: ArenaSky;
  /** Lieux nommés, pour la carte (client/hud/minimap.ts). */
  readonly places?: readonly ArenaPlace[];
  /**
   * Profondeur d'eau (m) au-delà de laquelle l'eau est profonde : une vraie limite (la mer autour
   * d'une île), que l'IA ne franchit pas, où un robot au sol se noie (sim/hazards.ts) et sur
   * laquelle les patins anti-gravité glissent. Sans elle, l'eau n'est que dessinée.
   */
  readonly deepWater?: number;
  /** Lave : coulées et lacs qui brûlent ce qui s'y tient (voir arena/features.ts). */
  readonly lava?: readonly LavaShape[];
  /**
   * Navigation de l'IA au sol selon le relief, l'une ou l'autre : une grille de passage (`navGrid`,
   * arena/navgrid.ts : pentes trop raides, lave, eau profonde ; pour une grande carte ouverte), ou
   * un réseau de points reliés (`nav`, arena/navGraph.ts : des sentiers qui contournent des falaises,
   * des ponts, une arche ; pour une carte que le relief coupe). Sans elles, l'IA va tout droit.
   */
  readonly navGrid?: NavGridSpec;
  readonly nav?: NavGraph;
  /** Palette du sol (client) ; sans elle, celle de la Vallée. */
  readonly ground?: GroundStyle;
  /** Couleur de l'eau (client). */
  readonly waterColor?: string;
  /** Fumerolles et cascades (client : render/fx/terrainFx.ts, ArenaView). */
  readonly vents?: readonly Vent[];
  readonly falls?: readonly Waterfall[];
}

/**
 * Lieux nommés des arènes, pour la carte : un identifiant (le même pour un même nom d'une arène à
 * l'autre), dont le nom est dans chaque langue (`place.<id>`, client/i18n/locales/<langue>/world.ts).
 */
export type PlaceId =
  | "village" | "fort" | "factory" | "airfield" | "bridge" | "sawmill" | "cabin"
  | "town" | "mine" | "mesa" | "arch" | "oasis" | "viaduct" | "northTunnel" | "southTunnel"
  | "station" | "tracks" | "expressway" | "offices" | "square" | "park" | "tower" | "carPark" | "northBoulevard" | "southBoulevard"
  | "crater" | "lagoon" | "bunkers" | "airstrip" | "wreck" | "waterfall" | "lavaFlow"
  | "freighter" | "swingBridge" | "basin" | "harbourOffice" | "silos" | "terminal" | "fuelDepot" | "warehouses" | "fishermen" | "lighthouse" | "railway";

/**
 * Lieu nommé d'une arène : lequel, et son centre (m). Celui d'une arène du jeu a un identifiant,
 * traduit ; celui d'une carte communautaire, le nom que lui a donné son auteur (et, s'il le veut, un
 * nom par langue), affiché tel quel.
 */
export type ArenaPlace =
  | { readonly place: PlaceId; readonly x: number; readonly z: number }
  | { readonly name: string; readonly names?: Readonly<Record<string, string>>; readonly x: number; readonly z: number };

/** Un accessoire ancré est posé un peu enfoncé (m) : sur une pente, sa base ne flotte pas. */
const SINK = 0.05;

/** Pose de départ de l'accessoire d'un emplacement (`anchored` : ancré, donc un peu enfoncé). */
export function spotPose(spot: PropSpot, anchored: boolean): { pos: Vec3; rot: Readonly<Quat> } {
  return { pos: anchored ? vec3(spot.pos.x, spot.pos.y - SINK, spot.pos.z) : spot.pos, rot: spot.rot ?? NO_ROTATION };
}

/** Hauteur du sol (le relief, sinon le sol plat) en (x, z), hors décor. */
export function groundLevel(arena: ArenaLayout, x: number, z: number): number {
  return arena.terrain ? Math.max(0, terrainHeight(arena.terrain, x, z)) : 0;
}

/** L'eau est-elle profonde en (x, z) (voir `ArenaLayout.deepWater`) ? */
export function deepWaterAt(arena: ArenaLayout, x: number, z: number): boolean {
  return arena.deepWater !== undefined && arena.water !== undefined && arena.water - groundLevel(arena, x, z) > arena.deepWater;
}

/**
 * Le point `p` est-il dans l'eau (sous la surface de l'arène, au-dessus d'un fond plus bas qu'elle) ?
 * Peu profonde ou non : une arme d'énergie s'y éteint (catalog/melee.ts, `quench`).
 */
export function inWater(arena: ArenaLayout, p: Vec3): boolean {
  return arena.water !== undefined && p.y < arena.water && groundLevel(arena, p.x, p.z) < arena.water;
}

/** Distance devant un robot volant à laquelle il regarde le relief (m) : il monte avant une colline. */
const TERRAIN_LOOKAHEAD = 8;

/**
 * Altitude (y) où voler à `alt` m au-dessus du relief, en allant de `pos` vers `target` : au-dessus
 * du plus haut du sol sous lui et un peu devant lui.
 */
export function flightLevel(arena: ArenaLayout, pos: Vec3, target: Vec3, alt: number): number {
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const d = Math.hypot(dx, dz);
  const k = d > 1e-3 ? Math.min(TERRAIN_LOOKAHEAD, d) / d : 0;
  return Math.max(groundLevel(arena, pos.x, pos.z), groundLevel(arena, pos.x + dx * k, pos.z + dz * k)) + alt;
}

/**
 * Dépôt : quatre piliers, deux rampes ; des caisses en piles, des barils explosifs près des piliers
 * et des rampes (pour des réactions en chaîne), et des bouteilles de gaz vers le centre.
 */
const DEPOT: ArenaLayout = {
  id: "depot",
  bounds: SMALL,
  boxes: [
    ...enclosure(SMALL.half),
    ramp(vec3(0, 0.55, 20), vec3(3, 0.25, 4.5), axisAngle(vec3(1, 0, 0), -0.2)),
    ramp(vec3(-22, 0.55, -8), vec3(4.5, 0.25, 3), axisAngle(vec3(0, 0, 1), 0.2)),
    ...[[12, 12], [-12, 14], [14, -14], [-10, -18]].map(([x, z]) => pillar(x, z)),
  ],
  props: [
    ...spots("crate", [
      [-6, 0.5, 6], [-6, 0.5, 7.05], [-6, 1.5, 6.5],
      [7, 0.5, -4], [8.05, 0.5, -4], [7.5, 1.5, -4],
      [20, 0.5, 20], [21.05, 0.5, 20], [-20, 0.5, 22],
    ]),
    ...spots("barrel", [
      [9.6, 0.5, 12], [10.4, 0.5, 13.2], [12, 0.5, 9.6], [-9.6, 0.5, 14], [13, 0.5, -11.8],
      [-8, 0.5, -16], [-7.2, 0.5, -17], [1.5, 0.5, 9], [-14, 0.5, 1.5], [16, 0.5, 3],
    ]),
    ...spots("gas", [[4, 0.55, -6], [-5, 0.55, 4], [6, 0.55, 5], [-3, 0.55, -11]]),
  ],
  zones: [zone("A", -20, 0, 4, 5), zone("B", 0, 0, 0, 6), zone("C", 20, 0, -4, 5)],
};

/** Hauteur de la plateforme de la Forteresse (m). */
const FORT_HEIGHT = 1.2;

/**
 * Forteresse : une plateforme au centre, où l'on monte par quatre rampes ; des murets pour
 * s'abriter, dans le sens de la marche (nord-sud) pour ne pas barrer le chemin des zones, et des
 * piliers sur les flancs.
 */
const FORT: ArenaLayout = {
  id: "fort",
  bounds: SMALL,
  boxes: [
    ...enclosure(SMALL.half),
    box("platform", 0, FORT_HEIGHT / 2, 0, 5, FORT_HEIGHT / 2, 5),
    incline(0, 8, "z", -1, 6, 6, FORT_HEIGHT),
    incline(0, -8, "z", 1, 6, 6, FORT_HEIGHT),
    incline(8, 0, "x", -1, 6, 6, FORT_HEIGHT),
    incline(-8, 0, "x", 1, 6, 6, FORT_HEIGHT),
    ...[[-13, 13], [13, 13], [-13, -13], [13, -13]].map(([x, z]) => barrier(x, z, "z", 5)),
    ...[[-29, 7], [29, 7], [-29, -7], [29, -7], [-6, 20], [6, -20]].map(([x, z]) => pillar(x, z)),
  ],
  props: [
    ...spots("crate", [[-11.9, 0.5, 12], [-11.9, 0.5, 13.05], [11.9, 0.5, -12], [11.9, 0.5, -13.05], [-4, 0.5, 20], [4, 0.5, -20]]),
    ...spots("barrel", [
      [-14.1, 0.5, 15], [14.1, 0.5, 15], [-14.1, 0.5, -15], [14.1, 0.5, -15],
      [7, 0.5, 7], [-7, 0.5, -7], [7, 0.5, -7], [-7, 0.5, 7],
    ]),
    ...spots("gas", [[3, FORT_HEIGHT + 0.55, 3], [-3, FORT_HEIGHT + 0.55, -3]]),
  ],
  zones: [zone("A", -22, 0, 0, 5), zone("B", 0, FORT_HEIGHT, 0, 4), zone("C", 22, 0, 0, 5)],
};

/**
 * Tranchées : deux lignes de murets coupent l'arène en trois couloirs, avec des passages entre
 * eux ; de part et d'autre de la zone centrale, deux murets bas ; sur les flancs, des piliers.
 */
const TRENCHES: ArenaLayout = {
  id: "trenches",
  bounds: SMALL,
  boxes: [
    ...enclosure(SMALL.half),
    ...[-10, 10].flatMap((x) => [-14, 0, 14].map((z) => barrier(x, z, "z", 6))),
    barrier(-6.5, 0, "z", 5, 1.2),
    barrier(6.5, 0, "z", 5, 1.2),
    ...[[-22, 12], [22, 12], [-22, -12], [22, -12]].map(([x, z]) => pillar(x, z)),
  ],
  props: [
    ...spots("crate", [[-9, 0.5, 0], [9, 0.5, 0], [-9, 1.5, 0], [-24, 0.5, 18], [24, 0.5, -18]]),
    ...spots("barrel", [
      [-11.3, 0.5, -14], [11.3, 0.5, -14], [-11.3, 0.5, 14], [11.3, 0.5, 14],
      [-20.4, 0.5, 12.6], [20.4, 0.5, -12.6], [-5.6, 0.5, 3.2], [5.6, 0.5, -3.2],
    ]),
    ...spots("gas", [[-4, 0.55, 14], [4, 0.55, -14]]),
  ],
  zones: [zone("A", -22, 0, 0, 5), zone("B", 0, 0, 0, 5), zone("C", 22, 0, 0, 5)],
};

/** Hauteur des terrasses du Chantier (m). */
const YARD_HEIGHT = 1.5;

/**
 * Chantier : deux terrasses sur les flancs, où l'on monte par trois rampes chacune (depuis le nord,
 * le sud et le centre) ; au centre, deux conteneurs couchés encadrent la zone B ; des piliers entre
 * les terrasses et les lignes de départ. On s'y bat en hauteur, ou à couvert.
 */
const YARD: ArenaLayout = {
  id: "yard",
  bounds: SMALL,
  boxes: [
    ...enclosure(SMALL.half),
    ...[-1, 1].flatMap((s) => [
      box("platform", s * 24, YARD_HEIGHT / 2, 0, 6, YARD_HEIGHT / 2, 9),
      incline(s * 24, 12, "z", -1, 6, 6, YARD_HEIGHT),
      incline(s * 24, -12, "z", 1, 6, 6, YARD_HEIGHT),
      incline(s * 15, 0, "x", s as 1 | -1, 6, 6, YARD_HEIGHT),
    ]),
    barrier(0, 7, "x", 7, 2.4),
    barrier(0, -7, "x", 7, 2.4),
    ...[[-10, 20], [10, 20], [-10, -20], [10, -20]].map(([x, z]) => pillar(x, z)),
  ],
  props: [
    ...spots("crate", [[-16, 0.5, 13], [16, 0.5, -13], [-16, 0.5, -13], [16, 0.5, 13], [-24, YARD_HEIGHT + 0.5, 6], [24, YARD_HEIGHT + 0.5, -6]]),
    ...spots("barrel", [[-4.5, 0.5, 8.2], [4.5, 0.5, -8.2], [-11.2, 0.5, 20], [11.2, 0.5, -20], [-26, YARD_HEIGHT + 0.5, -6], [26, YARD_HEIGHT + 0.5, 6]]),
    ...spots("gas", [[5, 0.55, 8.4], [-5, 0.55, -8.4]]),
  ],
  zones: [zone("A", -24, YARD_HEIGHT, 0, 4), zone("B", 0, 0, 0, 5), zone("C", 24, YARD_HEIGHT, 0, 4)],
};

export const ARENAS: Readonly<Record<ArenaId, ArenaLayout>> = {
  depot: DEPOT, fort: FORT, trenches: TRENCHES, yard: YARD, valley: VALLEY, canyon: CANYON, island: ISLAND, city: CITY, cityNight: CITY_NIGHT, port: PORT,
};
export const ARENA_IDS = Object.keys(ARENAS) as ArenaId[];
export const DEFAULT_ARENA: ArenaId = "depot";

export const isArenaId = (id: unknown): id is ArenaId => typeof id === "string" && Object.hasOwn(ARENAS, id);

/**
 * Cartes communautaires connues de ce processus (shared/map/ : `arenaFromMap`), par identifiant :
 * celles du dossier `maps/` sur le serveur ; dans le navigateur, celles livrées avec le jeu, celles
 * qu'on a importées, et celles qu'un serveur a envoyées. `Simulation.loadArena` les trouve ici.
 */
const COMMUNITY = new Map<MapKey, ArenaLayout>();

/** Fait connaître une carte communautaire (son identifiant est celui de l'arène). */
export function registerArena(arena: ArenaLayout): void {
  if (!isMapKey(arena.id)) throw new Error(`Identifiant de carte communautaire invalide : ${arena.id}`);
  COMMUNITY.set(arena.id, arena);
}

/** Oublie une carte communautaire (supprimée, ou remplacée par sa nouvelle version). */
export function unregisterArena(key: MapKey): void {
  COMMUNITY.delete(key);
}

/** L'arène de cet identifiant : une arène du jeu, ou une carte communautaire connue ; sinon undefined. */
export function arenaById(id: ArenaKey | string): ArenaLayout | undefined {
  if (isArenaId(id)) return ARENAS[id];
  return isMapKey(id) ? COMMUNITY.get(id) : undefined;
}

/** Les cartes communautaires connues, dans l'ordre où elles l'ont été. */
export const communityArenas = (): ArenaLayout[] => [...COMMUNITY.values()];
