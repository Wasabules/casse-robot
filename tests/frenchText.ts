import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * Repère le texte français écrit en dur dans le code (tests/i18nSource.test.ts) : ce que voit le
 * joueur doit passer par les catalogues de messages (client/i18n/locales/). Une heuristique, sans
 * analyse de TypeScript : on lit les chaînes et les gabarits du code (pas les commentaires), et l'on
 * signale celles qui ont l'air françaises :
 * - une lettre accentuée du français, ou des guillemets « » ;
 * - deux mots-outils français au moins (« de la », « pour les »…) ;
 * - un mot courant de l'interface qui n'est pas anglais (« Retour », « Jouer »…), seul ou non.
 * Ne comptent pas : les chemins d'import, les messages pour les développeurs (arguments de
 * `console.*`, `new Error`, `report`, et les noms des étapes du profil, `measure`), les lignes
 * marquées `// i18n-ignore` (un texte qui n'est pas une phrase : un nom propre, un format).
 */

const ACCENTS = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŒÆ«»]/;
/** Mots-outils français (absents de l'anglais). */
const FUNCTION_WORDS = new Set([
  "le", "la", "les", "des", "du", "une", "un", "est", "sont", "pour", "avec", "sans", "dans", "sur", "et", "au", "aux", "ne", "pas",
  "ce", "cette", "ces", "son", "sa", "ses", "tu", "ton", "ta", "tes", "vous", "votre", "ou", "qui", "que", "par", "de", "en", "il", "elle",
  "leur", "leurs", "plus", "moins", "tout", "tous", "toute", "toutes", "se", "lui",
]);
/** Mots courants de l'interface, en français et pas en anglais. */
const UI_WORDS = new Set([
  "retour", "jouer", "partie", "parties", "arme", "armes", "tirer", "touche", "manette", "carte", "recommencer", "reprendre",
  "quitter", "annuler", "enregistrer", "fermer", "ouvrir", "choisir", "poser", "copie", "vague", "joueur", "joueurs", "bleus", "rouges",
  "roue", "roues", "chenilles", "pattes", "patins", "moteur", "moteurs", "tourelle", "tourelles", "blindage", "piloter", "viseur",
  "leurres", "vitesse", "masse", "oui", "non", "aucun", "aucune", "rien", "toujours", "jamais", "encore", "chargement", "commandes",
  "paramètres", "son", "musique", "ombres", "basse", "moyenne", "haute", "souris", "tableau", "crédits",
  "pièce", "coup", "coups", "dégâts", "portée", "cadence", "chargeur", "tir", "tirs",
]);

/** Une chaîne du code (ou la partie fixe d'un gabarit) et sa ligne. */
interface Literal {
  text: string;
  line: number;
  /** Ce qui la précède sur sa ligne (pour reconnaître un appel à `console.warn(`…). */
  before: string;
}

/** Les chaînes et gabarits d'un source TypeScript, hors commentaires. */
export function literals(src: string): Literal[] {
  const out: Literal[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let prev = "";
  const push = (text: string, start: number, at: number): void => {
    out.push({ text, line: at, before: src.slice(Math.max(lineStart, start - 120), start) });
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      lineStart = i + 1;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      const at = line;
      let text = "";
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          text += src[i + 1];
          i += 2;
          continue;
        }
        text += src[i++];
      }
      i++;
      push(text, start, at);
      prev = "s";
      continue;
    }
    if (c === "`") {
      const start = i;
      const at = line;
      let text = "";
      let depth = 0;
      i++;
      while (i < n) {
        const d = src[i];
        if (d === "\\") {
          if (!depth) text += src[i + 1];
          i += 2;
          continue;
        }
        if (d === "\n") {
          line++;
          lineStart = i + 1;
        }
        if (!depth && d === "`") break;
        if (!depth && d === "$" && src[i + 1] === "{") {
          depth = 1;
          text += " ";
          i += 2;
          continue;
        }
        if (depth) {
          if (d === "{") depth++;
          else if (d === "}") depth--;
          i++;
          continue;
        }
        text += d;
        i++;
      }
      i++;
      push(text, start, at);
      prev = "s";
      continue;
    }
    // Une expression régulière littérale (après un opérateur ou une parenthèse)
    if (c === "/" && /[=(,:;!&|?{}[]/.test(prev)) {
      i++;
      while (i < n && src[i] !== "/" && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") {
          while (i < n && src[i] !== "]") {
            if (src[i] === "\\") i++;
            i++;
          }
        }
        i++;
      }
      i++;
      prev = "r";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Une chaîne qui sert aux développeurs, ou qui n'est pas un texte : un chemin d'import, un appel à la console… */
function exempt(lit: Literal, lineText: string): boolean {
  if (/\bi18n-ignore\b/.test(lineText)) return true;
  // Une clé de message (« conflict.piece »), un identifiant à points
  if (/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/.test(lit.text)) return true;
  // Un shader (ses commentaires sont pour les développeurs)
  if (/\bprecision (highp|mediump) float\b|\bgl_FragColor\b/.test(lit.text)) return true;
  if (/(\bfrom|\bimport\(?)\s*$/.test(lit.before)) return true;
  return /(console\.\w+|\bError|\breport|\bmeasure|\bwarn)\(\s*([^()]*\([^()]*\))*[^()]*$/.test(lit.before);
}

/** Cette chaîne a-t-elle l'air française ? */
export function looksFrench(text: string): boolean {
  if (ACCENTS.test(text)) return true;
  const words = text.toLowerCase().match(/[a-zàâäçéèêëîïôöùûüÿœæ]+/g) ?? [];
  if (words.some((w) => UI_WORDS.has(w))) return true;
  return words.filter((w) => FUNCTION_WORDS.has(w)).length >= 2;
}

/** Les fichiers TypeScript d'un dossier, sauf ceux d'un dossier écarté. */
export function sourceFiles(root: string, dir: string, skip: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(root, p).replace(/\\/g, "/");
      if (skip.some((s) => rel.startsWith(s))) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(join(root, dir));
  return out;
}

/** Les chaînes françaises d'un fichier : « fichier:ligne  "texte" ». */
export function frenchIn(root: string, file: string): string[] {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const rel = relative(root, file).replace(/\\/g, "/");
  return literals(src)
    .filter((lit) => /[a-zA-Zé]{2}/.test(lit.text) && looksFrench(lit.text) && !exempt(lit, lines[lit.line - 1] ?? ""))
    .map((lit) => `${rel}:${lit.line}  ${JSON.stringify(lit.text.trim().slice(0, 100))}`);
}

/**
 * Les textes de la page qui ne passent pas par une clé : le texte d'un élément sans `data-i18n`
 * (ni `data-key-action`, dont le texte est une touche), un attribut lisible (`title`, `aria-label`,
 * `placeholder`) sans son `data-i18n-…`.
 */
export function frenchInHtml(html: string): string[] {
  const out: string[] = [];
  const page = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
  for (const m of page.matchAll(/<(\w+)([^>]*)>([^<]*)/g)) {
    const [, tag, attrs, text] = m;
    // Le titre de la page, et ce qui ne se traduit pas (`translate="no"` : le nom du jeu)
    if (tag === "title" || /\stranslate="no"/.test(attrs)) continue;
    if (/[A-Za-zÀ-ÿ]{2}/.test(text) && !/\sdata-i18n="/.test(attrs) && !/\sdata-key-action="/.test(attrs)) out.push(`<${tag}> ${text.trim()}`);
    for (const a of ["title", "aria-label", "placeholder"]) {
      const v = new RegExp(`\\s${a}="([^"]*)"`).exec(attrs)?.[1];
      if (v && /[A-Za-zÀ-ÿ]{2}/.test(v) && !new RegExp(`\\sdata-i18n-${a}="`).test(attrs)) out.push(`<${tag} ${a}> ${v}`);
    }
  }
  return out;
}
