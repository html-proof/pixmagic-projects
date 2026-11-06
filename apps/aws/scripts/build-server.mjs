#!/usr/bin/env node
// Build the self-hosted server (docs/ikorex-migration): dist/server with
//   server.mjs       `node server.mjs web|worker` (src/server.ts), bundled with esbuild
//   admin.mjs        the maintenance command (src/admin.ts)
//   public/          the web UI (the same Next.js export the Lambda package ships)
//   fallback/        the export's /unavailable page, for the edge to show while the server can't answer
//   migrations/, init.sql   applied by `admin.mjs migrate`
//   build.json       the commit it was built from and when (GET /api/version)
//
//   node apps/aws/scripts/build-server.mjs [--skip-web]
//
// infra/ikorex/Dockerfile copies dist/server into the image as it is: no source, no node_modules.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const root = resolve(pkg, "../..");
const out = resolve(pkg, "dist/server");

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const buildInfo = { commit: `${git("rev-parse", "HEAD")}${git("status", "--porcelain") ? "-dirty" : ""}`, builtAt: new Date().toISOString() };

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!process.argv.includes("--skip-web")) {
  const r = spawnSync("pnpm", ["--filter", "@app/web", "build"], { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, NEXT_EXPORT_DIR: "out-aws" } });
  if (r.status !== 0) throw new Error("web build failed");
}
const ui = resolve(root, "apps/web/out-aws");
if (!existsSync(resolve(ui, "index.html"))) throw new Error(`No UI build in ${ui}: run without --skip-web`);
cpSync(ui, resolve(out, "public"), { recursive: true });
mkdirSync(resolve(out, "fallback"));
if (existsSync(resolve(out, "public/unavailable.html"))) renameSync(resolve(out, "public/unavailable.html"), resolve(out, "fallback/unavailable.html"));
for (const f of ["unavailable.txt", "unavailable"]) rmSync(resolve(out, "public", f), { recursive: true, force: true });

await build({
  entryPoints: { server: resolve(pkg, "src/server.ts"), admin: resolve(pkg, "src/admin.ts") },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  // No code splitting: each bundle finds public/, migrations/ and build.json beside itself (import.meta.url).
  platform: "node",
  target: "node24",
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // CommonJS dependencies (pg) call require() for Node's own modules.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  // Optional extras pg probes for (native bindings; sockets on other runtimes); never used here.
  external: ["pg-native", "cloudflare:sockets"],
  logLevel: "warning",
});

cpSync(resolve(root, "packages/db/prisma/migrations"), resolve(out, "migrations"), { recursive: true });
cpSync(resolve(root, "infra/postgres/init.sql"), resolve(out, "init.sql"));
writeFileSync(resolve(out, "build.json"), `${JSON.stringify(buildInfo)}\n`);
console.log(`built ${out} (${buildInfo.commit.slice(0, 12)})`);
