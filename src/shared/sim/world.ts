import type { ArenaLayout } from "../arena/layout";
import type { Bot, GroundFire, Projectile, Prop, Team } from "./entities";
import type { SimListener } from "./events";
import type { Match } from "./match";

/**
 * Ce que le rendu, le son et le HUD lisent du monde : la `Simulation` elle-même en partie locale,
 * ou sa réplique (`net/replica.ts`) en multijoueur, qui reconstruit les mêmes entités à partir de
 * ce qu'envoie le serveur et émet les mêmes événements.
 */
export interface World {
  readonly bots: readonly Bot[];
  /** Temps simulé (s) ; en réplique, celui de l'instant affiché. */
  readonly time: number;
  /** Robot du joueur local, ou null. */
  readonly player: Bot | null;
  readonly match: Match | null;
  /** Arène en place : décor, accessoires, zones à capturer. */
  readonly arena: ArenaLayout;
  /** Ennemis repérés par chaque équipe (voir sim/detection.ts). */
  readonly detected: ReadonlyMap<Team, ReadonlySet<Bot>>;
  /** Projectiles en vol et mines posées. */
  readonly projectiles: Iterable<Projectile>;
  /** Accessoires présents (caisses, barils, murs, arbres…). */
  readonly props: Iterable<Prop>;
  /** Flaques de feu au sol. */
  readonly groundFires: Iterable<GroundFire>;
  on(listener: SimListener): () => void;
}
