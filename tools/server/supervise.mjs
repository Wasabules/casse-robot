#!/usr/bin/env node
/*
 * Superviseur du serveur de jeu (`npm run server:supervised`) : lance le serveur compilé
 * (dist-server/main.js, ou le script donné en argument, avec ses arguments) et le relance s'il
 * s'arrête sur une erreur, après un délai qui double à chaque arrêt rapproché (1 s, 2 s, 4 s… au plus
 * une minute ; un serveur qui a tenu une minute repart du premier délai). Chaque arrêt et chaque
 * relance sont journalisés.
 *
 * Le serveur se relève déjà de lui-même d'une panique de la simulation (server/roomHost.ts : la salle
 * relancée, puis le repli sur la simulation du TypeScript) ; il ne s'arrête, avec le code 1, que sur
 * ce qu'il ne sait pas rattraper (une erreur hors de la salle, la simulation du TypeScript qui s'arrête
 * trois fois en dix minutes, une salle neuve qui ne se crée pas), après avoir enregistré la progression
 * des joueurs. Un arrêt demandé (Ctrl+C, SIGTERM : code 0) arrête aussi le superviseur. Sans dépendance :
 * Node seul. SUPERVISE_DELAY : le premier délai (s ; les essais le raccourcissent).
 */
import { spawn } from "node:child_process";

/** Premier délai avant de relancer (s), délai le plus long, et durée après laquelle un serveur est tenu pour stable. */
const FIRST_DELAY = Number(process.env.SUPERVISE_DELAY) || 1;
const MAX_DELAY = 60;
const STABLE = 60;
/** Sous Windows, tuer un processus ne le prévient pas : on laisse au serveur le temps de s'arrêter seul (Ctrl+C lui parvient aussi). */
const GRACE = 5;

const [script = "dist-server/main.js", ...args] = process.argv.slice(2);
let delay = FIRST_DELAY;
let restarts = 0;
let stopping = false;
/** @type {import("node:child_process").ChildProcess | null} */
let child = null;

const say = (text) => console.log(`[superviseur ${new Date().toISOString()}] ${text}`);

function start() {
  const born = Date.now();
  const proc = spawn(process.execPath, [script, ...args], { stdio: "inherit", env: process.env });
  child = proc;
  say(`serveur lancé (${script}, pid ${proc.pid})`);
  let ended = false;
  const end = (code, signal, error) => {
    if (ended) return;
    ended = true;
    child = null;
    const uptime = (Date.now() - born) / 1000;
    if (stopping) {
      say("serveur arrêté : le superviseur s'arrête aussi");
      process.exit(0);
    }
    if (code === 0) {
      say(`le serveur s'est arrêté normalement (après ${uptime.toFixed(1)} s) : pas de relance`);
      process.exit(0);
    }
    if (uptime >= STABLE) delay = FIRST_DELAY;
    restarts++;
    const why = error ? `ne démarre pas : ${error.message}` : signal ? `arrêté par le signal ${signal}` : `arrêté avec le code ${code}`;
    say(`serveur ${why}, après ${uptime.toFixed(1)} s : relance n° ${restarts} dans ${delay} s`);
    setTimeout(start, delay * 1000);
    delay = Math.min(MAX_DELAY, delay * 2);
  };
  proc.on("exit", (code, signal) => end(code, signal, null));
  proc.on("error", (error) => end(null, null, error));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const proc = child;
    if (!proc) process.exit(0);
    say(`${signal} : arrêt du serveur`);
    if (process.platform !== "win32") proc.kill(signal);
    else setTimeout(() => proc.kill(), GRACE * 1000).unref();
  });
}

start();
