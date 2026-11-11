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
 * L'anglais : les mêmes fichiers que le français, chacun vérifié contre le sien (`ZoneOf`), puis
 * l'ensemble dans locales/index.ts. Lexique suivi d'un écran à l'autre : voir docs/architecture.md, « Langues ».
 */
export const EN_ZONES = { common, catalog, world, bots, design, net, picker, keys, menu, hud, garage, parts, maps, editor } as const;

export const en = {
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
