import type { WeaponId } from "../../../shared/catalog/weapons";
import { liveTurrets, turretFrame, turretSpec } from "../../../shared/combat/turrets";
import { add, cross, distance, dot, len, norm, scale, sub, vec3, type Vec3 } from "../../../shared/math/vec";
import { blockWorldPos } from "../../../shared/robot/queries";
import type { Block, Bot, Turret } from "../../../shared/sim/entities";
import { firingTurret } from "../recoil";
import { FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import { surfaceAt } from "./marks";
import type { PuffSpec } from "./particles";

/*
 * Effets au départ du coup, et là où il arrive, d'après les événements `shot`, `impact`, `hit` et
 * `blockRepaired` (tous transmis par le réseau) :
 * - douilles éjectées sur le côté de la tourelle (fusil, sniper, fusil à pompe, canon) ;
 * - fumée qui traîne à la bouche après un coup lourd (canon, sniper, fusil à pompe, canon
 *   électrique, canon IEM, fumigène) ;
 * - souffle au sol sous le robot au coup de canon et de canon électrique ;
 * - panache vers l'arrière du lance-missiles au lancement ;
 * - point incandescent et fumée là où le laser et le plasma touchent ;
 * - rayon réparateur : particules rouges de l'ennemi vers le tireur quand il vole de la vie,
 *   vertes vers l'allié qu'il soigne.
 * La tourelle d'un tir se retrouve par sa bouche (`firingTurret`, render/recoil.ts).
 */

/** Au viseur, pas d'effet de ses propres tirs à moins de cette distance de l'objectif (m). */
const OWN_NEAR = 4;

/** Douille : sa taille (m), sa couleur ; elle est éjectée à droite de la culasse et tombe. */
interface Casing {
  spec: PuffSpec;
  /** Vitesse d'éjection (m/s), sur le côté. */
  kick: number;
}
const brass = (size: number, stretch: number, color = "#c9a045"): PuffSpec =>
  ({ color, kind: "smoke", size, life: 0.85, alpha: 1, fadeOut: 0.25, gravity: 9.8, drag: 0.3, stretch, wind: 0 });
const CASINGS: Partial<Record<WeaponId, Casing>> = {
  rifle: { spec: brass(0.035, 0.012), kick: 2.4 },
  sniper: { spec: brass(0.045, 0.02), kick: 2 },
  shotgun: { spec: brass(0.05, 0.016, "#b8342c"), kick: 2.2 },
  cannon: { spec: brass(0.09, 0.035, "#b8913a"), kick: 1.6 },
};

/** Fumée de bouche : combien de bouffées, et leur allure. */
interface MuzzleSmoke {
  count: number;
  spec: PuffSpec;
  /** Vitesse le long du tir (m/s). */
  push: number;
}
const gunSmoke = (size: number, grow: number, life: number, alpha: number): PuffSpec =>
  ({ color: "#b9bcbf", kind: "smoke", size, grow, life, alpha, fadeIn: 0.04, drag: 1.6, gravity: -0.25 });
const MUZZLE_SMOKE: Partial<Record<WeaponId, MuzzleSmoke>> = {
  cannon: { count: 5, spec: gunSmoke(0.25, 1.5, 2.2, 0.42), push: 3 },
  sniper: { count: 3, spec: gunSmoke(0.12, 0.8, 1.6, 0.3), push: 2.5 },
  shotgun: { count: 4, spec: gunSmoke(0.15, 0.9, 1.4, 0.34), push: 2.5 },
  rail: { count: 3, spec: { color: "#d6f4ff", kind: "vapor", size: 0.15, grow: 0.8, life: 1.0, alpha: 0.34, drag: 1.8, gravity: -0.2 }, push: 2 },
  emp: { count: 3, spec: { color: "#9fe3ff", kind: "glow", size: 0.12, grow: 0.03, life: 0.35, alpha: 0.9, drag: 4, stretch: 0.03 }, push: 4 },
  smoke: { count: 2, spec: gunSmoke(0.12, 0.7, 1.4, 0.3), push: 2 },
};

/** Souffle au sol : les armes lourdes soulèvent la poussière autour du robot. */
const DUST_WEAPONS: Partial<Record<WeaponId, number>> = { cannon: 1, rail: 0.8 };
const DUST: PuffSpec = { color: "#a39277", kind: "smoke", size: 0.3, grow: 1.5, life: 1.5, alpha: 0.45, fadeIn: 0.05, drag: 2.5, gravity: -0.1 };
/** Au-delà de cette hauteur au-dessus du sol (m), le souffle ne l'atteint pas. */
const DUST_REACH = 2.5;

/** Panache arrière du lance-missiles au lancement : son ampleur par arme. */
const BACKBLAST: Partial<Record<WeaponId, number>> = { missile: 1, lockon: 0.9, flak: 0.9, warhead: 1.6, rockets: 0.5 };
const BLAST_SMOKE: PuffSpec = { color: "#d9dbdd", kind: "smoke", size: 0.25, grow: 1.4, life: 1.3, alpha: 0.5, fadeIn: 0.03, drag: 2.8, gravity: -0.15 };
const BLAST_FLASH: PuffSpec = { color: "#ffc07a", kind: "glow", size: 0.6, grow: 0.25, life: 0.08, alpha: 0.9 };

/** Points incandescents du laser et du plasma. */
const HOT: Partial<Record<WeaponId, { glow: PuffSpec; core: PuffSpec; smoke: PuffSpec; smokeChance: number }>> = {
  laser: {
    glow: { color: "#ff6a3a", kind: "glow", size: 0.28, grow: 0.08, life: 0.14, alpha: 0.95 },
    core: { color: "#fff0d8", kind: "glow", size: 0.12, life: 0.06, alpha: 1 },
    smoke: { color: "#5a5e63", kind: "smoke", size: 0.08, grow: 0.5, life: 0.9, alpha: 0.35, gravity: -0.9, drag: 1 },
    smokeChance: 0.5,
  },
  plasma: {
    glow: { color: "#d890ff", kind: "glow", size: 0.42, grow: 0.1, life: 0.2, alpha: 0.9 },
    core: { color: "#f6e6ff", kind: "glow", size: 0.16, life: 0.07, alpha: 1 },
    smoke: { color: "#6a5e70", kind: "smoke", size: 0.1, grow: 0.55, life: 0.9, alpha: 0.32, gravity: -0.9, drag: 1 },
    smokeChance: 0.35,
  },
};

/** Rayon réparateur : ce qui coule de l'ennemi vers le tireur (vol de vie), et du tireur vers l'allié (soin). */
const DRAIN: PuffSpec = { color: "#ff3b4e", kind: "glow", size: 0.16, grow: 0.08, life: 0.45, alpha: 0.95, stretch: 0.025, wind: 0 };
const HEAL: PuffSpec = { color: "#7fffb0", kind: "glow", size: 0.14, grow: 0.07, life: 0.4, alpha: 0.9, stretch: 0.025, wind: 0 };
/** Vitesse de ces particules (m/s), et temps de vol au plus (s) : étirées le long de leur course, elles font des filets. */
const FLOW_SPEED = 16;
const FLOW_MAX = 0.9;
/** Au plus un flux tous les `FLOW_GAP` s par robot (vol de vie : le tireur ; soin : l'allié). */
const FLOW_GAP = 0.07;

/** Un tir en attente de son impact (laser, plasma) ou de ses effets (rayon réparateur), et le robot qui l'a tiré. */
interface Pending {
  weapon: WeaponId;
  origin: Vec3;
  dir: Vec3;
  at: number;
  shooter: Bot | null;
}
/** Délai (s) au-delà duquel un tir n'attend plus son impact. */
const PENDING_LIFE = 0.5;
/** Écart d'un impact à la ligne du tir (m) : au-delà, ce n'est pas le sien. */
const LINE_MATCH = 0.8;
/** Un bloc soigné à moins de cette distance (m) de la ligne d'un rayon réparateur : c'est lui qui le soigne. */
const HEAL_MATCH = 2.5;

export function muzzleFx(ctx: FxContext): FxSystem {
  const pending: Pending[] = [];
  const flowAt = new Map<Bot, number>();

  const own = (point: Vec3): boolean => !!ctx.inside && distance(point, ctx.eye) < OWN_NEAR;
  const far = (point: Vec3): boolean => distance(point, ctx.eye) > FX_RANGE;

  const off = ctx.world.on((e) => {
    switch (e.type) {
      case "shot":
        onShot(e.weapon, e.origin, norm(e.dir));
        break;
      case "impact":
        onImpact(e.point);
        break;
      case "hit":
        if (e.cause === "repair" && e.attacker) drainFlow(e.victim, e.attacker);
        break;
      case "blockRepaired":
        healFlow(e.block);
        break;
    }
  });

  function onShot(weapon: WeaponId, origin: Vec3, dir: Vec3): void {
    if (far(origin)) return;
    if (HOT[weapon] || weapon === "repair") {
      pending.push({ weapon, origin, dir, at: ctx.now, shooter: weapon === "repair" ? firingTurret(ctx.world, weapon, origin)?.block.bot ?? null : null });
    }
    const needsTurret = CASINGS[weapon] || DUST_WEAPONS[weapon] || BACKBLAST[weapon];
    const turret = needsTurret ? firingTurret(ctx.world, weapon, origin) : null;
    if (own(origin)) return;
    const smoke = MUZZLE_SMOKE[weapon];
    if (smoke) {
      const count = Math.max(1, Math.round(smoke.count * ctx.density));
      for (let i = 0; i < count; i++) {
        const at = add(origin, scale(dir, jitter(0, 0.4)));
        ctx.particles.emit(at, smoke.spec, add(scale(dir, smoke.push * jitter(0.4, 1.2)), vec3(jitter(-0.4, 0.4), jitter(0, 0.4), jitter(-0.4, 0.4))));
      }
    }
    if (!turret) return;
    const casing = CASINGS[weapon];
    if (casing) eject(turret, casing);
    const dust = DUST_WEAPONS[weapon];
    if (dust) groundBlast(turret.block.bot, dust);
    const blast = BACKBLAST[weapon];
    if (blast) backblast(turret, origin, dir, blast);
  }

  /** Une douille éjectée à droite de la culasse, qui tombe en gardant la vitesse du robot. */
  function eject(t: Turret, casing: Casing): void {
    const { dir, muzzle } = turretFrame(t);
    const breech = sub(muzzle, scale(dir, turretSpec(t).barrel * 0.8));
    const flat = Math.abs(dir.y) < 0.95 ? cross(dir, vec3(0, 1, 0)) : cross(dir, vec3(1, 0, 0));
    const right = norm(flat);
    const carried = t.block.part.rb.linvel();
    const vel = add(carried, add(scale(right, casing.kick * jitter(0.8, 1.2)), vec3(jitter(-0.3, 0.3), casing.kick * jitter(0.5, 0.9), jitter(-0.3, 0.3))));
    ctx.particles.emit(add(breech, vec3(0, 0.04, 0)), casing.spec, vel);
  }

  /** Coup lourd : un anneau de poussière qui s'écarte du robot sur le sol. */
  function groundBlast(bot: Bot, strength: number): void {
    if (!bot.cockpit.alive) return;
    const center = bot.cockpit.part.rb.translation();
    const ground = surfaceAt(ctx.world.arena, center.x, center.z, center.y);
    if (!ground || center.y - ground.point.y > DUST_REACH) return;
    const count = Math.max(4, Math.round(12 * ctx.density));
    const phase = jitter(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const a = phase + (i / count) * Math.PI * 2;
      const out = vec3(Math.cos(a), 0, Math.sin(a));
      const at = add(add(ground.point, scale(out, 0.9)), scale(ground.normal, 0.15));
      ctx.particles.emit(at, DUST, add(scale(out, jitter(3, 5) * strength), vec3(0, jitter(0.2, 0.6), 0)), strength);
    }
  }

  /** Lancement d'un missile : un panache de fumée rejeté vers l'arrière du tube, et un éclair. */
  function backblast(t: Turret, origin: Vec3, dir: Vec3, size: number): void {
    const rear = sub(origin, scale(dir, turretSpec(t).barrel * 2 + 0.25));
    ctx.particles.emit(rear, BLAST_FLASH, undefined, size);
    const count = Math.max(1, Math.round(5 * size * ctx.density));
    for (let i = 0; i < count; i++) {
      const vel = add(scale(dir, -jitter(4, 9)), vec3(jitter(-1, 1), jitter(-0.5, 1), jitter(-1, 1)));
      ctx.particles.emit(rear, BLAST_SMOKE, vel, size * jitter(0.8, 1.1));
    }
  }

  /** Un impact : s'il tombe sur la ligne d'un tir de laser ou de plasma en attente, il y fait un point incandescent. */
  function onImpact(point: Vec3): void {
    let best = -1;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (!HOT[p.weapon]) continue;
      const along = dot(sub(point, p.origin), p.dir);
      if (along < -0.5) continue;
      if (distance(point, add(p.origin, scale(p.dir, along))) < LINE_MATCH && (best < 0 || p.at > pending[best].at)) best = i;
    }
    if (best < 0) return;
    const shot = pending[best];
    pending.splice(best, 1);
    if (far(point) || own(point)) return;
    const hot = HOT[shot.weapon]!;
    const at = sub(point, scale(shot.dir, 0.05));
    ctx.particles.emit(at, hot.glow);
    ctx.particles.emit(at, hot.core);
    if (Math.random() < hot.smokeChance * ctx.density) ctx.particles.emit(at, hot.smoke, vec3(jitter(-0.2, 0.2), jitter(0.1, 0.4), jitter(-0.2, 0.2)));
  }

  /** Des particules qui volent de `from` vers `to`, en arrivant à la fin de leur vie. */
  function flow(from: Vec3, to: Vec3, spec: PuffSpec, count: number): void {
    const gap = sub(to, from);
    const length = len(gap);
    if (length < 0.3) return;
    const time = Math.min(FLOW_MAX, length / FLOW_SPEED);
    const n = Math.max(1, Math.round(count * ctx.density));
    for (let i = 0; i < n; i++) {
      const start = add(from, vec3(jitter(-0.12, 0.12), jitter(-0.12, 0.12), jitter(-0.12, 0.12)));
      const t = time * jitter(0.85, 1.1);
      ctx.particles.emit(start, { ...spec, life: t }, scale(sub(to, start), 1 / t));
    }
  }

  /** Vol de vie : de la vie rouge coule du bloc touché de l'ennemi vers le rayon du tireur. */
  function drainFlow(victim: Bot, attacker: Bot): void {
    if ((flowAt.get(attacker) ?? 0) > ctx.now) return;
    const beam = latestRepair(attacker);
    if (!beam || far(beam.origin)) return;
    const point = nearestToLine(victim, beam.origin, beam.dir);
    if (!point) return;
    flowAt.set(attacker, ctx.now + FLOW_GAP);
    flow(point, beam.origin, DRAIN, 4);
  }

  /** Soin : des particules vertes vont du rayon du tireur au bloc qu'il remet en état chez un allié. */
  function healFlow(block: Block): void {
    const bot = block.bot;
    if ((flowAt.get(bot) ?? 0) > ctx.now) return;
    const at = blockWorldPos(block);
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.weapon !== "repair" || !p.shooter || p.shooter === bot || p.shooter.team !== bot.team) continue;
      const along = dot(sub(at, p.origin), p.dir);
      if (along < 0 || distance(at, add(p.origin, scale(p.dir, along))) > HEAL_MATCH) continue;
      if (far(at)) return;
      flowAt.set(bot, ctx.now + FLOW_GAP);
      flow(p.origin, at, HEAL, 3);
      return;
    }
  }

  /** Le dernier tir de rayon réparateur de ce robot encore en attente. */
  function latestRepair(bot: Bot): Pending | null {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].weapon === "repair" && pending[i].shooter === bot) return pending[i];
    // (en réseau, la tourelle d'un tir peut ne pas avoir été retrouvée : on prend son lance-rayon)
    const t = liveTurrets(bot).find((x) => x.weapon === "repair");
    if (!t) return null;
    const { muzzle, dir } = turretFrame(t);
    return { weapon: "repair", origin: muzzle, dir, at: ctx.now, shooter: bot };
  }

  /** Le bloc de `bot` le plus proche de la ligne (origine, direction) : là où le rayon l'a touché. */
  function nearestToLine(bot: Bot, origin: Vec3, dir: Vec3): Vec3 | null {
    let best: Vec3 | null = null;
    let bestScore = Infinity;
    for (const b of bot.blocks.values()) {
      const p = blockWorldPos(b);
      const along = dot(sub(p, origin), dir);
      if (along < 0) continue;
      // L'écart à la ligne compte, puis la distance au tireur (le rayon touche la face tournée vers lui)
      const score = distance(p, add(origin, scale(dir, along))) + along * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  return {
    update() {
      while (pending.length && ctx.now - pending[0].at > PENDING_LIFE) pending.shift();
    },
    dispose() {
      off();
      pending.length = 0;
      flowAt.clear();
    },
  };
}
