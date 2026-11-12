import type { MapMeta } from "../../src/shared/map";

/*
 * Ce que l'outil des cartes ajoute à un paquet (shared/map/pack.ts : la carte et son relief) : le
 * fichier de sa licence, d'après ce qu'en dit la carte. En anglais, comme la documentation : il
 * s'adresse à qui reprend le paquet, dans n'importe quelle langue. La carte (map.json) reste la
 * référence : refaire la carte d'un paquet ne le relit pas.
 */

/** Une licence écrite comme un identifiant SPDX (« CC-BY-4.0 », « AGPL-3.0-or-later »). */
const SPDX = /^[A-Za-z0-9.+-]+$/;

/** Le texte de LICENSE.txt. */
export function licenseText(meta: MapMeta): string {
  return [
    `"${meta.name}" by ${meta.author}`,
    `License: ${meta.license}`,
    ...(SPDX.test(meta.license) ? [`https://spdx.org/licenses/${meta.license}.html`] : []),
    "",
    "This license covers the map (map.json) and its terrain (terrain.png).",
    "",
  ].join("\n");
}
