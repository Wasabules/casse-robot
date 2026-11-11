import type { MeleeSpec } from "../../../../shared/catalog/melee";
import type { Team } from "../../../../shared/sim/entities";
import type { LostReason, WeaponTag } from "../../../hud/hud";
import type { Message } from "../../i18n";
import { section } from "../section";

/*
 * Le HUD (client/hud/, client/game.ts, index.html) : barre des armes, tableau Tab, fil des
 * destructions, état du robot, alertes, réticule et instruments, mini-carte. Les nombres arrivent
 * déjà écrits à la manière de la langue, avec leur unité (`{time}` : « 2,3 s ») ; `{key}` : le nom
 * d'une touche choisie par le joueur.
 */
export const hud = {
  // --- Barre des armes ---
  /** Ce qui distingue une arme de tourelle, en deux mots, sous son nom. */
  ...section("hud.tag", {
    automatic: "automatique",
    energyWall: "mur d'énergie",
    repair: "réparation",
    flares: "leurres",
    antiAir: "anti-aérien",
    remote: "télécommande",
    sensor: "capteur",
    sticky: "ventouse",
    bouncing: "bondissante",
    screen: "écran",
    stunning: "paralysant",
    incendiary: "incendiaire",
    guided: "téléguidé",
    trap: "piège",
    burst: "rafale",
    piercing: "perforant",
    explosive: "explosif",
    single: "coup par coup",
  } as const satisfies Record<WeaponTag, Message>),
  /** Ce qui distingue une arme de contact, selon son allure. */
  ...section("hud.meleeTag", {
    bar: "toupie",
    hammer: "frappe",
    saber: "lame",
    whip: "fouet",
    lance: "pointe",
    field: "champ",
    disc: "toupie",
    drum: "tambour",
    shell: "anneau",
    propeller: "hélice",
    saw: "mord",
    drill: "mord",
    plate: "soulève",
    flail: "fléau",
    jaw: "saisit",
  } as const satisfies Record<MeleeSpec["look"], Message>),
  /** État d'une arme de contact (`{value}` : un pourcentage). */
  "hud.melee.spin": "régime {value}",
  "hud.melee.charge": "charge {value}",
  "hud.melee.armed": "armé",
  "hud.melee.rearming": "réarme",
  "hud.melee.reloading": "recharge",
  "hud.melee.gripping": "serre",
  "hud.melee.open": "ouverte",
  "hud.melee.reopening": "rouvre",
  "hud.weapon.overheated": "surchauffe",
  /** Une arme perdue, barrée : ses tourelles détruites, ou son coup unique tiré (des mots invariables : les armes n'ont pas toutes le même genre). */
  ...section("hud.lost", {
    offline: "hors d'usage",
    empty: "vide",
  } as const satisfies Record<LostReason, Message>),
  /** L'arme choisie est perdue : on passe à la suivante (une ligne du fil). */
  ...section("hud.lostNote", {
    offline: "{weapon} hors d'usage : {next}",
    empty: "{weapon} vide : {next}",
  } as const satisfies Record<LostReason, Message>),
  /** Les touches des armes (`{from}`, `{to}` : des noms de touches). */
  "hud.keys.range": "{from} à {to}",
  "hud.keys.shift": "{range} · {shift} + {from} à {to}",

  // --- Tableau (Tab) ---
  "hud.title.multiplayer": "Multijoueur",
  "hud.tab.you": "toi",
  "hud.tab.player": "joueur",
  "hud.tab.unseen": "Non repéré",
  "hud.tab.active": { one: "{n} actif", other: "{n} actifs" },
  "hud.tab.alive": "{red} rouges · {blue} bleus",
  ...section("hud.tab.teamOf", {
    blue: "Équipe bleue",
    red: "Équipe rouge",
  } as const satisfies Record<Team, Message>),
  /** Propulsion d'un robot (`{count}` : « 3/4 », ce qui marche encore ; `{energy}`, `{load}` : un pourcentage). */
  "hud.prop.hover": "Rotors {count} · ×{lift} · énergie {energy}",
  "hud.prop.plane": "Propulseur {count} · {speed}",
  "hud.prop.pads": "Patins {count} · énergie {energy}",
  "hud.prop.legs": "Pattes {count}",
  "hud.prop.wheels": "Roues {count}",
  "hud.prop.rollers": "Galets {count}",
  "hud.prop.steering": "dir. {count}",
  "hud.prop.load": "charge {load}",
  "hud.prop.rocket": "fusée {count}",

  // --- Fil des destructions ---
  "hud.feed.you": "{name} (toi)",
  "hud.feed.destroyed": "{victim} détruit {cause}",
  ...section("hud.feed.team", {
    blue: "les bleus",
    red: "les rouges",
  } as const satisfies Record<Team, Message>),
  "hud.feed.zoneTaken": "Zone {zone} prise par {team}",
  "hud.feed.zoneNeutralized": "Zone {zone} neutralisée par {team}",
  "hud.feed.hillMoves": "La colline se déplace : zone {zone}",
  "hud.note.manualFlight": "Pilotage manuel : {pitch} tangage, {roll} roulis, {rudder} palonnier, {throttle} gaz",
  "hud.note.mouseFlight": "Pilotage à la souris : l'avion va là où tu regardes ; {throttle} gaz, {turn} virer, {pitch} cabrer · piquer",

  // --- État du robot du joueur ---
  "hud.status.destroyed": "Détruit",
  "hud.status.destroyedBy": "Détruit par {killer}",
  "hud.status.respawnIn": "réapparition dans {time}",
  "hud.status.stunned": "Paralysé",
  "hud.status.emp": "Impulsion électromagnétique : moteurs et tourelles coupés",
  "hud.status.shortCircuit": "Court-circuit",
  "hud.status.righting": "Redressement",
  "hud.status.rightingNote": "Le gyroscope du cockpit te remet d'aplomb",
  "hud.status.flipped": "Renversé",
  "hud.status.flippedNote": "Redressement dans {time} · {key} : se saborder",
  "hud.status.lowBattery": "Batteries presque vides : pose-toi pour recharger",
  /** Paralysie locale (lance électrique) : les organes coupés, puis la phrase. */
  "hud.stun.wheels": { one: "{n} roue", other: "{n} roues" },
  "hud.stun.wheelsLeft": { one: "{n} roue à gauche", other: "{n} roues à gauche" },
  "hud.stun.wheelsRight": { one: "{n} roue à droite", other: "{n} roues à droite" },
  "hud.stun.thrusters": { one: "{n} moteur", other: "{n} moteurs" },
  "hud.stun.turrets": { one: "{n} tourelle", other: "{n} tourelles" },
  "hud.stun.melee": { one: "{n} arme de contact", other: "{n} armes de contact" },
  "hud.stun.supports": { one: "{n} appui", other: "{n} appuis" },
  "hud.stun.shields": { one: "{n} bouclier", other: "{n} boucliers" },
  "hud.stun.note": "Décharge : {organs} hors service encore {time}",

  // --- Alertes et aides près du réticule ---
  "hud.missile.incoming": "Missile en approche",
  "hud.missile.flares": "Missile en approche · {key} : leurres ({n})",
  "hud.missile.noFlares": "Missile en approche · plus de leurres",
  "hud.detonate": { one: "{key} : faire sauter ta mine", other: "{key} : faire sauter tes {n} mines" },
  "hud.reticle.masked": "Tir masqué par ton robot",
  "hud.reticle.unsteady": "Immobilise-toi : ta visée tremble",
  /** Grossissement au viseur (`{zoom}` : « ×2,5 »), et la molette qui en change. */
  "hud.scope.zoomWheel": "{zoom} · molette",

  // --- Instruments ---
  "hud.gunnery.out": "Hors de portée",
  "hud.gunnery.aligned": "Pointé",
  "hud.gunnery.aiming": "Pointage",
  "hud.lock.locked": "Verrouillé",
  "hud.flight.engineOff": "coupés",
  "hud.flight.manual": "Manuel",
  "hud.flight.mouse": "Souris",

  // --- Divers ---
  "hud.pad.connected": "Manette connectée",
  "hud.pad.disconnected": "Manette débranchée",
  /** Images par seconde (`{fps}` : un nombre, ou « – »). */
  "hud.fps": "{fps} i/s",
  /** Le relevé des sons joués (réglage « Afficher les sons joués » : `{sound}` est le nom technique du son). */
  "hud.soundLog.synth": "{sound} (synthétisé)",
  "hud.soundLog.at": "{sound} à {distance}",

  // --- Textes de la page (index.html, `data-i18n`) ---
  "hud.page.canvas": "Arène 3D : robots ennemis en blocs à détruire",
  "hud.page.board": "Tableau de la partie",
  "hud.page.tabHint": "maintenir : voir · appuyer : épingler",
  "hud.page.robot": "Robot",
  "hud.page.kd": "D / M",
  "hud.page.kdTitle": "Destructions / morts",
  "hud.page.arenaTools": "Arène",
  "hud.page.wave": "Vague",
  "hud.page.freeze": "Figer IA",
  "hud.page.slowmo": "Ralenti",
  "hud.page.statAlive": "Robots actifs",
  "hud.page.statDestroyed": "Blocs détruits",
  "hud.page.statBodies": "Corps physiques",
  "hud.page.statFps": "Images / s",
  "hud.page.statPhys": "Temps physique / image",
  "hud.page.controls": "Commandes",
  "hud.page.minimap": "Mini-carte",
  "hud.page.boardButton": "tableau",
  "hud.page.boardButtonTitle": "Robots, partie, commandes",
  "hud.page.mapButton": "carte",
  "hud.page.mapButtonTitle": "La carte entière",
  "hud.page.close": "fermer",
  "hud.page.bigmap": "Carte de l'arène",
  "hud.page.weapons": "Armes",
  "hud.page.structure": "Structure",
  "hud.page.energy": "Énergie",
  "hud.page.flares": "Leurres",
  "hud.page.hint": "Deux équipes s'affrontent. Tire sur un baril pour une explosion en chaîne, abats un rotor du drone, ou clique sur un nom pour suivre un robot.",
  "hud.page.touchStick": "Manche : avancer et tourner",
  "hud.page.touchFire": "Tir",
  "hud.page.touchUp": "Monter",
  "hud.page.touchDown": "Descendre",
  "hud.page.touchBoost": "Turbo",
  "hud.page.touchScope": "Viseur",
  "hud.page.elevation": "Hausse",
  "hud.page.heading": "Cap",
  "hud.page.range": "Portée",
  "hud.page.flightTime": "Vol",
  "hud.page.timeLeft": "Reste",
  "hud.page.altitude": "Altitude",
  "hud.page.speed": "Vitesse",
  "hud.page.distance": "Distance",
  /** Ogive pilotée : « Viser : diriger · [touche] : faire exploser » (la touche entre les deux). */
  "hud.page.warheadSteer": "Viser : diriger",
  "hud.page.warheadDetonate": " : faire exploser",
  "hud.page.climb": "V/S",
  "hud.page.pitch": "Assiette",
  "hud.page.bank": "Inclinaison",
  "hud.page.throttle": "Gaz",
  /** Suivi du nom de la touche du viseur. */
  "hud.page.scopeOnly": "Cette arme ne tire qu'au viseur :",
  "hud.page.lockHint": "Clique dans l'arène pour viser à la souris ·",
  /** Après la touche qui rend la souris (la pause). */
  "hud.page.lockHintRelease": "pour la rendre",
  "hud.page.garage": "Garage",
  "hud.page.inventory": "Inventaire des pièces",
} as const;
