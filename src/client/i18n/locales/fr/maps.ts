import type { MapCounted, MapIssueCode } from "../../../../shared/map/format";
import type { HeightmapErrorCode } from "../../../../shared/map/heightmap";
import type { GlbProblemCode } from "../../../../shared/media/glb";
import type { OpusProblem } from "../../../../shared/media/ogg";
import type { Message } from "../../i18n";
import { section } from "../section";

/*
 * Les cartes communautaires (shared/map/) : leur écran (importer, exporter, supprimer), et ce qui
 * empêche une carte de se jouer (`MapIssue`, en codes : le code partagé et le serveur n'écrivent pas
 * de texte). Le nom d'une carte, de son auteur, de ses lieux est écrit par une personne : il
 * s'affiche tel quel, sans clé.
 */
export const maps = {
  "maps.by": "par {author}",
  "maps.title": "Cartes communautaires",
  "maps.subtitle": "Les cartes livrées avec le jeu, et celles que tu as importées (fichiers .casse-map.json, paquets .casse-map.zip).",
  "maps.manage": "Cartes communautaires…",
  "maps.manageDetail": "Importer, exporter ou supprimer des cartes.",
  "maps.import": "Importer une carte…",
  "maps.importDetail": "Un fichier .casse-map.json, ou un paquet .casse-map.zip (la carte, ses modèles, son ambiance) : il est vérifié, puis gardé dans ce navigateur.",
  "maps.imported": "Carte importée : {name}.",
  "maps.already": "Cette carte est déjà là : {name}.",
  "maps.unreadable": "Fichier illisible.",
  "maps.invalidTitle": "Carte refusée",
  "maps.export": "Exporter le fichier",
  "maps.exportDetail": "Enregistre la carte en .casse-map.json, pour la partager ou la proposer au jeu.",
  "maps.exportPackageDetail": "Enregistre la carte et ses ressources (modèles, ambiance) en un paquet .casse-map.zip, pour la partager.",
  "maps.exportMissing": "Ressources absentes de ce navigateur : impossible d'en faire un paquet.",
  "maps.assetModels": { one: "{n} modèle d'accessoire", other: "{n} modèles d'accessoires" },
  "maps.assetAmbience": "son ambiance",
  "maps.assets": "Paquet : {list}",
  "maps.delete": "Supprimer",
  "maps.deleteDetail": "La retire de ce navigateur.",
  "maps.deleted": "Carte supprimée : {name}.",
  "maps.license": "Licence : {license}",
  "maps.empty": "Aucune carte communautaire pour l'instant.",
  "maps.storage": "Ce navigateur ne garde pas les cartes (navigation privée ?) : celles que tu importes ou fais ici seront perdues en fermant la page.",
  ...section("maps.origin", {
    bundled: "Livrée avec le jeu",
    library: "Dans ta bibliothèque",
    server: "Reçue d'un serveur",
  } as const),
  /** Pourquoi une carte ne se joue pas ; `{path}` : le champ fautif, tel qu'il est écrit dans le fichier (« props[3].type »). */
  ...section("mapIssue", {
    json: "Ce n'est pas un fichier de carte (JSON illisible).",
    tooLarge: "Fichier trop gros : {size} Ko (au plus {max} Ko).",
    format: "Version du format de carte absente ou inconnue.",
    formatTooNew: "Carte faite pour une version plus récente du jeu (format {version}) : mets le jeu à jour.",
    field: "Champ absent ou invalide : {path}.",
    text: "Texte trop long : {path} (au plus {max} caractères).",
    tooMany: "Trop de {what} : {count} (au plus {max}).",
    terrainSize: "Relief : {cells} cases au pas de {step} m ne vont pas (de 16 à 440 cases, pas de 1 ou 2 m, 440 m de côté au plus).",
    terrainData: "Relief : hauteurs illisibles (base64 invalide, ou pas le bon nombre de valeurs).",
    terrainSmall: "Relief trop petit : {side} m de côté, il en faut {need} pour la zone de jeu et sa limite.",
    outside: "Hors de la carte : {path}.",
    bounds: "Dimensions de jeu incohérentes : {path}.",
    zones: "Il faut d'une à cinq zones, chacune avec sa lettre (A à E).",
    zoneUnreachable: "L'IA ne peut pas atteindre la zone {zone}.",
    spawnBlocked: "Ligne de départ des {team} encombrée, trop raide, dans l'eau profonde ou la lave.",
    spawnHazard: "Danger tout près de la ligne de départ des {team} (lave, baril, citerne).",
    spawnOutside: "La ligne de départ des {team} sort de la zone de jeu.",
    spawnClose: "Les deux lignes de départ sont trop près l'une de l'autre : {distance} m (au moins {min} m).",
    archive: "Paquet illisible : archive zip abîmée, chiffrée, ou d'une forme que le jeu ne lit pas.",
    packagePath: "Paquet refusé : un fichier au nom dangereux ({path}).",
    packageMap: "Pas de map.json dans le paquet : ce n'est pas un paquet de carte.",
    assetSize: "Fichier trop gros dans le paquet : {path}, {size} Ko (au plus {max} Ko).",
    assetName: "Fichier inattendu dans le paquet : {path} (des modèles models/props/<type d'accessoire>.glb, une ambiance sounds/ambience.ogg).",
    assetModel: "Modèle illisible : {path} ({why}).",
    assetSound: "Ambiance refusée : {path} ({why}).",
  } as const satisfies Record<MapIssueCode, Message>),
  /** Ce qui ne va pas dans un modèle glTF d'un paquet (`GlbProblem`, shared/media/glb.ts). */
  ...section("glbProblem", {
    short: "trop court pour un fichier glTF binaire",
    magic: "pas un fichier glTF binaire : exporter en .glb",
    container: "conteneur en version {version}, le jeu lit la version 2",
    length: "longueur annoncée de {declared} octets pour un fichier de {actual}",
    jsonChunk: "morceau JSON absent ou tronqué",
    json: "JSON illisible",
    version: "glTF en version {version}, le jeu lit la 2.0",
    externalBuffer: "tampon dans un fichier à part : tout doit être dans le .glb",
    bufferSize: "tampon de {buffer} octets pour un morceau binaire de {bin}",
    externalImage: "image dans un fichier à part : les textures doivent être dans le .glb",
    noMesh: "aucun mesh",
    extensions: "extensions que le jeu ne lit pas : {list}",
  } as const satisfies Record<GlbProblemCode, Message>),
  /** Ce qui ne va pas dans l'ambiance d'un paquet (`OpusProblem`, shared/media/ogg.ts). */
  ...section("opusProblem", {
    format: "pas un Ogg Opus lisible",
    channels: "{channels} voies, au plus deux",
    duration: "{seconds} s, il en faut de {min} à {max}",
  } as const satisfies Record<OpusProblem["code"], Message>),
  /** Ce qu'une carte a en trop (« Trop de {what} »). */
  ...section("mapCounted", {
    boxes: "boîtes du décor",
    props: "accessoires",
    dynamicProps: "accessoires mobiles",
    prefabs: "préfabriqués",
    scattered: "arbres et rochers semés",
    zones: "zones",
    places: "lieux nommés",
    lava: "formes de lave",
    vents: "fumerolles",
    falls: "cascades",
    paths: "chemins",
    points: "points",
    languages: "langues",
    navPoints: "points du réseau de passage",
    navLinks: "liaisons du réseau de passage",
    files: "fichiers dans le paquet",
  } as const satisfies Record<MapCounted, Message>),
  /** Pourquoi une image ne fait pas un relief. */
  ...section("heightmap", {
    notPng: "Ce n'est pas une image PNG.",
    unsupported: "Image non prise en charge : il faut un PNG en niveaux de gris (8 ou 16 bits), non entrelacé.",
    tooLarge: "Image trop grande (4097 pixels de côté au plus).",
    corrupt: "Image abîmée ou illisible.",
    rawSize: "Un fichier RAW 16 bits doit être carré (côté × côté valeurs de 2 octets).",
  } as const satisfies Record<HeightmapErrorCode, Message>),
} as const;
