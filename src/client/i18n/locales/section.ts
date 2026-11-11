import type { Message } from "../i18n";

/**
 * Une rubrique d'un catalogue, exhaustive sur les identifiants d'un catalogue du jeu : les clés
 * reçoivent le préfixe (`section("block", { armor: "Blindage" })` donne `"block.armor"`). Écrire
 * l'objet `{ … } as const satisfies Record<BlockType, Message>` : TypeScript refuse alors un type de
 * bloc oublié ou en trop, comme pour les `Record` exhaustifs du rendu.
 */
export function section<const P extends string, const T extends Readonly<Record<string, Message>>>(
  prefix: P,
  entries: T,
): { readonly [K in keyof T & string as `${P}.${K}`]: T[K] } {
  const out: Record<string, Message> = {};
  for (const [key, message] of Object.entries(entries)) out[`${prefix}.${key}`] = message;
  return out as { readonly [K in keyof T & string as `${P}.${K}`]: T[K] };
}
