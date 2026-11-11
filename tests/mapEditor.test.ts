import { describe, expect, it } from "vitest";
import {
  addElement, applyBrush, blankMap, brushRegion, centerOf, checkMap, duplicateElements, elementsOf, fieldApplies, fieldHeight, fieldOf, FORMS, formOf, getElement,
  issueTarget, MAP_LIMITS, MapHistory, moveElements, movePoint, normalAngle, PALETTE, readMap, refAfterRemoval, removeElements, rotateElements, setElement,
  spawnsOf, terrainOfField, traceElement, TRACE_KINDS, withField, type ElementList, type ElementRef, type FieldSpec, type FormId, type HeightField,
  type MapElement, type MapFile, type MapProp, type Placed,
} from "../src/shared/map";

/*
 * La logique de l'éditeur de cartes, sans navigateur : les pinceaux du relief, les opérations
 * d'édition (poser, déplacer, tourner, dupliquer, supprimer, avec les appuis et les bâtiments des
 * accessoires), l'historique d'annulation, la palette (chaque élément posé avec ses valeurs par
 * défaut donne une carte lisible) et les formulaires (leurs bornes sont celles de la lecture).
 */

const base = (): MapFile => blankMap({ name: "Éditeur", author: "Tests", half: 70 });

/** Un champ plat de `cells` cases de 2 m, à `level` m. */
function flatField(cells = 40, level = 5): HeightField {
  return { cells, step: 2, heights: new Float32Array((cells + 1) * (cells + 1)).fill(level) };
}
const at = (f: HeightField, x: number, z: number): number => {
  const half = (f.cells * f.step) / 2;
  return f.heights[Math.round((x + half) / f.step) * (f.cells + 1) + Math.round((z + half) / f.step)];
};

describe("éditeur de cartes : pinceaux du relief", () => {
  it("monter : le centre monte le plus, rien ne bouge hors du rayon", () => {
    const f = flatField();
    const region = applyBrush(f, { kind: "raise", radius: 8, strength: 1 }, 0, 0, 0.5);
    expect(region).not.toBeNull();
    expect(at(f, 0, 0)).toBeCloseTo(5 + 6 * 0.5, 5);
    expect(at(f, 4, 0)).toBeGreaterThan(5);
    expect(at(f, 4, 0)).toBeLessThan(at(f, 0, 0));
    expect(at(f, 10, 0)).toBe(5);
    expect(at(f, 0, -10)).toBe(5);
    // La zone rendue couvre le disque, sans plus
    expect(region).toEqual(brushRegion(f, 0, 0, 8));
    expect(region!.ix1 - region!.ix0).toBe(8);
  });

  it("creuser : jamais sous la hauteur la plus basse permise", () => {
    const f = flatField(40, 1);
    for (let i = 0; i < 20; i++) applyBrush(f, { kind: "lower", radius: 6, strength: 1 }, 0, 0, 0.2);
    expect(at(f, 0, 0)).toBe(MAP_LIMITS.minHeight);
  });

  it("lisser : une pointe s'efface, le relief alentour bouge peu", () => {
    const f = flatField();
    const half = (f.cells * f.step) / 2;
    f.heights[Math.round(half / 2) * (f.cells + 1) + Math.round(half / 2)] = 15;
    const spike = at(f, 0, 0);
    expect(spike).toBe(15);
    for (let i = 0; i < 10; i++) applyBrush(f, { kind: "smooth", radius: 6, strength: 1 }, 0, 0, 0.1);
    expect(at(f, 0, 0)).toBeLessThan(7);
    expect(at(f, 0, 0)).toBeGreaterThan(5);
  });

  it("aplanir : à la hauteur choisie (ou cliquée), au centre d'abord", () => {
    const f = flatField(40, 3);
    applyBrush(f, { kind: "raise", radius: 14, strength: 1 }, 0, 0, 1);
    for (let i = 0; i < 40; i++) applyBrush(f, { kind: "flatten", radius: 10, strength: 1, height: 4 }, 0, 0, 0.1);
    expect(at(f, 0, 0)).toBeCloseTo(4, 2);
    // La hauteur cliquée : celle du sol sous le pinceau au début du coup
    const g = flatField(40, 2);
    applyBrush(g, { kind: "raise", radius: 20, strength: 1 }, 10, 0, 1);
    const clicked = fieldHeight(g, 0, 0);
    for (let i = 0; i < 30; i++) applyBrush(g, { kind: "level", radius: 8, strength: 1, height: clicked }, 4, 0, 0.1);
    expect(at(g, 4, 0)).toBeCloseTo(clicked, 1);
  });

  it("hors du relief : rien", () => {
    const f = flatField();
    expect(applyBrush(f, { kind: "raise", radius: 5, strength: 1 }, 500, 0, 1)).toBeNull();
    expect(applyBrush(f, { kind: "raise", radius: 5, strength: 0 }, 0, 0, 1)).toBeNull();
  });

  it("le champ d'une carte et retour : au millimètre près", () => {
    const map = base();
    const f = fieldOf(map.terrain!)!;
    applyBrush(f, { kind: "raise", radius: 20, strength: 1 }, 10, 10, 1);
    const terrain = terrainOfField(f);
    const back = fieldOf(terrain)!;
    let worst = 0;
    for (let i = 0; i < f.heights.length; i++) worst = Math.max(worst, Math.abs(back.heights[i] - f.heights[i]));
    expect(worst).toBeLessThan(0.002);
    expect(checkMap({ ...map, terrain }).issues).toEqual([]);
  });
});

/** Une petite maison à la main : deux murs (rangs 0 et 1), un toit qui repose sur eux (2), du même bâtiment, et une caisse (3). */
function withBuilding(): MapFile {
  const props: MapProp[] = [
    { type: "brick", x: 20, z: 20, size: [4, 3, 0.3], group: 3 },
    { type: "brick", x: 20, z: 24, size: [4, 3, 0.3], group: 3 },
    { type: "roof", x: 20, z: 22, y: 3, size: [5, 0.15, 5], rests: [0, 1], group: 3 },
    { type: "crate", x: 30, z: 30 },
  ];
  return { ...base(), props };
}

describe("éditeur de cartes : opérations", () => {
  it("poser, remplacer, relire", () => {
    const { map, ref } = addElement(base(), "boxes", { kind: "pillar", x: 10, z: 12, size: [1, 3, 1] });
    expect(ref).toEqual({ list: "boxes", index: 0 });
    expect(getElement(map, ref)).toMatchObject({ x: 10, z: 12 });
    const moved = setElement(map, ref, { kind: "pillar", x: 1, z: 2, size: [1, 3, 1] });
    expect(getElement(moved, ref)).toMatchObject({ x: 1, z: 2 });
    // La carte d'avant n'a pas changé, et ce qui ne change pas est partagé
    expect(getElement(map, ref)).toMatchObject({ x: 10 });
    expect(moved.terrain).toBe(map.terrain);
  });

  it("déplacer : une position, les points d'une clôture, les deux bouts d'un pont", () => {
    let map = base();
    map = addElement(map, "boxes", { kind: "pillar", x: 10, z: 12, size: [1, 3, 1] }).map;
    map = addElement(map, "prefabs", { kind: "fence", points: [[0, 0], [10, 0]] }).map;
    map = addElement(map, "prefabs", { kind: "bridge", from: [0, -5], to: [0, 5], width: 6 }).map;
    const refs: ElementRef[] = [{ list: "boxes", index: 0 }, { list: "prefabs", index: 0 }, { list: "prefabs", index: 1 }];
    const out = moveElements(map, refs, 3, -2);
    expect(getElement(out, refs[0])).toMatchObject({ x: 13, z: 10 });
    expect(getElement(out, refs[1])).toMatchObject({ points: [[3, -2], [13, -2]] });
    expect(getElement(out, refs[2])).toMatchObject({ from: [3, -7], to: [3, 3] });
    expect(out.terrain).toBe(map.terrain);
    expect(out.zones).toBe(map.zones);
    // Un point d'un tracé, un bout du pont
    expect(getElement(movePoint(out, refs[1], 1, 20, 4), refs[1])).toMatchObject({ points: [[3, -2], [20, 4]] });
    expect(getElement(movePoint(out, refs[2], 0, -1, -9), refs[2])).toMatchObject({ from: [-1, -9], to: [3, 3] });
  });

  it("tourner : un élément sur lui-même, plusieurs autour de leur centre", () => {
    let map = base();
    map = addElement(map, "boxes", { kind: "wall", x: 10, z: 0, size: [8, 3, 0.6] }).map;
    map = addElement(map, "props", { type: "crate", x: -10, z: 0 }).map;
    map = addElement(map, "falls", { x: 0, z: 30, top: 8, bottom: 2, width: 4, dir: 170 }).map;
    const wall: ElementRef = { list: "boxes", index: 0 };
    const crate: ElementRef = { list: "props", index: 0 };
    const one = rotateElements(map, [wall], 30);
    expect(getElement(one, wall)).toMatchObject({ x: 10, z: 0, yaw: 30 });
    // Une cascade tourne sa direction (ramenée à ]-180, 180])
    expect(getElement(rotateElements(map, [{ list: "falls", index: 0 }], 30), { list: "falls", index: 0 })).toMatchObject({ dir: -160 });
    // Deux éléments : autour de leur centre (0, 0) ; 90 tourne le nord (+z) vers l'ouest (+x)
    const both = rotateElements(map, [wall, crate], 90);
    const w = getElement(both, wall) as { x: number; z: number; yaw: number };
    expect(w.x).toBeCloseTo(0);
    expect(w.z).toBeCloseTo(-10);
    expect(w.yaw).toBe(90);
    expect(centerOf(both, [wall, crate])).toEqual(centerOf(map, [wall, crate]));
    expect(normalAngle(-190)).toBe(170);
    expect(normalAngle(540)).toBe(180);
  });

  it("dupliquer : les appuis d'un toit et le bâtiment suivent les copies", () => {
    const map = withBuilding();
    const refs: ElementRef[] = [0, 1, 2].map((index) => ({ list: "props", index }));
    const { map: out, refs: copies } = duplicateElements(map, refs, 10, 0);
    expect(copies.map((r) => r.index)).toEqual([4, 5, 6]);
    const props = out.props!;
    expect(props[6]).toMatchObject({ type: "roof", x: 30, rests: [4, 5], group: 4 });
    expect(props[4].group).toBe(4);
    // Le toit copié seul ne repose sur rien de copié : ses appuis sont oubliés
    const alone = duplicateElements(map, [{ list: "props", index: 2 }], 0, 10).map.props![4];
    expect(alone.rests).toBeUndefined();
    expect(readMap(out).ok).toBe(true);
  });

  it("supprimer : les rangs des appuis suivent, les lignes de départ restent", () => {
    const map = withBuilding();
    const one = removeElements(map, [{ list: "props", index: 0 }]);
    expect(one.props!.map((p) => p.type)).toEqual(["brick", "roof", "crate"]);
    expect(one.props![1].rests).toEqual([0]);
    const both = removeElements(map, [{ list: "props", index: 0 }, { list: "props", index: 1 }, { list: "spawns", index: 0 }]);
    expect(both.props![0].rests).toBeUndefined();
    expect(both.props!.length).toBe(2);
    expect(readMap(both).ok).toBe(true);
    // Une liste vidée disparaît (sauf les zones)
    expect(removeElements(both, [{ list: "props", index: 0 }, { list: "props", index: 1 }]).props).toBeUndefined();
    expect(refAfterRemoval({ list: "props", index: 3 }, [{ list: "props", index: 0 }])).toEqual({ list: "props", index: 2 });
    expect(refAfterRemoval({ list: "props", index: 0 }, [{ list: "props", index: 0 }])).toBeNull();
  });

  it("les lignes de départ : celles du nord et du sud tant qu'on n'y touche pas, puis les deux, placées", () => {
    const map = base();
    const lines = spawnsOf(map);
    expect(lines.blue).toEqual({ x: 0, z: -56, facing: 0, width: 42 });
    expect(lines.red).toMatchObject({ z: 56, facing: 180 });
    const moved = moveElements(map, [{ list: "spawns", index: 1 }], 10, -6);
    expect(moved.spawns).toEqual({ blue: lines.blue, red: { ...lines.red, x: 10, z: 50 } });
    const turned = rotateElements(moved, [{ list: "spawns", index: 0 }], 45);
    expect(turned.spawns!.blue.facing).toBe(45);
    // De biais, la ligne des bleus déborde de la zone de jeu ; plus près du centre, elle y tient
    expect(checkMap(turned).issues).toEqual([{ code: "spawnOutside", team: "blue" }]);
    expect(checkMap(moveElements(turned, [{ list: "spawns", index: 0 }], 0, 15)).issues).toEqual([]);
    // Les lignes ne se dupliquent pas
    expect(duplicateElements(map, [{ list: "spawns", index: 0 }], 5, 5).refs).toEqual([]);
  });

  it("où est un problème : l'élément en cause, ou la ligne de départ", () => {
    const map = withBuilding();
    expect(issueTarget(map, { code: "field", path: "props[1].size" })).toEqual({ ref: { list: "props", index: 1 }, at: [20, 24] });
    expect(issueTarget(map, { code: "zoneUnreachable", zone: "B" })).toEqual({ ref: { list: "zones", index: 1 }, at: [0, 0] });
    expect(issueTarget(map, { code: "spawnBlocked", team: "red" })).toEqual({ ref: { list: "spawns", index: 1 }, at: [0, 56] });
    expect(issueTarget(map, { code: "json" })).toBeNull();
  });
});

describe("éditeur de cartes : historique", () => {
  it("annuler, rétablir ; une nouvelle modification efface ce qu'on pouvait rétablir", () => {
    const a = base();
    const h = new MapHistory(a);
    const b = addElement(a, "props", { type: "crate", x: 1, z: 1 }).map;
    const c = addElement(b, "props", { type: "crate", x: 2, z: 2 }).map;
    h.push(b);
    h.push(c);
    expect(h.undo()).toBe(b);
    expect(h.undo()).toBe(a);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe(b);
    const d = addElement(b, "props", { type: "barrel", x: 3, z: 3 }).map;
    h.push(d);
    expect(h.canRedo).toBe(false);
    expect(h.current).toBe(d);
    expect(h.depth).toEqual({ undo: 2, redo: 0 });
  });

  it("au plus tant de modifications, et tant d'octets de reliefs : les plus anciennes s'en vont", () => {
    const a = base();
    const h = new MapHistory(a, 5, 1e9);
    let m = a;
    for (let i = 0; i < 9; i++) h.push((m = addElement(m, "props", { type: "crate", x: i, z: 0 }).map));
    expect(h.depth.undo).toBe(5);
    // Chaque coup de pinceau fait un nouveau relief : le budget en garde peu
    const size = a.terrain!.heights.length;
    const small = new MapHistory(a, 100, size * 3.5);
    const f = fieldOf(a.terrain!)!;
    for (let i = 0; i < 6; i++) {
      applyBrush(f, { kind: "raise", radius: 10, strength: 1 }, i * 5, 0, 0.2);
      small.push({ ...small.current, terrain: terrainOfField(f) });
    }
    expect(small.bytes).toBeLessThanOrEqual(size * 3.5);
    expect(small.depth.undo).toBe(2);
  });
});

/** Un exemple de chaque formulaire : posé d'après la palette (ou tracé), sur une carte de départ. */
function samples(): { map: MapFile; list: ElementList; index: number; form: FormId }[] {
  const out: { map: MapFile; list: ElementList; index: number; form: FormId }[] = [];
  const map = base();
  const ctx = { x: 20, z: 15, yaw: 30, map, ground: () => 2, placeName: "Ferme" };
  const placed: Placed[] = [
    ...PALETTE.filter((e) => e.make).map((e) => e.make!(ctx)!),
    ...TRACE_KINDS.map((k) => traceElement(k, [[10, 10], [20, 12], [30, 10]])!),
  ];
  for (const p of placed) {
    const { map: m, ref } = addElement(map, p.list, p.element);
    out.push({ map: m, list: ref.list, index: ref.index, form: formOf(ref.list, p.element) });
  }
  out.push({ map, list: "spawns", index: 0, form: "spawn" });
  return out;
}

describe("éditeur de cartes : palette et formulaires", () => {
  it("chaque élément de la palette, posé avec ses valeurs par défaut, donne une carte qui se lit et se joue", () => {
    for (const s of samples()) {
      const e = elementsOf(s.map, s.list)[s.index];
      const check = checkMap(s.map);
      expect(check.issues, `${s.form} ${JSON.stringify(e)}`).toEqual([]);
    }
    // Chaque formulaire a son exemple
    expect(new Set(samples().map((s) => s.form))).toEqual(new Set(Object.keys(FORMS)));
  });

  it("une sixième zone ne se pose pas ; un tracé d'un seul point non plus", () => {
    let map = base();
    const zone = PALETTE.find((e) => e.id === "zone")!;
    for (let i = 0; i < 2; i++) {
      const p = zone.make!({ x: i * 10, z: 30, yaw: 0, map, ground: () => 0 })!;
      map = addElement(map, p.list, p.element).map;
    }
    expect(map.zones.map((z) => z.label)).toEqual(["A", "B", "C", "D", "E"]);
    expect(zone.make!({ x: 0, z: 0, yaw: 0, map, ground: () => 0 })).toBeNull();
    expect(traceElement("path", [[0, 0]])).toBeNull();
    expect(traceElement("bridge", [[0, 0], [0, 10], [0, 20]])).toMatchObject({ element: { from: [0, 0], to: [0, 10] } });
  });

  it("les bornes de chaque champ sont celles de la lecture : chaque valeur extrême donne une carte lisible", () => {
    const values = (f: FieldSpec): readonly unknown[] => {
      switch (f.type) {
        case "number": return f.optional ? [f.min, f.max, undefined] : [f.min, f.max];
        case "angle": return [-179.5, 180, 0];
        case "choice": return f.optional ? [...f.options, undefined] : f.options;
        case "bool": return [true, false];
        case "size": return [[f.min, f.min, f.min], [f.max, f.max, f.max]];
        case "range": return [[f.min, f.max], [f.min, f.min], ...(f.optional ? [undefined] : [])];
        case "text": return ["a", "x".repeat(f.max)];
        case "trees": return [["pine"], ["oak", "palm", "kapok", "cactus"], undefined];
      }
    };
    let checked = 0;
    for (const s of samples()) {
      const e = elementsOf(s.map, s.list)[s.index] as MapElement;
      for (const field of FORMS[s.form]) {
        if (!fieldApplies(s.form, field, e)) continue;
        for (const v of values(field)) {
          // (une cascade : son haut reste au-dessus de son bas ; on ne la met pas tout en bas, ou tout en haut)
          if (s.form === "fall" && ((field.key === "top" && v === MAP_LIMITS.minY) || (field.key === "bottom" && v === MAP_LIMITS.maxY))) continue;
          let changed = withField(e, field, v);
          if (s.form === "fall" && field.key === "bottom") changed = { ...changed, top: Math.min(MAP_LIMITS.maxY, (v as number) + 1) } as MapElement;
          if (s.form === "fall" && field.key === "top") changed = { ...changed, bottom: Math.max(MAP_LIMITS.minY, (v as number) - 1) } as MapElement;
          const map = setElement(s.map, { list: s.list, index: s.index }, changed);
          const read = readMap(map);
          expect(read.ok, `${s.form}.${field.key} = ${JSON.stringify(v)} : ${read.ok ? "" : JSON.stringify(read.issues)}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("un champ facultatif remis à sa valeur par défaut disparaît de la carte", () => {
    const e: MapElement = { kind: "bridge", from: [0, 0], to: [0, 10], width: 6 };
    const parapets = FORMS.bridge.find((f) => f.key === "parapets")!;
    expect(withField(e, parapets, false)).toMatchObject({ parapets: false });
    expect("parapets" in withField({ ...e, parapets: false }, parapets, true)).toBe(false);
    const yaw = FORMS.house.find((f) => f.key === "yaw")!;
    expect("yaw" in withField({ kind: "house", x: 0, z: 0, width: 5, depth: 5, height: 3, wall: "brick", roof: "roof", yaw: 20 }, yaw, 0)).toBe(false);
  });
});
