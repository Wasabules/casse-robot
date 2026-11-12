import type { Quat, Vec3 } from "../../shared/math/vec";
import type { Simulation } from "../../shared/sim/simulation";

/*
 * Interpolation des poses en solo. La simulation avance à pas fixe (60 Hz) ; l'image se dessine au
 * rythme de l'écran (120, 144 Hz…) ou à celui que tient la machine. Sans rien faire, un robot ne
 * bougerait qu'aux images où tombe un pas : une image sur deux à 120 Hz, irrégulièrement à 144 Hz
 * (une saccade). Après chaque pas, on relève donc la pose de tout ce qui bouge ; le temps de dessiner
 * une image, on montre au rendu des poses interpolées entre l'avant-dernier et le dernier pas (`alpha` :
 * la part du pas suivant déjà écoulée), puis on lui reprend : l'image a un pas de retard (16,7 ms),
 * mais tout y glisse. Comme la réplique en multijoueur (ses `PoseBody`), les corps des morceaux, des
 * roues (et de leur porte-moyeu), des débris, des accessoires mobiles sont remplacés par des poses
 * (`ShownPose` : le rendu, les effets, le son, la caméra n'en lisent que la pose, les vitesses, le
 * centre de masse), et la position des projectiles par une position interpolée.
 *
 * Seules la position et l'orientation sont relevées à chaque pas (deux appels à Rapier par corps) ;
 * les vitesses et la masse se lisent au vrai corps si on les demande, et le centre de masse se
 * replace sur la pose interpolée (la caméra, qui le suit, reste d'accord avec ce qu'elle montre).
 *
 * Pendant la fenêtre (de `begin` à `end`), la simulation ne doit pas avancer ni être modifiée : ses
 * entités portent des poses, pas leurs corps Rapier. `end` est donc appelé après le rendu de l'image,
 * et avant tout ce qui change le monde depuis le rendu (une nouvelle vague de la démonstration).
 */

/** Ce qu'on lit d'un corps (Rapier, pose de roue). */
interface BodyLike {
  translation(): Vec3;
  rotation(): Quat;
  linvel(): Vec3;
  angvel(): Vec3;
  worldCom?(): Vec3;
  localCom?(): Vec3;
  mass?(): number;
}

/** Une pose relevée : position (x, y, z) et orientation (x, y, z, w). */
type Pose = Float64Array;

/** Une chose qui bouge et le champ qu'on remplace : un corps (`rb`, `hub`) ou une position (`pos`). */
interface Track {
  owner: Record<string, unknown>;
  field: string;
  prev: Pose;
  curr: Pose;
  /** Deux poses relevées : on peut interpoler. */
  ready: boolean;
  seen: number;
  /** Ce qui est montré au rendu (une pose de corps, ou une position), réutilisé d'une image à l'autre. */
  shown: ShownPose | Vec3 | null;
  /** Ce que portait le champ avant d'être remplacé (pendant la fenêtre). */
  saved: unknown;
}

/**
 * Un corps tel que le voit le rendu pendant l'image : la pose interpolée ; les vitesses et la masse
 * du vrai corps (au dernier pas) ; son centre de masse replacé sur la pose interpolée.
 */
export class ShownPose {
  readonly pos = { x: 0, y: 0, z: 0 };
  readonly rot = { x: 0, y: 0, z: 0, w: 1 };
  /** (comme `PoseBody` : pas de collider à retrouver par ce numéro) */
  readonly handle = -1;
  source: BodyLike | null = null;

  translation(): Vec3 {
    return { x: this.pos.x, y: this.pos.y, z: this.pos.z };
  }

  rotation(): Quat {
    return { x: this.rot.x, y: this.rot.y, z: this.rot.z, w: this.rot.w };
  }

  // (lue hors de son image, une pose n'a plus de corps derrière elle : immobile plutôt qu'un corps peut-être libéré)
  linvel(): Vec3 {
    return this.source?.linvel() ?? { x: 0, y: 0, z: 0 };
  }

  angvel(): Vec3 {
    return this.source?.angvel() ?? { x: 0, y: 0, z: 0 };
  }

  worldCom(): Vec3 {
    const local = this.source?.localCom?.();
    if (!local) return this.translation();
    // Le centre de masse dans le repère du corps, tourné et posé comme lui
    const { x, y, z, w } = this.rot;
    const tx = 2 * (y * local.z - z * local.y), ty = 2 * (z * local.x - x * local.z), tz = 2 * (x * local.y - y * local.x);
    return {
      x: this.pos.x + local.x + w * tx + (y * tz - z * ty),
      y: this.pos.y + local.y + w * ty + (z * tx - x * tz),
      z: this.pos.z + local.z + w * tz + (x * ty - y * tx),
    };
  }

  mass(): number {
    return this.source?.mass?.() ?? 0;
  }
}

export class PoseInterpolation {
  /** Les choses suivies, par champ remplacé (une roue a `rb` et `hub`). */
  private readonly tracks = { rb: new Map<object, Track>(), hub: new Map<object, Track>(), pos: new Map<object, Track>() };
  private generation = 0;
  /** Les champs remplacés pendant la fenêtre en cours. */
  private readonly open: Track[] = [];

  /** Nombre de choses suivies. */
  get size(): number {
    return this.tracks.rb.size + this.tracks.hub.size + this.tracks.pos.size;
  }

  /** Oublie tout (nouvelle vague, autre arène) : les choses d'avant ne reviendront pas. */
  reset(): void {
    this.end();
    for (const map of Object.values(this.tracks)) map.clear();
  }

  /** Relève les poses après un pas de simulation. */
  capture(sim: Simulation): void {
    this.end();
    const gen = ++this.generation;
    for (const part of sim.parts) this.body("rb", part, part.rb, gen);
    for (const bot of sim.bots) {
      for (const wheel of bot.wheels) {
        this.body("rb", wheel, wheel.rb, gen);
        if (wheel.hub) this.body("hub", wheel, wheel.hub, gen);
      }
    }
    for (const debris of sim.debris) this.body("rb", debris, debris.rb, gen);
    // (un accessoire ancré ne bouge pas : rien à interpoler)
    for (const prop of sim.props) if (!prop.fixed) this.body("rb", prop, prop.rb, gen);
    for (const p of sim.projectiles) this.point(p, p.pos, gen);
    for (const map of Object.values(this.tracks)) for (const [owner, track] of map) if (track.seen !== gen) map.delete(owner);
  }

  private track(field: "rb" | "hub" | "pos", owner: object, gen: number): Track {
    const map = this.tracks[field];
    let track = map.get(owner);
    if (track) {
      // L'ancienne pose courante devient la précédente (on garde les deux tableaux)
      const old = track.prev;
      track.prev = track.curr;
      track.curr = old;
      track.ready = track.seen === gen - 1;
    } else {
      track = { owner: owner as Record<string, unknown>, field, prev: new Float64Array(7), curr: new Float64Array(7), ready: false, seen: gen, shown: null, saved: null };
      map.set(owner, track);
    }
    track.seen = gen;
    return track;
  }

  private body(field: "rb" | "hub", owner: object, body: BodyLike, gen: number): void {
    const c = this.track(field, owner, gen).curr;
    const p = body.translation(), q = body.rotation();
    c[0] = p.x; c[1] = p.y; c[2] = p.z;
    c[3] = q.x; c[4] = q.y; c[5] = q.z; c[6] = q.w;
  }

  private point(owner: object, p: Vec3, gen: number): void {
    const c = this.track("pos", owner, gen).curr;
    c[0] = p.x; c[1] = p.y; c[2] = p.z;
  }

  /**
   * Montre au rendu les poses à `alpha` (0 : l'avant-dernier pas, 1 : le dernier) jusqu'à `end`. Ce
   * qui n'a qu'une pose relevée (apparu au dernier pas) reste tel quel.
   */
  begin(alpha: number): void {
    this.end();
    const t = Math.min(1, Math.max(0, alpha));
    for (const [field, map] of Object.entries(this.tracks)) {
      const point = field === "pos";
      for (const track of map.values()) {
        if (!track.ready) continue;
        const a = track.prev, b = track.curr;
        track.saved = track.owner[track.field];
        if (point) {
          const shown = (track.shown ??= { x: 0, y: 0, z: 0 }) as Vec3;
          shown.x = a[0] + (b[0] - a[0]) * t;
          shown.y = a[1] + (b[1] - a[1]) * t;
          shown.z = a[2] + (b[2] - a[2]) * t;
          track.owner[track.field] = shown;
        } else {
          const shown = (track.shown ??= new ShownPose()) as ShownPose;
          shown.source = track.saved as BodyLike;
          shown.pos.x = a[0] + (b[0] - a[0]) * t;
          shown.pos.y = a[1] + (b[1] - a[1]) * t;
          shown.pos.z = a[2] + (b[2] - a[2]) * t;
          // Interpolation normalisée des orientations, par le plus court chemin : assez juste d'un pas au suivant
          const s = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6] < 0 ? -1 : 1;
          const x = a[3] + (s * b[3] - a[3]) * t, y = a[4] + (s * b[4] - a[4]) * t, z = a[5] + (s * b[5] - a[5]) * t, w = a[6] + (s * b[6] - a[6]) * t;
          const n = Math.hypot(x, y, z, w) || 1;
          shown.rot.x = x / n; shown.rot.y = y / n; shown.rot.z = z / n; shown.rot.w = w / n;
          track.owner[track.field] = shown;
        }
        this.open.push(track);
      }
    }
  }

  /** Rend à la simulation ses corps et ses positions. */
  end(): void {
    for (const track of this.open) {
      track.owner[track.field] = track.saved;
      track.saved = null;
      if (track.shown instanceof ShownPose) track.shown.source = null;
    }
    this.open.length = 0;
  }
}
