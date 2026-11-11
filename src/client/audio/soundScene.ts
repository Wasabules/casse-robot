import type { UiKind } from "./sound";

/*
 * Ce qui doit sonner selon l'écran. Un seul endroit en décide : `App` annonce chaque écran
 * (`Sound.setScreen`), et `Sound` règle d'après lui deux bus de volume, le monde (tirs, explosions,
 * moteurs, feux, projectiles, accessoires) et l'ambiance de l'arène, et laisse passer ou non les
 * signaux de combat du joueur. La musique, elle, reste réglée à part (`Music`).
 */

/** Écran du jeu, du point de vue du son. */
export type SoundScreen = "playing" | "paused" | "over" | "menu" | "garage" | "loading";

export interface SoundScene {
  /** Volume du monde (0 à 1). */
  world: number;
  /** Volume de l'ambiance de l'arène (0 à 1). */
  ambience: number;
  /**
   * Le monde est-il là ? Faux quand l'arène est en veille (garage) : ses boucles (moteurs, feux,
   * projectiles en vol, tirs continus, ambiance) sont toutes libérées, et rien ne les relance tant
   * qu'on n'y revient pas.
   */
  live: boolean;
  /** Les signaux de combat du joueur (touches, alertes, compte à rebours, zones…) passent-ils ? */
  cues: boolean;
}

/**
 * Le son de chaque écran :
 * - en partie, tout ;
 * - en pause, le monde est figé : il se tait (l'ambiance reste, plus bas) ; en réseau, la partie
 *   continue sur le serveur : on l'entend encore, de loin ;
 * - en fin de partie, la bataille continue derrière le résultat, plus bas (et plus bas encore sous
 *   le motif de fin, voir `STINGER_DUCK`) ;
 * - derrière les menus, la bataille de démonstration, plus bas ;
 * - au garage, rien du monde ;
 * - pendant le chargement d'une partie, rien du monde non plus (elle est figée derrière l'écran de
 *   chargement, et ses sons attendent qu'elle commence) : seulement la musique.
 * Hors partie, les signaux de combat du joueur se taisent.
 */
export function soundScene(screen: SoundScreen, online = false): SoundScene {
  switch (screen) {
    case "playing":
      return { world: 1, ambience: 1, live: true, cues: true };
    case "paused":
      return online ? { world: 0.3, ambience: 0.6, live: true, cues: false } : { world: 0, ambience: 0.5, live: true, cues: false };
    case "over":
      return { world: 0.35, ambience: 0.6, live: true, cues: false };
    case "menu":
      return { world: 0.35, ambience: 0.6, live: true, cues: false };
    case "garage":
    case "loading":
      return { world: 0, ambience: 0, live: false, cues: false };
  }
}

/**
 * Les sons d'interface qui disent au joueur ce qui arrive à son robot ou à sa partie ; ceux des
 * menus et du garage (clic, survol, retour, pose, enregistrement, crédits…) passent toujours.
 */
export const COMBAT_CUES: ReadonlySet<UiKind> = new Set<UiKind>([
  "hit", "crit", "kill", "hurt", "capture", "lost", "lock", "locking", "overheat", "dry", "reload",
  "missile", "critical", "battery", "start", "tick", "hill", "respawn", "detonate",
]);

/** Ce son d'interface peut-il jouer sur cet écran ? */
export const cueAllowed = (kind: UiKind, scene: SoundScene): boolean => scene.cues || !COMBAT_CUES.has(kind);

/**
 * Sous le motif de victoire ou de défaite, le monde baisse encore, à cette part de son volume,
 * pendant ce temps (s) : la sirène, les explosions et le motif ne se marchent plus dessus.
 */
export const STINGER_DUCK = { level: 0.3, seconds: 4 } as const;
