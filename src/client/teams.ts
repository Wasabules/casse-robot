import type { Team } from "../shared/sim/entities";

/**
 * Couleur de chaque équipe, dans le HUD et sur les étiquettes des robots. Leur nom est dans chaque
 * langue (`team.<équipe>`, et les tournures du HUD : `hud.tab.teamOf`, `hud.feed.team`).
 */
export const TEAM_COLORS: Record<Team, string> = { red: "#e0605a", blue: "#4f8fe0" };
