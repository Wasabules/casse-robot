import * as B from "../babylon";
import { flailOrbit, isBit, meleeAxes, meleeDef, type MeleeAxis, type MeleeId, type MeleeSpec } from "../../shared/catalog/melee";
import { meleeFrame, restSwing, unbalanceShare, vibration } from "../../shared/combat/melee";
import { crankTip } from "../../shared/combat/mechanics";
import { clamp } from "../../shared/math/scalar";
import { add, cross, len, norm, scale, sub, vec3, type Vec3 } from "../../shared/math/vec";
import type { Block, Bot, MeleeArm } from "../../shared/sim/entities";
import type { Assets } from "./materials";
import { LANCE_HEAD } from "./models/meleeEnergy";

/*
 * Armes de contact, à l'écran (la simulation : shared/combat/melee.ts). La partie mobile (la barre
 * d'une toupie, le bras d'un marteau, l'émetteur d'une lame laser, la poignée d'un fouet, la tête
 * d'une lance, l'anneau d'un champ) est accrochée au repère de son bloc (`WorldView.anchor`), à son
 * moyeu, et tourne autour de l'axe de l'arme : un rotor de son régime (`MeleeArm.spin`, qui passe par
 * le réseau), plafonné par image comme les pales des rotors (sinon l'œil la voit ralentir ou tourner
 * à l'envers), avec un disque flou translucide quand il tourne vite ; un bras, à son angle
 * (`MeleeArm.swing`) ; une lance sort de sa sortie (`swing`, en mètres), sa hampe étirée jusqu'à sa
 * tête. Un rotor déséquilibré (balourd) tremble en tournant, et son robot entier vibre (`shake`, que
 * WorldView ajoute à la pose de ses morceaux). Une arme d'énergie a sa partie lumineuse (`glow` :
 * l'arc de la lame, le filament, l'étincelle de la pointe, le halo du champ), posée avec la partie
 * mobile et montrée quand elle est allumée. L'outil d'une lame qui mord derrière un réducteur (la
 * mèche d'une foreuse) tourne `gear` fois moins vite que son rotor : on voit ses filets avancer.
 *
 * Les frappes à mécanique (shared/combat/mechanics.ts) : le plateau d'un flipper prend son angle
 * comme un bras ; deux mâchoires, de part et d'autre, leur demi-ouverture ; la manivelle d'un fléau
 * son angle (`MeleeArm.angle`), et sa boule et les maillons de sa chaîne sont posés dans le monde,
 * d'après la boule (`MeleeArm.ball`) : la chaîne va du bout de la manivelle (ou du poteau où elle
 * s'est enroulée) à la boule, et pend quand elle est lâche.
 */

/** Rotation affichée par image, au plus, en part de l'écart entre deux bouts de la lame (une barre : un demi-tour). */
const STROBE_LIMIT = 0.28;
/**
 * Écart (rad) entre deux motifs semblables de la partie qui tourne : les deux bouts d'une barre, les
 * deux dents d'un disque, les trois rangées de dents d'un tambour, les quatre percuteurs d'un anneau.
 */
const STROBE_GAP: Record<MeleeSpec["look"], number> = {
  bar: Math.PI, disc: Math.PI, drum: (2 * Math.PI) / 3, shell: Math.PI / 2, hammer: Math.PI, propeller: (2 * Math.PI) / 3,
  saber: Math.PI, whip: Math.PI, lance: Math.PI, field: Math.PI, saw: Math.PI, drill: Math.PI, plate: Math.PI, flail: Math.PI, jaw: Math.PI,
};
/** Le disque flou paraît au-delà de cette part du plein régime. */
const BLUR_FROM = 0.2;
/** Balourd : inclinaison qui tremble (rad), au plus. */
const WOBBLE = 0.07;
/** Vibration du robot entier à balourd entier, plein régime (m). */
const SHAKE = 0.035;
/** Une lame d'énergie, un champ sont allumés au-delà de cette part de leur plein régime. */
const LIT_FROM = 0.15;
/** Un fouet brille tant que son bras est à plus de cette part de son arc de son repos (il frappe, il revient). */
const LASH_LIT = 0.35;
/** Un maillon de chaîne est allongé de tant le long de la chaîne (le modèle est un anneau rond). */
const LINK_STRETCH = 1.5;
/** Une chaîne lâche pend de cette part de ce qu'elle a de trop (au milieu). */
const SAG = 0.35;

/** Rotation de l'axe y d'un disque vers l'axe de l'arme (repère du bloc). */
const DISC_TURN: Record<MeleeAxis, B.Quaternion> = {
  up: B.Quaternion.Identity(),
  left: B.Quaternion.RotationAxis(new B.Vector3(0, 0, 1), -Math.PI / 2),
  forward: B.Quaternion.RotationAxis(new B.Vector3(1, 0, 0), Math.PI / 2),
};

/** Rotation de +z vers `e1` (repère du bloc) : une lance, dessinée le long de +z, sort le long de `e1`. */
const ALONG_E1: Record<MeleeAxis, B.Quaternion> = {
  up: B.Quaternion.Identity(),
  left: B.Quaternion.Identity(),
  forward: B.Quaternion.RotationAxis(new B.Vector3(1, 0, 0), -Math.PI / 2),
};

/** Angle d'un rotor arrêté, hors du jeu (rad, autour de son axe) : la barre d'une toupie de biais, qu'on la voie bien. */
const STILL_ROTOR = Math.PI / 4;

const toB = (v: Vec3): B.Vector3 => new B.Vector3(v.x, v.y, v.z);

/**
 * Pose de la partie mobile d'une arme dans le repère de son bloc : à son moyeu, tournée de `angle`
 * autour de son axe (un rotor, un bras : à l'envers, voir `pose`) ou sortie de `extension` m (une
 * lance). Écrit dans `position` et `rotation`.
 */
function placeMoving(spec: MeleeSpec, value: number, position: B.Vector3, rotation: B.Quaternion): void {
  const [hx, hy, hz] = spec.hub;
  position.set(hx, hy, hz);
  if (spec.thrust) {
    // La tête, dessinée la pointe à `reach`, glisse le long de `e1` jusqu'à la sortie voulue
    const e1 = meleeAxes(spec.axis).e1;
    const slide = value - spec.thrust.reach;
    position.addInPlaceFromFloats(e1.x * slide, e1.y * slide, e1.z * slide);
    rotation.copyFrom(ALONG_E1[spec.axis]);
    return;
  }
  B.Quaternion.RotationAxisToRef(toB(meleeAxes(spec.axis).axis), value, rotation);
}

/** Longueur de la hampe d'une lance sortie de `extension` m (de son moyeu à sa tête, un peu dedans). */
const shaftLength = (extension: number): number => Math.max(0.01, extension - LANCE_HEAD + 0.06);

/** Orientation d'un maillon : son long côté (z) le long de `along`, tourné d'un quart de tour un maillon sur deux. */
function linkRotation(along: Vec3, odd: boolean, out: B.Quaternion): void {
  const z = len(along) > 1e-6 ? norm(along) : vec3(0, 0, 1);
  const ref = Math.abs(z.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  let x = norm(cross(ref, z));
  let y = cross(z, x);
  if (odd) [x, y] = [y, scale(x, -1)];
  B.Quaternion.RotationQuaternionFromAxisToRef(toB(x), toB(y), toB(z), out);
}

/**
 * Points (monde) où poser les `count` maillons d'une chaîne de `from` à `to` (par `via`, si elle
 * est enroulée autour d'un obstacle), longue de `length` m : tendue, en ligne droite ; lâche, elle
 * pend au milieu.
 */
export function chainPoints(from: Vec3, to: Vec3, length: number, count: number, via: Vec3 | null = null): Vec3[] {
  const legs = via ? [[from, via], [via, to]] : [[from, to]];
  const spans = legs.map(([a, b]) => len(sub(b, a)));
  const total = spans.reduce((s, x) => s + x, 0);
  const sag = total < length ? SAG * Math.sqrt(length * length - total * total) : 0;
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    let d = t * total;
    let k = 0;
    while (k < legs.length - 1 && d > spans[k]) d -= spans[k++];
    const [a, b] = legs[k];
    const u = spans[k] > 1e-6 ? d / spans[k] : 0;
    out.push(add(add(a, scale(sub(b, a), u)), vec3(0, -4 * sag * t * (1 - t), 0)));
  }
  return out;
}

/**
 * Les autres pièces d'une frappe à mécanique hors du jeu, dans le repère de son bloc : la mâchoire du
 * bas (ouverte), la boule d'un fléau au bout de sa chaîne là où elle tourne lancée (ce que réserve
 * son encombrement), et les maillons. `instance` crée chaque pièce d'une source.
 */
function stillMechanics(assets: Assets, weapon: MeleeId, instance: (source: B.Mesh, name: string) => B.AbstractMesh): B.AbstractMesh[] {
  const spec = meleeDef(weapon);
  const made: B.AbstractMesh[] = [];
  const hub = vec3(spec.hub[0], spec.hub[1], spec.hub[2]);
  const axes = meleeAxes(spec.axis);
  const lower = assets.meleePieceSource(weapon, "lower");
  if (spec.jaw && lower) {
    const m = instance(lower, "still-melee-lower");
    m.position.set(hub.x, hub.y, hub.z);
    m.rotationQuaternion = B.Quaternion.RotationAxis(toB(axes.axis), spec.jaw.open);
    made.push(m);
  }
  const ballSource = assets.meleePieceSource(weapon, "ball");
  const linkSource = assets.meleePieceSource(weapon, "link");
  const fl = spec.flail;
  if (fl && ballSource && linkSource) {
    const orbit = flailOrbit(fl);
    const tip = add(hub, scale(axes.e1, fl.crank));
    const at = add(add(hub, scale(axes.e1, orbit.radius)), scale(axes.axis, -orbit.drop));
    const ball = instance(ballSource, "still-melee-ball");
    ball.position.set(at.x, at.y, at.z);
    made.push(ball);
    chainPoints(tip, at, fl.chain, fl.links).forEach((p, i) => {
      const link = instance(linkSource, "still-melee-link");
      link.position.set(p.x, p.y, p.z);
      link.rotationQuaternion = new B.Quaternion();
      linkRotation(sub(at, tip), i % 2 === 1, link.rotationQuaternion);
      link.scaling.z = LINK_STRETCH;
      made.push(link);
    });
  }
  return made;
}

/**
 * Pose immobile d'une arme de contact hors du jeu (garage, aperçus, vignettes) : sa partie mobile au
 * repos (une barre de biais, un bras armé, une lance rentrée), sa lueur avec elle (allumée : on voit
 * ce qu'elle est), et la hampe d'une lance. Sous `parent` (le bloc posé), avec `instance` pour créer
 * chaque pièce d'une source. Renvoie ce qui a été créé.
 */
export function stillMelee(assets: Assets, weapon: MeleeId, instance: (source: B.Mesh, name: string) => B.AbstractMesh): B.AbstractMesh[] {
  const spec = meleeDef(weapon);
  // (un bras, un plateau, une mâchoire : à leur angle de repos ; une manivelle de fléau : droit devant)
  const value = spec.thrust ? restSwing(spec) : spec.swing || spec.plate || spec.jaw ? -restSwing(spec) : spec.flail ? 0 : STILL_ROTOR;
  const made: B.AbstractMesh[] = [];
  const place = (m: B.AbstractMesh): B.AbstractMesh => {
    m.rotationQuaternion = new B.Quaternion();
    placeMoving(spec, value, m.position, m.rotationQuaternion);
    made.push(m);
    return m;
  };
  // (une hélice tranchante n'a rien de plus : ses pales sont celles de son moteur)
  const source = assets.meleeSource(weapon);
  if (!source) return made;
  place(instance(source, "still-melee"));
  // (le filament d'un fouet n'existe que quand il claque : au repos, on ne voit que sa poignée)
  const glow = assets.meleeGlowSource(weapon);
  if (glow && !spec.swing) place(instance(glow, "still-melee-glow"));
  if (spec.thrust) {
    const shaft = instance(assets.meleeShaftSource(), "still-melee-shaft");
    const [hx, hy, hz] = spec.hub;
    shaft.position.set(hx, hy, hz);
    shaft.rotationQuaternion = ALONG_E1[spec.axis].clone();
    shaft.scaling.set(1, 1, shaftLength(restSwing(spec)));
    made.push(shaft);
  }
  made.push(...stillMechanics(assets, weapon, instance));
  return made;
}

interface Rig {
  arm: MeleeArm;
  mesh: B.InstancedMesh;
  blur: B.InstancedMesh | null;
  /** Ce qui brille d'une arme d'énergie (posé comme `mesh`), et la hampe d'une lance. */
  glow: B.InstancedMesh | null;
  shaft: B.InstancedMesh | null;
  /** La mâchoire du bas (sous le repère du bloc). */
  lower: B.InstancedMesh | null;
  /** Fléau : la boule et les maillons, posés dans le monde. */
  ball: B.InstancedMesh | null;
  links: B.InstancedMesh[];
  /** Angle affiché du rotor (rad), et sa phase vraie (sans plafond), pour la vibration. */
  angle: number;
  phase: number;
}

export class MeleeRig {
  private readonly assets: Assets;
  private readonly shadows: B.ShadowGenerator;
  private readonly rigs = new Map<number, Rig>();
  /** Blocs annoncés avant leur arme (voir `attach`), à reprendre. */
  private readonly pending = new Map<number, { block: Block; anchor: B.TransformNode }>();
  /** Robot qu'on ne dessine pas (le joueur au viseur) : sa boule et sa chaîne, posées dans le monde, aussi. */
  hidden: Bot | null = null;

  constructor(assets: Assets, shadows: B.ShadowGenerator) {
    this.assets = assets;
    this.shadows = shadows;
  }

  /** Un bloc d'arme de contact s'affiche (ou change de morceau) : sa partie mobile, sous `anchor`. */
  attach(block: Block, anchor: B.TransformNode): void {
    const existing = this.rigs.get(block.id);
    if (existing) {
      for (const m of [existing.mesh, existing.blur, existing.glow, existing.shaft, existing.lower]) if (m) m.parent = anchor;
      return;
    }
    const arm = block.bot.melee.find((a) => a.block === block);
    // (à l'apparition, le bloc est annoncé avant que ses organes ne soient recensés : on y revient à l'image suivante)
    if (!arm) {
      this.pending.set(block.id, { block, anchor });
      return;
    }
    this.pending.delete(block.id);
    const spec = meleeDef(arm.weapon);
    // Une hélice tranchante : ses pales sont celles du moteur (LocomotionView), rien à ajouter
    const source = this.assets.meleeSource(arm.weapon);
    if (!source) return;
    const hub = new B.Vector3(spec.hub[0], spec.hub[1], spec.hub[2]);
    const part = (source: B.Mesh, name: string, shadow: boolean): B.InstancedMesh => {
      const m = source.createInstance(`${name}${block.id}`);
      m.parent = anchor;
      m.position.copyFrom(hub);
      m.rotationQuaternion = new B.Quaternion();
      m.isPickable = false;
      if (shadow) this.shadows.addShadowCaster(m, false);
      return m;
    };
    const mesh = part(source, "melee", true);
    let blur: B.InstancedMesh | null = null;
    // Le disque flou d'une lame à bras (une barre), d'énergie ou qui mord (une scie) : un disque plein ou
    // un tambour se voit tourner à ses dents ; une mèche n'en fait pas, elle tourne lentement derrière son réducteur
    if (spec.blade && !isBit(spec.blade) && (spec.blade.arms || spec.quench || spec.bite)) {
      blur = part(this.assets.meleeBlurSource(arm.weapon), "melee-blur", false);
      blur.rotationQuaternion = DISC_TURN[spec.axis].clone();
      blur.scaling.set(2 * spec.blade.outer, 2 * spec.blade.half * 0.6, 2 * spec.blade.outer);
      blur.isVisible = false;
    }
    const glowSource = this.assets.meleeGlowSource(arm.weapon);
    const glow = glowSource ? part(glowSource, "melee-glow", false) : null;
    if (glow) glow.isVisible = false;
    const shaft = spec.thrust ? part(this.assets.meleeShaftSource(), "melee-shaft", true) : null;
    const lowerSource = this.assets.meleePieceSource(arm.weapon, "lower");
    const lower = lowerSource ? part(lowerSource, "melee-lower", true) : null;
    // La boule et la chaîne d'un fléau : dans le monde
    let ball: B.InstancedMesh | null = null;
    const links: B.InstancedMesh[] = [];
    const ballSource = this.assets.meleePieceSource(arm.weapon, "ball");
    const linkSource = this.assets.meleePieceSource(arm.weapon, "link");
    if (spec.flail && ballSource && linkSource) {
      ball = ballSource.createInstance(`melee-ball${block.id}`);
      ball.rotationQuaternion = new B.Quaternion();
      ball.isPickable = false;
      this.shadows.addShadowCaster(ball, false);
      for (let i = 0; i < spec.flail.links; i++) {
        const link = linkSource.createInstance(`melee-link${block.id}-${i}`);
        link.rotationQuaternion = new B.Quaternion();
        link.scaling.set(1, 1, LINK_STRETCH);
        link.isPickable = false;
        links.push(link);
      }
    }
    this.rigs.set(block.id, { arm, mesh, blur, glow, shaft, lower, ball, links, angle: 0, phase: 0 });
    this.pose(this.rigs.get(block.id)!);
  }

  /** Le bloc n'est plus là : sa partie mobile disparaît. */
  detach(blockId: number): void {
    this.pending.delete(blockId);
    const rig = this.rigs.get(blockId);
    if (!rig) return;
    rig.mesh.dispose();
    rig.blur?.dispose();
    rig.glow?.dispose();
    rig.shaft?.dispose();
    rig.lower?.dispose();
    rig.ball?.dispose();
    for (const link of rig.links) link.dispose();
    this.rigs.delete(blockId);
  }

  /** À chaque image : les rotors tournent, les bras prennent leur angle, les lances leur sortie. */
  update(dt: number): void {
    for (const { block, anchor } of [...this.pending.values()]) {
      if (block.alive && !anchor.isDisposed()) this.attach(block, anchor);
      else this.pending.delete(block.id);
    }
    for (const rig of this.rigs.values()) {
      const spec = meleeDef(rig.arm.weapon);
      if (spec.spin) {
        const spin = rig.arm.spin * (spec.spin.direction ?? 1);
        // (le balourd est celui du rotor ; l'outil, derrière un réducteur, tourne `gear` fois moins vite)
        rig.phase = (rig.phase + spin * dt) % (Math.PI * 2);
        const most = STROBE_GAP[spec.look] * STROBE_LIMIT;
        // (l'outil d'une lame qui mord derrière un réducteur tourne `gear` fois moins vite que son rotor)
        const tool = spin / (spec.bite?.gear ?? 1);
        rig.angle = (rig.angle + clamp(tool * dt, -most, most)) % (Math.PI * 2);
        const ratio = clamp(rig.arm.spin / spec.spin.speed, 0, 1);
        // (une opacité fixe : l'opacité par instance ne passe pas, voir les pales de LocomotionView)
        if (rig.blur) rig.blur.isVisible = ratio > BLUR_FROM;
        if (rig.glow) rig.glow.isVisible = ratio > LIT_FROM;
      } else if (rig.glow) {
        rig.glow.isVisible = lit(spec, rig.arm);
      }
      this.pose(rig);
      if (rig.ball) this.placeFlail(rig);
    }
  }

  /** La boule d'un fléau, et sa chaîne du bout de la manivelle (ou du point où elle s'est enroulée) jusqu'à elle. */
  private placeFlail(rig: Rig): void {
    const arm = rig.arm;
    const fl = meleeDef(arm.weapon).flail!;
    const ball = arm.ball;
    const shown = !!ball && arm.block.alive && arm.block.bot !== this.hidden;
    rig.ball!.setEnabled(shown);
    for (const link of rig.links) link.setEnabled(shown);
    if (!shown || !ball) return;
    rig.ball!.position.set(ball.pos.x, ball.pos.y, ball.pos.z);
    const tip = crankTip(meleeFrame(arm), fl, arm.angle);
    const points = chainPoints(tip, ball.pos, fl.chain - ball.wound, rig.links.length, ball.wrap?.point ?? null);
    points.forEach((p, i) => {
      const link = rig.links[i];
      link.position.set(p.x, p.y, p.z);
      const next = points[i + 1] ?? ball.pos;
      const prev = i ? points[i - 1] : tip;
      linkRotation(sub(next, prev), i % 2 === 1, link.rotationQuaternion!);
    });
  }

  /** Oriente la partie mobile : autour de l'axe de l'arme, à l'angle du rotor ou du bras ; une lance à sa sortie ; un rotor déséquilibré tremble. */
  private pose(rig: Rig): void {
    const spec = meleeDef(rig.arm.weapon);
    const axes = meleeAxes(spec.axis);
    const q = rig.mesh.rotationQuaternion!;
    if (spec.spin) {
      placeMoving(spec, rig.angle, rig.mesh.position, q);
      const wobble = unbalanceShare(rig.arm) * clamp(rig.arm.spin / spec.spin.speed, 0, 1) * WOBBLE;
      if (wobble > 1e-3) {
        // L'axe penche du côté où est la masse excentrée, qui tourne avec le rotor
        const e1 = axes.e1;
        const e2 = axes.e2;
        const tilt = vec3(e1.x * Math.sin(rig.phase) - e2.x * Math.cos(rig.phase), e1.y * Math.sin(rig.phase) - e2.y * Math.cos(rig.phase), e1.z * Math.sin(rig.phase) - e2.z * Math.cos(rig.phase));
        const shaken = B.Quaternion.RotationAxis(toB(tilt), wobble);
        shaken.multiplyToRef(q, q);
        if (rig.blur) shaken.multiplyToRef(DISC_TURN[spec.axis], rig.blur.rotationQuaternion!);
      } else if (rig.blur) {
        rig.blur.rotationQuaternion!.copyFrom(DISC_TURN[spec.axis]);
      }
    } else if (spec.thrust) {
      placeMoving(spec, rig.arm.swing, rig.mesh.position, q);
      rig.shaft?.scaling.set(1, 1, shaftLength(rig.arm.swing));
      rig.shaft?.rotationQuaternion!.copyFrom(ALONG_E1[spec.axis]);
    } else if (spec.swing || spec.plate || spec.jaw) {
      // Le bras (le plateau, la mâchoire du haut) pointe le long de cos θ·e1 − sin θ·e2 : un quart de
      // tour autour de l'axe, à l'envers ; la mâchoire du bas, à l'opposé
      placeMoving(spec, -rig.arm.swing, rig.mesh.position, q);
      if (rig.lower) placeMoving(spec, rig.arm.swing, rig.lower.position, rig.lower.rotationQuaternion!);
    } else if (spec.flail) {
      placeMoving(spec, rig.arm.angle, rig.mesh.position, q);
    }
    if (rig.glow?.isVisible) {
      rig.glow.position.copyFrom(rig.mesh.position);
      rig.glow.rotationQuaternion!.copyFrom(q);
    }
  }

  /**
   * Vibration d'un robot dont un rotor a du balourd : un décalage (monde, m) à ajouter à la pose de
   * ses morceaux, qui tourne à la fréquence du rotor le plus déséquilibré.
   */
  shake(bot: Bot): B.Vector3 | null {
    if (!bot.melee.length) return null;
    const v = vibration(bot);
    if (v < 0.01) return null;
    let phase = 0;
    let worst = -1;
    for (const arm of bot.melee) {
      const share = unbalanceShare(arm) * arm.spin;
      const rig = this.rigs.get(arm.block.id);
      if (rig && share > worst) {
        worst = share;
        phase = rig.phase;
      }
    }
    const a = SHAKE * v;
    return new B.Vector3(a * Math.cos(phase), a * 0.35 * Math.sin(2 * phase), a * Math.sin(phase));
  }

  /** Tout disparaît (changement de monde). */
  dispose(): void {
    for (const id of [...this.rigs.keys()]) this.detach(id);
    this.pending.clear();
  }
}

/**
 * Une arme d'énergie sans rotor est-elle allumée ? Un fouet, tant qu'il frappe et le temps de
 * revenir (son filament claque) ; une lance, chargée hors de son retour (l'étincelle à sa pointe).
 * Ne lit que l'état des armes : marche aussi sur la réplique réseau.
 */
function lit(spec: MeleeSpec, arm: MeleeArm): boolean {
  if (spec.swing) {
    const arc = Math.abs(spec.swing.rest - spec.swing.end);
    return arm.phase === "strike" || (arm.phase === "recover" && Math.abs(arm.swing - spec.swing.rest) > LASH_LIT * arc);
  }
  if (spec.thrust) return arm.phase !== "recover";
  return false;
}
