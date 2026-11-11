import { describe, expect, it } from "vitest";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { profileFromDesign } from "../src/shared/design/custom";
import { LOCOMOTIONS, matches, robotCard, sortCards } from "../src/client/menu/robotCatalog";
import { botName, weaponName } from "../src/client/i18n/names";

const cards = PRESET_BOTS.map((p, i) => robotCard(p, false, i));
const card = (id: string) => cards.find((c) => c.profile.id === id)!;

describe("choix du robot : fiches, filtres et tris", () => {
  it("chaque robot prédéfini a sa propulsion, déduite de ses organes", () => {
    expect(card("tank").locomotion).toBe("tracks");
    expect(card("spider").locomotion).toBe("legs");
    expect(card("hovercraft").locomotion).toBe("pads");
    expect(card("scarab").locomotion).toBe("wheels");
    for (const id of ["drone", "hexa", "heli"]) expect(card(id).locomotion).toBe("hover");
    for (const id of ["plane", "fighter", "bomber"]) expect(card(id).locomotion).toBe("plane");
    // Tous les robots sont dans une des propulsions filtrables
    for (const c of cards) expect(LOCOMOTIONS).toContain(c.locomotion);
  });

  it("la fiche donne les armes (par sorte), le coût et la masse d'après le plan", () => {
    const tank = card("tank");
    expect(tank.weapons.map((w) => w.id)).toContain("cannon");
    expect(tank.cost).toBeGreaterThan(0);
    expect(tank.mass).toBeGreaterThan(20);
    for (const c of cards) for (const w of c.weapons) expect(w.count).toBeGreaterThan(0);
  });

  it("la recherche porte sur le nom, la description et les armes, sans tenir compte des accents", () => {
    const found = (query: string) => cards.filter((c) => matches(c, { locomotion: "all", query })).map((c) => c.profile.id);
    expect(found("helicoptere")).toEqual(["heli"]);
    expect(found(weaponName("cannon").toUpperCase())).toContain("tank");
    expect(found("chenilles")).toContain("tank");
    expect(found("zzz")).toEqual([]);
    // Filtre par propulsion
    const planes = cards.filter((c) => matches(c, { locomotion: "plane", query: "" }));
    expect(planes.length).toBeGreaterThanOrEqual(3);
    expect(planes.every((c) => c.profile.mobility === "plane")).toBe(true);
  });

  it("le filtre « Mon garage » ne garde que ses robots, et les tris rangent la liste", () => {
    const mine = robotCard(profileFromDesign("Maison", "#ff0000", PRESET_BOTS[0].design), true, -1);
    const all = [mine, ...cards];
    expect(all.filter((c) => matches(c, { locomotion: "own", query: "" }))).toEqual([mine]);
    const byCost = sortCards(all, "costUp").map((c) => c.cost);
    expect(byCost).toEqual([...byCost].sort((a, b) => a - b));
    expect(sortCards(all, "order")[0]).toBe(mine);
    const names = sortCards(cards, "name").map((c) => botName(c.profile));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "fr")));
  });
});
