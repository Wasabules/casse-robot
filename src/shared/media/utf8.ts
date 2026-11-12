/*
 * Texte en UTF-8, pour les fichiers d'un paquet de carte (map.json, les noms d'une archive, le JSON
 * d'un modèle glTF). Le navigateur, ses Workers et Node ont tous TextEncoder et TextDecoder ; c'est
 * leur déclaration qui manque au code partagé, compilé sans les types du DOM ni ceux de Node
 * (src/shared/tsconfig.json) : on les prend sur `globalThis`, avec le peu de types qu'il faut.
 */

interface Decoder {
  decode(bytes: Uint8Array): string;
}
interface Encoder {
  encode(text: string): Uint8Array;
}

const globals = globalThis as unknown as {
  TextDecoder: new (label: string, options?: { fatal?: boolean }) => Decoder;
  TextEncoder: new () => Encoder;
};

let strict: Decoder | null = null;
let encoder: Encoder | null = null;

/** Le texte de ces octets, s'ils sont de l'UTF-8 valide ; sinon null. */
export function utf8Text(bytes: Uint8Array): string | null {
  strict ??= new globals.TextDecoder("utf-8", { fatal: true });
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

/** Les octets UTF-8 d'un texte. */
export function utf8Bytes(text: string): Uint8Array {
  encoder ??= new globals.TextEncoder();
  return encoder.encode(text);
}
