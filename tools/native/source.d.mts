/** Les fichiers sources de la simulation compilée. */
export function sourceFiles(root: string): string[];
/** Empreinte (SHA-256, 16 chiffres) des sources, fins de ligne ramenées à `\n`. */
export function sourceHash(root: string): string;
