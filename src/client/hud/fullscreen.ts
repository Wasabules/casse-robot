/*
 * Plein écran (API Fullscreen du navigateur) : l'accueil et le menu pause le proposent, là où le
 * navigateur le permet (ordinateur, Android, iPad ; pas l'iPhone, où Safari ne met en plein écran
 * que les vidéos). Au doigt, le passage en plein écran tourne aussi l'écran à l'horizontale, là où
 * c'est possible (`screen.orientation.lock` : Chrome sur Android, en plein écran seulement).
 */

/** Le navigateur sait-il mettre la page en plein écran ? */
export function fullscreenSupported(): boolean {
  return typeof document !== "undefined" && !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function";
}

/** La page est-elle en plein écran ? */
export const isFullscreen = (): boolean => typeof document !== "undefined" && !!document.fullscreenElement;

/**
 * Passe en plein écran, ou en sort. `landscape` : tourne aussi l'écran à l'horizontale (là où le
 * navigateur le permet, en plein écran seulement : Chrome sur Android). À appeler d'un geste du
 * joueur (un clic, un toucher) : le navigateur refuse sinon.
 */
export async function toggleFullscreen(landscape = false): Promise<void> {
  try {
    if (isFullscreen()) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (landscape && orientation?.lock) await orientation.lock("landscape").catch(() => undefined);
  } catch {
    // Refusé (pas de geste du joueur, réglage du navigateur) : rien à faire
  }
}

/** Écoute les entrées et sorties du plein écran (par le jeu, ou par le navigateur : Échap, le geste retour). */
export function onFullscreenChange(listener: () => void): void {
  if (typeof document !== "undefined") document.addEventListener("fullscreenchange", listener);
}
