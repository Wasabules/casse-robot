/*
 * Quelle simulation fait tourner les parties : celle du TypeScript (`Simulation`, src/shared/sim/), ou
 * celle portée en Rust (crates/casse-sim, src/shared/native/), qui rend les mêmes images, octet pour
 * octet (tests/nativeSession.test.ts, tests/nativeParity.test.ts). Le choix vaut pour le Worker de la
 * partie solo (le réglage « Simulation » du joueur, `?sim=ts` ou `?sim=rust` dans l'adresse :
 * client/settings.ts), pour la salle du serveur (`SIM=ts` ou `SIM=rust`, server/main.ts) et pour les
 * batailles de l'IA (`SIM=…  npm run battle`).
 *
 * **La simulation Rust par défaut** (depuis le 13 novembre 2026), partout à la fois, par cette seule
 * constante. Les joueurs qui n'ont pas choisi eux-mêmes (`Settings.simulationChosen`) la prennent au
 * chargement suivant ; celle du TypeScript reste à qui la demande (`?sim=ts`, le réglage, `SIM=ts`),
 * en repli dans le Worker quand la Rust ne se charge pas, au serveur quand son module manque, et comme
 * référence des essais de parité et des batailles.
 */

export const SIMULATIONS = ["ts", "rust"] as const;
export type SimulationEngine = (typeof SIMULATIONS)[number];

/** La simulation par défaut (voir plus haut). */
export const DEFAULT_SIMULATION: SimulationEngine = "rust";

/** La simulation que nomme ce texte (« ts », « rust »), ou null. */
export function simulationNamed(name: unknown): SimulationEngine | null {
  return SIMULATIONS.find((s) => s === name) ?? null;
}
