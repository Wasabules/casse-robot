import { LOOP_PAD } from "./samples";

/*
 * Musique (générée avec ElevenLabs, voir tools/sounds) : chaque écran (accueil, garage, partie) a
 * plusieurs morceaux, joués l'un après l'autre en sac mélangé (`ShuffleBag` : tous passent avant
 * qu'un ne revienne, jamais deux fois de suite le même), un fondu enchaîné de `CHAIN_FADE` s passant
 * de l'un à l'autre ; en fin de partie, un court motif de victoire ou de défaite.
 *
 * Les morceaux durent de 1 à 4 minutes : décodés, ils pèseraient ~0,4 Mo par seconde (~96 Mo pour
 * 4 min, le double avec le suivant). Ils sont donc lus en flux : un élément <audio> (sur une URL
 * `blob:` du fichier compressé, téléchargé quand le morceau est préparé) branché au bus par
 * `createMediaElementSource`, le fondu sur un `GainNode`. Seule la version compressée reste en
 * mémoire (112 kb/s : ~3,4 Mo pour 4 min), le temps que le morceau serve : le morceau en cours et
 * le suivant de l'écran en cours, plus le premier de chacun des autres écrans (préparé d'avance :
 * élément créé, `canplaythrough` atteint), soit quatre morceaux, cinq pendant un fondu : ~15 Mo au
 * plus (`compressedMegabytes`). Un morceau fini est libéré (élément vidé, nœud débranché, URL
 * révoquée). Les motifs, qui doivent partir à l'instant, restent décodés (~3 Mo chacun :
 * `decodedMegabytes`). Sur une machine à peu de mémoire (`navigator.deviceMemory` ≤ 4), le garage
 * n'est pas préparé d'avance.
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
/**
 * Marge (s) : le fondu enchaîné finit avant la marge de fin du morceau, et l'heure de lecture
 * n'arrive que par `timeupdate` (toutes les ~0,25 s).
 */
const CHAIN_EARLY = 0.4;
/** Le suivant pas prêt : à moins de tant (s) de sa fin, le morceau reprend à son début. */
const LOOP_BACK = 0.4;
/** Au plus tant (s) d'attente pour préparer un morceau (écran de chargement d'une partie). */
const PREPARE_WAIT = 15;

/** Un fichier de musique : un morceau et sa variante (« music-menu-2 »). */
export type Track = `${MusicKey}-${number}`;
const trackOf = (key: MusicKey, n: number): Track => `${key}-${n}`;

/** Toutes les variantes de ces morceaux. */
export const tracksOf = (keys: readonly MusicKey[]): Track[] =>
  keys.flatMap((key) => Array.from({ length: MUSIC_TRACKS[key] }, (_, i) => trackOf(key, i + 1)));

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
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

export class Music {
  private readonly ctx: AudioContext;
  private readonly bus: GainNode;
  private readonly base: string;
  /** Ce qu'on veut entendre (un écran, un motif, ou rien) ; un chargement dépassé est abandonné. */
  private wanted: MusicTheme | MusicKey | null = null;
  private request = 0;
  /** Le morceau en cours et son écran. */
  private current: { stream: Stream; theme: MusicTheme } | null = null;
  /** Le morceau suivant de l'écran en cours, préparé d'avance. */
  private following: Stream | null = null;
  /** Le premier morceau de chaque autre écran, préparé d'avance. */
  private readonly upcoming = new Map<MusicTheme, Stream>();
  /** Morceaux préparés ou en cours (un élément chacun). */
  private readonly streams = new Map<Track, Stream>();
  private readonly bags = new Map<MusicTheme, ShuffleBag<Track>>();
  private readonly stingerBags = new Map<StingerKind, ShuffleBag<Track>>();
  /** Motifs décodés, ou en train de l'être. */
  private readonly decoded = new Map<Track, Promise<AudioBuffer | null>>();
  private stingerVoice: Voice | null = null;
  /** Peu de mémoire : le garage n'est pas préparé d'avance. */
  private readonly frugal: boolean;

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
      this.endScreen();
      this.fadeStinger();
      return;
    }
    void this.begin(theme, request, 0);
  }

  /** Un motif de fin de partie, une fois ; la musique en cours s'efface. */
  stinger(kind: StingerKind): void {
    let bag = this.stingerBags.get(kind);
    if (!bag) this.stingerBags.set(kind, (bag = new ShuffleBag(tracksOf(STINGERS[kind]))));
    const track = bag.take();
    this.wanted = track.slice(0, track.lastIndexOf("-")) as MusicKey;
    const request = ++this.request;
    this.endScreen();
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
      this.stingerVoice = { src, gain };
    });
  }

  /** Le premier morceau de l'écran, préparé, puis lancé (s'il est encore voulu). */
  private async begin(theme: MusicTheme, request: number, attempt: number): Promise<void> {
    const stream = this.upcomingStream(theme);
    const ok = await stream.ready;
    if (request !== this.request) return;
    if (!ok) {
      // Illisible : on passe au suivant du sac (une fois par morceau de l'écran, pas plus)
      this.upcoming.delete(theme);
      this.bag(theme).take();
      this.release(stream);
      if (attempt < tracksOf(THEMES[theme]).length) void this.begin(theme, request, attempt + 1);
      return;
    }
    // Contexte suspendu (pas encore de geste du joueur) : le morceau part dès qu'il reprend
    await this.running();
    if (request !== this.request) return;
    this.endScreen();
    this.fadeStinger();
    this.upcoming.delete(theme);
    this.bag(theme).take();
    this.launch(stream, FADE, false);
    this.current = { stream, theme };
    this.prepareFollowing();
  }

  /** Prépare le morceau qui suivra celui en cours (pas lui-même : un écran d'un seul morceau le reprend). */
  private prepareFollowing(): void {
    const cur = this.current!;
    const bag = this.bag(cur.theme);
    // Le sac propose le morceau en cours (un suivant illisible a été écarté en fin de tour) : on le saute
    if (bag.peek() === cur.stream.track && tracksOf(THEMES[cur.theme]).length > 1) bag.take();
    const next = bag.peek();
    this.following = next === cur.stream.track ? null : this.stream(next);
  }

  /** Lance un morceau à sa marge de début, avec un fondu d'entrée (en puissance constante si `curve`). */
  private launch(stream: Stream, fade: number, curve: boolean): void {
    const t = this.ctx.currentTime;
    const g = stream.gain.gain;
    g.cancelScheduledValues(t);
    if (curve) {
      setCurve(g, t, fade, (x) => Math.sin((Math.PI / 2) * x));
    } else {
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(1, t + fade);
    }
    const el = stream.el;
    el.currentTime = LOOP_PAD;
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

  /** Heure de lecture du morceau en cours : enchaîner, reprendre à son début, ou attendre. */
  private tick(stream: Stream): void {
    const cur = this.current;
    if (!cur || cur.stream !== stream) return;
    const el = stream.el;
    const left = el.duration - LOOP_PAD - el.currentTime;
    if (!Number.isFinite(left)) return;
    const next = this.following;
    // Un autre écran est voulu (il se prépare) : on n'enchaîne plus, on reprend au début en l'attendant
    const move = cur.theme === this.wanted ? chainMove(left, next ? next.state : null) : chainMove(left, null);
    switch (move) {
      case "chain":
        this.chain(cur.theme, stream, next!, Math.max(0.5, Math.min(CHAIN_FADE, left - 0.1)));
        break;
      case "replace":
        // Illisible : on l'écarte (il reviendra au tour suivant du sac) et on en prépare un autre
        this.bag(cur.theme).take();
        this.following = null;
        this.release(next!);
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

  /** Passe tout de suite au morceau suivant, s'il est prêt (essais, console : `__casse.game.sound.skipMusic()`). */
  skip(): boolean {
    const cur = this.current;
    if (!cur || this.following?.state !== "ready") return false;
    this.chain(cur.theme, cur.stream, this.following, CHAIN_FADE);
    return true;
  }

  /** Fondu enchaîné du morceau en cours au suivant du même écran. */
  private chain(theme: MusicTheme, from: Stream, to: Stream, fade: number): void {
    this.bag(theme).take();
    const t = this.ctx.currentTime;
    const g = from.gain.gain;
    const v = g.value;
    g.cancelScheduledValues(t);
    setCurve(g, t, fade, (x) => v * Math.cos((Math.PI / 2) * x));
    from.el.ontimeupdate = null;
    setTimeout(() => this.release(from), (fade + 0.3) * 1000);
    this.launch(to, fade, true);
    this.current = { stream: to, theme };
    this.prepareFollowing();
  }

  /** L'écran s'achève : son morceau s'efface ; le suivant préparé servira la prochaine fois. */
  private endScreen(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const { stream, theme } = cur;
    stream.el.ontimeupdate = null;
    const t = this.ctx.currentTime;
    const g = stream.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + FADE);
    setTimeout(() => this.release(stream), (FADE + 0.3) * 1000);
    const following = this.following;
    this.following = null;
    if (!following) return;
    if (!(this.frugal && theme === "garage") && !this.upcoming.has(theme) && following.track === this.bag(theme).peek()) {
      this.upcoming.set(theme, following);
    } else {
      this.release(following);
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

  private bag(theme: MusicTheme): ShuffleBag<Track> {
    let bag = this.bags.get(theme);
    if (!bag) this.bags.set(theme, (bag = new ShuffleBag(tracksOf(THEMES[theme]))));
    return bag;
  }

  /** Le premier morceau d'un écran, préparé d'avance (le prochain de son sac). */
  private upcomingStream(theme: MusicTheme): Stream {
    let stream = this.upcoming.get(theme);
    if (!stream || stream.released) {
      stream = this.stream(this.bag(theme).peek());
      this.upcoming.set(theme, stream);
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
    const stream: Stream = { track, el, node, gain, state: "loading", ready: Promise.resolve(false), bytes: 0, url: null, released: false };
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

  /** Libère un morceau dont plus personne n'a besoin (ni en cours, ni suivant, ni préparé). */
  private release(stream: Stream): void {
    if (stream.released || this.current?.stream === stream || this.following === stream || [...this.upcoming.values()].includes(stream)) return;
    stream.released = true;
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
  debugState(): { wanted: string | null; current: string | null; at: number; following: string | null; upcoming: Record<string, string>; streams: string[]; compressedMb: number } {
    return {
      wanted: this.wanted,
      current: this.current?.stream.track ?? null,
      at: this.current?.stream.el.currentTime ?? 0,
      following: this.following ? `${this.following.track} (${this.following.state})` : null,
      upcoming: Object.fromEntries([...this.upcoming].map(([theme, s]) => [theme, `${s.track} (${s.state})`])),
      streams: [...this.streams.keys()],
      compressedMb: Math.round(this.compressedMegabytes() * 10) / 10,
    };
  }
}

/** Une courbe de gain de `t` à `t + d` (f de 0 à 1), sinon une rampe linéaire vers sa fin. */
function setCurve(param: AudioParam, t: number, d: number, f: (x: number) => number): void {
  const n = 64;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = f(i / (n - 1));
  try {
    param.setValueCurveAtTime(curve, t, d);
  } catch {
    param.setValueAtTime(curve[0], t);
    param.linearRampToValueAtTime(curve[n - 1], t + d);
  }
}
