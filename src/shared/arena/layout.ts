import type { PropType } from "../catalog/props";
import { NO_ROTATION, vec3, type Quat, type Vec3 } from "../math/vec";
import type { GroundStyle, LavaShape, NavGridSpec, Vent, Waterfall } from "./features";
import { terrainHeight, type Terrain } from "./terrain";
import { dcos, dsin } from "../math/det";

/*
 * Arènes, en données pures : la physique (arena.ts) et le rendu (client/render/arenaView.ts) les
 * lisent toutes les deux. Les arènes du jeu sont faites par leur code (arena/sources.ts : les petites
 * arènes, qui ont la même enceinte et diffèrent par leur décor, leurs accessoires et leurs zones ; la
 * Vallée, valley.ts, le Canyon, l'Île volcanique, la Cité, le Port), écrites en fichiers de carte
 * (content/arenas/, `npm run map:export`), et jouées d'après ces fichiers : ce module en garde les
 * identifiants (`ARENA_IDS`) et les arènes construites (`ARENAS`, `arenaById`), comme les cartes
 * communautaires connues. Les lignes de départ des équipes (sim/wave.ts, au nord et au sud) restent dégagées.
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
  const c = dcos(placed.facing);
  const s = dsin(placed.facing);
  // Gauche de l'équipe : (cos, -sin) ; devant elle : (sin, cos)
  return { x: placed.x + c * along - s * back, z: placed.z - s * along - c * back };
}

/** Où est (x, z) par rapport à la ligne de départ d'une équipe : le long d'elle (m, depuis son milieu) et en travers (m, > 0 devant). */
export function spawnLocal(bounds: ArenaBounds, team: SpawnTeam, x: number, z: number): { along: number; across: number } {
  const placed = bounds.spawns?.[team];
  if (!placed) return { along: x, across: team === "blue" ? z + bounds.spawnLine : bounds.spawnLine - z };
  const c = dcos(placed.facing);
  const s = dsin(placed.facing);
  const dx = x - placed.x;
  const dz = z - placed.z;
  return { along: dx * c - dz * s, across: dx * s + dz * c };
}

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

/**
 * Les arènes du jeu, dans l'ordre des menus et de la rotation du serveur. Chacune est faite par son
 * code (arena/sources.ts), exportée en fichier de carte (`npm run map:export` :
 * content/arenas/<id>.casse-map.json), et c'est ce fichier que le jeu, le serveur et les essais lisent
 * (map/gameArenas.ts).
 */
export const ARENA_IDS = ["depot", "fort", "trenches", "yard", "valley", "canyon", "island", "city", "cityNight", "port"] as const;
export type ArenaId = (typeof ARENA_IDS)[number];

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

/** Une ressource d'un paquet de carte : l'empreinte SHA-256 de son fichier (64 chiffres hexadécimaux), et sa taille (octets). */
export interface MapAsset {
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Les ressources d'une carte communautaire venue d'un paquet (map/pack.ts) : ce qui ne change rien à
 * la simulation, seulement à ce qu'on voit et entend. Le client va chercher chaque fichier d'après son
 * empreinte (dans la bibliothèque du navigateur, ou chez le serveur qui l'a envoyée : client/maps/assets.ts).
 */
export interface MapAssets {
  /** Des modèles glTF (.glb) qui remplacent, sur cette carte seulement, ceux du jeu (par type d'accessoire existant). */
  readonly models?: { readonly [T in PropType]?: MapAsset };
  /** L'ambiance sonore : un Ogg Opus en boucle, à la place de celle d'une arène du jeu (`ambience`). */
  readonly ambience?: MapAsset;
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
 * Le ciel d'une arène qui n'en dit rien (les petites arènes) : celui que le client leur donne
 * (client/render/scene.ts), et celui qu'écrit l'export d'une telle arène en carte (map/export.ts).
 */
export const PLAIN_SKY: ArenaSky = { color: "#c7d1d6", fog: 0.009 };

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
  /** Les ressources d'une carte venue d'un paquet : ses modèles d'accessoires et son ambiance (le client seul s'en sert). */
  readonly assets?: MapAssets;
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
 * Une carte communautaire peut s'en servir aussi (`MapPlace.place` : un nom traduit).
 */
export const PLACE_IDS = [
  "village", "fort", "factory", "airfield", "bridge", "sawmill", "cabin",
  "town", "mine", "mesa", "arch", "oasis", "viaduct", "northTunnel", "southTunnel",
  "station", "tracks", "expressway", "offices", "square", "park", "tower", "carPark", "northBoulevard", "southBoulevard",
  "crater", "lagoon", "bunkers", "airstrip", "wreck", "waterfall", "lavaFlow",
  "freighter", "swingBridge", "basin", "harbourOffice", "silos", "terminal", "fuelDepot", "warehouses", "fishermen", "lighthouse", "railway",
] as const;
export type PlaceId = (typeof PLACE_IDS)[number];

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

export const DEFAULT_ARENA: ArenaId = "depot";

const GAME_IDS: ReadonlySet<string> = new Set(ARENA_IDS);
export const isArenaId = (id: unknown): id is ArenaId => typeof id === "string" && GAME_IDS.has(id);

/**
 * Les arènes du jeu déjà construites, par identifiant : d'après leurs fichiers, que fournit qui fait
 * tourner le code partagé (le client, le Worker de la partie solo, le serveur, les essais : voir
 * map/gameArenas.ts). Une arène se construit à sa première demande, une fois : toutes les lectures
 * partagent le même objet (la grille de passage de l'IA, calculée une fois par arène, lui est attachée).
 */
const GAME = new Map<ArenaId, ArenaLayout>();
/** D'où viennent les arènes du jeu : une arène construite d'après son fichier, ou undefined s'il n'est pas (encore) là. */
let gameSource: ((id: ArenaId) => ArenaLayout | undefined) | null = null;

/** Branche la source des arènes du jeu (map/gameArenas.ts : leurs fichiers de carte). */
export function setGameArenaSource(source: (id: ArenaId) => ArenaLayout | undefined): void {
  gameSource = source;
}

/** L'arène du jeu de cet identifiant, construite à la première demande ; undefined si son fichier n'est pas (encore) là. */
export function knownGameArena(id: ArenaId): ArenaLayout | undefined {
  let arena = GAME.get(id);
  if (!arena) {
    arena = gameSource?.(id);
    if (arena) GAME.set(id, arena);
  }
  return arena;
}

/** L'arène du jeu de cet identifiant ; une erreur si son fichier n'a pas été fourni (le client le charge d'abord : client/maps/gameArenas.ts). */
export function gameArena(id: ArenaId): ArenaLayout {
  const arena = knownGameArena(id);
  if (!arena) throw new Error(`Arène du jeu pas encore chargée : ${id} (son fichier, content/arenas/${id}.casse-map.json, n'a pas été fourni)`);
  return arena;
}

/**
 * Les arènes du jeu, par identifiant, construites à la première lecture (`gameArena`) : `ARENAS.valley`
 * se lit comme un objet, mais l'arène vient de son fichier. Le Dépôt, l'arène par défaut, doit être
 * là avant la première `Simulation` (le client l'a dans son paquet, avec les autres petites arènes).
 */
export const ARENAS: Readonly<Record<ArenaId, ArenaLayout>> = Object.defineProperties(
  {},
  Object.fromEntries(ARENA_IDS.map((id) => [id, { enumerable: true, get: () => gameArena(id) }])),
) as Record<ArenaId, ArenaLayout>;

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

/** L'arène de cet identifiant : une arène du jeu (son fichier fourni), ou une carte communautaire connue ; sinon undefined. */
export function arenaById(id: ArenaKey | string): ArenaLayout | undefined {
  if (isArenaId(id)) return knownGameArena(id);
  return isMapKey(id) ? COMMUNITY.get(id) : undefined;
}

/** Les cartes communautaires connues, dans l'ordre où elles l'ont été. */
export const communityArenas = (): ArenaLayout[] => [...COMMUNITY.values()];
