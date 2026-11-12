import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLOCK_PRICES, BLOCK_TYPES, blockShape, type BlockType } from "../src/shared/catalog/blocks";
import { fileData } from "../src/shared/catalog/content";
import { MELEE_WEAPONS, type MeleeId } from "../src/shared/catalog/melee";
import { PROP_TYPES } from "../src/shared/catalog/props";
import { WEAPONS, type WeaponId } from "../src/shared/catalog/weapons";
import { steeredVariant, WHEEL_PRICES, WHEEL_TYPES, type WheelType } from "../src/shared/catalog/wheels";
import { CONTENT_FAMILY_IDS, familySchema, familySchemaRef, type ContentFamily } from "../tools/schemas/catalog";
import { undocumented, unsupportedKeywords, validateSchema } from "./jsonSchema";

/*
 * Les éléments du jeu en fichiers de données (content/<famille>/<id>.json, que lit le jeu : voir
 * src/shared/catalog/content.ts) : un fichier par identifiant du catalogue, ni plus ni moins ; chacun
 * suit le schéma de sa famille (content/schemas/<famille>.schema.json), sans champ que le schéma
 * ignore (une faute de frappe dans le nom d'un champ facultatif) ; un fichier mal formé est signalé
 * par son nom et son champ ; ce que le jeu lit est exactement ce que dit le fichier.
 */

/** Ce que le jeu a lu de chaque fichier d'une famille, par identifiant (un TypeScript exhaustif : une nouvelle famille s'y ajoute). */
const READ: Record<ContentFamily, (id: string) => object | undefined> = {
  props: (id) => PROP_TYPES[id as keyof typeof PROP_TYPES],
  wheels: (id) => (id in WHEEL_TYPES ? { ...WHEEL_TYPES[id as WheelType], price: WHEEL_PRICES[id as WheelType] } : undefined),
  weapons: (id) => WEAPONS[id as WeaponId],
  melee: (id) => MELEE_WEAPONS[id as MeleeId],
  blocks: (id) => (id in BLOCK_TYPES ? { ...BLOCK_TYPES[id as BlockType], price: BLOCK_PRICES[id as BlockType] } : undefined),
};

/** Les identifiants du catalogue du code, dans son ordre. */
const IDS: Record<ContentFamily, readonly string[]> = {
  props: Object.keys(PROP_TYPES),
  wheels: Object.keys(WHEEL_TYPES),
  weapons: Object.keys(WEAPONS),
  melee: Object.keys(MELEE_WEAPONS),
  // Les blocs de forme sont calculés (catalog/blocks.ts, `shaped`) : ils n'ont pas de fichier
  blocks: Object.keys(BLOCK_TYPES).filter((type) => !blockShape(type as BlockType)),
};

/** Une valeur du jeu écrite en JSON : un nombre infini devient null (l'ogive ne se recharge jamais), le reste au bit près. */
function asJson(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(asJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asJson(v)]));
  return value;
}

const folder = (family: ContentFamily): URL => new URL(`../content/${family}/`, import.meta.url);

/** Les fichiers d'une famille (sans « .json »). */
const filesOf = (family: ContentFamily): string[] => readdirSync(folder(family)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

/** Les problèmes d'un fichier, une ligne chacun : « content/<famille>/<id>.json: <champ>: <ce qui ne va pas> ». */
function fileProblems(family: ContentFamily, id: string, data: unknown): string[] {
  const name = `content/${family}/${id}.json`;
  const problems = validateSchema(familySchema(family), data, { unknownProperties: true }).map((e) => `${name}: ${e.path || "(racine)"}: ${e.message}`);
  const ref = (data as { $schema?: unknown } | null)?.$schema;
  if (ref !== familySchemaRef(family)) problems.push(`${name}: $schema: ${JSON.stringify(ref)} au lieu de ${JSON.stringify(familySchemaRef(family))}`);
  return problems;
}

const readJson = (family: ContentFamily, id: string): unknown => JSON.parse(readFileSync(new URL(`${id}.json`, folder(family)), "utf8"));

describe("les éléments du jeu en fichiers de données (content/<famille>/<id>.json)", () => {
  for (const family of CONTENT_FAMILY_IDS) {
    it(`${family} : un fichier par identifiant du catalogue, chacun suit son schéma sans champ inconnu`, () => {
      expect(filesOf(family).sort()).toEqual([...IDS[family]].sort());
      expect(filesOf(family).flatMap((id) => fileProblems(family, id, readJson(family, id)))).toEqual([]);
    });

    it(`${family} : le jeu lit chaque fichier tel qu'il est (au bit près), sans ses champs « $ »`, () => {
      for (const id of filesOf(family)) expect(asJson(READ[family](id)), id).toEqual(fileData(readJson(family, id) as object));
    });

    it(`${family} : le schéma n'emploie que des mots-clés connus, et chacun de ses champs a sa description`, () => {
      const schema = familySchema(family);
      expect(unsupportedKeywords(schema)).toEqual([]);
      expect(undocumented(schema)).toEqual([]);
    });
  }

  it("un fichier mal formé est signalé par son nom et son champ", () => {
    const crate = readJson("props", "crate") as Record<string, unknown>;
    expect(fileProblems("props", "crate", crate)).toEqual([]);
    const broken = { ...crate, hp: "beaucoup", hps: 120, shape: { kind: "box" }, resist: { ...(crate.resist as object), heat: 2 } };
    const problems = fileProblems("props", "crate", broken);
    for (const field of ["hp", "hps", "shape", "resist.heat"]) expect(problems.some((p) => p.startsWith(`content/props/crate.json: ${field}:`)), field).toBe(true);
    const { $schema: _, ...unlinked } = crate;
    expect(fileProblems("props", "crate", unlinked)).toEqual([`content/props/crate.json: $schema: undefined au lieu de "../schemas/props.schema.json"`]);
    const wheel = readJson("wheels", "steered") as Record<string, unknown>;
    expect(fileProblems("wheels", "steered", { ...wheel, price: -5 })[0]).toMatch(/^content\/wheels\/steered\.json: price: /);
  });

  it("un rechargement null (jamais) devient l'infini, que JSON ne sait pas écrire", () => {
    expect((readJson("weapons", "warhead") as { ammo: { reload: unknown } }).ammo.reload).toBeNull();
    expect(WEAPONS.warhead.ammo.reload).toBe(Infinity);
    expect(WEAPONS.rockets.ammo.reload).toBe(1.1);
  });

  it("les champs « $ » ne sont pas des données : le jeu les ignore, l'ordre des autres reste", () => {
    expect(Object.keys(fileData({ $schema: "x", a: 1, $comment: "note", b: { $c: 2 } }))).toEqual(["a", "b"]);
  });

  it("une roue directrice a la taille, le moteur et la suspension de la roue fixe dont elle est la variante", () => {
    for (const type of Object.keys(WHEEL_TYPES) as WheelType[]) {
      const steered = steeredVariant(type);
      if (!steered || steered === type) continue;
      const { cost: _a, steering, ...fixed } = { ...WHEEL_TYPES[type], steering: undefined };
      const { cost: _b, steering: turn, ...variant } = WHEEL_TYPES[steered];
      expect(steering).toBeUndefined();
      expect(turn, steered).toBeDefined();
      expect(variant, steered).toEqual(fixed);
      expect(WHEEL_TYPES[steered].cost, steered).toBeGreaterThan(WHEEL_TYPES[type].cost);
    }
  });
});
