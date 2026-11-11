import { groundLevel } from "../../../shared/arena/layout";
import { smokeRadius } from "../../../shared/combat/smoke";
import { distance, type Vec3 } from "../../../shared/math/vec";
import type { SmokeCloud } from "../../../shared/sim/entities";
import { FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";

/*
 * Nuages de fumigène, en effets réalistes (en effets simples : SmokeView, quelques sphères) : un
 * vrai nuage épais, fait de volutes superposées, opaque au cœur (il cache ce qu'il cache : c'est
 * son rôle en jeu) et effiloché au bord. Les volutes du cœur tournent lentement autour du centre
 * et roulent sur elles-mêmes ; celles du bord débordent, s'éloignent en s'effaçant et renaissent.
 * Le nuage grandit, tient puis se dissipe comme celui de la simulation (`smokeRadius`), et
 * s'effiloche en se dissipant. Ses volutes sont redonnées à chaque image (`ParticleField.volute`) :
 * triées avec les autres fumées.
 */

/** Volutes du cœur et du bord d'un nuage (en effets réduits, d'autant moins). */
const CORE = 24;
const EDGE = 14;
/** Couleur du nuage : un gris clair. */
const COLOR = "#b9bfc3";
/** Opacité d'une volute du cœur, du bord. */
const CORE_ALPHA = 0.88;
const EDGE_ALPHA = 0.5;
/** Part des volutes dessinées quand la caméra est dans le nuage (voir `draw`). */
const CLOSE_SHARE = 0.4;
/** Le voile autour de la caméra dans le nuage : volutes, distance (m), taille (m), opacité. */
const VEIL = 8;
const VEIL_DISTANCE = 2.4;
const VEIL_SIZE = 4.6;
const VEIL_ALPHA = 0.72;
/** Temps de croissance d'un nuage (s, voir combat/smoke.ts) : ensuite, il ne fait plus que s'effilocher en se dissipant. */
const GROWTH = 1.2;

interface Volute {
  /** Direction depuis le centre (le nuage est une demi-boule posée au sol, un peu aplatie), et distance (part du rayon). */
  dx: number;
  dy: number;
  dz: number;
  dist: number;
  /** Taille (part du rayon), angle et rotation propre, case de l'atlas, graine, phase. */
  size: number;
  angle: number;
  spin: number;
  frame: number;
  seed: number;
  phase: number;
}

interface Cloud {
  cloud: SmokeCloud;
  core: Volute[];
  edge: Volute[];
  /** Sens et vitesse de la lente rotation du nuage (rad/s). */
  swirl: number;
}

function volute(edge: boolean): Volute {
  const a = Math.random() * Math.PI * 2;
  // Une demi-boule : plus de volutes vers le bas, quelques-unes au-dessus
  const y = edge ? jitter(-0.1, 0.55) : jitter(-0.25, 0.85);
  const s = Math.sqrt(1 - y * y);
  return {
    dx: Math.cos(a) * s,
    dy: y,
    dz: Math.sin(a) * s,
    dist: edge ? 1 : Math.sqrt(Math.random()) * 0.8,
    size: edge ? jitter(0.5, 0.75) : jitter(0.85, 1.2),
    angle: Math.random() * Math.PI * 2,
    spin: jitter(-0.25, 0.25),
    frame: Math.floor(Math.random() * 4),
    seed: Math.random(),
    phase: Math.random(),
  };
}

export function smokeCloudFx(ctx: FxContext): FxSystem {
  const clouds = new Map<number, Cloud>();
  const off = ctx.world.on((e) => {
    if (e.type === "smokeAdded") {
      clouds.set(e.cloud.id, {
        cloud: e.cloud,
        core: Array.from({ length: CORE }, () => volute(false)),
        edge: Array.from({ length: EDGE }, () => volute(true)),
        swirl: (Math.random() < 0.5 ? -1 : 1) * jitter(0.04, 0.09),
      });
    } else if (e.type === "smokeRemoved") clouds.delete(e.cloud.id);
  });

  const at = { x: 0, y: 0, z: 0 };
  function draw(c: Cloud): void {
    const { cloud } = c;
    const time = ctx.world.time;
    const r = smokeRadius(cloud, time);
    if (r < 0.05) return;
    const center: Vec3 = cloud.pos;
    if (distance(center, ctx.eye) > FX_RANGE + r) return;
    const age = time - cloud.born;
    const k = Math.min(1, r / cloud.radius);
    // Il grandit d'abord (les volutes s'épaississent), puis s'effiloche en se dissipant
    const fray = age < GROWTH ? 0.08 : 0.08 + (1 - k) * 0.7;
    const show = Math.min(1, k * 1.6);
    const ground = Math.min(center.y, groundLevel(ctx.world.arena, center.x, center.z));
    const base = Math.max(ground, center.y - r * 0.15);
    const turn = c.swirl * age;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    // De près (et du dedans), chaque volute couvre tout l'écran : on en dessine moins, plus opaques
    // (le nuage reste aussi épais, la carte graphique dessine bien moins de pixels)
    const near = Math.min(1, Math.max(CLOSE_SHARE, (distance(center, ctx.eye) - r * 0.6) / (r * 1.9)));
    const keep = Math.min(near, Math.max(0.6, ctx.density));
    const step = 1 / keep;
    const coreAlpha = 1 - Math.pow(1 - CORE_ALPHA * show, 1 / keep);
    for (let k = 0; k < c.core.length; k += step) {
      const v = c.core[Math.floor(k)];
      // Le cœur tourne lentement autour du centre, et chaque volute monte et descend un peu
      const ox = (v.dx * cos - v.dz * sin) * v.dist * r * 0.95;
      const oz = (v.dx * sin + v.dz * cos) * v.dist * r * 0.95;
      const oy = (v.dy * v.dist * 0.75 + 0.32) * r + Math.sin(age * 0.35 + v.phase * 6.28) * r * 0.04;
      at.x = center.x + ox;
      at.y = base + oy;
      at.z = center.z + oz;
      // Plus bas, plus au cœur : plus sombre (le nuage s'ombre lui-même)
      const shade = 0.72 + 0.2 * (v.dy * 0.5 + 0.5) + 0.08 * v.dist;
      ctx.particles.volute(at, r * v.size, COLOR, coreAlpha, v.angle + v.spin * age, v.frame, fray, ground, shade, v.seed);
    }
    const edgeCount = Math.ceil(c.edge.length * Math.min(ctx.density, near));
    for (let i = 0; i < edgeCount; i++) {
      const v = c.edge[i];
      // Une volute du bord déborde : elle s'éloigne et monte en s'effaçant, puis renaît
      const t = (age * 0.09 + v.phase) % 1;
      const out = r * (0.78 + 0.5 * t);
      const dx = v.dx * cos - v.dz * sin;
      const dz = v.dx * sin + v.dz * cos;
      at.x = center.x + dx * out;
      at.y = base + (v.dy * 0.5 + 0.18 + 0.35 * t) * r;
      at.z = center.z + dz * out;
      const a = EDGE_ALPHA * show * Math.sin(Math.PI * t) * (1 - t * 0.4);
      ctx.particles.volute(at, r * v.size * (0.8 + 0.5 * t), COLOR, a, v.angle + v.spin * age, v.frame, Math.min(1, fray + 0.25 + 0.4 * t), ground, 0.9, v.seed);
    }
    // Du dedans : un voile de volutes tout autour de la caméra, à quelques mètres (elles couvrent
    // l'écran : on n'y voit pas à plus de quelques mètres, ce qui est le rôle du nuage)
    const eye = ctx.eye;
    const inside = Math.max(0, Math.min(1, (r * 1.05 - distance(center, eye)) / (r * 0.5))) * show;
    if (inside <= 0) return;
    for (let i = 0; i < VEIL; i++) {
      const a = (i / VEIL) * Math.PI * 2 + age * 0.04;
      const y = i % 2 ? 0.3 : -0.2;
      const cy = Math.cos(y);
      at.x = eye.x + Math.cos(a) * cy * VEIL_DISTANCE;
      at.y = eye.y + Math.sin(y) * VEIL_DISTANCE;
      at.z = eye.z + Math.sin(a) * cy * VEIL_DISTANCE;
      ctx.particles.volute(at, VEIL_SIZE, COLOR, VEIL_ALPHA * inside, a * 3, i % 4, fray, ground, 0.85, i / VEIL);
    }
  }

  return {
    update() {
      if (ctx.look !== "realistic") return;
      for (const c of clouds.values()) draw(c);
    },
    dispose() {
      off();
      clouds.clear();
    },
  };
}
