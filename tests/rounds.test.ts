import { describe, expect, it } from "vitest";
import { visibleRounds } from "../src/client/render/rounds";

describe("munitions visibles sur les têtes", () => {
  it("on montre la part du chargeur qui reste, au moins un coup tant qu'il en reste", () => {
    // Autant de places que de coups : exactement ce qui reste
    expect([1, 0].map((a) => visibleRounds(1, a, 1))).toEqual([1, 0]);
    // Quatre tubes pour trois missiles
    expect([3, 2, 1, 0].map((a) => visibleRounds(4, a, 3))).toEqual([4, 3, 1, 0]);
    // Deux bombes pour un chapelet de huit : la dernière reste en vue jusqu'au dernier coup
    expect([8, 5, 4, 2, 1, 0].map((a) => visibleRounds(2, a, 8))).toEqual([2, 1, 1, 1, 1, 0]);
    // Jamais plus que les places, ni pour une arme sans chargeur
    expect(visibleRounds(3, 9, 4)).toBe(3);
    expect(visibleRounds(3, 5, 0)).toBe(0);
  });
});
