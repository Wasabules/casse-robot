/*
 * Un petit validateur de JSON Schema (draft 2020-12), pour les essais des schémas du jeu
 * (tests/schemas.test.ts) : il ne connaît que les mots-clés qu'emploient nos schémas
 * (tools/schemas/schemas.ts), et `unsupportedKeywords` dit si un schéma en emploie un autre (le
 * schéma doit alors rester dans ce sous-ensemble, ou ce validateur apprendre le mot-clé). Les
 * références ne vont que dans le même document (« #/$defs/… »).
 *
 * `unknownProperties` : signale aussi un champ qu'aucun schéma n'a évalué (comme
 * `unevaluatedProperties: false` partout) ; nos schémas les permettent (la lecture les ignore), mais
 * un document d'essai qui n'en a que de déclarés prouve que le schéma connaît chacun de ses champs.
 */

export interface SchemaError {
  /** Le champ fautif, à la manière de la lecture des cartes (« props[3].type »). */
  readonly path: string;
  readonly message: string;
}

type Schema = { readonly [keyword: string]: unknown };

/** Annotations : sans effet sur la validation. */
const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated"]);
/** Mots-clés dont la valeur est un schéma, une liste de schémas, ou des schémas par nom. */
const ONE = new Set(["items", "additionalProperties", "propertyNames", "contains", "if", "then"]);
const MANY = new Set(["prefixItems", "anyOf", "oneOf", "allOf"]);
const NAMED = new Set(["properties", "$defs"]);
/** Mots-clés dont la valeur n'est pas un schéma. */
const VALUES = new Set([
  "$ref", "type", "enum", "const", "required", "minItems", "maxItems", "minContains", "maxContains", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "maxProperties",
]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Les mots-clés d'un schéma (et de ses sous-schémas) que ce validateur ne connaît pas, avec leur chemin. */
export function unsupportedKeywords(schema: unknown, at = "#"): string[] {
  if (!isObject(schema)) return [`${at} (pas un objet)`];
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const here = `${at}/${key}`;
    if (ANNOTATIONS.has(key) || VALUES.has(key)) continue;
    if (ONE.has(key)) out.push(...unsupportedKeywords(value, here));
    else if (MANY.has(key) && Array.isArray(value)) value.forEach((s, i) => out.push(...unsupportedKeywords(s, `${here}/${i}`)));
    else if (NAMED.has(key) && isObject(value)) for (const [name, s] of Object.entries(value)) out.push(...unsupportedKeywords(s, `${here}/${name}`));
    else out.push(here);
  }
  return out;
}

/** Égalité de deux valeurs JSON. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return false;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const hasType = (v: unknown, type: string): boolean => typeOf(v) === type || (type === "number" && typeOf(v) === "integer");

const child = (path: string, key: string | number): string => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key);

/** Ce qu'une évaluation a trouvé : ses erreurs, et les champs de l'objet qu'elle a évalués. */
interface Outcome {
  readonly errors: SchemaError[];
  readonly evaluated: Set<string>;
}

/** Les expressions des schémas, compilées une fois. */
const PATTERNS = new Map<string, RegExp>();

class Validator {
  private readonly root: Schema;
  private readonly unknownProperties: boolean;

  constructor(root: Schema, unknownProperties: boolean) {
    this.root = root;
    this.unknownProperties = unknownProperties;
  }

  private resolve(ref: string): Schema {
    if (!ref.startsWith("#/")) throw new Error(`Référence non prise en charge : ${ref}`);
    let node: unknown = this.root;
    for (const part of ref.slice(2).split("/")) node = isObject(node) ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    if (!isObject(node)) throw new Error(`Référence introuvable : ${ref}`);
    return node;
  }

  private regex(pattern: string): RegExp {
    let re = PATTERNS.get(pattern);
    if (!re) PATTERNS.set(pattern, (re = new RegExp(pattern, "u")));
    return re;
  }

  /** Une valeur à son propre emplacement : ses champs non évalués s'y signalent (si on le demande). */
  at(schema: unknown, value: unknown, path: string): SchemaError[] {
    const { errors, evaluated } = this.check(schema, value, path);
    if (this.unknownProperties && isObject(value)) {
      for (const key of Object.keys(value)) if (!evaluated.has(key)) errors.push({ path: child(path, key), message: "champ inconnu du schéma" });
    }
    return errors;
  }

  /** Une valeur contre un schéma, au même emplacement (les applicateurs sur place : $ref, anyOf, oneOf, allOf, if). */
  check(schema: unknown, value: unknown, path: string): Outcome {
    const errors: SchemaError[] = [];
    const evaluated = new Set<string>();
    const fail = (message: string): void => {
      errors.push({ path, message });
    };
    const merge = (o: Outcome): void => {
      errors.push(...o.errors);
      for (const k of o.evaluated) evaluated.add(k);
    };
    if (!isObject(schema)) throw new Error(`Schéma invalide à ${path || "la racine"}`);
    const s = schema;

    if (typeof s.$ref === "string") merge(this.check(this.resolve(s.$ref), value, path));

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => hasType(value, t))) {
        fail(`type ${typeOf(value)} au lieu de ${types.join(" | ")}`);
        return { errors, evaluated };
      }
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, value))) fail(`valeur hors de la liste (${JSON.stringify(value)})`);
    if (s.const !== undefined && !same(s.const, value)) fail(`valeur ${JSON.stringify(value)} au lieu de ${JSON.stringify(s.const)}`);

    if (typeof value === "number") {
      if (typeof s.minimum === "number" && value < s.minimum) fail(`${value} < ${s.minimum}`);
      if (typeof s.maximum === "number" && value > s.maximum) fail(`${value} > ${s.maximum}`);
      if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) fail(`${value} ≤ ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) fail(`${value} ≥ ${s.exclusiveMaximum}`);
    }

    if (typeof value === "string") {
      // Les longueurs se comptent en caractères Unicode (points de code), pas en unités UTF-16
      const length = [...value].length;
      if (typeof s.minLength === "number" && length < s.minLength) fail(`texte de ${length} caractères (au moins ${s.minLength})`);
      if (typeof s.maxLength === "number" && length > s.maxLength) fail(`texte de ${length} caractères (au plus ${s.maxLength})`);
      if (typeof s.pattern === "string" && !this.regex(s.pattern).test(value)) fail(`texte qui ne suit pas ${s.pattern}`);
    }

    if (Array.isArray(value)) {
      if (typeof s.minItems === "number" && value.length < s.minItems) fail(`${value.length} éléments (au moins ${s.minItems})`);
      if (typeof s.maxItems === "number" && value.length > s.maxItems) fail(`${value.length} éléments (au plus ${s.maxItems})`);
      const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : [];
      prefix.forEach((p, i) => {
        if (i < value.length) errors.push(...this.at(p, value[i], child(path, i)));
      });
      if (s.items !== undefined) for (let i = prefix.length; i < value.length; i++) errors.push(...this.at(s.items, value[i], child(path, i)));
      if (s.contains !== undefined) {
        // (une épreuve, pas une évaluation de l'élément : ses autres champs ne sont pas « inconnus » pour autant)
        const count = value.filter((v, i) => !this.check(s.contains, v, child(path, i)).errors.length).length;
        const min = typeof s.minContains === "number" ? s.minContains : 1;
        if (count < min) fail(`${count} éléments conformes à « contains » (au moins ${min})`);
        if (typeof s.maxContains === "number" && count > s.maxContains) fail(`${count} éléments conformes à « contains » (au plus ${s.maxContains})`);
      }
    }

    if (isObject(value)) {
      const keys = Object.keys(value);
      if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!Object.hasOwn(value, k)) errors.push({ path: child(path, k), message: "champ obligatoire absent" });
      if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) fail(`${keys.length} champs (au plus ${s.maxProperties})`);
      if (s.propertyNames !== undefined) for (const k of keys) for (const e of this.at(s.propertyNames, k, child(path, k))) errors.push({ ...e, message: `nom de champ : ${e.message}` });
      const properties = isObject(s.properties) ? s.properties : {};
      for (const k of keys) {
        if (Object.hasOwn(properties, k)) {
          errors.push(...this.at(properties[k], value[k], child(path, k)));
          evaluated.add(k);
        } else if (s.additionalProperties !== undefined) {
          errors.push(...this.at(s.additionalProperties, value[k], child(path, k)));
          evaluated.add(k);
        }
      }
    }

    if (Array.isArray(s.allOf)) for (const sub of s.allOf) merge(this.check(sub, value, path));
    if (Array.isArray(s.anyOf)) {
      const outcomes = s.anyOf.map((sub) => this.check(sub, value, path));
      const passed = outcomes.filter((o) => !o.errors.length);
      if (passed.length) passed.forEach(merge);
      else fail(`aucune des ${outcomes.length} possibilités (anyOf) ne convient : ${bestErrors(outcomes)}`);
    }
    if (Array.isArray(s.oneOf)) {
      const outcomes = s.oneOf.map((sub) => this.check(sub, value, path));
      const passed = outcomes.filter((o) => !o.errors.length);
      if (passed.length === 1) merge(passed[0]);
      else if (passed.length) fail(`${passed.length} possibilités (oneOf) conviennent à la fois`);
      else fail(`aucune des ${outcomes.length} possibilités (oneOf) ne convient : ${bestErrors(outcomes)}`);
    }
    if (s.if !== undefined) {
      const test = this.check(s.if, value, path);
      if (!test.errors.length) {
        merge(test);
        if (s.then !== undefined) merge(this.check(s.then, value, path));
      }
    }
    return { errors, evaluated };
  }
}

/** Les erreurs de la possibilité qui en a le moins (la plus proche de convenir), en une ligne. */
function bestErrors(outcomes: readonly Outcome[]): string {
  const best = [...outcomes].sort((a, b) => a.errors.length - b.errors.length)[0];
  return best ? best.errors.slice(0, 3).map((e) => `${e.path || "(racine)"} : ${e.message}`).join(" ; ") : "";
}

/** Les erreurs d'une valeur contre un schéma (vide : elle s'y conforme). */
export function validateSchema(schema: object, value: unknown, options: { unknownProperties?: boolean } = {}): SchemaError[] {
  return new Validator(schema as Schema, options.unknownProperties ?? false).at(schema, value, "");
}
