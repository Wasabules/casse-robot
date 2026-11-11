import { groundLevel } from "../../../shared/arena/layout";
import { rayArena } from "../../../shared/arena/ray";
import { terrainHeight } from "../../../shared/arena/terrain";
import { blockDef } from "../../../shared/catalog/blocks";
import { wheelDef } from "../../../shared/catalog/wheels";
import { clamp } from "../../../shared/math/scalar";
import { distance, len, norm, qrot, vec3, type Vec3 } from "../../../shared/math/vec";
import { blockWorldPos } from "../../../shared/robot/queries";
import type { Bot, Support, Wheel } from "../../../shared/sim/entities";
import { FOOT_OUT, HALF_STEP } from "../locomotionView";
import { FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import { surfaceAt, type MarkSpec } from "./marks";
import type { PuffSpec } from "./particles";
import { countOf, groundRgb, LiveSet, toHex } from "./tracking";

/*
 * Le sol : traces des pneus et des chenilles, poussière soulevée, gerbes d'eau, pas des pattes,
 * atterrissages lourds, étincelles des chocs et des robots qui raclent le sol. Une roue touche le
 * sol quand un rayon lancé de son centre vers le bas rencontre le sol ou le décor sous elle : cela
 * se lit sur sa pose, et marche donc aussi en réseau (où l'appui des roues ne passe pas).
 */

/** Au-delà de cette distance de la caméra (m), pas de traces ni de poussière de roue. */
const MARK_RANGE = 90;
/**
 * Longueur des bandes d'une trace (m), au plus ; dans un virage, une nouvelle bande part dès que la
 * trace tourne de plus de `MARK_TURN` (rad) et qu'elle a au moins `MARK_MIN` m : les bandes suivent la
 * courbe sans laisser de jour à l'extérieur.
 */
const MARK_SPACING = 0.7;
const MARK_TURN = 0.14;
const MARK_MIN = 0.15;
/** Une roue qui a sauté plus loin que cela d'une image à l'autre (réapparition) recommence sa trace. */
const MARK_JUMP = 3;
/** Durée de vie d'une trace (s). */
const MARK_LIFE = 14;
/** Garde entre le bas d'une roue et le sol pour qu'elle le touche (m). */
const TOUCH = 0.18;
/** Poussière : vitesse au-delà de laquelle une roue en soulève sur la terre, et sur le béton (m/s). */
const DUST_SOIL = 3;
const DUST_HARD = 6;
/** Dérapage (vitesse de côté, m/s) et accélération (m/s²) au-delà desquels une roue soulève de la poussière. */
const SLIP = 1.2;
const JOLT = 3;
/** Atterrissage lourd : vitesse de chute (m/s) à partir de laquelle il soulève de la poussière. */
const HARD_LANDING = 4.5;
/**
 * Un robot a atterri si sa chute s'arrête moins de ce temps (s) après sa plus grande vitesse de
 * descente (large : à peu d'images par seconde, deux images sont loin l'une de l'autre).
 */
const LANDING_WINDOW = 0.5;
/** Un robot renversé qui glisse plus vite que cela (m/s) racle le sol : étincelles. */
const SCRAPE_SPEED = 2.5;
/** Largeur des bandes de terrain d'une case de voie (m) : les roues d'une même voie laissent une seule trace. */
const LANE = 0.3;
/**
 * Vitesse le long du robot (m/s) au-delà de laquelle on sait dans quel sens il roule : la roue qui
 * mène (celle de devant en marche avant, de derrière en marche arrière) trace ; en dessous, elle
 * reste la même (pas de va-et-vient d'une roue à l'autre à l'arrêt).
 */
const LEAD_SPEED = 0.3;
/** Le sol sous une roue n'est recherché de nouveau (un lancer de rayon) que si elle a bougé de plus de cela (m). */
const FLOOR_REUSE = 0.3;

const DUST: Omit<PuffSpec, "color"> = { kind: "smoke", size: 0.3, grow: 1.5, life: 1.3, alpha: 0.3, fadeIn: 0.1, drag: 2, gravity: -0.25 };
const BIG_DUST: Omit<PuffSpec, "color"> = { kind: "smoke", size: 0.5, grow: 2.4, life: 1.9, alpha: 0.42, fadeIn: 0.05, drag: 2.2, gravity: -0.15 };
const STEP_DUST: Omit<PuffSpec, "color"> = { kind: "smoke", size: 0.18, grow: 0.8, life: 0.9, alpha: 0.38, fadeIn: 0.05, drag: 3, gravity: -0.2 };
const DROPLET: PuffSpec = { color: "#dcebf2", kind: "vapor", size: 0.07, life: 0.9, alpha: 0.85, gravity: 9.8, drag: 0.3, stretch: 0.04, wind: 0 };
const FOAM: PuffSpec = { color: "#f1f6f8", kind: "vapor", size: 0.25, grow: 1.2, life: 0.9, alpha: 0.5, drag: 3, wind: 0.3 };
const SPRAY: PuffSpec = { color: "#e8f1f5", kind: "vapor", size: 0.4, grow: 1.8, life: 1.3, alpha: 0.45, drag: 1.5, gravity: 1.5, wind: 0.5 };
const SPARK: PuffSpec = { color: "#ffd27a", kind: "glow", size: 0.035, life: 0.45, gravity: 9.8, drag: 0.5, stretch: 0.035 };
const HOT_SPARK: PuffSpec = { color: "#fff1c4", kind: "glow", size: 0.03, life: 0.25, gravity: 9.8, drag: 0.5, stretch: 0.03 };
const FLASH: PuffSpec = { color: "#ffe6a8", kind: "glow", size: 0.15, grow: 0.5, life: 0.08, alpha: 0.9 };

/** Suivi d'une roue qui laisse une trace : sa position à l'image précédente, sa vitesse, le début de la bande en cours et la direction de la précédente. */
interface Rolling {
  last: Vec3 | null;
  speed: number;
  accel: number;
  mark: Vec3 | null;
  heading: { x: number; z: number } | null;
  /** Normale du sol sous la dernière bande posée, et dernier point de contact (la bande en cours y finit si la roue cesse de mener). */
  normal: Vec3;
  contact: Vec3 | null;
  /** Hauteur du sol sous la roue, et où on l'a cherchée. */
  floor: number;
  floorAt: Vec3 | null;
}

/**
 * Une voie d'un robot (même écart sur le côté) : sa roue de devant et sa roue de derrière parmi les
 * plus basses (la même s'il n'y en a qu'une), et celle qui mène, qui trace : les autres roulent dans
 * son ornière. Une chenille est une voie : son galet de devant trace, sous la bande.
 */
interface Lane {
  front: Wheel;
  rear: Wheel;
  leader: Wheel;
}

/** Ce qu'on sait d'une roue à cette image. */
interface Sample {
  st: Rolling;
  v: Vec3;
  speed: number;
  contact: Vec3;
  /** Elle touche le sol, hors de l'eau ; ou dans l'eau. */
  grounded: boolean;
  wet: boolean;
}

/** Suivi d'une chute : la plus grande vitesse de descente, et quand elle a été atteinte. */
interface Fall {
  worst: number;
  at: number;
}

export function groundFx(ctx: FxContext): FxSystem {
  const live = new LiveSet(ctx.world);
  /** Voies de chaque robot (voir `Lane`). */
  const lanes = new Map<Bot, Lane[]>();
  const rolling = new Map<Wheel, Rolling>();
  /** Pattes : le cosinus de leur phase à l'image précédente (le pied se pose quand il passe sous 0). */
  const legs = new Map<Support, number>();
  const falls = new Map<Bot, Fall>();

  const arena = (): typeof ctx.world.arena => ctx.world.arena;
  const water = (): number | undefined => ctx.world.arena.water;
  /** Ce point (x, z) est-il sous l'eau (le lit de la rivière est plus bas que sa surface) ? */
  const wet = (x: number, z: number): boolean => {
    const w = water();
    return w !== undefined && groundLevel(arena(), x, z) < w - 0.05;
  };
  /** Couleur de la poussière : celle du sol, éclaircie. */
  const dustColor = (p: Vec3): string => {
    const c = groundRgb(arena(), p.x, p.y, p.z);
    return toHex(c.r * 0.65 + 0.3, c.g * 0.65 + 0.28, c.b * 0.65 + 0.25);
  };
  const markColor = (p: Vec3, k: number): string => {
    const c = groundRgb(arena(), p.x, p.y, p.z);
    return toHex(c.r * k, c.g * k, c.b * k);
  };
  /** Hauteur du sol ou du décor sous un point, à moins de `reach` m dessous (sinon celle du relief). */
  const floorUnder = (p: Vec3, reach: number): number => {
    const t = rayArena(arena(), p, vec3(0, -1, 0), reach);
    return Math.max(t !== null ? p.y - t : -Infinity, groundLevel(arena(), p.x, p.z));
  };

  const off = ctx.world.on((e) => {
    switch (e.type) {
      case "wheelAdded":
        lanes.delete(e.wheel.bot);
        break;
      case "wheelRemoved":
        lanes.delete(e.wheel.bot);
        rolling.delete(e.wheel);
        break;
      case "botRemoved":
        lanes.delete(e.bot);
        falls.delete(e.bot);
        for (const w of e.bot.wheels) rolling.delete(w);
        for (const s of e.bot.supports) legs.delete(s);
        break;
      case "arenaChanged":
        // Les traces, empreintes et cratères de l'ancienne arène n'ont rien à faire sur le sol de la nouvelle
        ctx.marks.clear();
        lanes.clear();
        rolling.clear();
        break;
      case "collision":
        clash(e.point, e.strength);
        break;
      case "impact":
        if (wet(e.point.x, e.point.z) && e.point.y < (water() ?? 0) + 0.4) splash(e.point, 0.25);
        break;
      case "explosion":
        if (wet(e.point.x, e.point.z) && e.point.y < (water() ?? 0) + e.radius * 0.6) splash(e.point, Math.min(3, 0.6 + e.radius * 0.8));
        break;
    }
  });

  /** 45 : un choc (collision, frottement) : un éclair et une gerbe d'étincelles étirées. */
  function clash(at: Vec3, strength: number): void {
    if (distance(at, ctx.eye) > FX_RANGE) return;
    const k = Math.min(1, strength / 120);
    ctx.particles.emit(at, FLASH, undefined, 0.6 + k);
    const n = Math.round((5 + 22 * k) * ctx.density);
    for (let i = 0; i < n; i++) {
      const speed = jitter(3, 6 + 7 * k);
      const dir = norm(vec3(jitter(-1, 1), jitter(-0.2, 1), jitter(-1, 1)));
      ctx.particles.emit(at, Math.random() < 0.3 ? HOT_SPARK : SPARK, vec3(dir.x * speed, dir.y * speed, dir.z * speed));
    }
  }

  /** 42 : une gerbe d'eau à la surface, au-dessus de `at` ; `size` : 0,25 pour une balle, 1 à 3 pour une explosion. */
  function splash(at: Vec3, size: number): void {
    const w = water();
    if (w === undefined || distance(at, ctx.eye) > FX_RANGE) return;
    const surface = vec3(at.x, w + 0.05, at.z);
    const drops = Math.round((4 + 14 * size) * ctx.density);
    for (let i = 0; i < drops; i++) {
      ctx.particles.emit(surface, DROPLET, vec3(jitter(-1.5, 1.5) * size, jitter(2.5, 5 + 4 * size), jitter(-1.5, 1.5) * size), 0.8 + size * 0.3);
    }
    const foam = Math.round((1 + 5 * size) * ctx.density);
    for (let i = 0; i < foam; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = jitter(0, 0.4) * size;
      ctx.particles.emit(vec3(surface.x + Math.cos(a) * r, surface.y, surface.z + Math.sin(a) * r), FOAM, vec3(Math.cos(a) * size, 0.2, Math.sin(a) * size), 0.6 + size * 0.5);
    }
    // Une explosion soulève en plus une colonne d'embruns
    if (size >= 0.6) for (let i = Math.round(3 * size * ctx.density); i > 0; i--) ctx.particles.emit(surface, SPRAY, vec3(jitter(-0.6, 0.6), jitter(3, 5) * size, jitter(-0.6, 0.6)), size);
  }

  /** Éclaboussures d'un robot qui avance dans l'eau, au point `at` de la surface, à la vitesse `v`. */
  function wade(at: Vec3, v: Vec3, speed: number, dt: number, scale = 1): void {
    const w = water()!;
    const n = countOf(Math.min(24, speed * 3) * ctx.density * scale, dt);
    const surface = vec3(at.x, w + 0.05, at.z);
    for (let i = 0; i < n; i++) {
      ctx.particles.emit(surface, DROPLET, vec3(v.x * 0.3 + jitter(-1.5, 1.5), jitter(1.5, 2.5 + speed * 0.3), v.z * 0.3 + jitter(-1.5, 1.5)));
      if (Math.random() < 0.35) ctx.particles.emit(surface, FOAM, vec3(jitter(-0.5, 0.5), 0.1, jitter(-0.5, 0.5)));
    }
  }

  /** Voies d'un robot : dans chaque voie, ses roues montées les plus basses, celle de devant et celle de derrière. */
  function lanesOf(bot: Bot): Lane[] {
    let list = lanes.get(bot);
    if (list) return list;
    const low = new Map<number, Wheel[]>();
    for (const w of bot.wheels) {
      if (!w.hub || !live.wheelOk(w)) continue;
      const key = Math.round(w.local.x / LANE);
      const cur = low.get(key);
      if (!cur || w.local.y < cur[0].local.y - 0.1) low.set(key, [w]);
      else if (Math.abs(w.local.y - cur[0].local.y) <= 0.1) cur.push(w);
    }
    list = [...low.values()].map((ws) => {
      const front = ws.reduce((a, b) => (b.local.z > a.local.z ? b : a));
      const rear = ws.reduce((a, b) => (b.local.z < a.local.z ? b : a));
      return { front, rear, leader: front };
    });
    lanes.set(bot, list);
    return list;
  }

  /** Cette roue est-elle encore là, sur un morceau encore là ? */
  const usable = (w: Wheel): boolean => !!w.hub && !!w.part && live.wheelOk(w) && live.parts.has(w.part);

  /** Relève une roue à cette image : vitesse, sol sous elle ; null si elle est trop loin ou vue pour la première fois. */
  function sample(w: Wheel, dt: number): Sample | null {
    const def = wheelDef(w.type);
    const c = w.rb.translation();
    let st = rolling.get(w);
    if (!st) {
      st = { last: null, speed: 0, accel: 0, mark: null, heading: null, normal: vec3(0, 1, 0), contact: null, floor: 0, floorAt: null };
      rolling.set(w, st);
    }
    const seen = st.last !== null;
    const v = st.last ? vec3((c.x - st.last.x) / dt, (c.y - st.last.y) / dt, (c.z - st.last.z) / dt) : vec3(0, 0, 0);
    st.last = c;
    if (distance(c, ctx.eye) > MARK_RANGE) {
      st.mark = null;
      return null;
    }
    if (!st.floorAt || Math.abs(c.x - st.floorAt.x) + Math.abs(c.z - st.floorAt.z) > FLOOR_REUSE || Math.abs(c.y - st.floorAt.y) > FLOOR_REUSE) {
      st.floor = floorUnder(c, def.radius + 0.5);
      st.floorAt = c;
    }
    const contact = vec3(c.x, st.floor, c.z);
    const speed = Math.hypot(v.x, v.z);
    // Accélération lissée (les poses du réseau arrivent par à-coups) ; à la première image, pas encore de vitesse
    if (seen) st.accel += ((speed - st.speed) / dt - st.accel) * (1 - Math.exp(-dt * 6));
    st.speed = speed;
    if (!seen) return null;
    const touching = c.y - def.radius - st.floor <= TOUCH && speed <= 60;
    const wetHere = touching && wet(c.x, c.z) && st.floor < water()!;
    return { st, v, speed, contact, grounded: touching && !wetHere, wet: wetHere };
  }

  /** 40, 41, 42 : traces, poussière et éclaboussures des roues. */
  function wheels(dt: number): void {
    for (const bot of ctx.world.bots) {
      for (const lane of lanesOf(bot)) {
        // Arrachée entre-temps (sans événement : on ne le voit qu'à son porte-moyeu) : on refait les voies
        if (!usable(lane.front) || !usable(lane.rear)) {
          lanes.delete(bot);
          rolling.delete(lane.front);
          rolling.delete(lane.rear);
          break;
        }
        const front = sample(lane.front, dt);
        const rear = lane.rear === lane.front ? front : sample(lane.rear, dt);
        if (!front || !rear) continue;
        // Le sens de marche : la roue qui mène trace, les autres roulent dans son ornière
        const fwd = qrot(lane.front.part!.rb.rotation(), vec3(0, 0, 1));
        const along = front.v.x * fwd.x + front.v.y * fwd.y + front.v.z * fwd.z;
        if (Math.abs(along) > LEAD_SPEED) {
          const leader = along >= 0 ? lane.front : lane.rear;
          if (leader !== lane.leader) {
            finishTrack(lane.leader);
            lane.leader = leader;
          }
        }
        const lead = lane.leader === lane.front ? front : rear;
        const def = wheelDef(lane.leader.type);
        if (lead.grounded) layTrack(lane.leader, lead.st, lead.contact, def.width, !!def.track);
        else lead.st.mark = null;
        // Poussière et éclaboussures derrière : à la roue qui suit (la même s'il n'y en a qu'une)
        const trailer = lane.leader === lane.front ? lane.rear : lane.front;
        const trail = trailer === lane.front ? front : rear;
        const tdef = wheelDef(trailer.type);
        if (trail.wet) {
          if (trail.speed > 1.2) wade(trail.contact, trail.v, trail.speed, dt, tdef.track ? 0.6 : 1);
          continue;
        }
        if (!trail.grounded) continue;
        if (bot === ctx.inside && distance(trail.contact, ctx.eye) < 6) continue;
        // Poussière : la vitesse sur la terre, le dérapage, les coups d'accélérateur
        const { v, speed, contact } = trail;
        const axle = qrot(trailer.hub!.rotation(), vec3(1, 0, 0));
        const slip = Math.abs(v.x * axle.x + v.z * axle.z);
        const soil = !!arena().terrain && contact.y <= terrainHeight(arena().terrain!, contact.x, contact.z) + 0.2;
        const rate = Math.min(14, Math.max(0, speed - (soil ? DUST_SOIL : DUST_HARD)) * (soil ? 0.8 : 0.3) + Math.max(0, slip - SLIP) * 4 + Math.max(0, Math.abs(trail.st.accel) - JOLT) * 1.2);
        const n = countOf(rate * ctx.density, dt);
        if (n === 0) continue;
        const color = dustColor(contact);
        for (let i = 0; i < n; i++) {
          ctx.particles.emit(vec3(contact.x + jitter(-0.2, 0.2), contact.y + 0.15, contact.z + jitter(-0.2, 0.2)), { ...DUST, color }, vec3(-v.x * 0.15 + jitter(-0.4, 0.4), jitter(0.4, 1), -v.z * 0.15 + jitter(-0.4, 0.4)), tdef.track ? 1.3 : 1);
        }
      }
    }
  }

  /** Style de la trace d'une roue. */
  const trackSpec = (contact: Vec3, track: boolean): MarkSpec => ({ color: markColor(contact, track ? 0.45 : 0.55), life: MARK_LIFE, alpha: track ? 0.5 : 0.4, fade: 0.4 });

  /**
   * 40 : prolonge la trace d'une roue par une bande, tous les `MARK_SPACING` m, ou plus tôt dans un
   * virage ; et, à chaque image, la bande provisoire de la dernière posée jusque sous la roue : la
   * trace sort de sous la roue, elle n'apparaît pas derrière elle.
   */
  function layTrack(w: Wheel, st: Rolling, contact: Vec3, width: number, track: boolean): void {
    st.contact = contact;
    if (!st.mark || distance(st.mark, contact) > MARK_JUMP) {
      st.mark = contact;
      st.heading = null;
      return;
    }
    const spacing = Math.min(2, MARK_SPACING / ctx.density);
    const dx = contact.x - st.mark.x, dz = contact.z - st.mark.z;
    const gap = Math.hypot(dx, dz);
    const turning = st.heading !== null && gap >= MARK_MIN && Math.acos(Math.max(-1, Math.min(1, (dx * st.heading.x + dz * st.heading.z) / gap))) > MARK_TURN;
    if (gap >= spacing || turning) {
      st.heading = { x: dx / gap, z: dz / gap };
      const a = arena();
      st.normal = a.terrain ? surfaceAt(a, contact.x, contact.z, contact.y)?.normal ?? vec3(0, 1, 0) : vec3(0, 1, 0);
      ctx.marks.strip(st.mark, contact, st.normal, width * 0.9, trackSpec(contact, track));
      st.mark = contact;
      return;
    }
    if (gap > 0.02) ctx.marks.liveStrip(w, st.mark, contact, st.normal, width * 0.9, trackSpec(contact, track));
  }

  /** Une roue cesse de mener (le robot change de sens) : la bande en cours est posée jusqu'à son dernier contact. */
  function finishTrack(w: Wheel): void {
    const st = rolling.get(w);
    if (!st) return;
    if (st.mark && st.contact && distance(st.mark, st.contact) > 0.02) {
      const def = wheelDef(w.type);
      ctx.marks.strip(st.mark, st.contact, st.normal, def.width * 0.9, trackSpec(st.contact, !!def.track));
    }
    st.mark = null;
  }

  /** 43, et les appuis dans l'eau : bouffée de poussière (ou éclaboussure) quand un pied se pose ; patins qui fendent l'eau. */
  function supports(dt: number): void {
    for (const bot of ctx.world.bots) {
      for (const s of bot.supports) {
        const spec = blockDef(s.block.type).support;
        if (!spec || !live.blockOk(s.block)) {
          legs.delete(s);
          continue;
        }
        const part = s.block.part;
        const v = part.rb.linvel();
        const speed = Math.hypot(v.x, v.z);
        if (spec.kind !== "leg") {
          // Un patin au-dessus de l'eau la fend en avançant
          if (!Number.isFinite(s.contact) || speed < 1.5) continue;
          const hip = blockWorldPos(s.block);
          if (distance(hip, ctx.eye) > FX_RANGE || !wet(hip.x, hip.z) || hip.y - (water() ?? 0) > 2) continue;
          wade(hip, v, speed, dt, 0.5);
          continue;
        }
        const offset = (s.block.x + s.block.z) % 2 === 0 ? 0 : Math.PI;
        const c = Math.cos(s.phase + offset);
        const prev = legs.get(s);
        legs.set(s, c);
        // Comme LocomotionView : les pattes ne marchent que sur le morceau du cockpit, quand il avance
        const moving = speed > 0.2 && part === bot.cockpit.part;
        if (prev === undefined || !moving || !(prev > 0 && c <= 0) || !Number.isFinite(s.contact)) continue;
        const hip = blockWorldPos(s.block);
        if (distance(hip, ctx.eye) > MARK_RANGE) continue;
        const com = part.rb.worldCom();
        let out = vec3(hip.x - com.x, 0, hip.z - com.z);
        out = len(out) > 0.05 ? norm(out) : qrot(part.rb.rotation(), vec3(1, 0, 0));
        const forward = norm(vec3(v.x, 0, v.z));
        const reach = HALF_STEP * Math.sin(s.phase + offset);
        const foot = vec3(hip.x + out.x * FOOT_OUT + forward.x * reach, hip.y - s.contact, hip.z + out.z * FOOT_OUT + forward.z * reach);
        if (wet(foot.x, foot.z)) {
          splash(foot, 0.3);
          continue;
        }
        const color = dustColor(foot);
        for (let i = Math.round(5 * ctx.density); i > 0; i--) {
          const a = Math.random() * Math.PI * 2;
          ctx.particles.emit(vec3(foot.x, foot.y + 0.08, foot.z), { ...STEP_DUST, color }, vec3(Math.cos(a) * 1.1, jitter(0.2, 0.6), Math.sin(a) * 1.1));
        }
        // Et l'empreinte du pied, qui s'efface
        const ground = surfaceAt(arena(), foot.x, foot.z, foot.y);
        if (ground) ctx.marks.disc(ground.point, ground.normal, 0.2, { color: markColor(foot, 0.6), life: 8, alpha: 0.35 });
      }
    }
  }

  /** 44, 45 : atterrissages lourds (poussière ou gerbe d'eau) ; robots renversés qui raclent le sol (étincelles). */
  function bodies(dt: number): void {
    for (const bot of ctx.world.bots) {
      const ck = bot.cockpit;
      if (!live.blockOk(ck)) continue;
      const rb = ck.part.rb;
      const v = rb.linvel();
      let fall = falls.get(bot);
      if (!fall) {
        fall = { worst: 0, at: -Infinity };
        falls.set(bot, fall);
      }
      if (v.y < -1.5) {
        if (v.y < fall.worst) fall.worst = v.y;
        fall.at = ctx.now;
      } else if (fall.worst < -HARD_LANDING && v.y > -1 && ctx.now - fall.at < LANDING_WINDOW) {
        land(bot, rb.translation(), -fall.worst);
        fall.worst = 0;
      } else if (ctx.now - fall.at > LANDING_WINDOW) fall.worst = 0;
      // Renversé, il glisse sur le dos : ça racle
      const speed = Math.hypot(v.x, v.z);
      if (bot.flippedFor > 0.3 && speed > SCRAPE_SPEED) {
        const pos = rb.translation();
        if (distance(pos, ctx.eye) > FX_RANGE) continue;
        const floor = floorUnder(pos, bot.radius + 1.5);
        if (pos.y - floor > bot.radius + 0.4 || wet(pos.x, pos.z)) continue;
        const n = countOf(Math.min(40, speed * 5) * ctx.density, dt);
        for (let i = 0; i < n; i++) {
          const at = vec3(pos.x + jitter(-0.5, 0.5) * bot.radius, floor + 0.05, pos.z + jitter(-0.5, 0.5) * bot.radius);
          ctx.particles.emit(at, SPARK, vec3(-v.x * 0.4 + jitter(-1, 1), jitter(1, 3), -v.z * 0.4 + jitter(-1, 1)));
        }
      }
    }
  }

  /** 44 : un robot retombe lourdement : un anneau de poussière (ou une gerbe d'eau), à la mesure du choc. */
  function land(bot: Bot, pos: Vec3, speed: number): void {
    if (distance(pos, ctx.eye) > FX_RANGE) return;
    const floor = floorUnder(pos, bot.radius + 2.5);
    if (pos.y - floor > bot.radius + 2) return;
    const k = clamp((speed - HARD_LANDING) / 8, 0, 1);
    const ground = vec3(pos.x, floor, pos.z);
    if (wet(pos.x, pos.z) && floor < water()!) {
      splash(ground, 0.8 + 1.5 * k);
      return;
    }
    const color = dustColor(ground);
    const n = Math.round((10 + 16 * k) * ctx.density);
    const r = Math.max(0.6, bot.radius * 0.7);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + jitter(-0.2, 0.2);
      const out = jitter(2, 3 + 5 * k);
      ctx.particles.emit(vec3(pos.x + Math.cos(a) * r, floor + 0.2, pos.z + Math.sin(a) * r), { ...BIG_DUST, color }, vec3(Math.cos(a) * out, jitter(0.2, 0.8), Math.sin(a) * out), 0.7 + 0.6 * k);
    }
  }

  return {
    update(dt) {
      if (dt <= 0) return;
      wheels(dt);
      supports(dt);
      bodies(dt);
    },
    dispose() {
      off();
      live.dispose();
      lanes.clear();
      rolling.clear();
      legs.clear();
      falls.clear();
    },
  };
}
