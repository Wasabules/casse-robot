import type { SimulationEngine } from "../shared/native/choice";
import type { Connection, Player, RoomBase, RoomOptions } from "./room";

/*
 * L'hôte de la salle du serveur : il la fait tourner et la relance quand elle s'arrête sur une erreur.
 * Une panique du module de la simulation Rust (un piège WebAssembly `unreachable`) ou une exception de
 * la simulation du TypeScript, dans le pas de la salle ou en traitant un message d'un client, ne fait
 * plus tomber le serveur : l'hôte la journalise (ce que la simulation en sait, l'arène, le mode, le
 * temps de la partie), jette la salle (une instance du module qui a paniqué est inutilisable) et en
 * crée une neuve (une instance neuve du module, server/main.ts), dans l'arène suivante de la rotation.
 * Les clients connectés y passent tels quels : ceux qui avaient rejoint gardent leur nom, leur robot,
 * leur équipe et leur jeton, entrent dans la première partie de la nouvelle salle, et leur image
 * suivante décrit le monde neuf en disant à leur réplique d'oublier l'ancien (`FrameHeader.reset`,
 * que le client sait déjà lire : c'est ainsi que la partie solo change de monde). La progression des
 * joueurs (`ProgressBook`) est celle du serveur, que la nouvelle salle reprend : rien ne s'y perd, et
 * la partie interrompue rapporte ce qu'elle avait rapporté (partie jouée, destructions : `rewardInterrupted`).
 *
 * La simulation Rust qui panique `CRASH_LIMIT` fois en `CRASH_WINDOW` s laisse la place à celle du
 * TypeScript pour le reste de la vie du processus. Si celle du TypeScript s'arrête aussi souvent, ou
 * si la salle neuve ne se crée pas, l'hôte abandonne (`onGiveUp`) : server/main.ts enregistre la
 * progression et termine le processus, qu'un superviseur relance (tools/server/supervise.mjs). La
 * salle ne connaît pas le transport : l'hôte non plus (tests/roomHost.test.ts le fait tourner sans réseau).
 */

/** Au plus tant de pannes d'une simulation en `CRASH_WINDOW` s : au-delà, la Rust passe la main au TypeScript, le TypeScript abandonne. */
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW = 10 * 60;

/** Fabrique une salle sur cette simulation (la Rust : sur une instance neuve du module). */
export type RoomMaker = (engine: SimulationEngine, options: RoomOptions) => RoomBase<unknown>;

/** Ce que l'hôte journalise. */
export type HostLog = Pick<Console, "log" | "warn" | "error">;

/** Une panne de la salle, telle que l'hôte l'a vue. */
export interface RoomCrash {
  /** Ce que la simulation en sait (le message d'une panique), et ce que faisait la salle. */
  readonly message: string;
  readonly during: "step" | "message" | "leave";
  readonly engine: SimulationEngine;
  readonly arena: string;
  /** Temps simulé de la partie interrompue (s), et l'heure de la panne (ms, l'horloge de l'hôte). */
  readonly matchTime: number;
  readonly at: number;
}

/** L'état de l'hôte (`/status`, le journal). */
export interface HostStatus {
  /** La simulation qui tourne, et celle demandée au démarrage (différentes après le repli sur le TypeScript). */
  readonly engine: SimulationEngine;
  readonly asked: SimulationEngine;
  /** Salles relancées après une erreur, et la dernière panne. */
  readonly restarts: number;
  readonly lastCrash: RoomCrash | null;
  /** L'hôte a abandonné : le processus va s'arrêter. */
  readonly gaveUp: boolean;
  readonly players: number;
}

export interface HostOptions {
  /** Horloge (ms) : celle du système, ou celle d'un test. */
  readonly clock?: () => number;
  /** Où l'hôte journalise (la console, ou celle d'un test). */
  readonly console?: HostLog;
  /** L'hôte abandonne (la salle ne se relance pas) : pourquoi. */
  readonly onGiveUp?: (reason: string) => void;
  /**
   * Outil d'essai (`SIM_FAULT`, server/main.ts) : une vraie panne de la simulation (`provokeFault`)
   * après `after` s de temps simulé dans chaque salle, `count` fois en tout.
   */
  readonly fault?: { readonly after: number; readonly count: number } | null;
}

const ENGINE_NAMES: Record<SimulationEngine, string> = { rust: "Rust", ts: "TypeScript" };
/** Ce que faisait la salle, dans le journal. */
const DURING: Record<RoomCrash["during"], string> = { step: "pas", message: "message", leave: "départ" }; // i18n-ignore (le journal du serveur)

export class RoomHost {
  /** La salle qui tourne. */
  room: RoomBase<unknown>;
  /** La simulation des salles qu'on crée (la Rust, jusqu'au repli sur celle du TypeScript). */
  engine: SimulationEngine;
  readonly asked: SimulationEngine;
  restarts = 0;
  lastCrash: RoomCrash | null = null;
  gaveUp = false;
  private readonly make: RoomMaker;
  private readonly options: RoomOptions;
  private readonly clock: () => number;
  private readonly console: HostLog;
  private readonly onGiveUp: (reason: string) => void;
  private readonly fault: { readonly after: number; readonly count: number } | null;
  private faultsLeft: number;
  /** L'heure des pannes récentes de chaque simulation (ms). */
  private readonly crashes: Record<SimulationEngine, number[]> = { rust: [], ts: [] };

  constructor(make: RoomMaker, engine: SimulationEngine, options: RoomOptions, host: HostOptions = {}) {
    this.make = make;
    this.options = options;
    this.engine = engine;
    this.asked = engine;
    this.clock = host.clock ?? Date.now;
    this.console = host.console ?? console;
    this.onGiveUp = host.onGiveUp ?? (() => {});
    this.fault = host.fault ?? null;
    this.faultsLeft = this.fault?.count ?? 0;
    // (la première salle qui ne se crée pas arrête le serveur au démarrage, comme avant)
    this.room = make(engine, options);
  }

  get playerCount(): number {
    return this.room.playerCount;
  }

  /** Un client se connecte : un joueur de la salle (qui passera dans la suivante si elle s'arrête). */
  connect(conn: Connection): Player<unknown> {
    return this.room.connect(conn);
  }

  receive(player: Player<unknown>, text: string): void {
    if (this.gaveUp) return;
    try {
      this.room.receive(player, text);
    } catch (e) {
      this.recover(e, "message");
    }
  }

  disconnect(player: Player<unknown>): void {
    if (this.gaveUp) return;
    try {
      this.room.disconnect(player);
    } catch (e) {
      this.recover(e, "leave");
    }
  }

  /** Un pas de la salle ; une erreur la fait relancer. */
  tick(): void {
    if (this.gaveUp) return;
    const room = this.room;
    try {
      if (this.fault && this.faultsLeft > 0 && room.elapsed >= this.fault.after) {
        this.faultsLeft--;
        this.console.warn(`SIM_FAULT : panne d'essai de la salle (simulation ${ENGINE_NAMES[this.engine]}, ${this.faultsLeft} restante(s))`);
        room.provokeFault();
      }
      room.tick();
    } catch (e) {
      this.recover(e, "step");
    }
  }

  status(): HostStatus {
    return { engine: this.engine, asked: this.asked, restarts: this.restarts, lastCrash: this.lastCrash, gaveUp: this.gaveUp, players: this.playerCount };
  }

  /** L'état, en une ligne (le journal, `/status`). */
  describe(): string {
    const parts = [`simulation ${ENGINE_NAMES[this.engine]}`];
    if (this.engine !== this.asked) parts.push(`repli après ${CRASH_LIMIT} pannes de la simulation ${ENGINE_NAMES[this.asked]}`); // i18n-ignore (pour l'hébergeur)
    parts.push(`${this.restarts} redémarrage(s) de la salle`); // i18n-ignore
    const c = this.lastCrash;
    if (c) parts.push(`dernière panne il y a ${Math.round((this.clock() - c.at) / 1000)} s (${ENGINE_NAMES[c.engine]}, ${c.arena}) : ${c.message}`); // i18n-ignore
    return parts.join(", ");
  }

  /** La salle s'est arrêtée sur une erreur : on la journalise, on la jette, et une salle neuve reprend ses clients. */
  private recover(e: unknown, during: RoomCrash["during"]): void {
    const failed = this.room;
    const engine = this.engine;
    const where = failed.summary();
    let message: string;
    try {
      message = failed.explain(e);
    } catch {
      message = String(e);
    }
    // (sur une ligne : le message d'une panique en a deux)
    message = message.replace(/\s*\n\s*/g, " ");
    const at = this.clock();
    this.lastCrash = { message, during, engine, arena: where.arena, matchTime: where.matchTime, at };
    const what = `${DURING[during]} ; simulation ${ENGINE_NAMES[engine]}, arène ${where.arena}, mode ${where.mode}, partie à ${where.matchTime.toFixed(1)} s, salle à ${where.time.toFixed(1)} s, ${where.players} joueur(s)`; // i18n-ignore
    this.console.error(`Salle arrêtée sur une erreur (${what}) : ${message}`);
    if (e instanceof Error && e.stack) this.console.error(e.stack);
    const players = failed.connected;
    // La partie interrompue rapporte ce qu'elle avait déjà rapporté (partie jouée, destructions)
    try {
      failed.rewardInterrupted();
    } catch (again) {
      this.console.error(`Les crédits de la partie interrompue ne sont pas donnés : ${again instanceof Error ? again.message : String(again)}`);
    }
    try {
      failed.dispose();
    } catch {
      // (une instance du module qui a paniqué ne répond plus : elle part avec la salle)
    }
    if (!this.count(engine, at)) return;
    for (;;) {
      try {
        this.room = this.make(this.engine, { ...this.options, carry: { players, arena: where.arenaRank } });
        this.restarts++;
        this.console.warn(`Salle relancée (simulation ${ENGINE_NAMES[this.engine]}, redémarrage n° ${this.restarts}) : ${this.room.playerCount} joueur(s) reprennent dans une partie neuve, arène ${this.room.summary().arena}`);
        return;
      } catch (again) {
        const why = again instanceof Error ? again.message : String(again);
        this.console.error(`La salle neuve ne se crée pas (simulation ${ENGINE_NAMES[this.engine]}) : ${why}`);
        if (again instanceof Error && again.stack) this.console.error(again.stack);
        if (!this.count(this.engine, this.clock())) return;
      }
    }
  }

  /**
   * Compte une panne de cette simulation : trop de pannes de la Rust, et l'hôte passe à celle du
   * TypeScript ; trop de pannes de celle du TypeScript, et il abandonne (faux).
   */
  private count(engine: SimulationEngine, at: number): boolean {
    const recent = this.crashes[engine].filter((t) => at - t < CRASH_WINDOW * 1000);
    recent.push(at);
    this.crashes[engine] = recent;
    if (recent.length < CRASH_LIMIT) return true;
    if (engine === "rust") {
      this.engine = "ts";
      this.console.warn(`${CRASH_LIMIT} pannes de la simulation Rust en ${CRASH_WINDOW / 60} min : la salle passe sur celle du TypeScript pour la vie du processus`);
      return true;
    }
    this.gaveUp = true;
    const reason = `${CRASH_LIMIT} pannes de la simulation ${ENGINE_NAMES[engine]} en ${CRASH_WINDOW / 60} min`; // i18n-ignore (le journal du serveur)
    this.console.error(`La salle ne se relance plus (${reason})`);
    this.onGiveUp(reason);
    return false;
  }
}
