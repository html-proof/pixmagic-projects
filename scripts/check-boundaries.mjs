import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Reuse the UI's TypeScript parser so imports in comments are never treated as dependencies.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const ts = require("typescript");
const layers = {
  "packages/shared": [],
  "packages/db": ["packages/shared"],
  "packages/core": ["packages/shared", "packages/db"],
  "apps/web": ["packages/shared"],
  "apps/api": ["packages/shared", "packages/db", "packages/core"],
  "apps/worker": ["packages/shared", "packages/db", "packages/core"],
  "apps/aws": ["packages/shared", "packages/db", "packages/core", "apps/api", "apps/worker"],
};
const names = new Map();
for (const layer of Object.keys(layers)) {
  const manifest = JSON.parse(await readFile(path.join(root, layer, "package.json"), "utf8"));
  names.set(manifest.name, layer);
}
async function* sources(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(file);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) yield file;
  }
}
const violations = [];
for (const [layer, allowed] of Object.entries(layers)) {
  for await (const file of sources(path.join(root, layer, "src"))) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const value = specifier.text;
        const target = value.startsWith(".") ? path.relative(root, path.resolve(path.dirname(file), value)).replaceAll("\\", "/") : null;
        const dependency = target ? Object.keys(layers).find((candidate) => target.startsWith(`${candidate}/`)) : [...names].find(([name]) => value === name || value.startsWith(`${name}/`))?.[1];
        if (dependency && dependency !== layer && !allowed.includes(dependency)) violations.push(`${path.relative(root, file)}: forbidden dependency ${value}`);
        if (layer === "apps/web" && value === "@app/shared") violations.push(`${path.relative(root, file)}: use a browser-safe @app/shared subpath`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else console.log("Package boundaries passed for all seven source trees.");
