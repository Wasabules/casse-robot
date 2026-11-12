import { LocalSession, type SessionCommand } from "../../shared/net/session";
import { initPhysics } from "../../shared/sim/simulation";

/*
 * La simulation de la partie solo, hors du fil du rendu (un Worker) : reçoit les commandes du jeu
 * (`SessionCommand`), rend ses images (des `ArrayBuffer` transférés, comme les images binaires du
 * serveur de jeu) que le jeu rejoue dans une réplique (client/sim/workerLink.ts). Une erreur de la
 * session est renvoyée (`{ error }`) plutôt que d'arrêter le Worker en silence.
 */

/** Ce que le Worker renvoie : une image, ou une erreur. */
export type WorkerReply = ArrayBuffer | { error: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<SessionCommand>) => void) | null;
  postMessage(reply: WorkerReply, transfer?: Transferable[]): void;
};

let session: LocalSession | null = null;
const waiting: SessionCommand[] = [];

function handle(cmd: SessionCommand): void {
  try {
    for (const frame of session!.handle(cmd)) {
      // L'image a son propre tampon : il part sans copie
      const buffer = frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength ? frame.buffer : frame.slice().buffer;
      scope.postMessage(buffer as ArrayBuffer, [buffer as ArrayBuffer]);
    }
  } catch (e) {
    scope.postMessage({ error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
  }
}

scope.onmessage = (e) => {
  if (session) handle(e.data);
  else waiting.push(e.data);
};

void initPhysics().then(() => {
  session = new LocalSession(() => performance.now());
  for (const cmd of waiting.splice(0)) handle(cmd);
});
