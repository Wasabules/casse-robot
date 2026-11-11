import { upgradeUnlocked, type Ledger } from "../shared/design/progression";

/*
 * Progression des joueurs, gardée par le serveur : pour chaque jeton (un secret que le navigateur
 * tire au hasard et garde), ses crédits et ses pièces débloquées. La salle s'en sert (room.ts) ;
 * server/main.ts la lit au démarrage et l'écrit sur disque à chaque changement. Ce fichier-ci ne
 * touche pas au disque : les tests le font tourner en mémoire.
 */

/** Forme d'un jeton de joueur. */
export const TOKEN_PATTERN = /^[a-z0-9-]{16,64}$/;

export class ProgressBook {
  private readonly ledgers = new Map<string, Ledger>();
  /** Appelé après chaque changement (main.ts enregistre alors le fichier). */
  onChange: (() => void) | null = null;

  /** Progression de ce joueur ; un nouveau venu part de zéro. */
  get(token: string): Ledger {
    let ledger = this.ledgers.get(token);
    if (!ledger) {
      ledger = { credits: 0, unlocked: [] };
      this.ledgers.set(token, ledger);
    }
    return ledger;
  }

  /** Une progression a changé. */
  changed(): void {
    this.onChange?.();
  }

  toJSON(): Record<string, Ledger> {
    return Object.fromEntries(this.ledgers);
  }

  /** Reprend des progressions enregistrées (ce qui est illisible est ignoré). */
  load(data: unknown): void {
    if (!data || typeof data !== "object") return;
    for (const [token, raw] of Object.entries(data as Record<string, unknown>)) {
      if (!TOKEN_PATTERN.test(token) || !raw || typeof raw !== "object") continue;
      const { credits, unlocked } = raw as { credits?: unknown; unlocked?: unknown };
      this.ledgers.set(token, {
        credits: typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? Math.floor(credits) : 0,
        unlocked: Array.isArray(unlocked) ? upgradeUnlocked(unlocked.filter((k): k is string => typeof k === "string")) : [],
      });
    }
  }
}
