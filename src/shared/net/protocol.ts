import type { ArenaKey, MapKey } from "../arena/layout";
import type { MapFile } from "../map/format";
import type { PropType } from "../catalog/props";
import type { KillCause, WeaponId } from "../catalog/weapons";
import type { Ledger, Part, Reward } from "../design/progression";
import type { BotProfile } from "../design/presets";
import type { RobotDesign } from "../design/robotDesign";
import type { Vec3 } from "../math/vec";
import type { AiMode, ArmState, DebrisLook, Team } from "../sim/entities";
import type { ImpactSurface, MineAction } from "../sim/events";
import type { ExplosionLook } from "../catalog/weapons";
import type { MatchRules } from "../sim/match";
import type { PlayerInput } from "../sim/player";
import { utf8Decode, utf8Encode } from "./binary";

/*
 * Protocole du multijoueur. Le serveur fait autorité : il simule, les clients n'envoient que leurs
 * commandes (`PlayerInput`). Le serveur envoie des images (`Frame`) à cadence fixe : un en-tête JSON
 * (les changements du monde depuis l'image précédente, sous forme d'événements qui nomment les
 * entités par leur identifiant) suivi d'un instantané binaire (poses des corps, état des robots,
 * voir snapshot.ts). Le client les rejoue avec un peu de retard, en interpolant les poses
 * (net/replica.ts).
 */

/**
 * 22 : les cartes communautaires (message `map`, `join.maps`) ; 23 : les commandes du pilote
 * (`PlayerInput.look`, la direction du regard ; en avion, `climb` cabre et `power` porte les gaz dans
 * les deux pilotages) ; 24 : les lignes de départ libres d'une carte communautaire (`MapFile.spawns` :
 * une carte qui en a ne se joue pas pareil pour un client qui ne les connaît pas) ; 25 : la nuit (la
 * Cité de nuit, `sky.night` d'une carte), les phares et les balises des robots, le mât d'éclairage ; 26 :
 * les feux décoratifs (feu de position, feu à éclats, feu anticollision, gyrophare, rampe de police).
 */
export const PROTOCOL_VERSION = 26;
/** Port par défaut du serveur de jeu. */
export const DEFAULT_PORT = 8787;
/** Le serveur envoie une image tous les SNAPSHOT_EVERY pas de simulation (20 par seconde). */
export const SNAPSHOT_EVERY = 3;
/** Retard d'affichage du client (s) : il interpole entre deux images reçues. */
export const INTERP_DELAY = 0.1;
/** Cadence d'envoi des commandes par le client (par seconde). */
export const INPUT_RATE = 30;

/** Robot choisi par un joueur : un robot prédéfini, ou un plan du garage. */
export type RobotChoice = { preset: string } | { name: string; color: string; design: RobotDesign };

/** Messages du client (texte JSON). */
export type ClientMessage =
  /**
   * `token` : le secret du navigateur, qui désigne sa progression sur le serveur. `maps` : les
   * cartes communautaires qu'il a déjà (leurs identifiants, au plus `KNOWN_MAPS`) : le serveur ne
   * les lui envoie pas.
   */
  | { t: "join"; version: number; name: string; robot: RobotChoice; token: string; maps?: string[] }
  | { t: "input"; input: PlayerInput }
  /** Le robot du joueur se saborde (renversé, coincé). */
  | { t: "selfDestruct" };

/**
 * Pourquoi le serveur refuse un joueur : un code, et ce qu'il faut pour le dire. Le serveur n'envoie
 * pas de texte : le client le dit dans la langue du joueur (`refusal.<code>`, client/i18n/names.ts).
 */
export type Refusal =
  /** Le client n'a pas la version du serveur : il faut recharger la page. */
  | { code: "version" }
  /** Le jeton du joueur est illisible. */
  | { code: "token" }
  /** Le plan du robot n'est pas valide. */
  | { code: "invalidRobot" }
  /** Pièces à débloquer sur ce serveur : lesquelles, leur prix total, et les crédits du joueur. */
  | { code: "locked"; parts: Part[]; price: number; credits: number }
  /** Les deux équipes sont pleines de joueurs. */
  | { code: "full" };

/** Messages texte du serveur ; les images, elles, sont binaires. */
export type ServerMessage =
  /** Accepté : sa progression sur le serveur, et les pièces que son robot a fait débloquer (et leur prix total). */
  | { t: "welcome"; player: number; progress: Ledger; bought: { parts: Part[]; price: number } | null }
  | { t: "refused"; refusal: Refusal }
  /** Fin d'une partie : les crédits gagnés (détail) et la progression qui en résulte. */
  | { t: "progress"; progress: Ledger; reward: Reward }
  /**
   * Une carte communautaire que le client n'a pas, avant la première image qui la met en place
   * (`arena`) : il la vérifie (`checkMap`), la garde (d'après son identifiant) et sa réplique la
   * construit.
   */
  | { t: "map"; key: MapKey; map: MapFile };

/** Au plus autant de cartes déjà connues annoncées par un client. */
export const KNOWN_MAPS = 256;

/** En-tête d'une image : les changements du monde depuis la précédente, et le robot piloté par ce client. */
export interface FrameHeader {
  events: NetEvent[];
  you: number | null;
  /** Verrouillage en cours d'une arme de ce client (voir combat/lock.ts), pour son HUD. */
  lock?: LockState | null;
  /** Image d'une partie solo (net/session.ts) : un nouveau monde (une autre partie, une autre vague), la réplique oublie l'ancien. */
  reset?: boolean;
  /** Image d'une partie solo : l'état des armes de la caméra libre, pour son HUD. */
  arms?: [WeaponId, ArmState][];
  /** Image d'une partie solo : temps cumulés (ms) de chaque étape des pas mesurés, et leur nombre (la mesure du rendu). */
  profile?: { times: Record<string, number>; steps: number };
}

/** Une tourelle (id de son bloc) qui verrouille un robot (id), et la part du verrouillage acquise (0 à 1). */
export interface LockState {
  turret: number;
  target: number;
  progress: number;
}

/**
 * Robot tel qu'il est au moment où on le décrit (à son apparition, ou pour un joueur qui arrive
 * en cours de partie). Sa structure se déduit de son plan ; on ne transmet que ce qui a changé
 * depuis : les blocs encore en vie et leur morceau, les roues, les liaisons rompues.
 */
export interface BotDesc {
  id: number;
  profile: BotProfile;
  team: Team;
  controller: "ai" | "player";
  /** Identifiants des morceaux. */
  parts: number[];
  /** Blocs vivants : clé de grille, identifiant, morceau, points de structure, feu. */
  blocks: [key: string, id: number, part: number, hp: number, burn: number][];
  /** Le cockpit, même détruit (un robot hors de combat garde son cockpit mort). */
  cockpit: number;
  /** Roues encore là, dans l'ordre du plan : rang dans le plan, identifiant, points de structure. */
  wheels: [index: number, id: number, hp: number][];
  cuts: string[];
}

/** Changement du monde, les entités désignées par leur identifiant. */
export type NetEvent =
  | { t: "bot"; bot: BotDesc }
  | { t: "botGone"; id: number }
  | { t: "part"; id: number; bot: number }
  | { t: "partGone"; id: number }
  | { t: "attach"; block: number; part: number }
  | { t: "hp"; block: number; hp: number; repaired: boolean }
  | { t: "destroyed"; block: number }
  | { t: "wheelGone"; id: number }
  | { t: "debris"; id: number; look: DebrisLook; born: number; life: number }
  | { t: "debrisGone"; id: number }
  /** Un accessoire, posé à son emplacement (`spot`, dans `arena.props`) ; `fixed` : encore ancré. */
  | { t: "prop"; id: number; type: PropType; spot: number; fixed: boolean }
  | { t: "propGone"; id: number }
  /** Un accessoire ancré est libéré (il tombe) : l'instantané donne désormais sa pose. */
  | { t: "propFree"; id: number }
  /** Le feu d'un accessoire en bois : il brûle ou non, et sa part noircie. */
  | { t: "propFire"; id: number; burning: boolean; charred: number }
  /** Une flaque de feu au sol, jusqu'à `until` (temps simulé), ou son extinction. */
  | { t: "groundFire"; id: number; pos: Vec3; radius: number; until: number }
  | { t: "groundFireGone"; id: number }
  | { t: "projectile"; id: number; weapon: WeaponId; shooter: number | null }
  | { t: "projectileGone"; id: number }
  | { t: "mine"; id: number; action: MineAction }
  | { t: "shot"; weapon: WeaponId; origin: Vec3; dir: Vec3 }
  | { t: "impact"; point: Vec3; surface: ImpactSurface }
  | { t: "explosion"; point: Vec3; radius: number; look: ExplosionLook }
  | { t: "collision"; point: Vec3; strength: number }
  /** Coup d'une arme de contact : le bloc de l'arme, où, dans quel sens, son énergie (J), ce qu'il frappe, s'il a ricoché. */
  | { t: "melee"; block: number; point: Vec3; dir: Vec3; energy: number; surface: ImpactSurface; glance: boolean }
  | { t: "link"; point: Vec3 }
  | { t: "fire"; block: number }
  | { t: "fireOut"; block: number }
  | { t: "emp"; point: Vec3; radius: number }
  | { t: "stunned"; bot: number; until: number }
  /** Paralysie locale (lance électrique) : ces blocs et ces roues du robot coupés jusqu'à `until` ; où la décharge a frappé. */
  | { t: "shock"; bot: number; blocks: number[]; wheels: number[]; until: number; point: Vec3 | null }
  /** Un bloc perdu repousse (réparation) sur le morceau `part`, à la case `key` de son plan. */
  | { t: "rebuilt"; block: number; part: number; key: string; hp: number }
  | { t: "barrier"; id: number; team: Team; center: Vec3; normal: Vec3; width: number; height: number; hp: number; maxHp: number; until: number }
  | { t: "barrierHit"; id: number; hp: number; point: Vec3 }
  | { t: "barrierGone"; id: number; broken: boolean }
  | { t: "smoke"; id: number; pos: Vec3; radius: number; born: number; life: number }
  | { t: "smokeGone"; id: number }
  | { t: "shield"; block: number }
  | { t: "hit"; victim: number; attacker: number | null; cause: KillCause | null; destroyed: number }
  | { t: "killed"; bot: number; killer: number | null; cause: KillCause | null }
  /** Arène en place (avant les accessoires et la partie, qui en dépendent) : une arène du jeu, ou une carte communautaire (message `map`). */
  | { t: "arena"; id: ArenaKey }
  /** Début d'une partie (ses règles) ou fin des parties (null). */
  | { t: "match"; rules: MatchRules | null }
  | { t: "zone"; zone: number; owner: Team | null; by: Team }
  | { t: "over"; winner: Team | "draw" }
  | { t: "damage"; bots: number[] };

/** Code d'un mode d'IA dans l'instantané (l'ordre importe : ne pas renuméroter). */
export const MODE_CODES: Record<AiMode, number> = {
  patrol: 0, engage: 1, cover: 2, flee: 3, charge: 4, reverse: 5, hover: 6, paused: 7,
  gliding: 8, landing: 9, stunned: 10, flipped: 11, stranded: 12, falling: 13, dead: 14, support: 15,
};
export const MODES_BY_CODE: readonly AiMode[] = Object.entries(MODE_CODES).sort((a, b) => a[1] - b[1]).map(([m]) => m as AiMode);

/** Une image : en-tête JSON (longueur sur 4 octets, puis UTF-8), puis l'instantané. */
export function encodeFrame(header: FrameHeader, snapshot: Uint8Array): Uint8Array {
  const json = utf8Encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + snapshot.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(snapshot, 4 + json.length);
  return out;
}

export function decodeFrame(bytes: Uint8Array): { header: FrameHeader; snapshot: Uint8Array } {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const header = JSON.parse(utf8Decode(bytes.subarray(4, 4 + length))) as FrameHeader;
  return { header, snapshot: bytes.subarray(4 + length) };
}
