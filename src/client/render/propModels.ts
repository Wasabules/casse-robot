import * as B from "../babylon";
import { CAR_HALF, propDef, type PropType } from "../../shared/catalog/props";
import type { Vec3 } from "../../shared/math/vec";
import { context2d } from "./materials";

type Ctx = CanvasRenderingContext2D;

/*
 * Apparence des accessoires : peints (caisse, baril, bouteille, citerne), en matériau (mur de
 * briques, béton, planches, tôle, tuiles : une texture qui se répète tous les `tile` m, quelle que
 * soit la taille du pan ; une façade, ses fenêtres d'un étage), arbres (tronc et feuillage),
 * voitures (intactes ou brûlées) et lampadaires.
 */

/** Motif d'un matériau de construction, dessiné sur une texture carrée (une façade : deux travées de fenêtres). */
type Surface = "brick" | "concrete" | "plank" | "sheet" | "tiles" | "plaster" | "tenement";

/**
 * Peint (avec, pour un cylindre, `staves` : des douves de bois cerclées de fer, et `cap` : un toit
 * conique de cette couleur), en matériau, arbre, ou cactus (un cierge à bras, côtelé).
 */
type PropLook =
  | { kind: "painted"; fill: string; stripe: string; staves?: boolean; cap?: string }
  /**
   * `tileY` : hauteur du motif (m), si elle diffère de sa largeur ; `fit` : un nombre entier de
   * motifs sur la largeur d'un pan (des fenêtres entières).
   */
  | { kind: "surface"; surface: Surface; tile: number; tileY?: number; fit?: boolean }
  | { kind: "tree"; foliage: Foliage; bark: string; leaves: string }
  | { kind: "cactus"; skin: string; rib: string }
  /** Une voiture : sa peinture ; brûlée, une carcasse rouillée, sans vitres ni pneus. */
  | { kind: "car"; paint: string; burnt: boolean }
  /** Un lampadaire, ou un mât d'éclairage à projecteurs (`flood`) : leur verre luit la nuit (`PropModels.setNight`). */
  | { kind: "lamp"; metal: string; flood?: boolean };

/** Feuillage d'un arbre : étages de branches (sapin), boules (chêne), couronne de palmes (palmier), cime en parasol (fromager). */
type Foliage = "cone" | "ball" | "palm" | "parasol";

const PROP_LOOKS: Record<PropType, PropLook> = {
  crate: { kind: "painted", fill: "#b98f5c", stripe: "#8a6537" },
  barrel: { kind: "painted", fill: "#b8322a", stripe: "#f0bd2c" },
  gas: { kind: "painted", fill: "#e6c84a", stripe: "#5c6770" },
  tank: { kind: "painted", fill: "#d4d8d2", stripe: "#b8322a" },
  brick: { kind: "surface", surface: "brick", tile: 1.6 },
  concrete: { kind: "surface", surface: "concrete", tile: 3 },
  plank: { kind: "surface", surface: "plank", tile: 1.8 },
  sheet: { kind: "surface", surface: "sheet", tile: 1.5 },
  roof: { kind: "surface", surface: "tiles", tile: 1.6 },
  pine: { kind: "tree", foliage: "cone", bark: "#5b4330", leaves: "#2e5634" },
  oak: { kind: "tree", foliage: "ball", bark: "#5e4a36", leaves: "#4d7535" },
  palm: { kind: "tree", foliage: "palm", bark: "#8a7556", leaves: "#4a8a2e" },
  kapok: { kind: "tree", foliage: "parasol", bark: "#9b958a", leaves: "#2f6b2a" },
  cactus: { kind: "cactus", skin: "#56803f", rib: "#3d6230" },
  watertank: { kind: "painted", fill: "#8e6a45", stripe: "#3a3734", staves: true, cap: "#6d5236" },
  // Un étage de façade : deux travées de fenêtres sur 6 m, un étage (3,6 m) de haut
  facade: { kind: "surface", surface: "plaster", tile: 6, tileY: 3.6, fit: true },
  tenement: { kind: "surface", surface: "tenement", tile: 6, tileY: 3.6, fit: true },
  car: { kind: "car", paint: "#8c2f2a", burnt: false },
  wreck: { kind: "car", paint: "#5b4637", burnt: true },
  lamppost: { kind: "lamp", metal: "#3c4247" },
  floodlight: { kind: "lamp", metal: "#565d63", flood: true },
};

/**
 * Le verre des lampes, éteint le jour, allumé la nuit (une matière émise sans éclairage, que le halo
 * fait rayonner) : celui d'un lampadaire, chaud (sodium), celui d'un projecteur, blanc.
 */
const LAMP_GLASS = { day: "#d9d3b8", lamppost: "#ffd59a", floodlight: "#f4f7ff" } as const;

/** Fenêtres éclairées la nuit : leur part (les autres sont sombres), leurs teintes (lampes, écrans), et celles où brûle un feu. */
const LIT_SHARE = 0.38;
const LIT_TINTS = ["#d9a35a", "#e8b86a", "#c98a46", "#f0c98a", "#8ea6d8"] as const;
const FIRE_SHARE = 0.1;
/**
 * Motif des fenêtres éclairées d'une façade : autant de motifs de la texture du mur (deux travées sur
 * un étage) en largeur et en hauteur, chacun allumé au hasard (un tirage fixe) ; au-delà, il se répète.
 */
const WINDOW_TILES = { u: 4, v: 3 } as const;


/**
 * Bois noirci par le feu : 0 intact, 1 roussi, 2 calciné (d'après `Prop.charred`, voir `charLevel`).
 * Chaque cran a sa matière (la même texture, assombrie) : un accessoire qui noircit change de source.
 * Les seuils tombent sur les crans que la simulation annonce (`CHAR_STEPS`, un quart chacun).
 */
export type CharLevel = 0 | 1 | 2;
export const charLevel = (charred: number): CharLevel => (charred >= 0.75 ? 2 : charred >= 0.25 ? 1 : 0);
const CHAR_TINT: readonly B.Color3[] = [new B.Color3(1, 1, 1), new B.Color3(0.52, 0.47, 0.42), new B.Color3(0.2, 0.18, 0.17)];
/** Feuillage roussi, puis calciné. */
const BURNT_LEAVES = ["#5b4a2a", "#2a2420"] as const;
/** Une couleur « #rrggbb » assombrie d'un cran de noircissement. */
function charred(hex: string, char: CharLevel): string {
  if (!char) return hex;
  const c = B.Color3.FromHexString(hex).multiply(CHAR_TINT[char]);
  return c.toHexString();
}

/** Poussière d'un accessoire qui cède, selon sa matière (une caisse, un baril n'en font pas). */
const DUST: Readonly<Record<Surface | "tree" | "cactus", string>> = {
  brick: "#9c7f6a", concrete: "#9d9d98", plank: "#8a7458", sheet: "#8f918f", tiles: "#8f6d5c", tree: "#6f6848", cactus: "#7f8a55",
  plaster: "#a8a196", tenement: "#9a7a66",
};

export function dustColor(type: PropType): string | null {
  const look = PROP_LOOKS[type];
  return look.kind === "surface" ? DUST[look.surface] : look.kind === "tree" ? DUST.tree : look.kind === "cactus" ? DUST.cactus : null;
}

/** Taille de la texture d'un matériau (px). */
const SURFACE_PX = 256;

function drawSurface(c: Ctx, surface: Surface): void {
  const n = SURFACE_PX;
  // Petit hasard fixe, pour que le motif ne change pas d'une partie à l'autre
  let seed = 12345;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  switch (surface) {
    case "brick": {
      c.fillStyle = "#cfc2ad"; // mortier
      c.fillRect(0, 0, n, n);
      const rows = 8;
      const h = n / rows;
      for (let r = 0; r < rows; r++) {
        const offset = r % 2 ? h * 1.1 : 0;
        for (let x = -h * 2.2 + offset; x < n; x += h * 2.2) {
          const shade = 0.85 + random() * 0.3;
          c.fillStyle = `rgb(${Math.round(150 * shade)}, ${Math.round(72 * shade)}, ${Math.round(52 * shade)})`;
          c.fillRect(x + 2, r * h + 2, h * 2.2 - 4, h - 4);
        }
      }
      break;
    }
    case "concrete": {
      c.fillStyle = "#8d9295";
      c.fillRect(0, 0, n, n);
      for (let i = 0; i < 900; i++) {
        const g = 110 + random() * 60;
        c.fillStyle = `rgba(${g}, ${g}, ${g + 4}, 0.35)`;
        c.fillRect(random() * n, random() * n, 2 + random() * 3, 2 + random() * 3);
      }
      // Joints de coffrage
      c.strokeStyle = "rgba(60, 64, 66, 0.55)";
      c.lineWidth = 3;
      c.strokeRect(1, 1, n - 2, n - 2);
      c.beginPath(); c.moveTo(0, n / 2); c.lineTo(n, n / 2); c.stroke();
      break;
    }
    case "plank": {
      const boards = 6;
      const w = n / boards;
      for (let i = 0; i < boards; i++) {
        const shade = 0.85 + random() * 0.25;
        c.fillStyle = `rgb(${Math.round(140 * shade)}, ${Math.round(100 * shade)}, ${Math.round(60 * shade)})`;
        c.fillRect(i * w, 0, w, n);
        c.strokeStyle = "rgba(70, 45, 25, 0.35)";
        c.lineWidth = 1;
        for (let k = 0; k < 5; k++) {
          const x = i * w + 4 + random() * (w - 8);
          c.beginPath(); c.moveTo(x, 0); c.lineTo(x + random() * 6 - 3, n); c.stroke();
        }
        c.fillStyle = "#3c2a1a";
        c.fillRect(i * w, 0, 3, n);
      }
      break;
    }
    case "sheet": {
      const ribs = 10;
      const w = n / ribs;
      for (let i = 0; i < ribs; i++) {
        const grad = c.createLinearGradient(i * w, 0, (i + 1) * w, 0);
        grad.addColorStop(0, "#6f7c85");
        grad.addColorStop(0.5, "#a3afb6");
        grad.addColorStop(1, "#6f7c85");
        c.fillStyle = grad;
        c.fillRect(i * w, 0, w, n);
      }
      for (let i = 0; i < 14; i++) {
        c.fillStyle = `rgba(140, 80, 40, ${0.15 + random() * 0.2})`;
        c.beginPath();
        c.arc(random() * n, random() * n, 4 + random() * 12, 0, Math.PI * 2);
        c.fill();
      }
      break;
    }
    case "tiles": {
      c.fillStyle = "#6e2c1f";
      c.fillRect(0, 0, n, n);
      const rows = 8;
      const h = n / rows;
      for (let r = 0; r < rows; r++) {
        const offset = r % 2 ? h * 0.6 : 0;
        for (let x = -h * 1.2 + offset; x < n; x += h * 1.2) {
          const shade = 0.85 + random() * 0.25;
          const grad = c.createLinearGradient(0, r * h, 0, (r + 1) * h);
          grad.addColorStop(0, `rgb(${Math.round(120 * shade)}, ${Math.round(50 * shade)}, ${Math.round(35 * shade)})`);
          grad.addColorStop(1, `rgb(${Math.round(175 * shade)}, ${Math.round(78 * shade)}, ${Math.round(52 * shade)})`);
          c.fillStyle = grad;
          c.fillRect(x + 1, r * h + 1, h * 1.2 - 2, h - 2);
        }
      }
      break;
    }
    case "plaster":
    case "tenement":
      drawFacade(c, surface === "tenement", random);
      break;
  }
}

/**
 * Un étage de façade, deux travées (la texture fait 512 × 256 px : 6 m sur 3,6 m) : enduit taché
 * ou briques, un bandeau au plancher, et dans chaque travée une fenêtre à volets ; l'une a ses
 * carreaux soufflés et une traînée de suie au-dessus (la ville a brûlé).
 */
function drawFacade(c: Ctx, brick: boolean, random: () => number): void {
  const w = SURFACE_PX * 2;
  const h = SURFACE_PX;
  if (brick) {
    c.fillStyle = "#b9a891";
    c.fillRect(0, 0, w, h);
    const rows = 14;
    const bh = h / rows;
    for (let r = 0; r < rows; r++) {
      const offset = r % 2 ? bh * 1.1 : 0;
      for (let x = -bh * 2.2 + offset; x < w; x += bh * 2.2) {
        const shade = 0.8 + random() * 0.3;
        c.fillStyle = `rgb(${Math.round(146 * shade)}, ${Math.round(70 * shade)}, ${Math.round(50 * shade)})`;
        c.fillRect(x + 1.5, r * bh + 1.5, bh * 2.2 - 3, bh - 3);
      }
    }
  } else {
    c.fillStyle = "#c7bba3";
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 1400; i++) {
      const g = 150 + random() * 70;
      c.fillStyle = `rgba(${g}, ${g - 8}, ${g - 22}, 0.3)`;
      c.fillRect(random() * w, random() * h, 2 + random() * 5, 2 + random() * 5);
    }
    // Coulures de pluie
    for (let i = 0; i < 18; i++) {
      c.fillStyle = `rgba(90, 84, 72, ${0.08 + random() * 0.1})`;
      c.fillRect(random() * w, random() * h * 0.5, 3 + random() * 6, h * (0.3 + random() * 0.5));
    }
  }
  // Bandeau au plancher, en bas de l'étage
  c.fillStyle = brick ? "#d2c6b2" : "#a59b88";
  c.fillRect(0, h - 16, w, 16);
  c.fillStyle = "rgba(0, 0, 0, 0.25)";
  c.fillRect(0, h - 18, w, 3);
  for (let bay = 0; bay < 2; bay++) {
    const x0 = bay * SURFACE_PX + 78;
    const ww = 100;
    const y0 = 52;
    const wh = 140;
    const blown = bay === 1;
    if (blown) {
      // Suie au-dessus de la fenêtre soufflée
      const soot = c.createLinearGradient(0, y0 - 50, 0, y0 + 10);
      soot.addColorStop(0, "rgba(20, 18, 16, 0)");
      soot.addColorStop(1, "rgba(20, 18, 16, 0.75)");
      c.fillStyle = soot;
      c.beginPath();
      c.moveTo(x0 - 6, y0 + 10);
      c.lineTo(x0 + 18, y0 - 52);
      c.lineTo(x0 + ww - 14, y0 - 44);
      c.lineTo(x0 + ww + 6, y0 + 10);
      c.fill();
    }
    // Encadrement, puis la baie
    c.fillStyle = brick ? "#d8ccb6" : "#ddd3bf";
    c.fillRect(x0 - 8, y0 - 8, ww + 16, wh + 18);
    c.fillStyle = blown ? "#141312" : "#2a3138";
    c.fillRect(x0, y0, ww, wh);
    if (!blown) {
      // Carreaux et croisillons, un reflet
      c.fillStyle = "#4b5a66";
      c.fillRect(x0 + 6, y0 + 6, ww / 2 - 9, wh - 12);
      c.fillRect(x0 + ww / 2 + 3, y0 + 6, ww / 2 - 9, wh - 12);
      c.fillStyle = "rgba(220, 230, 240, 0.18)";
      c.fillRect(x0 + 10, y0 + 10, 14, wh - 30);
      c.fillStyle = "#c9c0ae";
      c.fillRect(x0 + ww / 2 - 3, y0, 6, wh);
      c.fillRect(x0, y0 + wh * 0.42, ww, 5);
    } else {
      // Quelques éclats de verre restés au cadre
      c.fillStyle = "#3d4a54";
      c.beginPath();
      c.moveTo(x0, y0); c.lineTo(x0 + 26, y0); c.lineTo(x0, y0 + 34); c.fill();
      c.beginPath();
      c.moveTo(x0 + ww, y0 + wh); c.lineTo(x0 + ww - 30, y0 + wh); c.lineTo(x0 + ww, y0 + wh - 22); c.fill();
    }
    // Volets ouverts, de part et d'autre
    c.fillStyle = blown ? "#3b3631" : brick ? "#4f6a5a" : "#6b5a44";
    c.fillRect(x0 - 34, y0, 24, wh);
    c.fillRect(x0 + ww + 10, y0, 24, wh);
    c.fillStyle = "rgba(0, 0, 0, 0.25)";
    for (let k = 0; k < 9; k++) {
      c.fillRect(x0 - 34, y0 + 8 + k * 15, 24, 3);
      c.fillRect(x0 + ww + 10, y0 + 8 + k * 15, 24, 3);
    }
    // Appui de fenêtre
    c.fillStyle = "#e2d9c7";
    c.fillRect(x0 - 12, y0 + wh + 8, ww + 24, 8);
  }
  // Impacts de balles, éclats d'enduit
  for (let i = 0; i < 26; i++) {
    c.fillStyle = "rgba(60, 55, 48, 0.55)";
    c.beginPath();
    c.arc(random() * w, random() * (h - 20), 2 + random() * 4, 0, Math.PI * 2);
    c.fill();
  }
}

/** Matériaux partagés : un par type d'accessoire (toutes les tailles d'un même mur le partagent). */
export class PropModels {
  private readonly scene: B.Scene;
  private readonly materials = new Map<string, B.StandardMaterial>();

  constructor(scene: B.Scene) {
    this.scene = scene;
  }

  /**
   * Mesh source d'un accessoire : à ses dimensions pour une dalle (`half`), sinon à sa taille
   * nominale (un arbre plus grand est une instance agrandie). `diamond` : une dalle posée en
   * losange, dont la texture est redressée. `char` : bois noirci par le feu (voir `CharLevel`).
   */
  source(type: PropType, half: Vec3 | null, diamond: boolean, char: CharLevel = 0): B.Mesh {
    const look = PROP_LOOKS[type];
    switch (look.kind) {
      case "painted":
        return this.painted(type, look, char);
      case "surface": {
        const h = half ?? { x: 0.5, y: 0.5, z: 0.5 };
        const mesh = B.MeshBuilder.CreateBox(`src-${type}`, { width: h.x * 2, height: h.y * 2, depth: h.z * 2, faceUV: faceUV(h, look.tile, look.tileY, look.fit), wrap: true }, this.scene);
        if (diamond) turnUVs(mesh, Math.PI / 4);
        return finish(mesh, this.surface(type, look.surface, char));
      }
      case "tree":
        return this.tree(type, look, char);
      case "cactus":
        return this.cactus(type, look);
      case "car":
        return this.car(type, half ?? CAR_HALF, look, char);
      case "lamp":
        return look.flood ? this.floodlight(type, look) : this.lamp(type, look);
    }
  }

  /**
   * La nuit : le verre des lampes s'allume, des fenêtres des façades s'éclairent (une texture émise
   * qui recouvre plusieurs motifs du mur, voir `WINDOW_TILES`) ; le jour, tout s'éteint. Vaut pour
   * les matières déjà faites et celles à venir.
   */
  setNight(on: boolean): void {
    if (on === this.night) return;
    this.night = on;
    for (const [key, mat] of this.materials) this.lightUp(key, mat);
  }

  private night = false;

  private lightUp(key: string, mat: B.StandardMaterial): void {
    if (key === "lamp-glass-lamppost" || key === "lamp-glass-floodlight") {
      const lit = this.night ? LAMP_GLASS[key === "lamp-glass-lamppost" ? "lamppost" : "floodlight"] : null;
      mat.diffuseColor = B.Color3.FromHexString(lit ?? LAMP_GLASS.day);
      mat.emissiveColor = lit ? B.Color3.FromHexString(lit) : B.Color3.Black();
      mat.disableLighting = !!lit;
      return;
    }
    if (key === "surface-facade-0" || key === "surface-tenement-0") {
      mat.emissiveTexture = this.night ? this.litWindows() : null;
    }
  }

  private windows: B.DynamicTexture | null = null;

  /** Les fenêtres éclairées des façades (les deux sortes de façade ont leurs fenêtres aux mêmes places). */
  private litWindows(): B.DynamicTexture {
    if (this.windows) return this.windows;
    // (à demi-résolution : il n'y a que des rectangles)
    const tw = SURFACE_PX;
    const th = SURFACE_PX / 2;
    const tex = new B.DynamicTexture("t-lit-windows", { width: tw * WINDOW_TILES.u, height: th * WINDOW_TILES.v }, this.scene, true);
    const c = context2d(tex);
    c.fillStyle = "#000000";
    c.fillRect(0, 0, tw * WINDOW_TILES.u, th * WINDOW_TILES.v);
    let seed = 777;
    const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let tu = 0; tu < WINDOW_TILES.u; tu++) {
      for (let tv = 0; tv < WINDOW_TILES.v; tv++) {
        for (let bay = 0; bay < 2; bay++) {
          // La même fenêtre que `drawFacade`, à demi-échelle ; la seconde travée a ses carreaux soufflés
          const x0 = tu * tw + (bay * SURFACE_PX + 78) / 2;
          const y0 = tv * th + 52 / 2;
          const ww = 100 / 2;
          const wh = 140 / 2;
          const roll = random();
          const blown = bay === 1;
          if (blown ? roll > FIRE_SHARE : roll > LIT_SHARE) continue;
          const tint = blown ? "#d0601e" : LIT_TINTS[Math.floor(random() * LIT_TINTS.length)];
          // Plus clair en bas (la lampe est dans la pièce), plus sombre en haut
          const g = c.createLinearGradient(0, y0, 0, y0 + wh);
          g.addColorStop(0, "#000000");
          g.addColorStop(0.35, tint);
          g.addColorStop(1, tint);
          c.fillStyle = g;
          c.fillRect(x0, y0, ww, wh);
          if (!blown) {
            // Croisillons et rideaux
            c.fillStyle = "#000000";
            c.fillRect(x0 + ww / 2 - 1.5, y0, 3, wh);
            c.fillRect(x0, y0 + wh * 0.42, ww, 2.5);
            if (random() < 0.5) c.fillRect(x0 + (random() < 0.5 ? 0 : ww * 0.62), y0, ww * 0.38, wh);
          }
        }
      }
    }
    tex.update();
    tex.wrapU = tex.wrapV = B.Texture.WRAP_ADDRESSMODE;
    tex.uScale = 1 / WINDOW_TILES.u;
    tex.vScale = 1 / WINDOW_TILES.v;
    this.windows = tex;
    return tex;
  }

  /** Éclat d'un accessoire (un cube de 1 m, à mettre à sa taille) : de sa matière, ou l'accessoire en réduction s'il est peint. */
  shard(type: PropType): B.Mesh | null {
    const look = PROP_LOOKS[type];
    if (look.kind === "painted") return null;
    const mesh = B.MeshBuilder.CreateBox(`src-shard-${type}`, { size: 1 }, this.scene);
    const material = look.kind === "surface" ? this.surface(type, look.surface)
      : look.kind === "tree" ? this.solid(`bark-${type}`, look.bark)
      : look.kind === "car" ? this.solid(`shard-${type}`, charred(look.paint, 2))
      : look.kind === "lamp" ? this.solid(`metal-${type}`, look.metal)
      : this.solid(`skin-${type}`, look.skin);
    return finish(mesh, material);
  }

  /**
   * Cactus à sa taille nominale : un cierge (le corps de l'accessoire, bout arrondi) et deux bras
   * qui se redressent, côtelés (une texture à bandes verticales). Il ne brûle pas : pas de noirci.
   */
  private cactus(type: PropType, look: { skin: string; rib: string }): B.Mesh {
    const shape = propDef(type).shape;
    if (shape.kind !== "cylinder") throw new Error(`Cactus sans tronc : ${type}`);
    const mat = this.material(`cactus-${type}`, () => {
      const tex = new B.DynamicTexture(`t-cactus-${type}`, { width: 64, height: 64 }, this.scene, true);
      const c = context2d(tex);
      c.fillStyle = look.skin;
      c.fillRect(0, 0, 64, 64);
      c.fillStyle = look.rib;
      for (let x = 0; x < 64; x += 8) c.fillRect(x, 0, 3, 64);
      tex.update();
      const m = new B.StandardMaterial(`cactus-${type}`, this.scene);
      m.diffuseTexture = tex;
      m.specularColor = new B.Color3(0.08, 0.08, 0.08);
      return m;
    });
    const r = shape.radius;
    const hh = shape.halfHeight;
    const column = (height: number, radius: number, x: number, y: number, z: number): B.Mesh[] => {
      const body = B.MeshBuilder.CreateCylinder("cactus", { height, diameter: radius * 2, tessellation: 10 }, this.scene);
      body.position.set(x, y, z);
      const tip = B.MeshBuilder.CreateSphere("cactus-tip", { diameter: radius * 2, segments: 6, slice: 0.5 }, this.scene);
      tip.position.set(x, y + height / 2, z);
      return [body, tip];
    };
    const arm = (side: number, at: number, reach: number, rise: number): B.Mesh[] => {
      const ar = r * 0.62;
      const elbow = B.MeshBuilder.CreateCylinder("cactus-arm", { height: reach, diameter: ar * 2, tessellation: 8 }, this.scene);
      elbow.rotation.z = Math.PI / 2;
      elbow.position.set(side * (r + reach / 2 - 0.05), at, 0);
      const joint = B.MeshBuilder.CreateSphere("cactus-joint", { diameter: ar * 2, segments: 6 }, this.scene);
      joint.position.set(side * (r + reach - 0.05), at, 0);
      return [elbow, joint, ...column(rise, ar, side * (r + reach - 0.05), at + rise / 2, 0)];
    };
    const parts = [...column(hh * 2, r, 0, 0, 0), ...arm(1, -hh * 0.05, 0.55, hh * 0.7), ...arm(-1, hh * 0.25, 0.45, hh * 0.5)];
    for (const p of parts) {
      p.material = mat;
      p.bakeCurrentTransformIntoVertices();
    }
    const merged = B.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    if (!merged) throw new Error(`Impossible de construire le cactus ${type}`);
    merged.name = `src-prop-${type}`;
    return finish(merged, mat);
  }

  private surface(type: PropType, surface: Surface, char: CharLevel = 0): B.StandardMaterial {
    return this.material(`surface-${type}-${char}`, () => {
      // Le bois noirci garde son motif (la même texture), assombri
      const wide = surface === "plaster" || surface === "tenement"; // deux travées côte à côte
      const tex = char ? this.surface(type, surface).diffuseTexture! : new B.DynamicTexture(`t-surface-${type}`, { width: SURFACE_PX * (wide ? 2 : 1), height: SURFACE_PX }, this.scene, true);
      if (!char) {
        drawSurface(context2d(tex as B.DynamicTexture), surface);
        (tex as B.DynamicTexture).update();
        tex.wrapU = tex.wrapV = B.Texture.WRAP_ADDRESSMODE;
        tex.anisotropicFilteringLevel = 4;
      }
      const mat = new B.StandardMaterial(`surface-${type}-${char}`, this.scene);
      mat.diffuseTexture = tex;
      mat.diffuseColor = CHAR_TINT[char];
      mat.specularColor = surface === "sheet" ? new B.Color3(0.3, 0.3, 0.3) : new B.Color3(0.05, 0.05, 0.05);
      return mat;
    });
  }

  private solid(name: string, color: string): B.StandardMaterial {
    return this.material(name, () => {
      const mat = new B.StandardMaterial(name, this.scene);
      mat.diffuseColor = B.Color3.FromHexString(color);
      mat.specularColor = new B.Color3(0.04, 0.04, 0.04);
      return mat;
    });
  }

  private material(key: string, build: () => B.StandardMaterial): B.StandardMaterial {
    let mat = this.materials.get(key);
    if (!mat) {
      mat = build();
      this.materials.set(key, mat);
      if (this.night) this.lightUp(key, mat);
    }
    return mat;
  }

  /** Caisse, baril, bouteille, citerne : une boîte ou un cylindre peint, avec un motif ; noirci par le feu (`char`), assombri. */
  private painted(type: PropType, look: { fill: string; stripe: string; staves?: boolean; cap?: string }, char: CharLevel = 0): B.Mesh {
    const shape = propDef(type).shape;
    const tex = new B.DynamicTexture(`t-prop-${type}`, { width: 128, height: 128 }, this.scene, true);
    const c = context2d(tex);
    c.fillStyle = look.fill;
    c.fillRect(0, 0, 128, 128);
    c.strokeStyle = look.stripe;
    if (shape.kind === "box") {
      c.lineWidth = 8;
      c.strokeRect(4, 4, 120, 120);
      c.lineWidth = 6;
      c.beginPath(); c.moveTo(12, 12); c.lineTo(116, 116); c.stroke();
    } else if (look.staves) {
      // Douves de bois (des joints sombres), cerclées de trois feuillards
      c.fillStyle = "rgba(40, 25, 12, 0.55)";
      for (let x = 0; x < 128; x += 11) c.fillRect(x, 0, 2, 128);
      c.fillStyle = look.stripe;
      for (const y of [14, 60, 106]) c.fillRect(0, y, 128, 6);
    } else {
      // Bandeaux autour du cylindre (danger pour le baril et la citerne, étiquette pour la bouteille)
      c.fillStyle = look.stripe;
      c.fillRect(0, 22, 128, 14);
      c.fillRect(0, 92, 128, 14);
    }
    tex.update();
    const mat = new B.StandardMaterial(`prop-${type}-${char}`, this.scene);
    mat.diffuseTexture = tex;
    mat.diffuseColor = CHAR_TINT[char];
    mat.specularColor = new B.Color3(0.25, 0.25, 0.25);
    const mesh = shape.kind === "cylinder"
      ? B.MeshBuilder.CreateCylinder(`src-prop-${type}`, { height: shape.halfHeight * 2, diameter: shape.radius * 2, tessellation: type === "tank" ? 28 : 18 }, this.scene)
      : B.MeshBuilder.CreateBox(`src-prop-${type}`, { size: shape.kind === "box" ? shape.half * 2 : 1 }, this.scene);
    if (!look.cap || shape.kind !== "cylinder") return finish(mesh, mat);
    // Un toit conique, un peu débordant (une seule matière : le cône prend la teinte du toit par ses sommets)
    const cap = B.MeshBuilder.CreateCylinder("cap", { height: shape.radius * 0.7, diameterTop: 0, diameterBottom: shape.radius * 2.3, tessellation: 18 }, this.scene);
    cap.position.y = shape.halfHeight + shape.radius * 0.35;
    cap.bakeCurrentTransformIntoVertices();
    const capColor = B.Color3.FromHexString(look.cap).multiply(CHAR_TINT[char]);
    cap.setVerticesData(B.VertexBuffer.ColorKind, new Array(cap.getTotalVertices()).fill([capColor.r, capColor.g, capColor.b, 1]).flat());
    mesh.setVerticesData(B.VertexBuffer.ColorKind, new Array(mesh.getTotalVertices()).fill([1, 1, 1, 1]).flat());
    const merged = B.Mesh.MergeMeshes([mesh, cap], true, true);
    if (!merged) throw new Error(`Impossible de construire ${type}`);
    merged.name = `src-prop-${type}`;
    return finish(merged, mat);
  }

  /**
   * Arbre à sa taille nominale : un tronc (le corps de l'accessoire) et son feuillage, qui ne heurte
   * rien. Brûlé (`char`), l'écorce noircit et le feuillage roussit, puis se calcine.
   */
  private tree(type: PropType, look: { foliage: Foliage; bark: string; leaves: string }, char: CharLevel = 0): B.Mesh {
    const shape = propDef(type).shape;
    if (shape.kind !== "cylinder") throw new Error(`Arbre sans tronc : ${type}`);
    const hh = shape.halfHeight;
    const bark = this.solid(`bark-${type}-${char}`, charred(look.bark, char));
    const leaves = this.solid(`leaves-${type}-${char}`, char ? BURNT_LEAVES[char - 1] : look.leaves);
    // Le stipe d'un palmier est presque droit ; le tronc d'un fromager s'évase en contreforts
    const flare = look.foliage === "palm" ? 1.5 : 2.4;
    const trunk = B.MeshBuilder.CreateCylinder("trunk", { height: hh * 2, diameterTop: shape.radius * 1.2, diameterBottom: shape.radius * flare, tessellation: 8 }, this.scene);
    trunk.material = bark;
    const parts: B.Mesh[] = [trunk];
    if (look.foliage === "palm") {
      // Une couronne de palmes qui retombent, alternées, et des noix de coco dessous
      const count = 9;
      for (let i = 0; i < count; i++) {
        const yaw = (i / count) * Math.PI * 2 + (i % 2) * 0.25;
        const droop = 0.3 + (i % 3) * 0.16;
        const length = 2.9 - (i % 2) * 0.4;
        const frond = B.MeshBuilder.CreateBox("frond", { width: 0.62, height: 0.05, depth: length }, this.scene);
        frond.rotation.set(droop, yaw, 0);
        const reach = (length / 2) * Math.cos(droop);
        frond.position.set(Math.sin(yaw) * reach, hh + 0.15 - (length / 2) * Math.sin(droop), Math.cos(yaw) * reach);
        frond.material = leaves;
        parts.push(frond);
      }
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        const nut = B.MeshBuilder.CreateIcoSphere("coconut", { radius: 0.15, subdivisions: 1, flat: true }, this.scene);
        nut.position.set(Math.cos(a) * 0.24, hh - 0.25, Math.sin(a) * 0.24);
        nut.material = bark;
        parts.push(nut);
      }
    } else if (look.foliage === "parasol") {
      // Une large cime aplatie, en plusieurs masses, et des contreforts au pied du tronc
      const canopy: [number, number, number, number, number][] = [
        [0, hh + 0.4, 0, 4.4, 1.5], [2.4, hh - 0.5, 1.1, 2.6, 1.1], [-2.2, hh - 0.3, -1.4, 2.7, 1.2], [0.8, hh - 0.6, -2.6, 2.4, 1], [-1.2, hh - 0.4, 2.5, 2.4, 1],
      ];
      for (const [x, y, z, r, h] of canopy) {
        const mass = B.MeshBuilder.CreateIcoSphere("canopy", { radiusX: r, radiusY: h, radiusZ: r, subdivisions: 2, flat: true }, this.scene);
        mass.position.set(x, y, z);
        mass.material = leaves;
        parts.push(mass);
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.3;
        const fin = B.MeshBuilder.CreateBox("buttress", { width: 0.14, height: 1.7, depth: 1.5 }, this.scene);
        fin.rotation.y = a;
        fin.position.set(Math.sin(a) * 0.75, -hh + 0.75, Math.cos(a) * 0.75);
        fin.material = bark;
        parts.push(fin);
      }
    } else if (look.foliage === "cone") {
      // Étages de branches, de plus en plus étroits vers la cime
      for (let i = 0; i < 4; i++) {
        const cone = B.MeshBuilder.CreateCylinder("boughs", { height: 3, diameterTop: 0, diameterBottom: 4.6 - i * 0.95, tessellation: 9 }, this.scene);
        cone.position.y = -hh + 3.4 + i * 1.65;
        cone.material = leaves;
        parts.push(cone);
      }
    } else {
      const balls: [number, number, number, number][] = [[0, hh - 0.6, 0, 2.6], [1.3, hh - 1.4, 0.4, 1.9], [-1.2, hh - 1.2, -0.5, 2], [0.2, hh - 1.6, -1.3, 1.8], [-0.3, hh + 0.6, 0.6, 1.8]];
      for (const [x, y, z, r] of balls) {
        const ball = B.MeshBuilder.CreateIcoSphere("leaves", { radius: r, subdivisions: 1, flat: true }, this.scene);
        ball.position.set(x, y, z);
        ball.material = leaves;
        parts.push(ball);
      }
    }
    for (const p of parts) p.bakeCurrentTransformIntoVertices();
    const merged = B.Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    if (!merged) throw new Error(`Impossible de construire l'arbre ${type}`);
    merged.name = `src-prop-${type}`;
    merged.isVisible = false;
    merged.receiveShadows = true;
    return merged;
  }

  /**
   * Une voiture à ses dimensions (`h` : l'avant vers +x, le toit vers +y) : caisse, capot, habitacle
   * vitré, toit, pare-chocs, phares et roues. Brûlée (une épave), la caisse est rouillée, les vitres
   * ont disparu, les pneus aussi (elle repose sur ses jantes). Le feu l'assombrit (`char`).
   */
  private car(type: PropType, h: Vec3, look: { paint: string; burnt: boolean }, char: CharLevel): B.Mesh {
    const paint = this.solid(`paint-${type}-${char}`, charred(look.paint, char));
    const dark = this.solid(`car-dark-${look.burnt ? "burnt" : "ok"}-${char}`, charred(look.burnt ? "#1c1a18" : "#23282d", char));
    const trim = this.solid(`car-trim-${char}`, charred("#3a3a3a", char));
    const glass = this.solid(`car-glass-${char}`, charred("#3d4c58", char));
    const light = this.solid(`car-light-${look.burnt ? "burnt" : "ok"}-${char}`, charred(look.burnt ? "#2c2a28" : "#e8e2c4", char));
    const parts: B.Mesh[] = [];
    const block = (mat: B.StandardMaterial, x: number, y: number, z: number, sx: number, sy: number, sz: number, tilt = 0): void => {
      const m = B.MeshBuilder.CreateBox("car-part", { width: sx, height: sy, depth: sz }, this.scene);
      m.position.set(x, y, z);
      m.rotation.z = tilt;
      m.material = mat;
      parts.push(m);
    };
    const L = h.x;
    const H = h.y;
    const W = h.z;
    const wheelR = look.burnt ? 0.27 : 0.33;
    const bodyLow = -H + wheelR + 0.06;
    const bodyTop = bodyLow + 0.55;
    const cabinTop = H - 0.1;
    const cabinMid = (bodyTop + cabinTop) / 2;
    // Caisse, capot, habitacle (vitré, ou vide sur une épave), montants, toit
    block(paint, 0, (bodyLow + bodyTop) / 2, 0, 2 * L, bodyTop - bodyLow, 2 * W);
    block(paint, L * 0.62, bodyTop + 0.03, 0, L * 0.7, 0.06, 2 * W * 0.96, -0.06);
    block(look.burnt ? dark : glass, -L * 0.08, cabinMid, 0, L * 0.95, cabinTop - bodyTop, 2 * W * 0.88);
    block(paint, L * 0.38, cabinMid, 0, 0.1, cabinTop - bodyTop, 2 * W * 0.9);
    block(paint, -L * 0.55, cabinMid, 0, 0.12, cabinTop - bodyTop, 2 * W * 0.9);
    block(paint, -L * 0.1, cabinTop + 0.05, 0, L * 0.9, 0.1, 2 * W * 0.86, look.burnt ? 0.05 : 0);
    // Pare-chocs, phares, bas de caisse
    for (const s of [-1, 1]) block(trim, s * (L - 0.04), bodyLow + 0.12, 0, 0.14, 0.2, 2 * W * 0.98);
    for (const s of [-1, 1]) block(light, L - 0.02, bodyLow + 0.36, s * W * 0.68, 0.06, 0.12, 0.34);
    for (const s of [-1, 1]) block(dark, 0, bodyLow + 0.02, s * (W - 0.02), L, 0.08, 0.06);
    // Roues (des jantes nues sur une épave)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const wheel = B.MeshBuilder.CreateCylinder("car-wheel", { height: 0.24, diameter: wheelR * 2, tessellation: 14 }, this.scene);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(sx * L * 0.64, -H + wheelR, sz * (W - 0.1));
        wheel.material = look.burnt ? trim : dark;
        parts.push(wheel);
      }
    }
    return mergeParts(parts, `src-prop-${type}`);
  }

  /** Un lampadaire à sa taille nominale : socle, mât, potence et lanterne, autour de son axe (le corps de l'accessoire). */
  private lamp(type: PropType, look: { metal: string }): B.Mesh {
    const shape = propDef(type).shape;
    if (shape.kind !== "cylinder") throw new Error(`Lampadaire sans mât : ${type}`);
    const hh = shape.halfHeight;
    const metal = this.solid(`metal-${type}`, look.metal);
    const glass = this.solid("lamp-glass-lamppost", LAMP_GLASS.day);
    const base = B.MeshBuilder.CreateCylinder("lamp-base", { height: 0.7, diameterTop: 0.22, diameterBottom: 0.36, tessellation: 10 }, this.scene);
    base.position.y = -hh + 0.35;
    const pole = B.MeshBuilder.CreateCylinder("lamp-pole", { height: hh * 2, diameterTop: 0.1, diameterBottom: 0.16, tessellation: 10 }, this.scene);
    const arm = B.MeshBuilder.CreateBox("lamp-arm", { width: 1.3, height: 0.08, depth: 0.08 }, this.scene);
    arm.position.set(0.6, hh - 0.15, 0);
    const head = B.MeshBuilder.CreateBox("lamp-head", { width: 0.6, height: 0.14, depth: 0.3 }, this.scene);
    head.position.set(1.15, hh - 0.2, 0);
    for (const m of [base, pole, arm, head]) m.material = metal;
    const lens = B.MeshBuilder.CreateBox("lamp-lens", { width: 0.5, height: 0.04, depth: 0.24 }, this.scene);
    lens.position.set(1.15, hh - 0.29, 0);
    lens.material = glass;
    return mergeParts([base, pole, arm, head, lens], `src-prop-${type}`);
  }

  /**
   * Mât d'éclairage : un socle, un mât effilé, en haut une traverse et trois projecteurs penchés
   * vers son +x (la direction de son bras, comme un lampadaire), leur verre sur leur face avant.
   */
  private floodlight(type: PropType, look: { metal: string }): B.Mesh {
    const shape = propDef(type).shape;
    if (shape.kind !== "cylinder") throw new Error(`Mât d'éclairage sans mât : ${type}`);
    const hh = shape.halfHeight;
    const metal = this.solid(`metal-${type}`, look.metal);
    const dark = this.solid("flood-housing", "#2c3135");
    const glass = this.solid("lamp-glass-floodlight", LAMP_GLASS.day);
    const parts: B.Mesh[] = [];
    const add = (m: B.Mesh, mat: B.StandardMaterial): void => {
      m.material = mat;
      parts.push(m);
    };
    const base = B.MeshBuilder.CreateCylinder("flood-base", { height: 0.9, diameterTop: 0.3, diameterBottom: 0.5, tessellation: 10 }, this.scene);
    base.position.y = -hh + 0.45;
    add(base, metal);
    const pole = B.MeshBuilder.CreateCylinder("flood-pole", { height: hh * 2 - 0.3, diameterTop: 0.14, diameterBottom: 0.26, tessellation: 10 }, this.scene);
    pole.position.y = -0.15;
    add(pole, metal);
    // La traverse, en travers de l'axe des projecteurs, et sa console
    const bar = B.MeshBuilder.CreateBox("flood-bar", { width: 0.12, height: 0.12, depth: 1.9 }, this.scene);
    bar.position.set(0.18, hh - 0.35, 0);
    add(bar, metal);
    const bracket = B.MeshBuilder.CreateBox("flood-bracket", { width: 0.36, height: 0.1, depth: 0.12 }, this.scene);
    bracket.position.set(0.06, hh - 0.35, 0);
    add(bracket, metal);
    // Trois projecteurs, penchés de 35° vers le bas, vers +x
    const tilt = -0.6;
    for (const z of [-0.62, 0, 0.62]) {
      const housing = B.MeshBuilder.CreateBox("flood-head", { width: 0.16, height: 0.38, depth: 0.5 }, this.scene);
      housing.rotation.z = tilt;
      housing.position.set(0.32, hh - 0.18, z);
      add(housing, dark);
      const lens = B.MeshBuilder.CreateBox("flood-lens", { width: 0.03, height: 0.32, depth: 0.42 }, this.scene);
      lens.rotation.z = tilt;
      lens.position.set(0.32 + Math.cos(tilt) * 0.09, hh - 0.18 + Math.sin(tilt) * 0.09, z);
      add(lens, glass);
    }
    return mergeParts(parts, `src-prop-${type}`);
  }
}

/** Fusionne des pièces (chacune avec sa matière) en un mesh source invisible, qui reçoit les ombres. */
function mergeParts(parts: B.Mesh[], name: string): B.Mesh {
  for (const p of parts) p.bakeCurrentTransformIntoVertices();
  const merged = B.Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  if (!merged) throw new Error(`Impossible de construire ${name}`);
  merged.name = name;
  merged.isVisible = false;
  merged.receiveShadows = true;
  return merged;
}

/**
 * Coordonnées de texture de chaque face d'une boîte : le motif se répète tous les `tile` m (en
 * hauteur, tous les `tileY` m) ; `fit` : un nombre entier de motifs sur une face assez large (des
 * fenêtres entières sur un pan de façade).
 */
function faceUV(h: Vec3, tile: number, tileY = tile, fit = false): B.Vector4[] {
  const along = (m: number): number => (fit && m >= tile * 0.6 ? Math.max(1, Math.round(m / tile)) : m / tile);
  const w = along(2 * h.x);
  const y = (2 * h.y) / tileY;
  const d = along(2 * h.z);
  return [new B.Vector4(0, 0, w, y), new B.Vector4(0, 0, w, y), new B.Vector4(0, 0, d, y), new B.Vector4(0, 0, d, y), new B.Vector4(0, 0, w, d), new B.Vector4(0, 0, w, d)];
}

/** Tourne les coordonnées de texture d'un mesh (autour de l'origine de la texture). */
function turnUVs(mesh: B.Mesh, angle: number): void {
  const uvs = mesh.getVerticesData(B.VertexBuffer.UVKind);
  if (!uvs) return;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = 0; i < uvs.length; i += 2) {
    const [u, v] = [uvs[i], uvs[i + 1]];
    uvs[i] = u * c - v * s;
    uvs[i + 1] = u * s + v * c;
  }
  mesh.setVerticesData(B.VertexBuffer.UVKind, uvs);
}

function finish(mesh: B.Mesh, material: B.Material): B.Mesh {
  mesh.material = material;
  mesh.isVisible = false;
  mesh.receiveShadows = true;
  return mesh;
}
