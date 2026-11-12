import { translate } from "../../src/client/i18n/i18n";
import { LOCALE_IDS } from "../../src/client/i18n/state";
import { ARENAS, type ArenaId } from "../../src/shared/arena/layout";
import { mapFromArena, mapText, type MapFile, type MapMeta } from "../../src/shared/map";

/*
 * Les arènes du jeu en fichiers de carte (`npm run map:export`) : la carte de chacune
 * (`mapFromArena`), avec ses noms et la phrase du menu dans chaque langue, écrite comme un fichier
 * (`mapText`). tests/arenaExport.test.ts vérifie que les fichiers de content/arenas/ sont ceux que
 * fait l'export. Pas dans maps/ : le jeu et le serveur y chargeraient des doublons de leurs arènes.
 */

/** Dossier des arènes du jeu exportées. */
export const ARENA_CONTENT = "content/arenas";

/** Langue des noms par défaut (celle du jeu) ; les autres vont dans `names`, `descriptions`. */
const SOURCE = "fr";

/** Les textes d'une arène dans les autres langues. */
function others(key: (lang: (typeof LOCALE_IDS)[number]) => string): Record<string, string> {
  return Object.fromEntries(LOCALE_IDS.filter((lang) => lang !== SOURCE).map((lang) => [lang, key(lang)]));
}

/** Ce que dit d'une arène du jeu sa carte : son nom et sa phrase du menu, dans chaque langue. */
export function arenaMeta(id: ArenaId): MapMeta {
  return {
    name: translate(SOURCE, `arena.${id}`),
    names: others((lang) => translate(lang, `arena.${id}`)),
    author: "Casse-Robot",
    description: translate(SOURCE, `arenaInfo.${id}`),
    descriptions: others((lang) => translate(lang, `arenaInfo.${id}`)),
    license: "AGPL-3.0-or-later",
  };
}

/** La carte d'une arène du jeu. */
export const arenaMap = (id: ArenaId): MapFile => mapFromArena(ARENAS[id], arenaMeta(id));

/** Le texte de son fichier (`<id>.casse-map.json`). */
export const arenaText = (id: ArenaId): string => mapText(arenaMap(id));
