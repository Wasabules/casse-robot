import type { PropType } from "../catalog/props";
import { axisAngle, qmul, qrot, vec3, type Quat, type Vec3 } from "../math/vec";
import type { PropSpot } from "./layout";

/*
 * Bâtiments en accessoires ancrés, pour les arènes du jeu (arena/valley.ts, canyon.ts, city.ts…) et
 * les préfabriqués des cartes communautaires (map/prefabs.ts) : la liste des accessoires d'une arène
 * et le numéro de chaque bâtiment (`PropList`), une maison en pans de mur sous un toit en bandes
 * (`house`), un immeuble en pans de façade, un par étage (`building`), et le tirage fixe qui les
 * varie (`seeded`). À part du code des arènes, que le jeu ne charge plus (il lit leurs fichiers :
 * map/gameArenas.ts) : l'éditeur de cartes et la construction d'une carte n'en ont besoin que de ceci.
 */

/** Tirage fixe (générateur congruentiel) : la carte est une donnée, la même à chaque partie. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const yaw = (a: number): Quat => axisAngle(vec3(0, 1, 0), a);
const pitch = (a: number): Quat => axisAngle(vec3(1, 0, 0), a);

/** Accessoires de la carte, et le numéro de chaque bâtiment (voir `PropSpot.building`). */
export class PropList {
  readonly spots: PropSpot[] = [];
  private buildings = 0;

  add(spot: PropSpot): number {
    this.spots.push(spot);
    return this.spots.length - 1;
  }

  newBuilding(): number {
    return this.buildings++;
  }
}

export interface HouseSpec {
  x: number;
  z: number;
  /** Longueur le long du faîtage, profondeur (m). */
  w: number;
  d: number;
  /** Hauteur des murs (m). */
  h: number;
  /** Sol du bâtiment (m). */
  ground: number;
  wall: PropType;
  roof: PropType;
  /** Toit à deux pans (45°, pignons fermés) ou plat. */
  roofKind: "gable" | "flat";
  /** Faîtage le long de x, ou de z. */
  ridge: "x" | "z";
  /** Grande ouverture (m de large) au milieu du long pan de devant (côté -z du bâtiment, avant rotation). */
  door?: number;
  /** Tourne le bâtiment d'un demi-tour (l'ouverture passe derrière). */
  flip?: boolean;
  /** L'ouverture traverse le bâtiment : la même dans le long pan de derrière (un hangar qu'on traverse). */
  through?: boolean;
}

/** Épaisseur d'un mur de maison, d'un toit (m) ; largeur maximale d'un pan (m) : un mur tombe par morceaux. */
const HOUSE_WALL = 0.3;
const ROOF = 0.2;
const PANEL = 3.6;
const EAVES = 0.5;

/**
 * Un bâtiment en pans de mur ancrés : deux longs pans (le long du faîtage), deux pignons, et un
 * toit en bandes, chacune posée sur les pans qu'elle couvre (elle tombe quand ils ont tous
 * disparu). Un toit à deux pans (45°) a des pignons en losange, dont la moitié basse se cache dans
 * le mur.
 */
export function house(P: PropList, s: HouseSpec): void {
  const building = P.newBuilding();
  const turn = qmul(yaw(s.ridge === "x" ? 0 : Math.PI / 2), yaw(s.flip ? Math.PI : 0));
  const place = (local: Vec3): Vec3 => {
    const p = qrot(turn, local);
    return vec3(s.x + p.x, p.y, s.z + p.z);
  };
  const add = (type: PropType, local: Vec3, half: Vec3, rot: Quat | null, rests?: number[], diamond?: boolean): number =>
    P.add({ type, pos: place(local), half, rot: rot ? qmul(turn, rot) : turn, rests, building, diamond });

  const g = s.ground;
  const n = Math.ceil(s.w / PANEL);
  const pw = s.w / n;
  const long: number[][] = [[], []]; // pans de devant (v < 0) et de derrière, par bande
  [-1, 1].forEach((side, k) => {
    for (let i = 0; i < n; i++) {
      const u = -s.w / 2 + pw * (i + 0.5);
      if ((side < 0 || s.through) && s.door && Math.abs(u) < s.door / 2) continue;
      long[k][i] = add(s.wall, vec3(u, g + s.h / 2, side * (s.d / 2 - HOUSE_WALL / 2)), vec3(pw / 2, s.h / 2, HOUSE_WALL / 2), null);
    }
  });
  const inner = s.d - 2 * HOUSE_WALL;
  const m = Math.ceil(inner / PANEL);
  const ends: number[][] = [[], []];
  [-1, 1].forEach((side, k) => {
    for (let j = 0; j < m; j++) {
      const v = -inner / 2 + (inner / m) * (j + 0.5);
      ends[k].push(add(s.wall, vec3(side * (s.w / 2 - HOUSE_WALL / 2), g + s.h / 2, v), vec3(HOUSE_WALL / 2, s.h / 2, inner / (2 * m)), null));
    }
  });
  // Ce que porte la bande i : ses pans de devant et de derrière, et le pignon au bout
  const under = (i: number): number[] => {
    const rests = [long[0][i], long[1][i]].filter((r) => r !== undefined);
    if (i === 0) rests.push(...ends[0]);
    if (i === n - 1) rests.push(...ends[1]);
    return rests;
  };
  const overhang = (i: number): number => (i === 0 || i === n - 1 ? EAVES / 2 : 0);
  const shift = (i: number): number => (i === 0 ? -EAVES / 2 : i === n - 1 ? EAVES / 2 : 0);

  if (s.roofKind === "flat") {
    for (let i = 0; i < n; i++) {
      const u = -s.w / 2 + pw * (i + 0.5) + (n === 1 ? 0 : shift(i));
      const hu = pw / 2 + (n === 1 ? EAVES : overhang(i));
      add(s.roof, vec3(u, g + s.h + ROOF / 2, 0), vec3(hu, ROOF / 2, s.d / 2 + EAVES), null, under(i));
    }
    return;
  }
  // Toit à deux pans : chaque pan descend du faîtage jusqu'au-delà du mur
  const slope = (s.d / 2) * Math.SQRT2 + EAVES;
  const ridgeY = g + s.h + s.d / 2;
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const u = -s.w / 2 + pw * (i + 0.5) + (n === 1 ? 0 : shift(i));
      const hu = pw / 2 + (n === 1 ? EAVES / 2 : overhang(i));
      // Du faîtage, on descend vers (0, -1, side)/√2 ; la normale est (0, 1, side)/√2
      const along = slope / 2 - 0.12;
      const c = vec3(u, ridgeY - along * Math.SQRT1_2 + (ROOF / 2) * Math.SQRT1_2, side * along * Math.SQRT1_2 + side * (ROOF / 2) * Math.SQRT1_2);
      add(s.roof, c, vec3(hu, ROOF / 2, slope / 2), pitch((side * Math.PI) / 4), under(i));
    }
  }
  // Pignons : un losange (carré tourné de 45°) dont la pointe haute monte sous le faîtage
  const diagonal = s.d - 2 * HOUSE_WALL;
  [-1, 1].forEach((side, k) => {
    add(s.wall, vec3(side * (s.w / 2 - HOUSE_WALL / 2), g + s.h, 0), vec3(HOUSE_WALL / 2, diagonal / (2 * Math.SQRT2), diagonal / (2 * Math.SQRT2)), pitch(Math.PI / 4), [...ends[k]], true);
  });
}

/** Rectangle du plan (m) : l'emprise d'un immeuble. */
export interface Area {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Épaisseur d'une façade, d'un toit d'immeuble (m) ; hauteur d'un étage ; largeur maximale d'un pan (m). */
export const WALL = 0.3;
const FLAT_ROOF = 0.3;
export const STOREY = 3.6;
const FACADE_PANEL = 6;

/** Un côté d'un immeuble : nord (+z), sud, ouest (+x), est. */
export type Side = "n" | "s" | "w" | "e";

export interface BuildingSpec {
  /** Emprise (m). */
  at: Area;
  /** Sol de l'immeuble (m). */
  ground: number;
  floors: number;
  wall: PropType;
  /** Ouvertures au rez-de-chaussée : le côté, et le rang du pan (depuis l'est ou le sud). */
  doors?: readonly [Side, number][];
  /** Part des colonnes de pans dont les étages du haut se sont effondrés (0 à 1). */
  ruin?: number;
  seed: number;
}

/**
 * Un immeuble en pans de façade ancrés, un par étage et par colonne : chaque pan repose sur celui
 * du dessous (il tombe quand celui-ci disparaît), et le toit plat, en bandes, sur les pans du haut.
 * Une ouverture au rez-de-chaussée (une porte cochère, une vitrine soufflée) laisse un linteau, qui
 * repose sur ses voisins. Une ruine a perdu le haut de quelques colonnes, et le toit au-dessus.
 */
export function building(P: PropList, s: BuildingSpec): void {
  const id = P.newBuilding();
  const random = seeded(s.seed);
  const base = s.ground;
  const { minX, maxX, minZ, maxZ } = s.at;
  const alongX = maxX - minX >= maxZ - minZ; // le faîte, le long du plus grand côté
  // Repère local : u le long du grand côté, v en travers
  const [u0, u1, v0, v1] = alongX ? [minX, maxX, minZ, maxZ] : [minZ, maxZ, minX, maxX];
  const place = (u: number, y: number, v: number): Vec3 => (alongX ? vec3(u, y, v) : vec3(v, y, u));
  const size = (hu: number, hy: number, hv: number): Vec3 => (alongX ? vec3(hu, hy, hv) : vec3(hv, hy, hu));
  const sideOf = (long: boolean, k: number): Side => (long === alongX ? (k ? "n" : "s") : (k ? "w" : "e"));
  const door = (side: Side, i: number): boolean => !!s.doors?.some(([d, j]) => d === side && j === i);

  const n = Math.ceil((u1 - u0) / FACADE_PANEL);
  const pw = (u1 - u0) / n;
  const inner = v1 - v0 - 2 * WALL;
  const m = Math.ceil(inner / FACADE_PANEL);
  const pd = inner / m;
  // Hauteur de chaque colonne (en étages) : une ruine en a perdu
  const height = (): number => (random() < (s.ruin ?? 0) ? Math.max(1, s.floors - 1 - (random() < 0.4 ? 1 : 0)) : s.floors);
  /** Pans par côté (0 : u ou v bas, 1 : haut), par colonne, par étage. */
  const long: (number | undefined)[][][] = [[], []];
  const ends: (number | undefined)[][][] = [[], []];
  const raise = (cols: (number | undefined)[][][], k: number, count: number, isLong: boolean, at: (i: number, y: number) => Vec3, half: Vec3): void => {
    for (let i = 0; i < count; i++) {
      const top = height();
      const column: (number | undefined)[] = [];
      for (let f = 0; f < top; f++) {
        const y = base + STOREY * (f + 0.5);
        if (f === 0 && door(sideOf(isLong, k), i)) {
          column.push(undefined);
          continue;
        }
        // Sur le pan du dessous ; un linteau, sur ses voisins du même étage
        const below = f > 0 ? column[f - 1] : undefined;
        const rests = f === 0 ? undefined : below !== undefined ? [below] : [cols[k][i - 1]?.[f], undefined].filter((r): r is number => r !== undefined);
        column.push(P.add({ type: s.wall, pos: at(i, y), half, building: id, rests }));
      }
      cols[k][i] = column;
    }
  };
  for (const k of [0, 1]) {
    const v = k ? v1 - WALL / 2 : v0 + WALL / 2;
    raise(long, k, n, true, (i, y) => place(u0 + pw * (i + 0.5), y, v), size(pw / 2, STOREY / 2, WALL / 2));
    const u = k ? u1 - WALL / 2 : u0 + WALL / 2;
    raise(ends, k, m, false, (j, y) => place(u, y, v0 + WALL + pd * (j + 0.5)), size(WALL / 2, STOREY / 2, pd / 2));
  }
  // Un linteau dont le voisin de droite n'existait pas encore : il repose aussi sur lui
  for (const cols of [long, ends]) {
    for (const k of [0, 1]) {
      cols[k].forEach((column, i) => {
        if (column[0] !== undefined) return;
        const lintel = column[1];
        const right = cols[k][i + 1]?.[1];
        if (lintel === undefined || right === undefined) return;
        const spot = P.spots[lintel];
        spot.rests = [...(spot.rests ?? []), right];
      });
    }
  }
  // Toit plat en bandes : chacune sur les pans du dernier étage de sa colonne (et des pignons au bout) ;
  // pas de bande là où les deux côtés se sont effondrés
  const roofY = base + STOREY * s.floors + FLAT_ROOF / 2;
  for (let i = 0; i < n; i++) {
    const rests = [long[0][i]?.[s.floors - 1], long[1][i]?.[s.floors - 1]].filter((r): r is number => r !== undefined);
    if (!rests.length) continue;
    if (i === 0) rests.push(...ends[0].map((c) => c[s.floors - 1]).filter((r): r is number => r !== undefined));
    if (i === n - 1) rests.push(...ends[1].map((c) => c[s.floors - 1]).filter((r): r is number => r !== undefined));
    P.add({ type: "concrete", pos: place(u0 + pw * (i + 0.5), roofY, (v0 + v1) / 2), half: size(pw / 2, FLAT_ROOF / 2, (v1 - v0) / 2), building: id, rests });
  }
}
