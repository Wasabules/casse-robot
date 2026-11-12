import { describe, expect, it } from "vitest";
import { columnsOf, gridMove, isGridKey } from "../src/client/menu/gridNav";

describe("grille de cartes : se déplacer au clavier et à la manette", () => {
  // 10 cartes sur 4 colonnes : 0 1 2 3 / 4 5 6 7 / 8 9
  it("les flèches vont à la carte voisine, dans les deux dimensions", () => {
    expect(gridMove(5, 10, 4, "ArrowRight")).toBe(6);
    expect(gridMove(5, 10, 4, "ArrowLeft")).toBe(4);
    expect(gridMove(5, 10, 4, "ArrowUp")).toBe(1);
    expect(gridMove(5, 10, 4, "ArrowDown")).toBe(9);
  });

  it("gauche et droite suivent l'ordre de lecture, d'une ligne à l'autre", () => {
    expect(gridMove(3, 10, 4, "ArrowRight")).toBe(4);
    expect(gridMove(4, 10, 4, "ArrowLeft")).toBe(3);
  });

  it("au bord de la grille, la touche ne mène nulle part (le menu passe à la commande voisine)", () => {
    expect(gridMove(0, 10, 4, "ArrowLeft")).toBeNull();
    expect(gridMove(9, 10, 4, "ArrowRight")).toBeNull();
    expect(gridMove(2, 10, 4, "ArrowUp")).toBeNull();
    expect(gridMove(8, 10, 4, "ArrowDown")).toBeNull();
    expect(gridMove(9, 10, 4, "ArrowDown")).toBeNull();
  });

  it("vers le bas, une dernière ligne incomplète mène à sa dernière carte", () => {
    expect(gridMove(6, 10, 4, "ArrowDown")).toBe(9);
    expect(gridMove(7, 10, 4, "ArrowDown")).toBe(9);
  });

  it("Début, Fin, et une page de rangées à la fois", () => {
    expect(gridMove(5, 10, 4, "Home")).toBe(0);
    expect(gridMove(5, 10, 4, "End")).toBe(9);
    expect(gridMove(0, 10, 4, "Home")).toBeNull();
    expect(gridMove(1, 30, 4, "PageDown", 3)).toBe(13);
    expect(gridMove(13, 30, 4, "PageUp", 3)).toBe(1);
    expect(gridMove(25, 30, 4, "PageDown", 3)).toBe(29);
    expect(gridMove(2, 30, 4, "PageUp", 3)).toBe(0);
  });

  it("sans sélection, on part de la première carte (ou de la dernière, pour Fin) ; sans carte, rien", () => {
    expect(gridMove(-1, 10, 4, "ArrowDown")).toBe(0);
    expect(gridMove(-1, 10, 4, "End")).toBe(9);
    expect(gridMove(-1, 0, 4, "ArrowDown")).toBeNull();
  });

  it("une seule colonne : une liste", () => {
    expect(gridMove(2, 5, 1, "ArrowDown")).toBe(3);
    expect(gridMove(2, 5, 1, "ArrowUp")).toBe(1);
    expect(gridMove(2, 5, 0, "ArrowDown")).toBe(3);
  });

  it("le nombre de colonnes se lit sur la position des cartes", () => {
    expect(columnsOf([10, 10, 10, 200, 200])).toBe(3);
    expect(columnsOf([10, 11.5, 10, 9])).toBe(4);
    expect(columnsOf([10, 200, 390])).toBe(1);
    expect(columnsOf([])).toBe(1);
  });

  it("reconnaît les touches de déplacement", () => {
    expect(isGridKey("PageDown")).toBe(true);
    expect(isGridKey("Enter")).toBe(false);
  });
});
