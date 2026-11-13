import { describe, expect, it } from "vitest";

// Code source de src/shared et src/server, lu en texte brut
const sharedSources = import.meta.glob<string>("../src/shared/**/*.ts", { query: "?raw", import: "default", eager: true });
const serverSources = import.meta.glob<string>("../src/server/**/*.ts", { query: "?raw", import: "default", eager: true });
const clientSources = import.meta.glob<string>("../src/client/**/*.ts", { query: "?raw", import: "default", eager: true });

describe("architecture", () => {
  it("src/shared ne dépend ni de Babylon ni du client", () => {
    const offenders = Object.entries(sharedSources)
      .filter(([, code]) => /from\s+["'](@babylonjs\/|[./]+\/client\/)/.test(code))
      .map(([file]) => file);
    expect(Object.keys(sharedSources).length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("src/server ne dépend ni de Babylon ni du client, et seul son point d'entrée touche à Node", () => {
    const offenders = Object.entries(serverSources)
      .filter(([, code]) => /from\s+["'](@babylonjs\/|[./]+\/client\/)/.test(code))
      .map(([file]) => file);
    expect(Object.keys(serverSources).length).toBeGreaterThan(1);
    expect(offenders).toEqual([]);
    // La salle de jeu ne connaît pas le transport : elle se teste sans réseau
    const nodeOnly = Object.entries(serverSources)
      .filter(([file, code]) => !file.endsWith("main.ts") && /from\s+["'](node:|ws["'])/.test(code))
      .map(([file]) => file);
    expect(nodeOnly).toEqual([]);
  });

  it("le client importe Babylon par morceaux, depuis client/babylon.ts seulement", () => {
    const offenders = Object.entries(clientSources)
      .filter(([file, code]) => !file.endsWith("/client/babylon.ts") && /from\s+["']@babylonjs\/core["']/.test(code))
      .map(([file]) => file);
    expect(Object.keys(clientSources).length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("le lecteur glTF n'entre pas dans le paquet principal : il ne se charge qu'à la demande", () => {
    // Babylon ne s'importe que de client/babylon.ts, son lecteur glTF de client/babylonGltf.ts et son moteur WebGPU de client/babylonGpu.ts
    const babylon = Object.entries(clientSources)
      .filter(([file, code]) => !/\/client\/babylon(Gltf|Gpu)?\.ts$/.test(file) && /from\s+["']@babylonjs\//.test(code))
      .map(([file]) => file);
    expect(babylon).toEqual([]);
    // babylonGltf.ts n'est importé que par render/gltfModel.ts…
    const gltf = Object.entries(clientSources)
      .filter(([file, code]) => !file.endsWith("/render/gltfModel.ts") && /from\s+["'][./]+(\/\.\.)*\/?babylonGltf["']/.test(code))
      .map(([file]) => file);
    expect(gltf).toEqual([]);
    // … qui ne l'est qu'à la demande (`import("./gltfModel")`, render/gltfModels.ts : accessoires,
    // blocs, têtes, roues) ou pour ses types
    const eager = Object.entries(clientSources)
      .filter(([, code]) => /^import\s+(?!type\b)[^;]*from\s+["'][./]+gltfModel["']/m.test(code) || /^import\s+["'][./]+gltfModel["']/m.test(code))
      .map(([file]) => file);
    expect(eager).toEqual([]);
    expect(clientSources["../src/client/render/gltfModels.ts"]).toMatch(/import\("\.\/gltfModel"\)/);
  });

  it("le moteur WebGPU n'entre pas dans le paquet principal : render/engine.ts le charge à la demande", () => {
    const eager = Object.entries(clientSources)
      .filter(([, code]) => /^import\s+(?!type)[^;]*from\s+["'][./]+(\/\.\.)*\/?babylonGpu["']/m.test(code))
      .map(([file]) => file);
    expect(eager).toEqual([]);
    expect(clientSources["../src/client/render/engine.ts"]).toMatch(/import\("\.\.\/babylonGpu"\)/);
  });

  it("la simulation n'emploie pas sin, cos, log ni les puissances de Math, dont le dernier bit dépend du moteur JavaScript (src/shared/math/det.ts)", () => {
    const offenders = Object.entries(sharedSources)
      .filter(([file]) => !file.endsWith("/math/det.ts"))
      .filter(([, code]) => /Math\.(sin|cos|log|pow)\(|\s\*\*\s/.test(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("le code des arènes n'entre ni dans le paquet du client ni dans celui du serveur : ils jouent leurs fichiers (content/arenas/)", () => {
    const sources: Record<string, string> = { ...sharedSources, ...serverSources, ...clientSources };
    // Ce qu'importe un fichier (pas ses types : ils ne vont pas dans le paquet), y compris à la demande (`dynamic`)
    const imports = (file: string, dynamic = true): string[] => {
      const code = sources[file].replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      const specs = [
        ...code.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gm),
        ...code.matchAll(/^import\s+["'](\.[^"']+)["']/gm),
        ...(dynamic ? code.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g) : []),
      ].map((m) => m[1]);
      const dir = file.slice(0, file.lastIndexOf("/"));
      return specs.map((spec) => {
        const out: string[] = [];
        for (const p of `${dir}/${spec}`.split("/")) {
          if (p === ".." && out.length && out[out.length - 1] !== "..") out.pop();
          else if (p !== ".") out.push(p);
        }
        const path = out.join("/");
        return [`${path}.ts`, `${path}/index.ts`].find((f) => f in sources) ?? path;
      }).filter((f) => f in sources);
    };
    const reached = (entry: string, dynamic = true): Set<string> => {
      const seen = new Set<string>([entry]);
      const todo = [entry];
      while (todo.length) {
        for (const next of imports(todo.pop()!, dynamic)) {
          if (seen.has(next)) continue;
          seen.add(next);
          todo.push(next);
        }
      }
      return seen;
    };
    const arenaCode = ["sources", "valley", "canyon", "island", "city", "port"].map((m) => `../src/shared/arena/${m}.ts`);
    for (const entry of ["../src/client/main.ts", "../src/client/sim/simWorker.ts", "../src/client/editor/checkWorker.ts", "../src/server/main.ts"]) {
      expect(entry in sources, entry).toBe(true);
      const all = reached(entry);
      // (le parcours suit bien les imports : chacun atteint la construction des cartes)
      expect(all.has("../src/shared/map/build.ts"), entry).toBe(true);
      expect(arenaCode.filter((f) => all.has(f)), entry).toEqual([]);
    }

    // La partie solo en Rust ne charge ni la simulation du TypeScript ni Rapier pour le JavaScript
    // (~4,2 Mo) : le Worker n'importe chaque session qu'à la demande, et celle du Rust n'atteint aucun
    // fichier qui importe Rapier (sauf pour ses types, qui ne vont pas dans le paquet)
    const reachedStatically = (entry: string): Set<string> => reached(entry, false);
    const rapier = (file: string): boolean => /^import\s+(?!type\b)[^;]*from\s+["']@dimforge\/rapier3d-compat["']/m.test(sources[file]);
    const worker = reachedStatically("../src/client/sim/simWorker.ts");
    expect([...worker].filter(rapier)).toEqual([]);
    expect(worker.has("../src/client/sim/tsSession.ts")).toBe(false);
    expect(worker.has("../src/client/sim/rustSession.ts")).toBe(false);
    const rust = reachedStatically("../src/client/sim/rustSession.ts");
    expect(rust.has("../src/shared/native/session.ts")).toBe(true);
    expect([...rust].filter(rapier)).toEqual([]);
    expect([...reachedStatically("../src/client/sim/tsSession.ts")].filter(rapier).length).toBeGreaterThan(0);
  });
});
