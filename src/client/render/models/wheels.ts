import type * as B from "../../babylon";
import type { WheelType, WheelTypeDef } from "../../../shared/catalog/wheels";
import type { ModelKit, WheelModel } from "../modelKit";

/*
 * Modèles 3D des roues (fixes, directrices, roulettes) : un pneu à crampons en chevrons, ses flancs
 * arrondis, une jante à rayons, ses écrous et son cache-moyeu, des deux côtés (une même roue se
 * monte à gauche comme à droite). L'essieu est le long de x ; la roue tourne autour de lui : les
 * crampons et les rayons font voir qu'elle roule. Une roue directrice a sa jante orange (on la
 * distingue d'une fixe au premier coup d'œil), une lourde des crampons profonds et une couronne de
 * talon, une roulette un bandage lisse sur un moyeu de fonte.
 */

const RUBBER = "#1f2225";
const LUG = "#2a2e32";
const WALL = "#2d3135";
const STEER = "#e2703a";

interface Style {
  /** Couleurs de la jante et de ses détails (écrous, cache-moyeu). */
  rim: string;
  trim: string;
  /** Part du rayon qu'occupe la jante. */
  rimShare: number;
  spokes: number;
  nuts: number;
  /** Crampons : leur profondeur (m) et leur pas sur la bande de roulement (m) ; 0 : bandage lisse. */
  lug: number;
  pitch: number;
  /** Couronne de talon (roue lourde, tout-terrain). */
  beadlock?: boolean;
}

/** Une pièce couchée le long de x (axe de la roue), centrée en (x, 0, 0). */
const axial = (kit: ModelKit, color: string, length: number, diameter: number, x = 0, tess = 20): B.Mesh =>
  kit.cylinder(color, length, diameter, diameter, [x, 0, 0], "x", tess);

function roadWheel(style: Style): WheelModel {
  return (kit, def, name) => kit.fuse(wheelParts(kit, def, style), name, { specular: 0.25 });
}

function wheelParts(kit: ModelKit, def: WheelTypeDef, s: Style): B.Mesh[] {
  const { radius: r, width: w } = def;
  const parts: B.Mesh[] = [];
  // Le pneu : la bande de roulement un peu en retrait (les crampons la dépassent), les flancs arrondis
  const tread = r - s.lug;
  parts.push(axial(kit, RUBBER, w * 0.9, tread * 2, 0, 28));
  for (const side of [-1, 1]) parts.push(kit.ring(WALL, tread * 2 - w * 0.18, w * 0.2, [side * w * 0.36, 0, 0], "x", 28));
  // Les crampons, en chevrons : deux rangées décalées d'un demi-pas (une pièce tournée de `a`
  // autour de l'essieu a son haut vers (0, cos a, sin a) : dressée sur la bande de roulement)
  if (s.lug > 0) {
    const count = Math.max(10, Math.round((2 * Math.PI * r) / s.pitch));
    for (let i = 0; i < count; i++) {
      for (const side of [-1, 1]) {
        const a = ((i + (side > 0 ? 0.5 : 0)) / count) * Math.PI * 2;
        const at: [number, number, number] = [side * w * 0.22, Math.cos(a) * (r - s.lug / 2), Math.sin(a) * (r - s.lug / 2)];
        parts.push(kit.box(LUG, [w * 0.46, s.lug, s.pitch * 0.42], at, [a, 0, 0]));
      }
    }
  }
  // La jante, de part en part, et sur chaque face : son voile, ses rayons, ses écrous, le cache-moyeu
  const rim = r * s.rimShare;
  parts.push(axial(kit, s.rim, w * 0.92, rim * 2, 0, 20));
  for (const side of [-1, 1]) {
    const face = side * (w * 0.46);
    parts.push(kit.ring(s.trim, rim * 2, 0.03, [face, 0, 0], "x", 20));
    parts.push(axial(kit, s.rim, 0.02, rim * 1.7, face + side * 0.005, 18));
    for (let i = 0; i < s.spokes; i++) {
      const a = (i / s.spokes) * Math.PI * 2;
      parts.push(kit.box(s.trim, [0.025, rim * 0.62, rim * 0.16], [face + side * 0.018, Math.cos(a) * rim * 0.52, Math.sin(a) * rim * 0.52], [a, 0, 0]));
    }
    for (let i = 0; i < s.nuts; i++) {
      const a = ((i + 0.5) / s.nuts) * Math.PI * 2;
      parts.push(kit.cylinder("#c9ced2", 0.03, rim * 0.12, rim * 0.12, [face + side * 0.022, Math.cos(a) * rim * 0.3, Math.sin(a) * rim * 0.3], "x", 6));
    }
    parts.push(axial(kit, s.trim, 0.05, rim * 0.34, face + side * 0.03, 12));
    if (s.beadlock) parts.push(kit.ring("#c9ced2", rim * 2.08, 0.035, [face + side * 0.01, 0, 0], "x", 24));
  }
  return parts;
}

const standard: Style = { rim: "#9aa6ad", trim: "#b9c3c9", rimShare: 0.56, spokes: 5, nuts: 5, lug: 0.035, pitch: 0.14 };
const small: Style = { rim: "#c9a045", trim: "#e0b64a", rimShare: 0.58, spokes: 4, nuts: 4, lug: 0.025, pitch: 0.11 };
const heavy: Style = { rim: "#66737a", trim: "#7d8a92", rimShare: 0.52, spokes: 6, nuts: 8, lug: 0.06, pitch: 0.19, beadlock: true };
/** Une directrice : la même roue, jante orange. */
const steered = (s: Style): Style => ({ ...s, rim: "#c45f2e", trim: STEER });

/** Roulette : un bandage lisse et bombé sur un moyeu de fonte, sans crampons. */
const caster: WheelModel = (kit, def, name) => {
  const { radius: r, width: w } = def;
  const parts: B.Mesh[] = [
    axial(kit, RUBBER, w * 0.8, r * 2 - 0.03, 0, 24),
    ...[-1, 1].map((side) => kit.ring(WALL, r * 2 - w * 0.25, w * 0.28, [side * w * 0.3, 0, 0], "x", 24)),
    axial(kit, "#b5bcc1", w * 0.95, r * 1.1, 0, 18),
    ...[-1, 1].flatMap((side) => [
      axial(kit, "#dfe4e7", 0.02, r * 0.9, side * w * 0.48, 16),
      axial(kit, "#5b6268", 0.06, r * 0.3, side * w * 0.5, 10),
    ]),
  ];
  return kit.fuse(parts, name, { specular: 0.3 });
};

export const WHEEL_MODELS: Partial<Record<WheelType, WheelModel>> = {
  standard: roadWheel(standard),
  steered: roadWheel(steered(standard)),
  small: roadWheel(small),
  smallSteered: roadWheel(steered(small)),
  heavy: roadWheel(heavy),
  heavySteered: roadWheel(steered(heavy)),
  caster,
};
