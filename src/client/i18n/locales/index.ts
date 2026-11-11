import type { Catalog, CatalogErrors, Message, MessageKey, WidenedKeys } from "../i18n";
import type { Locale } from "../state";
import { en } from "./en";
import { fr } from "./fr";

/*
 * Les langues du jeu. Le français est la langue source ; une autre langue complète passe par
 * `complete` : TypeScript y refuse une clé absente (`Catalog`), une clé en trop ou des paramètres
 * différents de ceux du français (`CatalogErrors`, dont les clés fautives s'affichent dans
 * l'erreur). Une langue en cours de traduction peut n'avoir qu'une partie des clés : ce qui manque
 * s'affiche en anglais (voir `t`).
 */

export interface LocaleInfo {
  /** Nom de la langue dans cette langue (le réglage les montre ainsi : chacun reconnaît la sienne). */
  readonly name: string;
  readonly messages: Readonly<Partial<Record<MessageKey, Message>>>;
}

/** Une langue complète, vérifiée : le second argument ne vaut `true` que si elle n'a aucune erreur. */
function complete<L extends Catalog>(messages: L, ok: [CatalogErrors<L>] extends [never] ? true : CatalogErrors<L>): L {
  void ok;
  return messages;
}

/** La langue source, vérifiée : chaque message a un type littéral (sinon ses paramètres ne seraient pas vérifiés). */
function source<L>(messages: L, ok: [WidenedKeys<L>] extends [never] ? true : WidenedKeys<L>): L {
  void ok;
  return messages;
}

export const LOCALES: Readonly<Record<Locale, LocaleInfo>> = {
  fr: { name: "Français", messages: source(fr, true) },
  en: { name: "English", messages: complete(en, true) },
};
