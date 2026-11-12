import type { Team } from "../../../../shared/sim/entities";
import type { Message, ZoneOf } from "../../i18n";
import type { common as fr } from "../fr/common";
import { section } from "../section";

export const common = {
  ...section("unit", {
    m: "{v}\u00a0m",
    cm: "{v}\u00a0cm",
    s: "{v}\u00a0s",
    ms: "{v}\u00a0ms",
    kg: "{v}\u00a0kg",
    kJ: "{v}\u00a0kJ",
    kW: "{v}\u00a0kW",
    kN: "{v}\u00a0kN",
    N: "{v}\u00a0N",
    Nm: "{v}\u00a0N·m",
    m2: "{v}\u00a0m²",
    mps: "{v}\u00a0m/s",
    kmh: "{v}\u00a0km/h",
    rpm: "{v}\u00a0rpm",
    hp: "{v}\u00a0HP",
    hpps: "{v}\u00a0HP/s",
    pts: "{v}\u00a0pts",
    deg: "{v}°",
    dps: "{v}\u00a0dmg/s",
    px: "{v}\u00a0px",
    kB: "{v} KB",
    times: "×{v}",
  } as const),
  ...section("team", { blue: "Blue", red: "Red" } as const satisfies Record<Team, Message>),
  ...section("teamOne", { blue: "blue", red: "red" } as const satisfies Record<Team, Message>),
  "common.back": "Back",
  "common.cancel": "Cancel",
  "common.on": "On",
  "common.off": "Off",
  "common.none": "—",
} as const satisfies ZoneOf<typeof fr>;
