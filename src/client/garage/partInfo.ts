import { blockDef, blockShape, BLOCK_TYPES, type BlockType } from "../../shared/catalog/blocks";
import type { ShapeId } from "../../shared/catalog/shapes";
import { weaponDef, type DamageType, type Weapon } from "../../shared/catalog/weapons";
import {
  biteDps, biteSpeed, biteTorque, flailEnergy, flailOrbit, flailPower, holdPower, isBit, meleeDef, meleeReach, motorPower, spinEnergy,
  type MeleeId, type MeleeSpec,
} from "../../shared/catalog/melee";
import { WHEEL_TYPES, wheelDef, wheelKind, type WheelKind, type WheelType } from "../../shared/catalog/wheels";
import type { Part } from "../../shared/design/progression";
import { fullJetLength, jetSize } from "../../shared/robot/exhaust";
import { fold, num, pct } from "../i18n/format";
import { measure, t, tMaybe, type MessageKey } from "../i18n/i18n";
import { damageWord, meleeName, partName, weaponName } from "../i18n/names";
import { keyLabel } from "../input/bindings";

/*
 * Ce que l'inventaire du garage sait de chaque pièce : sa catégorie, de quoi la retrouver par une
 * recherche, et sa fiche (une phrase qui dit à quoi elle sert, puis ses caractéristiques). Tout se
 * déduit des catalogues : une pièce nouvelle y trouve sa place d'elle-même. Les textes sont dans la
 * langue affichée (i18n/locales/<langue>/parts.ts : résumés `parts.summary.*`, `parts.melee.*`…,
 * libellés `parts.stat.*`, valeurs `parts.value.*`).
 */

/** Catégories de l'inventaire, dans l'ordre des onglets (leur nom : `partCategory.<id>`). */
export const CATEGORIES = [
  "structure", "shapes", "control", "propulsion", "wings", "weapons", "equipment", "wheels", "tracks",
] as const;
export type Category = (typeof CATEGORIES)[number];
/** Nom d'une catégorie de l'inventaire, dans la langue affichée. */
export const categoryName = (category: Category): string => t(`partCategory.${category}`);

/** Sous-groupes d'une catégorie (une ligne de titre dans la grille ; leur nom : `partGroup.<id>`). */
export type PartGroup =
  | "fixed" | "steered" | "casters" | "melee" | "dropped" | "mines" | "support" | "guided" | "explosive" | "direct"
  | "wedges" | "corners" | "innerCorners" | "rounds" | "roundCorners" | "slopes" | "slabs";
/** Nom d'un sous-groupe, dans la langue affichée. */
export const groupName = (group: PartGroup): string => t(`partGroup.${group}`);

/** Toutes les pièces : les blocs, puis les roues (fixes, directrices, roulettes, galets). */
export function allParts(): Part[] {
  const blocks = (Object.keys(BLOCK_TYPES) as BlockType[]).map((type): Part => ({ kind: "block", type }));
  const order: WheelKind[] = ["fixed", "steered", "caster", "track"];
  const wheels = (Object.keys(WHEEL_TYPES) as WheelType[])
    .map((type): Part => ({ kind: "wheel", type }))
    .sort((a, b) => order.indexOf(wheelKind(wheelDef(a.type as WheelType))) - order.indexOf(wheelKind(wheelDef(b.type as WheelType))));
  return [...blocks, ...wheels];
}

export const samePart = (a: Part, b: Part): boolean => a.kind === b.kind && a.type === b.type;

/** Catégorie d'une pièce, d'après ce qu'elle fait. */
export function partCategory(part: Part): Category {
  if (part.kind === "wheel") return wheelDef(part.type).track ? "tracks" : "wheels";
  const type = part.type;
  const d = blockDef(type);
  if (type === "cockpit") return "control";
  // (une hélice tranche ce qu'elle frôle, mais c'est d'abord un moteur)
  if (d.turret || (d.melee && !d.thruster)) return "weapons";
  if (d.thruster || d.support) return "propulsion";
  if (d.aero) return "wings";
  if (d.battery || d.repair || d.shield || d.radar || d.jammer || d.flares || d.light) return "equipment";
  if (blockShape(type)) return "shapes";
  return "structure";
}

/** La phrase de fiche de chaque lumière de robot. */
const LIGHT_SUMMARIES = {
  headlight: "parts.summary.headlight", beacon: "parts.summary.beacon", navLight: "parts.summary.navLight", strobe: "parts.summary.strobe",
  antiCollision: "parts.summary.antiCollision", rotatingLight: "parts.summary.rotatingLight", policeBar: "parts.summary.policeBar",
} as const satisfies Partial<Record<BlockType, MessageKey>>;

/** Sous-groupe d'une pièce dans sa catégorie (une ligne de titre dans la grille), ou null. */
export function partGroup(part: Part): PartGroup | null {
  if (part.kind === "wheel") {
    const kind = wheelKind(wheelDef(part.type));
    return kind === "fixed" ? "fixed" : kind === "steered" ? "steered" : kind === "caster" ? "casters" : null;
  }
  const d = blockDef(part.type);
  if (d.melee && !d.thruster) return "melee";
  if (d.turret) return d.turret.fixed ? (d.turret.fixed === "down" ? "dropped" : "mines") : weaponGroup(weaponDef(d.turret.weapon));
  const shape = blockShape(part.type);
  if (shape) return SHAPE_GROUPS[shape];
  return null;
}

/** Famille d'une arme de tourelle (un titre dans la catégorie Armes). */
function weaponGroup(w: Weapon): PartGroup {
  const p = w.projectile;
  if (p.repair || p.barrier || p.decoy || w.autoSupport) return "support";
  if (p.guidance) return "guided";
  if (p.explosion || p.emp || p.smoke) return "explosive";
  return "direct";
}

/** Le sous-groupe des blocs de forme (les deux pentes vont ensemble). */
const SHAPE_GROUPS: Record<ShapeId, PartGroup> = {
  wedge: "wedges", corner: "corners", innerCorner: "innerCorners", round: "rounds", roundCorner: "roundCorners",
  slopeLow: "slopes", slopeHigh: "slopes", slab: "slabs",
};

/** Nom affiché d'une pièce. */
export { partName } from "../i18n/names";

/** Coût de construction d'une pièce (points du budget). */
export const partCost = (part: Part): number => (part.kind === "block" ? blockDef(part.type).cost : wheelDef(part.type).cost);

/** Texte sans accents ni majuscules (une recherche « helice » trouve « Hélice »). */
export { fold };

/** Tout ce qu'une recherche peut trouver d'une pièce, dans la langue affichée : son nom, sa catégorie, son groupe, sa fiche. */
export function partSearchText(part: Part): string {
  const info = partInfo(part);
  const group = partGroup(part);
  return fold([partName(part), categoryName(partCategory(part)), group ? groupName(group) : "", info.summary, ...info.stats.map(([k, v]) => `${k} ${v}`)].join(" "));
}

/** La pièce répond-elle à la recherche ? Chaque mot doit s'y trouver. */
export function matchesSearch(part: Part, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = partSearchText(part);
  return words.every((w) => text.includes(w));
}

/** Fiche d'une pièce : à quoi elle sert (une phrase), et ses caractéristiques (libellé, valeur). */
export interface PartInfo {
  summary: string;
  stats: [string, string][];
}

/** Libellé d'une caractéristique, dans la langue affichée. */
const stat = (id: StatId): string => t(`parts.stat.${id}`);
type StatId = MessageKey extends infer K ? (K extends `parts.stat.${infer S}` ? S : never) : never;

/** Une nature de dégâts et sa traduction (« balles »), pour les valeurs « 120 dégâts (feu) ». */
const kindOf = (type: DamageType): string => damageWord(type);

export function partInfo(part: Part): PartInfo {
  return part.kind === "block" ? blockInfo(part.type) : wheelInfo(part.type);
}

function blockInfo(type: BlockType): PartInfo {
  const d = blockDef(type);
  const stats: [string, string][] = [
    [stat("cost"), measure(d.cost, "pts")], [stat("mass"), measure(d.mass, "kg", 2)], [stat("structure"), measure(d.hp, "hp")],
  ];
  const resist = d.resist ?? {};
  const strong = (Object.entries(resist) as [DamageType, number][]).filter(([, k]) => k <= 0.5).map(([type]) => kindOf(type));
  const weak = (Object.entries(resist) as [DamageType, number][]).filter(([, k]) => k >= 1.5).map(([type]) => kindOf(type));
  if (strong.length) stats.push([stat("resists"), strong.join(", ")]);
  if (weak.length) stats.push([stat("weakTo"), weak.join(", ")]);

  if (type === "cockpit") return { summary: t("parts.summary.cockpit"), stats };
  if (d.turret) return { summary: turretSummary(d.turret.weapon, d.turret.fixed), stats: [...stats, ...weaponStats(weaponDef(d.turret.weapon))] };
  if (d.melee && !d.thruster) return { summary: meleeSummary(d.melee), stats: [...stats, ...meleeStats(meleeDef(d.melee))] };
  if (d.thruster) {
    const th = d.thruster;
    const what = t(`parts.thruster.${th.look ?? "flame"}`);
    stats.push([stat("thrust"), measure(th.maxThrust, "N")], [stat("energy"), measure(th.power, "kW", 1)]);
    const sentences = [t("parts.thruster.summary", { what })];
    // Son jet de flamme brûle ce qui est derrière sa tuyère (robot/exhaust.ts), son propre robot compris ; un moteur
    // à flamme couché de côté fait tourner une hélice de rotor de queue
    if (th.exhaust) {
      sentences.push(t(th.look ? "parts.thruster.flameJet" : "parts.thruster.flameJetTail"));
      stats.push([stat("flameJet"), t("parts.value.flameJet", {
        length: measure(fullJetLength(th.exhaust), "m", 1), dps: measure(jetSize(th.exhaust, 1).dps, "dps"), kind: kindOf("fire"),
      })]);
    }
    // Une hélice tranchante (arme de contact menée par le moteur, combat/melee.ts)
    if (d.melee) {
      const m = meleeDef(d.melee);
      const full = spinEnergy(m.spin!, m.spin!.speed);
      sentences.push(t("parts.thruster.blades"));
      stats.push([stat("blades"), t("parts.value.blades", { damage: Math.round((full * m.hit.bite * m.hit.damage) / 1000), kind: kindOf(m.hit.damageType) })]);
    }
    return { summary: sentences.join(" "), stats };
  }
  if (d.support) {
    stats.push([stat("load"), measure(d.support.ratedLoad, "kg")]);
    return { summary: t(d.support.kind === "hover" ? "parts.summary.hoverPad" : "parts.summary.leg"), stats };
  }
  if (d.aero) {
    stats.push([stat("area"), measure(d.aero.area, "m2", 2)]);
    return { summary: t(d.aero.maxDeflection ? "parts.summary.flap" : "parts.summary.wing"), stats };
  }
  if (d.battery) return { summary: t("parts.summary.battery"), stats: [...stats, [stat("reserve"), measure(d.battery.capacity, "kJ")]] };
  if (d.repair) {
    return {
      summary: t("parts.summary.repairModule"),
      stats: [...stats, [stat("repair"), measure(d.repair.rate, "hpps")], [stat("radius"), measure(d.repair.radius, "m", 1)]],
    };
  }
  if (d.shield) {
    return { summary: t("parts.summary.shield"), stats: [...stats, [stat("absorbs"), pct(d.shield.absorb)], [stat("radius"), measure(d.shield.radius, "m", 1)]] };
  }
  if (d.radar) return { summary: t("parts.summary.radar"), stats: [...stats, [stat("range"), measure(d.radar.range, "m")]] };
  if (d.jammer) return { summary: t("parts.summary.jammer"), stats: [...stats, [stat("range"), measure(d.jammer.range, "m")]] };
  if (d.light) {
    const beam: [string, string][] = d.light.cone ? [[stat("beam"), measure(Math.round((d.light.cone * 180) / Math.PI), "deg")]] : [];
    const rhythm: [string, string][] = d.light.pattern !== "steady" ? [[stat("rhythm"), t(`parts.rhythm.${d.light.pattern}`)]] : [];
    const summary = (LIGHT_SUMMARIES as Partial<Record<BlockType, (typeof LIGHT_SUMMARIES)[keyof typeof LIGHT_SUMMARIES]>>)[type] ?? "parts.summary.beacon";
    return { summary: t(summary), stats: [...stats, [stat("range"), measure(d.light.range, "m")], ...beam, ...rhythm] };
  }
  if (d.flares) {
    return { summary: t("parts.summary.flareLauncher", { key: keyLabel("flares") }), stats: [...stats, [stat("salvos"), num(d.flares.charges)], [stat("reload"), measure(d.flares.reload, "s")]] };
  }
  const shape = blockShape(type);
  if (shape) return { summary: `${t(`parts.shape.${shape}`)} ${t("parts.shapeNote")}`, stats };
  if (type === "frame") return { summary: t("parts.summary.frame"), stats };
  if (type === "armorReactive") return { summary: t("parts.summary.armorReactive"), stats };
  const armor = d.hp >= 200 ? "parts.summary.armorHeavy" : d.hp >= 100 ? "parts.summary.armor" : "parts.summary.armorLight";
  return { summary: t(armor), stats };
}

/** Ce que fait une arme de contact (combat/melee.ts), en une phrase. */
function meleeSummary(id: MeleeId): string {
  const m = meleeDef(id);
  const name = meleeName(id);
  if (m.bite?.feed === "axial") return t("parts.melee.drill", { name });
  if (m.bite) return t("parts.melee.saw", { name });
  switch (m.look) {
    case "saber":
      return t("parts.melee.saber", { name });
    case "whip":
      return t("parts.melee.whip", { name });
    case "lance":
      return t("parts.melee.lance", { name });
    case "field":
      return t("parts.melee.field", { name });
    default:
      break;
  }
  if (m.motion === "spin" || m.motion === "driven") {
    // Ce que fait un rotor, et son gyroscope, selon son allure (les autres armes ont leur propre phrase)
    const gyro = tMaybe(`parts.meleeGyro.${m.look}`);
    return t("parts.melee.rotor", {
      name,
      says: tMaybe(`parts.meleeSays.${m.look}`) ?? "",
      gyro: gyro ? ` ${gyro}` : "",
      swept: t(m.look === "shell" ? "parts.melee.sweptShell" : "parts.melee.swept"),
    });
  }
  if (m.motion === "flip") return t("parts.melee.flip", { name });
  if (m.motion === "flail") return t("parts.melee.flail", { name });
  if (m.motion === "grip") return t("parts.melee.grip", { name });
  return t("parts.melee.hammer", { name });
}

/** Caractéristiques d'une arme de contact. */
function meleeStats(m: MeleeSpec): [string, string][] {
  const out: [string, string][] = [];
  const hit = m.hit;
  const kind = kindOf(hit.damageType);
  const kJ = (joules: number): string => measure(joules / 1000, "kJ", 1);
  const kW = (kw: number): string => measure(kw, "kW", 1);
  const s = (seconds: number, digits = 1): string => measure(seconds, "s", digits);
  if (m.field && m.spin) {
    const full = spinEnergy(m.spin, m.spin.speed);
    out.push([stat("charge"), t("parts.value.chargeField", { energy: kJ(full), time: s(m.spin.spinUp) })]);
    out.push([stat("contact"), t("parts.value.contact", {
      damage: Math.round((full * hit.bite * hit.damage) / 1000), kind, gap: s(hit.gap), n: m.field.contacts,
    })]);
    out.push([stat("covers"), t("parts.value.covers", { radius: measure(m.field.radius, "m", 1), margin: measure(m.field.margin * 100, "cm") })]);
    out.push([stat("enemySpinner"), t("parts.value.enemySpinner", { pct: pct(m.field.drain) })]);
    out.push([stat("batteries"), t("parts.value.batteriesField", { charge: kW(motorPower(m.spin)), hold: kW(holdPower(m.spin)) })]);
    return out;
  }
  if (m.spin && m.bite) {
    const held = biteSpeed(m.spin, m.bite);
    const rpm = (omega: number): number => Math.round((omega * 60) / (2 * Math.PI) / m.bite!.gear);
    const spin = { rpm: measure(rpm(m.spin.speed), "rpm"), time: s(m.spin.spinUp) };
    out.push([stat("spin"), m.bite.gear > 1 ? t("parts.value.spinGeared", { ...spin, gear: m.bite.gear }) : t("parts.value.spin", spin)]);
    out.push([stat("bite"), t("parts.value.bite", {
      full: Math.round(biteDps(m, m.spin.speed)), kind, held: Math.round(biteDps(m, held)), pct: pct(held / m.spin.speed),
    })]);
    out.push([stat("cut"), t("parts.value.cut", { power: kW(m.bite.power), depth: measure(m.bite.depth, "m", 1) })]);
    if (m.bite.gear > 1) out.push([stat("torque"), t("parts.value.torque", { torque: measure(Math.round(biteTorque(m.spin, m.bite) * m.bite.gear), "Nm") })]);
    if (m.bite.grab > 0) {
      const force = Math.round((m.bite.grab * biteTorque(m.spin, m.bite)) / (m.blade?.outer ?? 1));
      out.push([stat("grip"), t("parts.value.gripSaw", { force: measure(force, "N") })]);
    }
    out.push([stat("motor"), t("parts.value.motor", { power: kW(motorPower(m.spin)), hold: kW(holdPower(m.spin)) })]);
  } else if (m.spin) {
    const full = spinEnergy(m.spin, m.spin.speed);
    if (m.quench) {
      // Une lame d'énergie : sa charge, ce qu'elle tire des batteries, et ses coups rapprochés
      out.push([stat("charge"), t("parts.value.chargeBlade", { energy: kJ(full), time: s(m.spin.spinUp) })]);
      out.push([stat("cut"), t("parts.value.cutBlade", { damage: Math.round((full * hit.bite * hit.damage) / 1000), kind, gap: s(hit.gap, 2) })]);
      out.push([stat("batteries"), t("parts.value.batteriesBlade", { hold: kW(holdPower(m.spin)), power: kW(motorPower(m.spin)) })]);
    } else {
      out.push([stat("energy"), t("parts.value.energySpin", { energy: kJ(full) })]);
      out.push([stat("spin"), t("parts.value.spin", { rpm: measure(Math.round((m.spin.speed * 60) / (2 * Math.PI)), "rpm"), time: s(m.spin.spinUp) })]);
      out.push([stat("directHit"), t("parts.value.directHit", { damage: Math.round((full * hit.bite * hit.damage) / 1000), kind })]);
      out.push([stat("motor"), t("parts.value.motor", { power: kW(motorPower(m.spin)), hold: kW(holdPower(m.spin)) })]);
    }
  }
  if (m.swing) {
    out.push([stat("strike"), t("parts.value.strike", { energy: kJ(m.swing.energy), damage: Math.round((m.swing.energy * hit.damage) / 1000), kind })]);
    out.push([stat("rate"), t("parts.value.rateStrike", { time: s(m.swing.strike + m.swing.recover) })]);
    out.push([stat("energy"), t("parts.value.energyStrike", { energy: measure(m.swing.cost, "kJ", 1) })]);
  }
  if (m.plate) {
    out.push([stat("lift"), t("parts.value.lift", {
      energy: kJ(m.plate.energy), time: measure(Math.round(m.plate.strike * 1000), "ms"), damage: Math.round((m.plate.energy * hit.damage) / 1000), kind,
    })]);
    out.push([stat("reload"), t("parts.value.reloadLift", { time: s(m.plate.reload + m.plate.strike) })]);
    out.push([stat("energy"), t("parts.value.energyLift", { energy: measure(m.plate.cost, "kJ", 1) })]);
  }
  if (m.flail) {
    const full = flailEnergy(m.flail);
    const orbit = flailOrbit(m.flail);
    const speed = m.flail.speed * orbit.radius;
    out.push([stat("ball"), t("parts.value.ball", { mass: measure(m.flail.mass, "kg"), speed: measure(speed, "mps"), energy: kJ(full) })]);
    out.push([stat("blow"), t("parts.value.blow", { damage: Math.round((0.5 * m.flail.mass * speed * speed * hit.damage) / 1000), kind })]);
    out.push([stat("motor"), t("parts.value.motorFlail", { power: kW(flailPower(m.flail)), time: s(m.flail.spinUp) })]);
  }
  if (m.jaw) {
    out.push([stat("bite"), t("parts.value.biteJaw", { damage: m.jaw.bite, kind, crush: m.jaw.crush })]);
    out.push([stat("grip"), t("parts.value.gripJaw", { force: measure(m.jaw.strength / 1000, "kN", 1), time: s(m.jaw.hold, 0) })]);
    out.push([stat("energy"), t("parts.value.energyJaw", { power: kW(m.jaw.power) })]);
  }
  if (m.thrust) {
    out.push([stat("discharge"), t("parts.value.discharge", { damage: Math.round((m.thrust.energy * hit.damage) / 1000), kind })]);
    out.push([stat("rate"), t("parts.value.rateThrust", { time: s(m.thrust.strike + m.thrust.recover) })]);
    out.push([stat("energy"), t("parts.value.energyThrust", { energy: measure(m.thrust.cost, "kJ", 1) })]);
  }
  if (hit.ignite) out.push([stat("fire"), t("parts.value.fire", { pct: pct(hit.ignite) })]);
  if (hit.stun) out.push([stat("stun"), t("parts.value.stun", { radius: measure(hit.stun.radius, "m", 1), time: s(hit.stun.duration) })]);
  if (m.blade && isBit(m.blade)) {
    // Une mèche : son moyeu est au milieu de sa longueur ; sa pointe, plus loin du bloc
    const tip = Math.hypot(...m.hub) + m.blade.half;
    out.push([stat("range"), t("parts.value.rangeBit", { length: measure(2 * m.blade.half, "m", 1), tip: measure(tip, "m", 1) })]);
  } else {
    out.push([stat("range"), t("parts.value.rangeReach", { reach: measure(meleeReach(m), "m", 1) })]);
  }
  return out;
}

function turretSummary(id: Parameters<typeof weaponDef>[0], fixed: "back" | "down" | undefined): string {
  const w = weaponDef(id);
  const name = weaponName(id);
  const p = w.projectile;
  if (w.autoSupport) return t("parts.turret.autoSupport", { name });
  if (p.barrier) return t("parts.turret.barrier", { name });
  if (p.repair) return t("parts.turret.repair", { name });
  if (fixed === "down") return t("parts.turret.bombs", { name });
  if (fixed === "back" || p.mine) return t("parts.turret.mines", { name });
  if (w.lock) return t("parts.turret.lock", { name, time: measure(w.lock.time, "s", 1) });
  if (p.guidance?.mode === "piloted") return t("parts.turret.piloted", { name });
  if (p.guidance) return t("parts.turret.guided", { name });
  return t("parts.turret.aimed", { name });
}

function weaponStats(w: Weapon): [string, string][] {
  const p = w.projectile;
  const out: [string, string][] = [];
  const pellets = p.pellets?.count ?? 1;
  if (p.damage) out.push([stat("damage"), pellets > 1 ? t("parts.value.pellets", { pellets, damage: p.damage }) : num(p.damage)]);
  if (p.explosion) out.push([stat("explosion"), t("parts.value.explosion", { damage: p.explosion.damage, radius: measure(p.explosion.radius, "m", 1) })]);
  if (p.repair) {
    const amount = measure(p.repair.amount, "hp");
    out.push([stat("heal"), p.repair.swarm ? t("parts.value.healSwarm", { amount, n: p.repair.swarm }) : amount]);
  }
  if (p.barrier) {
    out.push([stat("wall"), t("parts.value.wall", {
      width: num(p.barrier.width, 1), height: measure(p.barrier.height, "m", 1), hp: measure(p.barrier.hp, "hp"), life: measure(p.barrier.life, "s"),
    })]);
  }
  if (w.range) out.push([stat("range"), measure(w.range, "m")]);
  out.push([stat("rate"), w.cooldown >= 1 ? t("parts.value.rateSlow", { time: measure(w.cooldown, "s", 1) }) : t("parts.value.rateFast", { rate: num(1 / w.cooldown, 1) })]);
  if (w.ammo) out.push([stat("magazine"), t("parts.value.magazine", { n: w.ammo.capacity })]);
  if (w.power) out.push([stat("energy"), t("parts.value.energyShot", { energy: measure(w.power, "kJ", 2) })]);
  return out;
}

function wheelInfo(type: WheelType): PartInfo {
  const d = wheelDef(type);
  const kind = wheelKind(d);
  const stats: [string, string][] = [
    [stat("cost"), measure(d.cost, "pts")], [stat("mass"), measure(d.mass, "kg", 1)], [stat("structure"), measure(d.hp, "hp")],
    [stat("diameter"), measure(d.radius * 2, "m", 2)], [stat("load"), measure(d.ratedLoad, "kg")], [stat("traction"), num(d.grip, 2)],
  ];
  if (d.steering) stats.push([stat("steering"), measure(Math.round((d.steering.maxAngle * 180) / Math.PI), "deg")]);
  return { summary: t(`parts.wheel.${kind}`), stats };
}
