import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { frenchIn, frenchInHtml, looksFrench, sourceFiles } from "./frenchText";

/*
 * Pas de texte français en dur dans le code : ce que voit le joueur passe par les catalogues de
 * messages (client/i18n/locales/), sinon il ne se traduirait pas. Une heuristique (tests/frenchText.ts) :
 * une chaîne qui sert aux développeurs (console, erreurs) ou qui n'est pas une phrase se marque
 * `// i18n-ignore` sur sa ligne.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("langues : pas de texte français en dur", () => {
  it("l'heuristique reconnaît une phrase française, et laisse l'anglais et le code", () => {
    expect(looksFrench("Pièces à débloquer")).toBe(true);
    expect(looksFrench("Retour")).toBe(true);
    expect(looksFrench("pose-toi pour recharger dans la zone")).toBe(true);
    expect(looksFrench("Back to the garage")).toBe(false);
    expect(looksFrench("600 28px 'Chakra Petch', sans-serif")).toBe(false);
    expect(looksFrench("casse-robot.settings")).toBe(false);
  });

  it("le code du client, du serveur et le code partagé n'écrivent pas de texte français", () => {
    const files = [
      ...sourceFiles(ROOT, "src/client", ["src/client/i18n/locales/", "src/client/i18n/i18n.ts"]),
      ...sourceFiles(ROOT, "src/shared", []),
      ...sourceFiles(ROOT, "src/server", []),
    ];
    const found = files.flatMap((f) => frenchIn(ROOT, f));
    expect(found, found.join("\n")).toEqual([]);
  });

  it("chaque texte de la page passe par une clé (data-i18n)", () => {
    const found = frenchInHtml(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    expect(found, found.join("\n")).toEqual([]);
  });
});
