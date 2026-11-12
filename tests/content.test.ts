import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { MELEE_WEAPONS } from "../src/shared/catalog/melee";
import { PROP_TYPES } from "../src/shared/catalog/props";
import { SHAPE_IDS, shapeFraction } from "../src/shared/catalog/shapes";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { WHEEL_TYPES } from "../src/shared/catalog/wheels";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { validateDesign } from "../src/shared/design/robotDesign";
import { catalogData, catalogSchema } from "../tools/schemas/catalog";
import { unsupportedKeywords, validateSchema } from "./jsonSchema";

/*
 * Le catalogue du jeu en données ouvertes (content/catalog.json, fait par tools/schemas/catalog.ts ;
 * tests/schemas.test.ts vérifie que les fichiers livrés sont à jour) : il suit son schéma sans un
 * champ que le schéma ignore, chaque champ du schéma a sa description, il a toutes les entrées des
 * catalogues du code avec leurs valeurs, leurs noms dans les deux langues, et les robots prédéfinis
 * avec leurs plans jouables.
 */

const SCHEMA = catalogSchema();
const DATA = JSON.parse(readFileSync(new URL("../content/catalog.json", import.meta.url), "utf8")) as Record<string, Record<string, Record<string, unknown>>>;

/**
 * Les sous-schémas sans description (un champ d'un objet, une définition), avec leur chemin. Les
 * contraintes (une branche d'`anyOf` qui ne fait que restreindre des champs déjà décrits, sans
 * `type`) ne décrivent pas de champ.
 */
function undocumented(schema: unknown, path = "#"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  for (const group of s.type === "object" ? ["properties", "$defs"] : ["$defs"]) {
    const named = s[group];
    if (named && typeof named === "object") {
      for (const [name, sub] of Object.entries(named)) {
        const subSchema = sub as Record<string, unknown>;
        if (typeof subSchema.description !== "string" && typeof subSchema.$ref !== "string" && !("const" in subSchema)) out.push(`${path}/${group}/${name}`);
        out.push(...undocumented(sub, `${path}/${group}/${name}`));
      }
    }
  }
  for (const key of ["items", "additionalProperties"]) out.push(...undocumented(s[key], `${path}/${key}`));
  for (const key of ["anyOf", "oneOf"]) if (Array.isArray(s[key])) (s[key] as unknown[]).forEach((sub, i) => out.push(...undocumented(sub, `${path}/${key}/${i}`)));
  return out;
}

describe("catalogue du jeu en données ouvertes (content/)", () => {
  it("le catalogue suit son schéma, sans champ que le schéma ignore ; le schéma n'emploie que des mots-clés connus", () => {
    expect(unsupportedKeywords(SCHEMA)).toEqual([]);
    expect(validateSchema(SCHEMA, DATA, { unknownProperties: true })).toEqual([]);
    expect(validateSchema(SCHEMA, catalogData(), { unknownProperties: true })).toEqual([]);
  });

  it("chaque champ du schéma a sa description (en anglais)", () => {
    expect(undocumented(SCHEMA)).toEqual([]);
  });

  it("toutes les entrées des catalogues du code, avec leurs valeurs et leurs noms dans les deux langues", () => {
    const sections = { blocks: BLOCK_TYPES, wheels: WHEEL_TYPES, weapons: WEAPONS, melee: MELEE_WEAPONS, props: PROP_TYPES } as const;
    for (const [section, catalog] of Object.entries(sections)) {
      expect(Object.keys(DATA[section]), section).toEqual(Object.keys(catalog));
      for (const [id, entry] of Object.entries(DATA[section])) {
        const names = entry.names as { fr: string; en: string };
        expect(names.fr.length && names.en.length, `${section}.${id}`).toBeTruthy();
      }
    }
    expect(DATA.blocks.armorHeavy.hp).toBe(BLOCK_TYPES.armorHeavy.hp);
    expect(DATA.blocks.armorHeavy.names).toEqual({ fr: "Blindage lourd", en: "Heavy armor" });
    expect(DATA.blocks.jet.thruster).toEqual(JSON.parse(JSON.stringify(BLOCK_TYPES.jet.thruster)));
    expect(DATA.weapons.cannon.projectile).toEqual(JSON.parse(JSON.stringify(WEAPONS.cannon.projectile)));
    expect(DATA.melee.saw.bite).toEqual(MELEE_WEAPONS.saw.bite);
    expect(DATA.props.crate.shape).toEqual(PROP_TYPES.crate.shape);
    expect(DATA.wheels.track.kind).toBe("track");
    expect(DATA.wheels.heavySteered.price).toBeGreaterThan(0);
    // Un nombre infini (l'ogive ne se recharge jamais) devient null
    expect((DATA.weapons.warhead.ammo as { reload: unknown }).reload).toBeNull();
    // Les formes : leur part du cube, et des sommets dans le cube de demi-côté 1
    expect(Object.keys(DATA.shapes)).toEqual(SHAPE_IDS);
    expect(DATA.shapes.wedge.fraction).toBeCloseTo(shapeFraction("wedge"), 6);
    const points = (DATA.shapes.innerCorner.pieces as { faces: { points: number[][] }[] }[]).flatMap((p) => p.faces.flatMap((f) => f.points));
    expect(points.every((p) => p.every((c) => Math.abs(c) <= 1 + 1e-9))).toBe(true);
  });

  it("les robots prédéfinis : leurs noms, leur description, leur plan jouable", () => {
    expect(Object.keys(DATA.robots)).toEqual(PRESET_BOTS.map((b) => b.id));
    for (const bot of PRESET_BOTS) {
      const entry = DATA.robots[bot.id];
      expect(entry.design).toEqual(JSON.parse(JSON.stringify(bot.design)));
      expect(validateDesign(entry.design as typeof bot.design), bot.id).toEqual([]);
      expect((entry.traits as { en: string }).en.length).toBeGreaterThan(0);
    }
    expect(DATA.robots.scarab.names).toEqual({ fr: "Scarabée", en: "Scarab" });
  });
});
