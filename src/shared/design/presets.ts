import { steeredVariant } from "../catalog/wheels";
import { DesignGrid, type Facing, type RobotDesign, type WheelMount } from "./robotDesign";

/** Réaction d'un robot de l'IA quand il est touché. */
export type Behavior = "flee" | "charge";

/** Façon de se déplacer, qui choisit le pilote de l'IA : rouler, voler en stationnaire (rotors), ou voler comme un avion. */
export type Mobility = "ground" | "hover" | "plane";

/**
 * Un robot prêt à jouer : son plan, son apparence et ses réglages de conduite. Un robot prédéfini
 * n'a pas de nom ici : il est dans chaque langue, avec sa courte description (`bot.<id>`,
 * `botTrait.<id>` : client/i18n/locales/<langue>/bots.ts) ; un robot du garage porte celui que lui a
 * donné le joueur, un robot piloté en multijoueur celui du joueur.
 */
export interface BotProfile {
  /** Un robot prédéfini (`PresetId`), ou « garage:<nom> » pour un robot du garage. */
  id: string;
  /** Nom donné par une personne (robot du garage, joueur en multijoueur) ; absent pour un robot prédéfini. */
  name?: string;
  /** Couleur des blocs teintés, en hexadécimal. */
  color: string;
  /**
   * Vitesse de croisière visée (m/s). Au sol, les moteurs des roues et le poids du robot la limitent ;
   * en vol stationnaire, c'est la vitesse horizontale maximale ; pour un avion, sa vitesse air.
   */
  speed: number;
  /**
   * Conduite différentielle (sans roue directrice, ou quand elles sont arrachées) : écart de vitesse
   * au sol entre le côté gauche et le côté droit pour tourner (m/s).
   */
  turn: number;
  behavior: Behavior;
  mobility: Mobility;
  design: RobotDesign;
}

/** Roues au format compact [x, y, z, dx, dz] : bloc support, puis flanc de montage. */
const mounts = (...list: [number, number, number, number, number][]): WheelMount[] =>
  list.map(([x, y, z, dx, dz]) => ({ x, y, z, dx, dz, type: "standard" }));

/** Les mêmes roues, en roues directrices de même taille. */
const steered = (wheels: WheelMount[]): WheelMount[] => wheels.map((w) => ({ ...w, type: steeredVariant(w.type) ?? w.type }));

function scarab(): RobotDesign {
  const g = new DesignGrid();
  g.box(-3, 3, 0, 0, -4, 4, "frame");
  for (const [x, z] of [[-3, -4], [3, -4], [-3, 4], [3, 4]]) g.remove(x, 0, z);
  g.box(-2, 2, 1, 1, -3, 3, "armor");
  g.box(-1, 1, 2, 2, -2, 2, "armorHeavy"); // dôme
  g.put(0, 3, 0, "armorHeavy");
  g.put(0, 1, 0, "cockpit");
  g.put(0, 4, 0, "cannonTurret");
  return {
    blocks: g.blocks(),
    wheels: mounts([-3, 0, -3, -1, 0], [3, 0, -3, 1, 0], [-3, 0, 0, -1, 0], [3, 0, 0, 1, 0], [-3, 0, 3, -1, 0], [3, 0, 3, 1, 0]),
  };
}

function stilt(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -2, 2, "frame");
  g.box(0, 1, 1, 6, 0, 1, "frame");
  g.box(-1, 2, 7, 8, -1, 2, "armor");
  g.put(0, 8, 0, "cockpit");
  g.put(1, 9, 1, "sniperTurret"); // tireur perché
  g.put(-1, 9, -1, "radar"); // guetteur : il repère pour toute son équipe
  return {
    blocks: g.blocks(),
    wheels: mounts([-1, 0, -2, -1, 0], [1, 0, -2, 1, 0], [-1, 0, 2, -1, 0], [1, 0, 2, 1, 0]),
  };
}

/**
 * Tricycle : une roue avant directrice, deux roues arrière sur un essieu élargi. Sur trois roues,
 * le robot se couche dès que son centre de masse sort du triangle d'appui : il est tenu bas et
 * vers l'avant, sans quoi il se renverse en virage ou se cabre en montant sur un obstacle.
 */
function trike(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -3, 2, "frame");
  g.put(0, 0, 3, "frame");
  g.put(-2, 0, -3, "frame").put(2, 0, -3, "frame"); // essieu arrière
  g.box(-1, 1, 1, 1, -3, 0, "armorLight");
  g.put(0, 1, -1, "cockpit");
  g.put(0, 2, -1, "gunTurret");
  return {
    blocks: g.blocks(),
    wheels: [...steered(mounts([0, 0, 3, 0, 1])), ...mounts([-2, 0, -3, -1, 0], [2, 0, -3, 1, 0])],
  };
}

function centipede(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, 4, 8, "frame");
  g.put(0, 0, 3, "frame");
  g.box(-1, 1, 0, 0, -2, 2, "frame");
  g.put(0, 0, -3, "frame");
  g.box(-1, 1, 0, 0, -8, -4, "frame");
  g.box(-1, 1, 1, 1, 5, 7, "armor");
  g.put(0, 1, 6, "cockpit");
  g.box(-1, 1, 1, 1, -1, 1, "armor");
  g.box(-1, 1, 1, 1, -7, -5, "armor");
  g.put(0, 2, 6, "gunTurret").put(0, 2, 0, "empTurret");
  return {
    blocks: g.blocks(),
    // Les roues de tête et de queue braquent, en sens opposés : les segments suivent la même courbe
    wheels: [
      ...steered(mounts([-1, 0, 8, -1, 0], [1, 0, 8, 1, 0])),
      ...mounts([-1, 0, 5, -1, 0], [1, 0, 5, 1, 0], [-1, 0, 0, -1, 0], [1, 0, 0, 1, 0]),
      ...steered(mounts([-1, 0, -6, -1, 0], [1, 0, -6, 1, 0])),
    ],
  };
}

function drone(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -1, 1, "frame");
  g.put(0, 1, 0, "cockpit");
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.put(x, 1, z, "armorLight");
  g.put(1, 1, 1, "battery").put(-1, 1, -1, "battery");
  for (const s of [-1, 1]) {
    g.put(2 * s, 0, 0, "armorLight").put(3 * s, 0, 0, "armorLight").put(4 * s, 0, 0, "thruster");
    g.put(0, 0, 2 * s, "armorLight").put(0, 0, 3 * s, "armorLight").put(0, 0, 4 * s, "thruster");
  }
  g.put(0, -1, 1, "frame").put(0, -1, 2, "frame");
  g.put(0, -1, 0, "gunTurret", HANGING); // tourelle ventrale
  g.put(0, 2, 0, "beacon"); // balise, sur le cockpit : la nuit, on le voit venir
  return { blocks: g.blocks(), wheels: [] };
}

function ram(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  g.box(-2, 2, 0, 0, 4, 4, "armorHeavy"); // pare-chocs
  g.box(-2, 2, 1, 1, -3, 1, "armor");
  g.box(-2, 2, 2, 2, -3, -1, "armor");
  g.put(0, 1, -2, "cockpit");
  g.put(0, 0, -4, "mineLayer"); // sème des mines derrière lui
  g.put(0, 1, 3, "flamerTurret"); // et arrose ce qu'il percute
  g.put(0, 3, -2, "gunTurret"); // une mitrailleuse sur le toit, pour ne pas charger les mains vides
  g.put(-1, 1, 2, "headlight", PUSH_FORWARD).put(1, 1, 2, "headlight", PUSH_FORWARD); // phares, au-dessus du châssis, derrière le pare-chocs
  return {
    blocks: g.blocks(),
    wheels: mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0], [-2, 0, 2, -1, 0], [2, 0, 2, 1, 0]),
  };
}

function crane(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -3, 3, "frame");
  g.put(0, 1, -2, "cockpit").put(-1, 1, -2, "armor").put(1, 1, -2, "armor");
  g.box(0, 0, 1, 5, 0, 0, "frame"); // mât d'un seul bloc
  g.box(-1, 9, 6, 6, 0, 0, "frame"); // flèche
  g.box(-4, -2, 5, 7, -1, 1, "armor"); // contrepoids
  g.put(9, 5, 0, "frame").put(9, 4, 0, "frame"); // câble
  g.box(8, 9, 1, 3, 0, 1, "armor"); // charge
  g.put(-3, 8, 0, "missileLauncher"); // sur le contrepoids
  return {
    blocks: g.blocks(),
    wheels: mounts([-1, 0, -3, -1, 0], [1, 0, -3, 1, 0], [-1, 0, 3, -1, 0], [1, 0, 3, 1, 0]),
  };
}

/** Plaque verticale (dérive, gouverne de direction) : son haut pointe vers la gauche, l'air l'attaque par l'avant. */
const VERTICAL: Facing = { up: "+x", forward: "+z" };
/** Tourelle suspendue sous le robot (tête en bas). */
const HANGING: Facing = { up: "-y", forward: "+z" };
/** Propulseur qui pousse vers l'avant. */
const PUSH_FORWARD: Facing = { up: "+z", forward: "+y" };
/** Rotor de queue : un réacteur couché qui pousse vers la droite. */
const TAIL_ROTOR: Facing = { up: "-x", forward: "+z" };

/**
 * Avion : un fuselage, une aile de 6 m² avec ailerons en bout, un empennage (profondeur et
 * dérive avec direction), une hélice au nez et un train d'atterrissage sur roulettes.
 * Le centre de gravité est devant le foyer des surfaces portantes : l'avion est stable.
 */
function plane(): RobotDesign {
  const g = new DesignGrid();
  g.box(0, 0, 0, 0, -5, 2, "frame"); // fuselage
  g.put(0, 1, 1, "cockpit");
  g.put(0, 0, 3, "propeller", PUSH_FORWARD); // hélice au nez
  for (const s of [-1, 1]) {
    g.box(s, 6 * s, 0, 0, -1, 0, "wing"); // aile principale (deux rangées de corde)
    g.box(4 * s, 6 * s, 0, 0, -1, 0, "flap"); // ailerons, sur toute la corde en bout d'aile
    g.box(s, 2 * s, 0, 0, -5, -5, "wing"); // empennage horizontal
    g.put(s, -1, 0, "frame"); // jambes du train principal
  }
  g.box(-2, 2, 0, 0, -6, -6, "flap"); // profondeur
  g.box(0, 0, 1, 2, -5, -5, "wing", VERTICAL); // dérive
  g.box(0, 0, 1, 2, -6, -6, "flap", VERTICAL); // direction
  g.put(0, -1, -4, "frame"); // béquille arrière
  g.put(0, -1, 2, "gunTurret", HANGING); // tourelle ventrale
  g.put(0, -1, -3, "flareLauncher", HANGING); // leurres, sous le ventre : ils partent vers le bas
  return {
    blocks: g.blocks(),
    wheels: [
      { x: -1, y: -1, z: 0, dx: -1, dz: 0, type: "small" },
      { x: 1, y: -1, z: 0, dx: 1, dz: 0, type: "small" },
      { x: 0, y: -1, z: -4, dx: 0, dz: -1, type: "caster" }, // roulette de queue
    ],
  };
}

/**
 * Bombardier : l'Avion, avec deux soutes à bombes sous le fuselage, à l'aplomb de l'aile (le
 * centre de gravité ne recule pas), et une aile plus longue pour porter leur poids ; plus lourd, il
 * vole plus vite (15 m/s au lieu de 12) pour tenir son altitude, et ses ailerons, sur toute la
 * corde, le font rouler assez vite pour s'aligner sur sa cible. Sa tourelle ventrale le défend.
 */
function bomber(): RobotDesign {
  const g = new DesignGrid();
  g.box(0, 0, 0, 0, -5, 2, "frame"); // fuselage
  g.put(0, 1, 1, "cockpit");
  for (const s of [-1, 1]) {
    g.box(s, 7 * s, 0, 0, -1, 0, "wing"); // aile principale, plus longue d'une case
    g.box(5 * s, 7 * s, 0, 0, -1, 0, "flap"); // ailerons sur toute la corde : il roule deux fois plus vite
    g.box(s, 2 * s, 0, 0, -5, -5, "wing"); // empennage horizontal
    g.put(s, -1, 0, "frame"); // jambes du train principal
    g.put(3 * s, 0, 1, "propeller", PUSH_FORWARD); // bimoteur : une hélice devant chaque aile
  }
  g.box(-2, 2, 0, 0, -6, -6, "flap"); // profondeur
  g.box(0, 0, 1, 2, -5, -5, "wing", VERTICAL); // dérive
  g.box(0, 0, 1, 2, -6, -6, "flap", VERTICAL); // direction
  g.put(0, -1, -4, "frame"); // béquille arrière
  g.put(0, -1, 0, "bombBay").put(0, -1, -1, "bombBay"); // soutes, sous l'aile
  g.put(0, -1, 2, "gunTurret", HANGING); // tourelle ventrale
  g.put(0, -1, -3, "flareLauncher", HANGING); // leurres, sous le ventre : ils partent vers le bas
  return {
    blocks: g.blocks(),
    wheels: [
      { x: -1, y: -1, z: 0, dx: -1, dz: 0, type: "small" },
      { x: 1, y: -1, z: 0, dx: 1, dz: 0, type: "small" },
      { x: 0, y: -1, z: -4, dx: 0, dz: -1, type: "caster" }, // roulette de queue
    ],
  };
}

/**
 * Sapeur : un châssis vif qui sème trois sortes de mines derrière lui en tournant autour de sa
 * cible (IEM pour la paralyser, ventouse qui la suit, bondissante qui frappe au-dessus des roues) ;
 * une mitrailleuse le défend.
 */
function sapper(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  g.box(-1, 1, 1, 1, -2, 2, "armor");
  g.put(0, 2, 0, "cockpit");
  g.put(-1, 0, -4, "empMineLayer").put(0, 0, -4, "stickyMineLayer").put(1, 0, -4, "bounceMineLayer");
  g.put(0, 2, 2, "gunTurret");
  return {
    blocks: g.blocks(),
    wheels: mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0], [-2, 0, 2, -1, 0], [2, 0, 2, 1, 0]),
  };
}

/**
 * Mécano : un caisson sur quatre roues qui soigne ses alliés au rayon réparateur (une batterie
 * pour le nourrir), se remet en état lui-même (module de réparation) et se défend à la mitrailleuse.
 */
function mechanic(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  g.box(-2, 2, 1, 1, -3, 2, "armor");
  g.put(0, 2, -1, "cockpit");
  g.put(0, 2, 1, "repairTurret");
  g.put(0, 2, -3, "gunTurret");
  g.put(1, 2, -1, "repairModule").put(-1, 2, -1, "battery");
  return {
    blocks: g.blocks(),
    wheels: mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0], [-2, 0, 2, -1, 0], [2, 0, 2, 1, 0]),
  };
}

/**
 * Gardien : un soutien de première ligne. Son projecteur déploie un mur d'énergie devant lui, qui
 * arrête les tirs ennemis ; son rayon réparateur soigne ses alliés, ou vole la vie de ses ennemis ;
 * son module de réparation fait repousser ses blocs perdus.
 */
function guardian(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  g.box(-2, 2, 1, 1, -3, 2, "armor");
  g.box(-2, 2, 1, 1, 3, 3, "armorHeavy"); // bouclier avant
  g.put(0, 2, -1, "cockpit");
  g.put(0, 2, 1, "barrierProjector");
  g.put(0, 2, -3, "repairTurret");
  g.put(1, 2, -2, "repairModule").put(-1, 2, -2, "battery");
  return {
    blocks: g.blocks(),
    wheels: mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0], [-2, 0, 2, -1, 0], [2, 0, 2, 1, 0]),
  };
}

/**
 * Ange : un drone de soutien. Son lance-nanites verrouille seul l'allié le plus abîmé et lui envoie
 * des nanites qui le poursuivent, se répandent sur lui et font repousser ses blocs perdus.
 */
function angel(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -1, 1, "frame");
  g.put(0, 1, 0, "cockpit");
  g.put(0, 2, 0, "naniteLauncher"); // sur le dessus : rien ne le masque
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.put(x, 1, z, "armorLight");
  g.put(1, 1, 1, "battery").put(-1, 1, -1, "battery");
  for (const s of [-1, 1]) {
    g.put(2 * s, 0, 0, "armorLight").put(3 * s, 0, 0, "armorLight").put(4 * s, 0, 0, "thruster");
    g.put(0, 0, 2 * s, "armorLight").put(0, 0, 3 * s, "armorLight").put(0, 0, 4 * s, "thruster");
  }
  g.put(0, -1, 0, "gunTurret", HANGING); // tourelle ventrale
  return { blocks: g.blocks(), wheels: [] };
}

/**
 * Guetteur : un éclaireur léger qui sème des capteurs (son équipe voit à travers les murs autour
 * d'eux) et des mines anti-aériennes contre les avions et les drones ; une mitrailleuse.
 */
function scout(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -3, 3, "frame");
  g.box(-1, 1, 1, 1, -2, 2, "armorLight");
  g.put(0, 1, -1, "cockpit"); // encastré dans la caisse : posé dessus, un choc l'arrachait
  g.put(0, 2, 1, "gunTurret");
  g.put(-1, 0, -4, "sensorMineLayer").put(1, 0, -4, "aaMineLayer");
  return {
    blocks: g.blocks(),
    wheels: steered(mounts([-1, 0, 3, -1, 0], [1, 0, 3, 1, 0])).concat(mounts([-1, 0, -3, -1, 0], [1, 0, -3, 1, 0])),
  };
}

/**
 * Chasseur : la cellule de l'Avion, une aile plus courte aux ailerons sur toute la corde, et deux
 * turboréacteurs sous les ailes : il vole à 18 m/s (l'Avion à 12). Une mitrailleuse ventrale, des
 * leurres.
 */
function jetFighter(): RobotDesign {
  const g = new DesignGrid();
  g.box(0, 0, 0, 0, -5, 3, "frame"); // fuselage, nez effilé
  g.put(0, 1, 1, "cockpit");
  for (const s of [-1, 1]) {
    g.box(s, 5 * s, 0, 0, -1, 0, "wing"); // aile principale
    g.box(4 * s, 5 * s, 0, 0, -1, 0, "flap"); // ailerons sur toute la corde
    g.box(s, 2 * s, 0, 0, -5, -5, "wing"); // empennage horizontal
    g.put(s, -1, 0, "frame"); // jambes du train principal
    g.put(3 * s, -1, 0, "jet", PUSH_FORWARD); // turboréacteur sous l'aile
  }
  g.box(-2, 2, 0, 0, -6, -6, "flap"); // profondeur
  g.box(0, 0, 1, 2, -5, -5, "wing", VERTICAL); // dérive
  g.box(0, 0, 1, 2, -6, -6, "flap", VERTICAL); // direction
  g.put(0, -1, -4, "frame"); // béquille arrière
  g.put(0, -1, 2, "gunTurret", HANGING); // mitrailleuse ventrale
  g.put(0, -1, -3, "flareLauncher", HANGING); // leurres, sous le ventre : ils partent vers le bas
  return {
    blocks: g.blocks(),
    wheels: [
      { x: -1, y: -1, z: 0, dx: -1, dz: 0, type: "small" },
      { x: 1, y: -1, z: 0, dx: 1, dz: 0, type: "small" },
      { x: 0, y: -1, z: -4, dx: 0, dz: -1, type: "caster" }, // roulette de queue
    ],
  };
}

/**
 * Bolide : un châssis bas sur quatre roues (avant directrices), une étrave en blindage lourd, et
 * quatre turboréacteurs groupés à l'arrière, deux sur deux, nourris par deux batteries : au sprint
 * (Maj), il file bien plus vite que ses roues ne le mèneraient. Une mitrailleuse sur le capot.
 * Les réacteurs sont une case derrière le châssis, tenus par une épine au milieu (châssis en bas,
 * blindage léger en haut) : la case devant chacun reste vide, l'entrée d'air de sa nacelle y
 * dépasse (`JET_NACELLE`). Ils pèsent 24 kg : les grosses roues arrière sont le plus en arrière
 * possible (juste devant cette case), et les batteries et l'étrave (deux rangées de blindage
 * lourd) font contrepoids, sans quoi l'avant ne portait que 14 % du poids, se levait dès qu'il
 * accélérait, et ne braquait plus. Reculés sans rien d'autre, ils allégeaient l'avant (34 % du
 * poids au lieu de 39) ; la seconde rangée de l'étrave le leste de nouveau (40 %), pour 9 kg de
 * plus (son sprint en est 7 % moins vif). Mesuré : tests/engines.test.ts.
 */
function dragster(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -4, 4, "frame");
  g.box(-1, 1, 1, 1, -4, 2, "armorLight");
  g.box(-1, 1, 0, 0, 5, 6, "armorHeavy"); // étrave, qui fait contrepoids
  g.put(0, 1, -1, "cockpit"); // encastré dans la caisse
  g.put(0, 2, 1, "gunTurret");
  g.put(-1, 1, 3, "battery").put(1, 1, 3, "battery"); // sur le capot, devant
  // L'épine qui porte les réacteurs, sur deux étages (pas un col d'un seul bloc, qu'un choc romprait)
  g.box(0, 0, 0, 0, -6, -5, "frame").box(0, 0, 1, 1, -6, -5, "armorLight");
  for (const x of [-1, 1]) for (const y of [0, 1]) g.put(x, y, -6, "jet", PUSH_FORWARD);
  // Roues lourdes à l'arrière, devant les entrées d'air ; roues avant directrices
  const rear: WheelMount[] = [-1, 1].map((s) => ({ x: s, y: 0, z: -4, dx: s, dz: 0, type: "heavy" }));
  return { blocks: g.blocks(), wheels: steered(mounts([-1, 0, 3, -1, 0], [1, 0, 3, 1, 0])).concat(rear) };
}

/** Hexacoptère : 6 rotors. Il a de la marge : il continue de voler après la perte d'un rotor. */
function hexacopter(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -1, 1, "frame");
  g.box(-1, 1, 1, 1, -1, 1, "armorLight");
  g.put(0, 1, 0, "cockpit");
  g.put(0, 2, 0, "flakLauncher");
  g.put(0, -1, 0, "gunTurret", HANGING); // mitrailleuse ventrale, contre les robots au sol
  g.put(1, 1, 1, "battery").put(-1, 1, -1, "battery"); // six rotors : il lui faut de l'énergie
  for (const s of [-1, 1]) {
    g.put(2 * s, 0, 0, "armorLight").put(3 * s, 0, 0, "armorLight").put(4 * s, 0, 0, "thruster");
    for (const t of [-1, 1]) {
      g.put(s, 0, 2 * t, "armorLight").put(2 * s, 0, 2 * t, "armorLight").put(2 * s, 0, 3 * t, "thruster");
    }
  }
  return { blocks: g.blocks(), wheels: [] };
}

/** Camion : 6 roues lourdes (2 directrices à l'avant) sous une benne en blindage lourd (environ 260 kg). */
function truck(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -5, 5, "frame"); // châssis
  g.box(-2, 2, 1, 1, 2, 5, "armor"); // cabine
  g.put(0, 2, 4, "cockpit");
  g.box(-2, 2, 1, 2, -5, 0, "armorHeavy"); // benne
  g.put(0, 3, -3, "cannonTurret").put(1, 2, 4, "gunTurret");
  g.put(-1, 2, 4, "repairModule"); // répare la cabine et l'avant de la benne entre deux combats
  g.put(-1, 1, 6, "headlight", PUSH_FORWARD).put(1, 1, 6, "headlight", PUSH_FORWARD); // phares, devant la cabine
  g.put(-1, 3, 0, "beacon"); // balise, sur la benne
  const wheels: WheelMount[] = [];
  for (const z of [-4, 0, 4]) {
    const type = z === 4 ? "heavySteered" : "heavy";
    wheels.push({ x: -2, y: 0, z, dx: -1, dz: 0, type }, { x: 2, y: 0, z, dx: 1, dz: 0, type });
  }
  return { blocks: g.blocks(), wheels };
}

/**
 * Voiture-fusée : large et basse sur quatre roues, avec un propulseur au ras du châssis à
 * l'arrière, qu'elle allume en ligne droite pour fuir.
 */
function rocketCar(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  g.box(-1, 1, 1, 1, -1, 2, "armorLight");
  g.put(0, 2, 0, "cockpit");
  g.put(0, 0, -4, "engine", PUSH_FORWARD);
  g.put(0, 2, 1, "missileLauncher");
  g.put(0, 2, -1, "smokeLauncher"); // couvre sa fuite
  return {
    blocks: g.blocks(),
    wheels: mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0], [-2, 0, 2, -1, 0], [2, 0, 2, 1, 0]),
  };
}

/**
 * Buggy : châssis léger perché sur quatre roulettes (jambes sous le châssis, pour la garde au sol),
 * directrices à l'avant.
 */
function buggy(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 1, 1, -3, 3, "armorLight");
  g.put(0, 2, 0, "cockpit").put(-1, 2, 0, "armorLight").put(1, 2, 0, "armorLight");
  g.put(0, 2, -2, "frame").put(0, 3, -2, "frame"); // arceau
  g.put(0, 4, -2, "gunTurret");
  g.put(0, 2, 2, "jammer"); // invisible aux radars au-delà de 25 m
  const wheels: WheelMount[] = [];
  for (const z of [-3, 3]) {
    for (const x of [-1, 1]) {
      g.put(x, 0, z, "frame"); // jambe
      wheels.push({ x, y: 0, z, dx: x, dz: 0, type: z > 0 ? "smallSteered" : "small" });
    }
  }
  return { blocks: g.blocks(), wheels };
}

/**
 * Char : deux chenilles de cinq galets (un toutes les deux cases : la bande couvre le flanc) sous
 * une caisse blindée, un canon. Lent, increvable, il tourne en ripant.
 */
function tank(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -4, 4, "frame");
  g.box(-2, 2, 1, 1, -4, 3, "armor");
  g.box(-2, 2, 1, 1, 4, 4, "armorHeavy"); // glacis
  g.box(-1, 1, 2, 2, -2, 1, "armorReactive"); // tourelle, contre les missiles
  g.put(0, 2, -1, "cockpit");
  g.put(0, 3, 0, "cannonTurret");
  g.put(2, 2, -3, "flareLauncher"); // leurres, sur l'arrière de la caisse
  const wheels: WheelMount[] = [];
  for (let z = -4; z <= 4; z += 2) for (const s of [-1, 1]) wheels.push({ x: 2 * s, y: 0, z, dx: s, dz: 0, type: "track" });
  return { blocks: g.blocks(), wheels };
}

/** Aéroglisseur : six patins anti-gravité sous une coque légère. Rapide et passe-partout, mais il dérape. */
function hovercraft(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  for (const x of [-2, 2]) for (const z of [-3, 0, 3]) g.put(x, 0, z, "hoverPad");
  g.box(-1, 1, 1, 1, -2, 2, "armorLight");
  g.put(0, 1, -1, "cockpit");
  g.put(0, 2, 0, "gunTurret");
  g.put(0, 1, 3, "flamerTurret");
  g.put(-1, 1, -3, "battery").put(1, 1, -3, "battery");
  return { blocks: g.blocks(), wheels: [] };
}

/** Araignée : six pattes autour d'un corps compact. Elle agrippe tout et enjambe les obstacles bas. */
function spider(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -1, 1, "frame");
  g.box(-1, 1, 1, 1, -1, 1, "armor");
  g.put(0, 1, 0, "cockpit");
  for (const x of [-2, 2]) for (const z of [-1, 0, 1]) g.put(x, 0, z, "leg");
  g.put(0, 2, 0, "missileLauncher");
  return { blocks: g.blocks(), wheels: [] };
}

/**
 * Hélicoptère : un rotor orientable au sommet du mât, au-dessus du centre de masse ; en inclinant
 * sa poussée, il tient l'assiette. Un réacteur couché en bout de poutre compense le couple du rotor.
 */
function helicopter(): RobotDesign {
  const g = new DesignGrid();
  g.box(0, 0, 0, 0, -6, 2, "frame"); // fuselage et poutre de queue
  g.box(-1, 1, 0, 0, -1, 1, "frame"); // cabine
  g.put(0, 1, 1, "cockpit");
  g.put(0, 1, -1, "frame").put(0, 2, -1, "rotor"); // mât, à l'aplomb du centre de masse
  g.put(-1, 0, -6, "thruster", TAIL_ROTOR);
  g.put(-1, 0, 0, "battery").put(1, 0, 0, "battery");
  for (const x of [-1, 1]) g.put(x, -1, -1, "frame").put(x, -1, 1, "frame"); // patins d'atterrissage
  g.put(0, -1, 0, "missileLauncher", HANGING);
  g.put(0, -1, -3, "flareLauncher", HANGING); // leurres, sous la poutre de queue : ils partent vers le bas
  return { blocks: g.blocks(), wheels: [] };
}

/**
 * Rempart : un caisson blindé sur six roues, protégé par un bouclier au centre de son toit, avec
 * un laser par-dessus, une mitrailleuse derrière et deux batteries pour tenir le bouclier et le laser.
 */
function bulwark(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  g.box(-2, 2, 1, 1, -3, 3, "armor");
  g.put(0, 2, -2, "cockpit");
  g.put(0, 2, 0, "shield").put(0, 3, 0, "laserTurret");
  g.put(-1, 2, -2, "battery").put(1, 2, -2, "battery").put(1, 3, -2, "gunTurret"); // hors de la ligne de tir du laser
  g.box(-1, 1, 2, 2, 2, 3, "armorHeavy"); // bouclier de proue
  return { blocks: g.blocks(), wheels: mounts(...[-3, 0, 3].flatMap((z): [number, number, number, number, number][] => [[-2, 0, z, -1, 0], [2, 0, z, 1, 0]])) };
}

/**
 * Lancier : un châssis long et bas, un canon électrique au milieu et trois batteries à l'arrière
 * pour le nourrir ; il tire de loin, puis attend que ses batteries se rechargent.
 */
function lancer(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -3, 3, "frame");
  g.box(-1, 1, 1, 1, -1, 3, "armor");
  g.put(0, 1, -2, "cockpit");
  g.put(-1, 1, -3, "battery").put(0, 1, -3, "battery").put(1, 1, -3, "battery");
  g.put(0, 2, 1, "railTurret");
  return {
    blocks: g.blocks(),
    wheels: steered(mounts([-1, 0, 3, -1, 0], [1, 0, 3, 1, 0])).concat(mounts([-1, 0, -3, -1, 0], [1, 0, -3, 1, 0])),
  };
}

/**
 * Cogneur : une étrave blindée et deux fusils à pompe, sur quatre roues (directrices à l'avant) ; il
 * fonce au contact, où ses gerbes font le plus de dégâts.
 */
function brawler(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  g.box(-2, 2, 1, 1, -3, 2, "armor");
  g.box(-2, 2, 1, 1, 3, 3, "armorHeavy"); // étrave
  g.put(0, 2, -2, "cockpit");
  g.put(-1, 2, 1, "shotgunTurret").put(1, 2, 1, "shotgunTurret");
  return {
    blocks: g.blocks(),
    wheels: steered(mounts([-2, 0, 3, -1, 0], [2, 0, 3, 1, 0])).concat(mounts([-2, 0, -3, -1, 0], [2, 0, -3, 1, 0])),
  };
}

/**
 * Faucheuse : une toupie horizontale (une barre de 1,9 m) à l'avant, qui tourne à plat à hauteur des
 * caisses ennemies (~1 m du sol) ; un robot bas et plat passe dessous. Le dessus du robot reste hors
 * du disque de la barre ; le nez, sous elle, est en blindage lourd. Elle charge à plein régime.
 */
function reaper(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 1, "frame");
  g.box(-1, 1, 0, 0, 2, 3, "armorHeavy"); // nez, sous la barre
  g.put(0, 0, 3, "spinner");
  g.box(-2, 2, 1, 1, -3, 0, "armor");
  g.put(-2, 1, 1, "armorHeavy").put(2, 1, 1, "armorHeavy");
  g.put(0, 1, -2, "cockpit");
  g.put(-1, 1, -3, "battery").put(1, 1, -3, "battery");
  g.box(-1, 1, 2, 2, -3, -1, "armor"); // dôme
  return {
    blocks: g.blocks(),
    wheels: mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0], [-2, 0, 1, -1, 0], [2, 0, 1, 1, 0]),
  };
}

/**
 * Pilon : un marteau pneumatique sur le dessus, armé vers l'arrière, qui s'abat devant lui (jusqu'au
 * sol) ; l'avant du châssis est court, pour que la tête passe devant. Chaque coup lui soulève le nez.
 */
function pounder(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 1, "frame");
  g.box(-2, 2, 1, 1, -3, 0, "armor");
  g.put(-2, 1, 1, "armorHeavy").put(-1, 1, 1, "armorHeavy").put(1, 1, 1, "armorHeavy").put(2, 1, 1, "armorHeavy");
  g.put(0, 1, 1, "hammer");
  g.put(0, 1, -2, "cockpit");
  g.put(-1, 1, -3, "battery").put(1, 1, -3, "battery");
  g.box(-1, 1, 2, 2, -3, -2, "armor");
  return {
    blocks: g.blocks(),
    wheels: steered(mounts([-2, 0, 1, -1, 0], [2, 0, 1, 1, 0])).concat(mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0])),
  };
}

/**
 * Catapulte : un flipper bas et large sur chenilles ; le plateau en coin, au ras du sol devant son
 * nez, glisse sous l'ennemi et le jette en l'air (il se fait mal en retombant, souvent sur le dos).
 * Lourde (blindage lourd sur tout le pont) : le sol la retient, c'est l'autre qui part.
 */
function catapult(): RobotDesign {
  const g = new DesignGrid();
  g.box(-3, 3, 0, 0, -3, 1, "frame");
  // Le nez en blindage lourd, le flipper au milieu : tenu de trois côtés, un coup ne l'arrache pas
  g.box(-3, 3, 0, 0, 2, 2, "armorHeavy");
  g.put(0, 0, 2, "flipper");
  g.box(-3, 3, 1, 1, -3, 2, "armorHeavy");
  g.put(0, 1, -2, "cockpit");
  g.put(-1, 1, -3, "battery").put(1, 1, -3, "battery");
  const wheels: WheelMount[] = [];
  for (const z of [-3, -1, 1]) for (const s of [-1, 1]) wheels.push({ x: 3 * s, y: 0, z, dx: s, dz: 0, type: "track" });
  return { blocks: g.blocks(), wheels };
}

/**
 * Broyeur : une mâchoire broyeuse au bout du nez d'un char lourd ; il mord ce qui se présente
 * devant lui, l'écrase et recule en le traînant. Lourd : c'est sa proie qui suit.
 */
function crusher(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -4, 3, "frame");
  // La mâchoire au bout du nez, entre deux joues en blindage lourd (un coup ne l'arrache pas)
  g.box(-1, 1, 0, 0, 4, 4, "armorHeavy");
  g.put(0, 0, 4, "jaw");
  g.box(-2, 2, 1, 1, -4, 2, "armorHeavy");
  g.put(0, 1, -2, "cockpit");
  g.put(-1, 2, -3, "battery").put(1, 2, -3, "battery");
  g.box(-1, 1, 2, 2, -2, 1, "armor"); // dôme
  const wheels: WheelMount[] = [];
  for (const z of [-4, -2, 0, 2]) for (const s of [-1, 1]) wheels.push({ x: 2 * s, y: 0, z, dx: s, dz: 0, type: "track" });
  return { blocks: g.blocks(), wheels };
}

/**
 * Batteur : une galette de blindage lourd sur chenilles, et au milieu, sur son mât, un fléau dont
 * la boule tourne à hauteur des caisses ennemies ; rien ne dépasse du pont (la boule passerait dedans).
 * Il tourne autour de sa cible en la battant ; sa boule tire sur lui à chaque tour.
 */
function thresher(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -2, 2, "armorHeavy");
  g.put(0, 0, 0, "flail");
  g.put(0, 0, -2, "cockpit");
  g.put(-1, 0, -2, "battery");
  // Des chenilles (trois galets de chaque côté) : sur quatre roues, il restait sans roues sous le feu
  const wheels: WheelMount[] = [];
  for (const z of [-2, 0, 2]) for (const s of [-1, 1]) wheels.push({ x: 2 * s, y: 0, z, dx: s, dz: 0, type: "track" });
  return { blocks: g.blocks(), wheels };
}

/**
 * Scieur : une scie circulaire à plat au bout d'un bras devant son nez (son disque mord à ~0,6 m du
 * sol, la hauteur des caisses), sur quatre roues, directrices à l'avant. Il mord sa cible et la
 * longe, tiré par la prise de sa lame. Le moteur de la scie est pris dans un nez de blindage lourd
 * (seul au bout du châssis, il était un col qu'un choc de face arrachait) ; rien devant lui dans le disque.
 */
function sawyer(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 1, "frame");
  g.box(-1, 1, 0, 1, 2, 2, "armorHeavy"); // le nez
  g.put(0, 0, 2, "saw");
  g.box(-2, 2, 1, 1, -3, 1, "armorHeavy"); // caisse lourde : il va au contact sous le feu
  g.put(0, 1, -2, "cockpit");
  g.put(-1, 1, -3, "battery").put(1, 1, -3, "battery");
  g.box(-1, 1, 2, 2, -3, -1, "armor"); // dôme
  return {
    blocks: g.blocks(),
    wheels: steered(mounts([-2, 0, 1, -1, 0], [2, 0, 1, 1, 0])).concat(mounts([-2, 0, -3, -1, 0], [2, 0, -3, 1, 0])),
  };
}

/**
 * Duelliste : une lame laser à l'avant, qui balaie à plat à hauteur des caisses ennemies, et une lance
 * électrique sous elle, qui sort droit devant et paralyse les roues ou la tourelle qu'elle touche.
 * Rien de lourd ne tourne : il garde sa conduite, mais la lame vide ses trois batteries. Le dessus
 * reste hors de l'arc de la lame ; il charge dès que sa lame est allumée.
 */
function duelist(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 1, "frame");
  g.box(-1, 1, 0, 0, 2, 3, "armorHeavy"); // nez, sous la lame
  g.put(0, 0, 3, "laserBlade");
  g.put(0, 0, 4, "shockLance");
  g.box(-2, 2, 1, 1, -3, 0, "armor");
  g.put(-2, 1, 1, "armorHeavy").put(2, 1, 1, "armorHeavy");
  g.put(0, 1, -2, "cockpit");
  g.put(-1, 1, -3, "battery").put(0, 1, -3, "battery").put(1, 1, -3, "battery");
  g.box(-1, 1, 2, 2, -3, -1, "armor"); // dôme
  return {
    blocks: g.blocks(),
    wheels: steered(mounts([-2, 0, 1, -1, 0], [2, 0, 1, 1, 0])).concat(mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0])),
  };
}

/**
 * Foreur : une foreuse au milieu de son front, à hauteur des cockpits (~0,9 m), sur un châssis
 * large et lourd à chenilles : le couple de sa mèche (qui tord sa cible) lui revient en réaction,
 * et il faut sa masse et ses appuis larges pour ne pas rouler sur lui-même. Il vise le cockpit de sa
 * cible et pousse droit dedans.
 */
function borer(): RobotDesign {
  const g = new DesignGrid();
  g.box(-3, 3, 0, 0, -4, 3, "frame");
  g.box(-3, 3, 1, 1, -4, 2, "armor");
  g.box(-3, 3, 1, 1, 3, 3, "armorHeavy"); // front
  g.remove(0, 1, 3);
  g.put(0, 1, 3, "drill");
  g.box(-2, 2, 2, 2, -3, 1, "armorHeavy"); // caisse lourde
  g.put(0, 2, -1, "cockpit");
  g.put(-1, 2, -3, "battery").put(1, 2, -3, "battery");
  const wheels: WheelMount[] = [];
  for (let z = -4; z <= 2; z += 2) for (const s of [-1, 1]) wheels.push({ x: 3 * s, y: 0, z, dx: s, dz: 0, type: "track" });
  return { blocks: g.blocks(), wheels };
}

/**
 * Oursin : un champ broyeur au milieu du dos, qui couvre toute la coque (ce qui s'y frotte est frappé
 * et repoussé, une toupie ennemie y perd son régime), et un fouet plasma à l'avant, au ras du
 * châssis, qui claque de sa droite à sa gauche et met le feu. Blindé, sur quatre roues ; il charge.
 */
function urchin(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 2, "frame");
  g.box(-1, 1, 0, 0, 3, 3, "armorHeavy");
  g.put(0, 0, 3, "plasmaWhip");
  g.box(-2, 2, 1, 1, -3, 2, "armor");
  g.box(-2, 2, 1, 1, 2, 2, "armorHeavy"); // étrave
  g.put(0, 1, -2, "cockpit");
  g.put(-1, 1, -3, "battery").put(1, 1, -3, "battery");
  g.box(-1, 1, 2, 2, -2, 1, "armor");
  g.put(0, 2, 0, "crusherField");
  return {
    blocks: g.blocks(),
    wheels: steered(mounts([-2, 0, 2, -1, 0], [2, 0, 2, 1, 0])).concat(mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0])),
  };
}

/**
 * Culbuteur : une toupie verticale à l'avant (un disque de 0,9 m, debout entre deux fourches
 * blindées), à 15 cm du sol : elle cueille l'adversaire par-dessous, le soulève et le retourne. Bas
 * et large sur quatre roues (directrices à l'avant) : son gyroscope le fait pencher en virage, sans
 * le coucher. Il charge à plein régime.
 */
function tumbler(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 1, "frame");
  g.put(0, 0, 2, "verticalSpinner");
  // Les fourches, de part et d'autre du disque, en biseau lourd vers l'avant
  g.put(-1, 0, 2, "armorHeavy").put(1, 0, 2, "armorHeavy");
  g.put(-1, 0, 3, "wedgeHeavy").put(1, 0, 3, "wedgeHeavy");
  g.box(-2, 2, 1, 1, -3, 0, "armor");
  g.put(0, 1, -2, "cockpit");
  g.put(-1, 1, -3, "battery").put(1, 1, -3, "battery");
  g.box(-1, 1, 2, 2, -3, -1, "armor"); // dôme
  return {
    blocks: g.blocks(),
    wheels: steered(mounts([-2, 0, 1, -1, 0], [2, 0, 1, 1, 0])).concat(mounts([-2, 0, -2, -1, 0], [2, 0, -2, 1, 0])),
  };
}

/**
 * Batteur : un tambour à dents, large et bas (à 11 cm du sol), devant un châssis à chenilles : il
 * fait sautiller l'adversaire à petits coups répétés et lui arrache roues et galets. Peu de
 * précession : il vire sans se coucher. Il charge à plein régime.
 */
function drummer(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -3, 1, "frame");
  g.put(0, 0, 2, "drum");
  g.put(-1, 0, 2, "armorHeavy").put(1, 0, 2, "armorHeavy");
  g.box(-1, 1, 1, 1, -3, 1, "armor");
  g.put(0, 1, -2, "cockpit");
  g.put(0, 1, -3, "battery");
  g.box(-1, 1, 1, 1, 2, 2, "wedgeHeavy"); // capot en biseau au-dessus du tambour
  const wheels: WheelMount[] = [];
  for (const z of [-3, -1, 1]) for (const s of [-1, 1]) wheels.push({ x: s, y: 0, z, dx: s, dz: 0, type: "track" });
  return { blocks: g.blocks(), wheels };
}

/**
 * Tourbillon : un anneau-coque, un anneau d'acier de 3,2 m qui tourne autour de tout le robot, pendu
 * à quatre rayons posés sur le dessus ; dessous, un châssis bas et compact sur chenilles. Il frappe
 * de tous côtés sans viser, et son anneau lui sert de blindage ; énorme gyroscope, il dérape quand
 * son anneau reprend de la vitesse. Il charge à plein régime.
 */
function whirlwind(): RobotDesign {
  const g = new DesignGrid();
  // Le lourd en bas : le moyeu de l'anneau pèse sur le dessus, et un robot haut se fait retourner
  g.box(-1, 1, 0, 0, -1, 1, "armorHeavy");
  g.box(-1, 1, 1, 1, -1, 1, "armor");
  g.put(0, 1, 0, "shellSpinner");
  g.put(0, 1, -1, "cockpit");
  g.put(0, 1, 1, "battery");
  const wheels: WheelMount[] = [];
  for (const z of [-1, 0, 1]) for (const s of [-1, 1]) wheels.push({ x: s, y: 0, z, dx: s, dz: 0, type: "track" });
  return { blocks: g.blocks(), wheels };
}

/**
 * Essaim : un porte-roquettes léger sur six roues ; il vide son panier en une salve, puis se tient
 * à distance le temps de le recharger, en couvrant sa retraite à la mitrailleuse.
 */
function swarm(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -4, 4, "frame");
  g.box(-2, 2, 1, 1, -4, 3, "armorLight");
  g.put(0, 1, 4, "cockpit");
  g.put(0, 2, 0, "rocketPod").put(0, 2, -3, "gunTurret");
  return { blocks: g.blocks(), wheels: mounts(...[-4, 0, 4].flatMap((z): [number, number, number, number, number][] => [[-2, 0, z, -1, 0], [2, 0, z, 1, 0]])) };
}

/**
 * Traqueur : rapide et peu blindé, un radar pour repérer de loin (on ne verrouille qu'un ennemi
 * repéré) et un lance-missiles à verrouillage ; ses missiles poursuivent leur cible hors de vue.
 */
function tracker(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -3, 3, "frame");
  g.box(-1, 1, 1, 1, -3, 2, "armorLight");
  g.put(0, 2, -2, "cockpit");
  g.put(0, 2, 1, "lockonLauncher");
  g.put(0, 2, -3, "radar");
  return {
    blocks: g.blocks(),
    wheels: steered(mounts([-1, 0, 3, -1, 0], [1, 0, 3, 1, 0])).concat(mounts([-1, 0, -3, -1, 0], [1, 0, -3, 1, 0])),
  };
}

/**
 * Brasier : un caisson sur six roues, blindage lourd à l'avant, un projecteur de plasma et deux
 * batteries pour le nourrir ; il s'approche à courte portée et fait fondre ce qu'il touche,
 * blindage lourd compris.
 */
function furnace(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  g.box(-2, 2, 1, 1, -3, 1, "armor");
  g.box(-2, 2, 1, 1, 2, 3, "armorHeavy"); // proue
  g.put(0, 2, -2, "cockpit");
  g.put(-1, 2, -2, "battery").put(1, 2, -2, "battery");
  g.put(0, 2, 1, "plasmaTurret");
  return { blocks: g.blocks(), wheels: mounts(...[-3, 0, 3].flatMap((z): [number, number, number, number, number][] => [[-2, 0, z, -1, 0], [2, 0, z, 1, 0]])) };
}

/**
 * Porte-ogive : lent, sur six roues, il garde son ogive pour une cible lointaine (un seul coup par
 * vie) et se défend à la mitrailleuse.
 */
function warheadCarrier(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -4, 4, "frame");
  g.box(-2, 2, 1, 1, -4, 4, "armor");
  g.put(0, 2, -3, "cockpit");
  g.put(0, 2, 1, "warheadLauncher").put(1, 2, -3, "gunTurret");
  return { blocks: g.blocks(), wheels: mounts(...[-4, 0, 4].flatMap((z): [number, number, number, number, number][] => [[-2, 0, z, -1, 0], [2, 0, z, 1, 0]])) };
}

/*
 * Vaisseaux : des robots taillés dans les blocs de forme (biseaux, coins, arrondis). Rappel : un
 * biseau a son dessous et son arrière pleins, sa pente vers le haut et l'avant de son bloc ; un
 * coin, deux pentes, vers l'avant et vers la gauche ; `pair` pose un bloc et son image dans le miroir.
 */
/** Biseau dont la pente regarde vers la gauche (vers la droite, en miroir) : un flanc incliné. */
const SLOPE_OUT: Facing = { up: "+y", forward: "+x" };
/** Biseau dont la pente regarde vers l'arrière. */
const SLOPE_BACK: Facing = { up: "+y", forward: "-z" };
/** Biseau retourné, sous un nez : sa pente regarde vers le bas et l'avant. */
const SLOPE_UNDER: Facing = { up: "-y", forward: "+z" };
/** Coin arrière gauche : ses pentes regardent vers la gauche et vers l'arrière. */
const CORNER_BACK: Facing = { up: "+y", forward: "+x" };

/**
 * Frégate : un vaisseau en flèche qui vole sur quatre réacteurs en bout d'ailes delta. Nez en
 * biseau, bords d'attaque biseautés, verrière arrondie ; un laser sous le ventre (il vise ce qui
 * est au sol), nourri par deux batteries. Légère : ses réacteurs portent 1,45 fois son poids.
 */
function frigate(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -3, 2, "armorLight"); // coque
  g.box(2, 3, 0, 0, -2, 1, "armorLight").box(-3, -2, 0, 0, -2, 1, "armorLight"); // ailes
  g.box(-1, 1, 0, 0, 3, 3, "wedgeLight").pair(1, 0, 3, "cornerLight"); // nez effilé
  g.pair(2, 0, 2, "wedgeLight").pair(3, 0, 2, "cornerLight"); // bords d'attaque
  g.pair(4, 0, 1, "thruster").pair(4, 0, -2, "thruster"); // réacteurs en bout d'aile
  g.put(0, 1, 0, "cockpit").put(0, 1, 1, "roundLight"); // verrière
  g.pair(1, 1, 0, "battery");
  g.put(0, 1, -2, "slopeHighLight", SLOPE_BACK).put(0, 1, -3, "slopeLowLight", SLOPE_BACK); // dérive, en pente douce
  g.put(0, -1, 0, "laserTurret", HANGING); // laser ventral
  return { blocks: g.blocks(), wheels: [] };
}

/**
 * Raie : un aéroglisseur plat et large sur six patins, profilé de biseaux tout autour (nez, flancs,
 * poupe, coins) ; un lance-roquettes sur le dos et un lance-flammes à la proue.
 */
function manta(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -3, 3, "frame");
  for (const x of [-2, 2]) for (const z of [-3, 0, 3]) g.put(x, 0, z, "hoverPad");
  g.box(-1, 1, 1, 1, -2, 2, "armorLight"); // pont
  g.box(-1, 1, 1, 1, 3, 3, "wedgeLight").pair(2, 1, 3, "cornerLight"); // proue
  for (let z = -2; z <= 2; z++) g.pair(2, 1, z, "wedgeLight", SLOPE_OUT); // flancs
  g.box(-1, 1, 1, 1, -3, -3, "wedgeLight", SLOPE_BACK).pair(2, 1, -3, "cornerLight", CORNER_BACK); // poupe
  g.put(0, 1, -1, "cockpit").put(0, 2, -1, "roundLight"); // verrière
  g.pair(1, 1, -2, "battery");
  g.put(0, 2, 1, "rocketPod");
  g.put(0, 1, 3, "flamerTurret");
  return { blocks: g.blocks(), wheels: [] };
}

/**
 * Bastion : un char lourd à glacis en biseau (blindage lourd dessus et dessous, coins lourds),
 * jupes inclinées au-dessus des chenilles, tourelle aux flancs et au front inclinés : les obus y
 * ricochent moins qu'ils n'y frappent, mais la forme dévie ce qui le percute. Un canon, une
 * mitrailleuse, des leurres.
 */
function bastion(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -4, 4, "frame");
  g.box(-2, 2, 1, 1, -4, 3, "armor");
  g.box(-1, 1, 1, 1, 4, 4, "wedgeHeavy").pair(2, 1, 4, "cornerHeavy"); // glacis supérieur
  g.box(-2, 2, 0, 0, 5, 5, "wedgeHeavy", SLOPE_UNDER); // glacis inférieur
  for (let z = -4; z <= 3; z++) g.pair(3, 1, z, "wedgeLight", SLOPE_OUT); // jupes, au-dessus des chenilles
  g.box(-1, 1, 2, 2, -2, 0, "armor"); // tourelle
  g.box(-1, 1, 2, 2, 1, 1, "wedge").pair(2, 2, 1, "corner"); // front de tourelle
  for (const z of [-2, -1, 0]) g.pair(2, 2, z, "wedge", SLOPE_OUT); // flancs de tourelle
  g.put(0, 2, -1, "cockpit");
  g.put(0, 3, 0, "cannonTurret").put(-1, 3, -2, "gunTurret");
  g.put(1, 2, -3, "flareLauncher");
  const wheels: WheelMount[] = [];
  for (let z = -4; z <= 4; z += 2) for (const s of [-1, 1]) wheels.push({ x: 2 * s, y: 0, z, dx: s, dz: 0, type: "track" });
  return { blocks: g.blocks(), wheels };
}

/** Les robots prédéfinis, dans l'ordre d'apparition (leurs identifiants littéraux font `PresetId`). */
const PRESETS = [
  { id: "scarab", color: "#8a9a5b", speed: 3.9, turn: 3.9, behavior: "flee", mobility: "ground", design: scarab() },
  { id: "stilt", color: "#8a7fa8", speed: 3.9, turn: 2.2, behavior: "flee", mobility: "ground", design: stilt() },
  { id: "trike", color: "#4f9a94", speed: 6.6, turn: 3.3, behavior: "flee", mobility: "ground", design: trike() },
  { id: "centi", color: "#b86b52", speed: 5.5, turn: 6, behavior: "flee", mobility: "ground", design: centipede() },
  { id: "drone", color: "#c2a36b", speed: 5, turn: 0, behavior: "flee", mobility: "hover", design: drone() },
  { id: "ram", color: "#6f93a8", speed: 6.6, turn: 4.4, behavior: "charge", mobility: "ground", design: ram() },
  { id: "crane", color: "#a86f8e", speed: 2.8, turn: 2.2, behavior: "flee", mobility: "ground", design: crane() },
  { id: "plane", color: "#d27d4a", speed: 12, turn: 0, behavior: "flee", mobility: "plane", design: plane() },
  { id: "hexa", color: "#4fb07a", speed: 5, turn: 0, behavior: "flee", mobility: "hover", design: hexacopter() },
  { id: "truck", color: "#9a8a6a", speed: 3, turn: 2.5, behavior: "charge", mobility: "ground", design: truck() },
  { id: "rocket", color: "#d6c94f", speed: 5, turn: 3.5, behavior: "flee", mobility: "ground", design: rocketCar() },
  { id: "tank", color: "#6b7a4a", speed: 3.6, turn: 2.2, behavior: "charge", mobility: "ground", design: tank() },
  { id: "hovercraft", color: "#4aa3a0", speed: 6.5, turn: 3.5, behavior: "flee", mobility: "ground", design: hovercraft() },
  { id: "spider", color: "#8c5a7a", speed: 3, turn: 2.5, behavior: "flee", mobility: "ground", design: spider() },
  { id: "heli", color: "#c9a13a", speed: 6, turn: 0, behavior: "flee", mobility: "hover", design: helicopter() },
  { id: "buggy", color: "#5fa8d6", speed: 6.5, turn: 4, behavior: "flee", mobility: "ground", design: buggy() },
  { id: "bulwark", color: "#5a7fa8", speed: 4, turn: 2.6, behavior: "flee", mobility: "ground", design: bulwark() },
  { id: "lancer", color: "#b0a07a", speed: 5.5, turn: 3.5, behavior: "flee", mobility: "ground", design: lancer() },
  { id: "brawler", color: "#b5763c", speed: 5.5, turn: 4, behavior: "charge", mobility: "ground", design: brawler() },
  { id: "swarm", color: "#8fa35a", speed: 4.5, turn: 3.5, behavior: "flee", mobility: "ground", design: swarm() },
  { id: "tracker", color: "#c9a94a", speed: 6, turn: 3.5, behavior: "flee", mobility: "ground", design: tracker() },
  { id: "furnace", color: "#8a4fb0", speed: 4.5, turn: 3, behavior: "flee", mobility: "ground", design: furnace() },
  { id: "carrier", color: "#a8574a", speed: 3.5, turn: 3, behavior: "flee", mobility: "ground", design: warheadCarrier() },
  { id: "sapper", color: "#8a6a3a", speed: 6.2, turn: 4, behavior: "flee", mobility: "ground", design: sapper() },
  { id: "mechanic", color: "#4f9a6a", speed: 4.5, turn: 3, behavior: "flee", mobility: "ground", design: mechanic() },
  { id: "guardian", color: "#5a8fb8", speed: 4, turn: 3, behavior: "flee", mobility: "ground", design: guardian() },
  { id: "angel", color: "#e6d9a8", speed: 5, turn: 0, behavior: "flee", mobility: "hover", design: angel() },
  { id: "scout", color: "#6a8a9a", speed: 7, turn: 4, behavior: "flee", mobility: "ground", design: scout() },
  { id: "fighter", color: "#8aa0b8", speed: 18, turn: 0, behavior: "flee", mobility: "plane", design: jetFighter() },
  { id: "dragster", color: "#d0503a", speed: 6.5, turn: 4, behavior: "flee", mobility: "ground", design: dragster() },
  { id: "bomber", color: "#7a8a5a", speed: 15, turn: 0, behavior: "flee", mobility: "plane", design: bomber() },
  { id: "frigate", color: "#5a8ab8", speed: 6, turn: 0, behavior: "flee", mobility: "hover", design: frigate() },
  { id: "manta", color: "#3f9a8c", speed: 6.5, turn: 3.5, behavior: "flee", mobility: "ground", design: manta() },
  { id: "bastion", color: "#7a6a4a", speed: 3.3, turn: 2, behavior: "charge", mobility: "ground", design: bastion() },
  { id: "reaper", color: "#9a3f3a", speed: 5, turn: 3.5, behavior: "charge", mobility: "ground", design: reaper() },
  { id: "pounder", color: "#c08a2e", speed: 5, turn: 3.5, behavior: "charge", mobility: "ground", design: pounder() },
  { id: "catapult", color: "#5c7d3c", speed: 3.6, turn: 2.2, behavior: "charge", mobility: "ground", design: catapult() },
  { id: "crusher", color: "#6e5a8c", speed: 3.4, turn: 2, behavior: "charge", mobility: "ground", design: crusher() },
  { id: "thresher", color: "#7d8a52", speed: 4.5, turn: 3, behavior: "charge", mobility: "ground", design: thresher() },
  { id: "duelist", color: "#3f6fb8", speed: 5.5, turn: 3.8, behavior: "charge", mobility: "ground", design: duelist() },
  { id: "urchin", color: "#7a4fa8", speed: 4.6, turn: 3.2, behavior: "charge", mobility: "ground", design: urchin() },
  { id: "tumbler", color: "#b0563a", speed: 5, turn: 3.5, behavior: "charge", mobility: "ground", design: tumbler() },
  { id: "drummer", color: "#a8843a", speed: 4, turn: 2.6, behavior: "charge", mobility: "ground", design: drummer() },
  { id: "whirlwind", color: "#6a7a8a", speed: 3.6, turn: 2.4, behavior: "charge", mobility: "ground", design: whirlwind() },
  { id: "sawyer", color: "#5f8f9a", speed: 5.5, turn: 3.5, behavior: "charge", mobility: "ground", design: sawyer() },
  { id: "borer", color: "#7d6a52", speed: 3.4, turn: 2.2, behavior: "charge", mobility: "ground", design: borer() },
] as const satisfies readonly BotProfile[];

/** Identifiant d'un robot prédéfini. */
export type PresetId = (typeof PRESETS)[number]["id"];
export const PRESET_IDS: readonly PresetId[] = PRESETS.map((p) => p.id);
export const isPresetId = (id: string): id is PresetId => (PRESET_IDS as readonly string[]).includes(id);

/** Les ennemis de la vague, dans l'ordre d'apparition. */
export const PRESET_BOTS: readonly BotProfile[] = PRESETS;

/** Douze robots de toutes les sortes, pour une bataille qui ne surcharge pas l'arène (et pour le banc de performance). */
export const BATTLE_ROSTER: readonly BotProfile[] = [
  "scarab", "trike", "centi", "drone", "ram", "plane", "truck", "buggy", "tank", "hovercraft", "spider", "heli",
].map((id) => PRESET_BOTS.find((p) => p.id === id)!);
