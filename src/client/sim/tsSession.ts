import { LocalSession, type SessionLike } from "../../shared/net/session";
import { initPhysics } from "../../shared/sim/simulation";

/*
 * La session solo sur la simulation du TypeScript (`LocalSession`), avec Rapier compilé pour le
 * JavaScript (~4,2 Mo, le WebAssembly en base64 de sa version « compat ») : un morceau du Worker
 * (client/sim/simWorker.ts) chargé à la demande, seulement quand c'est elle qui tourne (`?sim=ts`, ou
 * le repli quand la simulation portée en Rust ne se charge pas).
 */
export async function startTsSession(now: () => number): Promise<SessionLike> {
  await initPhysics();
  return new LocalSession(now);
}
