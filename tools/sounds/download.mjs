// Télécharge des variantes générées par ElevenLabs : node tools/sounds/download.mjs <liens.json>
// Le fichier : { "<son>": [["<id de génération>", "<lien>"], …], … } (les liens du suivi de
// génération, valables 2 h). Chaque variante va dans tools/sounds/raw/<son>/<n>-<id>.mp3, n
// continuant la numérotation des variantes déjà là ; une variante déjà téléchargée est sautée.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage : node tools/sounds/download.mjs <liens.json>");
  process.exit(1);
}
const list = JSON.parse(readFileSync(file, "utf8"));
let failures = 0;
for (const [key, variants] of Object.entries(list)) {
  const dir = `tools/sounds/raw/${key}`;
  mkdirSync(dir, { recursive: true });
  for (const [id, url] of variants) {
    const present = readdirSync(dir);
    const already = present.find((f) => f.endsWith(`-${id}.mp3`));
    if (already) {
      console.log(`${key} ${id} déjà là (${already})`);
      continue;
    }
    const res = await fetch(url);
    if (!res.ok) {
      failures++;
      console.log(`${key} ${id} ÉCHEC HTTP ${res.status}`);
      continue;
    }
    const name = `${present.filter((f) => f.endsWith(".mp3")).length + 1}-${id}.mp3`;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(`${dir}/${name}`, buf);
    console.log(`${key} ${name} ${buf.length} octets`);
  }
}
if (failures) {
  console.log(`${failures} échec(s) : relire le suivi de génération pour des liens neufs, et relancer.`);
  process.exit(2);
}
