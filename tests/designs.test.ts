import { describe, expect, it } from "vitest";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type RobotDesign } from "../src/shared/design/robotDesign";

describe("plans de robots", () => {
  it.each(PRESET_BOTS.map((p) => [p.name, p.design] as const))("%s est valide", (_name, design) => {
    expect(validateDesign(design)).toEqual([]);
  });

  it("les identifiants des robots prédéfinis sont uniques", () => {
    const ids = PRESET_BOTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuse un plan sans cockpit", () => {
    const design: RobotDesign = { blocks: new DesignGrid().box(0, 1, 0, 0, 0, 0, "frame").blocks(), wheels: [] };
    expect(validateDesign(design)).toEqual([{ code: "cockpits", n: 0 }]);
  });

  it("refuse un bloc détaché et une roue sans support", () => {
    const g = new DesignGrid().put(0, 0, 0, "cockpit").put(3, 0, 0, "frame");
    const design: RobotDesign = { blocks: g.blocks(), wheels: [{ x: 1, y: 0, z: 0, dx: 1, dz: 0, type: "standard" }] };
    const problems = validateDesign(design);
    expect(problems).toContainEqual({ code: "detached", n: 1 });
    expect(problems).toContainEqual({ code: "noSupport", at: "1,0,0" });
  });

  it("poser un bloc sur une case occupée le remplace", () => {
    const blocks = new DesignGrid().box(0, 2, 0, 0, 0, 0, "armor").put(1, 0, 0, "cockpit").blocks();
    expect(blocks.map((b) => b.type)).toEqual(["armor", "cockpit", "armor"]);
  });
});
