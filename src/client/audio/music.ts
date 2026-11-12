import { LOOP_PAD } from "./samples";

/*
 * Musique (générée avec ElevenLabs, voir tools/sounds) : chaque écran (accueil, garage, partie) a
 * plusieurs morceaux, joués l'un après l'autre en sac mélangé (`ShuffleBag` : tous passent avant
 * qu'un ne revienne, jamais deux fois de suite le même), un fondu enchaîné de `CHAIN_FADE` s passant
 * de l'un à l'autre ; en fin de partie, un court motif de victoire ou de défaite.
 *
 * Le joueur peut passer au morceau suivant ou revenir au précédent (`next`, `previous` : le lecteur
 * des menus, les touches en partie) : chaque écran a sa liste de lecture (`Playlist` : le sac pour
 * les nouveaux morceaux, et un court historique pour revenir en arrière), et le saut se fait en
 * fondu de `SKIP_FADE` s. Un morceau précédent déjà libéré est préparé de nouveau : celui qu'on
 * entend continue jusqu'à ce qu'il soit prêt (`MusicNow.pending`). Chaque morceau a un titre, dans
 * chaque langue (`music.title.<fichier>`) ; `onChange` annonce ce qui change (hud/nowPlaying.ts).
 *
 * Les morceaux durent de 1 à 4 minutes : décodés, ils pèseraient ~0,4 Mo par seconde (~96 Mo pour
 * 4 min, le double avec le suivant). Ils sont donc lus en flux : un élément <audio> (sur une URL
 * `blob:` du fichier compressé, téléchargé quand le morceau est préparé) branché au bus par
 * `createMediaElementSource`, le fondu sur un `GainNode`. Seule la version compressée reste en
 * mémoire (112 kb/s : ~3,4 Mo pour 4 min), le temps que le morceau serve : le morceau en cours et
 * le suivant de l'écran en cours, plus le premier de chacun des autres écrans (préparé d'avance :
 * élément créé, `canplaythrough` atteint), soit quatre morceaux, cinq pendant un fondu : ~15 Mo au
 * plus (`compressedMegabytes`). Un morceau fini est libéré (élément vidé, nœud débranché, URL
 * révoquée), sauf s'il sert encore (le suivant, après un retour en arrière : il est mis en pause).
 * Les motifs, qui doivent partir à l'instant, restent décodés (~3 Mo chacun : `decodedMegabytes`).
 * Sur une machine à peu de mémoire (`navigator.deviceMemory` ≤ 4), le garage n'est pas préparé
 * d'avance.
 *
 * Préparation (`preload`) : les motifs et le premier morceau de l'accueil pendant l'écran de
 * chargement, puis, sans les attendre, celui de la partie et celui du garage ; `prepare(theme)`
 * (écran de chargement d'une partie) attend que le premier morceau de l'écran puisse partir.
 *
 * Un morceau est encodé comme une boucle (tools/sounds/build.mjs : marges de `LOOP_PAD` s, sa fin
 * fondue dans son début) : on le lit de sa marge de début et on enchaîne avant sa marge de fin. Si
 * le suivant n'est pas prêt à temps, il reprend à son début (sa fin y mène sans à-coup) et on
 * enchaîne au tour suivant.
 */

/** Morceaux et motifs : nombre de variantes (fichiers public/sounds/<morceau>-<n>.ogg). */
export const MUSIC_TRACKS = {
  "music-menu": 2,
  "music-menu-b": 1,
  "music-garage": 2,
  "music-garage-b": 1,
  "music-battle-a": 2,
  "music-battle-b": 2,
  "music-battle-c": 1,
  "music-battle-d": 2,
  "music-battle-e": 2,
  "music-battle-f": 2,
  "music-battle-g": 1,
  "stinger-victory": 2,
  "stinger-victory-b": 1,
  "stinger-defeat": 2,
  "stinger-defeat-b": 1,
} as const;

export type MusicKey = keyof typeof MUSIC_TRACKS;
export type MusicTheme = "menu" | "garage" | "battle";
export type StingerKind = "victory" | "defeat";

/** Les morceaux de chaque écran (toutes leurs variantes y passent). */
export const THEMES: Record<MusicTheme, readonly MusicKey[]> = {
  menu: ["music-menu", "music-menu-b"],
  garage: ["music-garage", "music-garage-b"],
  battle: ["music-battle-a", "music-battle-b", "music-battle-c", "music-battle-d", "music-battle-e", "music-battle-f", "music-battle-g"],
};

/** Les motifs de fin de partie, joués une fois, décodés d'avance. */
export const STINGERS: Record<StingerKind, readonly MusicKey[]> = {
  victory: ["stinger-victory", "stinger-victory-b"],
  defeat: ["stinger-defeat", "stinger-defeat-b"],
};

/** Durée des fondus d'un écran à l'autre (s). */
const FADE = 1.5;
/** Fondu enchaîné d'un morceau au suivant du même écran (s). */
export const CHAIN_FADE = 3;
/** Fondu d'un saut demandé par le joueur (morceau suivant, précédent) : plus court, il répond tout de suite (s). */
export const SKIP_FADE = 1.2;
/** Morceaux gardés dans l'historique de chaque écran, pour revenir en arrière. */
export const HISTORY = 8;
/**
 * Marge (s) : le fondu enchaîné finit avant la marge de fin du morceau, et l'heure de lecture
 * n'arrive que par `timeupdate` (toutes les ~0,25 s).
 */
const CHAIN_EARLY = 0.4;
/** Le suivant pas prêt : à moins de tant (s) de sa fin, le morceau reprend à son début. */
const LOOP_BACK = 0.4;
/** Au plus tant (s) d'attente pour préparer un morceau (écran de chargement d'une partie). */
const PREPARE_WAIT = 15;

/** Les nombres de 1 à N (les variantes d'un morceau). */
type UpTo<N extends number, A extends unknown[] = []> = A["length"] extends N ? never : [...A, unknown]["length"] | UpTo<N, [...A, unknown]>;

/**
 * Un fichier de musique : un morceau et sa variante (« music-menu-2 »), d'après `MUSIC_TRACKS`.
 * Chacun a son titre dans chaque langue (`music.title.<fichier>`, exhaustif : TypeScript réclame
 * celui d'une variante ajoutée).
 */
export type Track = { [K in MusicKey]: `${K}-${UpTo<(typeof MUSIC_TRACKS)[K]>}` }[MusicKey];
const trackOf = (key: MusicKey, n: number): Track => `${key}-${n}` as Track;

/** Toutes les variantes de ces morceaux. */
export const tracksOf = (keys: readonly MusicKey[]): Track[] =>
  keys.flatMap((key) => Array.from({ length: MUSIC_TRACKS[key] }, (_, i) => trackOf(key, i + 1)));

/** Le morceau d'un fichier (« music-menu-2 » → « music-menu »). */
const keyOf = (track: Track): MusicKey => track.slice(0, track.lastIndexOf("-")) as MusicKey;

/**
 * Sac mélangé : les éléments sortent dans un ordre au hasard, chacun une fois par tour, et un tour
 * ne commence pas par le dernier sorti du précédent (jamais deux fois de suite le même, s'il y en a
 * au moins deux). `peek` dit le prochain sans le sortir (pour le préparer d'avance).
 */
export class ShuffleBag<T> {
  private readonly items: readonly T[];
  private readonly random: () => number;
  private queue: T[] = [];
  private last: T | undefined;

  constructor(items: readonly T[], random: () => number = Math.random) {
    if (!items.length) throw new Error("Sac mélangé vide");
    this.items = items;
    this.random = random;
  }

  /** Nombre d'éléments différents. */
  get size(): number {
    return this.items.length;
  }

  peek(): T {
    this.fill();
    return this.queue[0];
  }

  take(): T {
    this.fill();
    const item = this.queue.shift()!;
    this.last = item;
    return item;
  }

  private fill(): void {
    if (this.queue.length) return;
    const q = [...this.items];
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    if (q.length > 1 && q[0] === this.last) {
      const j = 1 + Math.floor(this.random() * (q.length - 1));
      [q[0], q[j]] = [q[j], q[0]];
    }
    this.queue = q;
  }
}

/**
 * Liste de lecture d'un écran, dans l'ordre où on l'entend : les nouveaux morceaux viennent du sac
 * mélangé ; un historique (`HISTORY` morceaux au plus) permet de revenir en arrière (`previous`),
 * puis de repartir en avant (`next` rejoue d'abord ce qu'on a quitté en revenant, puis reprend le
 * sac). `current` : le morceau voulu (celui qu'on entend, ou celui qu'on prépare pour le remplacer) ;
 * null quand l'écran s'est tu (`stop` : il passe derrière, l'écran reprendra au suivant). Jamais
 * deux fois de suite le même morceau, s'il y en a au moins deux.
 */
export class Playlist<T> {
  private readonly bag: ShuffleBag<T>;
  private readonly limit: number;
  /** Morceaux entendus avant celui en cours, le plus récent en dernier. */
  private readonly behind: T[] = [];
  /** Morceaux quittés en revenant en arrière, le prochain à rejouer en dernier. */
  private readonly ahead: T[] = [];
  private playing: T | null = null;

  constructor(items: readonly T[], random: () => number = Math.random, limit = HISTORY) {
    this.bag = new ShuffleBag(items, random);
    this.limit = limit;
  }

  /** Le morceau voulu (null : l'écran s'est tu). */
  get current(): T | null {
    return this.playing;
  }

  /**
   * Le prochain morceau, sans y passer : celui qu'on a quitté en revenant en arrière, sinon le
   * prochain du sac, jamais le dernier entendu (le sac le proposerait après un retour en arrière, ou
   * quand un suivant illisible a été écarté en fin de tour : on le saute, il reviendra au tour suivant).
   */
  peekNext(): T {
    const replay = this.ahead.at(-1);
    if (replay !== undefined) return replay;
    const last = this.playing ?? this.behind.at(-1);
    if (this.bag.size > 1 && this.bag.peek() === last) this.bag.take();
    return this.bag.peek();
  }

  /** Passe au morceau suivant (celui de `peekNext`) ; celui en cours passe derrière. */
  next(): T {
    const track = this.peekNext();
    if (this.ahead.length) this.ahead.pop();
    else this.bag.take();
    this.remember(this.playing);
    this.playing = track;
    return track;
  }

  /** Le morceau d'avant, auquel `previous` reviendrait (undefined : aucun). */
  peekPrevious(): T | undefined {
    return this.behind.at(-1);
  }

  /** Revient au morceau d'avant ; celui en cours passe devant (`next` y repartira). Undefined : rien derrière. */
  previous(): T | undefined {
    const track = this.behind.pop();
    if (track === undefined) return undefined;
    if (this.playing !== null) this.ahead.push(this.playing);
    this.playing = track;
    return track;
  }

  /** L'écran s'est tu : le morceau en cours passe derrière ; il reprendra au suivant. */
  stop(): void {
    this.remember(this.playing);
    this.playing = null;
  }

  /**
   * Revient au morceau `track` en parcourant l'historique (en arrière, ou en avant), le plus proche
   * d'abord : un morceau demandé illisible, on reste sur celui qu'on entend. Faux s'il n'y est pas.
   */
  seek(track: T): boolean {
    if (this.playing === track) return true;
    if (this.behind.includes(track)) {
      while (this.playing !== track) this.previous();
      return true;
    }
    if (this.ahead.includes(track)) {
      while (this.playing !== track) this.next();
      return true;
    }
    return false;
  }

  /** Écarte le prochain morceau (illisible) : il ne reviendra qu'au tour suivant du sac. */
  discardNext(): void {
    this.peekNext();
    if (this.ahead.length) this.ahead.pop();
    else this.bag.take();
  }

  /** L'historique (essais, console) : derrière, du plus ancien au plus récent ; devant, du prochain au dernier. */
  snapshot(): { behind: T[]; ahead: T[] } {
    return { behind: [...this.behind], ahead: [...this.ahead].reverse() };
  }

  private remember(track: T | null): void {
    if (track === null) return;
    this.behind.push(track);
    if (this.behind.length > this.limit) this.behind.shift();
  }
}

/** État de préparation d'un morceau. */
export type StreamState = "loading" | "ready" | "failed";

/**
 * Ce que fait le morceau en cours à `left` s de sa marge de fin, selon le suivant (null : il n'y
 * en a pas d'autre) : attendre, enchaîner (fondu), en préparer un autre (le suivant est illisible),
 * ou reprendre à son début (le suivant n'est pas prêt).
 */
export function chainMove(left: number, next: StreamState | null): "wait" | "chain" | "replace" | "loop" {
  if (left > CHAIN_FADE + CHAIN_EARLY) return "wait";
  if (next === "ready") return "chain";
  if (next === "failed") return "replace";
  return left <= LOOP_BACK ? "loop" : "wait";
}

/** Ce que joue la musique, pour le lecteur (hud/nowPlaying.ts) et les paramètres. */
export interface MusicNow {
  /** Le morceau qu'on entend (null : rien, ou un écran qui attend le geste du joueur). */
  readonly track: Track | null;
  /** Son écran ; null pour un motif de fin de partie. */
  readonly theme: MusicTheme | null;
  /** Le motif de fin de partie qu'on entend. */
  readonly stinger: StingerKind | null;
  /** Le morceau demandé (suivant, précédent) qu'on prépare encore : celui qu'on entend continue d'ici là. */
  readonly pending: Track | null;
  /** Le morceau auquel `previous` reviendrait (null : aucun). */
  readonly previous: Track | null;
  /** On peut changer de morceau (un écran qui en a plusieurs, et dont la musique est celle voulue). */
  readonly canSkip: boolean;
}

/**
 * Ce qui change : un morceau commence (`start`), un morceau demandé se prépare (`loading`), il est
 * illisible (`failed` : on reste sur celui qu'on entend, `track` dit lequel a échoué), il n'y a pas
 * de morceau précédent (`none`), la musique se tait (`stop`).
 */
export type MusicChange = "start" | "loading" | "failed" | "none" | "stop";

/** Écoute du lecteur : ce que joue la musique, ce qui vient de changer, et si le joueur l'a demandé. */
export type MusicListener = (now: MusicNow, change: MusicChange, manual: boolean, track: Track | null) => void;

/** Un morceau lu en flux. */
interface Stream {
  track: Track;
  el: HTMLAudioElement;
  node: MediaElementAudioSourceNode;
  gain: GainNode;
  state: StreamState;
  /** Prêt à partir (`canplaythrough`), ou faux s'il est illisible. */
  ready: Promise<boolean>;
  /** Taille du fichier compressé (octets), pour les mesures. */
  bytes: number;
  url: string | null;
  released: boolean;
  /** Fondu de sortie en cours : à sa fin, le morceau est libéré, ou mis en pause s'il sert encore (0 : aucun). */
  timer: number;
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  track: Track;
  kind: StingerKind;
}

export class Music {
  private readonly ctx: AudioContext;
  private readonly bus: GainNode;
  private readonly base: string;
  /** Ce qu'on veut entendre (un écran, un motif, ou rien) ; un chargement dépassé est abandonné. */
  private wanted: MusicTheme | MusicKey | null = null;
  private request = 0;
  /** Le morceau qu'on entend et son écran. */
  private current: { stream: Stream; theme: MusicTheme } | null = null;
  /** Le morceau suivant de l'écran en cours, préparé d'avance. */
  private following: Stream | null = null;
  /** Le morceau demandé par le joueur (suivant, précédent), qu'on prépare encore. */
  private pending: Stream | null = null;
  /** Sauts demandés : un saut dépassé par un autre est abandonné. */
  private jumps = 0;
  /** Le premier morceau de chaque autre écran, préparé d'avance. */
  private readonly upcoming = new Map<MusicTheme, Stream>();
  /** Morceaux préparés ou en cours (un élément chacun). */
  private readonly streams = new Map<Track, Stream>();
  private readonly playlists = new Map<MusicTheme, Playlist<Track>>();
  private readonly stingerBags = new Map<StingerKind, ShuffleBag<Track>>();
  /** Motifs décodés, ou en train de l'être. */
  private readonly decoded = new Map<Track, Promise<AudioBuffer | null>>();
  private stingerVoice: Voice | null = null;
  /** Peu de mémoire : le garage n'est pas préparé d'avance. */
  private readonly frugal: boolean;
  /** Le lecteur écoute (voir `MusicListener`). */
  onChange: MusicListener | null = null;

  constructor(ctx: AudioContext, out: AudioNode, base: string) {
    this.ctx = ctx;
    this.base = base;
    this.bus = ctx.createGain();
    this.bus.connect(out);
    this.frugal = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
  }

  /** Volume de la musique (0 à 1), par-dessus le volume général. */
  setVolume(volume: number): void {
    this.bus.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.1);
  }

  /**
   * Prépare la musique : décode les motifs et prépare le premier morceau de l'accueil (attendus),
   * puis, sans les attendre, ceux de la partie et du garage. `progress` reçoit la part faite (0 à 1).
   */
  async preload(progress: (done: number) => void = () => {}): Promise<void> {
    const first: Promise<unknown>[] = [this.prepare("menu"), ...tracksOf([...STINGERS.victory, ...STINGERS.defeat]).map((t) => this.decode(t))];
    let done = 0;
    await Promise.all(first.map((p) => p.then(() => progress(++done / first.length))));
    // Ensuite, en arrière-plan : la partie (et le garage), pour qu'ils commencent sans attendre
    void this.prepare("battle").then(() => (this.frugal ? undefined : this.prepare("garage")));
  }

  /** Prépare le premier morceau de cet écran (il peut partir) ; rien à faire s'il joue déjà. */
  prepare(theme: MusicTheme): Promise<void> {
    if (this.current?.theme === theme) return Promise.resolve();
    const stream = this.upcomingStream(theme);
    return Promise.race([stream.ready, new Promise((resolve) => setTimeout(resolve, PREPARE_WAIT * 1000))]).then(() => undefined);
  }

  /** La musique d'un écran, ses morceaux enchaînés (rien ne change si c'est déjà elle) ; null : silence. */
  play(theme: MusicTheme | null): void {
    if (theme === this.wanted) return;
    this.wanted = theme;
    const request = ++this.request;
    // On revient à l'écran dont la musique joue encore (on l'avait quitté avant que l'autre parte)
    if (theme && this.current?.theme === theme) return;
    if (!theme) {
      const audible = !!this.current || !!this.stingerVoice;
      this.endScreen();
      this.fadeStinger();
      if (audible) this.emit("stop", false);
      return;
    }
    void this.begin(theme, request, 0);
  }

  /** Un motif de fin de partie, une fois ; la musique en cours s'efface. */
  stinger(kind: StingerKind): void {
    let bag = this.stingerBags.get(kind);
    if (!bag) this.stingerBags.set(kind, (bag = new ShuffleBag(tracksOf(STINGERS[kind]))));
    const track = bag.take();
    this.wanted = keyOf(track);
    const request = ++this.request;
    const audible = !!this.current;
    this.endScreen();
    if (audible) this.emit("stop", false);
    void this.decode(track).then((buffer) => {
      // Un autre morceau a été demandé pendant le chargement
      if (!buffer || request !== this.request) return;
      this.fadeStinger();
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(1, t + 0.05);
      src.connect(gain).connect(this.bus);
      src.start(t);
      const voice: Voice = { src, gain, track, kind };
      src.onended = () => {
        if (this.stingerVoice !== voice) return;
        this.stingerVoice = null;
        this.emit("stop", false);
      };
      this.stingerVoice = voice;
      this.emit("start", false);
    });
  }

  /**
   * Passe au morceau suivant de l'écran (le prochain du sac, ou celui qu'on avait quitté en revenant
   * en arrière), en fondu : tout de suite s'il est prêt, sinon dès qu'il l'est. Faux sans musique
   * d'écran (un motif, un écran qui se prépare). Console : `__casse.game.sound.nextMusic()`.
   */
  next(): boolean {
    return this.jump(1);
  }

  /** Revient au morceau d'avant de l'écran (son historique), de même ; faux s'il n'y en a pas. */
  previous(): boolean {
    return this.jump(-1);
  }

  /** Ce que joue la musique maintenant (voir `MusicNow`). */
  now(): MusicNow {
    const cur = this.current;
    if (!cur) {
      const voice = this.stingerVoice;
      return { track: voice?.track ?? null, theme: null, stinger: voice?.kind ?? null, pending: null, previous: null, canSkip: false };
    }
    const list = this.playlist(cur.theme);
    return {
      track: cur.stream.track,
      theme: cur.theme,
      stinger: null,
      pending: this.pending?.track ?? null,
      previous: list.peekPrevious() ?? null,
      canSkip: cur.theme === this.wanted && tracksOf(THEMES[cur.theme]).length > 1,
    };
  }

  /** Le premier morceau de l'écran, préparé, puis lancé (s'il est encore voulu). */
  private async begin(theme: MusicTheme, request: number, attempt: number): Promise<void> {
    const stream = this.upcomingStream(theme);
    const ok = await stream.ready;
    if (request !== this.request) return;
    const list = this.playlist(theme);
    if (!ok) {
      // Illisible : on passe au suivant du sac (une fois par morceau de l'écran, pas plus)
      if (this.upcoming.get(theme) === stream) this.upcoming.delete(theme);
      list.discardNext();
      this.retire(stream);
      if (attempt < tracksOf(THEMES[theme]).length) void this.begin(theme, request, attempt + 1);
      return;
    }
    // Contexte suspendu (pas encore de geste du joueur) : le morceau part dès qu'il reprend
    await this.running();
    if (request !== this.request) return;
    this.endScreen();
    this.fadeStinger();
    this.upcoming.delete(theme);
    list.next();
    this.launch(stream, FADE, false);
    this.current = { stream, theme };
    this.prepareFollowing();
    this.emit("start", false);
  }

  /**
   * Un saut demandé par le joueur : la liste de lecture avance (ou recule) tout de suite ; le
   * morceau qu'on entend s'efface dès que l'autre est prêt. Un nouveau saut avant cela remplace le
   * précédent ; un changement d'écran l'abandonne.
   */
  private jump(direction: 1 | -1): boolean {
    const cur = this.current;
    // Pas de musique d'écran, ou un autre écran se prépare : rien à sauter
    if (!cur || cur.theme !== this.wanted) return false;
    const list = this.playlist(cur.theme);
    if (tracksOf(THEMES[cur.theme]).length < 2) return false;
    const track = direction > 0 ? list.next() : list.previous();
    if (track === undefined) {
      this.emit("none", true);
      return false;
    }
    const id = ++this.jumps;
    const request = this.request;
    const old = this.pending;
    this.pending = null;
    if (track === cur.stream.track) {
      // Revenu au morceau qu'on entend (le joueur a changé d'avis avant que l'autre soit prêt)
      if (old) this.retire(old);
      this.prepareFollowing();
      this.emit("start", true);
      return true;
    }
    const stream = this.stream(track);
    this.pending = stream;
    if (old && old !== stream) this.retire(old);
    this.prepareFollowing();
    if (stream.state !== "ready") this.emit("loading", true);
    void stream.ready.then((ok) => {
      // Un autre saut, un autre écran entre-temps : ils ont pris la main
      if (id !== this.jumps || request !== this.request || this.current !== cur) return;
      this.pending = null;
      if (!ok) {
        // Illisible : on reste sur le morceau qu'on entend (la liste y revient)
        list.seek(cur.stream.track);
        this.retire(stream);
        this.prepareFollowing();
        this.emit("failed", true, track);
        return;
      }
      this.crossfade(cur.theme, cur.stream, stream, SKIP_FADE, true);
    });
    return true;
  }

  /** Prépare le morceau qui suivra (pas celui qu'on entend : un écran d'un seul morceau le reprend). */
  private prepareFollowing(): void {
    const cur = this.current;
    if (!cur) return;
    const next = this.playlist(cur.theme).peekNext();
    const old = this.following;
    this.following = next === cur.stream.track ? null : this.stream(next);
    if (old && old !== this.following) this.retire(old);
  }

  /**
   * Lance un morceau, avec un fondu d'entrée (en puissance constante si `curve`) : à sa marge de
   * début, ou là où il en est s'il s'efface encore (on y revient aussitôt).
   */
  private launch(stream: Stream, fade: number, curve: boolean): void {
    window.clearTimeout(stream.timer);
    stream.timer = 0;
    const v = stream.gain.gain.value;
    ramp(stream.gain.gain, this.ctx.currentTime, fade, curve ? (x) => v + (1 - v) * Math.sin((Math.PI / 2) * x) : null, v, 1);
    const el = stream.el;
    if (el.paused) el.currentTime = LOOP_PAD;
    el.ontimeupdate = () => this.tick(stream);
    el.play().catch((err: unknown) => {
      if ((err as { name?: string }).name !== "NotAllowedError") return;
      // Lecture refusée sans geste du joueur : au prochain, s'il est encore en cours
      const retry = (): void => {
        window.removeEventListener("pointerdown", retry, true);
        window.removeEventListener("keydown", retry, true);
        if (!stream.released && (this.current?.stream === stream)) void el.play().catch(() => undefined);
      };
      window.addEventListener("pointerdown", retry, true);
      window.addEventListener("keydown", retry, true);
    });
  }

  /** Efface un morceau (en puissance constante si `curve`) ; à la fin du fondu, il est libéré ou mis en pause (`retire`). */
  private fadeOut(stream: Stream, fade: number, curve: boolean): void {
    stream.el.ontimeupdate = null;
    const v = stream.gain.gain.value;
    ramp(stream.gain.gain, this.ctx.currentTime, fade, curve ? (x) => v * Math.cos((Math.PI / 2) * x) : null, v, 0);
    window.clearTimeout(stream.timer);
    stream.timer = window.setTimeout(() => {
      stream.timer = 0;
      this.retire(stream);
    }, (fade + 0.3) * 1000);
  }

  /** Heure de lecture du morceau en cours : enchaîner, reprendre à son début, ou attendre. */
  private tick(stream: Stream): void {
    const cur = this.current;
    if (!cur || cur.stream !== stream) return;
    const el = stream.el;
    const left = el.duration - LOOP_PAD - el.currentTime;
    if (!Number.isFinite(left)) return;
    const next = this.following;
    // Un autre écran est voulu (il se prépare), ou le joueur a demandé un autre morceau (il se
    // prépare) : on n'enchaîne plus, on reprend au début en l'attendant
    const move = cur.theme === this.wanted && !this.pending ? chainMove(left, next ? next.state : null) : chainMove(left, null);
    switch (move) {
      case "chain":
        this.playlist(cur.theme).next();
        this.crossfade(cur.theme, stream, next!, Math.max(0.5, Math.min(CHAIN_FADE, left - 0.1)), false);
        break;
      case "replace":
        // Illisible : on l'écarte (il reviendra au tour suivant du sac) et on en prépare un autre
        this.playlist(cur.theme).discardNext();
        this.following = null;
        this.retire(next!);
        this.prepareFollowing();
        break;
      case "loop":
        // Sa fin mène à son début : la marge de début répète ce qui précède la fin
        el.currentTime = Math.max(0, LOOP_PAD - Math.max(0, left));
        break;
      case "wait":
        break;
    }
  }

  /** Fondu enchaîné du morceau qu'on entend à un autre du même écran (`manual` : demandé par le joueur). */
  private crossfade(theme: MusicTheme, from: Stream, to: Stream, fade: number, manual: boolean): void {
    this.fadeOut(from, fade, true);
    this.launch(to, fade, true);
    this.current = { stream: to, theme };
    this.prepareFollowing();
    this.emit("start", manual);
  }

  /** L'écran s'achève : son morceau s'efface ; le suivant préparé servira la prochaine fois. */
  private endScreen(): void {
    const pending = this.pending;
    this.pending = null;
    // Un saut en cours est abandonné
    this.jumps++;
    if (pending) this.retire(pending);
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const { stream, theme } = cur;
    const list = this.playlist(theme);
    list.stop();
    this.fadeOut(stream, FADE, false);
    const following = this.following;
    this.following = null;
    if (!following) return;
    if (!(this.frugal && theme === "garage") && !this.upcoming.has(theme) && following.track === list.peekNext()) {
      this.upcoming.set(theme, following);
    } else {
      this.retire(following);
    }
  }

  private fadeStinger(): void {
    const old = this.stingerVoice;
    if (!old) return;
    this.stingerVoice = null;
    const t = this.ctx.currentTime;
    old.gain.gain.cancelScheduledValues(t);
    old.gain.gain.setValueAtTime(old.gain.gain.value, t);
    old.gain.gain.linearRampToValueAtTime(0, t + FADE);
    old.src.stop(t + FADE + 0.05);
  }

  private emit(change: MusicChange, manual: boolean, track: Track | null = null): void {
    this.onChange?.(this.now(), change, manual, track);
  }

  private playlist(theme: MusicTheme): Playlist<Track> {
    let list = this.playlists.get(theme);
    if (!list) this.playlists.set(theme, (list = new Playlist(tracksOf(THEMES[theme]))));
    return list;
  }

  /** Le premier morceau d'un écran, préparé d'avance (le prochain de sa liste de lecture). */
  private upcomingStream(theme: MusicTheme): Stream {
    const next = this.playlist(theme).peekNext();
    let stream = this.upcoming.get(theme);
    if (!stream || stream.released || stream.track !== next) {
      const old = stream;
      stream = this.stream(next);
      this.upcoming.set(theme, stream);
      if (old && old !== stream) this.retire(old);
    }
    return stream;
  }

  /** L'élément d'un morceau (créé et préparé s'il n'existe pas). */
  private stream(track: Track): Stream {
    const existing = this.streams.get(track);
    if (existing) return existing;
    const el = new Audio();
    el.preload = "auto";
    // Filet : s'il n'était pas relayé à temps, le morceau ne s'arrête jamais (voir `tick`)
    el.loop = true;
    const node = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    node.connect(gain).connect(this.bus);
    const stream: Stream = { track, el, node, gain, state: "loading", ready: Promise.resolve(false), bytes: 0, url: null, released: false, timer: 0 };
    stream.ready = fetch(`${this.base}sounds/${track}.ogg`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => new Promise<boolean>((resolve) => {
        if (stream.released) return resolve(false);
        stream.bytes = blob.size;
        stream.url = URL.createObjectURL(blob);
        el.addEventListener("canplaythrough", () => resolve(true), { once: true });
        el.addEventListener("error", () => resolve(false), { once: true });
        el.src = stream.url;
      }))
      .catch((err) => {
        console.warn(`Musique ${track} illisible :`, err);
        return false;
      })
      .then((ok) => {
        stream.state = ok ? "ready" : "failed";
        return ok;
      });
    this.streams.set(track, stream);
    return stream;
  }

  /** Ce morceau sert-il encore (le suivant, le premier d'un écran, le saut demandé) ? */
  private needed(stream: Stream): boolean {
    return this.following === stream || this.pending === stream || [...this.upcoming.values()].includes(stream);
  }

  /**
   * Un morceau dont on n'a plus besoin tout de suite : s'il s'efface encore, la fin de son fondu en
   * décidera ; s'il sert encore, il est mis en pause (il reprendra à son début) ; sinon, libéré.
   */
  private retire(stream: Stream): void {
    if (stream.released || stream.timer || this.current?.stream === stream) return;
    if (this.needed(stream)) {
      stream.el.ontimeupdate = null;
      stream.el.pause();
      return;
    }
    this.release(stream);
  }

  /** Libère un morceau dont plus personne n'a besoin (ni en cours, ni suivant, ni préparé). */
  private release(stream: Stream): void {
    if (stream.released || this.current?.stream === stream || this.needed(stream)) return;
    stream.released = true;
    window.clearTimeout(stream.timer);
    stream.timer = 0;
    this.streams.delete(stream.track);
    const el = stream.el;
    el.ontimeupdate = null;
    el.pause();
    el.removeAttribute("src");
    el.load();
    stream.node.disconnect();
    stream.gain.disconnect();
    if (stream.url) URL.revokeObjectURL(stream.url);
    stream.url = null;
  }

  /** Attend que le contexte audio tourne (il est suspendu jusqu'au premier geste du joueur). */
  private running(): Promise<void> {
    const ctx = this.ctx;
    if (ctx.state === "running") return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (ctx.state !== "running") return;
        ctx.removeEventListener("statechange", check);
        resolve();
      };
      ctx.addEventListener("statechange", check);
    });
  }

  /** Un motif décodé (gardé : il doit partir à l'instant). */
  private decode(track: Track): Promise<AudioBuffer | null> {
    let decoded = this.decoded.get(track);
    if (!decoded) {
      decoded = fetch(`${this.base}sounds/${track}.ogg`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((data) => this.ctx.decodeAudioData(data))
        .catch((err) => {
          console.warn(`Musique ${track} illisible :`, err);
          return null;
        });
      this.decoded.set(track, decoded);
    }
    return decoded;
  }

  /** Mémoire des motifs décodés (Mo, échantillons en flottants de 32 bits), pour les mesures. */
  async decodedMegabytes(): Promise<number> {
    const buffers = await Promise.all(this.decoded.values());
    return buffers.reduce((s, b) => s + (b ? (b.length * b.numberOfChannels * 4) / 1e6 : 0), 0);
  }

  /** Fichiers compressés des morceaux préparés ou en cours (Mo), pour les mesures. */
  compressedMegabytes(): number {
    return [...this.streams.values()].reduce((s, st) => s + st.bytes / 1e6, 0);
  }

  /** Ce qui joue et ce qui est prêt (essais, console : `__casse.game.sound.musicState()`). */
  debugState(): {
    wanted: string | null; current: string | null; at: number; following: string | null; pending: string | null;
    upcoming: Record<string, string>; streams: string[]; history: { behind: Track[]; ahead: Track[] } | null; compressedMb: number;
  } {
    const cur = this.current;
    return {
      wanted: this.wanted,
      current: cur?.stream.track ?? null,
      at: cur?.stream.el.currentTime ?? 0,
      following: this.following ? `${this.following.track} (${this.following.state})` : null,
      pending: this.pending ? `${this.pending.track} (${this.pending.state})` : null,
      upcoming: Object.fromEntries([...this.upcoming].map(([theme, s]) => [theme, `${s.track} (${s.state})`])),
      streams: [...this.streams.keys()],
      history: cur ? this.playlist(cur.theme).snapshot() : null,
      compressedMb: Math.round(this.compressedMegabytes() * 10) / 10,
    };
  }
}

/**
 * Un fondu de gain de `t` à `t + d`, de `from` à `to`, en suivant `f` (de 0 à 1 ; null : une rampe
 * linéaire). Les automatisations en cours sont annulées d'abord (la valeur a été lue avant : pas de
 * saut) ; sans courbe possible, une rampe linéaire.
 */
function ramp(param: AudioParam, t: number, d: number, f: ((x: number) => number) | null, from: number, to: number): void {
  param.cancelScheduledValues(t);
  if (f) {
    const n = 64;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = f(i / (n - 1));
    try {
      param.setValueCurveAtTime(curve, t, d);
      return;
    } catch {
      // (une courbe refusée : la rampe ci-dessous)
    }
  }
  param.setValueAtTime(from, t);
  param.linearRampToValueAtTime(to, t + d);
}
