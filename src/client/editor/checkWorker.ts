import { checkMap } from "../../shared/map/validate";
import type { MapIssue } from "../../shared/map/format";

/*
 * La vérification d'une carte, hors du fil de la page (un Worker) : sur une grande carte, elle prend
 * jusqu'à deux secondes (la grille de passage de l'IA, les bois semés), et l'éditeur ne doit pas
 * geler pendant ce temps. Reçoit `{ id, map }`, rend `{ id, issues }`.
 */

export interface CheckRequest {
  readonly id: number;
  readonly map: unknown;
}

export interface CheckReply {
  readonly id: number;
  readonly issues: readonly MapIssue[];
  /** Temps de la vérification (ms). */
  readonly ms: number;
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<CheckRequest>) => void) | null; postMessage(reply: CheckReply): void };

scope.onmessage = (e) => {
  const start = performance.now();
  const { issues } = checkMap(e.data.map);
  scope.postMessage({ id: e.data.id, issues, ms: performance.now() - start });
};
