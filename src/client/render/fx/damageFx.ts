import { blockDef } from "../../../shared/catalog/blocks";
import { weaponDef } from "../../../shared/catalog/weapons";
import { wheelDef } from "../../../shared/catalog/wheels";
import { WRECK_INTEGRITY } from "../../../shared/combat/damage";
import { turretFrame } from "../../../shared/combat/turrets";
import { distance, vec3, type Vec3 } from "../../../shared/math/vec";
import { integrity } from "../../../shared/robot/queries";
import type { Block, Bot, Part, Turret, Wheel } from "../../../shared/sim/entities";
import { FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import type { PuffSpec } from "./particles";
import { countOf, LiveSet } from "./tracking";

/*
 * Dégâts visibles : blocs abîmés qui fument, organes électriques qui crépitent, robot au bord de la
 * destruction qui flambe, morceaux arrachés qui fument en volant, épave qui fume, roues abîmées,
 * épaves de roues qui brûlent, canons qui rougeoient en chauffant. Tout se lit dans ce que lit le
 * rendu (points de structure, chaleur des armes, poses) : cela marche aussi en réseau, sauf les
 * roues abîmées (leurs points de structure ne passent pas par les instantanés).
 */

/** Seuils : un bloc fume sous la moitié de ses points, épaissement sous le quart. */
const SMOKE_BELOW = 0.5;
const HEAVY_BELOW = 0.25;
/**
 * Fumée d'un robot abîmé : volutes par seconde pour chaque bloc qui fume (un peu, beaucoup), et au
 * plus pour tout le robot : quelques volutes, tirées parmi ses blocs abîmés, pas un nuage qui le cache.
 */
const LIGHT_RATE = 0.5;
const HEAVY_RATE = 1.2;
const BOT_SMOKE = 5;
/** Un organe électrique crépite sous cette part de ses points. */
const ELECTRIC_BELOW = 0.6;
/** Le robot flambe quand la part de ses blocs encore reliés au cockpit approche de la règle de structure. */
const CRITICAL_MARGIN = 0.2;
/** Un morceau arraché fume tant qu'il va vite, pendant au plus ce temps (s) après s'être détaché. */
const DETACHED_LIFE = 6;
const DETACHED_SPEED = 2.5;
/** Espacement des bouffées de la traînée d'un morceau arraché (m). */
const DETACHED_SPACING = 0.45;
/** Colonne de fumée d'une épave : sa durée (s), et le temps pendant lequel elle flambe d'abord. */
const WRECK_SMOKE = 9;
const WRECK_FLAMES = 2.2;
/** Épave de roue : elle brûle ce temps (s) après avoir été arrachée. */
const WHEEL_BURN = 6;
/** Canon : il rougeoie au-delà de cette chaleur (0 à 1), et fume en refroidissant au-dessus de celle-ci. */
const GLOW_HEAT = 0.5;
const SMOKE_HEAT = 0.25;

const LIGHT_SMOKE: PuffSpec = { color: "#80848a", kind: "smoke", size: 0.14, grow: 0.9, life: 1.6, alpha: 0.22, fadeIn: 0.2, drag: 1.4, gravity: -0.9 };
const HEAVY_SMOKE: PuffSpec = { color: "#2e3033", kind: "smoke", size: 0.2, grow: 1.3, life: 2.2, alpha: 0.36, fadeIn: 0.12, drag: 1.3, gravity: -1.1 };
const BLAZE_SMOKE: PuffSpec = { color: "#262729", kind: "smoke", size: 0.3, grow: 1.8, life: 2.6, alpha: 0.45, fadeIn: 0.1, drag: 1.2, gravity: -1.4 };
const SPARK: PuffSpec = { color: "#ffd27a", kind: "glow", size: 0.035, life: 0.4, gravity: 9.8, drag: 0.6, stretch: 0.03 };
const ARC: PuffSpec = { color: "#a8e6ff", kind: "glow", size: 0.1, grow: 0.32, life: 0.08, alpha: 0.9 };
const ARC_SPARK: PuffSpec = { color: "#d6f4ff", kind: "glow", size: 0.03, life: 0.25, gravity: 6, drag: 1, stretch: 0.03 };
const FLAME: PuffSpec = { color: "#ff6a14", kind: "fire", size: 0.5, grow: 0.1, life: 0.45, alpha: 0.9, gravity: -3.5, drag: 1.2, heat: 0.75 };
const FLAME_CORE: PuffSpec = { color: "#ffc24a", kind: "fire", size: 0.3, grow: 0.06, life: 0.28, alpha: 0.95, gravity: -3, drag: 1.2, heat: 1 };
const WRECK_COLUMN: PuffSpec = { color: "#222326", kind: "smoke", size: 0.6, grow: 3.4, life: 4.5, alpha: 0.5, fadeIn: 0.08, drag: 0.8, gravity: -2.4 };
const EMBER: PuffSpec = { color: "#ff9a3a", kind: "glow", size: 0.05, life: 1.2, gravity: 3, drag: 0.8, stretch: 0.02 };
const TRAIL_SMOKE: PuffSpec = { color: "#4a4d51", kind: "smoke", size: 0.25, grow: 1.3, life: 1.6, alpha: 0.42, drag: 1.5, gravity: -0.6 };
const BARREL_SMOKE: PuffSpec = { color: "#a0a4a8", kind: "smoke", size: 0.07, grow: 0.5, life: 1.3, alpha: 0.32, drag: 1.5, gravity: -0.9 };
/** Rougeoiement du canon, du rouge sombre à l'orange vif selon la chaleur. */
const HEAT_COLORS = ["#6e1c0b", "#9a2a0e", "#c83f12", "#f25f18", "#ff8c30"];

/** Une épave qui fume : le robot détruit, depuis quand, et où (le plus gros de ses morceaux encore là). */
interface Wreck {
  bot: Bot;
  at: number;
  pos: Vec3 | null;
}

export function damageFx(ctx: FxContext): FxSystem {
  const live = new LiveSet(ctx.world);
  /** Blocs abîmés (sous `SMOKE_BELOW`), d'après les événements : on ne parcourt pas tous les blocs à chaque image. */
  const damaged = new Set<Block>();
  const wrecks: Wreck[] = [];
  /** Dernière position connue du cockpit de chaque robot (pour une épave dont tous les morceaux ont disparu). */
  const lastPos = new Map<Bot, Vec3>();
  /** Morceaux détachés : depuis quand (horloge de la page), et le dernier point de leur traînée. */
  const detached = new Map<Part, { since: number; last: Vec3 | null }>();
  /** Épaves de roues : depuis quand elles sont arrachées (horloge de la page). */
  const released = new Map<Wheel, number>();
  /** Chaleur de chaque arme à l'image précédente (elle refroidit : il fume). */
  const heat = new Map<Turret, number>();

  const share = (b: Block): number => b.hp / blockDef(b.type).hp;
  const note = (b: Block): void => {
    if (b.alive && share(b) < SMOKE_BELOW) damaged.add(b);
    else damaged.delete(b);
  };
  // Les blocs déjà abîmés (le système naît avec une partie en cours, ou en rejoignant une partie en réseau)
  for (const bot of ctx.world.bots) for (const b of bot.blocks.values()) note(b);
  // Les roues déjà arrachées ne brûlent plus
  for (const bot of ctx.world.bots) for (const w of bot.wheels) if (!w.hub) released.set(w, -Infinity);

  const off = ctx.world.on((e) => {
    switch (e.type) {
      case "blockDamaged":
      case "blockRepaired":
      case "blockRebuilt":
        note(e.block);
        break;
      case "blockDestroyed":
        damaged.delete(e.block);
        break;
      case "botKilled":
        wrecks.push({ bot: e.bot, at: ctx.now, pos: lastPos.get(e.bot) ?? null });
        break;
      case "botRemoved":
        lastPos.delete(e.bot);
        byBot.delete(e.bot);
        for (const b of e.bot.blocks.values()) damaged.delete(b);
        for (const w of e.bot.wheels) released.delete(w);
        for (const t of e.bot.turrets) heat.delete(t);
        break;
      case "partRemoved":
        detached.delete(e.part);
        break;
      case "wheelRemoved":
        released.delete(e.wheel);
        break;
    }
  });

  const near = (p: Vec3): boolean => distance(p, ctx.eye) < FX_RANGE;
  const up = (speed: number): Vec3 => vec3(jitter(-0.3, 0.3), speed, jitter(-0.3, 0.3));

  /** Une gerbe d'étincelles en `at`, projetées vers le haut et en tous sens. */
  const sparks = (at: Vec3, n: number, spec: PuffSpec, speed: number): void => {
    for (let i = 0; i < n; i++) {
      ctx.particles.emit(at, spec, vec3(jitter(-1, 1) * speed, jitter(0.2, 1.2) * speed, jitter(-1, 1) * speed));
    }
  };

  /** Blocs abîmés de chaque robot, refaits à chaque image d'après `damaged` (seulement ceux qu'on peut lire). */
  const byBot = new Map<Bot, Block[]>();

  /** 25, 26 : blocs abîmés qui fument ; organes électriques qui crépitent. */
  const smokeBlocks = (dt: number): void => {
    for (const list of byBot.values()) list.length = 0;
    for (const b of damaged) {
      if (!live.blockOk(b)) {
        if (!b.alive) damaged.delete(b);
        continue;
      }
      let list = byBot.get(b.bot);
      if (!list) {
        list = [];
        byBot.set(b.bot, list);
      }
      list.push(b);
    }
    for (const [bot, blocks] of byBot) {
      if (!blocks.length) {
        byBot.delete(bot);
        continue;
      }
      if (bot === ctx.inside) continue;
      // Quelques volutes pour tout le robot, chacune d'un de ses blocs abîmés (les plus touchés plus souvent)
      let rate = 0;
      for (const b of blocks) rate += share(b) < HEAVY_BELOW ? HEAVY_RATE : LIGHT_RATE;
      const n = countOf(Math.min(BOT_SMOKE, rate) * ctx.density, dt);
      for (let i = 0; i < n; i++) {
        const a = blocks[Math.floor(Math.random() * blocks.length)];
        const c = blocks[Math.floor(Math.random() * blocks.length)];
        const b = share(a) < share(c) ? a : c;
        const pos = live.blockPos(b)!;
        if (!near(pos)) break;
        const v = b.part.rb.linvel();
        const at = vec3(pos.x + jitter(-0.15, 0.15), pos.y + 0.2, pos.z + jitter(-0.15, 0.15));
        ctx.particles.emit(at, share(b) < HEAVY_BELOW ? HEAVY_SMOKE : LIGHT_SMOKE, vec3(v.x * 0.25 + jitter(-0.2, 0.2), 0.8 + v.y * 0.25, v.z * 0.25 + jitter(-0.2, 0.2)));
      }
      // Organes électriques : des arcs et des étincelles, par à-coups
      for (const b of blocks) {
        const def = blockDef(b.type);
        const s = share(b);
        if (!(def.battery || def.shield || def.radar || def.jammer) || s >= ELECTRIC_BELOW) continue;
        const arcs = countOf((1 - s) * 3 * ctx.density, dt);
        if (arcs === 0) continue;
        const pos = live.blockPos(b)!;
        if (!near(pos)) continue;
        for (let i = 0; i < arcs; i++) {
          const at = vec3(pos.x + jitter(-0.22, 0.22), pos.y + jitter(-0.1, 0.25), pos.z + jitter(-0.22, 0.22));
          ctx.particles.emit(at, ARC);
          sparks(at, 3 + Math.floor(Math.random() * 4), Math.random() < 0.5 ? ARC_SPARK : SPARK, 2.5);
        }
      }
    }
  };

  /**
   * Flammes et fumée épaisse autour d'un point (robot à bout, épave). Les flammes partent à la
   * vitesse de ce qui brûle : elles filent avec le robot (l'air les freine et les couche derrière
   * lui) au lieu de rester en arrière, chacune à sa place, ce qui faisait avancer le feu par à-coups.
   */
  const blaze = (at: Vec3, vel: Vec3, flames: number, smoke: number, spread: number): void => {
    for (let i = 0; i < flames; i++) {
      const p = vec3(at.x + jitter(-spread, spread), at.y + jitter(0, 0.3), at.z + jitter(-spread, spread));
      ctx.particles.emit(p, Math.random() < 0.4 ? FLAME_CORE : FLAME, vec3(vel.x, vel.y + 0.3, vel.z));
    }
    for (let i = 0; i < smoke; i++) {
      const p = vec3(at.x + jitter(-spread, spread), at.y + 0.4, at.z + jitter(-spread, spread));
      ctx.particles.emit(p, BLAZE_SMOKE, vec3(vel.x * 0.3 + jitter(-0.2, 0.2), 0.8, vel.z * 0.3 + jitter(-0.2, 0.2)));
    }
  };

  /**
   * 27 : robot près de la règle de structure : il flambe. Les flammes sortent de ses blocs les plus
   * abîmés, là où on les voit (le cockpit est souvent enfoui au cœur du robot), sinon du cockpit.
   */
  const criticalBots = (dt: number): void => {
    for (const bot of ctx.world.bots) {
      const ck = bot.cockpit;
      if (!live.blockOk(ck)) continue;
      const pos = live.blockPos(ck)!;
      lastPos.set(bot, pos);
      const k = (WRECK_INTEGRITY + CRITICAL_MARGIN - integrity(bot)) / CRITICAL_MARGIN;
      if (k <= 0 || bot === ctx.inside || !near(pos)) continue;
      const level = Math.min(1, k);
      const spots = (byBot.get(bot) ?? []).filter((b) => share(b) < HEAVY_BELOW);
      const v = ck.part.rb.linvel();
      const bursts = countOf((3 + 8 * level) * ctx.density, dt);
      for (let i = 0; i < bursts; i++) {
        const spot = spots.length ? live.blockPos(spots[Math.floor(Math.random() * spots.length)])! : pos;
        blaze(vec3(spot.x, spot.y + 0.25, spot.z), v, 2, Math.random() < 0.5 ? 1 : 0, 0.2);
      }
    }
  };

  /** 28 : morceaux arrachés qui fument et crachent des étincelles tant qu'ils volent. */
  const flyingParts = (dt: number): void => {
    for (const part of live.parts) {
      const bot = part.bot;
      const loose = !bot.cockpit.alive || part !== bot.cockpit.part;
      if (!loose) continue;
      let state = detached.get(part);
      if (!state) {
        state = { since: ctx.now, last: null };
        detached.set(part, state);
      }
      if (ctx.now - state.since > DETACHED_LIFE) continue;
      const v = part.rb.linvel();
      const pos = part.rb.translation();
      if (Math.hypot(v.x, v.y, v.z) < DETACHED_SPEED || !near(pos)) {
        state.last = null;
        continue;
      }
      if (state.last) {
        const gap = distance(state.last, pos);
        const spacing = DETACHED_SPACING / ctx.density;
        const steps = Math.min(8, Math.floor(gap / spacing));
        for (let i = 1; i <= steps; i++) {
          const k = (i * spacing) / gap;
          ctx.particles.emit(vec3(state.last.x + (pos.x - state.last.x) * k, state.last.y + (pos.y - state.last.y) * k, state.last.z + (pos.z - state.last.z) * k), TRAIL_SMOKE, up(0.3));
        }
        if (steps > 0) state.last = pos;
      } else state.last = pos;
      const n = countOf(6 * ctx.density, dt);
      if (n > 0) sparks(pos, n, SPARK, 2);
    }
  };

  /** 29 : colonne de fumée de l'épave, qui flambe d'abord. */
  const smokeWrecks = (dt: number): void => {
    for (let i = wrecks.length - 1; i >= 0; i--) {
      const w = wrecks[i];
      const age = ctx.now - w.at;
      // Le plus gros de ses morceaux encore là
      let biggest: Part | null = null;
      for (const part of w.bot.parts) if (live.parts.has(part) && (!biggest || part.blocks.size > biggest.blocks.size)) biggest = part;
      // (pulvérisée, l'épave fume encore là où elle était)
      if (biggest) w.pos = biggest.rb.translation();
      if (age > WRECK_SMOKE || !w.pos) {
        wrecks.splice(i, 1);
        continue;
      }
      if (!near(w.pos)) continue;
      const fade = 1 - age / WRECK_SMOKE;
      const n = countOf(7 * fade * ctx.density, dt);
      for (let j = 0; j < n; j++) ctx.particles.emit(vec3(w.pos.x + jitter(-0.4, 0.4), w.pos.y + 0.3, w.pos.z + jitter(-0.4, 0.4)), WRECK_COLUMN, up(1.2), 0.7 + fade * 0.5);
      if (age < WRECK_FLAMES) {
        const k = 1 - age / WRECK_FLAMES;
        blaze(w.pos, vec3(0, 0, 0), countOf(20 * k * ctx.density, dt), 0, 0.6);
        const embers = countOf(12 * k * ctx.density, dt);
        for (let j = 0; j < embers; j++) ctx.particles.emit(w.pos, EMBER, vec3(jitter(-2.5, 2.5), jitter(2, 6), jitter(-2.5, 2.5)));
      }
    }
  };

  /** 31 : roues abîmées qui fument, jantes qui raclent, épaves de roues qui brûlent. */
  const wheels = (dt: number): void => {
    for (const bot of ctx.world.bots) {
      for (const w of bot.wheels) {
        if (!live.wheelOk(w)) continue;
        if (w.hub) {
          // Montée : ses points de structure (en réseau, ils ne passent pas : elle ne fume pas)
          if (!w.part || !live.parts.has(w.part) || bot === ctx.inside) continue;
          const def = wheelDef(w.type);
          const s = w.hp / def.hp;
          if (s >= SMOKE_BELOW) continue;
          const n = countOf((s < HEAVY_BELOW ? 3 : 1.2) * ctx.density, dt);
          const scrape = s < HEAVY_BELOW && w.load > 0;
          if (n === 0 && !scrape) continue;
          const pos = w.rb.translation();
          if (!near(pos)) continue;
          for (let i = 0; i < n; i++) ctx.particles.emit(pos, s < HEAVY_BELOW ? HEAVY_SMOKE : LIGHT_SMOKE, up(0.5), 0.8);
          if (scrape) {
            // La jante racle : des étincelles au point de contact, projetées vers l'arrière
            const v = w.part.rb.linvel();
            const speed = Math.hypot(v.x, v.z);
            const m = countOf(Math.min(30, speed * 3) * ctx.density, dt);
            const contact = vec3(pos.x, pos.y - def.radius * 0.85, pos.z);
            for (let i = 0; i < m; i++) ctx.particles.emit(contact, SPARK, vec3(-v.x * 0.5 + jitter(-1.5, 1.5), jitter(1, 3), -v.z * 0.5 + jitter(-1.5, 1.5)));
          }
          continue;
        }
        // Arrachée : elle brûle un moment
        let since = released.get(w);
        if (since === undefined) {
          since = ctx.now;
          released.set(w, since);
        }
        const age = ctx.now - since;
        if (age > WHEEL_BURN) continue;
        const pos = w.rb.translation();
        if (!near(pos)) continue;
        const k = 1 - age / WHEEL_BURN;
        const r = wheelDef(w.type).radius;
        for (let i = countOf(10 * k * ctx.density, dt); i > 0; i--) {
          ctx.particles.emit(vec3(pos.x + jitter(-r, r) * 0.6, pos.y + jitter(0, r), pos.z + jitter(-r, r) * 0.6), Math.random() < 0.4 ? FLAME_CORE : FLAME, up(0.3), 0.7);
        }
        for (let i = countOf(3 * k * ctx.density, dt); i > 0; i--) ctx.particles.emit(vec3(pos.x, pos.y + r, pos.z), HEAVY_SMOKE, up(0.8), 0.9);
      }
    }
  };

  /** 32 : canons qui rougeoient en chauffant, et fument en refroidissant. */
  const hotBarrels = (dt: number): void => {
    for (const bot of ctx.world.bots) {
      if (bot === ctx.inside) continue;
      for (const t of bot.turrets) {
        // (le rayon réparateur chauffe aussi, mais un faisceau vert qui rougirait n'aurait pas de sens)
        const weapon = weaponDef(t.weapon);
        if (!weapon.heat || weapon.projectile.repair) continue;
        const level = t.arm.heat;
        const before = heat.get(t) ?? level;
        heat.set(t, level);
        if (level < SMOKE_HEAT || !live.blockOk(t.block)) continue;
        const cooling = level < before;
        if (level < GLOW_HEAT && !cooling) continue;
        const { muzzle, dir } = turretFrame(t);
        if (!near(muzzle)) continue;
        if (level >= GLOW_HEAT) {
          // Une lueur continue au bout du canon, qui vire du rouge sombre à l'orange vif
          const k = (level - GLOW_HEAT) / (1 - GLOW_HEAT);
          const color = HEAT_COLORS[Math.min(HEAT_COLORS.length - 1, Math.floor(k * HEAT_COLORS.length))];
          const back = vec3(muzzle.x - dir.x * 0.12, muzzle.y - dir.y * 0.12, muzzle.z - dir.z * 0.12);
          ctx.particles.emit(back, { color, kind: "glow", size: 0.13 + 0.08 * k, life: Math.max(0.08, dt * 1.6), alpha: 0.75 + 0.25 * k });
        }
        if (cooling || t.arm.overheated) {
          const n = countOf((t.arm.overheated ? 9 : 3.5) * level * ctx.density, dt);
          for (let i = 0; i < n; i++) ctx.particles.emit(muzzle, BARREL_SMOKE, vec3(dir.x * 0.4 + jitter(-0.1, 0.1), 0.4, dir.z * 0.4 + jitter(-0.1, 0.1)));
        }
      }
    }
  };

  return {
    update(dt) {
      if (dt <= 0) return;
      smokeBlocks(dt);
      criticalBots(dt);
      flyingParts(dt);
      smokeWrecks(dt);
      wheels(dt);
      hotBarrels(dt);
    },
    dispose() {
      off();
      live.dispose();
      damaged.clear();
      wrecks.length = 0;
      detached.clear();
      released.clear();
      heat.clear();
      lastPos.clear();
      byBot.clear();
    },
  };
}
