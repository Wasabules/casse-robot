import * as B from "../babylon";
import type { Vec3 } from "../../shared/math/vec";
import { chooseLights, type LightRequest } from "./lightChoice";

/*
 * Lumières en grappes : une réserve de lumières ponctuelles et de projecteurs dans un
 * `ClusteredLightContainer` de Babylon (chaque fragment ne fait le calcul que des lumières de sa
 * case de l'écran : des dizaines à la fois, pour le prix de quelques-unes ; il faut WebGL 2 et le
 * mélange de textures flottantes). Ce qui éclaire en demande une à chaque image
 * (render/lightSources.ts, et les éclairs : render/lighting.ts) ; les plus utiles à la caméra passent
 * (render/lightChoice.ts).
 */

/** Lumières de la réserve : ponctuelles, projecteurs. */
const POINTS = 48;
const SPOTS = 20;
/** Sans les lumières dynamiques (la nuit, seulement les lampes et les phares) : au plus tant de lumières ponctuelles. */
const STEADY_POINTS = 24;
/** Une lumière qui entre dans le choix apparaît en tant (s) : elle ne s'allume pas d'un coup. */
const FADE_IN = 0.15;
/**
 * Un cône s'éteint vers son bord : sa lumière y tombe à `CONE_EDGE` de celle de son axe (sans quoi
 * le bord du disque éclairé est net, comme découpé). D'où l'exposant du projecteur, selon son angle.
 */
const CONE_EDGE = 0.01;
const coneExponent = (angle: number): number => Math.log(CONE_EDGE) / Math.log(Math.max(0.05, Math.cos(angle / 2)));
/** Lumière d'une lampe garée (inutilisée) : loin sous le sol, sans portée : elle n'éclaire aucune case. */
const PARKED = new B.Vector3(0, -1e4, 0);

interface Slot {
  light: B.PointLight | B.SpotLight;
  key: unknown;
  /** De 0 à 1 : elle apparaît quand elle entre dans le choix (`FADE_IN`). */
  fade: number;
}

/**
 * La réserve de lumières : un nombre fixe de lumières dans un conteneur en grappes (changer le
 * nombre de lumières de la scène recompilerait toutes les matières : on les garde toutes, garées
 * sans portée sous le sol quand elles ne servent pas). À chaque image, `update` donne les plus
 * utiles des lumières demandées à ses lumières, chacune gardant d'une image à l'autre celle qu'elle
 * avait (pas de saut).
 */
export class LightPool {
  private readonly container: B.ClusteredLightContainer;
  private readonly points: Slot[] = [];
  private readonly spots: Slot[] = [];

  private constructor(container: B.ClusteredLightContainer) {
    this.container = container;
    const scene = container.getScene();
    for (let i = 0; i < POINTS; i++) {
      const light = new B.PointLight(`pool-point-${i}`, PARKED.clone(), scene);
      this.points.push(this.park({ light, key: null, fade: 0 }));
      container.addLight(light);
    }
    for (let i = 0; i < SPOTS; i++) {
      const light = new B.SpotLight(`pool-spot-${i}`, PARKED.clone(), new B.Vector3(0, -1, 0), 1, 2, scene);
      this.spots.push(this.park({ light, key: null, fade: 0 }));
      container.addLight(light);
    }
  }

  /** La réserve, si la carte graphique sait faire des lumières en grappes (WebGL 2, textures flottantes) ; sinon null. */
  static create(scene: B.Scene): LightPool | null {
    const container = new B.ClusteredLightContainer("night-lights", [], scene);
    if (!container.isSupported) {
      container.dispose();
      return null;
    }
    return new LightPool(container);
  }

  /** Donne aux lumières de la réserve les plus utiles de `requests` pour la caméra en `eye` ; `steady` : sans les lumières dynamiques (moins de lumières ponctuelles). */
  update(requests: readonly LightRequest[], eye: Vec3, dt: number, steady: boolean): void {
    const points: LightRequest[] = [];
    const spots: LightRequest[] = [];
    for (const r of requests) (r.dir ? spots : points).push(r);
    this.assign(this.points, chooseLights(points, eye, steady ? STEADY_POINTS : POINTS, keysOf(this.points)), dt);
    this.assign(this.spots, chooseLights(spots, eye, SPOTS, keysOf(this.spots)), dt);
  }

  dispose(): void {
    this.container.dispose();
  }

  private assign(slots: Slot[], chosen: readonly LightRequest[], dt: number): void {
    const wanted = new Map<unknown, LightRequest>();
    for (const r of chosen) wanted.set(r.key, r);
    // Celles qui gardent leur lumière, puis les nouvelles dans les lumières libres
    const free: Slot[] = [];
    for (const slot of slots) {
      const r = slot.key !== null ? wanted.get(slot.key) : undefined;
      if (r) {
        wanted.delete(slot.key);
        slot.fade = Math.min(1, slot.fade + dt / FADE_IN);
        this.set(slot, r);
      } else free.push(slot);
    }
    let i = 0;
    for (const r of wanted.values()) {
      const slot = free[i++];
      if (!slot) break;
      slot.key = r.key;
      slot.fade = r.sudden ? 1 : 0;
      this.set(slot, r);
    }
    for (; i < free.length; i++) if (free[i].key !== null) this.park(free[i]);
  }

  private set(slot: Slot, r: LightRequest): void {
    const light = slot.light;
    light.position.set(r.x, r.y, r.z);
    light.diffuse.set(r.r, r.g, r.b);
    light.specular.set(r.r * 0.3, r.g * 0.3, r.b * 0.3);
    light.intensity = r.intensity * slot.fade;
    if (light.range !== r.range) light.range = r.range;
    if (light instanceof B.SpotLight && r.dir) {
      light.direction.set(r.dir.x, r.dir.y, r.dir.z);
      const angle = r.angle ?? 1;
      if (light.angle !== angle) {
        light.angle = angle;
        light.exponent = coneExponent(angle);
      }
    }
  }

  private park(slot: Slot): Slot {
    slot.key = null;
    slot.fade = 0;
    slot.light.position.copyFrom(PARKED);
    slot.light.intensity = 0;
    slot.light.range = 0.01;
    return slot;
  }
}

function keysOf(slots: readonly Slot[]): Set<unknown> {
  const keys = new Set<unknown>();
  for (const s of slots) if (s.key !== null) keys.add(s.key);
  return keys;
}
