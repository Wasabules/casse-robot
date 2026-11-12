import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { MELEE_WEAPONS } from "../src/shared/catalog/melee";
import { PROP_TYPES } from "../src/shared/catalog/props";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { WHEEL_TYPES } from "../src/shared/catalog/wheels";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { BLOCK_PRICES, WHEEL_PRICES } from "../src/shared/design/progression";

/*
 * Les catalogues du jeu, figés avant leur passage en fichiers de données (content/<famille>/<id>.json,
 * voir « Content catalog » dans docs/architecture.md) : ce que le code construit depuis les fichiers
 * doit être exactement ce qu'il construisait avant, au bit près pour chaque nombre (−0, infinis
 * compris), champ par champ et dans le même ordre (un `Object.entries` les parcourt dans cet ordre).
 *
 * Un changement voulu d'une valeur (un réglage d'équilibre) change aussi l'instantané : le récrire
 * dans le même commit, `CATALOG_SNAPSHOT=write npx vitest run tests/catalogSnapshot.test.ts` ; son
 * diff montre ce qui a changé, élément par élément.
 */

const FILE = new URL("./reference/catalogs.json", import.meta.url);

/** Une valeur en JSON exact : ce que JSON ne dit pas (−0, infinis, NaN, undefined, une fonction) devient `{ "#": "-0" }`… */
function frozen(value: unknown): unknown {
  if (typeof value === "number") return Object.is(value, -0) ? { "#": "-0" } : Number.isFinite(value) ? value : { "#": String(value) };
  if (value === undefined) return { "#": "undefined" };
  if (typeof value === "function") return { "#": "function" };
  if (Array.isArray(value)) return value.map(frozen);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, frozen(v)]));
  return value;
}

/** Chaque entrée de chaque catalogue, sur une ligne : « famille.id » → sa valeur figée. */
function entries(): Record<string, string> {
  const families: Record<string, Readonly<Record<string, unknown>>> = {
    props: PROP_TYPES,
    wheels: WHEEL_TYPES,
    wheelPrices: WHEEL_PRICES,
    blocks: BLOCK_TYPES,
    blockPrices: BLOCK_PRICES,
    weapons: WEAPONS,
    melee: MELEE_WEAPONS,
    robots: Object.fromEntries(PRESET_BOTS.map((bot) => [bot.id, bot])),
  };
  const out: Record<string, string> = {};
  for (const [family, catalog] of Object.entries(families)) {
    // L'ordre des identifiants compte aussi (les listes du garage, des armes, du sélecteur de robots)
    out[`${family}.#order`] = JSON.stringify(Object.keys(catalog));
    for (const [id, entry] of Object.entries(catalog)) out[`${family}.${id}`] = JSON.stringify(frozen(entry));
  }
  return out;
}

it("les catalogues du code sont ceux de l'instantané, au bit près", () => {
  const now = entries();
  if (process.env.CATALOG_SNAPSHOT === "write") {
    const lines = Object.entries(now).map(([k, v]) => `  ${JSON.stringify(k)}: ${v}`);
    writeFileSync(FILE, `{\n${lines.join(",\n")}\n}\n`);
  }
  // Relu puis réécrit, chaque valeur redonne son texte d'une ligne (JSON.parse garde l'ordre des champs et chaque nombre)
  const reference = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
  expect(Object.keys(now)).toEqual(Object.keys(reference));
  for (const [key, text] of Object.entries(now)) expect(text, key).toBe(JSON.stringify(reference[key]));
});
