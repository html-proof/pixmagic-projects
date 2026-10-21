#!/usr/bin/env node
/**
 * Fails when the source has an import cycle: module A imports B, which (through any chain) imports A.
 * A cycle makes the load order matter (one module sees the other half-initialised) and is how
 * layering quietly erodes, so `pnpm lint` runs this next to ESLint.
 *
 * Only imports that exist at run time count: `import type` / `export type` are erased by TypeScript.
 * A dynamic `import()` counts: loading a module lazily to dodge a cycle leaves the cycle in place.
 * Workspace packages (`@app/core`, `@app/shared/roles`, ...) resolve to their source through each
 * package's `exports`, so a cycle that crosses packages is found too.
 *
 *   node scripts/check-import-cycles.mjs          prints each cycle, exits 1 if there is one
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRS = ["packages", "apps"];
const SKIP = new Set(["node_modules", "generated", "test", "e2e", "demo", "ops", ".next", "out", "dist", "cdk.out"]);
const EXT = [".ts", ".tsx"];

/** Workspace package name → { dir, exports: subpath → file }. */
function workspacePackages() {
  const out = new Map();
  for (const top of SOURCE_DIRS) {
    for (const name of readdirSync(join(root, top))) {
      const pj = join(root, top, name, "package.json");
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, "utf8"));
      const exports = new Map();
      const ex = pkg.exports ?? (pkg.main ? { ".": pkg.main } : {});
      for (const [sub, target] of Object.entries(typeof ex === "string" ? { ".": ex } : ex)) {
        const file = typeof target === "string" ? target : (target.import ?? target.default ?? target.types);
        if (typeof file === "string") exports.set(sub, resolve(join(root, top, name), file));
      }
      out.set(pkg.name, { dir: join(root, top, name), exports });
    }
  }
  return out;
}

function sourceFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (EXT.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts") && !/\.(test|spec)\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

function fileFor(base) {
  const noJs = base.replace(/\.(m?js|jsx)$/, "");
  for (const cand of [base, ...EXT.map((e) => noJs + e), ...EXT.map((e) => join(base, "index" + e))]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function resolveSpecifier(spec, from, packages) {
  if (spec.startsWith(".")) return fileFor(resolve(dirname(from), spec));
  if (spec.startsWith("@/")) {
    // apps/web's path alias for src/.
    const web = packages.get("@app/web");
    return web ? fileFor(join(web.dir, "src", spec.slice(2))) : null;
  }
  const m = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(spec);
  const pkg = m && packages.get(m[1]);
  if (!pkg) return null;
  const sub = m[2] ? "." + m[2] : ".";
  if (pkg.exports.has(sub)) return pkg.exports.get(sub);
  // A wildcard export ("./*": "./src/*.ts").
  for (const [pattern, target] of pkg.exports) {
    if (!pattern.includes("*")) continue;
    const [pre, post] = pattern.split("*");
    if (sub.startsWith(pre) && sub.endsWith(post)) {
      const hit = sub.slice(pre.length, sub.length - post.length);
      return fileFor(target.replace("*", hit));
    }
  }
  return null;
}

/** The specifiers a module loads when it runs (type-only imports and exports left out). */
function runtimeImports(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out = [];
  const re = /(?:^|[;\n}])\s*(import|export)\s+([^;]*?)\s*from\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(re)) {
    if (m[4]) {
      out.push(m[4]);
      continue;
    }
    const clause = m[2].trim();
    if (/^type\b/.test(clause)) continue;
    // `import { type A, type B } from` loads nothing either.
    const named = /^\{([\s\S]*)\}$/.exec(clause);
    if (named && named[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
    out.push(m[3]);
  }
  // A dynamic import counts too: `await import()` only hides a cycle until the call runs.
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

/** Tarjan's strongly connected components; every component with more than one module is a cycle. */
function cycles(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const found = [];
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (graph.get(v) ?? new Set()).has(v)) found.push(comp);
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return found;
}

/** One concrete loop through a component, for the message: A → B → C → A. */
function loopIn(comp, graph) {
  const inComp = new Set(comp);
  const start = [...comp].sort()[0];
  const prev = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const v = queue.shift();
    for (const w of graph.get(v) ?? []) {
      if (!inComp.has(w)) continue;
      if (w === start) {
        const path = [v];
        for (let p = prev.get(v); p; p = prev.get(p)) path.unshift(p);
        return [...path, start];
      }
      if (!prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return comp;
}

const packages = workspacePackages();
const graph = new Map();
for (const top of SOURCE_DIRS) {
  for (const name of readdirSync(join(root, top))) {
    const src = join(root, top, name, "src");
    if (!existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const deps = new Set();
      for (const spec of runtimeImports(readFileSync(file, "utf8"))) {
        const target = resolveSpecifier(spec, file, packages);
        if (target && !target.includes("node_modules")) deps.add(target);
      }
      graph.set(file, deps);
    }
  }
}

const found = cycles(graph);
const rel = (p) => relative(root, p).replaceAll("\\", "/");
if (found.length) {
  console.error(`${found.length} import cycle${found.length > 1 ? "s" : ""}:`);
  for (const comp of found) {
    console.error(`  ${loopIn(comp, graph).map(rel).join("\n    → ")}${comp.length > 2 ? `\n    (${comp.length} modules in this loop)` : ""}`);
  }
  console.error("\nBreak each one: move what both sides need into a module that imports neither (docs/architecture.md, Packages).");
  process.exit(1);
}
console.log(`No import cycles in ${graph.size} modules.`);
