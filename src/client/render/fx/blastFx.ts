import { groundLevel, spotPose } from "../../../shared/arena/layout";
import { propDef } from "../../../shared/catalog/props";
import type { ExplosionLook } from "../../../shared/catalog/weapons";
import { add, distance, qrot, scale, vec3, type Vec3 } from "../../../shared/math/vec";
import type { Prop } from "../../../shared/sim/entities";
import { emissions, FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import { surfaceAt, type MarkSpec } from "./marks";
import type { PuffSpec } from "./particles";
import { groundRgb, toHex } from "./tracking";

/*
 * Ce qui reste d'une explosion, et le décor qui réagit : cratère et brûlure au sol, fumée qui
 * monte encore quelques secondes, braises qui retombent en arcs, poussière soulevée par le
 * souffle ; jet de gaz d'une bouteille percée, étincelles de la mèche d'un baril, fumée des ruines
 * d'un bâtiment. L'explosion elle-même : en effets simples, des sphères (render/effects.ts,
 * `EXPLOSION_STYLES`) ; en effets réalistes, ici (`FIREBALLS`) : un éclair, des boules de feu qui
 * roulent en s'élargissant puis noircissent en fumée, la fumée qui monte, la terre projetée. Les
 * arbres qui ploient, dans WorldView.
 */

/** Marques au sol d'une explosion, en rayons d'explosion : cratère sombre, brûlure autour, terre projetée. */
interface Crater {
  crater: number;
  scorch: number;
  /** Anneau de terre retournée autour (mine, bombe). */
  dirt?: number;
  /** Braises projetées. */
  embers: number;
  /** Fumée résiduelle : durée (s). */
  smolder: number;
}

/** Chaque allure d'explosion a ses traces (TypeScript refuse une allure sans les siennes). */
const CRATERS: Record<ExplosionLook, Crater> = {
  shell: { crater: 0.45, scorch: 0.95, embers: 5, smolder: 3 },
  missile: { crater: 0.5, scorch: 1, embers: 7, smolder: 4 },
  rocket: { crater: 0.4, scorch: 0.85, embers: 3, smolder: 2 },
  flak: { crater: 0.3, scorch: 0.7, embers: 6, smolder: 1.5 },
  mine: { crater: 0.4, scorch: 0.65, dirt: 0.95, embers: 4, smolder: 3 },
  // (une bombe tombe en chapelet : ses cratères se recouvrent, ils restent mesurés)
  bomb: { crater: 0.38, scorch: 0.7, dirt: 0.95, embers: 10, smolder: 5 },
  napalm: { crater: 0.3, scorch: 1.25, embers: 12, smolder: 6 },
  warhead: { crater: 0.35, scorch: 0.75, dirt: 0.95, embers: 18, smolder: 8 },
  barrel: { crater: 0.3, scorch: 0.9, embers: 10, smolder: 5 },
  gas: { crater: 0.2, scorch: 0.8, embers: 5, smolder: 2 },
  car: { crater: 0.25, scorch: 1.1, embers: 14, smolder: 8 },
};

const CRATER_MARK: MarkSpec = { color: "#16120e", life: 60, alpha: 0.75, fade: 0.35 };
const SCORCH_MARK: MarkSpec = { color: "#2a231c", life: 60, alpha: 0.4, fade: 0.35 };
const DIRT_MARK: MarkSpec = { color: "#5a4a37", life: 60, alpha: 0.32, fade: 0.35 };
/** Une explosion à plus de cette part de son rayon au-dessus du sol n'y laisse pas de trace (flak en l'air). */
const GROUND_REACH = 0.8;

const SMOLDER: PuffSpec = { color: "#57524d", kind: "smoke", size: 0.6, grow: 2.6, life: 3.2, alpha: 0.4, gravity: -0.7, drag: 0.5, fadeIn: 0.2 };
const DUST: PuffSpec = { color: "#9d8d74", kind: "smoke", size: 0.5, grow: 1.6, life: 1.5, alpha: 0.4, drag: 2.6, gravity: -0.25, fadeIn: 0.05 };
const EMBER_HEAD: PuffSpec = { color: "#ffd27a", kind: "glow", size: 0.22, life: 0.06, alpha: 1 };
const EMBER_TRAIL: PuffSpec = { color: "#ff8c2a", kind: "glow", size: 0.15, grow: 0.03, life: 0.5, alpha: 0.8 };
const EMBER_SMOKE: PuffSpec = { color: "#6a6560", kind: "smoke", size: 0.1, grow: 0.5, life: 0.9, alpha: 0.35, gravity: -0.3 };
const SPARK: PuffSpec = { color: "#ffd27a", kind: "glow", size: 0.06, life: 0.45, alpha: 1, gravity: 9.8, stretch: 0.03 };
const GAS: PuffSpec = { color: "#e3edf5", kind: "vapor", size: 0.12, grow: 1.1, life: 0.7, alpha: 0.5, drag: 3.2, fadeIn: 0.05 };
const RUIN_SMOKE: PuffSpec = { color: "#6f6962", kind: "smoke", size: 1, grow: 3.4, life: 5, alpha: 0.32, gravity: -0.6, drag: 0.4, fadeIn: 0.2 };
const RUIN_SMOKE_DARK: PuffSpec = { ...RUIN_SMOKE, color: "#3b3835", alpha: 0.42 };

/**
 * L'explosion elle-même, en effets réalistes (tailles en rayons d'explosion, durées en s) : un
 * éclair bref, des boules de feu qui s'élargissent en roulant puis refroidissent en fumée (elles
 * brûlent `burn` de leur vie), la fumée qui suit et monte, et pour une mine ou une bombe une gerbe
 * de terre qui jaillit puis retombe. TypeScript refuse une allure sans la sienne.
 */
interface Fireball {
  /** Éclair : diamètre, couleur. */
  flash: number;
  flashColor: string;
  /** Boules de feu : nombre, diamètre au départ et à la fin, durée, part de vie où elles brûlent, vitesse (rayons/s), montée (m/s). */
  fire: number;
  from: number;
  to: number;
  life: number;
  burn: number;
  burst: number;
  rise: number;
  /** Couleur de la fumée qu'elles deviennent. */
  soot: string;
  /** Fumée qui suit : nombre, diamètre (rayons), durée, opacité, montée (m/s). */
  smoke: number;
  smokeColor: string;
  smokeSize: number;
  smokeLife: number;
  smokeAlpha: number;
  smokeRise: number;
  /** Gerbe de terre : nombre de mottes de fumée brune et hauteur où elles montent (m/s). */
  dirt?: { count: number; speed: number };
}

const FIREBALLS: Record<ExplosionLook, Fireball> = {
  shell: { flash: 1.6, flashColor: "#ffe2a8", fire: 6, from: 0.45, to: 1.2, life: 0.9, burn: 0.45, burst: 2.2, rise: 0.8, soot: "#4b4845", smoke: 4, smokeColor: "#6c6863", smokeSize: 1.3, smokeLife: 2.2, smokeAlpha: 0.5, smokeRise: 1.2, dirt: { count: 5, speed: 5 } },
  missile: { flash: 1.8, flashColor: "#fff1d0", fire: 8, from: 0.5, to: 1.4, life: 1.1, burn: 0.5, burst: 2.4, rise: 1.2, soot: "#2c2a28", smoke: 5, smokeColor: "#3a3836", smokeSize: 1.5, smokeLife: 3, smokeAlpha: 0.6, smokeRise: 1.6 },
  rocket: { flash: 1.6, flashColor: "#fff1d0", fire: 5, from: 0.4, to: 1.1, life: 0.7, burn: 0.45, burst: 2.2, rise: 0.8, soot: "#55524e", smoke: 3, smokeColor: "#8a8682", smokeSize: 1.2, smokeLife: 1.8, smokeAlpha: 0.45, smokeRise: 1 },
  flak: { flash: 1.6, flashColor: "#ffe2a8", fire: 5, from: 0.4, to: 1.1, life: 0.6, burn: 0.4, burst: 2, rise: 0, soot: "#1f2022", smoke: 0, smokeColor: "#26282b", smokeSize: 1.4, smokeLife: 2, smokeAlpha: 0.6, smokeRise: 0.2 },
  mine: { flash: 1.3, flashColor: "#ffd28a", fire: 4, from: 0.35, to: 0.9, life: 0.6, burn: 0.4, burst: 1.6, rise: 1, soot: "#5a4a37", smoke: 4, smokeColor: "#7a6650", smokeSize: 1.1, smokeLife: 2, smokeAlpha: 0.55, smokeRise: 1.2, dirt: { count: 10, speed: 9 } },
  bomb: { flash: 2, flashColor: "#fff1d0", fire: 9, from: 0.5, to: 1.3, life: 1.2, burn: 0.45, burst: 2.2, rise: 1.4, soot: "#33302d", smoke: 6, smokeColor: "#45413c", smokeSize: 1.4, smokeLife: 3.2, smokeAlpha: 0.6, smokeRise: 1.8, dirt: { count: 12, speed: 10 } },
  napalm: { flash: 1.6, flashColor: "#ffc070", fire: 12, from: 0.5, to: 1.4, life: 1.6, burn: 0.7, burst: 1.6, rise: 1, soot: "#2a2420", smoke: 4, smokeColor: "#2e2a27", smokeSize: 1.3, smokeLife: 2.8, smokeAlpha: 0.5, smokeRise: 1.6 },
  warhead: { flash: 2.6, flashColor: "#fff8e8", fire: 16, from: 0.45, to: 1.3, life: 2, burn: 0.5, burst: 1.8, rise: 3, soot: "#2f2c29", smoke: 10, smokeColor: "#4a4642", smokeSize: 1.2, smokeLife: 4.5, smokeAlpha: 0.6, smokeRise: 3, dirt: { count: 10, speed: 10 } },
  barrel: { flash: 1.8, flashColor: "#ffd28a", fire: 9, from: 0.5, to: 1.4, life: 1.3, burn: 0.55, burst: 1.8, rise: 1.8, soot: "#1d1c1b", smoke: 5, smokeColor: "#262524", smokeSize: 1.5, smokeLife: 3.2, smokeAlpha: 0.65, smokeRise: 2 },
  gas: { flash: 2, flashColor: "#cfeaff", fire: 6, from: 0.5, to: 1.3, life: 0.8, burn: 0.5, burst: 2.4, rise: 1, soot: "#6a6866", smoke: 2, smokeColor: "#9a9896", smokeSize: 1.2, smokeLife: 1.6, smokeAlpha: 0.35, smokeRise: 1 },
  car: { flash: 1.8, flashColor: "#ffd28a", fire: 12, from: 0.5, to: 1.5, life: 1.6, burn: 0.6, burst: 1.6, rise: 2.2, soot: "#1d1c1b", smoke: 6, smokeColor: "#232221", smokeSize: 1.6, smokeLife: 3.6, smokeAlpha: 0.7, smokeRise: 2.4 },
};

/** Une boule de feu (sa taille et sa couleur de fumée sont données à l'émission). */
const FIREBALL: PuffSpec = { color: "#333333", kind: "fire", billow: true, size: 1, life: 1, alpha: 0.95, fadeIn: 0.04, drag: 3.2, heat: 1, spin: 1.2 };
const FLASH: PuffSpec = { color: "#fff1d0", kind: "glow", size: 0.8, grow: 1.1, life: 0.08, alpha: 0.85 };
const BLAST_SMOKE: PuffSpec = { color: "#555555", kind: "smoke", size: 1, life: 2, alpha: 0.5, fadeIn: 0.12, drag: 1.6, spin: 0.5 };
/** Motte de terre projetée : une volute brune qui jaillit puis retombe. */
const DIRT_PUFF: PuffSpec = { color: "#6b5a45", kind: "smoke", size: 0.5, grow: 1.4, life: 1.5, alpha: 0.7, fadeIn: 0.03, drag: 1.2, gravity: 6, spin: 0.8 };
const BLAST_SPARK: PuffSpec = { color: "#ffd27a", kind: "glow", size: 0.07, life: 0.5, alpha: 1, gravity: 9.8, drag: 0.8, stretch: 0.035 };

/** Braises à la fois, au plus. */
const MAX_EMBERS = 120;

/** Une braise : un point qu'on suit, qui laisse une traînée en retombant. */
interface Ember {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
}

/** Un foyer de fumée qui dure : sur un cratère, sur des ruines. */
interface Smolder {
  pos: Vec3;
  until: number;
  rate: number;
  spec: PuffSpec;
  scale: number;
  spread: number;
  acc: { acc: number };
}

export function blastFx(ctx: FxContext): FxSystem {
  const embers: Ember[] = [];
  const smolders: Smolder[] = [];
  /** Accessoires tombés (qui bougent) : leur dernière position, pour la fumée de leurs ruines (on ne relit pas un corps retiré). */
  const lastAt = new Map<Prop, Vec3>();
  const sparks = { acc: 0 };
  const gas = new Map<Prop, { acc: number }>();

  /** L'explosion elle-même, en effets réalistes (voir `FIREBALLS`). */
  const fireball = (point: Vec3, radius: number, look: ExplosionLook, low: boolean): void => {
    const f = FIREBALLS[look];
    const d = ctx.density;
    ctx.particles.emit(point, { ...FLASH, color: f.flashColor }, undefined, radius * f.flash);
    // Les boules de feu partent du centre (vers le haut au sol), s'élargissent et montent
    const fires = Math.max(3, Math.round(f.fire * (0.5 + 0.5 * d)));
    for (let i = 0; i < fires; i++) {
      const dir = randomDir(low);
      const at = add(point, scale(dir, radius * jitter(0.05, 0.3)));
      const spec: PuffSpec = { ...FIREBALL, color: f.soot, size: f.from, grow: f.to, life: f.life * jitter(0.75, 1.25), burn: f.burn, gravity: -f.rise * FIREBALL.drag! };
      ctx.particles.emit(at, spec, add(scale(dir, radius * f.burst * jitter(0.5, 1.2)), vec3(0, f.rise * 0.5, 0)), radius * jitter(0.8, 1.2));
    }
    // La fumée qui suit (elle paraît à mesure que le feu s'éteint)
    const smokes = Math.round(f.smoke * d);
    for (let i = 0; i < smokes; i++) {
      const dir = randomDir(low);
      const at = add(point, add(scale(dir, radius * jitter(0.1, 0.5)), vec3(0, radius * 0.3, 0)));
      const spec: PuffSpec = {
        ...BLAST_SMOKE, color: f.smokeColor, size: f.smokeSize * 0.6, grow: f.smokeSize * 1.5, life: f.smokeLife * jitter(0.8, 1.2),
        alpha: f.smokeAlpha, fadeIn: 0.25, gravity: -f.smokeRise * BLAST_SMOKE.drag!,
      };
      ctx.particles.emit(at, spec, add(scale(dir, radius * 1.2), vec3(0, f.smokeRise * 0.5, 0)), radius * jitter(0.8, 1.2));
    }
    // La terre jaillit en gerbe, puis retombe (de la couleur du sol)
    if (f.dirt && low) {
      const c = groundRgb(ctx.world.arena, point.x, point.y, point.z);
      const spec: PuffSpec = { ...DIRT_PUFF, color: toHex(c.r * 0.62, c.g * 0.58, c.b * 0.52) };
      const count = Math.round(f.dirt.count * d);
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const up = jitter(0.7, 1);
        const side = Math.sqrt(1 - up * up);
        const speed = f.dirt.speed * jitter(0.5, 1.15) * Math.sqrt(Math.max(0.5, radius / 1.5));
        ctx.particles.emit(add(point, vec3(0, 0.1, 0)), spec, vec3(Math.cos(a) * side * speed, up * speed, Math.sin(a) * side * speed), radius * jitter(0.6, 1.1));
      }
    }
    // Des éclats incandescents
    const sparks = Math.round(10 * d);
    for (let i = 0; i < sparks; i++) {
      const dir = randomDir(low);
      ctx.particles.emit(point, BLAST_SPARK, scale(dir, jitter(8, 18)));
    }
  };

  const onExplosion = (point: Vec3, radius: number, look: ExplosionLook): void => {
    if (distance(point, ctx.eye) > FX_RANGE + 40) return;
    const style = CRATERS[look];
    const ground = surfaceAt(ctx.world.arena, point.x, point.z, point.y);
    const low = ground !== null && point.y - ground.point.y < radius * GROUND_REACH + 0.3;
    if (ctx.look === "realistic") fireball(point, radius, look, low);
    if (ground && low) {
      const { point: at, normal } = ground;
      if (style.dirt) ctx.marks.disc(at, normal, radius * style.dirt, DIRT_MARK);
      ctx.marks.disc(at, normal, radius * style.scorch, SCORCH_MARK);
      ctx.marks.disc(at, normal, radius * style.crater, CRATER_MARK);
      smolders.push({ pos: at, until: ctx.now + style.smolder, rate: 3 + radius, spec: SMOLDER, scale: Math.min(2.5, 0.6 + radius * 0.4), spread: radius * 0.5, acc: { acc: 0 } });
      // Le souffle soulève la poussière en anneau
      const count = Math.round(Math.min(26, 8 + radius * 5) * ctx.density);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + jitter(-0.2, 0.2);
        const out = vec3(Math.cos(a), 0, Math.sin(a));
        const from = add(at, vec3(out.x * radius * 0.45, 0.2, out.z * radius * 0.45));
        ctx.particles.emit(from, DUST, vec3(out.x * radius * 3.8, jitter(0.2, 1), out.z * radius * 3.8), Math.min(2.5, 0.6 + radius * 0.35) * jitter(0.8, 1.2));
      }
    }
    // Braises : vers le haut au sol, dans tous les sens en l'air
    const n = Math.round(style.embers * ctx.density);
    for (let i = 0; i < n && embers.length < MAX_EMBERS; i++) {
      const up = low ? jitter(0.35, 1) : jitter(-1, 1);
      const a = Math.random() * Math.PI * 2;
      const side = Math.sqrt(Math.max(0, 1 - up * up));
      const speed = jitter(4, 9) * Math.sqrt(Math.max(0.6, radius));
      embers.push({ pos: point, vel: vec3(Math.cos(a) * side * speed, up * speed, Math.sin(a) * side * speed), age: 0, life: jitter(1.1, 2.2) });
    }
  };

  const onRemoved = (prop: Prop): void => {
    const at = lastAt.get(prop) ?? positionOf(ctx, prop);
    lastAt.delete(prop);
    gas.delete(prop);
    // Un pan de mur ou un toit détruit : ses ruines fument (davantage s'il brûlait)
    const def = propDef(prop.type);
    if (!at || def.shape.kind !== "slab" || prop.state.kind === "intact") return;
    const size = Math.max(prop.half.x, prop.half.y, prop.half.z);
    const burnt = prop.burn > 0 || prop.charred > 0.3;
    const ground = groundLevel(ctx.world.arena, at.x, at.z);
    smolders.push({
      pos: vec3(at.x, Math.max(ground, at.y - prop.half.y) + 0.3, at.z),
      until: ctx.now + (burnt ? 30 : 16),
      rate: burnt ? 2.5 : 1.2,
      spec: burnt ? RUIN_SMOKE_DARK : RUIN_SMOKE,
      scale: Math.min(1.8, 0.7 + size * 0.3),
      spread: size,
      acc: { acc: 0 },
    });
  };

  const off = ctx.world.on((e) => {
    if (e.type === "explosion") onExplosion(e.point, e.radius, e.look);
    else if (e.type === "propRemoved") onRemoved(e.prop);
  });

  return {
    update(dt) {
      const now = ctx.now;
      // Accessoires qui bougent : leur position (pour leurs ruines) ; jets de gaz ; mèches
      for (const prop of ctx.world.props) {
        if (!prop.fixed) lastAt.set(prop, prop.rb.translation());
        const state = prop.state;
        if (state.kind === "intact") continue;
        const c = prop.rb.translation();
        if (distance(c, ctx.eye) > FX_RANGE) continue;
        const q = prop.rb.rotation();
        if (state.kind === "venting") {
          // Le gaz jaillit du trou du flanc, vers l'extérieur
          const dir = qrot(q, state.leak);
          const hole = add(c, scale(dir, prop.half.x + 0.05));
          let acc = gas.get(prop);
          if (!acc) gas.set(prop, (acc = { acc: 0 }));
          for (let i = emissions(acc, 45 * ctx.density, dt); i > 0; i--) {
            ctx.particles.emit(hole, GAS, vec3(dir.x * 13 + jitter(-1.5, 1.5), dir.y * 13 + jitter(-1, 1.5), dir.z * 13 + jitter(-1.5, 1.5)), jitter(0.8, 1.3));
          }
        } else if (state.kind === "fuse" && propDef(prop.type).explosion && !propDef(prop.type).burns) {
          // La mèche crépite au sommet du baril (une voiture, elle, flambe : voir fireFx)
          const top = add(c, qrot(q, vec3(0, prop.half.y, 0)));
          for (let i = emissions(sparks, 70 * ctx.density, dt); i > 0; i--) {
            ctx.particles.emit(top, SPARK, vec3(jitter(-2.5, 2.5), jitter(2, 6), jitter(-2.5, 2.5)));
          }
        }
      }
      // Braises en vol : elles retombent en laissant une traînée, et s'éteignent au sol
      const arena = ctx.world.arena;
      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        e.age += dt;
        e.vel = vec3(e.vel.x * (1 - 0.4 * dt), e.vel.y - 9.8 * dt, e.vel.z * (1 - 0.4 * dt));
        const next = add(e.pos, scale(e.vel, dt));
        if (e.age > e.life || next.y < groundLevel(arena, next.x, next.z)) {
          embers[i] = embers[embers.length - 1];
          embers.pop();
          continue;
        }
        ctx.particles.emit(next, EMBER_HEAD);
        ctx.particles.emit(e.pos, EMBER_TRAIL);
        if (Math.random() < 0.25) ctx.particles.emit(e.pos, EMBER_SMOKE);
        e.pos = next;
      }
      // Foyers de fumée
      for (let i = smolders.length - 1; i >= 0; i--) {
        const s = smolders[i];
        if (now > s.until) {
          smolders[i] = smolders[smolders.length - 1];
          smolders.pop();
          continue;
        }
        if (distance(s.pos, ctx.eye) > FX_RANGE) continue;
        // Elle faiblit vers la fin
        const left = Math.min(1, (s.until - now) / 3);
        for (let k = emissions(s.acc, s.rate * left * ctx.density, dt); k > 0; k--) {
          const at = vec3(s.pos.x + jitter(-1, 1) * s.spread, s.pos.y, s.pos.z + jitter(-1, 1) * s.spread);
          ctx.particles.emit(at, s.spec, vec3(jitter(-0.2, 0.2), jitter(0.4, 1), jitter(-0.2, 0.2)), s.scale * jitter(0.8, 1.2));
        }
      }
    },
    dispose() {
      off();
      embers.length = 0;
      smolders.length = 0;
      lastAt.clear();
      gas.clear();
    },
  };
}

/** Une direction au hasard ; au sol (`low`), vers le haut (l'explosion ne s'enfonce pas). */
function randomDir(low: boolean): Vec3 {
  const a = Math.random() * Math.PI * 2;
  const y = low ? jitter(0.15, 1) : jitter(-1, 1);
  const s = Math.sqrt(1 - y * y);
  return vec3(Math.cos(a) * s, y, Math.sin(a) * s);
}

/** Position d'un accessoire ancré retiré : celle de son emplacement (son corps n'est plus là). */
function positionOf(ctx: FxContext, prop: Prop): Vec3 | null {
  const spot = ctx.world.arena.props[prop.spot];
  return spot ? spotPose(spot, true).pos : null;
}
