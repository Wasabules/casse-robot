/** Élément de la page par son id. Lève une erreur s'il manque dans index.html. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Élément #${id} introuvable dans la page`);
  return el as T;
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
