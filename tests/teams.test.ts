import { expect, it } from "vitest";
import { designCost } from "../src/shared/design/budget";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { GAME_MODES, matchEntries, teamCost } from "../src/shared/modes";
import { seedRandom } from "./seed";

it("les deux équipes d'une partie ont des coûts proches, quel que soit le robot du joueur", () => {
  const mode = GAME_MODES.battle;
  const heaviest = Math.max(...PRESET_BOTS.map((p) => designCost(p.design)));
  for (let seed = 1; seed <= 20; seed++) {
    seedRandom(seed);
    const player = PRESET_BOTS[seed % PRESET_BOTS.length];
    const entries = matchEntries(mode, player);
    expect(entries[0]).toEqual({ profile: player, team: "blue" });
    expect(entries.filter((e) => e.team === "blue")).toHaveLength(mode.size / 2);
    expect(entries.filter((e) => e.team === "red")).toHaveLength(mode.size / 2);
    // L'écart ne dépasse pas le coût d'un robot moyen, loin du plus lourd
    expect(Math.abs(teamCost(entries, "blue") - teamCost(entries, "red"))).toBeLessThan(heaviest * 0.5);
  }
});
