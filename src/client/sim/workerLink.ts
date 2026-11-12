import { arenaById } from "../../shared/arena/layout";
import { STEP } from "../../shared/config";
import type { ClientMessage } from "../../shared/net/protocol";
import { Replica } from "../../shared/net/replica";
import type { SessionCommand } from "../../shared/net/session";
import type { WorkerReply } from "./simWorker";

/*
 * La partie solo dans un Worker (client/sim/simWorker.ts) : le jeu lui envoie des commandes
 * (`SessionCommand` : une partie, les commandes du joueur, le temps qui avance…) et rejoue ses images
 * dans une réplique, comme une partie en réseau, mais avec un retard d'interpolation court
 * (`LOCAL_DELAY`) : le fil du rendu ne fait plus la simulation. Ce que le jeu dit au serveur de jeu
 * (`send` : ses commandes, se saborder) se traduit en commandes de la session.
 */

/**
 * Retard de l'instant affiché sur la dernière image du Worker (s) : il en arrive une à chaque image
 * dessinée qui a vu tomber un pas ; deux pas et demi couvrent l'écart entre deux images jusqu'à
 * ~40 images par seconde.
 */
export const LOCAL_DELAY = 2.5 * STEP;

export class WorkerLink {
  readonly replica = new Replica();
  /** Le Worker a échoué (une erreur de la simulation, un Worker qui ne démarre pas). */
  onFail: ((reason: string) => void) | null = null;
  private readonly worker: Worker;
  private closed = false;
  /** Nouveaux mondes demandés (une partie, une vague) : la réplique les a tous quand elle en a reçu autant. */
  private worlds = 0;
  /** Les arènes dont le Worker a déjà reçu le fichier (une grande arène du jeu, une carte communautaire) : il les garde. */
  private readonly given = new Set<string>();

  constructor() {
    this.replica.delay = LOCAL_DELAY;
    // Les cartes communautaires que le jeu a fait connaître (la bibliothèque, l'éditeur) : la réplique les y trouve
    this.replica.resolveArena = (key) => arenaById(key);
    this.worker = new Worker(new URL("./simWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      if (e.data instanceof ArrayBuffer) this.replica.receive(new Uint8Array(e.data));
      else this.fail(e.data.error);
    };
    this.worker.onerror = (e) => this.fail(e.message || "le Worker de la simulation ne démarre pas"); // i18n-ignore (pour la console)
  }

  /** Une commande pour la session. */
  command(cmd: SessionCommand): void {
    if (this.closed) return;
    if (cmd.t === "start" || cmd.t === "spawn") this.worlds++;
    // Le fichier d'une arène part une fois (celui du Canyon pèse ~590 Ko)
    if (cmd.t === "start" && cmd.map) {
      if (this.given.has(cmd.arena)) cmd = { ...cmd, map: undefined };
      else this.given.add(cmd.arena);
    }
    this.worker.postMessage(cmd);
  }

  /** Le dernier monde demandé est arrivé dans la réplique. */
  get arrived(): boolean {
    return this.replica.resets >= this.worlds;
  }

  /** Ce que le jeu dit au serveur de jeu, en commandes de la session (l'interface de `NetClient`). */
  send(msg: ClientMessage): void {
    if (msg.t === "input") this.command({ t: "input", input: msg.input, aim: null });
    else if (msg.t === "selfDestruct") this.command({ t: "selfDestruct" });
  }

  close(): void {
    this.closed = true;
    this.worker.terminate();
  }

  private fail(reason: string): void {
    console.error("Simulation dans le Worker :", reason);
    this.onFail?.(reason);
  }
}
