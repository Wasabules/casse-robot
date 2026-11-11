// Prépare les sons générés pour le jeu (npm run sounds) : pour chaque son de catalog.json, ses
// variantes retenues (tools/sounds/raw/<son>/<variante>.mp3) deviennent public/sounds/<son>-<n>.ogg.
// Avec des noms (npm run sounds -- <son> [<son>…]), seulement ces sons-là : tout refaire prend
// plus de dix minutes, la musique surtout.
//
// Son ponctuel : le silence du début et de la fin retiré (4 ms gardées avant l'attaque), un fondu
// de sortie (le générateur coupe net un son plus long que la durée demandée), crête à -1 dB.
// Boucle : le passage à 48 kHz se fait sur trois copies bout à bout, dont on garde celle du
// milieu ; puis un fondu enchaîné à puissance constante mêle la fin au début (le générateur ne
// raccorde pas toujours proprement) ; son niveau moyen est ramené à LOOP_RMS_DB (deux variantes
// d'un même moteur sonnent aussi fort), sans que sa crête dépasse -1 dB. L'Opus abîme les tout
// premiers et tout derniers échantillons d'un fichier : une boucle est encodée avec LOOP_PAD s de
// sa fin avant son début, et de son début après sa fin ; le jeu ne boucle qu'entre les deux
// (LOOP_PAD dans client/audio/samples.ts, qui doit rester égal). Mono, Opus 64 kb/s ; un son
// `stereo` (ambiance, musique : non spatialisés) garde ses deux voies, en Opus 96 kb/s ; la
// `music` en 112 kb/s ; un morceau en boucle perd son introduction et sa conclusion (le
// générateur compose un début qui monte et une fin qui s'éteint : en boucle, un creux à chaque
// tour), puis se raccorde sur MUSIC_CROSSFADE s.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";

const RATE = 48000;
const PEAK_DB = -1;
const ONSET_DB = -50;
const TAIL_DB = -60;
const KEEP_BEFORE = 0.004;
const FADE_OUT = 0.08;
const FADE_IN = 0.002;
const LOOP_RMS_DB = -16;
const LOOP_PAD = 0.1;
/** Fondu enchaîné d'une boucle : une part de sa durée, sans dépasser une seconde. */
const CROSSFADE_SHARE = 0.06;
const CROSSFADE_MAX = 1;
const MUSIC_CROSSFADE = 3;
/** Rognage d'un morceau : on garde ce qui n'est pas à plus de MUSIC_DIP dB sous son niveau médian (fenêtres de MUSIC_WINDOW s). */
const MUSIC_DIP = 6;
const MUSIC_WINDOW = 0.5;

const dbToGain = (db) => 10 ** (db / 20);

/** Décode un fichier en échantillons (entrelacés s'il y a deux voies), à la fréquence voulue. */
function decode(file, rate, channels) {
  const out = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", String(channels), "-ar", String(rate), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

/** Rééchantillonne des échantillons. */
function resample(pcm, from, to, channels) {
  const out = execFileSync("ffmpeg", ["-v", "error", "-f", "f32le", "-ar", String(from), "-ac", String(channels), "-i", "-", "-ar", String(to), "-f", "f32le", "-"], {
    input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), maxBuffer: 1 << 28,
  });
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

function sourceRate(file) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", file]).toString().trim());
}

/** Son ponctuel (échantillons entrelacés s'il y a deux voies) : silences retirés, fondus. */
function oneShot(pcm, channels = 1) {
  const onset = dbToGain(ONSET_DB);
  const tail = dbToGain(TAIL_DB);
  const frames = pcm.length / channels;
  const loud = (f, limit) => {
    for (let c = 0; c < channels; c++) if (Math.abs(pcm[f * channels + c]) > limit) return true;
    return false;
  };
  let first = 0;
  while (first < frames && !loud(first, onset)) first++;
  if (first === frames) first = 0;
  first = Math.max(0, first - Math.round(KEEP_BEFORE * RATE));
  let last = frames - 1;
  while (last > first && !loud(last, tail)) last--;
  const out = pcm.slice(first * channels, (last + 1) * channels);
  const n = out.length / channels;
  const fadeIn = Math.min(n, Math.round(FADE_IN * RATE));
  const fadeOut = Math.min(n, Math.round(FADE_OUT * RATE));
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < fadeIn; i++) out[i * channels + c] *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) out[(n - 1 - i) * channels + c] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut);
  }
  return out;
}

/** Boucle : trois copies bout à bout rééchantillonnées, celle du milieu, puis le fondu enchaîné. */
function loopable(file, channels, music) {
  const rate = sourceRate(file);
  const pcm = decode(file, rate, channels);
  const tiled = new Float32Array(pcm.length * 3);
  for (let k = 0; k < 3; k++) tiled.set(pcm, k * pcm.length);
  const all = resample(tiled, rate, RATE, channels);
  const length = Math.round((pcm.length / channels) * RATE / rate) * channels;
  const one = all.slice(length, 2 * length);
  return music ? crossfade(trimMusic(one, channels), channels, MUSIC_CROSSFADE) : crossfade(one, channels, null);
}

/** Garde d'un morceau la partie à son niveau établi : sans l'introduction qui monte ni la fin qui s'éteint. */
function trimMusic(pcm, channels) {
  const win = Math.round(MUSIC_WINDOW * RATE) * channels;
  const levels = [];
  for (let i = 0; i + win <= pcm.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += pcm[j] * pcm[j];
    levels.push(10 * Math.log10(Math.max(sum / win, 1e-12)));
  }
  const median = [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 2)];
  const first = levels.findIndex((l) => l >= median - MUSIC_DIP);
  let last = levels.length - 1;
  while (last > first && levels[last] < median - MUSIC_DIP) last--;
  return pcm.slice(first * win, (last + 1) * win);
}

/**
 * Mêle la fin d'une boucle à son début : la boucle raccourcit de la durée du fondu, et sa
 * dernière image précède directement la première, qui est celle qui suivait dans l'original.
 * À puissance constante (sinus, cosinus) : des bruits sans rapport entre eux ne creusent pas.
 */
function crossfade(pcm, channels, seconds) {
  const frames = pcm.length / channels;
  const fade = Math.round((seconds ?? Math.min(CROSSFADE_MAX, (frames / RATE) * CROSSFADE_SHARE)) * RATE);
  const out = pcm.slice(0, (frames - fade) * channels);
  for (let i = 0; i < fade; i++) {
    const a = (Math.PI / 2) * (i / fade);
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] = pcm[i * channels + c] * Math.sin(a) + pcm[(frames - fade + i) * channels + c] * Math.cos(a);
    }
  }
  return out;
}

/** Marges d'une boucle : sa fin avant son début, son début après sa fin (voir plus haut). */
function pad(pcm, channels) {
  const n = Math.round(LOOP_PAD * RATE) * channels;
  const out = new Float32Array(pcm.length + 2 * n);
  out.set(pcm.subarray(pcm.length - n), 0);
  out.set(pcm, n);
  out.set(pcm.subarray(0, n), n + pcm.length);
  return out;
}

/**
 * Ramène la crête à PEAK_DB (son ponctuel), ou le niveau moyen à LOOP_RMS_DB sans dépasser cette
 * crête (boucle) ; renvoie le gain appliqué (dB).
 */
function normalize(pcm, loop) {
  let peak = 0;
  let sum = 0;
  for (const x of pcm) {
    peak = Math.max(peak, Math.abs(x));
    sum += x * x;
  }
  const rms = Math.sqrt(sum / pcm.length);
  const byPeak = dbToGain(PEAK_DB) / Math.max(peak, 1e-6);
  const gain = loop ? Math.min(byPeak, dbToGain(LOOP_RMS_DB) / Math.max(rms, 1e-6)) : byPeak;
  for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
  return 20 * Math.log10(gain);
}

function encode(pcm, out, channels, music) {
  const rate = music ? "112k" : channels > 1 ? "96k" : "64k";
  // bitexact : sans lui, l'Ogg tire un numéro de flux au hasard et chaque préparation réécrirait tous les fichiers
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", String(RATE), "-ac", String(channels), "-i", "-", "-c:a", "libopus", "-b:a", rate,
    "-fflags", "+bitexact", "-flags:a", "+bitexact", out], {
    input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
  });
}

const catalog = JSON.parse(readFileSync("tools/sounds/catalog.json", "utf8"));
const only = process.argv.slice(2);
const unknown = only.filter((key) => !(key in catalog.sounds));
if (unknown.length) {
  console.error(`Sons absents du catalogue : ${unknown.join(", ")}`);
  process.exit(1);
}
mkdirSync("public/sounds", { recursive: true });
for (const [key, sound] of Object.entries(catalog.sounds)) {
  if (only.length && !only.includes(key)) continue;
  sound.keep.forEach((name, i) => {
    const src = `tools/sounds/raw/${key}/${name}.mp3`;
    const out = `public/sounds/${key}-${i + 1}.ogg`;
    // Un bruitage ponctuel est mono (le jeu le place dans l'arène) ; ambiances et musique en stéréo
    const channels = sound.stereo ? 2 : 1;
    const pcm = sound.loop ? loopable(src, channels, !!sound.music) : oneShot(decode(src, RATE, channels), channels);
    const gain = normalize(pcm, !!sound.loop);
    encode(sound.loop ? pad(pcm, channels) : pcm, out, channels, !!sound.music);
    const seconds = pcm.length / channels / RATE;
    console.log(`${out.padEnd(36)} ${seconds.toFixed(2)} s, gain ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB, ${(statSync(out).size / 1024).toFixed(1)} Ko`);
  });
}
