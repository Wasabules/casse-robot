import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DOM_ATTRIBUTES } from "../src/client/i18n/dom";
import { fixed, fold, num, pct, signed } from "../src/client/i18n/format";
import {
  detectLocale, isMessageKey, LOCALE_IDS, LOCALES, measure, onLocaleChange, pluralForm, setLocale, t, translate, type Locale, type Message,
} from "../src/client/i18n/i18n";
import { EN_ZONES } from "../src/client/i18n/locales/en";
import { FR_ZONES, fr } from "../src/client/i18n/locales/fr";
import { DEFAULT_SETTINGS, parseSettings } from "../src/client/settings";

/** Noms des paramètres d'un message (`{nom}`), triés ; une forme plurielle a toujours `n`. */
function params(m: Message): string[] {
  const texts = typeof m === "string" ? [m] : Object.values(m);
  const names = new Set(texts.flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1])));
  if (typeof m !== "string") names.add("n");
  return [...names].sort();
}

const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

afterEach(() => setLocale("fr"));

describe("langues : catalogues de messages", () => {
  it("chaque langue a toutes les clés du français, et rien de plus", () => {
    const keys = Object.keys(fr).sort();
    for (const id of LOCALE_IDS) expect(Object.keys(LOCALES[id].messages).sort(), id).toEqual(keys);
  });

  it("chaque message a les mêmes paramètres dans toutes les langues ; une forme plurielle a son « other »", () => {
    for (const id of LOCALE_IDS) {
      for (const [key, m] of Object.entries(LOCALES[id].messages) as [keyof typeof fr, Message][]) {
        expect(params(m), `${id} : ${key}`).toEqual(params(fr[key]));
        if (typeof m !== "string") {
          expect(m.other, `${id} : ${key}`).toBeTypeOf("string");
          for (const c of Object.keys(m)) expect(CATEGORIES, `${id} : ${key}`).toContain(c);
        }
        // Pas de texte vide ni d'accolade mal fermée
        for (const s of typeof m === "string" ? [m] : Object.values(m)) {
          expect(s.trim().length, `${id} : ${key}`).toBeGreaterThan(0);
          expect(s.replace(/\{\w+\}/g, ""), `${id} : ${key}`).not.toMatch(/[{}]/);
        }
      }
    }
  });

  it("chaque fichier d'une langue a les clés du même fichier en français, et une clé n'est que dans un fichier", () => {
    expect(Object.keys(EN_ZONES).sort()).toEqual(Object.keys(FR_ZONES).sort());
    let total = 0;
    for (const [zone, messages] of Object.entries(FR_ZONES)) {
      const en = EN_ZONES[zone as keyof typeof EN_ZONES];
      expect(Object.keys(en).sort(), zone).toEqual(Object.keys(messages).sort());
      total += Object.keys(messages).length;
    }
    // Deux fichiers qui auraient la même clé : la seconde écraserait la première sans bruit
    expect(Object.keys(fr).length).toBe(total);
  });

  it("le nom de chaque langue est dans sa propre langue", () => {
    expect(LOCALES.fr.name).toBe("Français");
    expect(LOCALES.en.name).toBe("English");
  });
});

describe("langues : pluriels, nombres, unités", () => {
  it("les pluriels suivent les règles de chaque langue (0 est au singulier en français, pas en anglais)", () => {
    const n = (lang: Locale, count: number): string => translate(lang, "picker.ownTrait", { trait: "x", n: count });
    expect([n("fr", 0), n("fr", 1), n("fr", 2)]).toEqual(["x · 0 bloc", "x · 1 bloc", "x · 2 blocs"]);
    expect([n("en", 0), n("en", 1), n("en", 2)]).toEqual(["x · 0 blocks", "x · 1 block", "x · 2 blocks"]);
    expect(translate("fr", "reward.kills", { n: 3 })).toBe("3 destructions");
    expect(translate("en", "reward.kills", { n: 1 })).toBe("1 kill");
    // Une catégorie absente de la langue prend la forme « other »
    expect(pluralForm({ other: "toujours" }, 1, "fr")).toBe("toujours");
  });

  it("les nombres s'écrivent à la manière de la langue : virgule ou point, groupes, signe moins", () => {
    expect(num(0.5, 1, "fr")).toBe("0,5");
    expect(num(0.5, 1, "en")).toBe("0.5");
    expect(num(2, 1, "fr")).toBe("2");
    expect(fixed(12, 1, "fr")).toBe("12,0");
    expect(fixed(12, 1, "en")).toBe("12.0");
    // Des groupes au-delà de 9 999 seulement : un port reste d'un bloc
    expect(num(8787, 0, "fr")).toBe("8787");
    expect(num(12345, 0, "en")).toBe("12,345");
    expect(num(12345, 0, "fr")).toBe("12\u202f345");
    expect(signed(-1.5, 1, "fr")).toBe("−1,5");
    expect(signed(1.5, 1, "en")).toBe("+1.5");
    expect(signed(-0.01, 1, "fr")).toBe("+0,0");
  });

  it("pourcentages et unités : « 85 % » et « 0,5 m » en français, « 85% » et « 0.5 m » en anglais", () => {
    // (une espace ins\u00e9cable, fine ou non selon la version des donn\u00e9es Unicode du moteur)
    expect(pct(0.85, 0, "fr")).toMatch(/^85[\u00a0\u202f]%$/);
    expect(pct(0.85, 0, "en")).toBe("85%");
    setLocale("fr");
    expect(measure(0.5, "m", 1)).toBe("0,5\u00a0m");
    expect(measure(1200, "rpm")).toBe("1200\u00a0tr/min");
    setLocale("en");
    expect(measure(0.5, "m", 1)).toBe("0.5\u00a0m");
    expect(measure(1200, "rpm")).toBe("1200\u00a0rpm");
  });

  it("un paramètre numérique est écrit à la manière de la langue", () => {
    expect(translate("fr", "designIssue.overBudget", { cost: 1.5, budget: 400 })).toBe("coût 1,5 au-delà du budget (400)");
    expect(translate("en", "designIssue.overBudget", { cost: 1.5, budget: 400 })).toBe("cost 1.5 over the budget (400)");
  });

  it("la recherche ignore accents et majuscules", () => {
    expect(fold("Hélicoptère")).toBe("helicoptere");
  });
});

describe("langues : choix et changement à chaud", () => {
  it("la langue par défaut est celle du navigateur, l'anglais à défaut", () => {
    expect(detectLocale(["fr-CA", "en-US"])).toBe("fr");
    expect(detectLocale(["de-DE", "en-GB"])).toBe("en");
    expect(detectLocale(["de"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });

  it("le réglage de la langue se relit, et une langue inconnue reprend la valeur par défaut", () => {
    expect(parseSettings(JSON.stringify({ language: "en" })).language).toBe("en");
    expect(parseSettings(JSON.stringify({ language: "fr" })).language).toBe("fr");
    expect(parseSettings(JSON.stringify({ language: "klingon" })).language).toBe(DEFAULT_SETTINGS.language);
    expect(parseSettings(JSON.stringify({ language: 3 })).language).toBe(DEFAULT_SETTINGS.language);
  });

  it("changer de langue prévient ceux qui écoutent, et `t` parle la nouvelle langue", () => {
    setLocale("fr");
    const heard: Locale[] = [];
    const stop = onLocaleChange((l) => heard.push(l));
    expect(t("block.armorHeavy")).toBe("Blindage lourd");
    setLocale("en");
    setLocale("en");
    expect(t("block.armorHeavy")).toBe("Heavy armor");
    stop();
    setLocale("fr");
    expect(heard).toEqual(["en"]);
  });

  it("un paramètre absent reste visible tel quel, sans erreur", () => {
    expect((translate as (lang: Locale, key: string, params: object) => string)("fr", "net.unreachable", {})).toBe("Impossible de joindre le serveur {url}.");
  });
});

describe("langues : la page (index.html)", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const attributes = ["data-i18n", ...DOM_ATTRIBUTES.map(([data]) => data)];
  const keys = attributes.flatMap((a) => [...html.matchAll(new RegExp(`\\s${a}="([^"]+)"`, "g"))].map((m) => m[1]));

  it("chaque clé de la page existe et n'a pas de paramètre", () => {
    for (const key of keys) {
      expect(isMessageKey(key), key).toBe(true);
      if (isMessageKey(key)) expect(params(fr[key]), key).toEqual([]);
    }
  });
});
