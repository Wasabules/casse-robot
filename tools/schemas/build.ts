import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { schemaFiles } from "./schemas";

/*
 * Écrit les schémas JSON des formats ouverts du jeu (schemas/map.schema.json,
 * schemas/robot.schema.json), ceux des fichiers des éléments (content/schemas/<famille>.schema.json)
 * et le catalogue du jeu en données (content/catalog.json, son schéma) d'après le code : `npm run
 * schemas`, depuis la racine du dépôt. À relancer après tout changement d'un élément (son fichier),
 * d'un catalogue, d'une borne ou d'un champ du format :
 * tests/schemas.test.ts refuse des fichiers qui ne sont plus ceux que ferait ce générateur.
 */

for (const [path, text] of Object.entries(schemaFiles())) {
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`${path} : ${Math.round(text.length / 1024)} Ko`);
}
