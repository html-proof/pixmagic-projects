#!/usr/bin/env node
// Build the AWS Lambda package (infra/aws/staging.yaml): dist/function.zip with
//   index.mjs        the function (API + static UI), bundled with esbuild
//   *.wasm           Prisma's query compiler
//   public/          the web UI (Next.js export, built into apps/web/out-aws)
//   migrations/, init.sql   applied by the function itself ({ "action": "migrate" })
//   rds-ca.pem       Amazon RDS's CA bundle (NODE_EXTRA_CA_CERTS: TLS to the database is verified)
//
//   node apps/aws/scripts/build.mjs [--skip-web]
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const root = resolve(pkg, "../..");
const out = resolve(pkg, "dist/function");
const zip = resolve(pkg, "dist/function.zip");

rmSync(resolve(pkg, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!process.argv.includes("--skip-web")) {
  const r = spawnSync("pnpm", ["--filter", "@app/web", "build"], { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, NEXT_EXPORT_DIR: "out-aws" } });
  if (r.status !== 0) throw new Error("web build failed");
}
cpSync(resolve(root, "apps/web/out-aws"), resolve(out, "public"), { recursive: true });

/** Prisma's generated client imports its query compiler as `*.wasm?module` (a compiled module, as on workerd). */
const wasmModule = {
  name: "wasm-module",
  setup(b) {
    b.onResolve({ filter: /\.wasm\?module$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -"?module".length)), namespace: "wasm-module" }));
    b.onLoad({ filter: /.*/, namespace: "wasm-module" }, (args) => {
      const name = basename(args.path);
      cpSync(args.path, resolve(out, name));
      return {
        contents: `import { readFileSync } from "node:fs";\nexport default new WebAssembly.Module(readFileSync(new URL("./${name}", import.meta.url)));\n`,
        loader: "js",
        resolveDir: out,
      };
    });
  },
};

await build({
  entryPoints: [resolve(pkg, "src/index.ts")],
  outfile: resolve(out, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  plugins: [wasmModule],
  // CommonJS dependencies (pg) call require() for Node's own modules.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  // Optional native/cloud extras some dependencies probe for; never used here.
  external: ["pg-native", "cloudflare:sockets"],
  logLevel: "warning",
});

cpSync(resolve(root, "packages/db/prisma/migrations"), resolve(out, "migrations"), { recursive: true });
cpSync(resolve(root, "infra/postgres/init.sql"), resolve(out, "init.sql"));

// Amazon's own CA bundle for RDS, so the database's certificate is checked (sslmode=verify-full).
const caFile = resolve(out, "rds-ca.pem");
const res = await fetch("https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem");
if (!res.ok) throw new Error(`Downloading the RDS CA bundle failed (${res.status})`);
const ca = await res.text();
if (!ca.includes("BEGIN CERTIFICATE")) throw new Error("The RDS CA bundle doesn't look like PEM certificates");
writeFileSync(caFile, ca);

// Zip the folder's contents (at the root of the archive, as Lambda expects). Windows' bsdtar or zip(1).
const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : null;
if (tar && existsSync(tar)) execFileSync(tar, ["-a", "-c", "-f", zip, "-C", out, "."], { stdio: "inherit" });
else execFileSync("zip", ["-qr", zip, "."], { cwd: out, stdio: "inherit" });

const size = readFileSync(zip).length;
console.log(`built ${zip} (${(size / 1024 / 1024).toFixed(1)} MB)`);

// One file to upload to CloudShell: the package, both templates and the deploy script (LF line
// endings: bash on Linux reads them), plus the commit they were built from.
const bundleDir = resolve(pkg, "dist/staging-bundle");
mkdirSync(bundleDir, { recursive: true });
cpSync(zip, resolve(bundleDir, "function.zip"));
for (const f of ["staging.yaml", "cognito.yaml", "deploy-staging.sh"]) {
  writeFileSync(resolve(bundleDir, f), readFileSync(resolve(root, "infra/aws", f), "utf8").replace(/
/g, "
"));
}
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() ? "-dirty" : "";
writeFileSync(resolve(bundleDir, "COMMIT"), `${sha}${dirty}
`);
const bundle = resolve(pkg, "dist/insights-staging-bundle.zip");
if (tar && existsSync(tar)) execFileSync(tar, ["-a", "-c", "-f", bundle, "-C", bundleDir, "."], { stdio: "inherit" });
else execFileSync("zip", ["-qr", bundle, "."], { cwd: bundleDir, stdio: "inherit" });
console.log(`built ${bundle} (commit ${sha}${dirty})`);
