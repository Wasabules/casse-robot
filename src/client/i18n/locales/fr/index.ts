import { bots } from "./bots";
import { catalog } from "./catalog";
import { common } from "./common";
import { design } from "./design";
import { editor } from "./editor";
import { garage } from "./garage";
import { hud } from "./hud";
import { keys } from "./keys";
import { maps } from "./maps";
import { menu } from "./menu";
import { net } from "./net";
import { parts } from "./parts";
import { picker } from "./picker";
import { world } from "./world";

/*
 * Le français, langue source : ses clés font foi pour toutes les langues (voir locales/index.ts).
 * Un fichier par partie du jeu ; chaque clé commence par le nom de sa rubrique, et une clé n'est
 * que dans un fichier (vérifié par tests/i18n.test.ts, d'après `FR_ZONES`).
 */
export const FR_ZONES = { common, catalog, world, bots, design, net, picker, keys, menu, hud, garage, parts, maps, editor } as const;

export const fr = {
  ...common,
  ...catalog,
  ...world,
  ...bots,
  ...design,
  ...net,
  ...picker,
  ...keys,
  ...menu,
  ...hud,
  ...garage,
  ...parts,
  ...maps,
  ...editor,
} as const;
