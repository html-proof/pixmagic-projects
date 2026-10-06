import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * The Prisma client is generated for workerd, which imports its query compiler
 * as `*.wasm?module` (a compiled WebAssembly.Module). Node has no such import,
 * so tests load the bytes and compile them the same way.
 */
export function wasmModule(): Plugin {
  const PREFIX = "\0wasm-module:";
  return {
    name: "wasm-module",
    enforce: "pre",
    resolveId(id, importer) {
      if (!id.endsWith(".wasm?module") || !importer) return null;
      return PREFIX + resolve(dirname(importer), id.slice(0, -"?module".length));
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const file = id.slice(PREFIX.length);
      return `import { readFileSync } from "node:fs";\nexport default new WebAssembly.Module(readFileSync(${JSON.stringify(file)}));\n`;
    },
  };
}
