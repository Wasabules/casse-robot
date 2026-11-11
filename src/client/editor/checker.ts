import type { MapFile, MapIssue } from "../../shared/map/format";
import { checkMap } from "../../shared/map/validate";
import type { CheckReply, CheckRequest } from "./checkWorker";

/*
 * Les problèmes de la carte qu'on modifie, revus après chaque modification : un délai d'attente
 * (on ne vérifie pas à chaque touche d'un champ), puis la vérification dans un Worker
 * (editor/checkWorker.ts). Une seule à la fois ; une modification pendant ce temps est vérifiée
 * ensuite (la dernière seulement). Sans Worker, sur le fil de la page.
 */

/** Délai entre la dernière modification et la vérification (ms). */
const WAIT = 350;

export class MapChecker {
  private worker: Worker | null = null;
  private timer: number | undefined;
  private busy = false;
  private next: MapFile | null = null;
  private id = 0;
  private sent: MapFile | null = null;
  /** La carte vérifiée et ses problèmes ; `ms` : le temps de la vérification. */
  onResult: (map: MapFile, issues: readonly MapIssue[], ms: number) => void = () => {};

  constructor() {
    try {
      this.worker = new Worker(new URL("./checkWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<CheckReply>) => this.reply(e.data);
      this.worker.onerror = (e) => {
        console.warn("Éditeur de cartes : la vérification dans un Worker a échoué, elle se fera sur la page", e.message);
        this.worker?.terminate();
        this.worker = null;
        this.busy = false;
        if (this.sent) this.request(this.sent, 0);
      };
    } catch (e) {
      console.warn("Éditeur de cartes : pas de Worker, la vérification se fera sur la page", e);
      this.worker = null;
    }
  }

  /** Vérifier cette carte (après le délai d'attente, `wait` ms). */
  request(map: MapFile, wait = WAIT): void {
    this.next = map;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.send(), wait);
  }

  /** En attente, ou en cours ? */
  get pending(): boolean {
    return this.busy || this.next !== null;
  }

  private send(): void {
    if (this.busy || !this.next) return;
    const map = this.next;
    this.next = null;
    this.busy = true;
    this.sent = map;
    const id = ++this.id;
    if (this.worker) {
      this.worker.postMessage({ id, map } satisfies CheckRequest);
      return;
    }
    // Sans Worker : sur la page, après avoir rendu la main
    window.setTimeout(() => {
      const start = performance.now();
      this.reply({ id, issues: checkMap(map).issues, ms: performance.now() - start });
    }, 0);
  }

  private reply(r: CheckReply): void {
    if (r.id !== this.id || !this.sent) return;
    const map = this.sent;
    this.busy = false;
    this.sent = null;
    this.onResult(map, r.issues, r.ms);
    if (this.next) this.send();
  }

  /** Arrête tout (le Worker compris). */
  dispose(): void {
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    this.next = null;
    this.sent = null;
    this.onResult = () => {};
  }
}
