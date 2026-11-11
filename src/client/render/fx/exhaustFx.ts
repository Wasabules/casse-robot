import { clamp } from "../../../shared/math/scalar";
import { add, cross, distance, dot, len, norm, scale, sub, vec3, type Vec3 } from "../../../shared/math/vec";
import { botJets, jetContact, jetHeat, jetRadius, type Jet, type JetContact } from "../../../shared/robot/exhaust";
import type { Bot, Thruster } from "../../../shared/sim/entities";
import { emissions, FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import { surfaceAt } from "./marks";
import type { PuffSpec } from "./particles";

/*
 * Le jet de flamme des moteurs (robot/exhaust.ts) là où il frappe une surface (un bloc, un mur,
 * un accessoire, le sol) : des flammèches qui s'étalent sur elle, une lueur, des étincelles et un
 * peu de fumée ; sur le sol, une brûlure qui fonce à mesure que le jet y reste ; dans l'eau, de la
 * vapeur. Tout se lit dans le monde affiché (la poussée des moteurs passe par le réseau) ; ce que
 * touche chaque jet se relit `CONTACT_RATE` fois par seconde, sans physique (`jetContact`). La
 * suie sur les blocs qui y cuisent est dans WorldView (`sootJets`).
 */

/** Au viseur, rien de ses propres jets à moins de cette distance de l'objectif (m). */
const OWN_NEAR = 5;
/** Ce que touche un jet se relit au plus ce nombre de fois par seconde. */
const CONTACT_RATE = 15;
/** Chaleur de référence (dégâts par seconde) : un turboréacteur à plein régime, sans postcombustion. */
const HOT = 40;
/**
 * Brûlure au sol : une marque tous les MARK_GAP s, ou dès que le point d'impact a bougé de MARK_MOVE m ;
 * à la même place, elles se superposent et foncent (cinq secondes de jet : un brun presque noir).
 */
const MARK_GAP = 1.2;
const MARK_MOVE = 0.35;
/** Le sol trouvé sous le point d'impact doit en être à moins de cette distance (m) : sinon c'est un mur, sans brûlure. */
const ON_GROUND = 0.35;

/** Flammèches qui s'étalent sur la surface : cœur jaune, flamme, langue rouge. */
const LICK: PuffSpec = { color: "#ff9a2e", kind: "fire", size: 0.26, grow: 0.08, life: 0.32, alpha: 0.8, drag: 2.2, gravity: -2.5, fadeIn: 0.1, heat: 0.85 };
const LICK_HOT: PuffSpec = { ...LICK, color: "#ffe08a", size: 0.18, life: 0.22, alpha: 0.9, heat: 1 };
const LICK_RED: PuffSpec = { ...LICK, color: "#ff4d1a", size: 0.32, life: 0.42, alpha: 0.65, heat: 0.6 };
/** Lueur de la surface chauffée : dessinée à chaque image, brève. */
const GLOW: PuffSpec = { color: "#ff8a2a", kind: "glow", size: 1, life: 0.05, alpha: 0.24 };
/** Étincelles qui rebondissent. */
const SPARK: PuffSpec = { color: "#ffc061", kind: "glow", size: 0.05, life: 0.7, alpha: 1, drag: 0.6, gravity: 6, stretch: 0.03 };
/** Fumée de ce qui cuit. */
const SMOKE: PuffSpec = { color: "#3a3734", kind: "smoke", size: 0.3, grow: 1.5, life: 1.8, alpha: 0.4, fadeIn: 0.12, drag: 0.9, gravity: -1.1 };
/** Vapeur d'un jet dans l'eau. */
const STEAM: PuffSpec = { color: "#eef3f5", kind: "vapor", size: 0.35, grow: 1.6, life: 1.2, alpha: 0.5, fadeIn: 0.08, drag: 1.2, gravity: -1.6 };
/** Brûlure au sol (des disques qui se superposent et foncent), qui reste un moment. */
const BURN = { color: "#21180f", life: 40, fade: 0.4 };

interface JetState {
  contact: JetContact | null;
  /** Heure (s) de la dernière lecture de ce que touche le jet. */
  readAt: number;
  licks: { acc: number };
  sparks: { acc: number };
  smoke: { acc: number };
  /** Dernière brûlure posée : où, et quand (heure de la page). */
  markAt: Vec3 | null;
  markTime: number;
  /** Vu à cette image (sinon, oublié). */
  seen: boolean;
}

/** Un vecteur unitaire perpendiculaire à `n`. */
const perpendicular = (n: Vec3): Vec3 => norm(Math.abs(n.y) < 0.9 ? cross(n, vec3(0, 1, 0)) : cross(n, vec3(1, 0, 0)));

/** Le jet de flamme des moteurs, là où il frappe. */
export function exhaustFx(ctx: FxContext): FxSystem {
  const states = new Map<Thruster, JetState>();
  const off = ctx.world.on((e) => {
    if (e.type === "botRemoved") for (const t of e.bot.thrusters) states.delete(t);
    else if (e.type === "arenaChanged") states.clear();
  });

  const strike = (bot: Bot, jet: Jet, s: JetState, dt: number): void => {
    const c = s.contact;
    if (!c) return;
    const d = Math.min(c.distance, jet.length);
    const point = add(jet.origin, scale(jet.dir, d));
    if (distance(point, ctx.eye) > FX_RANGE) return;
    if (ctx.inside === bot && distance(point, ctx.eye) < OWN_NEAR) return;
    const heat = clamp(jetHeat(jet, d) / HOT, 0.1, 1.4);
    const width = jetRadius(jet, d);
    const arena = ctx.world.arena;
    // Le sol (ou le dessus du décor) sous l'impact : sa normale ; un mur, un bloc : face au jet
    const ground = c.kind === "ground" ? surfaceAt(arena, point.x, point.z, point.y) : null;
    const flat = ground !== null && Math.abs(ground.point.y - point.y) < ON_GROUND + width;
    const normal = flat ? ground.normal : scale(jet.dir, -1);
    const at = flat ? vec3(point.x, ground.point.y + 0.05, point.z) : point;
    // Dans l'eau : de la vapeur, et c'est tout
    if (arena.water !== undefined && at.y < arena.water) {
      for (let i = emissions(s.smoke, 14 * heat * ctx.density, dt); i > 0; i--) {
        ctx.particles.emit(vec3(at.x + jitter(-width, width), arena.water + 0.05, at.z + jitter(-width, width)), STEAM, vec3(jitter(-0.6, 0.6), jitter(0.5, 1.6), jitter(-0.6, 0.6)), 0.7 + heat * 0.6);
      }
      return;
    }
    // Les flammes s'étalent le long de la surface, dans le sens du jet, puis montent
    const along = sub(jet.dir, scale(normal, dot(jet.dir, normal)));
    const slide = len(along) > 0.2 ? norm(along) : perpendicular(normal);
    const side = cross(normal, slide);
    ctx.particles.emit(add(at, scale(normal, 0.08)), GLOW, undefined, (0.35 + 1.1 * width) * (0.7 + 0.3 * heat) * (0.85 + 0.3 * Math.random()));
    for (let i = emissions(s.licks, 34 * heat * ctx.density, dt); i > 0; i--) {
      const spec = i % 3 === 0 ? LICK_HOT : i % 3 === 1 ? LICK : LICK_RED;
      const spread = add(scale(slide, jitter(1.2, 3.6)), scale(side, jitter(-2, 2)));
      const from = add(at, add(scale(side, jitter(-width, width)), scale(normal, jitter(0.03, 0.15))));
      ctx.particles.emit(from, spec, add(spread, scale(normal, jitter(0.4, 1.3))), 0.7 + 0.6 * heat);
    }
    for (let i = emissions(s.sparks, 9 * heat * ctx.density, dt); i > 0; i--) {
      const out = add(scale(normal, jitter(1.5, 3.5)), add(scale(slide, jitter(0.5, 3)), scale(side, jitter(-2.5, 2.5))));
      ctx.particles.emit(at, SPARK, out);
    }
    // Ce qui cuit fume (un bloc, un accessoire ; le sol, à peine)
    const smoky = c.kind === "ground" ? 1.2 : 4;
    for (let i = emissions(s.smoke, smoky * heat * ctx.density, dt); i > 0; i--) {
      ctx.particles.emit(add(at, scale(normal, 0.15)), SMOKE, add(scale(normal, 0.6), vec3(jitter(-0.3, 0.3), 0.4, jitter(-0.3, 0.3))));
    }
    // Le sol brûlé : des disques sombres qui se superposent, plus nombreux là où le jet reste
    if (flat && ground) {
      const now = ctx.now;
      if (!s.markAt || now - s.markTime > MARK_GAP || distance(s.markAt, ground.point) > MARK_MOVE) {
        ctx.marks.disc(ground.point, ground.normal, width * 1.7 + 0.12, { ...BURN, alpha: 0.12 + 0.12 * Math.min(1, heat) });
        s.markAt = ground.point;
        s.markTime = now;
      }
    }
  };

  return {
    update(dt) {
      if (dt <= 0) return;
      for (const s of states.values()) s.seen = false;
      for (const bot of ctx.world.bots) {
        if (!bot.thrusters.length) continue;
        for (const jet of botJets(ctx.world, bot)) {
          if (distance(jet.origin, ctx.eye) > FX_RANGE + jet.length) continue;
          let s = states.get(jet.thruster);
          if (!s) {
            s = { contact: null, readAt: -Infinity, licks: { acc: 0 }, sparks: { acc: 0 }, smoke: { acc: 0 }, markAt: null, markTime: 0, seen: true };
            states.set(jet.thruster, s);
          }
          s.seen = true;
          if (ctx.now - s.readAt >= 1 / CONTACT_RATE) {
            s.contact = jetContact(ctx.world, jet);
            s.readAt = ctx.now;
          }
          strike(bot, jet, s, dt);
        }
      }
      for (const [t, s] of states) if (!s.seen) states.delete(t);
    },
    dispose() {
      off();
      states.clear();
    },
  };
}
