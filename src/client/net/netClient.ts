import { isArenaId, type ArenaId } from "../../shared/arena/layout";
import { checkMap } from "../../shared/map/validate";
import { decodeFrame, DEFAULT_PORT, KNOWN_MAPS, type ClientMessage, type ServerMessage } from "../../shared/net/protocol";
import { Replica } from "../../shared/net/replica";
import { t } from "../i18n/i18n";
import { refusalText } from "../i18n/names";
import { httpOrigin, mapAssets } from "../maps/assets";
import { arenaReady, loadArena } from "../maps/gameArenas";
import type { MapLibrary } from "../maps/library";

/** Port de `vite preview` : comme en développement, la page vient de Vite, et le serveur de jeu tourne à côté. */
const VITE_PREVIEW_PORT = "4173";

/**
 * Adresse du serveur par défaut. En développement (Vite), la machine qui sert la page, sur le port
 * du jeu. Sinon, la page vient du serveur de jeu lui-même (`npm run server`, `npm run share`) : la
 * partie est à la même adresse, en `wss` si la page est en https (un tunnel n'ouvre que celle-là).
 */
export function defaultServer(): string {
  if (import.meta.env.DEV || location.port === VITE_PREVIEW_PORT) return `ws://${location.hostname || "localhost"}:${DEFAULT_PORT}`;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

/**
 * Liaison WebSocket avec le serveur de jeu : elle envoie la demande pour rejoindre, puis les
 * commandes ; les images reçues nourrissent la réplique du monde.
 */
export class NetClient {
  readonly replica = new Replica();
  /** Le serveur accepte le joueur. */
  onWelcome: (() => void) | null = null;
  /** Fin de la session : refus du serveur, ou liaison coupée (la raison, à afficher). */
  onEnd: ((reason: string) => void) | null = null;
  /** Progression du joueur sur le serveur : à son arrivée (et ce que son robot y a fait débloquer), puis à chaque fin de partie. */
  onProgress: ((msg: Extract<ServerMessage, { t: "welcome" | "progress" }>) => void) | null = null;
  private readonly socket: WebSocket;
  private welcomed = false;
  private closing = false;
  /**
   * Messages retenus, dans l'ordre, pendant que se charge le fichier d'une arène du jeu qu'une image
   * annonce (une grande arène que ce navigateur n'a pas encore : client/maps/gameArenas.ts) : la
   * réplique la trouve quand elle rejoue cette image. Le protocole ne change pas : le serveur ne dit
   * que l'identifiant de l'arène.
   */
  private held: (string | ArrayBuffer)[] | null = null;
  /** Les arènes dont le fichier n'a pas pu se charger : on ne les attend plus (la réplique note l'arène manquante). */
  private readonly unavailable = new Set<ArenaId>();

  /** Les cartes communautaires de ce navigateur (`maps`) : celles qu'on a, le serveur ne les envoie pas ; celles qu'il envoie, on les garde. */
  private readonly maps: MapLibrary | null;

  /** L'origine HTTP du serveur (« http://hôte:8787 ») : il y sert les ressources des cartes qu'il envoie. */
  private readonly origin: string | null;

  constructor(url: string, join: Extract<ClientMessage, { t: "join" }>, maps: MapLibrary | null = null) {
    this.maps = maps;
    this.origin = httpOrigin(url);
    if (maps) {
      join = { ...join, maps: maps.knownKeys().slice(0, KNOWN_MAPS) };
      this.replica.resolveArena = (key) => {
        const arena = maps.arena(key);
        // (une carte qu'on a déjà, mais dont une ressource a manqué la dernière fois : ce serveur l'a)
        if (arena && this.origin) mapAssets.fetchFrom(this.origin, arena);
        return arena;
      };
    }
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => this.send(join));
    this.socket.addEventListener("message", (e) => this.onMessage(e.data as string | ArrayBuffer));
    this.socket.addEventListener("close", () => {
      if (this.closing) return;
      this.closing = true;
      this.onEnd?.(this.welcomed ? t("net.lost") : t("net.unreachable", { url }));
    });
  }

  send(msg: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  /** Départ voulu : on ferme sans prévenir `onEnd`. */
  close(): void {
    this.closing = true;
    this.socket.close();
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (this.held) {
      this.held.push(data);
      return;
    }
    if (typeof data === "string") {
      this.onText(JSON.parse(data) as ServerMessage);
      return;
    }
    const frame = decodeFrame(new Uint8Array(data));
    for (const e of frame.header.events) {
      if (e.t === "arena" && isArenaId(e.id) && !arenaReady(e.id) && !this.unavailable.has(e.id)) {
        this.hold(e.id, data);
        return;
      }
    }
    this.replica.receiveFrame(frame);
  }

  /** Retient cette image et celles qui suivent le temps que le fichier de l'arène se charge, puis les rend. */
  private hold(arena: ArenaId, first: ArrayBuffer): void {
    this.held = [first];
    const release = (): void => {
      const held = this.held ?? [];
      this.held = null;
      for (const data of held) {
        if (this.closing) return;
        this.onMessage(data);
      }
    };
    loadArena(arena).then(release, (e: unknown) => {
      console.warn(`Arène ${arena} : fichier impossible à charger`, e);
      this.unavailable.add(arena);
      release();
    });
  }

  /**
   * Une carte communautaire envoyée par le serveur : vérifiée comme une carte importée, puis gardée et
   * donnée à la réplique. Ses ressources (un paquet : modèles, ambiance) se téléchargent chez le serveur,
   * en parallèle de la partie (client/maps/assets.ts).
   */
  private receiveMap(msg: Extract<ServerMessage, { t: "map" }>): void {
    const check = checkMap(msg.map);
    if (!check.map || !check.arena || check.key !== msg.key || check.issues.length) {
      console.warn(`Carte du serveur refusée : ${String(msg.key)}`, check.issues);
      return;
    }
    this.replica.addArena(check.arena);
    if (this.origin) mapAssets.fetchFrom(this.origin, check.map);
    void this.maps?.save(check.map, "server");
  }

  private onText(msg: ServerMessage): void {
    if (msg.t === "welcome") {
      this.welcomed = true;
      this.onWelcome?.();
      this.onProgress?.(msg);
    } else if (msg.t === "progress") {
      this.onProgress?.(msg);
    } else if (msg.t === "map") {
      this.receiveMap(msg);
    } else if (msg.t === "refused") {
      this.closing = true;
      this.socket.close();
      this.onEnd?.(refusalText(msg.refusal));
    }
  }
}
