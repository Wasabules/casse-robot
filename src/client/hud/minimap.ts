import { lavaAt } from "../../shared/arena/features";
import { spotPose, type ArenaLayout, type BoxLook, type PropSpot, type StaticBox, type StaticKind } from "../../shared/arena/layout";
import { terrainHeight } from "../../shared/arena/terrain";
import { propDef, type PropType } from "../../shared/catalog/props";
import { clamp } from "../../shared/math/scalar";
import { norm, qrot, vec3, type Quat, type Vec3 } from "../../shared/math/vec";
import type { Bot, Prop } from "../../shared/sim/entities";
import type { SimEvent } from "../../shared/sim/events";
import type { World } from "../../shared/sim/world";
import { byId } from "../dom";
import { groundColor } from "../render/arenaView";
import { TEAM_COLORS } from "../teams";
import { arenaName, placeLabel } from "../i18n/names";

type Ctx = CanvasRenderingContext2D;

/*
 * Mini-carte (en haut à droite) et carte entière (touche M). Le nord (+z) est en haut ; le repère
 * est direct, comme la vue 3D : l'ouest (+x) est donc à gauche. Le fond (sol, relief ombré, eau,
 * chemins, décor fixe) est calculé une fois par arène ; les bâtiments et les arbres debout sont
 * sur une couche à part, redessinée quand l'un d'eux tombe ; zones, robots et regard de la caméra
 * sont redessinés à chaque rafraîchissement. On ne voit que les ennemis que son équipe a repérés.
 */

/** Rafraîchissement des cartes (s). */
const REFRESH = 0.1;
/** Demi-côté de ce que montre la mini-carte au plus (m) : dans une grande arène, les environs du joueur. */
const MINI_RANGE = 60;
/** Résolution du fond (px par m), et ses bornes (px). */
const BACKGROUND_DENSITY = 3;
const BACKGROUND_MIN = 256;
const BACKGROUND_MAX = 640;
/** Regard de la caméra : demi-angle (rad) et longueur (en part de la carte) du cône. */
const VIEW_HALF_ANGLE = 0.5;
const VIEW_LENGTH = 0.16;

/** Couleur de chaque sorte de boîte du décor sur la carte. */
const BOX_COLORS: Record<StaticKind, string> = {
  wall: "#c9d2d8", ramp: "#76828b", pillar: "#1b2126", platform: "#8a969f", barrier: "#2b333a",
  rock: "#58554f", container: "#8b5a42", deck: "#a39d90", road: "#3a3d40", bound: "transparent",
  tower: "#2e3236", track: "#4d443c",
};
/**
 * Couleur d'une boîte qui a son apparence : le grès est à demi transparent (on voit la voie sous
 * le toit d'un tunnel), la charpente, la voie, les wagons, les planches, le basalte et la rouille ont leur teinte.
 */
const LOOK_COLORS: Record<BoxLook, string> = {
  sandstone: "rgba(168, 84, 52, 0.55)", timber: "#5e4128", rail: "#4b3d33", wagon: "#7d3122", wood: "#8a6a45", basalt: "#3c3733", rust: "#7a4a30",
  quay: "#8f8c85", steel: "#c98a34", hull: "#5b2b26", superstructure: "#e2e0d8", hatch: "#4b6a46", funnel: "#2a2c2e",
  lighthouse: "#efede6", lamp: "#ffe08a", silo: "#c8c3b7", container: "#2f5f8a",
};
/** Ordre de dessin : ce sur quoi l'on roule d'abord, les obstacles par-dessus. */
const BOX_ORDER: readonly StaticKind[] = ["road", "track", "deck", "ramp", "platform", "wall", "barrier", "container", "rock", "pillar", "tower"];

/** Ce que la carte montre des accessoires ancrés debout : murs, toits (par-dessus), citernes, arbres (pas les pignons, sous les toits). */
const STRUCTURE_COLORS: Partial<Record<PropType, string>> = {
  brick: "#a55842", concrete: "#a7adb1", plank: "#9b7852", sheet: "#8e9ba5", roof: "#7c3a2c", tank: "#dde1db",
  pine: "rgba(34, 70, 38, 0.9)", oak: "rgba(52, 88, 40, 0.9)", palm: "rgba(62, 110, 44, 0.85)", kapok: "rgba(30, 72, 32, 0.9)",
  cactus: "rgba(58, 96, 46, 0.9)", watertank: "#8e6a45", facade: "#b9ae9a", tenement: "#9c5844", wreck: "#5a4f45",
};
/** Rayon du feuillage d'un arbre sur la carte, à l'échelle 1 (m). */
const CROWN: Partial<Record<PropType, number>> = { pine: 2.2, oak: 2.8, palm: 2.2, kapok: 4.2, cactus: 0.9 };

/** Ce que montre une carte : son centre (x, z) et son demi-côté (m). */
interface View {
  x: number;
  z: number;
  half: number;
}

/** Accessoire ancré debout, tel que la carte le dessine : une emprise, ou un cercle. */
export interface Standing {
  color: string;
  polygon: Vec3[] | null;
  circle: { x: number; z: number; r: number } | null;
}

export class MiniMap {
  private readonly mini: HTMLCanvasElement;
  private readonly big: HTMLCanvasElement;
  private layout: ArenaLayout | null = null;
  /** Demi-côté du fond (m), centré sur l'origine. */
  private extent = 40;
  private readonly background = document.createElement("canvas");
  private readonly structures = document.createElement("canvas");
  private readonly standing = new Map<Prop, Standing>();
  private structuresDirty = true;
  private timer = 0;
  private detected: ((bot: Bot) => boolean) | null = null;
  private bigOpen = false;

  constructor() {
    this.mini = byId<HTMLCanvasElement>("minimapCanvas");
    this.big = byId<HTMLCanvasElement>("bigmapCanvas");
    // Au doigt (sans touche M), le bouton sous la mini-carte ouvre et ferme la carte entière
    byId("mmMap").addEventListener("click", () => this.toggleBig());
  }

  get bigMapOpen(): boolean {
    return this.bigOpen;
  }

  /** Ouvre ou ferme la carte entière. */
  toggleBig(open = !this.bigOpen): void {
    this.bigOpen = open;
    byId("bigmap").hidden = !open;
    byId("mmMap").setAttribute("aria-pressed", String(open));
    this.timer = 0;
  }

  /** Ennemis que l'équipe du joueur a repérés (null : tout est visible, caméra libre). */
  setDetection(detected: ((bot: Bot) => boolean) | null): void {
    this.detected = detected;
  }

  /** Les bâtiments et les arbres debout, d'après les événements du monde affiché. */
  onWorldEvent(e: SimEvent): void {
    switch (e.type) {
      case "propAdded":
        if (e.prop.fixed) this.addStanding(e.prop);
        break;
      case "propRemoved":
      case "propReleased":
        if (this.standing.delete(e.prop)) this.structuresDirty = true;
        break;
      default:
        break;
    }
  }

  /** Le monde affiché change (partie en réseau, ou retour en local) : on oublie ses accessoires. */
  clear(): void {
    this.standing.clear();
    this.structuresDirty = true;
  }

  /** La langue a changé : le titre de la carte entière (les noms des lieux se redessinent à chaque image). */
  refreshTexts(): void {
    if (this.layout) byId("bigmap-title").textContent = arenaName(this.layout);
  }

  /** Nouvelle arène : son fond est recalculé. */
  setArena(layout: ArenaLayout): void {
    if (layout === this.layout) return;
    this.layout = layout;
    this.extent = mapExtent(layout);
    const size = Math.round(clamp(this.extent * 2 * BACKGROUND_DENSITY, BACKGROUND_MIN, BACKGROUND_MAX));
    for (const c of [this.background, this.structures]) c.width = c.height = size;
    drawBackground(this.background, layout, this.extent);
    this.structuresDirty = true;
    byId("bigmap-title").textContent = arenaName(layout);
  }

  /**
   * À chaque image : la mini-carte (centrée sur `center`, le joueur ou ce que regarde la caméra
   * libre) et, si elle est ouverte, la carte entière ; `look` : direction horizontale de la caméra.
   */
  update(dt: number, world: World, center: Vec3, look: Vec3): void {
    const layout = this.layout;
    if (!layout) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = REFRESH;
    if (this.structuresDirty) this.drawStructures();
    const half = Math.min(this.extent, MINI_RANGE);
    const edge = this.extent - half;
    const miniView: View = { x: clamp(center.x, -edge, edge), z: clamp(center.z, -edge, edge), half };
    this.draw(this.mini, miniView, world, center, look, false);
    if (this.bigOpen) this.draw(this.big, { x: 0, z: 0, half: this.extent }, world, center, look, true);
  }

  private addStanding(prop: Prop): void {
    const spot = this.layout?.props[prop.spot];
    const standing = spot && standingOf(spot, prop.half);
    if (!standing) return;
    this.standing.set(prop, standing);
    this.structuresDirty = true;
  }

  private drawStructures(): void {
    this.structuresDirty = false;
    const c = this.structures.getContext("2d")!;
    const size = this.structures.width;
    c.clearRect(0, 0, size, size);
    paintStanding(c, this.standing.values(), this.extent, size / (2 * this.extent));
  }

  /** Une carte : le fond et les bâtiments dans sa fenêtre, puis zones, robots et regard de la caméra. */
  private draw(canvas: HTMLCanvasElement, view: View, world: World, center: Vec3, look: Vec3, big: boolean): void {
    const px = fitCanvas(canvas);
    const c = canvas.getContext("2d")!;
    const scale = px / (2 * view.half); // px par m
    const sx = (x: number): number => px / 2 + (view.x - x) * scale;
    const sy = (z: number): number => px / 2 + (view.z - z) * scale;
    // Le fond et les bâtiments : la part de leur toile qui correspond à la fenêtre
    const k = this.background.width / (2 * this.extent);
    const left = (this.extent - view.x - view.half) * k;
    const top = (this.extent - view.z - view.half) * k;
    const side = 2 * view.half * k;
    c.clearRect(0, 0, px, px);
    c.drawImage(this.background, left, top, side, side, 0, 0, px, px);
    c.drawImage(this.structures, left, top, side, side, 0, 0, px, px);
    const unit = (big ? 1.5 : 1) * (window.devicePixelRatio || 1);
    const layout = this.layout!;

    // Limite de la zone de jeu d'une grande arène (le pied des montagnes)
    if (layout.terrain) {
      const h = layout.bounds.half;
      c.setLineDash([4 * unit, 4 * unit]);
      c.strokeStyle = "rgba(240, 244, 247, 0.45)";
      c.lineWidth = unit;
      c.strokeRect(sx(h), sy(h), 2 * h * scale, 2 * h * scale);
      c.setLineDash([]);
    }

    // Zones à capturer : à la couleur de l'équipe qui les tient ; la colline seule en jeu
    const zones = world.match?.zones ?? [];
    c.textAlign = "center";
    c.textBaseline = "middle";
    zones.forEach((z, i) => {
      const zone = layout.zones[i];
      if (!zone) return;
      const color = z.owner ? TEAM_COLORS[z.owner] : "#e5ecf1";
      const r = Math.max(zone.radius * scale, 5 * unit);
      c.globalAlpha = z.active ? 1 : 0.3;
      c.beginPath();
      c.arc(sx(zone.pos.x), sy(zone.pos.z), r, 0, Math.PI * 2);
      c.fillStyle = z.owner ? hexAlpha(color, 0.35) : "rgba(229, 236, 241, 0.16)";
      c.fill();
      c.lineWidth = 1.5 * unit;
      c.strokeStyle = z.contested ? "#f0bd2c" : color;
      c.stroke();
      c.fillStyle = "#f4f7f9";
      c.font = `700 ${Math.round(9 * unit)}px "Chakra Petch", sans-serif`;
      c.fillText(zone.label, sx(zone.pos.x), sy(zone.pos.z) + 0.5);
      c.globalAlpha = 1;
    });

    // Lieux nommés (carte entière)
    if (big && layout.places) {
      c.font = `600 ${Math.round(10 * unit)}px "Chakra Petch", sans-serif`;
      c.lineWidth = 3 * unit;
      c.strokeStyle = "rgba(10, 14, 20, 0.75)";
      c.fillStyle = "#f0f3f5";
      for (const p of layout.places) {
        const y = sy(p.z) - 14 * unit;
        const label = placeLabel(p).toUpperCase();
        c.strokeText(label, sx(p.x), y);
        c.fillText(label, sx(p.x), y);
      }
    }

    // Regard de la caméra : un cône clair depuis le joueur (ou ce que regarde la caméra libre)
    const heading = Math.atan2(-look.z, -look.x); // angle à l'écran : x vers la droite est -x, y vers le bas est -z
    const reach = px * VIEW_LENGTH;
    const cx = sx(center.x);
    const cy = sy(center.z);
    const cone = c.createRadialGradient(cx, cy, 0, cx, cy, reach);
    cone.addColorStop(0, "rgba(255, 255, 255, 0.32)");
    cone.addColorStop(1, "rgba(255, 255, 255, 0)");
    c.fillStyle = cone;
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, reach, heading - VIEW_HALF_ANGLE, heading + VIEW_HALF_ANGLE);
    c.closePath();
    c.fill();

    // Robots : une flèche à la couleur de son équipe (creuse s'il vole), le sien plus grand
    const player = world.player;
    for (const bot of world.bots) {
      if (!bot.cockpit.alive || bot === player) continue;
      if (this.detected && !this.detected(bot)) continue;
      drawBot(c, bot, sx(bot.lastPos.x), sy(bot.lastPos.z), 5 * unit, false);
    }
    if (player?.cockpit.alive) drawBot(c, player, sx(player.lastPos.x), sy(player.lastPos.z), 7 * unit, true);
  }
}

/** Une flèche dans le sens de l'avant du robot. */
function drawBot(c: Ctx, bot: Bot, x: number, y: number, size: number, mine: boolean): void {
  const f = qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
  const a = Math.atan2(-f.z, -f.x);
  const flies = bot.profile.mobility !== "ground";
  c.save();
  c.translate(x, y);
  c.rotate(a);
  c.beginPath();
  c.moveTo(size, 0);
  c.lineTo(-size * 0.7, size * 0.62);
  c.lineTo(-size * 0.35, 0);
  c.lineTo(-size * 0.7, -size * 0.62);
  c.closePath();
  c.lineJoin = "round";
  if (flies && !mine) {
    c.lineWidth = size * 0.35;
    c.strokeStyle = TEAM_COLORS[bot.team];
    c.stroke();
  } else {
    c.fillStyle = mine ? "#ffffff" : TEAM_COLORS[bot.team];
    c.fill();
    c.lineWidth = mine ? size * 0.28 : size * 0.22;
    c.strokeStyle = mine ? TEAM_COLORS[bot.team] : "rgba(10, 14, 20, 0.8)";
    c.stroke();
  }
  c.restore();
}

/** Demi-côté de ce que montre la carte entière d'une arène (m) : une grande arène, avec le pied de ses montagnes. */
export function mapExtent(layout: ArenaLayout): number {
  return layout.terrain ? layout.bounds.half * 1.12 : layout.bounds.half + 2;
}

/**
 * Ce que la carte dessine d'un accessoire ancré debout (un pan de mur, un toit, une citerne, un
 * arbre), d'après son emplacement et ses demi-dimensions ; null : rien (une caisse, un pignon).
 */
export function standingOf(spot: PropSpot, half: Vec3): Standing | null {
  const color = STRUCTURE_COLORS[spot.type];
  if (!color || spot.diamond) return null;
  const { pos, rot } = spotPose(spot, true);
  const crown = CROWN[spot.type];
  if (crown || propDef(spot.type).shape.kind === "cylinder") {
    const r = crown ? crown * (spot.scale ?? 1) : half.x;
    return { color, polygon: null, circle: { x: pos.x, z: pos.z, r } };
  }
  return { color, polygon: footprint(pos, half, rot), circle: null };
}

/** Dessine des accessoires debout sur une toile qui couvre [-extent, extent]² à `k` px par m. */
export function paintStanding(c: Ctx, list: Iterable<Standing>, extent: number, k: number): void {
  const u = (x: number): number => (extent - x) * k;
  const v = (z: number): number => (extent - z) * k;
  for (const s of list) {
    c.fillStyle = s.color;
    c.beginPath();
    if (s.circle) c.arc(u(s.circle.x), v(s.circle.z), Math.max(1, s.circle.r * k), 0, Math.PI * 2);
    else if (s.polygon) s.polygon.forEach((p, i) => (i ? c.lineTo(u(p.x), v(p.z)) : c.moveTo(u(p.x), v(p.z))));
    c.fill();
  }
}

/** Le fond d'une arène : sol (relief ombré, eau, chemins) et décor fixe, sur [-extent, extent]². */
export function drawBackground(canvas: HTMLCanvasElement, layout: ArenaLayout, extent: number): void {
  const c = canvas.getContext("2d")!;
  const size = canvas.width;
  if (layout.terrain) {
    const image = c.createImageData(size, size);
    paintTerrainRows(image, layout, extent, 0, size);
    c.putImageData(image, 0, 0);
  } else {
    drawFlatGround(c, layout, extent, size);
  }
  drawBoxes(c, layout, extent, size / (2 * extent));
}

/**
 * Le relief d'une arène, de la ligne `from` à la ligne `to` (exclue) d'une image carrée qui couvre
 * [-extent, extent]² : la couleur du sol du rendu (voir ArenaView), ombrée par une lumière venue du
 * nord-ouest, l'eau, la lave. Par lignes : le plan d'une arène (menu/arenaPreview.ts) se calcule en
 * plusieurs fois, entre deux images.
 */
export function paintTerrainRows(image: ImageData, layout: ArenaLayout, extent: number, from: number, to: number): void {
  const terrain = layout.terrain;
  if (!terrain) return;
  const size = image.width;
  const k = size / (2 * extent);
  const light = norm(vec3(0.6, 1.2, 0.6));
  const water = layout.water ?? -Infinity;
  const paths = layout.paths ?? [];
  for (let j = from; j < Math.min(to, size); j++) {
    for (let i = 0; i < size; i++) {
      const x = extent - (i + 0.5) / k;
      const z = extent - (j + 0.5) / k;
      const h = terrainHeight(terrain, x, z);
      const n = norm(vec3(terrainHeight(terrain, x - 1, z) - terrainHeight(terrain, x + 1, z), 2, terrainHeight(terrain, x, z - 1) - terrainHeight(terrain, x, z + 1)));
      let { r, g, b } = groundColor(x, h, z, n.y, water, paths, layout);
      if (h < water) [r, g, b] = [r * 0.3 + 0.25 * 0.7, g * 0.3 + 0.44 * 0.7, b * 0.3 + 0.53 * 0.7];
      // L'eau profonde (une limite : on s'y noie) plus sombre ; la lave, qui brûle, en orange vif
      if (layout.deepWater !== undefined && water - Math.max(0, h) > layout.deepWater) [r, g, b] = [0.1, 0.24, 0.36];
      if (layout.lava && lavaAt(layout.lava, x, z) > 0) [r, g, b] = [0.95, 0.36, 0.08];
      const shade = 0.55 + 0.6 * Math.max(0, n.x * light.x + n.y * light.y + n.z * light.z);
      const outside = Math.max(Math.abs(x), Math.abs(z)) > layout.bounds.half ? 0.62 : 1;
      const o = (j * size + i) * 4;
      image.data[o] = clamp(r * shade * 0.9 * outside * 255, 0, 255);
      image.data[o + 1] = clamp(g * shade * 0.9 * outside * 255, 0, 255);
      image.data[o + 2] = clamp(b * shade * 0.9 * outside * 255, 0, 255);
      image.data[o + 3] = 255;
    }
  }
}

/** Sol plat (une arène sans relief) : l'arène claire dans ses murs, un quadrillage de 4 m. */
export function drawFlatGround(c: Ctx, layout: ArenaLayout, extent: number, size: number): void {
  const k = size / (2 * extent);
  c.fillStyle = "#28313a";
  c.fillRect(0, 0, size, size);
  const h = layout.bounds.half;
  const a = (extent - h) * k;
  c.fillStyle = "#4b5862";
  c.fillRect(a, a, 2 * h * k, 2 * h * k);
  c.strokeStyle = "rgba(255, 255, 255, 0.06)";
  c.lineWidth = 1;
  for (let m = -h; m <= h; m += 4) {
    const p = (extent - m) * k;
    c.beginPath(); c.moveTo(p, a); c.lineTo(p, a + 2 * h * k); c.stroke();
    c.beginPath(); c.moveTo(a, p); c.lineTo(a + 2 * h * k, p); c.stroke();
  }
}

/** Décor fixe : l'emprise au sol de chaque boîte, ce sur quoi l'on roule d'abord, les obstacles par-dessus. */
export function drawBoxes(c: Ctx, layout: ArenaLayout, extent: number, k: number): void {
  const boxes = [...layout.boxes].sort((p, q) => BOX_ORDER.indexOf(p.kind) - BOX_ORDER.indexOf(q.kind));
  for (const box of boxes) drawBox(c, box, extent, k);
}

function drawBox(c: Ctx, box: StaticBox, extent: number, k: number): void {
  c.fillStyle = box.look ? LOOK_COLORS[box.look] : BOX_COLORS[box.kind];
  c.beginPath();
  // Une boîte ronde (un silo, un phare) : un disque
  if (box.round) c.arc((extent - box.pos.x) * k, (extent - box.pos.z) * k, box.half.x * k, 0, Math.PI * 2);
  else footprint(box.pos, box.half, box.rot).forEach((p, i) => (i ? c.lineTo((extent - p.x) * k, (extent - p.z) * k) : c.moveTo((extent - p.x) * k, (extent - p.z) * k)));
  c.closePath();
  c.fill();
  if (box.kind === "rock" || box.kind === "container") {
    c.strokeStyle = "rgba(10, 14, 20, 0.5)";
    c.lineWidth = 1;
    c.stroke();
  }
}

/** Emprise au sol d'une boîte orientée : le contour de ses coins vus d'en haut (pour une boîte tournée autour de la verticale, ses quatre coins du bas). */
function footprint(pos: Vec3, half: Vec3, rot: Readonly<Quat>): Vec3[] {
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = qrot(rot, vec3(sx * half.x, sy * half.y, sz * half.z));
    corners.push(vec3(pos.x + p.x, 0, pos.z + p.z));
  }
  return hull(corners);
}

/** Enveloppe convexe de points du plan (x, z), dans l'ordre (méthode de la chaîne monotone). */
function hull(points: Vec3[]): Vec3[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: Vec3, a: Vec3, b: Vec3): number => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Vec3[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec3[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** La toile à la taille où elle s'affiche (pixels de l'écran) ; renvoie son côté (px). */
function fitCanvas(canvas: HTMLCanvasElement): number {
  const px = Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
  if (canvas.width !== px || canvas.height !== px) canvas.width = canvas.height = px;
  return px;
}

/** Couleur « #rrggbb » avec une opacité. */
function hexAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
