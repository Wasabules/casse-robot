/*
 * Se déplacer dans une grille de cartes au clavier (et à la manette, qui envoie les mêmes flèches :
 * menu.ts) : choix du robot, choix de l'arène. Les cartes sont rangées ligne par ligne ; le nombre de
 * colonnes dépend de la largeur de l'écran, il se relève sur la page (`columnsOf`). Logique pure,
 * vérifiée par tests/gridNav.test.ts.
 */

/** Les touches qui déplacent la sélection dans une grille. */
export const GRID_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"] as const;
export type GridKey = (typeof GRID_KEYS)[number];

export const isGridKey = (key: string): key is GridKey => (GRID_KEYS as readonly string[]).includes(key);

/**
 * La carte où mène une touche, depuis la carte `index` (-1 : aucune sélectionnée), dans une grille de
 * `count` cartes sur `columns` colonnes, dont `rows` rangées tiennent à l'écran (une page). Les
 * flèches gauche et droite suivent l'ordre de lecture (d'une ligne à la suivante) ; vers le bas, la
 * dernière ligne, incomplète, mène à la dernière carte. Null : la touche ne mène nulle part (bord
 * de la grille) ; le menu donne alors le focus à la commande voisine (les filtres au-dessus, le
 * bouton « Retour » au-dessous).
 */
export function gridMove(index: number, count: number, columns: number, key: GridKey, rows = 1): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  if (index < 0 || index > last) return key === "End" ? last : 0;
  const cols = Math.max(1, Math.floor(columns));
  const page = cols * Math.max(1, Math.floor(rows));
  const row = Math.floor(index / cols);
  let next: number;
  switch (key) {
    case "ArrowLeft": next = index - 1; break;
    case "ArrowRight": next = index + 1; break;
    case "ArrowUp": next = index - cols; break;
    case "ArrowDown":
      next = index + cols;
      // La dernière ligne est incomplète : on va à sa dernière carte (s'il y a bien une ligne plus bas)
      if (next > last && row < Math.floor(last / cols)) next = last;
      break;
    case "Home": next = 0; break;
    case "End": next = last; break;
    case "PageUp": next = Math.max(0, index - page); break;
    case "PageDown": next = Math.min(last, index + page); break;
  }
  return next >= 0 && next <= last && next !== index ? next : null;
}

/**
 * Nombre de colonnes d'une grille d'après le haut de chacune de ses cartes, dans l'ordre (une carte
 * cachée n'est pas comptée : qu'on ne la passe pas) : celles de la première ligne sont au même
 * niveau (à quelques pixels près).
 */
export function columnsOf(tops: readonly number[]): number {
  if (!tops.length) return 1;
  let n = 1;
  while (n < tops.length && Math.abs(tops[n] - tops[0]) < 4) n++;
  return n;
}
