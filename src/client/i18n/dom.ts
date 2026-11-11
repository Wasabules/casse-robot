import { isMessageKey, locale, translate } from "./i18n";

/*
 * Les textes de la page (index.html) : un élément porte la clé de son texte (`data-i18n`), ou de
 * ses attributs (`data-i18n-title`, `data-i18n-aria-label`, `data-i18n-placeholder`). Appliqué au
 * démarrage et à chaque changement de langue. Ces messages n'ont pas de paramètre (vérifié par
 * tests/i18n.test.ts, qui refuse aussi une clé inconnue).
 */

/** Attributs traduits : l'attribut `data-…` qui porte la clé, et celui qui reçoit le texte. */
export const DOM_ATTRIBUTES = [
  ["data-i18n-title", "title"],
  ["data-i18n-aria-label", "aria-label"],
  ["data-i18n-placeholder", "placeholder"],
] as const;

/** Le texte d'une clé écrite dans la page ; une clé inconnue se voit telle quelle. */
function text(key: string): string {
  return isMessageKey(key) ? (translate as (lang: string, k: string) => string)(locale(), key) : key;
}

/** Traduit les éléments de `root` qui portent une clé, et donne sa langue à la page. */
export function applyDom(root: ParentNode = document): void {
  document.documentElement.lang = locale();
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = text(el.getAttribute("data-i18n")!);
  for (const [data, attribute] of DOM_ATTRIBUTES) {
    for (const el of root.querySelectorAll<HTMLElement>(`[${data}]`)) el.setAttribute(attribute, text(el.getAttribute(data)!));
  }
}
