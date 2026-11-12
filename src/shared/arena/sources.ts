import { axisAngle, vec3 } from "../math/vec";
import { barrier, box, enclosure, incline, pillar, ramp, spots, zone } from "./builders";
import { CANYON } from "./canyon";
import { CITY, CITY_NIGHT } from "./city";
import { ISLAND } from "./island";
import type { ArenaBounds, ArenaId, ArenaLayout } from "./layout";
import { PORT } from "./port";
import { VALLEY } from "./valley";

/*
 * Le code des arènes du jeu : la source de leurs fichiers de carte (`npm run map:export` les écrit
 * dans content/arenas/, tools/maps/arenas.ts), et la référence de l'aller-retour (tests/arenaExport.test.ts :
 * chaque fichier, relu et construit, redonne au bit près l'arène de son code). Le jeu, le Worker de la
 * partie solo, le serveur et les essais jouent les fichiers (`ARENAS`, map/gameArenas.ts) : ce code
 * n'entre ni dans le paquet du client ni dans celui du serveur.
 */

/** Les petites arènes : murs d'enceinte à ±36 m, lignes de départ à une soixantaine de mètres l'une de l'autre. */
const SMALL: ArenaBounds = { half: 36, roam: 29, spawnLine: 29, spawnSpread: 24, circuit: 35 };

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

/** Chaque arène du jeu, telle que la fait son code. */
export const ARENA_SOURCES: Readonly<Record<ArenaId, ArenaLayout>> = {
  depot: DEPOT, fort: FORT, trenches: TRENCHES, yard: YARD, valley: VALLEY, canyon: CANYON, island: ISLAND, city: CITY, cityNight: CITY_NIGHT, port: PORT,
};
