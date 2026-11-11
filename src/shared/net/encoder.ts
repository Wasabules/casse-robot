import { localStuns } from "../combat/emp";
import type { Vec3 } from "../math/vec";
import type { Barrier, Block, Bot, GroundFire, Prop, Wheel } from "../sim/entities";
import type { SimEvent } from "../sim/events";
import type { Simulation } from "../sim/simulation";
import type { BotDesc, NetEvent } from "./protocol";

/*
 * Côté serveur : traduit les événements de la simulation en événements réseau (entités nommées
 * par leur identifiant), à envoyer avec la prochaine image. Un robot qui apparaît est décrit en
 * entier au moment de l'envoi, dans son état d'alors : les événements qui le concernent entre-temps
 * (ses morceaux, ses blocs, ses roues, un premier coup reçu) sont inutiles et ne sont pas transmis.
 */

export class NetEncoder {
  /** Événements de l'image en cours ; un robot tient la place de sa description. */
  private events: (NetEvent | Bot)[] = [];
  /** Robots apparus depuis la dernière image. */
  private readonly fresh = new Set<Bot>();
  private readonly unsubscribe: () => void;

  constructor(sim: Simulation) {
    this.unsubscribe = sim.on((e) => this.record(e));
  }

  /** Événement qui ne vient pas de la simulation (début ou fin d'une partie). */
  push(event: NetEvent): void {
    this.events.push(event);
  }

  /** Événements depuis la dernière image, les robots apparus décrits dans leur état actuel. */
  take(): NetEvent[] {
    const out = this.events.map((e): NetEvent => ("profile" in e ? { t: "bot", bot: describeBot(e) } : e));
    this.events = [];
    this.fresh.clear();
    return out;
  }

  dispose(): void {
    this.unsubscribe();
  }

  private record(e: SimEvent): void {
    const about = subjectOf(e);
    if (about && this.fresh.has(about) && e.type !== "botRemoved") return;
    const net = toNet(e, this.fresh);
    if (net === "bot") {
      if (e.type === "botAdded") {
        this.fresh.add(e.bot);
        this.events.push(e.bot);
      }
    } else if (net === "forget") {
      // Robot apparu et retiré dans la même image : on n'en parle pas
      if (e.type === "botRemoved") {
        this.fresh.delete(e.bot);
        this.events = this.events.filter((x) => x !== e.bot);
      }
    } else if (net) {
      this.events.push(net);
    }
  }
}

/** Robot concerné par un événement de structure, s'il y en a un. */
function subjectOf(e: SimEvent): Bot | null {
  switch (e.type) {
    case "partAdded":
    case "partRemoved":
      return e.part.bot;
    case "blockAttached":
    case "blockDamaged":
    case "blockRepaired":
    case "blockDestroyed":
    case "blockRebuilt":
    case "fireStarted":
    case "fireEnded":
    case "shieldHit":
      return e.block.bot;
    case "wheelAdded":
    case "wheelRemoved":
      return e.wheel.bot;
    case "stunned":
    case "organsStunned":
    case "botKilled":
    case "botRemoved":
      return e.bot;
    case "hit":
      return e.victim;
    default:
      return null;
  }
}

function toNet(e: SimEvent, fresh: ReadonlySet<Bot>): NetEvent | "bot" | "forget" | null {
  switch (e.type) {
    case "botAdded": return "bot";
    case "botRemoved": return fresh.has(e.bot) ? "forget" : { t: "botGone", id: e.bot.id };
    case "partAdded": return { t: "part", id: e.part.id, bot: e.part.bot.id };
    case "partRemoved": return { t: "partGone", id: e.part.id };
    case "blockAttached": return { t: "attach", block: e.block.id, part: e.block.part.id };
    case "blockDamaged": return { t: "hp", block: e.block.id, hp: e.block.hp, repaired: false };
    case "blockRepaired": return { t: "hp", block: e.block.id, hp: e.block.hp, repaired: true };
    case "blockDestroyed": return { t: "destroyed", block: e.block.id };
    case "blockRebuilt": return { t: "rebuilt", block: e.block.id, part: e.block.part.id, key: e.block.key, hp: e.block.hp };
    case "barrierAdded": return barrierNet(e.barrier);
    case "barrierHit": return { t: "barrierHit", id: e.barrier.id, hp: e.barrier.hp, point: plain(e.point) };
    case "barrierRemoved": return { t: "barrierGone", id: e.barrier.id, broken: e.broken };
    case "wheelAdded": return null; // les roues n'apparaissent qu'avec leur robot
    case "wheelRemoved": return { t: "wheelGone", id: e.wheel.id };
    case "debrisAdded": return { t: "debris", id: e.debris.id, look: e.debris.look, born: e.debris.born, life: e.debris.life };
    case "debrisRemoved": return { t: "debrisGone", id: e.debris.id };
    case "propAdded": return { t: "prop", id: e.prop.id, type: e.prop.type, spot: e.prop.spot, fixed: e.prop.fixed };
    case "propRemoved": return { t: "propGone", id: e.prop.id };
    case "propReleased": return { t: "propFree", id: e.prop.id };
    case "propFire": return propFireNet(e.prop);
    case "groundFireAdded": return groundFireNet(e.fire);
    case "groundFireRemoved": return { t: "groundFireGone", id: e.fire.id };
    case "projectileAdded": return { t: "projectile", id: e.projectile.id, weapon: e.projectile.weapon, shooter: e.projectile.shooter?.id ?? null };
    case "projectileRemoved": return { t: "projectileGone", id: e.projectile.id };
    case "mine": return { t: "mine", id: e.projectile.id, action: e.action };
    case "shot": return { t: "shot", weapon: e.weapon, origin: plain(e.origin), dir: plain(e.dir) };
    case "impact": return { t: "impact", point: plain(e.point), surface: e.surface };
    case "explosion": return { t: "explosion", point: plain(e.point), radius: e.radius, look: e.look };
    case "collision": return { t: "collision", point: plain(e.point), strength: e.strength };
    case "meleeHit":
      return { t: "melee", block: e.block.id, point: plain(e.point), dir: plain(e.dir), energy: e.energy, surface: e.surface, glance: e.glance };
    case "linkBroken": return { t: "link", point: plain(e.point) };
    case "fireStarted": return { t: "fire", block: e.block.id };
    case "fireEnded": return { t: "fireOut", block: e.block.id };
    case "empBurst": return { t: "emp", point: plain(e.point), radius: e.radius };
    case "stunned": return { t: "stunned", bot: e.bot.id, until: e.until };
    case "organsStunned": return shockNet(e.bot, e.blocks, e.wheels, e.until, e.point);
    case "smokeAdded": return { t: "smoke", id: e.cloud.id, pos: plain(e.cloud.pos), radius: e.cloud.radius, born: e.cloud.born, life: e.cloud.life };
    case "smokeRemoved": return { t: "smokeGone", id: e.cloud.id };
    case "shieldHit": return { t: "shield", block: e.block.id };
    case "hit": return { t: "hit", victim: e.victim.id, attacker: e.attacker?.id ?? null, cause: e.cause, destroyed: e.destroyed };
    case "botKilled": return { t: "killed", bot: e.bot.id, killer: e.killer?.id ?? null, cause: e.cause };
    case "arenaChanged": return { t: "arena", id: e.arena };
    case "zoneChanged": return { t: "zone", zone: e.zone, owner: e.owner, by: e.by };
    case "matchOver": return { t: "over", winner: e.winner };
    case "damage": return { t: "damage", bots: e.bots.filter((b) => !fresh.has(b)).map((b) => b.id) };
  }
}

/** Vecteur réduit à ses trois composantes (ceux de Rapier sont des objets de classe). */
const plain = (v: { x: number; y: number; z: number }): { x: number; y: number; z: number } => ({ x: v.x, y: v.y, z: v.z });

/** Un robot tel qu'il est : ses morceaux, ses blocs vivants, ses roues, ses liaisons rompues. */
export function describeBot(bot: Bot): BotDesc {
  return {
    id: bot.id,
    profile: bot.profile,
    team: bot.team,
    controller: bot.controller,
    parts: [...bot.parts].map((p) => p.id),
    blocks: [...bot.blocks.values()].map((b) => [b.key, b.id, b.part.id, b.hp, b.burn]),
    cockpit: bot.cockpit.id,
    wheels: bot.wheels.map((w, i) => [i, w.id, w.hp]),
    cuts: [...bot.cuts],
  };
}

/** Tout le monde, pour un joueur qui arrive : la partie, les robots, les accessoires, ce qui vole. */
export function describeWorld(sim: Simulation): NetEvent[] {
  return [
    { t: "arena", id: sim.arena.id },
    { t: "match", rules: sim.match?.rules ?? null },
    ...sim.bots.map((bot): NetEvent => ({ t: "bot", bot: describeBot(bot) })),
    ...sim.props.map((p): NetEvent => ({ t: "prop", id: p.id, type: p.type, spot: p.spot, fixed: p.fixed })),
    // Le bois qui brûle ou a brûlé, et les flaques de feu en cours
    ...sim.props.filter((p) => p.burn > 0 || p.charred > 0).map(propFireNet),
    ...sim.groundFires.map(groundFireNet),
    ...sim.debris.map((d): NetEvent => ({ t: "debris", id: d.id, look: d.look, born: d.born, life: d.life })),
    ...sim.projectiles.map((p): NetEvent => ({ t: "projectile", id: p.id, weapon: p.weapon, shooter: p.shooter?.id ?? null })),
    ...sim.smokes.map((s): NetEvent => ({ t: "smoke", id: s.id, pos: plain(s.pos), radius: s.radius, born: s.born, life: s.life })),
    ...sim.barriers.map(barrierNet),
    // Les paralysies locales en cours (lance électrique)
    ...sim.bots.flatMap((bot): NetEvent[] => {
      const { blocks, wheels, until } = localStuns(sim, bot);
      return blocks.length || wheels.length ? [shockNet(bot, blocks, wheels, until, null)] : [];
    }),
  ];
}

/** Une paralysie locale : les blocs et les roues coupés, jusqu'à quand, et où la décharge a frappé. */
const shockNet = (bot: Bot, blocks: readonly Block[], wheels: readonly Wheel[], until: number, point: Vec3 | null): NetEvent => ({
  t: "shock", bot: bot.id, blocks: blocks.map((b) => b.id), wheels: wheels.map((w) => w.id), until, point: point && plain(point),
});

/** Le feu d'un accessoire, tel qu'il est. */
const propFireNet = (p: Prop): NetEvent => ({ t: "propFire", id: p.id, burning: p.burn > 0, charred: p.charred });

/** Une flaque de feu, telle qu'elle est. */
const groundFireNet = (f: GroundFire): NetEvent => ({ t: "groundFire", id: f.id, pos: plain(f.pos), radius: f.radius, until: f.until });

/** Un mur d'énergie, tel qu'il est. */
const barrierNet = (b: Barrier): NetEvent => ({
  t: "barrier", id: b.id, team: b.team, center: plain(b.center), normal: plain(b.normal), width: b.width, height: b.height, hp: b.hp, maxHp: b.maxHp, until: b.until,
});
