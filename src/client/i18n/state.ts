/*
 * La langue affichée, et ceux qui veulent savoir quand elle change. À part (sans dépendance) : les
 * catalogues, la mise en forme des nombres et `t` s'en servent sans s'importer en boucle.
 */

/** Les langues du jeu, dans l'ordre du réglage. Une langue de plus : voir locales/index.ts. */
export const LOCALE_IDS = ["fr", "en"] as const;
export type Locale = (typeof LOCALE_IDS)[number];

let current: Locale = "fr";
const listeners = new Set<(locale: Locale) => void>();

/** La langue affichée. */
export const locale = (): Locale => current;

/** Change la langue affichée ; ceux qui écoutent (menus, HUD, garage) se redessinent. */
export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener(next);
}

/** Appelé à chaque changement de langue ; renvoie de quoi cesser d'écouter. */
export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Est-ce une langue du jeu ? */
export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALE_IDS as readonly string[]).includes(v);

/**
 * La langue du joueur d'après celles de son navigateur (`navigator.languages`, la première qu'on
 * connaît : « fr-CA » donne le français) ; à défaut, l'anglais, la plus partagée.
 */
export function detectLocale(preferred: readonly string[] = []): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return "en";
}
