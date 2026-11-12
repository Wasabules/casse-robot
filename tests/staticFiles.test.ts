import { describe, expect, it } from "vitest";
import { cacheControl, contentType, mapAssetHash, staticPath } from "../src/server/staticFiles";
import { MAP_ASSET_PATH } from "../src/shared/net/protocol";

/* La page du jeu servie par le serveur de jeu (npm run share) : quel fichier pour quelle adresse. */
describe("pages servies par le serveur de jeu", () => {
  it("la page d'accueil et les fichiers du client", () => {
    expect(staticPath("/")).toBe("index.html");
    expect(staticPath("/?salle=1")).toBe("index.html");
    expect(staticPath("/assets/index-abc123.js")).toBe("assets/index-abc123.js");
    expect(staticPath("/sounds/explosion-1.ogg#t=0")).toBe("sounds/explosion-1.ogg");
    expect(staticPath("/sounds/ma%20musique.ogg")).toBe("sounds/ma musique.ogg");
    expect(staticPath("/./assets//a.js")).toBe("assets/a.js");
  });

  it("refuse ce qui sortirait du dossier du client", () => {
    for (const url of ["/../package.json", "/assets/../../x", "/%2e%2e/secret", "/a%5c..%5cb", "/C:/Windows/win.ini", "/x%00.js", "/%E0%A4%A", "assets/a.js"]) {
      expect(staticPath(url), url).toBeNull();
    }
  });

  it("types et mise en cache", () => {
    expect(contentType("index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("assets/index.JS")).toBe("text/javascript; charset=utf-8");
    expect(contentType("sounds/a.ogg")).toBe("audio/ogg");
    expect(contentType("inconnu.xyz")).toBe("application/octet-stream");
    expect(cacheControl("assets/index-abc.js")).toContain("immutable");
    expect(cacheControl("index.html")).toBe("no-cache");
    expect(contentType("models/props/crate.glb")).toBe("model/gltf-binary");
  });

  it("les ressources des cartes : une empreinte SHA-256 sous MAP_ASSET_PATH, rien d'autre", () => {
    const hash = "0123456789abcdef".repeat(4);
    expect(mapAssetHash(`${MAP_ASSET_PATH}${hash}`, MAP_ASSET_PATH)).toBe(hash);
    expect(mapAssetHash(`${MAP_ASSET_PATH}${hash}?v=1`, MAP_ASSET_PATH)).toBe(hash);
    for (const url of [`${MAP_ASSET_PATH}${hash.toUpperCase()}`, `${MAP_ASSET_PATH}${hash}0`, `${MAP_ASSET_PATH}../${hash}`, `/assets/${hash}`, MAP_ASSET_PATH, "/"]) {
      expect(mapAssetHash(url, MAP_ASSET_PATH), url).toBeNull();
    }
  });
});
