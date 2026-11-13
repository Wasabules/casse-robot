import type { SessionCommand, SessionLike } from "../../shared/net/session";
// La simulation compilée entière (Rapier compris, ~3 Mo) : un fichier à part, téléchargé seulement
// quand c'est la simulation Rust qui tourne
import simWasmUrl from "../../shared/native/casse-sim.wasm?url";
// Les petites arènes du jeu, dont le Dépôt où naît la session ; les grandes viennent avec la partie (`start`)
import "../maps/smallArenas";

/*
 * La simulation de la partie solo, hors du fil du rendu (un Worker) : reçoit les commandes du jeu
 * (`SessionCommand`), rend ses images (des `ArrayBuffer` transférés, comme les images binaires du
 * serveur de jeu) que le jeu rejoue dans une réplique (client/sim/workerLink.ts). Une erreur de la
 * session est renvoyée (`{ error }`) plutôt que d'arrêter le Worker en silence.
 *
 * La simulation est celle portée en Rust (`NativeSession`, src/shared/native/session.ts) quand le
 * Worker s'appelle « rust » (son nom, `WorkerLink`), celle du TypeScript (`LocalSession`) quand il
 * s'appelle « ts » : les mêmes images, octet pour octet. Chacune est un morceau chargé à la demande
 * (client/sim/rustSession.ts, tsSession.ts) : la partie en Rust ne télécharge ni la simulation du
 * TypeScript ni Rapier pour le JavaScript (~4,2 Mo). Si la simulation Rust ne se charge pas (son
 * module introuvable, un navigateur qui le refuse), le Worker prend celle du TypeScript et le dit
 * (`{ engine: "ts" }`).
 */

/** La simulation que fait tourner le Worker. */
export type SimEngine = "ts" | "rust";

/** Ce qu'a coûté le démarrage du Worker (ms depuis son lancement), et la mémoire de la simulation compilée. */
export interface WorkerStats {
  readonly engine: SimEngine;
  /**
   * Les étapes du démarrage (ms depuis le lancement du Worker) : le morceau de la session chargé
   * (`chunk`), le module téléchargé (`fetched`) et instancié (`instantiated` : la simulation Rust), la
   * session prête (`ready`).
   */
  readonly boot: Readonly<Record<string, number>>;
  /** Ce que la simulation Rust a refusé, quand le Worker est passé à celle du TypeScript. */
  readonly fallback: string | null;
  /** La mémoire du module de la simulation Rust (octets), null pour celle du TypeScript. */
  readonly wasmMemory: number | null;
}

/** Ce que le Worker renvoie : une image, une erreur, la simulation qui tourne (après un repli), ses mesures. */
export type WorkerReply = ArrayBuffer | { error: string } | { engine: SimEngine } | { stats: WorkerStats };

/** Ce que le Worker reçoit : une commande de la session, ou une demande de ses mesures (la console, `npm run perf`). */
export type WorkerMessage = SessionCommand | { t: "stats" };

const scope = self as unknown as {
  readonly name?: string;
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(reply: WorkerReply, transfer?: Transferable[]): void;
};

let engine: SimEngine = scope.name === "rust" ? "rust" : "ts";
let session: SessionLike | null = null;
let failed = false;
let fallback: string | null = null;
/** Les étapes du démarrage (ms depuis le lancement du Worker). */
const boots: Record<string, number> = {};
let wasmMemory: (() => number) | null = null;
/** Ce que le module de la simulation Rust sait d'une erreur (une panique : son message). */
let explain: (e: unknown) => string = (e) => (e instanceof Error ? e.message : String(e));
const waiting: SessionCommand[] = [];

function fail(e: unknown): void {
  scope.postMessage({ error: `${explain(e)}\n${e instanceof Error ? e.stack ?? "" : ""}` });
}

function handle(cmd: SessionCommand): void {
  try {
    for (const frame of session!.handle(cmd)) {
      // L'image a son propre tampon : il part sans copie
      const buffer = frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength ? frame.buffer : frame.slice().buffer;
      scope.postMessage(buffer as ArrayBuffer, [buffer as ArrayBuffer]);
    }
  } catch (e) {
    fail(e);
  }
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.t === "stats") {
    scope.postMessage({ stats: { engine, boot: { ...boots }, fallback, wasmMemory: wasmMemory?.() ?? null } });
    return;
  }
  if (session) handle(msg);
  else if (!failed) waiting.push(msg);
};

const now = (): number => performance.now();

/** La session du TypeScript (son morceau chargé à la demande, avec Rapier). */
async function tsSession(): Promise<SessionLike> {
  const { startTsSession } = await import("./tsSession");
  boots.chunk = now();
  return startTsSession(now);
}

/** La session de la simulation portée en Rust (son morceau, puis son module téléchargé et instancié). */
async function rustSession(): Promise<SessionLike> {
  const { startRustSession } = await import("./rustSession");
  boots.chunk = now();
  const { session, module, fetched, instantiated } = await startRustSession(simWasmUrl, now);
  boots.fetched = fetched;
  boots.instantiated = instantiated;
  wasmMemory = () => module.x.memory.buffer.byteLength;
  explain = (e) => module.explain(e);
  return session;
}

/** La session : celle de la simulation choisie ; la Rust qui ne se charge pas laisse la place à celle du TypeScript. */
async function boot(): Promise<SessionLike> {
  if (engine === "ts") return tsSession();
  try {
    return await rustSession();
  } catch (e) {
    fallback = e instanceof Error ? e.message : String(e);
    console.warn("Simulation Rust indisponible, celle du TypeScript la remplace :", e);
    engine = "ts";
    scope.postMessage({ engine });
    return tsSession();
  }
}

boot().then(
  (s) => {
    session = s;
    boots.ready = now();
    for (const cmd of waiting.splice(0)) handle(cmd);
  },
  (e) => {
    failed = true;
    fail(e);
  },
);
