import type { fr } from "./locales/fr";
import { LOCALES } from "./locales";
import { formatParam, num } from "./format";
import { locale, type Locale } from "./state";

/*
 * Langues du jeu (i18n). Tout texte que voit le joueur vient d'un catalogue de messages par langue
 * (i18n/locales/<langue>/) ; le français est la langue source : ses clés font foi, et le type des
 * autres langues en découle (une clé absente ou en trop, un paramètre différent : une erreur de
 * TypeScript, voir locales/index.ts). Logique pure (ni DOM ni navigateur) : les tests s'en servent ;
 * ce qui touche la page est dans i18n/dom.ts, la langue affichée dans i18n/state.ts.
 *
 * Un message est un texte, avec des paramètres entre accolades (« {n} crédits »), ou ses formes
 * selon le nombre `n` (`{ one: "{n} pièce", other: "{n} pièces" }`), choisies par les règles de
 * pluriel de la langue (`Intl.PluralRules` : en français 0 et 1 sont au singulier, en anglais 1
 * seulement). Un paramètre numérique est écrit à la manière de la langue (« 0,5 », « 0.5 » ; au
 * plus deux décimales) ; pour une précision ou une unité choisies, on le met en forme avant
 * (i18n/format.ts, `measure`).
 */

export { detectLocale, isLocale, locale, LOCALE_IDS, onLocaleChange, setLocale, type Locale } from "./state";
export { LOCALES } from "./locales";

/** Catégories de pluriel de `Intl.PluralRules`. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
/** Les formes d'un message selon le nombre `n` : `other` toujours, les autres selon la langue. */
export type Plural = { readonly other: string } & { readonly [C in Exclude<PluralCategory, "other">]?: string };
export type Message = string | Plural;

/** Les messages de la langue source (le français). */
type Source = typeof fr;
/** Clé d'un message. */
export type MessageKey = keyof Source & string;

/** Noms des paramètres d'un texte : `{nom}` (un mot, sans espace). */
type Names<S> = S extends `${string}{${infer P}}${infer R}` ? (P extends "" | `${string} ${string}` ? never : P) | Names<R> : never;
/** Noms des paramètres d'un message (une forme plurielle a toujours `n`). */
export type MessageParams<M> = M extends string ? Names<M> : M extends Plural ? "n" | Names<M[keyof M]> : never;
/** Valeur d'un paramètre : un texte, ou un nombre (écrit à la manière de la langue). */
export type ParamValue = string | number;
/** Les paramètres d'un message : `n` est un nombre (il choisit la forme du pluriel). */
export type Params<K extends MessageKey> = { readonly [P in MessageParams<Source[K]>]: P extends "n" ? number : ParamValue };
/** Les arguments de `t` après la clé : rien pour un message sans paramètre. */
export type ParamArgs<K extends MessageKey> = [MessageParams<Source[K]>] extends [never] ? [] : [params: Params<K>];

/** Les messages d'une langue complète : toutes les clés de la langue source. */
export type Catalog = { readonly [K in MessageKey]: Message };
/**
 * Un fichier d'une langue, d'après le même fichier en français (`satisfies ZoneOf<typeof fr>`) :
 * une clé oubliée ou en trop y est signalée sur place.
 */
export type ZoneOf<T> = { readonly [K in keyof T]: Message };

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Les textes d'un message (ses formes, pour un pluriel). */
type TextsOf<M> = M extends string ? M : M extends Plural ? M[keyof M] & string : never;
/**
 * Clés d'une langue dont un texte a perdu son type littéral (une concaténation « … » + « … ») : ses
 * paramètres ne seraient plus vérifiés. Écrire chaque message d'une seule chaîne.
 */
export type WidenedKeys<L> = { [K in keyof L & string]: string extends TextsOf<L[K]> ? K : never }[keyof L & string];
/**
 * Ce qui ne va pas dans une langue (à part les clés absentes, que `Catalog` refuse déjà) : ses clés
 * en trop, celles dont les paramètres diffèrent de la langue source, celles qui ne sont pas littérales.
 */
export type CatalogErrors<L extends Catalog> =
  | Exclude<keyof L, MessageKey>
  | { [K in MessageKey]: Same<MessageParams<Source[K]>, MessageParams<L[K]>> extends true ? never : K }[MessageKey]
  | WidenedKeys<L>;

/**
 * Langues de repli, dans l'ordre, quand une traduction manque (une langue en cours de traduction) :
 * l'anglais, puis la langue source, toujours complète.
 */
const FALLBACK: readonly Locale[] = ["en", "fr"];
/** Problèmes déjà signalés (une fois chacun). */
const reported = new Set<string>();

/** En développement, une traduction manquante ou un paramètre absent se signale dans la console. */
function report(problem: string): void {
  if (reported.has(problem)) return;
  reported.add(problem);
  if (import.meta.env?.DEV) console.warn(`i18n : ${problem}`);
}

/** Le message d'une clé dans une langue, ou dans une langue de repli. */
function lookup(key: MessageKey, lang: Locale): Message {
  const own = LOCALES[lang].messages[key];
  if (own !== undefined) return own;
  report(`« ${key} » manque en ${lang}`);
  for (const other of FALLBACK) {
    const m = LOCALES[other].messages[key];
    if (m !== undefined) return m;
  }
  return key;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

/** La forme d'un message pluriel qui convient à `n` dans cette langue (`other` à défaut). */
export function pluralForm(m: Plural, n: number, lang: Locale = locale()): string {
  let rules = pluralRules.get(lang);
  if (!rules) pluralRules.set(lang, (rules = new Intl.PluralRules(lang)));
  return m[rules.select(n)] ?? m.other;
}

/** Remplace les `{nom}` d'un texte par les paramètres. */
function interpolate(text: string, params: Readonly<Record<string, ParamValue>> | undefined, key: string, lang: Locale): string {
  if (!text.includes("{")) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params?.[name];
    if (v === undefined) {
      report(`paramètre {${name}} absent pour « ${key} » (${lang})`);
      return whole;
    }
    return formatParam(v, lang);
  });
}

/** Le texte d'un message dans une langue donnée (tests, comparaisons). */
export function translate<K extends MessageKey>(lang: Locale, key: K, ...[params]: ParamArgs<K>): string {
  const m = lookup(key, lang);
  const values = params as Readonly<Record<string, ParamValue>> | undefined;
  const text = typeof m === "string" ? m : pluralForm(m, Number(values?.n ?? 0), lang);
  return interpolate(text, values, key, lang);
}

/**
 * Le texte d'un message dans la langue affichée : `t("menu.play")`, `t("garage.credits", { n: 120 })`.
 * TypeScript vérifie la clé et les paramètres (d'après le message français).
 */
export function t<K extends MessageKey>(key: K, ...args: ParamArgs<K>): string {
  return translate(locale(), key, ...args);
}

/** Cette clé existe-t-elle ? (Pour un texte facultatif : la précision d'une action, par exemple.) */
export const isMessageKey = (key: string): key is MessageKey => Object.hasOwn(LOCALES.fr.messages, key);

/** Clés des messages sans paramètre. */
export type PlainKey = { [K in MessageKey]: ParamArgs<K> extends [] ? K : never }[MessageKey];

/**
 * Le texte d'une clé facultative, faite à la volée (« actionDetail.boost ») : undefined si elle
 * n'existe pas (une rubrique `Partial<Record<…>>`). `params` : ceux que peuvent prendre les messages
 * de la rubrique (TypeScript ne les vérifie pas ici : chaque message n'en prend que ce qu'il cite).
 */
export function tMaybe(key: string, params?: Readonly<Record<string, ParamValue>>): string | undefined {
  if (!isMessageKey(key)) return undefined;
  const m = lookup(key, locale());
  return interpolate(typeof m === "string" ? m : pluralForm(m, Number(params?.n ?? 0)), params, key, locale());
}

/** Unités (`unit.*` des catalogues : le symbole, et sa place autour du nombre). */
export type Unit = MessageKey extends infer K ? (K extends `unit.${infer U}` ? U : never) : never;

/** Une mesure : le nombre (au plus `digits` décimales) et son unité, à la manière de la langue (« 0,5 m »). */
export function measure(x: number, unit: Unit, digits = 0): string {
  return translate(locale(), `unit.${unit}`, { v: num(x, digits) });
}
