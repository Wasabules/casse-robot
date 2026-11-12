/*
 * SHA-256 (FIPS 180-4), écrit à la main : le navigateur n'en donne un (`crypto.subtle`) que sur une
 * page sûre (https, localhost), pas sur une page servie par le serveur de jeu sur le réseau local
 * (http://192.168…). Il sert d'empreinte aux ressources d'un paquet de carte (modèles, ambiance) : le
 * même fichier a la même empreinte partout (dans la carte, sur le serveur, dans le cache du
 * navigateur), et un fichier reçu se vérifie contre elle. Mesuré : ~20 Mo par seconde dans V8 sur une
 * machine chargée par d'autres calculs, assez pour des fichiers de quelques Mo.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Une empreinte SHA-256 : 64 chiffres hexadécimaux en minuscules. */
export const SHA256 = /^[0-9a-f]{64}$/;

/** L'empreinte SHA-256 de ces octets, en hexadécimal (minuscules). */
export function sha256(bytes: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  // Le message complété : un bit 1, des zéros, puis sa longueur en bits sur 64 bits (un multiple de 64 octets)
  const length = bytes.length;
  const blocks = Math.ceil((length + 9) / 64);
  const tail = new Uint8Array(128);
  const fullBlocks = Math.floor(length / 64);
  const rest = length - fullBlocks * 64;
  tail.set(bytes.subarray(fullBlocks * 64));
  tail[rest] = 0x80;
  const tailBlocks = blocks - fullBlocks;
  const bits = length * 8;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tailBlocks * 64 - 8, Math.floor(bits / 0x100000000));
  tv.setUint32(tailBlocks * 64 - 4, bits >>> 0);
  for (let b = 0; b < blocks; b++) {
    const inTail = b >= fullBlocks;
    const src = inTail ? tail : bytes;
    let at = inTail ? (b - fullBlocks) * 64 : b * 64;
    for (let i = 0; i < 16; i++, at += 4) w[i] = (src[at] << 24) | (src[at + 1] << 16) | (src[at + 2] << 8) | src[at + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  let out = "";
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, "0");
  return out;
}
