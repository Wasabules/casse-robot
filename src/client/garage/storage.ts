import { upgradeDesign, type RobotDesign } from "../../shared/design/robotDesign";

/** Un robot du garage : son nom, sa couleur et son plan (données JSON). */
export interface SavedRobot {
  name: string;
  color: string;
  design: RobotDesign;
}

const KEY = "casse-robot.garage";

/**
 * Robots enregistrés dans le navigateur. Le stockage peut être indisponible (navigation privée) ;
 * on repart alors d'un garage vide, et les enregistrements ne valent que pour la visite.
 */
export function loadRobots(): SavedRobot[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as SavedRobot[];
    if (!Array.isArray(list)) return [];
    // Un robot d'une version précédente est remis au format du jour (voir upgradeDesign)
    return list.filter((r) => r && typeof r.name === "string" && r.design).map((r) => ({ ...r, design: upgradeDesign(r.design) }));
  } catch {
    return [];
  }
}

/** Enregistre (ou remplace, s'il porte le même nom) un robot. */
export function saveRobot(robot: SavedRobot): void {
  const list = loadRobots().filter((r) => r.name !== robot.name);
  list.push(robot);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Pas de stockage : l'enregistrement ne vaut que pour cette visite
  }
}

export function deleteRobot(name: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadRobots().filter((r) => r.name !== name)));
  } catch {
    // Rien à faire sans stockage
  }
}
