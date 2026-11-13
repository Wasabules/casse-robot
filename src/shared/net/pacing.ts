import type { PlayerInput } from "../sim/input";
import { INPUT_RATE, INTERP_DELAY } from "./protocol";

/*
 * Le rythme d'un client en réseau : quand afficher ce qu'il reçoit, quand envoyer ce qu'il commande.
 *
 * Le retard d'affichage (`DelayTuner`, `Replica.delay`) : la réplique montre le monde `delay` derrière
 * la dernière image reçue, et interpole entre deux images ; il faut que la suivante soit là quand
 * l'instant affiché l'atteint. Avec des images régulières, un intervalle entre deux images y suffit ;
 * ce qui s'y ajoute couvre leurs à-coups (la gigue : le réseau, le serveur qui envoie au pas près, le
 * client occupé). On note, pour chaque image, quand elle arrive par rapport à son temps (`arrive`) : sur
 * les dernières, la vitesse du temps du serveur (`rate` : il peut décrocher du temps réel), puis, à ce
 * rythme, le retard de chacune sur la plus rapide. Le retard d'affichage : un intervalle, le plus grand
 * de ces retards, et une marge ; il monte tout de suite (une image en retard), et redescend doucement
 * (la réplique rattrape l'écart sans à-coup : net/replica.ts).
 *
 * Les commandes (`InputPacer`) : une touche qui change part à l'image même ; le reste (la visée, le
 * regard, qui bougent à chaque image) à `INPUT_RATE` par seconde, comme avant.
 */

/** Combien d'images on garde pour juger la gigue (~3 s à 20 images par seconde). */
const WINDOW = 60;
/** Marge au-delà de la gigue mesurée (s). */
const MARGIN = 0.012;
/** Au plus (s) : au-delà, la liaison est mauvaise, et un retard plus long ne la rend pas meilleure. */
const MAX_DELAY = 0.35;
/** Part de l'écart dont le retard redescend à chaque image (il monte d'un coup). */
const SETTLE = 0.05;

export class DelayTuner {
  /** Le retard d'affichage à donner à la réplique (s de temps du serveur). */
  delay = INTERP_DELAY;
  /**
   * La vitesse du temps du serveur par rapport à l'horloge du client (`Replica.rate`) : 1 quand il tient
   * le temps réel ; moins quand il décroche (une machine trop chargée simule moins vite). Sans elle, la
   * réplique avancerait plus vite que ce qu'elle reçoit, et cet écart qui grandit passerait pour de la gigue.
   */
  rate = 1;
  /** Les dernières images : quand elles sont arrivées (horloge du client), et leur temps (serveur). */
  private readonly arrivals: { now: number; time: number }[] = [];

  /** Une image du temps simulé `time` (s) arrive à l'instant `now` (s, l'horloge du client). */
  arrive(now: number, time: number): void {
    if (!Number.isFinite(now) || !Number.isFinite(time)) return;
    const last = this.arrivals.at(-1);
    // (un saut : une partie qui repart de zéro, une horloge qui recule : ce qui précède ne dit plus rien)
    if (last && (time <= last.time || time - last.time > 1 || now < last.now)) this.arrivals.length = 0;
    this.arrivals.push({ now, time });
    if (this.arrivals.length > WINDOW) this.arrivals.shift();
    const n = this.arrivals.length;
    if (n < 8) return;
    // La vitesse : la pente du temps du serveur selon l'horloge du client (moindres carrés sur la fenêtre)
    let mx = 0;
    let my = 0;
    for (const a of this.arrivals) {
      mx += a.now / n;
      my += a.time / n;
    }
    let sxy = 0;
    let sxx = 0;
    for (const a of this.arrivals) {
      sxy += (a.now - mx) * (a.time - my);
      sxx += (a.now - mx) * (a.now - mx);
    }
    this.rate = sxx > 0 ? Math.min(MAX_RATE, Math.max(MIN_RATE, sxy / sxx)) : 1;
    // Le retard de chaque image sur ce rythme (horloge du client), et l'écart entre deux images
    let early = Infinity;
    let late = -Infinity;
    const gaps: number[] = [];
    this.arrivals.forEach((a, k) => {
      const offset = a.now - a.time / this.rate;
      early = Math.min(early, offset);
      late = Math.max(late, offset);
      if (k) gaps.push((a.time - this.arrivals[k - 1].time) / this.rate);
    });
    // Ce qu'il faut d'avance (horloge du client), en temps du serveur
    const want = Math.min(MAX_DELAY, (median(gaps) + late - early + MARGIN) * this.rate);
    this.delay = want > this.delay ? want : this.delay + (want - this.delay) * SETTLE;
  }
}

/** Bornes de la vitesse du temps du serveur qu'on croit (au-delà : une mesure aberrante). */
const MIN_RATE = 0.25;
const MAX_RATE = 2;

function median(list: readonly number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Au plus un envoi par… (s) : un manche analogique qui bouge à chaque image ne part pas plus souvent. */
const MIN_GAP = 1 / 60;

/** Ce qui, dans les commandes, est une touche (ou un manche) : ce qui part dès qu'il change. */
function keysOf(i: PlayerInput): string {
  const r = (x: number): number => Math.round(x * 10);
  return `${r(i.throttle)},${r(i.steer)},${r(i.climb)},${r(i.brake)},${r(i.yaw)},${r(i.power)},${+i.boost}${+i.trigger}${+i.scope}${+i.relative}${+i.detonate}${+i.flares}${+i.manual},${i.weapon}`;
}

export class InputPacer {
  private timer = 0;
  private since = Infinity;
  private sent = "";

  /** Le temps passe de `dt` (s) : faut-il envoyer les commandes `input` maintenant ? */
  due(dt: number, input: PlayerInput): boolean {
    this.timer -= dt;
    this.since += dt;
    const keys = keysOf(input);
    if (this.timer > 0 && (keys === this.sent || this.since < MIN_GAP)) return false;
    this.timer = 1 / INPUT_RATE;
    this.since = 0;
    this.sent = keys;
    return true;
  }
}
