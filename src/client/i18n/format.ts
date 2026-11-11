import { locale, type Locale } from "./state";

/*
 * Nombres à la manière de la langue affichée : séparateur décimal (« 0,5 » en français, « 0.5 » en
 * anglais), groupes de chiffres (au-delà de 9 999 seulement : un port, une année restent d'un
 * bloc), pourcentages (« 85 % », « 85% »), signe moins typographique. Les formats `Intl` sont gardés
 * par langue et par précision : les instruments en refont à chaque image.
 */

const formats = new Map<string, Intl.NumberFormat>();

function numberFormat(lang: Locale, id: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${lang}|${id}`;
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.NumberFormat(lang, options)));
  return f;
}

/** `useGrouping: "min2"` (des groupes à partir de 10 000), que les types d'ES2022 ne connaissent pas encore. */
const MIN2 = "min2" as unknown as boolean;

/** Un nombre, avec au plus `digits` décimales (sans zéros inutiles : « 1,5 », « 2 »). */
export function num(x: number, digits = 0, lang: Locale = locale()): string {
  return numberFormat(lang, `n${digits}`, { maximumFractionDigits: digits, useGrouping: MIN2 }).format(x);
}

/** Un nombre avec exactement `digits` décimales (« 12,0 ») : une valeur qui change à chaque image ne saute pas. */
export function fixed(x: number, digits: number, lang: Locale = locale()): string {
  return numberFormat(lang, `f${digits}`, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: MIN2 }).format(x);
}

/** Une part (0 à 1) en pourcentage, à la manière de la langue (« 85 % », « 85% »). */
export function pct(fraction: number, digits = 0, lang: Locale = locale()): string {
  return numberFormat(lang, `p${digits}`, { style: "percent", maximumFractionDigits: digits }).format(fraction);
}

/** Un nombre signé (« +1,5 », « −1,5 », avec le vrai signe moins), `digits` décimales exactement. */
export function signed(x: number, digits: number, lang: Locale = locale()): string {
  const body = fixed(Math.abs(x), digits, lang);
  // Un zéro arrondi n'a pas de signe moins
  return `${x < 0 && Number(Math.abs(x).toFixed(digits)) !== 0 ? "−" : "+"}${body}`;
}

/** Valeur d'un paramètre de message : un nombre est écrit à la manière de la langue (au plus 2 décimales). */
export function formatParam(v: string | number, lang: Locale): string {
  return typeof v === "number" ? num(v, 2, lang) : v;
}

/** Texte sans accents ni majuscules, pour les recherches (« helice » trouve « Hélice »). */
export const fold = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** La première lettre en majuscule (un nom en tête de phrase). */
export const capitalize = (text: string, lang: Locale = locale()): string => text.charAt(0).toLocaleUpperCase(lang) + text.slice(1);

const collators = new Map<Locale, Intl.Collator>();

/** Ordre alphabétique de la langue affichée (accents compris). */
export function compareText(a: string, b: string, lang: Locale = locale()): number {
  let c = collators.get(lang);
  if (!c) collators.set(lang, (c = new Intl.Collator(lang)));
  return c.compare(a, b);
}
