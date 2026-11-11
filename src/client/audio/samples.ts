/*
 * Sons enregistrés (générés avec ElevenLabs, voir tools/sounds) : chaque son a ses variantes,
 * fichiers public/sounds/<son>-<n>.ogg (Opus, mono). Ils sont chargés après le premier geste du
 * joueur (quand le son est permis) ; tant qu'un son n'est pas chargé, ou si le navigateur ne lit
 * pas l'Opus, le jeu joue son équivalent synthétisé (audio/sound.ts).
 */

interface SampleDef {
  /** Nombre de variantes (fichiers <son>-1.ogg à <son>-n.ogg). */
  readonly variants: number;
  /**
   * Volume de base (un son ponctuel a sa crête à -1 dB ; une boucle, son niveau moyen à -16 dB,
   * voir tools/sounds/build.mjs).
   */
  readonly gain: number;
  /** Boucle : encodée avec LOOP_PAD s de marge de chaque côté, on ne la fait boucler qu'entre les deux. */
  readonly loop?: true;
  /**
   * Portée (m) : jusqu'à cette distance, il garde tout son volume, puis il décroît (5 par défaut) ;
   * au-delà de `hearing` (90 par défaut), il n'est pas joué. Une explosion porte loin, un bip non.
   */
  readonly reach?: number;
  readonly hearing?: number;
}

/**
 * Marge d'une boucle (s) : sa fin est recopiée avant son début et son début après sa fin, car
 * l'Opus abîme les bords d'un fichier (voir tools/sounds/build.mjs, qui utilise la même valeur).
 */
export const LOOP_PAD = 0.1;
/** Durée (s) du raccord refait au début d'une boucle décodée (voir `mendLoop`). */
const MEND = 0.02;

/**
 * Raccord d'une boucle décodée : ses premiers échantillons (après la marge) sont fondus avec ceux
 * de la marge d'après sa fin, qui les répètent et suivent sans à-coup la fin telle qu'elle a été
 * décodée. L'Opus ne décode pas deux fois un passage exactement pareil : sans cela, un vent grave
 * claque à chaque tour de boucle.
 */
export function mendLoop(buffer: AudioBuffer): void {
  const start = Math.round(LOOP_PAD * buffer.sampleRate);
  const end = buffer.length - start;
  const n = Math.min(start, Math.round(MEND * buffer.sampleRate));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const w = i / n;
      d[start + i] = d[end + i] * (1 - w) + d[start + i] * w;
    }
  }
}

export const SAMPLES = {
  // Tirs (un son par tir ; `-loop` : en boucle tant que l'arme tire)
  "rifle-shot": { variants: 4, gain: 0.8 },
  "sniper-shot": { variants: 3, gain: 0.85, reach: 10, hearing: 200 },
  "cannon-shot": { variants: 4, gain: 0.9, reach: 10, hearing: 160 },
  "missile-launch": { variants: 3, gain: 0.6, reach: 8, hearing: 140 },
  "flak-shot": { variants: 3, gain: 0.6 },
  "mine-drop": { variants: 3, gain: 0.5 },
  "flamer-loop": { variants: 2, gain: 0.35, loop: true },
  "emp-shot": { variants: 3, gain: 0.6 },
  "smoke-shot": { variants: 3, gain: 0.5 },
  "laser-shot": { variants: 4, gain: 0.3 },
  "rail-shot": { variants: 3, gain: 0.85, reach: 10, hearing: 180 },
  "shotgun-shot": { variants: 4, gain: 0.8, reach: 7, hearing: 120 },
  "rocket-launch": { variants: 4, gain: 0.4 },
  "plasma-loop": { variants: 2, gain: 0.3, loop: true },
  "lockon-launch": { variants: 3, gain: 0.6 },
  "warhead-launch": { variants: 2, gain: 0.9, reach: 12, hearing: 200 },
  "bomb-release": { variants: 4, gain: 0.6 },
  "flare-launch": { variants: 3, gain: 0.7, reach: 8, hearing: 120 },
  "repair-beam": { variants: 3, gain: 0.3, loop: true },
  // Essaim de nanorobots : scintillement aigu (6 à 10 kHz), qui s'entend plus fort à niveau égal
  "nanite-launch": { variants: 3, gain: 0.5 },
  // Armes de contact. Boucles de régime (`-whine`, `-hum`, `-whirl`) : le jeu règle leur hauteur et
  // leur volume selon le régime ou la charge ; les aiguës (scie, fléau) s'entendent plus fort à niveau
  // égal, les graves (anneau, foreuse, champ) moins. `-bite` : la coupe d'une lame qui mord, en boucle,
  // plus forte avec sa puissance
  "spinner-whine": { variants: 3, gain: 0.4, loop: true },
  "disc-whine": { variants: 3, gain: 0.35, loop: true },
  "drum-whine": { variants: 3, gain: 0.35, loop: true },
  "shell-whine": { variants: 2, gain: 0.5, loop: true },
  "flail-whirl": { variants: 3, gain: 0.3, loop: true },
  "saw-whine": { variants: 3, gain: 0.22, loop: true },
  "saw-bite": { variants: 2, gain: 0.4, loop: true },
  "drill-whine": { variants: 3, gain: 0.45, loop: true },
  "drill-bite": { variants: 2, gain: 0.4, loop: true },
  "saber-hum": { variants: 2, gain: 0.35, loop: true },
  // Champ broyeur : un bourdon très grave (86 à 170 Hz), qui demande plus de volume
  "field-hum": { variants: 3, gain: 0.45, loop: true },
  // Tenues tant que les coups se suivent : la lame laser qui découpe, la mâchoire qui écrase
  "saber-cut": { variants: 3, gain: 0.3, loop: true },
  "jaw-crush": { variants: 2, gain: 0.45, loop: true },
  // Coups (plus forts et plus graves avec leur énergie) et départs des bras
  "spinner-hit": { variants: 4, gain: 0.85, reach: 8, hearing: 130 },
  "disc-hit": { variants: 4, gain: 0.8, reach: 8, hearing: 130 },
  "drum-hit": { variants: 3, gain: 0.6, reach: 6, hearing: 100 },
  "shell-hit": { variants: 3, gain: 0.85, reach: 10, hearing: 140 },
  "propeller-hit": { variants: 3, gain: 0.6, reach: 6, hearing: 100 },
  "hammer-swing": { variants: 3, gain: 0.4 },
  "hammer-hit": { variants: 3, gain: 0.85, reach: 8, hearing: 130 },
  "flipper-swing": { variants: 3, gain: 0.75, reach: 8, hearing: 120 },
  "flail-hit": { variants: 4, gain: 0.75, reach: 8, hearing: 120 },
  "jaw-swing": { variants: 3, gain: 0.5 },
  "whip-swing": { variants: 3, gain: 0.45 },
  "whip-hit": { variants: 3, gain: 0.5 },
  "lance-swing": { variants: 3, gain: 0.3 },
  "lance-hit": { variants: 3, gain: 0.55, reach: 6, hearing: 100 },
  // Projectiles : en vol (en boucle), et la balle qui siffle à l'oreille
  "missile-flight": { variants: 2, gain: 0.35, loop: true },
  "rocket-flight": { variants: 2, gain: 0.25, loop: true },
  "warhead-flight": { variants: 2, gain: 0.45, loop: true },
  "shell-whistle": { variants: 2, gain: 0.25, loop: true },
  "bomb-whistle": { variants: 3, gain: 0.35, loop: true },
  "flare-burn": { variants: 3, gain: 0.3, loop: true },
  "bullet-flyby": { variants: 4, gain: 0.5 },
  // Moteurs, en boucle : le jeu règle leur hauteur et leur volume selon la vitesse ou la poussée
  // Roues : pneus à crampons sur la terre et le gravier, transmission, petit diesel en fond
  "wheels-roll": { variants: 3, gain: 0.5, loop: true },
  tracks: { variants: 2, gain: 0.45, loop: true },
  "legs-servo": { variants: 2, gain: 0.35, loop: true },
  "hover-pad": { variants: 2, gain: 0.35, loop: true },
  "rotor-heli": { variants: 2, gain: 0.5, loop: true },
  "rotor-drone": { variants: 2, gain: 0.35, loop: true },
  "propeller-plane": { variants: 2, gain: 0.4, loop: true },
  "propeller-big": { variants: 3, gain: 0.45, loop: true },
  "jet-engine": { variants: 3, gain: 0.5, loop: true },
  // Impacts, explosions, casse
  "impact-metal": { variants: 3, gain: 0.3 },
  "impact-ground": { variants: 4, gain: 0.25 },
  "impact-prop": { variants: 3, gain: 0.3 },
  "missile-intercepted": { variants: 3, gain: 0.7, reach: 8, hearing: 150 },
  "explosion-small": { variants: 2, gain: 0.8, reach: 10, hearing: 150 },
  explosion: { variants: 8, gain: 1, reach: 18, hearing: 220 },
  "explosion-huge": { variants: 6, gain: 1, reach: 40, hearing: 350 },
  "explosion-bomb": { variants: 4, gain: 1, reach: 25, hearing: 280 },
  "napalm-burst": { variants: 3, gain: 0.9, reach: 15, hearing: 200 },
  "block-break": { variants: 4, gain: 0.45 },
  "link-snap": { variants: 3, gain: 0.6 },
  collision: { variants: 4, gain: 0.7, reach: 8 },
  "robot-destroyed": { variants: 3, gain: 1, reach: 15, hearing: 220 },
  "crate-break": { variants: 3, gain: 0.6 },
  // Décor destructible de la Vallée : un pan de mur qui s'écroule, un arbre qui tombe, de la tôle
  "wall-collapse": { variants: 3, gain: 0.85, reach: 10, hearing: 140 },
  "tree-fall": { variants: 2, gain: 0.8, reach: 10, hearing: 120 },
  "metal-crash": { variants: 2, gain: 0.75, reach: 8, hearing: 120 },
  // Effets
  "fire-ignite": { variants: 3, gain: 0.45 },
  "fire-loop": { variants: 2, gain: 0.3, loop: true },
  "emp-burst": { variants: 3, gain: 0.7 },
  "stun-crackle": { variants: 2, gain: 0.45 },
  "smoke-hiss": { variants: 2, gain: 0.4 },
  "shield-hit": { variants: 4, gain: 0.4 },
  // Mur d'énergie : il se déploie, puis se brise (un éclat qui porte loin) ; blindage qui se reconstitue
  "barrier-deploy": { variants: 3, gain: 0.6, reach: 8, hearing: 100 },
  "barrier-break": { variants: 3, gain: 0.55, reach: 10, hearing: 120 },
  "block-regrow": { variants: 3, gain: 0.4, hearing: 60 },
  // Interface (sans spatialisation)
  "lock-acquired": { variants: 2, gain: 0.25 },
  "hit-marker": { variants: 4, gain: 0.25 },
  "kill-confirm": { variants: 3, gain: 0.35 },
  hurt: { variants: 3, gain: 0.4 },
  "zone-captured": { variants: 2, gain: 0.35 },
  "zone-lost": { variants: 2, gain: 0.35 },
  // Alertes du robot du joueur, et de la partie (interface)
  "overheat-alarm": { variants: 2, gain: 0.3 },
  "dry-fire": { variants: 3, gain: 0.35 },
  "reload-ready": { variants: 3, gain: 0.3 },
  "missile-warning": { variants: 2, gain: 0.3 },
  "integrity-alarm": { variants: 2, gain: 0.3 },
  "battery-low": { variants: 2, gain: 0.3 },
  "match-start": { variants: 2, gain: 0.15 },
  "countdown-tick": { variants: 2, gain: 0.3 },
  "hill-moved": { variants: 2, gain: 0.35 },
  // Dans l'arène
  respawn: { variants: 3, gain: 0.5 },
  righting: { variants: 2, gain: 0.5 },
  "mine-arm": { variants: 2, gain: 0.2, hearing: 25 },
  "mine-jump": { variants: 3, gain: 0.6, hearing: 50 },
  "limpet-attach": { variants: 3, gain: 0.6, hearing: 50 },
  "sensor-ping": { variants: 3, gain: 0.3, hearing: 40 },
  "remote-detonator": { variants: 3, gain: 0.5 },
  footstep: { variants: 4, gain: 0.45 },
  "gas-leak": { variants: 1, gain: 0.35, loop: true },
  "fuse-hiss": { variants: 2, gain: 0.3, loop: true },
  // Menus et garage (interface)
  "menu-click": { variants: 3, gain: 0.25 },
  "menu-hover": { variants: 2, gain: 0.12 },
  "menu-back": { variants: 2, gain: 0.25 },
  unlock: { variants: 2, gain: 0.4 },
  credits: { variants: 2, gain: 0.35 },
  "garage-place": { variants: 4, gain: 0.35 },
  "garage-remove": { variants: 3, gain: 0.3 },
  "garage-rotate": { variants: 2, gain: 0.3 },
  "garage-wheel": { variants: 2, gain: 0.35 },
  "garage-error": { variants: 2, gain: 0.3 },
  "garage-save": { variants: 2, gain: 0.35 },
  // Ambiances des arènes (stéréo, en boucle, sans spatialisation)
  "amb-depot": { variants: 2, gain: 0.25, loop: true },
  "amb-fortress": { variants: 2, gain: 0.25, loop: true },
  "amb-trenches": { variants: 2, gain: 0.25, loop: true },
  "amb-yard": { variants: 1, gain: 0.25, loop: true },
  // Vent dans les pins, rivière, oiseaux : surtout des aigus, qui s'entendent plus fort à niveau égal
  "amb-valley": { variants: 2, gain: 0.13, loop: true },
} as const satisfies Record<string, SampleDef>;

export type SampleKey = keyof typeof SAMPLES;

/** Fichier d'une variante (n à partir de 1), par rapport à la racine du site. */
export const sampleFile = (key: SampleKey, n: number): string => `sounds/${key}-${n}.ogg`;

/** Le navigateur lit-il l'Opus dans un conteneur Ogg ? (Sinon, le jeu garde ses sons synthétisés.) */
export function canPlayOpus(): boolean {
  try {
    return document.createElement("audio").canPlayType('audio/ogg; codecs="opus"') !== "";
  } catch {
    return false;
  }
}

/** Les sons enregistrés, décodés, avec leurs variantes. */
export class SampleBank {
  private readonly ctx: AudioContext;
  private readonly buffers = new Map<SampleKey, AudioBuffer[]>();
  /** Dernière variante jouée de chaque son : on ne la rejoue pas aussitôt. */
  private readonly last = new Map<SampleKey, number>();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /**
   * Charge et décode tous les sons (`base` : racine du site). Un fichier manquant est signalé et
   * ignoré. `progress` reçoit la part des sons prêts (0 à 1) à chaque son décodé.
   */
  async load(base: string, progress: (done: number) => void = () => {}): Promise<void> {
    const keys = Object.keys(SAMPLES) as SampleKey[];
    let ready = 0;
    await Promise.all(keys.map(async (key) => {
      const decoded: AudioBuffer[] = [];
      for (let n = 1; n <= SAMPLES[key].variants; n++) {
        try {
          const res = await fetch(base + sampleFile(key, n));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
          if ("loop" in SAMPLES[key]) mendLoop(buffer);
          decoded.push(buffer);
        } catch (err) {
          console.warn(`Son ${sampleFile(key, n)} illisible :`, err);
        }
      }
      if (decoded.length) this.buffers.set(key, decoded);
      progress(++ready / keys.length);
    }));
  }

  has(key: SampleKey): boolean {
    return this.buffers.has(key);
  }

  /** Une variante au hasard, pas la même que la dernière fois. */
  pick(key: SampleKey): AudioBuffer | null {
    const list = this.buffers.get(key);
    if (!list) return null;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === this.last.get(key)) i = (i + 1) % list.length;
    this.last.set(key, i);
    return list[i];
  }

  /** La variante `i` (modulo leur nombre) : un robot garde la même voix. */
  variant(key: SampleKey, i: number): AudioBuffer | null {
    const list = this.buffers.get(key);
    return list ? list[i % list.length] : null;
  }
}
