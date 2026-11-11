import { describe, expect, it } from "vitest";
import { BLOCK_PRICES, lockedParts, matchReward, partPrice, REWARDS, WHEEL_PRICES } from "../src/shared/design/progression";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { Progress } from "../src/client/progress";
import { rewardLineText } from "../src/client/i18n/names";

describe("progression : crédits et pièces à débloquer", () => {
  it("on part avec de quoi construire un robot armé qui roule", () => {
    for (const type of ["frame", "armor", "cockpit", "gunTurret", "battery"] as const) expect(BLOCK_PRICES[type]).toBe(0);
    expect(WHEEL_PRICES.standard).toBe(0);
    // Les pièces de haut niveau se débloquent
    expect(BLOCK_PRICES.railTurret).toBeGreaterThan(BLOCK_PRICES.cannonTurret);
    expect(BLOCK_PRICES.shield).toBeGreaterThan(0);
  });

  it("une partie rapporte d'autant plus qu'on la gagne et qu'on y détruit", () => {
    expect(matchReward({ outcome: "loss", kills: 0, captures: 0 }).total).toBe(REWARDS.played);
    const win = matchReward({ outcome: "win", kills: 3, captures: 2 });
    expect(win.total).toBe(REWARDS.played + REWARDS.win + 3 * REWARDS.kill + 2 * REWARDS.capture);
    expect(win.lines.map(rewardLineText)).toEqual(["Partie jouée", "Victoire", "3 destructions", "2 zones prises"]);
    expect(win.lines.map((l) => l.kind)).toEqual(["played", "win", "kills", "captures"]);
  });

  it("repère les pièces d'un plan qu'on n'a pas encore", () => {
    const tank = PRESET_BOTS.find((p) => p.id === "tank")!;
    const free = (part: Parameters<typeof partPrice>[0]): boolean => partPrice(part) === 0;
    const locked = lockedParts(tank.design, free).map((p) => `${p.kind}:${p.type}`);
    expect(locked).toContain("wheel:track");
    expect(locked).toContain("block:cannonTurret");
    expect(locked).not.toContain("block:frame");
    expect(lockedParts(tank.design, () => true)).toEqual([]);
  });

  it("on débloque une pièce avec ses crédits, pas sans ; en bac à sable, tout est là", () => {
    const progress = new Progress(); // sans stockage dans Node : on part de zéro
    const cannon = { kind: "block", type: "cannonTurret" } as const;
    expect(progress.has(cannon)).toBe(false);
    expect(progress.buy(cannon)).toBe(false);
    progress.earn(BLOCK_PRICES.cannonTurret + 30);
    expect(progress.buy(cannon)).toBe(true);
    expect(progress.has(cannon)).toBe(true);
    expect(progress.credits).toBe(30);
    expect(progress.count).toBe(1);
    const rail = { kind: "block", type: "railTurret" } as const;
    expect(progress.has(rail)).toBe(false);
    progress.sandbox = true;
    expect(progress.has(rail)).toBe(true);
  });
});
