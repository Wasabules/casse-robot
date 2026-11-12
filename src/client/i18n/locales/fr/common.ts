import type { Team } from "../../../../shared/sim/entities";
import type { Message } from "../../i18n";
import { section } from "../section";

/*
 * Mots de tous les écrans : unités (le nombre en `{v}`, déjà écrit à la manière de la langue, et le
 * symbole ; une espace insécable entre les deux), équipes, boutons qui reviennent partout.
 */
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
    rpm: "{v}\u00a0tr/min",
    hp: "{v}\u00a0PS",
    hpps: "{v}\u00a0PS/s",
    pts: "{v}\u00a0pts",
    deg: "{v}°",
    dps: "{v}\u00a0dégâts/s",
    px: "{v}\u00a0px",
    kB: "{v} Ko",
    times: "×{v}",
  } as const),
  ...section("team", { blue: "Bleus", red: "Rouges" } as const satisfies Record<Team, Message>),
  ...section("teamOne", { blue: "bleue", red: "rouge" } as const satisfies Record<Team, Message>),
  "common.back": "Retour",
  "common.cancel": "Annuler",
  "common.on": "Oui",
  "common.off": "Non",
  "common.none": "—",
} as const;
