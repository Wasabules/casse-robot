import { describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { WHEEL_TYPES } from "../src/shared/catalog/wheels";
import {
  allParts, CATEGORIES, categoryName, fold, groupName, matchesSearch, partCategory, partGroup, partInfo, partName,
} from "../src/client/garage/partInfo";
import { setLocale } from "../src/client/i18n/state";

/** Les types des pièces qui répondent à une recherche, dans la langue affichée. */
const found = (query: string): string[] => allParts().filter((p) => matchesSearch(p, query)).map((p) => p.type);

describe("inventaire du garage", () => {
  it("chaque pièce a sa catégorie, son nom et sa fiche", () => {
    const parts = allParts();
    expect(parts).toHaveLength(Object.keys(BLOCK_TYPES).length + Object.keys(WHEEL_TYPES).length);
    for (const part of parts) {
      expect(CATEGORIES, part.type).toContain(partCategory(part));
      expect(partName(part).length).toBeGreaterThan(0);
      const info = partInfo(part);
      expect(info.summary.length, part.type).toBeGreaterThan(10);
      // Pas de paramètre oublié dans une phrase (« {name} » resté tel quel)
      expect(info.summary, part.type).not.toMatch(/[{}]/);
      for (const [k, v] of info.stats) expect(`${k} ${v}`, part.type).not.toMatch(/[{}]/);
      expect(info.stats.map(([k]) => k)).toContain("Coût");
    }
    // Chaque catégorie a des pièces
    for (const cat of CATEGORIES) expect(parts.some((p) => partCategory(p) === cat), cat).toBe(true);
  });

  it("les armes sont rangées par famille, les roues par sorte", () => {
    expect(partGroup({ kind: "block", type: "missileLauncher" })).toBe("guided");
    expect(partGroup({ kind: "block", type: "gunTurret" })).toBe("direct");
    expect(partGroup({ kind: "block", type: "repairTurret" })).toBe("support");
    expect(partGroup({ kind: "wheel", type: "steered" })).toBe("steered");
    expect(partGroup({ kind: "wheel", type: "caster" })).toBe("casters");
    expect(partCategory({ kind: "wheel", type: "track" })).toBe("tracks");
    // Et se disent dans la langue affichée
    expect(groupName("guided")).toBe("Guidées");
    expect(categoryName("tracks")).toBe("Chenilles");
  });

  it("les valeurs s'écrivent à la française : virgule décimale, unités", () => {
    const stats = new Map(partInfo({ kind: "block", type: "armorLight" }).stats);
    expect(stats.get("Masse")).toBe("0,5\u00a0kg");
    expect(stats.get("Structure")).toBe("40\u00a0PS");
    expect(new Map(partInfo({ kind: "block", type: "cannonTurret" }).stats).get("Chargeur")).toMatch(/^\d+ coups$/);
  });

  it("la recherche ignore les accents et trouve par le nom, le rôle ou l'arme", () => {
    expect(fold("Hélice")).toBe("helice");
    expect(found("helice")).toContain("propeller");
    expect(found("missile")).toContain("missileLauncher");
    expect(found("soigne")).toEqual(expect.arrayContaining(["repairTurret", "naniteLauncher"]));
    // Tous les mots doivent y être
    const steered = found("roue directrice");
    expect(steered.length).toBeGreaterThan(0);
    for (const type of steered) expect(Object.keys(WHEEL_TYPES)).toContain(type);
    expect(found("zzz introuvable")).toEqual([]);
    expect(found("")).toHaveLength(allParts().length);
  });

  it("en anglais : les fiches sont en anglais, et la recherche porte sur les mots anglais", () => {
    setLocale("en");
    try {
      for (const part of allParts()) {
        const info = partInfo(part);
        expect(info.summary, part.type).not.toMatch(/[àâçéèêëîïôûùœ]/);
        expect(info.summary, part.type).not.toMatch(/[{}]/);
      }
      const stats = new Map(partInfo({ kind: "block", type: "armorLight" }).stats);
      expect(stats.get("Mass")).toBe("0.5\u00a0kg");
      expect(stats.get("Structure")).toBe("40\u00a0HP");
      expect(found("propeller")).toContain("propeller");
      expect(found("heals")).toEqual(expect.arrayContaining(["repairTurret", "naniteLauncher"]));
      expect(found("steered wheel").length).toBeGreaterThan(0);
      expect(categoryName("tracks")).toBe("Tracks");
    } finally {
      setLocale("fr");
    }
  });
});
