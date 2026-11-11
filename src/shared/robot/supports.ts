import RAPIER from "@dimforge/rapier3d-compat";
import { blockDef, type SupportSpec } from "../catalog/blocks";
import { GRAVITY, STEP } from "../config";
import { clamp } from "../math/scalar";
import { add, cross, dot, len, norm, qrot, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { Bot, Support } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { ownerBot } from "./colliders";
import { supply } from "./energy";
import { blockWorldPos } from "./queries";

/*
 * Appuis sans roue : patins anti-gravité et pattes. Chaque appui mesure la distance au sol sous
 * lui (un rayon le long du bas de son bloc) et pousse comme un ressort-amortisseur réglé pour sa
 * charge nominale : un robot trop lourd s'enfonce. Il pousse aussi à l'horizontale pour amener
 * son point du robot à la vitesse voulue (avancer, tourner), dans la limite de son adhérence :
 * une patte agrippe le sol, un patin glisse sur son coussin. Un robot sur pattes enjambe ce qui
 * est plus bas que ses pattes ; un robot sur patins passe au-dessus de tout ce qui est plus bas
 * que son coussin, mais il dérape.
 */

/** Réactivité de la traction : l'écart de vitesse est rattrapé en 1 / TRACTION_GAIN s, si l'adhérence le permet. */
const TRACTION_GAIN = 4;
/** Force d'appui maximale, en multiple du poids nominal. */
const MAX_LOAD = 3;
/** Longueur d'une foulée (m) : la phase de la marche fait un tour quand le robot avance d'autant. */
const STRIDE = 1.2;

const specOf = (s: Support): SupportSpec => blockDef(s.block.type).support!;

/**
 * Distance le long de `down` jusqu'à la surface de l'eau, si elle est à portée (`reach`) et que
 * l'eau de l'arène est réelle (`ArenaLayout.deepWater`) ; Infinity sinon (ailleurs, l'eau n'est
 * que dessinée : le patin s'appuie sur le fond).
 */
function waterBelow(sim: Simulation, p: Vec3, down: Vec3, reach: number): number {
  const { water, deepWater } = sim.arena;
  if (water === undefined || deepWater === undefined || down.y > -0.5 || p.y < water) return Infinity;
  const t = (p.y - water) / -down.y;
  return t <= reach ? t : Infinity;
}

/** Appuis encore reliés au cockpit : les seuls commandés. */
export function liveSupports(bot: Bot): Support[] {
  const ck = bot.cockpit;
  if (!ck.alive) return [];
  return bot.supports.filter((s) => s.block.alive && s.block.part === ck.part);
}

/** Appuis qui touchent le sol (le robot tient debout dessus). */
export const groundedSupports = (bot: Bot): Support[] => liveSupports(bot).filter((s) => Number.isFinite(s.contact));

/**
 * Frein des appuis : la traction rattrape l'écart de vitesse BRAKE_GAIN fois plus vite, et un
 * patin, qui glisse d'ordinaire, s'accroche BRAKE_HOVER_TRACTION fois plus (il incline son champ).
 */
const BRAKE_GAIN = 3;
const BRAKE_HOVER_TRACTION = 2;

/** Consignes des appuis, en plus des gaz et de la direction (voir `DriveOptions`, robot/propulsion.ts). */
export interface SupportOptions {
  /** Boost : la traction ne retient jamais le robot dans son sens de marche (au-delà de la consigne, il file). */
  overrun?: boolean;
  /** Vitesse voulue multipliée d'autant (sprint). */
  speedFactor?: number;
  /** Frein, de 0 à 1 : la consigne retombe à l'arrêt, et les appuis s'accrochent davantage. */
  brake?: number;
}

/**
 * Un pas des appuis : sustentation, et traction vers la consigne `throttle` (avance, de -1 à 1)
 * et `steer` (lacet, > 0 : à gauche). `powered` faux (électronique coupée) : les patins
 * s'éteignent, les pattes restent debout et freinent.
 */
export function driveSupports(sim: Simulation, bot: Bot, throttle: number, steer: number, powered: boolean, options: SupportOptions = {}): void {
  const supports = liveSupports(bot);
  if (!supports.length) return;
  const rb = bot.cockpit.part.rb;
  const q = rb.rotation();
  const com = rb.worldCom();
  const v = rb.linvel();
  const w = rb.angvel();
  const up = qrot(q, vec3(0, 1, 0));
  const forward = norm(vec3(qrot(q, vec3(0, 0, 1)).x, 0, qrot(q, vec3(0, 0, 1)).z));
  const share = rb.mass() / supports.length;
  const brake = clamp(options.brake ?? 0, 0, 1);
  const go = 1 - brake;
  const speed = powered ? throttle * bot.profile.speed * (options.speedFactor ?? 1) * go : 0;
  const yaw = powered ? ((steer * bot.profile.turn) / Math.max(1, bot.radius)) * go : 0;
  const gain = TRACTION_GAIN * (1 + (BRAKE_GAIN - 1) * brake);
  // Les patins ne reçoivent que ce que l'alimentation peut fournir
  const hoverDemand = supports.reduce((s, x) => s + specOf(x).power, 0);
  const k = supply(bot, hoverDemand);
  const flat = Math.hypot(v.x, v.z);

  for (const s of supports) {
    const spec = specOf(s);
    s.phase += (flat * STEP * 2 * Math.PI) / STRIDE;
    const p = blockWorldPos(s.block);
    const down = scale(qrot(q, s.block.up), -1);
    const hit = sim.world.castRay(
      new RAPIER.Ray(p, down), spec.reach, true, undefined, undefined, undefined, undefined,
      (c) => {
        const owner = sim.colliders.get(c.handle);
        return owner?.kind !== "debris" && ownerBot(owner) !== bot;
      },
    );
    const hover = spec.kind === "hover";
    // Paralysé localement (lance électrique, combat/emp.ts) : ce patin retombe, cette patte se fige
    const on = powered && s.block.stunnedUntil <= sim.time;
    // Un patin glisse sur l'eau d'une arène où elle est réelle (la mer d'une île : `deepWater`)
    s.contact = Math.min(hit ? hit.timeOfImpact : Infinity, hover ? waterBelow(sim, p, down, spec.reach) : Infinity);
    if (!Number.isFinite(s.contact) || (hover && !on)) {
      s.force = 0;
      continue;
    }

    // Sustentation : ressort-amortisseur réglé pour la charge nominale
    const omega = 2 * Math.PI * spec.frequency;
    const stiffness = spec.ratedLoad * omega * omega;
    const damping = 2 * spec.dampingRatio * Math.sqrt(stiffness * spec.ratedLoad);
    const vp = add(v, cross(w, sub(p, com)));
    const approach = dot(vp, down);
    const weight = spec.ratedLoad * GRAVITY;
    let force = clamp(weight + stiffness * (spec.height - s.contact) + damping * approach, 0, MAX_LOAD * weight);
    if (hover) {
      force *= k;
      bot.drawn += (spec.power * force) / weight;
    }
    s.force = force;
    rb.applyImpulseAtPoint(scale(down, -force * STEP), p, true);

    // Traction : amène la vitesse horizontale du point vers la consigne, sans dépasser l'adhérence
    const r = sub(p, com);
    const want = on ? add(scale(forward, speed), cross(scale(up, yaw), r)) : vec3(0, 0, 0);
    const slip = sub(want, vp);
    let push = scale(vec3(slip.x, 0, slip.z), share * gain);
    // Boost : vers l'avant, l'appui ne pousse que dans le sens des gaz (sans gaz, le robot file librement)
    if (options.overrun) {
      const along = dot(push, forward);
      const allowed = throttle > 0 ? Math.max(0, along) : throttle < 0 ? Math.min(0, along) : 0;
      push = add(push, scale(forward, allowed - along));
    }
    const limit = spec.traction * force * (hover ? 1 + (BRAKE_HOVER_TRACTION - 1) * brake : 1);
    if (len(push) > limit) push = scale(push, limit / len(push));
    rb.applyImpulseAtPoint(scale(push, STEP), p, true);
  }
}
