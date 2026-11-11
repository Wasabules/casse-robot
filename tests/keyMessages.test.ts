import { afterEach, describe, expect, it } from "vitest";
import { partInfo } from "../src/client/garage/partInfo";
import { LOCALE_IDS, LOCALES, setLocale, t, type Locale, type Message } from "../src/client/i18n/i18n";
import { botTrait } from "../src/client/i18n/names";
import { ACTION_IDS, bindingName, DEFAULT_BINDINGS, keyLabel, setKeyNamer, type ActionId } from "../src/client/input/bindings";
import { freeKeys, garageKeys, pilotKeys } from "../src/client/keys";

/*
 * Les messages qui citent une touche nomment celle que le joueur a choisie : aucun catalogue n'écrit
 * une touche en dur (une lettre, Maj, Espace, un clic…), seulement des paramètres (`{key}`,
 * `{throttle}`…) que le jeu remplit d'après la table des actions (input/bindings.ts), en partie, au
 * garage, dans les fiches des pièces et les traits des robots.
 */

/** Les noms de touches et de boutons qu'aucun message ne doit écrire, par langue (mots entiers ; la casse compte : « espace », « tab » ne sont pas des touches). */
const FORBIDDEN: Readonly<Record<Locale, readonly string[]>> = {
  fr: [
    "Maj", "Ctrl", "Alt", "Espace", "Échap", "Tab", "Suppr", "Entrée", "Retour arr", "Pg préc", "Pg suiv", "Page↑", "Page↓",
    "clic gauche", "clic droit", "clic du milieu", "clic milieu", "Clic gauche", "Clic droit", "Clic du milieu", "Clic milieu", "Stick g", "Stick d",
    "LT", "RT", "LB", "RB", "L2", "R2", "L3", "R3",
  ],
  en: [
    "Shift", "Ctrl", "Alt", "Space", "Esc", "Tab", "Delete", "Enter", "Backspace", "Page Up", "Page Down",
    "left click", "right click", "middle click", "Left click", "Right click", "Middle click", "L stick", "R stick",
    "LT", "RT", "LB", "RB", "L2", "R2", "L3", "R3",
  ],
};

/**
 * Les noms des touches eux-mêmes, et ce qui n'est pas une touche mais en a l'air : des abréviations,
 * les unités, les initiales de la boussole du garage, le réglage du stick droit de la manette (une
 * commande fixe, que l'on règle là), les lettres des zones (« A à E ») et le bouton qui supprime une
 * carte communautaire (« Delete »).
 */
const EXEMPT = /^(key\.|pad\.|unit\.|garage\.compass\.|hud\.page\.kd$|hud\.page\.climb$|menu\.pad\.sensitivity$|mapIssue\.zones$|maps\.delete$)/;

/** Une lettre seule qui ressemble à une touche : « (F) », « R : », « Maj + R », « Ctrl+Z ». */
const LONE_LETTER = /(^|[\s(+«])[A-Z](?=\s?[:)+»]|$)/u;

const texts = (m: Message): string[] => (typeof m === "string" ? [m] : Object.values(m));

afterEach(() => {
  setLocale("fr");
  setKeyNamer((id) => bindingName(id, DEFAULT_BINDINGS[id]));
});

describe("messages qui nomment des touches", () => {
  it("aucun catalogue n'écrit de touche en dur : des paramètres, remplis d'après la table des actions", () => {
    const found: string[] = [];
    for (const id of LOCALE_IDS) {
      const words = FORBIDDEN[id].map((w) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u"));
      for (const [key, m] of Object.entries(LOCALES[id].messages) as [string, Message][]) {
        if (EXEMPT.test(key)) continue;
        for (const s of texts(m)) {
          // (les paramètres ne comptent pas : `{key}` n'est pas la touche K)
          const plain = s.replace(/\{\w+\}/g, "");
          const word = words.find((w) => w.test(plain));
          if (word) found.push(`${id} ${key} : « ${s} » (${word.source})`);
          else if (LONE_LETTER.test(plain)) found.push(`${id} ${key} : « ${s} » (une lettre seule)`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("les fiches des pièces, les traits des robots et les aides nomment les touches choisies, dans chaque langue", () => {
    // Des touches inventées, pour être sûr qu'elles viennent de la table et non d'un texte
    const names: Partial<Record<ActionId, string>> = { flares: "Ñ", boost: "Ж", forward: "⇧1", back: "⇩1", garageSpin: "Ω", garageUndo: "Ctrl+Ü" };
    setKeyNamer((id) => names[id] ?? "·");
    for (const locale of LOCALE_IDS) {
      setLocale(locale);
      expect(partInfo({ kind: "block", type: "flareLauncher" }).summary, locale).toContain("Ñ");
      expect(botTrait({ id: "dragster" }), locale).toContain("Ж");
      const k = (id: ActionId): string => keyLabel(id);
      const help = [...pilotKeys(k, k), ...freeKeys(k, k), ...garageKeys(k)].flat().join(" ");
      for (const name of ["Ñ", "Ж", "⇧1", "Ω", "Ctrl+Ü"]) expect(help, `${locale} : ${name}`).toContain(name);
      expect(t("hud.missile.flares", { key: keyLabel("flares"), n: 2 }), locale).toContain("Ñ");
    }
  });

  it("chaque action du garage a son libellé, et sa touche se nomme selon le clavier du joueur", () => {
    for (const locale of LOCALE_IDS) {
      setLocale(locale);
      for (const id of ACTION_IDS) expect(t(`action.${id}`).length, `${locale} : ${id}`).toBeGreaterThan(0);
      // Sur un clavier AZERTY : la symétrie se lit M (sa position QWERTY y écrit « , »), annuler, Ctrl+Z
      const azerty = new Map([["KeyW", "z"], ["KeyZ", "w"], ["KeyM", ","], ["Semicolon", "m"]]);
      expect(bindingName("garageMirror", DEFAULT_BINDINGS.garageMirror, azerty)).toBe("M");
      expect(bindingName("garageUndo", DEFAULT_BINDINGS.garageUndo, azerty)).toBe("Ctrl+Z");
    }
  });
});
