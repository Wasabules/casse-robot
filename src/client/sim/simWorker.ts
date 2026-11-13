import { LocalSession, type SessionCommand, type SessionLike } from "../../shared/net/session";
import { NativeSession } from "../../shared/native/session";
import { loadSimModule } from "../../shared/native/simModule";
import { initPhysics } from "../../shared/sim/simulation";
// La simulation compilée entière (Rapier compris, ~3 Mo) : un fichier à part, téléchargé seulement
// quand on choisit la simulation Rust (`?sim=rust`)
import simWasmUrl from "../../shared/native/casse-sim.wasm?url";
// Les petites arènes du jeu, dont le Dépôt où naît la session ; les grandes viennent avec la partie (`start`)
import "../maps/smallArenas";

/*
 * La simulation de la partie solo, hors du fil du rendu (un Worker) : reçoit les commandes du jeu
 * (`SessionCommand`), rend ses images (des `ArrayBuffer` transférés, comme les images binaires du
 * serveur de jeu) que le jeu rejoue dans une réplique (client/sim/workerLink.ts). Une erreur de la
 * session est renvoyée (`{ error }`) plutôt que d'arrêter le Worker en silence.
 *
 * La simulation est celle du TypeScript (`LocalSession`), ou celle portée en Rust
 * (`NativeSession`, src/shared/native/session.ts) quand le Worker s'appelle « rust » (son nom,
 * `WorkerLink`) : les mêmes images, octet pour octet.
 */

/** Ce que le Worker renvoie : une image, ou une erreur. */
export type WorkerReply = ArrayBuffer | { error: string };

/** La simulation que fait tourner le Worker. */
export type SimEngine = "ts" | "rust";

const scope = self as unknown as {
  readonly name?: string;
  onmessage: ((e: MessageEvent<SessionCommand>) => void) | null;
  postMessage(reply: WorkerReply, transfer?: Transferable[]): void;
};

const engine: SimEngine = scope.name === "rust" ? "rust" : "ts";
let session: SessionLike | null = null;
let failed = false;
const waiting: SessionCommand[] = [];

function fail(e: unknown): void {
  scope.postMessage({ error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
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
  if (session) handle(e.data);
  else if (!failed) waiting.push(e.data);
};

/** La session : celle du TypeScript, ou celle de la simulation portée (son module téléchargé d'abord). */
async function boot(): Promise<SessionLike> {
  await initPhysics();
  const now = (): number => performance.now();
  if (engine === "ts") return new LocalSession(now);
  const response = await fetch(simWasmUrl);
  if (!response.ok) throw new Error(`simulation Rust introuvable (${response.status})`);
  const module = await loadSimModule(new Uint8Array(await response.arrayBuffer()));
  return new NativeSession(module, now);
}

boot().then(
  (s) => {
    session = s;
    for (const cmd of waiting.splice(0)) handle(cmd);
  },
  (e) => {
    failed = true;
    fail(e);
  },
);
