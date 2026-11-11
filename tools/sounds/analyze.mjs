// Examine les variantes générées d'un son : node tools/sounds/analyze.mjs <son> [<son>…]
// (sans argument : tous les sons de tools/sounds/raw). Pour chaque variante : son enveloppe (un
// caractère par 100 ms), sa crête, la durée où il s'entend, et pour une boucle le saut au
// raccord (rapporté au pas moyen d'un échantillon à l'autre). Signale ce qui cloche : presque
// muet, trop court par rapport à la durée demandée, boucle qui saute ou qui s'éteint.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const RATE = 44100;
const catalog = JSON.parse(readFileSync("tools/sounds/catalog.json", "utf8")).sounds;
const keys = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync("tools/sounds/raw");
const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const BARS = [[-60, "·"], [-45, "▁"], [-35, "▂"], [-28, "▃"], [-22, "▄"], [-16, "▅"], [-10, "▆"], [Infinity, "█"]];

for (const key of keys) {
  const spec = catalog[key] ?? {};
  const loop = !!spec.loop;
  const files = readdirSync(`tools/sounds/raw/${key}`).filter((f) => f.endsWith(".mp3")).sort((a, b) => parseInt(a) - parseInt(b));
  console.log(`\n${key}${loop ? " (boucle)" : ""}`);
  for (const f of files) {
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", `tools/sounds/raw/${key}/${f}`, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
    const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
    const win = RATE / 10;
    const levels = [];
    for (let i = 0; i < s.length; i += win) {
      let sum = 0;
      const end = Math.min(s.length, i + win);
      for (let j = i; j < end; j++) sum += s[j] * s[j];
      levels.push(db(Math.sqrt(sum / (end - i))));
    }
    const bars = levels.map((l) => BARS.find(([limit]) => l < limit)[1]).join("");
    let peak = 0;
    for (const x of s) peak = Math.max(peak, Math.abs(x));
    const loud = levels.filter((l) => l > db(peak) - 30).length / 10;
    const flags = [];
    if (db(peak) < -30) flags.push("presque muet");
    if (!loop && spec.duration && loud < Math.min(0.15, spec.duration * 0.25)) flags.push("très court");
    if (loop) {
      let step = 0;
      for (let i = 1; i < s.length; i++) step += Math.abs(s[i] - s[i - 1]);
      step /= s.length - 1;
      const seam = Math.abs(s[0] - s[s.length - 1]) / step;
      const inner = levels.slice(1, -1);
      const swing = Math.max(...inner) - Math.min(...inner);
      flags.push(`raccord ${seam.toFixed(1)}×`);
      if (seam > 4) flags.push("RACCORD QUI SAUTE");
      if (swing > 18) flags.push(`niveau qui varie de ${swing.toFixed(0)} dB`);
    }
    console.log(`  ${f.padEnd(28)} ${bars}  crête ${db(peak).toFixed(1)} dB, audible ${loud.toFixed(1)} s${flags.length ? " — " + flags.join(", ") : ""}`);
  }
}
