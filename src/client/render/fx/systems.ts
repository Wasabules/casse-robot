import { blastFx } from "./blastFx";
import { damageFx } from "./damageFx";
import { dustFx } from "./dustFx";
import { downwash, engineDamage, exhaustPuffs, fallingWrecks, jetFx, stunArcs, wingtipVortices } from "./engineFx";
import { exhaustFx } from "./exhaustFx";
import { meleeFx } from "./meleeFx";
import { mechanicsFx } from "./mechanicsFx";
import { blockFireFx, fireFx } from "./fireFx";
import type { FxFactory } from "./fx";
import { groundFx } from "./groundFx";
import { muzzleFx } from "./muzzleFx";
import { projectileTrails } from "./projectileTrails";
import { smokeCloudFx } from "./smokeCloudFx";
import { terrainFx } from "./terrainFx";

/**
 * Les systèmes d'effets du monde, un par famille (voir `FxSystem`, render/fx/fx.ts). Un nouveau
 * système : son fichier dans render/fx/, puis une ligne ici.
 */
export const FX_SYSTEMS: readonly FxFactory[] = [
  projectileTrails,
  muzzleFx,
  damageFx,
  groundFx,
  blastFx,
  fireFx,
  // Effets réalistes : les flammes des blocs en feu, les nuages de fumigène
  blockFireFx,
  smokeCloudFx,
  terrainFx,
  // Moteurs et vol (engineFx.ts)
  engineDamage, jetFx, wingtipVortices, downwash, exhaustPuffs, stunArcs, fallingWrecks,
  // Le jet de flamme des moteurs, là où il frappe
  exhaustFx,
  // Poussière dans l'air de la Cité
  dustFx,
  // Armes de contact : la gerbe d'un coup, le grincement d'un rotor déséquilibré
  meleeFx,
  // Frappes à mécanique : la chute de la cible d'un flipper, la boule d'un fléau, la mâchoire qui serre
  mechanicsFx,
];
