import { inWater } from "../../../shared/arena/layout";
import { meleeDef, type MeleeSpec } from "../../../shared/catalog/melee";
import { headAt, meleeFrame, tipAt, unbalanceShare } from "../../../shared/combat/melee";
import { clamp } from "../../../shared/math/scalar";
import { add, cross, distance, len, norm, scale, sub, vec3, type Vec3 } from "../../../shared/math/vec";
import { blockDef } from "../../../shared/catalog/blocks";
import type { Block, MeleeArm, MeleeBite } from "../../../shared/sim/entities";
import type { SimEvent } from "../../../shared/sim/events";
import { emissions, FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import { surfaceAt } from "./marks";
import type { PuffSpec } from "./particles";
import type { StreakSpec } from "./streaks";
import { groundRgb, LiveSet, toHex } from "./tracking";

/*
 * Armes de contact (combat/melee.ts), à l'écran : le coup d'une lame ou d'une tête (`meleeHit`, que
 * le réseau transmet) jette une gerbe d'étincelles étirées dans le sens où part l'impulsion et le
 * long du tranchant, un éclair blanc, des éclats sombres qui retombent et un peu de fumée, d'autant
 * plus que le coup est fort ; un coup qui ricoche sur un glacis fait une traînée d'étincelles le long
 * de la pente, moins vive ; un coup au sol (la tête d'un marteau) soulève un anneau de poussière à
 * la couleur du sol et laisse une marque. Un rotor très déséquilibré grince : des étincelles
 * jaillissent de son moyeu, par à-coups. Tout se lit dans le monde affiché.
 *
 * Armes d'énergie, chacune à sa façon (selon son allure, `MeleeSpec.look`) : la lame laser fait
 * jaillir du métal en fusion (gouttes orange étirées, un point blanc, une fumée légère, une brûlure
 * au sol) et pétille le long de son arc allumé, et fume dans l'eau où elle s'éteint ; le fouet
 * laisse une traînée de plasma le long de la course de sa tête et crache des braises et du plasma
 * où il claque ; la lance crépite à sa pointe chargée et lance des arcs en étoile où elle décharge ;
 * le champ fait s'illuminer la coque là où on le touche (des éclats violets en anneau, et un arc du
 * projecteur au point touché, lu à l'image suivante : on ne relit pas une pose dans un écouteur).
 *
 * Une lame qui mord (`MeleeArm.bite`, qui passe par l'instantané) crache en continu, d'autant plus
 * qu'elle y met de puissance : une gerbe d'étincelles étirées que la scie projette dans le sens de
 * ses dents (sa « queue de coq ») et que la mèche fait gicler tout autour de son axe et vers
 * l'arrière ; des copeaux de métal sombres qui retombent (la mèche les jette en spirale) ; un point
 * incandescent où elle mord, un peu de fumée ; l'entaille, un trait rouge vif qui suit la lame et se
 * refroidit ; au sol, de la poussière à sa couleur et un sillon sombre. Sur une pente qui la fait
 * glisser, moins d'étincelles, plus rasantes.
 */

/** Énergie d'un coup (J) qui donne la gerbe de référence. */
const REFERENCE = 1500;
/** Au-delà de ce balourd (voir `unbalanceShare`), à plein régime, le moyeu crache des étincelles. */
const GRIND_FROM = 0.45;
/** Une arme d'énergie est allumée au-delà de cette part de son plein régime (comme à l'écran, render/meleeView.ts). */
const LIT_FROM = 0.15;

/** Étincelles d'un coup : brèves, vives, étirées le long de leur course, qui retombent. */
const SPARK: PuffSpec = { color: "#ffd38a", kind: "glow", size: 0.05, life: 0.45, alpha: 1, drag: 1.2, gravity: 7, stretch: 0.045 };
const SPARK_HOT: PuffSpec = { ...SPARK, color: "#fff3cf", size: 0.04, life: 0.25 };
/** Éclair au point d'impact, d'une image ou deux. */
const FLASH: PuffSpec = { color: "#fff6e0", kind: "glow", size: 0.4, grow: 0.8, life: 0.08, alpha: 0.75 };
/** Éclats de métal qui retombent. */
const CHIP: PuffSpec = { color: "#2a2d30", kind: "smoke", size: 0.07, life: 0.9, alpha: 1, drag: 0.4, gravity: 9.8, wind: 0 };
/** Fumée du métal arraché, de la poussière du sol. */
const SMOKE: PuffSpec = { color: "#4a4c4f", kind: "smoke", size: 0.35, grow: 1.6, life: 1.4, alpha: 0.45, fadeIn: 0.1, drag: 1.4, gravity: -0.6 };
const DUST: PuffSpec = { color: "#b9a888", kind: "smoke", size: 0.4, grow: 1.8, life: 1.6, alpha: 0.55, fadeIn: 0.08, drag: 2.2, gravity: -0.25 };
/** Marque d'un coup au sol : une entaille sombre. */
const GOUGE = { color: "#3a3127", life: 40, fade: 0.3 };

/** Morsure : puissance de coupe (kW) qui donne la gerbe de référence, et ce qu'elle émet alors par seconde. */
const BITE_REFERENCE = 3;
const BITE_SPARKS = 240;
const BITE_CHIPS = 28;
const BITE_SMOKE = 5;
/** Étincelles d'une lame qui mord : longues, rapides. */
const BITE_SPARK: PuffSpec = { color: "#ffc670", kind: "glow", size: 0.035, life: 0.35, alpha: 1, drag: 1.5, gravity: 6, stretch: 0.05 };
const BITE_SPARK_HOT: PuffSpec = { ...BITE_SPARK, color: "#fff1c4", size: 0.03, life: 0.2 };
/** Le point où elle mord, incandescent (une image). */
const BITE_GLOW: PuffSpec = { color: "#ffb24a", kind: "glow", size: 0.16, grow: 0.22, life: 0.05, alpha: 0.85 };
/** Copeaux de métal, plus petits que les éclats d'un coup. */
const SWARF: PuffSpec = { color: "#3a3f44", kind: "smoke", size: 0.045, life: 0.8, alpha: 1, drag: 0.6, gravity: 9.8, wind: 0, stretch: 0.02 };
const BITE_HAZE: PuffSpec = { color: "#6a6c70", kind: "smoke", size: 0.22, grow: 1.1, life: 1.1, alpha: 0.3, fadeIn: 0.1, drag: 1.4, gravity: -0.5 };
/** L'entaille : un trait rouge vif qui se refroidit, posé de la dernière morsure à la suivante. */
const KERF = { color: "#ff6a1f", kind: "glow" as const, width: 0.035, widen: 0.015, life: 1.1, alpha: 0.9 };
/** Au sol : un sillon sombre. */
const FURROW = { color: "#2e2822", life: 35, fade: 0.3, alpha: 0.5 };
/** Une entaille se pose quand la lame a bougé d'au moins KERF_STEP m (et pas d'un bond de plus de KERF_JUMP). */
const KERF_STEP = 0.04;
const KERF_JUMP = 0.6;
/** Lame laser : gouttes de métal en fusion, point incandescent, fumée claire, brûlure au sol, pétillement de l'arc, vapeur dans l'eau. */
const MOLTEN: PuffSpec = { color: "#ffb347", kind: "glow", size: 0.045, life: 0.55, alpha: 1, drag: 0.8, gravity: 9, stretch: 0.03 };
const MOLTEN_CORE: PuffSpec = { color: "#fff7e8", kind: "glow", size: 0.16, grow: 0.25, life: 0.12, alpha: 0.95 };
const SABER_FLASH: PuffSpec = { color: "#bff2ff", kind: "glow", size: 0.3, grow: 0.5, life: 0.07, alpha: 0.7 };
const FUME: PuffSpec = { color: "#8a8f94", kind: "smoke", size: 0.18, grow: 0.9, life: 1, alpha: 0.35, fadeIn: 0.1, drag: 1.2, gravity: -1.2 };
const SCORCH = { color: "#1d1a17", life: 30, fade: 0.3 };
const ARC_SPARK: PuffSpec = { color: "#bff2ff", kind: "glow", size: 0.04, life: 0.18, alpha: 1, drag: 2, stretch: 0.02, wind: 0 };
const STEAM: PuffSpec = { color: "#e8eef2", kind: "vapor", size: 0.2, grow: 1.4, life: 0.9, alpha: 0.5, fadeIn: 0.05, drag: 1.5, gravity: -1.8 };
/** Fouet plasma : sa traînée (le long de la course de sa tête), le plasma qui gicle, les braises. */
const LASH: StreakSpec = { color: "#d58aff", kind: "glow", width: 0.07, widen: 0.02, life: 0.18, alpha: 0.85 };
const LASH_CORE: StreakSpec = { color: "#fff0ff", kind: "glow", width: 0.025, life: 0.1, alpha: 1 };
const PLASMA: PuffSpec = { color: "#e07bff", kind: "glow", size: 0.12, grow: 0.5, life: 0.3, alpha: 0.9, drag: 2.5 };
const PLASMA_FLASH: PuffSpec = { color: "#ffd9ff", kind: "glow", size: 0.5, grow: 0.8, life: 0.08, alpha: 0.8 };
const EMBER: PuffSpec = { color: "#ff9a3a", kind: "glow", size: 0.05, life: 0.8, alpha: 1, drag: 0.7, gravity: 4, stretch: 0.02 };
/** Lance électrique : arcs en étoile, éclair bleu, étincelles bleues, crépitement de la pointe chargée. */
const BOLT: StreakSpec = { color: "#bfe4ff", kind: "glow", width: 0.035, life: 0.09, alpha: 1 };
const BOLT_HALO: StreakSpec = { color: "#4a9cff", kind: "glow", width: 0.1, life: 0.12, alpha: 0.5 };
const ZAP_FLASH: PuffSpec = { color: "#e2f2ff", kind: "glow", size: 0.45, grow: 0.6, life: 0.08, alpha: 0.85 };
const BLUE_SPARK: PuffSpec = { color: "#9fd4ff", kind: "glow", size: 0.04, life: 0.3, alpha: 1, drag: 1.5, gravity: 5, stretch: 0.03 };
/** Champ broyeur : éclats de la coque qui s'illumine, arc du projecteur, et des lueurs qui flottent autour de lui, armé. */
const HULL_GLOW: PuffSpec = { color: "#a88cff", kind: "glow", size: 0.16, grow: 0.3, life: 0.22, alpha: 0.75, wind: 0 };
const HULL_CORE: PuffSpec = { color: "#efe6ff", kind: "glow", size: 0.3, grow: 0.4, life: 0.08, alpha: 0.7 };
const FIELD_ARC: StreakSpec = { color: "#c9b8ff", kind: "glow", width: 0.03, life: 0.08, alpha: 1 };
const FIELD_HALO: StreakSpec = { color: "#7a5cff", kind: "glow", width: 0.09, life: 0.1, alpha: 0.45 };
const MOTE: PuffSpec = { color: "#b8a8ff", kind: "glow", size: 0.05, life: 0.9, alpha: 0.8, drag: 1, gravity: -0.6, wind: 0 };

/** Un vecteur unitaire perpendiculaire à `n`. */
const perpendicular = (n: Vec3): Vec3 => norm(Math.abs(n.y) < 0.9 ? cross(n, vec3(0, 1, 0)) : cross(n, vec3(1, 0, 0)));

/** Ce qu'une lame qui mord a émis : les restes des cadences, et le dernier point de son entaille. */
interface Trail {
  sparks: { acc: number };
  chips: { acc: number };
  smoke: { acc: number };
  last: Vec3 | null;
}

/** Au viseur, rien de ses propres morsures à moins de cette distance de l'objectif (m). */
const OWN_NEAR = 3;

/** Un arc électrique de `a` à `b`, en zigzag (des segments aux coudes écartés au hasard). */
function bolt(ctx: FxContext, a: Vec3, b: Vec3, core: StreakSpec, halo: StreakSpec, kinks = 3): void {
  const d = sub(b, a);
  const size = len(d);
  let last = a;
  for (let i = 1; i <= kinks; i++) {
    const on = add(a, scale(d, i / kinks));
    const next = i === kinks ? b : add(on, vec3(jitter(-1, 1) * size * 0.12, jitter(-1, 1) * size * 0.12, jitter(-1, 1) * size * 0.12));
    ctx.streaks.line(last, next, core);
    ctx.streaks.line(last, next, halo);
    last = next;
  }
}

export function meleeFx(ctx: FxContext): FxSystem {
  const live = new LiveSet(ctx.world);
  const grind = new Map<MeleeArm, { acc: number }>();
  /** Ce qu'émet en continu une arme d'énergie (pétillement, vapeur, crépitement, lueurs). */
  const glimmer = new Map<MeleeArm, { acc: number }>();
  /** Dernière position de la tête d'un fouet qui frappe : sa traînée part de là. */
  const lashes = new Map<MeleeArm, Vec3>();
  /** Coups d'un champ, à illuminer à l'image suivante (l'arc part de son projecteur, dont on lira la pose). */
  const fieldHits: { block: Block; point: Vec3; dir: Vec3; k: number }[] = [];
  /** Morsures en cours : ce qu'elles ont émis, et le dernier point de leur entaille. */
  const trails = new Map<MeleeArm, Trail>();

  /** Une lame qui mord, à cette image : étincelles, copeaux, point incandescent, fumée, entaille ou sillon. */
  const gnaw = (arm: MeleeArm, bite: MeleeBite, dt: number): void => {
    let trail = trails.get(arm);
    if (!trail) trails.set(arm, (trail = { sparks: { acc: 0 }, chips: { acc: 0 }, smoke: { acc: 0 }, last: null }));
    const at = bite.point;
    const bot = arm.block.bot;
    if (distance(at, ctx.eye) > FX_RANGE || (ctx.inside === bot && distance(at, ctx.eye) < OWN_NEAR)) {
      trail.last = null;
      return;
    }
    const spec = meleeDef(arm.weapon);
    const axial = spec.bite?.feed === "axial";
    const k = clamp(bite.power / BITE_REFERENCE, 0.1, 1.6) * (bite.glance ? 0.5 : 1);
    const dir = len(bite.dir) > 1e-6 ? norm(bite.dir) : vec3(0, 1, 0);
    const side = perpendicular(dir);
    const ground = bite.surface === "scenery";
    ctx.particles.emit(at, BITE_GLOW, undefined, 0.7 + 0.4 * Math.min(1, k));
    // Les étincelles : la scie les projette dans le sens de ses dents ; la mèche les fait gicler
    // autour de son axe, et vers l'arrière, le long de la mèche
    const sparks = emissions(trail.sparks, BITE_SPARKS * k * ctx.density, dt);
    for (let i = 0; i < sparks; i++) {
      let out: Vec3;
      if (axial) {
        const a = jitter(0, Math.PI * 2);
        const radial = add(scale(side, Math.cos(a)), scale(cross(dir, side), Math.sin(a)));
        out = add(add(scale(radial, jitter(3, 8)), scale(dir, -jitter(1, 5))), vec3(0, jitter(0, 2.5), 0));
      } else {
        out = add(add(scale(dir, jitter(6, 14) * (bite.glance ? 0.7 : 1)), scale(side, jitter(-2.5, 2.5))), vec3(jitter(-1, 1), jitter(0.5, 4), jitter(-1, 1)));
      }
      ctx.particles.emit(at, i % 3 === 0 ? BITE_SPARK_HOT : BITE_SPARK, out);
    }
    // Copeaux (sur un robot, un accessoire) ou poussière (au sol, sur le décor)
    const chips = emissions(trail.chips, BITE_CHIPS * k * ctx.density, dt);
    if (ground) {
      const c = groundRgb(ctx.world.arena, at.x, at.y, at.z);
      const dust = { ...DUST, color: toHex(c.r * 0.9 + 0.08, c.g * 0.9 + 0.07, c.b * 0.9 + 0.05), size: 0.25 };
      for (let i = 0; i < chips; i++) ctx.particles.emit(at, dust, add(scale(dir, jitter(1, 3)), vec3(jitter(-1, 1), jitter(0.4, 1.5), jitter(-1, 1))));
    } else {
      for (let i = 0; i < chips; i++) {
        const spiral = axial
          ? add(scale(cross(dir, side), jitter(2, 4)), add(scale(side, jitter(-2, 2)), scale(dir, -jitter(1, 3))))
          : add(scale(dir, jitter(2, 6)), vec3(jitter(-1.5, 1.5), jitter(1, 3.5), jitter(-1.5, 1.5)));
        ctx.particles.emit(at, SWARF, spiral, jitter(0.6, 1.3));
      }
    }
    for (let i = emissions(trail.smoke, BITE_SMOKE * k * ctx.density, dt); i > 0; i--) {
      ctx.particles.emit(add(at, vec3(jitter(-0.08, 0.08), 0.05, jitter(-0.08, 0.08))), BITE_HAZE, vec3(jitter(-0.3, 0.3), 0.5, jitter(-0.3, 0.3)));
    }
    // L'entaille : un trait rouge vif de la dernière morsure à celle-ci ; au sol, un sillon
    const last = trail.last;
    if (!last || distance(last, at) > KERF_JUMP) {
      trail.last = at;
      return;
    }
    if (distance(last, at) < KERF_STEP) return;
    if (ground) {
      const floor = surfaceAt(ctx.world.arena, at.x, at.z, at.y + 0.3);
      if (floor && Math.abs(floor.point.y - at.y) < 0.4) ctx.marks.strip(vec3(last.x, floor.point.y, last.z), floor.point, floor.normal, 0.08, FURROW);
    } else {
      ctx.streaks.line(last, at, KERF);
    }
    trail.last = at;
  };

  /** Le coup d'une lame d'acier ou d'une tête (toupie, marteau) : la gerbe, les éclats, la poussière au sol. */
  const steel = (e: Extract<SimEvent, { type: "meleeHit" }>, spec: MeleeSpec | null, k: number, dir: Vec3): void => {
    const at = e.point;
    const side = perpendicular(dir);
    const swing = spec?.motion === "swing";
    ctx.particles.emit(at, FLASH, undefined, 0.6 + 0.4 * Math.min(1, k));
    // La gerbe : dans le sens de l'impulsion (et à l'opposé, ce que la lame rejette), en éventail
    const sparks = Math.round((e.glance ? 14 : 30) * k * ctx.density);
    for (let i = 0; i < sparks; i++) {
      const back = Math.random() < 0.35 ? -0.6 : 1;
      const out = add(add(scale(dir, back * jitter(4, 13)), scale(side, jitter(-6, 6))), vec3(jitter(-2, 2), jitter(0, 5), jitter(-2, 2)));
      ctx.particles.emit(at, i % 3 === 0 ? SPARK_HOT : SPARK, out);
    }
    if (e.surface === "scenery") {
      // Le sol (ou le dessus du décor) : poussière en anneau, à sa couleur, et une entaille
      const ground = surfaceAt(ctx.world.arena, at.x, at.z, at.y + 0.3);
      const flat = ground && Math.abs(ground.point.y - at.y) < 0.4;
      const c = groundRgb(ctx.world.arena, at.x, at.y, at.z);
      const dust = { ...DUST, color: toHex(c.r * 0.9 + 0.08, c.g * 0.9 + 0.07, c.b * 0.9 + 0.05) };
      const n = Math.round((swing ? 14 : 6) * k * ctx.density);
      for (let i = 0; i < n; i++) {
        const a = (i / Math.max(1, n)) * Math.PI * 2 + jitter(-0.2, 0.2);
        ctx.particles.emit(add(at, vec3(Math.cos(a) * 0.2, 0.05, Math.sin(a) * 0.2)), dust, vec3(Math.cos(a) * jitter(1.5, 3.5), jitter(0.3, 1.4), Math.sin(a) * jitter(1.5, 3.5)), 0.8 + 0.4 * k);
      }
      if (flat && ground) ctx.marks.disc(ground.point, ground.normal, 0.25 + 0.2 * k, { ...GOUGE, alpha: 0.35 });
      return;
    }
    // Un robot, un accessoire : des éclats qui retombent, et la fumée du métal arraché
    const chips = Math.round(8 * k * ctx.density);
    for (let i = 0; i < chips; i++) {
      ctx.particles.emit(at, CHIP, add(scale(dir, jitter(2, 7)), vec3(jitter(-2.5, 2.5), jitter(1, 5), jitter(-2.5, 2.5))), jitter(0.6, 1.4));
    }
    for (let i = Math.round(2 * k * ctx.density); i > 0; i--) {
      ctx.particles.emit(add(at, vec3(jitter(-0.15, 0.15), 0.1, jitter(-0.15, 0.15))), SMOKE, add(scale(dir, 0.6), vec3(0, 0.6, 0)));
    }
  };

  /** Le coup d'une arme d'énergie, selon son allure ; faux pour une arme d'acier. */
  const energy = (e: Extract<SimEvent, { type: "meleeHit" }>, spec: MeleeSpec, k: number, dir: Vec3): boolean => {
    const at = e.point;
    const side = perpendicular(dir);
    switch (spec.look) {
      case "saber": {
        // Le métal fond : un point blanc, des gouttes orange qui giclent le long de la lame, une fumée claire
        ctx.particles.emit(at, SABER_FLASH, undefined, 0.7 + 0.3 * Math.min(1, k));
        ctx.particles.emit(at, MOLTEN_CORE);
        for (let i = Math.round(12 * Math.min(1.5, 0.5 + k) * ctx.density); i > 0; i--) {
          ctx.particles.emit(at, MOLTEN, add(add(scale(dir, jitter(1.5, 6)), scale(side, jitter(-3, 3))), vec3(0, jitter(0.5, 3), 0)));
        }
        if (Math.random() < 0.5 * ctx.density) ctx.particles.emit(at, FUME, vec3(jitter(-0.3, 0.3), 0.6, jitter(-0.3, 0.3)));
        if (e.surface === "scenery") {
          const ground = surfaceAt(ctx.world.arena, at.x, at.z, at.y + 0.3);
          if (ground && Math.abs(ground.point.y - at.y) < 0.4) ctx.marks.disc(ground.point, ground.normal, 0.18, { ...SCORCH, alpha: 0.4 });
        }
        return true;
      }
      case "whip": {
        // Le claquement : un éclair rose, du plasma qui gicle, des braises qui retombent
        ctx.particles.emit(at, PLASMA_FLASH, undefined, 0.7 + 0.4 * Math.min(1, k));
        for (let i = Math.round(10 * k * ctx.density) + 3; i > 0; i--) {
          ctx.particles.emit(at, PLASMA, add(scale(dir, jitter(1, 4)), vec3(jitter(-2, 2), jitter(0, 2.5), jitter(-2, 2))));
        }
        for (let i = Math.round(10 * k * ctx.density); i > 0; i--) {
          ctx.particles.emit(at, EMBER, add(scale(dir, jitter(1, 5)), vec3(jitter(-2.5, 2.5), jitter(1, 4), jitter(-2.5, 2.5))));
        }
        ctx.particles.emit(add(at, vec3(0, 0.1, 0)), SMOKE, vec3(0, 0.8, 0), 0.8);
        return true;
      }
      case "lance": {
        // La décharge : un éclair bleu, des arcs en étoile autour du point, des étincelles bleues
        ctx.particles.emit(at, ZAP_FLASH);
        for (let i = 0; i < 5; i++) {
          const out = norm(vec3(jitter(-1, 1), jitter(-0.4, 1), jitter(-1, 1)));
          bolt(ctx, at, add(at, scale(out, jitter(0.4, 0.9))), BOLT, BOLT_HALO);
        }
        for (let i = Math.round(14 * ctx.density); i > 0; i--) {
          ctx.particles.emit(at, BLUE_SPARK, add(scale(dir, jitter(-2, 4)), vec3(jitter(-3, 3), jitter(0.5, 4), jitter(-3, 3))));
        }
        return true;
      }
      case "field":
        // La coque s'illumine là où on la touche ; l'arc du projecteur est tracé à l'image suivante
        fieldHits.push({ block: e.block, point: at, dir, k });
        return true;
      default:
        return false;
    }
  };

  const hit = (e: Extract<SimEvent, { type: "meleeHit" }>): void => {
    if (distance(e.point, ctx.eye) > FX_RANGE) return;
    const k = clamp(e.energy / REFERENCE, 0.15, 2.2) * (e.glance ? 0.45 : 1);
    const dir = len(e.dir) > 1e-6 ? norm(e.dir) : vec3(0, 1, 0);
    const weapon = blockDef(e.block.type).melee;
    const spec = weapon !== undefined ? meleeDef(weapon) : null;
    if (spec && energy(e, spec, k, dir)) return;
    steel(e, spec, k, dir);
  };

  /** Un coup de champ, une image après : la coque s'illumine en anneau autour du point, et un arc part du projecteur. */
  const glowHull = (h: (typeof fieldHits)[number]): void => {
    const n = h.dir;
    const u = perpendicular(n);
    const v = cross(n, u);
    ctx.particles.emit(h.point, HULL_CORE);
    const count = Math.round(9 * ctx.density) + 3;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + jitter(-0.15, 0.15);
      const r = jitter(0.15, 0.4);
      ctx.particles.emit(add(h.point, add(scale(u, Math.cos(a) * r), scale(v, Math.sin(a) * r))), HULL_GLOW, scale(n, jitter(0.2, 0.8)));
    }
    const arm = h.block.alive && live.blockOk(h.block) ? h.block.bot.melee.find((m) => m.block === h.block) : undefined;
    if (arm) bolt(ctx, meleeFrame(arm).hub, h.point, FIELD_ARC, FIELD_HALO, 4);
  };

  const off = ctx.world.on((e) => {
    if (e.type === "meleeHit") hit(e);
    else if (e.type === "botRemoved") {
      for (const arm of e.bot.melee) {
        grind.delete(arm);
        trails.delete(arm);
        glimmer.delete(arm);
        lashes.delete(arm);
      }
    }
  });

  /** Ce qu'émet en continu une arme d'énergie allumée, à `rate` par seconde. */
  const emitting = (arm: MeleeArm, rate: number, dt: number): number => {
    let carry = glimmer.get(arm);
    if (!carry) glimmer.set(arm, (carry = { acc: 0 }));
    return emissions(carry, rate * ctx.density, dt);
  };

  return {
    update(dt) {
      if (dt <= 0) return;
      for (const h of fieldHits.splice(0)) glowHull(h);
      // Les lames qui mordent
      for (const bot of ctx.world.bots) {
        for (const arm of bot.melee) {
          const bite = arm.bite;
          if (bite && live.blockOk(arm.block)) {
            gnaw(arm, bite, dt);
          } else {
            // (la morsure a cessé : la prochaine entaille repartira de son nouveau point)
            const trail = trails.get(arm);
            if (trail) trail.last = null;
          }
        }
      }
      for (const arm of [...trails.keys()]) if (!arm.block.alive) trails.delete(arm);
      for (const bot of ctx.world.bots) {
        if (!bot.melee.length) continue;
        for (const arm of bot.melee) {
          if (!live.blockOk(arm.block)) {
            lashes.delete(arm);
            continue;
          }
          const spec = meleeDef(arm.weapon);
          const spin = spec.spin;
          // Un rotor très déséquilibré grince : des étincelles jaillissent de son moyeu
          if (spin && spin.unbalance > 0) {
            const shake = unbalanceShare(arm) * (arm.spin / spin.speed) ** 2;
            if (shake >= GRIND_FROM * GRIND_FROM) {
              const f = meleeFrame(arm);
              if (distance(f.hub, ctx.eye) > FX_RANGE) continue;
              let carry = grind.get(arm);
              if (!carry) grind.set(arm, (carry = { acc: 0 }));
              const rate = 30 * shake * ctx.density * (Math.random() < 0.3 ? 3 : 0.4);
              for (let i = emissions(carry, rate, dt); i > 0; i--) {
                const a = jitter(0, Math.PI * 2);
                const radial = add(scale(f.e1, Math.cos(a)), scale(f.e2, Math.sin(a)));
                const tangent = cross(f.axis, radial);
                const out = add(scale(radial, jitter(1, 3)), scale(tangent, jitter(3, 8) * (spin.direction ?? 1)));
                ctx.particles.emit(add(f.hub, scale(radial, 0.15)), SPARK, add(out, vec3(0, jitter(0.5, 2), 0)));
              }
            }
          }
          shine(arm, spec, dt);
        }
      }
      for (const arm of [...grind.keys()]) if (!arm.block.alive) grind.delete(arm);
      for (const arm of [...glimmer.keys()]) if (!arm.block.alive) glimmer.delete(arm);
    },
    dispose() {
      off();
      live.dispose();
      grind.clear();
      trails.clear();
      glimmer.clear();
      lashes.clear();
      fieldHits.length = 0;
    },
  };

  /** Ce qu'émet une arme d'énergie entre deux coups (son bloc est lisible : vérifié par l'appelant). */
  function shine(arm: MeleeArm, spec: MeleeSpec, dt: number): void {
    switch (spec.look) {
      case "saber": {
        const f = meleeFrame(arm);
        if (distance(f.hub, ctx.eye) > FX_RANGE) return;
        // Dans l'eau, elle s'éteint en grésillant : de la vapeur monte de son émetteur
        if (inWater(ctx.world.arena, f.hub)) {
          for (let i = emitting(arm, 8, dt); i > 0; i--) ctx.particles.emit(add(f.hub, vec3(jitter(-0.2, 0.2), 0, jitter(-0.2, 0.2))), STEAM, vec3(0, jitter(0.5, 1.2), 0));
          return;
        }
        // Allumée, son arc pétille : de petites étincelles bleutées sur le cercle qu'elle balaie
        if (arm.spin < LIT_FROM * spec.spin!.speed) return;
        const outer = spec.blade!.outer;
        for (let i = emitting(arm, 14, dt); i > 0; i--) {
          const a = jitter(0, Math.PI * 2);
          const radial = add(scale(f.e1, Math.cos(a)), scale(f.e2, Math.sin(a)));
          const at = add(f.hub, scale(radial, jitter(0.6, 1) * outer));
          ctx.particles.emit(at, ARC_SPARK, add(scale(cross(f.axis, radial), jitter(2, 5)), scale(radial, jitter(0.5, 2))));
        }
        return;
      }
      case "whip": {
        // Sa tête trace une traînée de plasma le long de sa course
        const swing = spec.swing!;
        if (arm.phase !== "strike") {
          lashes.delete(arm);
          return;
        }
        const head = headAt(meleeFrame(arm), swing, arm.swing);
        if (distance(head, ctx.eye) > FX_RANGE) return;
        const last = lashes.get(arm);
        if (last && distance(last, head) > 0.02) {
          ctx.streaks.line(last, head, LASH);
          ctx.streaks.line(last, head, LASH_CORE);
        }
        lashes.set(arm, head);
        return;
      }
      case "lance": {
        // Chargée, sa pointe crépite : de petites étincelles bleues, parfois un arc minuscule
        if (arm.phase === "recover") return;
        const tip = tipAt(meleeFrame(arm), arm.swing);
        if (distance(tip, ctx.eye) > FX_RANGE) return;
        for (let i = emitting(arm, 6, dt); i > 0; i--) {
          const out = norm(vec3(jitter(-1, 1), jitter(-1, 1), jitter(-1, 1)));
          if (Math.random() < 0.3) bolt(ctx, tip, add(tip, scale(out, jitter(0.12, 0.25))), BOLT, BOLT_HALO, 2);
          else ctx.particles.emit(tip, BLUE_SPARK, scale(out, jitter(0.5, 2)));
        }
        return;
      }
      case "field": {
        // Armé, des lueurs violettes montent doucement autour de son projecteur
        if (arm.spin < LIT_FROM * 2 * spec.spin!.speed) return;
        const f = meleeFrame(arm);
        if (distance(f.hub, ctx.eye) > FX_RANGE) return;
        for (let i = emitting(arm, 3, dt); i > 0; i--) {
          const a = jitter(0, Math.PI * 2);
          ctx.particles.emit(add(f.hub, add(scale(f.e1, Math.cos(a) * 0.3), scale(f.e2, Math.sin(a) * 0.3))), MOTE, vec3(0, jitter(0.2, 0.6), 0));
        }
        return;
      }
      default:
        return;
    }
  }
}
