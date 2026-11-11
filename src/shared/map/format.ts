import type { ArenaId, BoxLook, CommunityMeta, PathSurface, StaticKind } from "../arena/layout";
import type { GroundStyle } from "../arena/features";
import type { PropType } from "../catalog/props";

/*
 * Format des cartes communautaires (`MapFile`) : une donnée JSON versionnée, qu'une personne écrit
 * (à la main, avec un outil, bientôt avec l'éditeur) et que le jeu convertit en arène
 * (`arenaFromMap`, map/build.ts) : ensuite, la simulation, l'IA, le rendu, la mini-carte et le
 * réseau la traitent comme une arène du jeu. Le détail de chaque champ, pour les auteurs, est dans
 * docs/maps.md ; les bornes, dans `MAP_LIMITS` (une carte qui les dépasse est refusée : elle
 * coûterait trop cher à simuler, ou ce n'est pas une carte).
 *
 * Unités : mètres et degrés. Repère du jeu : nord = +z, ouest = +x, haut = +y ; le centre de la
 * carte est l'origine. Les champs facultatifs ont une valeur par défaut raisonnable : une carte
 * minimale n'a que `format`, `meta`, `bounds` et ses `zones`.
 */

/** Version du format que ce code écrit ; une carte plus ancienne passe par `upgradeMap` (map/read.ts). */
export const MAP_FORMAT = 1;
/** Extension d'un fichier de carte. */
export const MAP_EXTENSION = ".casse-map.json";

/** Un point du plan : [x, z] (m). */
export type MapPoint = readonly [number, number];
/** Trois longueurs : largeur (x), hauteur (y), profondeur (z) (m). */
export type MapSize = readonly [number, number, number];

/** Ce que l'auteur dit de sa carte (voir `CommunityMeta`) : nom, auteur, description, licence. */
export type MapMeta = CommunityMeta;

/**
 * Relief : une grille carrée de hauteurs, centrée sur l'origine, de `cells` cases de `step` m par
 * côté (`cells + 1` sommets par côté). Les hauteurs sont des entiers de 0 à 65 535 (`min` à `max` m),
 * en Uint16 petit-boutiste, encodés en base64, dans l'ordre du champ de hauteurs de Rapier : une
 * colonne par x (de l'est, -x, à l'ouest, +x), et dans chacune les z croissants (du sud au nord).
 */
export interface MapTerrain {
  readonly cells: number;
  /** Pas de la grille (m) : 1 ou 2 (une puissance de deux : voir `MAP_LIMITS.steps`). */
  readonly step: number;
  readonly min: number;
  readonly max: number;
  readonly heights: string;
}

/**
 * Dimensions de jeu (voir `ArenaBounds`, arena/layout.ts) : seul `half` est obligatoire, le reste
 * s'en déduit. Les rouges partent du nord (+z), les bleus du sud (-z), sur une ligne à `spawnLine` m
 * du centre, large de 2 × `spawnSpread` m (sauf lignes de départ libres : `MapFile.spawns`).
 */
export interface MapBounds {
  readonly half: number;
  readonly roam?: number;
  readonly spawnLine?: number;
  readonly spawnSpread?: number;
  readonly circuit?: number;
  /** Altitude plancher des avions de l'IA (m au-dessus du relief) ; sans elle, d'après le plus haut du décor. */
  readonly airFloor?: number;
  readonly hoverFloor?: number;
}

/**
 * Limites de la carte : des murs d'enceinte visibles à ±`half` (comme les petites arènes), et une
 * limite invisible à ±`bound` m (comme la Vallée, au fond de ses montagnes : rien ne sort de la carte,
 * pas même un robot qui s'envole). Sans `bound`, la limite invisible est à 35 m au-delà de `half`
 * (et dans le relief) ; `bound: 0` : pas de limite invisible.
 */
export interface MapLimits {
  readonly walls?: boolean;
  readonly bound?: number;
}

/** Ciel et brouillard (voir `ArenaSky`). */
export interface MapSky {
  readonly color: string;
  readonly fog: number;
  readonly dust?: number;
  /** La nuit : la lune, les étoiles, les lampadaires et les mâts d'éclairage allumés (voir `ArenaSky.night`). */
  readonly night?: boolean;
}

/**
 * Palette du sol : celle d'une arène du jeu (`preset`, la Vallée par défaut), dont on peut changer
 * chaque champ (voir `GroundStyle`, arena/features.ts).
 */
export type MapGround = Partial<GroundStyle> & { readonly preset?: ArenaId };

/** L'eau : son niveau (m), la profondeur au-delà de laquelle on s'y noie (sans elle, on la traverse partout), sa couleur. */
export interface MapWater {
  readonly level: number;
  readonly deep?: number;
  readonly color?: string;
}

/**
 * Grille de passage de l'IA (voir arena/navgrid.ts) : taille d'une case (m) et pente la plus raide
 * qu'elle franchit (degrés). Par défaut sur une carte qui a du relief, de l'eau profonde ou de la
 * lave ; `false` : aucune (l'IA va tout droit).
 */
export interface MapNav {
  readonly cell?: number;
  readonly maxSlope?: number;
}

/** Lave : une coulée (ligne brisée, large de `width` m) ou un lac (disque) ; voir `LavaShape`. */
export type MapLava =
  | { readonly kind: "flow"; readonly width: number; readonly points: readonly MapPoint[] }
  | { readonly kind: "pool"; readonly x: number; readonly z: number; readonly r: number };

/** Une fumerolle (voir `Vent`) ; sans `y`, au ras du sol. */
export interface MapVent {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
  readonly size: number;
  readonly steam?: boolean;
}

/** Une cascade (voir `Waterfall`) ; `dir` : où tombe l'eau (degrés : 0 vers le nord, 90 vers l'ouest). */
export interface MapFall {
  readonly x: number;
  readonly z: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly dir: number;
}

/** Un chemin dessiné sur le relief (voir `TerrainPath`). */
export interface MapPath {
  readonly width: number;
  readonly points: readonly MapPoint[];
  readonly surface?: PathSurface;
}

/** Orientation : lacet (autour de la verticale ; 90 tourne le nord vers l'ouest), tangage (autour de x), roulis (autour de z), en degrés. */
export interface MapTurn {
  readonly yaw?: number;
  readonly pitch?: number;
  readonly roll?: number;
}

/**
 * Une boîte du décor fixe (voir `StaticBox`) : sa sorte, son centre, ses dimensions, son
 * orientation. Sans `y`, elle est posée sur le sol (au plus bas du relief sous elle ; un rocher, à
 * demi enterré).
 */
export interface MapBox extends MapTurn {
  readonly kind: StaticKind;
  readonly x: number;
  readonly z: number;
  readonly y?: number;
  readonly size: MapSize;
  readonly look?: BoxLook;
  readonly round?: boolean;
  readonly underpass?: boolean;
  readonly approach?: number;
}

/**
 * Un accessoire (voir `PropSpot`, `PROP_TYPES`) : sa base en (x, z), à `y` m (sans `y`, sur le
 * sol). Une dalle (pan de mur, toit) a ses dimensions (`size`) ; un arbre, un baril, une échelle
 * (`scale`). `rests` : les accessoires (rangs dans `props`) sur lesquels il repose (il tombe quand ils
 * ont tous disparu) ; `group` : son bâtiment (l'IA contourne un bâtiment d'un bloc).
 */
export interface MapProp extends MapTurn {
  readonly type: PropType;
  readonly x: number;
  readonly z: number;
  readonly y?: number;
  readonly size?: MapSize;
  readonly scale?: number;
  readonly rests?: readonly number[];
  readonly group?: number;
}

/** Matières des murs et des toits d'un bâtiment. */
export type WallMaterial = "brick" | "concrete" | "plank" | "sheet";
export type RoofMaterial = "roof" | "sheet" | "concrete" | "plank";
/** Les arbres et les cactus qu'on sème. */
export type TreeType = "pine" | "oak" | "palm" | "kapok" | "cactus";

/**
 * Éléments préfabriqués : quelques champs, qui se déplient en accessoires et en boîtes
 * (map/prefabs.ts). Un bâtiment est fait de pans de murs et d'un toit qui tombent par morceaux.
 */
export type MapPrefab =
  /** Une maison, un hangar : murs, toit à deux pans (`gable`) ou plat, une ouverture au milieu du long pan de devant (-z avant rotation). */
  | {
      readonly kind: "house"; readonly x: number; readonly z: number; readonly y?: number; readonly yaw?: number;
      /** Le long du faîtage (x avant rotation), en travers, hauteur des murs (m). */
      readonly width: number; readonly depth: number; readonly height: number;
      readonly wall: WallMaterial; readonly roof: RoofMaterial; readonly roofKind?: "gable" | "flat";
      readonly door?: number; readonly through?: boolean;
    }
  /** Un immeuble : des pans de façade, un par étage, et un toit plat ; une ruine a perdu le haut de quelques colonnes. */
  | {
      readonly kind: "tenement"; readonly x: number; readonly z: number; readonly y?: number; readonly yaw?: number;
      readonly width: number; readonly depth: number; readonly floors: number;
      readonly wall: "facade" | "tenement" | "brick" | "concrete";
      /** Ouvertures au rez-de-chaussée : le côté (avant rotation : n = +z, s, w = +x, e) et le rang du pan. */
      readonly doors?: readonly (readonly ["n" | "s" | "w" | "e", number])[];
      readonly ruin?: number; readonly seed?: number;
    }
  /** Une clôture ou un muret le long d'une ligne brisée, en pans. */
  | { readonly kind: "fence"; readonly points: readonly MapPoint[]; readonly height?: number; readonly material?: WallMaterial }
  /** Un bois : `count` arbres semés dans un disque, à l'écart des chemins, des zones, des lignes de départ et du reste. */
  | {
      readonly kind: "woods"; readonly x: number; readonly z: number; readonly radius: number; readonly count: number;
      readonly trees?: readonly TreeType[]; readonly scale?: readonly [number, number]; readonly spacing?: number; readonly seed?: number;
    }
  /** Des rochers semés dans un disque. */
  | {
      readonly kind: "rocks"; readonly x: number; readonly z: number; readonly radius: number; readonly count: number;
      readonly size?: readonly [number, number]; readonly look?: "sandstone" | "basalt"; readonly seed?: number;
    }
  /** Une rampe qui monte de `rise` m sur `length` m vers son avant (+z avant rotation), depuis `base` (le sol à son pied). */
  | {
      readonly kind: "ramp"; readonly x: number; readonly z: number; readonly yaw?: number;
      readonly width: number; readonly length: number; readonly rise: number; readonly base?: number;
    }
  /** Un pont d'un bout à l'autre : un tablier (à la hauteur `y`, sinon celle du sol à ses bouts), des parapets, des piles. */
  | {
      readonly kind: "bridge"; readonly from: MapPoint; readonly to: MapPoint; readonly width: number; readonly y?: number;
      readonly parapets?: boolean; readonly piers?: number; readonly look?: BoxLook;
    }
  /** Une rangée de conteneurs, éventuellement empilés. */
  | {
      readonly kind: "containers"; readonly x: number; readonly z: number; readonly y?: number; readonly yaw?: number;
      readonly count?: number; readonly levels?: number;
    };

export type PrefabKind = MapPrefab["kind"];

/** Une zone à capturer : sa lettre (A à E), son centre (sans `y`, au sol), son rayon. */
export interface MapZone {
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly y?: number;
  readonly radius: number;
}

/**
 * Une ligne de départ placée par l'auteur (`MapFile.spawns`) : son milieu (m), la direction où
 * regarde l'équipe en partant (degrés : 0 vers le nord, 90 vers l'ouest) et sa longueur (m). Les
 * robots de l'équipe s'y alignent, tournés vers `facing`, et réapparaissent là.
 */
export interface MapSpawn {
  readonly x: number;
  readonly z: number;
  readonly facing: number;
  readonly width: number;
}

/** Les lignes de départ des deux équipes, où l'on veut (sans elles : les bleus au sud, les rouges au nord). */
export interface MapSpawns {
  readonly blue: MapSpawn;
  readonly red: MapSpawn;
}

/** Un lieu nommé de la carte (la carte entière, M) : son nom, et s'il le faut un nom par langue. */
export interface MapPlace {
  readonly name: string;
  readonly names?: Readonly<Record<string, string>>;
  readonly x: number;
  readonly z: number;
}

/** Une carte communautaire. */
export interface MapFile {
  readonly format: typeof MAP_FORMAT;
  readonly meta: MapMeta;
  /** Relief ; sans relief, un sol plat (à y = 0). */
  readonly terrain?: MapTerrain;
  readonly bounds: MapBounds;
  readonly limits?: MapLimits;
  readonly sky?: MapSky;
  readonly ground?: MapGround;
  readonly water?: MapWater;
  readonly lava?: readonly MapLava[];
  readonly vents?: readonly MapVent[];
  readonly falls?: readonly MapFall[];
  readonly paths?: readonly MapPath[];
  /** Une ville : l'IA ne prend pas pour destination un point dans un bâtiment (voir `ArenaLayout.urban`). */
  readonly urban?: boolean;
  /** Ambiance sonore : celle d'une arène du jeu (la Vallée par défaut). */
  readonly ambience?: ArenaId;
  readonly nav?: MapNav | false;
  readonly boxes?: readonly MapBox[];
  readonly props?: readonly MapProp[];
  readonly prefabs?: readonly MapPrefab[];
  readonly zones: readonly MapZone[];
  readonly places?: readonly MapPlace[];
  /** Lignes de départ libres ; sans elles, celles de `bounds` (au nord et au sud). */
  readonly spawns?: MapSpawns;
}

/**
 * Bornes d'une carte. Elles gardent un pas de simulation raisonnable (les arènes du jeu en sont
 * loin : la Cité a 152 boîtes et 530 accessoires, le Port 242 boîtes dont 78 accessoires mobiles)
 * et protègent le serveur d'une carte malformée ou hostile.
 */
export const MAP_LIMITS = {
  /** Taille d'un fichier de carte (octets). */
  bytes: 4 * 1024 * 1024,
  /** Textes : nom, auteur, licence, description, nom d'un lieu ; langues par texte. */
  name: 48,
  author: 48,
  license: 48,
  description: 400,
  place: 32,
  languages: 8,
  /** Relief : cases par côté, pas permis (m), côté du relief au plus (m : le sol plat sous le relief fait ±220 m). */
  minCells: 16,
  maxCells: 440,
  steps: [1, 2] as readonly number[],
  maxSide: 440,
  /** Hauteurs (m). */
  minHeight: 0,
  maxHeight: 250,
  /** Demi-côté de la zone de jeu (m). */
  minHalf: 20,
  maxHalf: 200,
  /** Coordonnées dans le plan, et en hauteur (m). */
  reach: 220,
  minY: -10,
  maxY: 300,
  /** Dimension d'une boîte, d'une dalle (m). */
  maxSize: 200,
  boxes: 400,
  props: 900,
  /** Accessoires mobiles (caisses, barils, voitures) : des corps que la physique fait bouger. */
  dynamicProps: 120,
  prefabs: 300,
  zones: 5,
  places: 24,
  lava: 32,
  vents: 32,
  falls: 16,
  paths: 64,
  /**
   * Points d'une ligne brisée (coulée, chemin, clôture) ; de tous les chemins, de toutes les coulées
   * de lave (on les parcourt souvent : pour semer, pour la grille de passage, pour brûler ce qui est
   * dans la lave). Les grandes arènes du jeu en ont quelques dizaines.
   */
  points: 128,
  pathPoints: 1024,
  lavaPoints: 512,
  /**
   * Arbres d'un bois, rochers d'un tas ; et de tous les bois et tas de la carte (chacun se sème en
   * huit essais par arbre au plus, à l'écart des chemins et du décor : le serveur ne doit pas y passer
   * des minutes).
   */
  scatter: 200,
  scattered: 1200,
  /** Étages d'un immeuble, conteneurs d'une rangée, niveaux d'une pile, piles d'un pont. */
  floors: 8,
  containers: 12,
  levels: 4,
  piers: 16,
  /** Pans d'une clôture. */
  fencePanels: 200,
  /** Longueur d'une ligne de départ libre (m). */
  minSpawnWidth: 4,
  maxSpawnWidth: 160,
  /** Taille d'une case de la grille de passage (m). */
  minNavCell: 2,
  maxNavCell: 6,
} as const;

/** Sur quoi porte un dépassement de nombre (`MapIssue` « tooMany »). */
export type MapCounted =
  | "boxes" | "props" | "dynamicProps" | "prefabs" | "scattered" | "zones" | "places" | "lava" | "vents" | "falls" | "paths" | "points" | "languages";

/** Ce que les lignes de départ ont de travers : une équipe. */
export type MapTeam = "blue" | "red";

/**
 * Pourquoi une carte est refusée : un code, et ce qu'il faut pour le dire (le client le dit dans la
 * langue du joueur : `mapIssue.<code>`, client/i18n/names.ts). `path` désigne le champ fautif à la
 * manière de JavaScript (« props[3].type ») : il se montre tel quel.
 */
export type MapIssue =
  /** Ce n'est pas du JSON, ou pas un objet. */
  | { code: "json" }
  /** Le fichier dépasse la taille permise (Ko). */
  | { code: "tooLarge"; size: number; max: number }
  /** Pas de version de format lisible. */
  | { code: "format" }
  /** Carte faite pour une version plus récente du jeu. */
  | { code: "formatTooNew"; version: number }
  /** Un champ manque ou a une valeur invalide. */
  | { code: "field"; path: string }
  /** Un texte trop long. */
  | { code: "text"; path: string; max: number }
  /** Trop d'éléments d'une sorte. */
  | { code: "tooMany"; what: MapCounted; count: number; max: number }
  /** Le relief : taille ou pas invalides. */
  | { code: "terrainSize"; cells: number; step: number }
  /** Le relief : ses hauteurs sont illisibles (base64, nombre de valeurs). */
  | { code: "terrainData" }
  /** Le relief ne couvre pas la zone de jeu (et sa limite). */
  | { code: "terrainSmall"; side: number; need: number }
  /** Un élément hors de la carte. */
  | { code: "outside"; path: string }
  /** Dimensions de jeu incohérentes (zone de l'IA, lignes de départ, circuit des avions). */
  | { code: "bounds"; path: string }
  /** Pas de zone, ou lettres en double ou hors de A à E. */
  | { code: "zones" }
  /** Une zone que l'IA ne peut pas atteindre. */
  | { code: "zoneUnreachable"; zone: string }
  /** La ligne de départ d'une équipe est encombrée, trop raide, dans l'eau profonde ou la lave. */
  | { code: "spawnBlocked"; team: MapTeam }
  /** Quelque chose de dangereux (lave, baril, citerne) tout près de la ligne de départ d'une équipe. */
  | { code: "spawnHazard"; team: MapTeam }
  /** La ligne de départ (libre) d'une équipe sort de la zone de jeu. */
  | { code: "spawnOutside"; team: MapTeam }
  /** Les deux lignes de départ (libres) sont trop près l'une de l'autre. */
  | { code: "spawnClose"; distance: number; min: number };

export type MapIssueCode = MapIssue["code"];
