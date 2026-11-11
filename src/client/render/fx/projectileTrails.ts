import { weaponDef, type WeaponId } from "../../../shared/catalog/weapons";
import { add, cross, distance, dot, len, norm, scale, sub, vec3, type Vec3 } from "../../../shared/math/vec";
import type { Projectile } from "../../../shared/sim/entities";
import { FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import type { PuffSpec } from "./particles";
import type { StreakSpec } from "./streaks";

/*
 * Traînées des projectiles. Tout se lit sur le monde affiché (projectiles, événements `shot`,
 * `impact`, `explosion`, `projectileRemoved`) : ça marche aussi sur la réplique du serveur.
 *
 * - Fumée des missiles, des roquettes, de l'ogive, de l'obus et du fumigène : des bouffées
 *   espacées régulièrement le long du trajet (continue à toutes les vitesses), et la flamme du
 *   propulseur ; un missile perdu (leurre éteint) crache par à-coups une fumée plus sombre.
 * - Nuée des nanites, étincelles de l'obus IEM, fumée ample des leurres.
 * - Nuage noir qui flotte là où éclate un missile anti-aérien.
 * - Missile (roquette, ogive, bombe) abattu en vol : un fragment incandescent part en vrille.
 * - Sillage de vapeur du sniper et trait ionisé du canon électrique, de la bouche à l'impact
 *   (d'après le tir et l'impact qui tombe sur sa ligne : les balles vont trop vite pour que la
 *   réplique les voie toutes).
 */

/** Au viseur, pas de traînée à moins de cette distance de l'objectif (m) pour ses propres tirs : elle boucherait la vue. */
const OWN_NEAR = 6;

/**
 * Allure de la traînée d'un projectile. Les bouffées naissent plus grosses que leur espacement :
 * la traînée reste continue avec peu de bouffées (un missile en vol en garde moins de 200 ; une
 * salve de huit roquettes, ~600).
 */
interface TrailStyle {
  /** Fumée laissée tous les `spacing` m. */
  smoke?: PuffSpec;
  spacing: number;
  /** Distance du centre du projectile à sa tuyère (m, vers l'arrière). */
  tail: number;
  /** Flamme du propulseur, à chaque image. */
  flame?: PuffSpec;
  /** Vitesse à laquelle la fumée est rejetée vers l'arrière (m/s). */
  exhaust?: number;
}

/** Fumée d'un missile : blanche, épaisse, qui s'étale et reste quelques secondes. */
const MISSILE_SMOKE: PuffSpec = { color: "#e4e6e8", kind: "smoke", size: 0.42, grow: 1.6, life: 2.4, alpha: 0.55, fadeIn: 0.05, drag: 1.5, gravity: -0.25 };
/** Flamme du propulseur : un cœur blanc-jaune qui tremble à la tuyère. */
const MISSILE_FLAME: PuffSpec = { color: "#ffc46a", kind: "glow", size: 0.42, grow: 0.12, life: 0.09, alpha: 0.95 };

const STYLES: Partial<Record<WeaponId, TrailStyle>> = {
  missile: { smoke: MISSILE_SMOKE, spacing: 0.38, tail: 0.75, flame: MISSILE_FLAME, exhaust: 1.5 },
  lockon: { smoke: { ...MISSILE_SMOKE, size: 0.4, grow: 1.3, life: 2.0 }, spacing: 0.4, tail: 0.75, flame: MISSILE_FLAME, exhaust: 1.5 },
  // Anti-aérien : une traînée grise, plus sèche
  flak: { smoke: { ...MISSILE_SMOKE, color: "#9da2a7", size: 0.38, grow: 1.1, life: 1.7, alpha: 0.5 }, spacing: 0.42, tail: 0.75, flame: MISSILE_FLAME, exhaust: 1.5 },
  // Roquettes : des traînées fines et courtes (l'éventail qui s'ouvre puis se referme se voit)
  rockets: {
    smoke: { color: "#d6d9dc", kind: "smoke", size: 0.4, grow: 0.75, life: 0.75, alpha: 0.38, fadeIn: 0.05, drag: 2, gravity: -0.2 },
    spacing: 0.45, tail: 0.42, flame: { ...MISSILE_FLAME, size: 0.26, life: 0.07 }, exhaust: 1,
  },
  // Ogive : une traînée épaisse et lumineuse, qu'on suit du regard en la pilotant
  warhead: {
    smoke: { color: "#e9e6e0", kind: "smoke", size: 0.6, grow: 2.6, life: 4.5, alpha: 0.6, fadeIn: 0.04, drag: 1.2, gravity: -0.2 },
    spacing: 0.45, tail: 1.3, flame: { color: "#ffb347", kind: "glow", size: 0.6, grow: 0.2, life: 0.1, alpha: 0.75 }, exhaust: 2,
  },
  // Obus : un léger sillage de fumée
  cannon: { smoke: { color: "#b9bcbf", kind: "smoke", size: 0.25, grow: 0.5, life: 0.6, alpha: 0.22, drag: 1.5, gravity: -0.2 }, spacing: 0.5, tail: 0.1 },
  // Fumigène : un filet gris
  smoke: { smoke: { color: "#a7abaf", kind: "smoke", size: 0.22, grow: 0.4, life: 0.8, alpha: 0.26, drag: 1.2, gravity: -0.3 }, spacing: 0.45, tail: 0.08 },
  // Leurre : une fumée blanche ample, qui dessine en retombant des arcs (des « ailes d'ange » quand un avion lâche une salve en virant)
  flare: {
    smoke: { color: "#eef0f2", kind: "smoke", size: 0.3, grow: 1.05, life: 2.4, alpha: 0.42, fadeIn: 0.05, drag: 0.8, gravity: -0.12 },
    spacing: 0.35, tail: 0, flame: { color: "#fff6c8", kind: "glow", size: 0.3, grow: 0.15, life: 0.05, alpha: 0.55 },
  },
};

/**
 * Jet du lance-flammes, en effets réalistes (en effets simples, ProjectileView dessine chaque jet
 * en boule) : chaque jet crache des boules de feu qui roulent le long de sa course, s'élargissent
 * et refroidissent (du blanc-jaune près de la buse au rouge au bout), et un peu de fumée noire au
 * bout de sa course. Trois chaleurs selon l'âge du jet.
 */
const JET_FIRE: PuffSpec = { color: "#3a3430", kind: "fire", billow: true, size: 0.22, grow: 0.45, life: 0.18, alpha: 0.9, drag: 2.5, heat: 1, burn: 1, spin: 3 };
const JET_FIRES: readonly PuffSpec[] = [JET_FIRE, { ...JET_FIRE, heat: 0.78 }, { ...JET_FIRE, heat: 0.55, life: 0.24 }];
const JET_SMOKE: PuffSpec = { color: "#2e2b29", kind: "smoke", size: 0.4, grow: 1.6, life: 1.4, alpha: 0.32, fadeIn: 0.2, drag: 1.5, gravity: -0.8 };
/** Boules de feu par seconde et par jet, et fumées par seconde au bout de sa course. */
const JET_RATE = 42;
const JET_SMOKE_RATE = 5;

/** Fumée d'un missile perdu (leurre éteint) : plus sombre, crachée par à-coups. */
const LOST_SMOKE: PuffSpec = { color: "#5c6065", kind: "smoke", size: 0.3, grow: 1.3, life: 2.2, alpha: 0.6, drag: 1.5, gravity: -0.2 };
/** Rythme des à-coups d'un missile perdu (par seconde). */
const SPUTTER_RATE = 6;

/** Nanites : une nuée d'étincelles vertes qui scintillent autour d'elles, par seconde. */
const NANITE_SPARK: PuffSpec = { color: "#9dffbf", kind: "glow", size: 0.09, grow: 0.03, life: 0.4, alpha: 0.95, drag: 3 };
const NANITE_RATE = 90;
/** Obus IEM : des étincelles bleues, par seconde. */
const EMP_SPARK: PuffSpec = { color: "#8fe0ff", kind: "glow", size: 0.09, grow: 0.02, life: 0.28, alpha: 0.95, drag: 4, stretch: 0.03 };
const EMP_RATE = 45;

/** Nuage noir d'un éclatement anti-aérien : il flotte quelques secondes dans le ciel. */
const FLAK_CLOUD: PuffSpec = { color: "#26282b", kind: "smoke", size: 0.8, grow: 2.2, life: 4.5, alpha: 0.7, fadeIn: 0.04, drag: 1.5, gravity: -0.06, fadeOut: 0.5 };
const FLAK_CLOUD_LIGHT: PuffSpec = { ...FLAK_CLOUD, color: "#4a4d51", alpha: 0.5, life: 3.6 };

/** Missile abattu : le fragment incandescent, sa fumée et le trait de sa vrille. */
const FRAGMENT_LIFE = 0.55;
/** Pas de la vrille (s) : un segment de son trait par pas. */
const FRAGMENT_STEP = 1 / 60;
const FRAGMENT_SPARK: PuffSpec = { color: "#ffcf7a", kind: "glow", size: 0.2, grow: 0.05, life: 0.14, alpha: 1 };
const FRAGMENT_SMOKE: PuffSpec = { color: "#3f4246", kind: "smoke", size: 0.14, grow: 0.8, life: 1.5, alpha: 0.55, drag: 1, gravity: -0.3 };
const FRAGMENT_STREAK: StreakSpec = { color: "#5a5d62", kind: "smoke", width: 0.07, widen: 0.35, life: 1.3, alpha: 0.5 };
const FRAGMENT_POP: PuffSpec = { color: "#ffb347", kind: "glow", size: 0.3, grow: 0.9, life: 0.18, alpha: 0.9 };
/** Un impact sur un projectile (`impact` de surface `projectile`) dans ce rayon (m) et ce délai (s) : il a été abattu. */
const SHOT_DOWN_NEAR = 1.6;
const SHOT_DOWN_WINDOW = 0.35;

/** Sillage de vapeur du sniper et trait ionisé du canon électrique. */
const SNIPER_VAPOR: StreakSpec = { color: "#f4f6f8", kind: "vapor", width: 0.025, widen: 0.32, life: 1.1, alpha: 0.38 };
const SNIPER_PUFF: PuffSpec = { color: "#f4f6f8", kind: "vapor", size: 0.05, grow: 0.42, life: 1.0, alpha: 0.16 };
const RAIL_CORE: StreakSpec = { color: "#bff0ff", kind: "glow", width: 0.07, widen: 0.02, life: 0.3, alpha: 0.95 };
const RAIL_ION: StreakSpec = { color: "#d6f4ff", kind: "vapor", width: 0.05, widen: 0.45, life: 0.9, alpha: 0.32 };
const RAIL_ARC: StreakSpec = { color: "#8fdcff", kind: "glow", width: 0.028, life: 0.22, alpha: 0.95 };
/** Un tir de sniper ou de canon électrique attend au plus ce délai (s) l'impact au bout de sa ligne ; sans impact, la ligne court jusqu'à `LINE_MISS` m. */
const LINE_WAIT = 0.3;
const LINE_MISS = 140;
/** Écart d'un impact à la ligne du tir (m) : au-delà, ce n'est pas le sien. */
const LINE_MATCH = 0.8;

interface Trail {
  /** Dernier point de la traînée. */
  last: Vec3;
  /** Reste des émissions à cadence (étincelles). */
  acc: number;
}

/** Fragment d'un projectile abattu, qui part en vrille. */
interface Fragment {
  center: Vec3;
  vel: Vec3;
  /** Deux axes perpendiculaires à sa course, pour la vrille. */
  u: Vec3;
  v: Vec3;
  age: number;
  spin: number;
  last: Vec3;
}

/** Tir en ligne (sniper, canon électrique) qui attend son impact. */
interface LineShot {
  weapon: WeaponId;
  origin: Vec3;
  dir: Vec3;
  at: number;
}

export function projectileTrails(ctx: FxContext): FxSystem {
  const trails = new Map<Projectile, Trail>();
  const fragments: Fragment[] = [];
  const lines: LineShot[] = [];
  /** Impacts récents sur des projectiles (heure de la page), pour reconnaître un missile abattu en réseau. */
  const intercepts: { point: Vec3; at: number }[] = [];

  /** Trop loin, ou tout contre l'objectif au viseur pour ses propres tirs : on ne voit rien, on n'émet rien. */
  const hidden = (point: Vec3, own: boolean): boolean => {
    const d = distance(point, ctx.eye);
    return d > FX_RANGE || (own && d < OWN_NEAR);
  };

  const off = ctx.world.on((e) => {
    switch (e.type) {
      case "projectileRemoved": {
        const p = e.projectile;
        trails.delete(p);
        const spec = weaponDef(p.weapon).projectile;
        if (spec.hull && !spec.mine && (p.blown || interceptedNear(p.pos))) shotDown(p);
        break;
      }
      case "impact":
        if (e.surface === "projectile") intercepts.push({ point: e.point, at: ctx.now });
        resolveLine(e.point);
        break;
      case "explosion":
        if (e.look === "flak" && !hidden(e.point, false)) flakCloud(e.point, e.radius);
        break;
      case "shot":
        if (e.weapon === "sniper" || e.weapon === "rail") lines.push({ weapon: e.weapon, origin: e.origin, dir: norm(e.dir), at: ctx.now });
        break;
    }
  });

  function interceptedNear(point: Vec3): boolean {
    for (const i of intercepts) if (ctx.now - i.at < SHOT_DOWN_WINDOW && distance(i.point, point) < SHOT_DOWN_NEAR) return true;
    return false;
  }

  /** Un projectile abattu : un fragment incandescent part en vrille, dans le sens de sa course. */
  function shotDown(p: Projectile): void {
    if (hidden(p.pos, false)) return;
    const speed = len(p.vel);
    const dir = speed > 0.1 ? scale(p.vel, 1 / speed) : vec3(0, -1, 0);
    const u = norm(Math.abs(dir.y) < 0.9 ? cross(dir, vec3(0, 1, 0)) : cross(dir, vec3(1, 0, 0)));
    const v = cross(dir, u);
    fragments.push({
      center: p.pos,
      vel: add(scale(dir, Math.min(speed, 30) * 0.45), vec3(jitter(-1, 1), jitter(0.5, 2), jitter(-1, 1))),
      u, v, age: 0, spin: jitter(0, Math.PI * 2), last: p.pos,
    });
  }

  function updateFragments(dt: number): void {
    // Par petits pas : la vrille reste ronde même à peu d'images par seconde
    const steps = Math.max(1, Math.min(12, Math.ceil(dt / FRAGMENT_STEP)));
    const h = dt / steps;
    for (let i = fragments.length - 1; i >= 0; i--) {
      const f = fragments[i];
      for (let s = 0; s < steps && f.age < FRAGMENT_LIFE; s++) {
        f.age += h;
        f.vel = add(f.vel, vec3(0, -6 * h, 0));
        f.center = add(f.center, scale(f.vel, h));
        // La vrille s'élargit en tournant de plus en plus vite
        f.spin += h * (18 + f.age * 30);
        const radius = 0.15 + f.age * 0.9;
        const at = add(f.center, add(scale(f.u, Math.cos(f.spin) * radius), scale(f.v, Math.sin(f.spin) * radius)));
        ctx.streaks.line(f.last, at, FRAGMENT_STREAK);
        f.last = at;
      }
      ctx.particles.emit(f.last, FRAGMENT_SPARK);
      if (Math.random() < ctx.density) ctx.particles.emit(f.last, FRAGMENT_SMOKE, vec3(jitter(-0.3, 0.3), jitter(-0.3, 0.3), jitter(-0.3, 0.3)));
      if (f.age >= FRAGMENT_LIFE) {
        ctx.particles.emit(f.last, FRAGMENT_POP);
        fragments.splice(i, 1);
      }
    }
  }

  /** Nuage noir d'un éclatement anti-aérien, de la taille de l'explosion. */
  function flakCloud(point: Vec3, radius: number): void {
    const count = Math.max(3, Math.round(7 * ctx.density));
    for (let i = 0; i < count; i++) {
      const at = add(point, vec3(jitter(-0.5, 0.5) * radius, jitter(-0.3, 0.4) * radius, jitter(-0.5, 0.5) * radius));
      const vel = vec3(jitter(-0.6, 0.6), jitter(-0.2, 0.4), jitter(-0.6, 0.6));
      ctx.particles.emit(at, i % 3 === 2 ? FLAK_CLOUD_LIGHT : FLAK_CLOUD, vel, radius / 2.2 * jitter(0.8, 1.2));
    }
  }

  /** Un impact : s'il tombe sur la ligne d'un tir de sniper ou de canon électrique en attente, la ligne s'arrête là. */
  function resolveLine(point: Vec3): void {
    let best = -1;
    let bestAt = -Infinity;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const along = dot(sub(point, l.origin), l.dir);
      if (along < -0.5) continue;
      const off = distance(point, add(l.origin, scale(l.dir, along)));
      if (off < LINE_MATCH && l.at > bestAt) {
        best = i;
        bestAt = l.at;
      }
    }
    if (best < 0) return;
    const l = lines[best];
    lines.splice(best, 1);
    drawLine(l, point);
  }

  /** Le sillage d'un tir en ligne, de la bouche (ou d'un peu devant l'objectif, au viseur) jusqu'à `end`. */
  function drawLine(l: LineShot, end: Vec3): void {
    let start = l.origin;
    if (distance(start, ctx.eye) < OWN_NEAR) start = add(start, scale(l.dir, OWN_NEAR));
    const length = dot(sub(end, start), l.dir);
    if (length <= 0.2) return;
    const far = distance(start, ctx.eye) > FX_RANGE && distance(end, ctx.eye) > FX_RANGE;
    if (far) return;
    if (l.weapon === "sniper") {
      ctx.streaks.line(start, end, SNIPER_VAPOR);
      // De la vapeur en bouffées le long du trait, pour lui donner du volume
      const step = 2.5 / ctx.density;
      for (let d = step * jitter(0.3, 1); d < length; d += step) ctx.particles.emit(add(start, scale(l.dir, d)), SNIPER_PUFF, vec3(jitter(-0.2, 0.2), jitter(0, 0.2), jitter(-0.2, 0.2)));
      return;
    }
    // Canon électrique : un cœur lumineux, un sillage ionisé, et des arcs qui crépitent autour
    ctx.streaks.line(start, end, RAIL_CORE);
    ctx.streaks.line(start, end, RAIL_ION);
    const u = norm(Math.abs(l.dir.y) < 0.9 ? cross(l.dir, vec3(0, 1, 0)) : cross(l.dir, vec3(1, 0, 0)));
    const v = cross(l.dir, u);
    for (let pass = 0; pass < 2; pass++) {
      let prev = start;
      const step = 1.6 + pass * 0.8;
      for (let d = step; d < length + step; d += step) {
        const at = Math.min(d, length);
        const wobble = add(scale(u, jitter(-0.14, 0.14)), scale(v, jitter(-0.14, 0.14)));
        const point = add(add(start, scale(l.dir, at)), at >= length ? vec3(0, 0, 0) : wobble);
        ctx.streaks.line(prev, point, { ...RAIL_ARC, life: RAIL_ARC.life * (1 + pass) });
        prev = point;
      }
    }
  }

  /** Des bouffées régulières du dernier point de la traînée jusqu'à `tail`, rejetées vers l'arrière. */
  function lay(trail: Trail, tail: Vec3, spec: PuffSpec, spacing: number, back: Vec3): void {
    const gap = distance(trail.last, tail);
    const step = spacing / ctx.density;
    const steps = Math.floor(gap / step);
    if (steps <= 0) return;
    const from = trail.last;
    for (let i = 1; i <= steps; i++) {
      const k = (i * step) / gap;
      const at = vec3(from.x + (tail.x - from.x) * k, from.y + (tail.y - from.y) * k, from.z + (tail.z - from.z) * k);
      ctx.particles.emit(at, spec, vec3(back.x + jitter(-0.3, 0.3), back.y + jitter(-0.3, 0.3), back.z + jitter(-0.3, 0.3)));
    }
    const k = (steps * step) / gap;
    trail.last = vec3(from.x + (tail.x - from.x) * k, from.y + (tail.y - from.y) * k, from.z + (tail.z - from.z) * k);
  }

  /** Le jet d'un lance-flammes (effets réalistes) : des boules de feu le long de sa course, de la fumée au bout. */
  function flameJet(trail: Trail, p: Projectile, dt: number): void {
    const life = weaponDef(p.weapon).projectile.life;
    const k = Math.min(1, p.age / life);
    trail.acc += JET_RATE * ctx.density * dt;
    const n = Math.floor(trail.acc);
    trail.acc -= n;
    const spec = JET_FIRES[Math.min(JET_FIRES.length - 1, Math.floor(k * JET_FIRES.length))];
    for (let i = 0; i < n; i++) {
      const at = add(p.pos, vec3(jitter(-0.08, 0.08), jitter(-0.08, 0.08), jitter(-0.08, 0.08)));
      ctx.particles.emit(at, spec, add(scale(p.vel, 0.35), vec3(jitter(-0.6, 0.6), jitter(-0.2, 0.9), jitter(-0.6, 0.6))), (0.6 + p.age * 2.4) * jitter(0.8, 1.2));
    }
    if (k > 0.55 && Math.random() < JET_SMOKE_RATE * ctx.density * dt) {
      ctx.particles.emit(p.pos, JET_SMOKE, add(scale(p.vel, 0.2), vec3(0, jitter(0.4, 1), 0)), 1 + p.age * 1.5);
    }
  }

  /** Étincelles à cadence autour d'un projectile (nanites, obus IEM). */
  function sparkle(trail: Trail, p: Projectile, spec: PuffSpec, rate: number, spread: number, dt: number): void {
    trail.acc += rate * ctx.density * dt;
    const n = Math.floor(trail.acc);
    trail.acc -= n;
    for (let i = 0; i < n; i++) {
      const at = add(p.pos, vec3(jitter(-spread, spread), jitter(-spread, spread), jitter(-spread, spread)));
      ctx.particles.emit(at, spec, add(scale(p.vel, 0.25), vec3(jitter(-1.2, 1.2), jitter(-1.2, 1.2), jitter(-1.2, 1.2))));
    }
  }

  return {
    update(dt) {
      // Tirs en ligne restés sans impact : la balle est partie au loin
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (ctx.now - l.at < LINE_WAIT) continue;
        lines.splice(i, 1);
        drawLine(l, add(l.origin, scale(l.dir, LINE_MISS)));
      }
      while (intercepts.length && ctx.now - intercepts[0].at > SHOT_DOWN_WINDOW) intercepts.shift();
      updateFragments(dt);

      for (const p of ctx.world.projectiles) {
        const look = weaponDef(p.weapon).projectile.look;
        const style = STYLES[p.weapon];
        const jet = look === "flame" && ctx.look === "realistic";
        if (!style && look !== "nanites" && look !== "orb" && !jet) continue;
        let trail = trails.get(p);
        const speed = len(p.vel);
        const dir = speed > 0.1 ? scale(p.vel, 1 / speed) : vec3(0, 0, 1);
        const tail = sub(p.pos, scale(dir, style?.tail ?? 0));
        if (!trail) {
          trail = { last: tail, acc: 0 };
          trails.set(p, trail);
        }
        if (hidden(tail, !!ctx.inside && p.shooter === ctx.inside)) {
          trail.last = tail;
          continue;
        }
        if (look === "nanites") {
          sparkle(trail, p, NANITE_SPARK, NANITE_RATE, 0.22, dt);
          continue;
        }
        if (jet) {
          flameJet(trail, p, dt);
          continue;
        }
        if (look === "orb") {
          sparkle(trail, p, EMP_SPARK, EMP_RATE, 0.12, dt);
          continue;
        }
        if (!style) continue;
        // Une mine ou un leurre posé ne laisse plus rien
        if (speed < 0.3) {
          trail.last = tail;
          continue;
        }
        const back = scale(dir, -(style.exhaust ?? 0));
        if (p.lost && style.flame) {
          // Missile perdu : le propulseur tousse, la fumée sort sombre, par à-coups
          const on = ((ctx.now * SPUTTER_RATE + p.id * 0.37) % 1) < 0.55;
          if (on) {
            ctx.particles.emit(tail, style.flame, scale(p.vel, 0.6), jitter(0.5, 1));
            lay(trail, tail, LOST_SMOKE, style.spacing * 1.3, back);
          } else trail.last = tail;
          continue;
        }
        if (style.flame) ctx.particles.emit(tail, style.flame, scale(p.vel, 0.6), jitter(0.85, 1.15));
        if (style.smoke) lay(trail, tail, style.smoke, style.spacing, back);
      }
    },
    dispose() {
      off();
      trails.clear();
      fragments.length = 0;
      lines.length = 0;
      intercepts.length = 0;
    },
  };
}
