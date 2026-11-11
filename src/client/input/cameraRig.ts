import * as B from "../babylon";
import { clamp, rand } from "../../shared/math/scalar";
import { norm, vec3, type Vec3 } from "../../shared/math/vec";

/** Limite de déplacement de la cible de la caméra, au-delà des murs de l'arène (m). */
const PAN_MARGIN = 24;
/** Vitesse de rotation de la caméra en démonstration (rad/s). */
const DRIFT_SPEED = 0.06;
/** Regard à la souris capturée : rotation par pixel de déplacement (rad), en lacet et en site, à la sensibilité 1. */
const LOOK_YAW = 0.0032;
const LOOK_PITCH = 0.0026;
/** Zoom à la molette : bornes (m), et facteur par cran. */
const ZOOM_MIN = 4;
const ZOOM_MAX = 70;
const ZOOM_STEP = 0.0012;
/**
 * Angle de la caméra depuis la verticale (rad) : au plus 85° en caméra libre (au-dessus de la
 * scène) ; en pilotant, jusqu'à ~30° sous l'horizontale du robot, pour viser vers le ciel.
 */
const FREE_BETA_MAX = 1.48;
/** Angle le plus petit depuis la verticale (rad) : la caméra ne passe jamais tout à fait à la verticale du robot. */
const LOWEST_BETA = 0.2;
const PILOT_BETA_MAX = 2.1;
/** Quand on vise vers le haut, la cible de la caméra monte au-dessus du robot (m par radian sous l'horizontale). */
const LOOK_UP_RISE = 4;
/** Hauteur minimale de la caméra au-dessus du sol (m), et distance minimale au robot quand elle s'en rapproche pour ne pas passer dessous. */
const CAMERA_FLOOR = 0.4;
const CLOSEST = 1.8;
/**
 * Décor entre le robot et la caméra : elle se tient à OCCLUSION_MARGIN m devant l'obstacle, jamais
 * à moins de OCCLUDED_CLOSEST m du robot ; une fois le passage dégagé, elle ressort en douceur
 * (RELEASE_RATE, 1/s), pour ne pas sauter d'avant en arrière au ras d'un pilier.
 */
const OCCLUSION_MARGIN = 0.4;
const OCCLUDED_CLOSEST = 1.2;
const RELEASE_RATE = 4;
/** Champ de vision vertical par défaut (rad), et vitesse de la transition du zoom au viseur (1/s). */
const FOV = 0.8;
const SCOPE_RATE = 12;
/** Au viseur, la caméra passe dans l'arme en EYE_TIME s ; elle reste alors à EYE_RADIUS m de son point de vue. */
const EYE_TIME = 0.15;
const EYE_RADIUS = 0.05;
/** Part de la transition au-delà de laquelle la caméra est « dans l'arme » : on ne dessine plus le robot. */
const EYE_INSIDE = 0.35;
/**
 * Recul de la vue à ses propres tirs (voir `kick`) : elle revient avec ce temps caractéristique (s),
 * et s'écarte de côté d'au plus cette part de l'à-coup vers le haut.
 */
const KICK_RETURN = 0.12;
const KICK_SIDE = 0.35;
/** Angle ramené dans ]−π, π]. */
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Réglages du regard à la souris. */
export interface LookSettings {
  /** Multiplicateur de la vitesse de rotation (1 : normal). */
  sensitivity: number;
  /** Axes inversés : souris vers la droite, la caméra tourne à gauche ; souris vers le haut, elle regarde en bas. */
  invertX: boolean;
  invertY: boolean;
}

/**
 * Caméra orbitale autour d'une cible : la molette règle le zoom voulu ; rotation au clic droit
 * (souris libre) ou regard à la souris (souris capturée, en pilotant) ; déplacement au clavier ;
 * suivi d'un robot. En pilotant, elle peut descendre sous le robot pour viser haut : elle se
 * rapproche alors de lui pour ne pas passer sous le sol, et sa cible monte.
 */
export class CameraRig {
  readonly camera: B.ArcRotateCamera;
  look: LookSettings = { sensitivity: 1, invertX: false, invertY: false };
  /** Distance voulue au robot ou à la cible (m) ; la caméra s'en rapproche si le sol ou le décor l'y oblige. */
  private zoom = 38;
  /** Distance réellement tenue (m) : elle rentre d'un coup devant un obstacle, et ressort en douceur. */
  private held = 38;
  /** Premier obstacle du décor sur un rayon (distance, ou null), fourni par le jeu ; voir `setOcclusion`. */
  private occlusion: ((from: Vec3, dir: Vec3, length: number) => number | null) | null = null;
  /** Hauteur du sol de l'arène en (x, z), et limite de déplacement de la cible (m) ; voir `setArena`. */
  private ground: (x: number, z: number) => number = () => 0;
  private panLimit = 36 + PAN_MARGIN;
  private pilotView = false;
  /**
   * Tangage libre (en avion) : la caméra regarde par-dessus la verticale et passe sur le dos, comme
   * l'avion qui boucle (β, sans bornes, fait le tour ; Babylon retourne l'image quand sin β < 0 :
   * `allowUpsideDown`). Voir `setFreePitch`.
   */
  private freePitch = false;
  /** Recul en cours de la vue (rad) : ce qu'il reste à rendre en site et en lacet. */
  private kickPitch = 0;
  private kickYaw = 0;
  private scoped = false;
  /** Dernier mouvement de la souris capturée (s, horloge de la page). */
  private lookedAt = 0;
  /** Grossissements au viseur (du plus faible au plus fort), et celui choisi. */
  private scopeLevels: readonly number[] = [1];
  private scopeLevel = 0;
  /**
   * Cible de la caméra à la troisième personne (le robot suivi, ou le point survolé). Au viseur, la
   * caméra quitte cette cible pour le point de vue de l'arme (`eye`), progressivement (`eyeBlend`).
   */
  private readonly anchor: B.Vector3;
  private readonly eye = new B.Vector3();
  private hasEye = false;
  private eyeBlend = 0;
  /** Assiettes la plus basse et la plus haute que peut prendre la tourelle de l'arme (rad, < 0 : sous l'horizontale). */
  /** Champ de vision vertical hors viseur (rad), réglé par le joueur. */
  private fov = FOV;

  /** `active` : l'arène a l'écran (la molette ne sert pas au garage). */
  constructor(scene: B.Scene, canvas: HTMLCanvasElement, active: () => boolean) {
    const camera = new B.ArcRotateCamera("cam", -Math.PI / 2 - 0.5, 0.92, 38, new B.Vector3(0, 0, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 700; // les montagnes de la Vallée
    camera.fov = FOV;
    // Au viseur, la caméra entre dans l'arme : elle doit pouvoir s'approcher tout près de son point de vue
    camera.lowerRadiusLimit = EYE_RADIUS / 2;
    camera.upperRadiusLimit = ZOOM_MAX;
    camera.lowerBetaLimit = LOWEST_BETA;
    camera.upperBetaLimit = FREE_BETA_MAX;
    // Toutes les commandes passent par ici : rotation, clavier et molette de Babylon sont retirés
    camera.inputs.clear();
    this.camera = camera;
    this.anchor = camera.target.clone();
    canvas.addEventListener("wheel", (e) => {
      if (!active() || !e.deltaY) return;
      if (this.wheelClaim?.(e.deltaY < 0)) return;
      // Au viseur, la molette change le grossissement (s'il y en a plusieurs), pas la distance
      if (this.scoped) {
        const step = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
        this.scopeLevel = clamp(this.scopeLevel + step, 0, this.scopeLevels.length - 1);
        return;
      }
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
    }, { passive: true });
  }

  /** Cap de la caméra (rad) : sa direction horizontale est (sin, 0, cos). */
  get heading(): number {
    const cam = this.camera;
    return Math.atan2(cam.target.x - cam.position.x, cam.target.z - cam.position.z);
  }

  get position(): Vec3 {
    const p = this.camera.position;
    return vec3(p.x, p.y, p.z);
  }

  /**
   * En pilotant, la caméra ne passe pas derrière le décor : `probe` donne la distance au premier
   * obstacle sur un rayon (voir shared/arena/ray.ts), et elle se rapproche du robot s'il y en a un.
   */
  setOcclusion(probe: ((from: Vec3, dir: Vec3, length: number) => number | null) | null): void {
    this.occlusion = probe;
  }

  /**
   * Arène affichée : la cible de la caméra libre ne s'éloigne pas au-delà de ses murs (`half`), et
   * suit son sol (`ground`) ; la caméra ne descend pas sous lui.
   */
  setArena(half: number, ground: (x: number, z: number) => number): void {
    this.panLimit = half + PAN_MARGIN;
    this.ground = ground;
  }

  /** Distance voulue (m). */
  setZoom(distance: number): void {
    this.zoom = clamp(distance, ZOOM_MIN, ZOOM_MAX);
  }

  /** Caméra de pilotage (elle peut viser vers le ciel) ou caméra libre (toujours au-dessus). */
  setPilotView(on: boolean): void {
    if (on === this.pilotView) return;
    this.pilotView = on;
    if (!on) this.setFreePitch(false);
    if (this.freePitch) return;
    this.camera.upperBetaLimit = on ? PILOT_BETA_MAX : FREE_BETA_MAX;
    if (!on) this.camera.beta = Math.min(this.camera.beta, FREE_BETA_MAX);
  }

  /**
   * Tangage libre, en avion : la souris fait passer la vue par-dessus la verticale, sur le dos, et
   * la ramène (l'avion qui la suit boucle). Sans bornes, Babylon fait tourner β sur tout le tour
   * (]−π, π], l'image à l'envers quand sin β < 0). En le quittant, la caméra se remet à l'endroit :
   * (α, β) et (α + π, −β) regardent dans la même direction.
   */
  setFreePitch(on: boolean): void {
    if (on === this.freePitch) return;
    this.freePitch = on;
    const cam = this.camera;
    if (on) {
      cam.lowerBetaLimit = null;
      cam.upperBetaLimit = null;
      return;
    }
    if (cam.beta < 0) {
      cam.alpha += Math.PI;
      cam.beta = -cam.beta;
    }
    cam.lowerBetaLimit = LOWEST_BETA;
    cam.upperBetaLimit = this.pilotView ? PILOT_BETA_MAX : FREE_BETA_MAX;
    cam.beta = clamp(cam.beta, LOWEST_BETA, cam.upperBetaLimit);
  }

  /** La vue est-elle libre en tangage (en avion) ? */
  get freeLook(): boolean {
    return this.freePitch;
  }

  /** Un angle β permis : ramené sur le tour en tangage libre, sinon entre les bornes de la caméra. */
  private betaWithin(beta: number): number {
    const cam = this.camera;
    return this.freePitch ? wrapAngle(beta) : clamp(beta, cam.lowerBetaLimit ?? 0, cam.upperBetaLimit ?? Math.PI);
  }

  /**
   * Viseur : la caméra passe dans l'arme (voir `setEye`) et zoome ; `levels` : les grossissements
   * de l'arme, entre lesquels passe la molette ; on repart du plus faible à chaque changement
   * d'arme. La souris tourne moins vite, à proportion.
   */
  setScope(on: boolean, levels: readonly number[] = [1]): void {
    this.scoped = on;
    if (levels !== this.scopeLevels) {
      this.scopeLevels = levels;
      this.scopeLevel = 0;
    }
  }

  /** Grossissement au viseur (×2 : la vue est deux fois plus serrée). */
  get magnification(): number {
    return this.scopeLevels[Math.min(this.scopeLevel, this.scopeLevels.length - 1)];
  }

  /** Champ de vision au viseur (rad) : celui qui grossit de `magnification` fois. */
  private get scopeFov(): number {
    return 2 * Math.atan(Math.tan(this.fov / 2) / this.magnification);
  }

  /** Part du champ de vision gardée au viseur (la souris y tourne moins vite d'autant). */
  private get scopeZoom(): number {
    return this.scopeFov / this.fov;
  }

  /** Part du passage au viseur, de 0 (vue de dos) à 1 (dans l'arme). */
  get scopeAmount(): number {
    return this.eyeBlend * this.eyeBlend * (3 - 2 * this.eyeBlend);
  }

  /** Point de vue de l'arme choisie (au-dessus de sa tourelle), où va la caméra au viseur ; null : aucun. */
  setEye(p: Vec3 | null): void {
    this.hasEye = p !== null;
    if (p) this.eye.set(p.x, p.y, p.z);
  }

  /**
   * Angles depuis la verticale (β) entre lesquels regarde la caméra dans l'arme : aussi librement
   * que de dos, presque à la verticale vers le bas comme vers le haut. La tourelle suit jusqu'à sa
   * butée, comme de dos. (Limitée au débattement de la tourelle, mesuré sur l'horizon sans tenir
   * compte de l'inclinaison du robot, elle ne pouvait presque pas viser le sol depuis un avion.)
   * De dos, la caméra ne monte qu'à `PILOT_BETA_MAX`, mais elle est derrière et sous le robot :
   * elle vise plus haut qu'elle ne regarde.
   */
  private readonly eyeBetaRange = { lower: LOWEST_BETA, upper: Math.PI - 0.1 };

  /**
   * Tourne la caméra vers `point` depuis le point de vue de l'arme : en passant au viseur, on garde
   * ce que l'on visait (depuis l'arme, le même angle que de dos viserait le sol juste devant).
   */
  lookFromEye(point: Vec3): void {
    const d = vec3(point.x - this.eye.x, point.y - this.eye.y, point.z - this.eye.z);
    const length = Math.hypot(d.x, d.y, d.z);
    if (length < 1) return;
    // La caméra est en cible + rayon·(cos α sin β, cos β, sin α sin β) et regarde vers la cible
    const cam = this.camera;
    const { lower, upper } = this.eyeBetaRange;
    cam.beta = clamp(Math.acos(clamp(-d.y / length, -1, 1)), lower, upper);
    if (!this.freePitch) cam.upperBetaLimit = Math.max(cam.upperBetaLimit ?? 0, cam.beta);
    cam.alpha = Math.atan2(-d.z, -d.x);
  }

  /**
   * Tourne la caméra de dos pour que le réticule, à `height` de la hauteur de l'écran (au-dessus du
   * centre), tombe sur `point` : en sortant du viseur, on garde ce que l'on visait. Le réticule vise
   * plus haut que la caméra ne regarde, d'un angle fixe ; la caméra est derrière la cible, à sa
   * distance de dos : sa position dépend de l'angle cherché, on l'affine en quelques passes.
   */
  lookFromBehind(point: Vec3, height: number): void {
    const cam = this.camera;
    const lift = Math.atan((1 - 2 * height) * Math.tan(this.fov / 2));
    let { alpha, beta } = cam;
    for (let i = 0; i < 4; i++) {
      const sin = Math.sin(beta);
      const d = vec3(
        point.x - (this.anchor.x + this.held * Math.cos(alpha) * sin),
        point.y - (this.anchor.y + this.held * Math.cos(beta)),
        point.z - (this.anchor.z + this.held * Math.sin(alpha) * sin),
      );
      const length = Math.hypot(d.x, d.y, d.z);
      if (length < 1) return;
      // Le réticule est dans le plan vertical du regard, `lift` au-dessus : même cap, assiette moindre
      beta = Math.PI / 2 + Math.asin(clamp(d.y / length, -1, 1)) - lift;
      alpha = Math.atan2(-d.z, -d.x);
    }
    cam.alpha = alpha;
    cam.beta = Math.max(beta, LOWEST_BETA);
  }

  /** Tourne autour de la cible, d'après un glisser de (dx, dy) pixels (souris libre : on « attrape » la scène). */
  orbit(dx: number, dy: number): void {
    const cam = this.camera;
    cam.alpha -= dx * 0.006;
    cam.beta = this.betaWithin(cam.beta - dy * 0.005);
  }

  /**
   * Regard à la souris capturée : souris vers la droite, la vue tourne à droite ; vers le haut, elle
   * regarde vers le haut (sauf axes inversés dans les réglages).
   */
  lookBy(dx: number, dy: number): void {
    const k = this.look.sensitivity;
    this.turn(dx * LOOK_YAW * k * (this.look.invertX ? -1 : 1), dy * LOOK_PITCH * k * (this.look.invertY ? -1 : 1));
  }

  /**
   * Tourne la vue de `yaw` (> 0 : vers la droite) et `pitch` (> 0 : vers le bas) radians, comme la
   * souris (la manette passe par ici, avec ses propres réglages) ; au viseur, moins vite, à
   * proportion du zoom.
   */
  turn(yaw: number, pitch: number): void {
    const cam = this.camera;
    this.lookedAt = performance.now() / 1000;
    const k = this.scoped ? this.scopeZoom : 1;
    cam.alpha += yaw * k;
    cam.beta = this.betaWithin(cam.beta - pitch * k);
  }

  /**
   * La molette sert-elle une action (une touche choisie par le joueur) ? `up` : vers le haut. Si
   * oui, elle ne zoome pas.
   */
  wheelClaim: ((up: boolean) => boolean) | null = null;

  /** Depuis combien de temps (s) la souris capturée n'a pas tourné la caméra. */
  get idle(): number {
    return performance.now() / 1000 - this.lookedAt;
  }

  /**
   * Se remet peu à peu derrière ce qui va dans la direction `dir` (le nez d'un avion), à la vitesse
   * `rate` (1/s) : le réticule, à `height` de la hauteur de l'écran (au-dessus du centre), vise
   * dans cette direction. En tangage libre, elle passe par-dessus la verticale avec lui (une boucle)
   * sans se retourner d'un coup : des deux façons de regarder dans une direction, (α, β) et
   * (α + π, −β), elle prend la plus proche.
   */
  chaseDirection(dt: number, dir: Vec3, rate: number, height: number): void {
    const l = Math.hypot(dir.x, dir.y, dir.z);
    if (l < 1e-6) return;
    const cam = this.camera;
    // Le réticule vise `lift` plus haut que la caméra ne regarde (voir `lookFromBehind`)
    const lift = Math.atan((1 - 2 * height) * Math.tan(this.fov / 2));
    // La caméra regarde vers −(cos α sin β, cos β, sin α sin β)
    const beta = Math.acos(clamp(-dir.y / l, -1, 1));
    const alpha = Math.atan2(-dir.z, -dir.x);
    const ways: [number, number][] = this.freePitch ? [[alpha, beta - lift], [alpha + Math.PI, -beta - lift]] : [[alpha, beta - lift]];
    const gap = ([a, b]: [number, number]): number => Math.abs(wrapAngle(a - cam.alpha)) + Math.abs(wrapAngle(b - cam.beta));
    const [a, b] = ways.reduce((best, w) => (gap(w) < gap(best) ? w : best));
    const k = 1 - Math.exp(-dt * rate);
    cam.alpha += wrapAngle(a - cam.alpha) * k;
    cam.beta = this.betaWithin(cam.beta + wrapAngle(b - cam.beta) * k);
  }

  /**
   * Recul à un tir du joueur : la vue saute de `pitch` rad vers le haut (et un peu de côté, au
   * hasard), d'un coup, puis revient en douceur où la souris l'avait laissée (voir `update`).
   */
  kick(pitch: number): void {
    const cam = this.camera;
    const before = cam.beta;
    cam.beta = this.betaWithin(cam.beta + pitch);
    const yaw = pitch * rand(-KICK_SIDE, KICK_SIDE);
    cam.alpha += yaw;
    this.kickPitch += cam.beta - before;
    this.kickYaw += yaw;
  }

  /**
   * Tremblement (le balourd d'une arme de contact secoue le robot) : un à-coup de la vue au hasard,
   * d'au plus `amplitude` rad, en haut ou en bas, de côté, qui revient comme un recul (à chaque image).
   */
  shake(amplitude: number): void {
    if (amplitude <= 0) return;
    const cam = this.camera;
    const before = cam.beta;
    cam.beta = this.betaWithin(cam.beta + rand(-amplitude, amplitude));
    const yaw = rand(-amplitude, amplitude);
    cam.alpha += yaw;
    this.kickPitch += cam.beta - before;
    this.kickYaw += yaw;
  }

  /** Déplace la cible dans le plan : `forward` et `side` valent -1, 0 ou 1. */
  pan(dt: number, forward: number, side: number): void {
    const cam = this.camera;
    const f = norm(vec3(cam.target.x - cam.position.x, 0, cam.target.z - cam.position.z));
    const r = vec3(-f.z, 0, f.x);
    const speed = 14 * dt * (cam.radius / 25 + 0.4);
    this.anchor.x = clamp(this.anchor.x + (f.x * forward + r.x * side) * speed, -this.panLimit, this.panLimit);
    this.anchor.z = clamp(this.anchor.z + (f.z * forward + r.z * side) * speed, -this.panLimit, this.panLimit);
    this.anchor.y = this.ground(this.anchor.x, this.anchor.z);
  }

  /** La caméra est dans l'arme (viseur), ou presque : le robot du joueur la masquerait. */
  get inWeapon(): boolean {
    return this.eyeBlend > EYE_INSIDE;
  }

  /**
   * Rapproche la cible d'un point `lift` m au-dessus de `p`, en douceur ; quand on vise vers le
   * haut, la cible monte encore.
   */
  track(dt: number, p: Vec3, lift = 0.5): void {
    // (pas au-delà de la vue de dos : au viseur, la caméra peut regarder bien plus haut ; en avion,
    // la vue tourne autour de lui, en boucle s'il le faut)
    const up = this.pilotView && !this.freePitch ? Math.max(0, Math.min(this.camera.beta, PILOT_BETA_MAX) - Math.PI / 2) * LOOK_UP_RISE : 0;
    const goal = new B.Vector3(p.x, p.y + lift + up, p.z);
    B.Vector3.LerpToRef(this.anchor, goal, 1 - Math.exp(-dt * 5), this.anchor);
  }

  /**
   * À chaque image : cible et distance (le zoom voulu, raccourci pour ne pas passer sous le sol ;
   * au viseur, la caméra glisse jusque dans l'arme), puis champ de vision.
   */
  update(dt: number): void {
    const cam = this.camera;
    // Le recul se rend peu à peu : la vue revient où elle était avant le tir
    const give = 1 - Math.exp(-dt / KICK_RETURN);
    cam.beta -= this.kickPitch * give;
    cam.alpha -= this.kickYaw * give;
    this.kickPitch -= this.kickPitch * give;
    this.kickYaw -= this.kickYaw * give;
    this.eyeBlend = this.hasEye ? clamp(this.eyeBlend + (this.scoped ? dt : -dt) / EYE_TIME, 0, 1) : 0;
    // Dans l'arme, ni plus bas ni plus haut que ne va la tourelle. En sortant du viseur, une vue
    // levée plus haut que ne le permet la vue de dos redescend en douceur. En tangage libre (avion),
    // aucune borne : la vue fait le tour
    if (!this.freePitch) {
      const range = this.eyeBetaRange;
      const eye = this.hasEye && this.scoped;
      cam.lowerBetaLimit = this.inWeapon ? range.lower : LOWEST_BETA;
      const upper = eye ? range.upper : this.pilotView ? PILOT_BETA_MAX : FREE_BETA_MAX;
      if (cam.beta > upper) cam.beta = eye ? upper : upper + (cam.beta - upper) * Math.exp(-dt * SCOPE_RATE);
      cam.upperBetaLimit = Math.max(upper, cam.beta);
      cam.beta = Math.max(cam.beta, cam.lowerBetaLimit);
    }
    let radius = this.zoom;
    const cos = Math.cos(cam.beta);
    if (cos < 0) radius = Math.max(CLOSEST, Math.min(radius, (this.anchor.y - this.ground(this.anchor.x, this.anchor.z) - CAMERA_FLOOR) / -cos));
    // Un mur, un pilier, une rampe entre le robot et la caméra : elle se rapproche du robot
    if (this.pilotView && this.occlusion) {
      const sin = Math.sin(cam.beta);
      const out = vec3(Math.cos(cam.alpha) * sin, cos, Math.sin(cam.alpha) * sin);
      const hit = this.occlusion(vec3(this.anchor.x, this.anchor.y, this.anchor.z), out, radius + OCCLUSION_MARGIN);
      if (hit !== null) radius = Math.max(OCCLUDED_CLOSEST, hit - OCCLUSION_MARGIN);
    }
    this.held = radius < this.held ? radius : this.held + (radius - this.held) * (1 - Math.exp(-dt * RELEASE_RATE));
    radius = this.held;
    // Transition adoucie ; la distance diminue en proportion (de ~12 m à 5 cm)
    const k = this.eyeBlend * this.eyeBlend * (3 - 2 * this.eyeBlend);
    if (k > 0) {
      B.Vector3.LerpToRef(this.anchor, this.eye, k, cam.target);
      cam.radius = radius * Math.pow(EYE_RADIUS / radius, k);
    } else {
      cam.target.copyFrom(this.anchor);
      cam.radius = radius;
    }
    const fov = this.scoped ? this.scopeFov : this.fov;
    cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * SCOPE_RATE));
  }

  /** Champ de vision vertical (rad), hors viseur. */
  setFov(fov: number): void {
    this.fov = fov;
  }

  /** Vue de départ : l'arène entière, de biais. */
  resetView(): void {
    const cam = this.camera;
    this.anchor.set(0, this.ground(0, 0), 0);
    cam.target.copyFrom(this.anchor);
    this.eyeBlend = 0;
    cam.alpha = -Math.PI / 2 - 0.5;
    cam.beta = 0.92;
    this.zoom = 38;
  }

  /** Démonstration : la caméra tourne lentement autour de l'arène. */
  drift(dt: number): void {
    const cam = this.camera;
    const k = 1 - Math.exp(-dt * 0.8);
    cam.alpha += DRIFT_SPEED * dt;
    cam.beta += (0.95 - cam.beta) * k;
    this.zoom += (46 - this.zoom) * k;
    B.Vector3.LerpToRef(this.anchor, new B.Vector3(0, 2, 0), k, this.anchor);
  }

  /** Se rapproche à 20 m au plus (quand on commence à suivre un robot). */
  closeIn(): void {
    this.zoom = Math.min(this.zoom, 20);
  }
}
