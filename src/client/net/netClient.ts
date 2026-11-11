import { checkMap } from "../../shared/map/validate";
import { DEFAULT_PORT, KNOWN_MAPS, type ClientMessage, type ServerMessage } from "../../shared/net/protocol";
import { Replica } from "../../shared/net/replica";
import { t } from "../i18n/i18n";
import { refusalText } from "../i18n/names";
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

  /** Les cartes communautaires de ce navigateur (`maps`) : celles qu'on a, le serveur ne les envoie pas ; celles qu'il envoie, on les garde. */
  private readonly maps: MapLibrary | null;

  constructor(url: string, join: Extract<ClientMessage, { t: "join" }>, maps: MapLibrary | null = null) {
    this.maps = maps;
    if (maps) {
      join = { ...join, maps: maps.knownKeys().slice(0, KNOWN_MAPS) };
      this.replica.resolveArena = (key) => maps.arena(key);
    }
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => this.send(join));
    this.socket.addEventListener("message", (e) => {
      if (typeof e.data === "string") this.onText(JSON.parse(e.data) as ServerMessage);
      else this.replica.receive(new Uint8Array(e.data as ArrayBuffer));
    });
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

  /** Une carte communautaire envoyée par le serveur : vérifiée comme une carte importée, puis gardée et donnée à la réplique. */
  private receiveMap(msg: Extract<ServerMessage, { t: "map" }>): void {
    const check = checkMap(msg.map);
    if (!check.map || !check.arena || check.key !== msg.key || check.issues.length) {
      console.warn(`Carte du serveur refusée : ${String(msg.key)}`, check.issues);
      return;
    }
    this.replica.addArena(check.arena);
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
