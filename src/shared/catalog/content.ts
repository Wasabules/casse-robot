/*
 * Les éléments du jeu en fichiers de données : content/<famille>/<id>.json, un fichier par élément
 * (voir « Element files » dans docs/architecture.md). Chaque catalogue importe ses fichiers un par
 * un (`import crate from "…/content/props/crate.json"`) : les noms de ces imports font l'union de ses
 * identifiants (`PropType`), que TypeScript garde pour les `Record` exhaustifs du client ; un import
 * statique se lit partout pareil (la page, le Worker de la partie solo, le serveur construit par
 * `vite build --ssr`, les essais, les outils), sans `fs` ni `fetch`.
 *
 * Rien n'est vérifié ici (le démarrage n'en paie rien) : chaque fichier suit le schéma de sa famille
 * (content/schemas/<famille>.schema.json, écrit d'après les types du code par `npm run schemas`), ce
 * que vérifient les essais (tests/contentFiles.test.ts : le fichier et le champ fautifs) et l'éditeur
 * de qui modifie un fichier (son champ `$schema`).
 */

/**
 * Le type d'un élément lu de son fichier : sa définition (`Def`), où chaque champ facultatif que le
 * fichier donne devient sûr. TypeScript voit la structure d'un fichier JSON importé (pas ses valeurs :
 * un texte y est un `string`) : `WEAPONS.smoke.projectile.smoke` a son nuage, comme quand le catalogue
 * était écrit en TypeScript, et les valeurs gardent les types de la définition.
 */
export type Given<File, Def> = Def extends readonly unknown[] | string | number | boolean
  ? Def
  : Def extends object
    ? Def & { readonly [K in keyof File & keyof Def]-?: Given<File[K], NonNullable<Def[K]>> }
    : Def;

/** Un catalogue lu de ses fichiers : chaque élément, du type de sa définition et de ce que donne son fichier. */
export type FromFiles<Files, Def> = { readonly [K in keyof Files]: Given<Files[K], Def> };

/**
 * Les données d'un fichier : ses champs dans leur ordre, sans ceux dont le nom commence par « $ »
 * (`$schema`, le schéma de sa famille ; `$comment`, une note pour qui le modifie), qui n'en sont pas.
 */
export function fileData(file: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(file).filter(([key]) => !key.startsWith("$")));
}

/**
 * Le catalogue d'une famille d'après ses fichiers, dans l'ordre où le catalogue les donne : chacun
 * relu comme sa définition (`Def`), telle que son schéma la décrit ; `read` y remet ce que JSON ne
 * sait pas écrire (un nombre infini).
 */
export function fromFiles<Files extends Readonly<Record<string, object>>, Def>(
  files: Files, read: (data: Record<string, unknown>) => Def = (data) => data as Def,
): FromFiles<Files, Def> {
  const out: Record<string, Def> = {};
  for (const id of Object.keys(files)) out[id] = read(fileData(files[id]));
  return out as FromFiles<Files, Def>;
}

/**
 * Comme `fromFiles`, pour une famille dont chaque fichier donne aussi un champ qui n'est pas dans la
 * définition de son élément (le prix de déblocage d'une pièce) : les définitions sans lui, et ses
 * valeurs à part, dans le même ordre.
 */
export function splitFiles<Files extends Readonly<Record<string, object>>, Def, Value>(
  files: Files, key: string,
): { readonly defs: FromFiles<Files, Def>; readonly split: { readonly [K in keyof Files]: Value } } {
  const defs: Record<string, Def> = {};
  const split: Record<string, Value> = {};
  for (const id of Object.keys(files)) {
    const { [key]: value, ...def } = fileData(files[id]);
    defs[id] = def as Def;
    split[id] = value as Value;
  }
  return { defs: defs as FromFiles<Files, Def>, split: split as { readonly [K in keyof Files]: Value } };
}
