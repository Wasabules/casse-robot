import { spawnLineOf, spawnPoint, type ArenaLayout } from "../../shared/arena/layout";
import { propDef, propHalf } from "../../shared/catalog/props";
import { drawBoxes, drawFlatGround, mapExtent, paintStanding, paintTerrainRows, standingOf, type Standing } from "../hud/minimap";
import { TEAM_COLORS } from "../teams";

/*
 * Le plan d'une arène vu de dessus, pour le choix de l'arène (menu/arenaPicker.ts) : le fond de la
 * carte du jeu (hud/minimap.ts : relief ombré, eau, lave, chemins, décor fixe), les bâtiments et les
 * arbres debout, les lignes de départ des deux équipes et les zones à capturer ; plus sombre la nuit.
 * Dessiné une fois par arène et gardé le temps de la visite. Le relief, calculé point par point, est
 * le plus cher (de 0,13 à 0,33 s de calcul pour une grande carte) : il se calcule par tranches, entre deux
 * images, à une résolution moitié moindre que le plan, puis il est agrandi ; les plans se font l'un
 * après l'autre, celui de l'arène sélectionnée d'abord. Une grande arène du jeu attend son fichier
 * (chargé à la demande : client/maps/gameArenas.ts), puis se construit d'une traite, comme une carte
 * communautaire.
 */

/** Côté d'un plan (px) : assez pour la grande vue de la fiche. */
const PLAN_SIZE = 400;
/** Côté du relief calculé (px), agrandi au côté du plan. */
const TERRAIN_SIZE = 200;
/** Durée d'une tranche de calcul (ms), avant de laisser passer une image. */
const SLICE = 8;

/** Plans déjà dessinés, par identifiant d'arène (le même pour la même carte communautaire). */
const plans = new Map<string, HTMLCanvasElement>();

/** Laisse le navigateur dessiner une image. */
const breathe = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

/**
 * Dessine le plan d'une arène sur une nouvelle toile carrée, par tranches ; null si `alive` devient
 * faux entre deux tranches (l'écran est parti).
 */
export async function drawArenaPlan(layout: ArenaLayout, alive: () => boolean = () => true, size = PLAN_SIZE): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const c = canvas.getContext("2d")!;
  const extent = mapExtent(layout);
  const k = size / (2 * extent);
  const u = (x: number): number => (extent - x) * k;
  const v = (z: number): number => (extent - z) * k;
  if (layout.terrain) {
    const relief = document.createElement("canvas");
    relief.width = relief.height = TERRAIN_SIZE;
    const rc = relief.getContext("2d")!;
    const image = rc.createImageData(TERRAIN_SIZE, TERRAIN_SIZE);
    let start = performance.now();
    for (let row = 0; row < TERRAIN_SIZE; row += 2) {
      paintTerrainRows(image, layout, extent, row, row + 2);
      if (performance.now() - start > SLICE) {
        await breathe();
        if (!alive()) return null;
        start = performance.now();
      }
    }
    rc.putImageData(image, 0, 0);
    c.imageSmoothingQuality = "high";
    c.drawImage(relief, 0, 0, size, size);
  } else {
    drawFlatGround(c, layout, extent, size);
  }
  drawBoxes(c, layout, extent, k);
  // Les bâtiments et les arbres, debout comme au début d'une partie
  const standing: Standing[] = [];
  for (const spot of layout.props) {
    if (!propDef(spot.type).anchored) continue;
    const s = standingOf(spot, propHalf(spot.type, spot));
    if (s) standing.push(s);
  }
  paintStanding(c, standing, extent, k);
  // La nuit : tout s'assombrit, sauf les repères
  if (layout.sky?.night) {
    c.fillStyle = "rgba(6, 12, 34, 0.45)";
    c.fillRect(0, 0, size, size);
  }
  // Lignes de départ : un trait épais à la couleur de chaque équipe
  const unit = size / 200;
  c.lineCap = "round";
  for (const team of ["blue", "red"] as const) {
    const { spread } = spawnLineOf(layout.bounds, team);
    const a = spawnPoint(layout.bounds, team, -spread);
    const b = spawnPoint(layout.bounds, team, spread);
    c.strokeStyle = "rgba(10, 14, 20, 0.7)";
    c.lineWidth = 5 * unit;
    c.beginPath();
    c.moveTo(u(a.x), v(a.z));
    c.lineTo(u(b.x), v(b.z));
    c.stroke();
    c.strokeStyle = TEAM_COLORS[team];
    c.lineWidth = 3 * unit;
    c.stroke();
  }
  // Zones à capturer : un disque clair et sa lettre
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.font = `700 ${Math.round(8 * unit)}px "Chakra Petch", sans-serif`;
  for (const zone of layout.zones) {
    const x = u(zone.pos.x);
    const y = v(zone.pos.z);
    c.beginPath();
    c.arc(x, y, Math.max(zone.radius * k, 6 * unit), 0, Math.PI * 2);
    c.fillStyle = "rgba(240, 189, 44, 0.28)";
    c.fill();
    c.lineWidth = 1.5 * unit;
    c.strokeStyle = "#f0bd2c";
    c.stroke();
    c.lineWidth = 2.5 * unit;
    c.strokeStyle = "rgba(10, 14, 20, 0.8)";
    c.strokeText(zone.label, x, y + 0.5);
    c.fillStyle = "#f4f7f9";
    c.fillText(zone.label, x, y + 0.5);
  }
  return canvas;
}

/**
 * Copie un plan sur une toile affichée : en entier (carrée), ou recadré au milieu à la proportion de
 * la toile (une carte de la grille, plus large que haute).
 */
export function paintPlan(target: HTMLCanvasElement, plan: HTMLCanvasElement): void {
  const c = target.getContext("2d");
  if (!c) return;
  const aspect = target.width / target.height;
  const sw = aspect >= 1 ? plan.width : plan.width * aspect;
  const sh = aspect >= 1 ? plan.height / aspect : plan.height;
  c.imageSmoothingQuality = "high";
  c.clearRect(0, 0, target.width, target.height);
  c.drawImage(plan, (plan.width - sw) / 2, (plan.height - sh) / 2, sw, sh, 0, 0, target.width, target.height);
}

/** L'arène d'un plan : tout de suite, ou une fois chargée (une grande arène du jeu : client/maps/gameArenas.ts). */
export type PlanLayout = () => ArenaLayout | undefined | Promise<ArenaLayout | undefined>;

interface PlanRequest {
  key: string;
  layout: PlanLayout;
  done: ((plan: HTMLCanvasElement) => void)[];
}

/**
 * Les plans demandés par un écran, dessinés l'un après l'autre. `stop` (l'écran s'en va) abandonne
 * ceux qui restent ; ceux déjà dessinés sont gardés pour la prochaine fois.
 */
export class PlanQueue {
  private readonly queue: PlanRequest[] = [];
  private running = false;
  private stopped = false;

  /** Demande le plan d'une arène ; `done` est appelé quand il est prêt (tout de suite s'il l'est déjà). */
  request(key: string, layout: PlanLayout, done: (plan: HTMLCanvasElement) => void): void {
    const ready = plans.get(key);
    if (ready) {
      done(ready);
      return;
    }
    const pending = this.queue.find((r) => r.key === key);
    if (pending) pending.done.push(done);
    else this.queue.push({ key, layout, done: [done] });
    if (!this.running && !this.stopped) void this.run();
  }

  /** Ce plan d'abord (l'arène sélectionnée), s'il n'est pas déjà en cours. */
  hurry(key: string): void {
    const i = this.queue.findIndex((r) => r.key === key);
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  private async run(): Promise<void> {
    this.running = true;
    // (l'écran se dessine d'abord, sans attendre les plans)
    await breathe();
    while (this.queue.length && !this.stopped) {
      const request = this.queue.shift()!;
      try {
        const layout = await request.layout();
        const plan = layout && !this.stopped ? await drawArenaPlan(layout, () => !this.stopped) : null;
        if (plan) {
          plans.set(request.key, plan);
          for (const done of request.done) done(plan);
        }
      } catch (e) {
        console.warn(`Plan de l'arène ${request.key} impossible à dessiner`, e);
      }
      await breathe();
    }
    this.running = false;
  }
}
