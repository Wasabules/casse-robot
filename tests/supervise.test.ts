import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/*
 * Le superviseur du serveur de jeu (tools/server/supervise.mjs, `npm run server:supervised`) : il
 * relance le serveur qui s'arrête sur une erreur, après un délai qui double, et s'arrête avec lui
 * quand il s'arrête normalement. Essayé sur un faux serveur qui échoue deux fois puis s'arrête.
 */

describe("superviseur du serveur", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("relance le serveur qui s'arrête sur une erreur, avec un délai qui double, puis s'arrête avec lui", () => {
    dir = mkdtempSync(join(tmpdir(), "casse-superviseur-"));
    const runs = join(dir, "runs.txt");
    const server = join(dir, "server.mjs");
    // Un faux serveur : ses deux premiers lancements échouent (code 1, puis une exception), le troisième s'arrête normalement
    writeFileSync(server, [
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const file = process.argv[2];",
      'appendFileSync(file, "x");',
      'const n = readFileSync(file, "utf8").length;',
      'if (n === 1) process.exit(1);',
      'if (n === 2) throw new Error("panne");',
      "process.exit(0);",
    ].join("\n"));
    writeFileSync(runs, "");
    const start = Date.now();
    const result = spawnSync(process.execPath, ["tools/server/supervise.mjs", server, runs], {
      env: { ...process.env, SUPERVISE_DELAY: "0.1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(runs, "utf8")).toBe("xxx");
    const lines = result.stdout.split("\n").filter((l) => l.startsWith("[superviseur "));
    expect(lines.filter((l) => l.includes("serveur lancé"))).toHaveLength(3);
    expect(lines.some((l) => /serveur arrêté avec le code 1, après [\d.]+ s : relance n° 1 dans 0\.1 s$/.test(l))).toBe(true);
    expect(lines.some((l) => /serveur arrêté avec le code 1, après [\d.]+ s : relance n° 2 dans 0\.2 s$/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/s'est arrêté normalement .* pas de relance$/);
    // (au moins les deux délais)
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  });
});
