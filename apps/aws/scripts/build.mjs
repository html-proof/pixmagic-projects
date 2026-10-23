#!/usr/bin/env node
// Build the AWS Lambda package: dist/function (and the same as dist/function.zip) with
//   index.mjs        the function (API + static UI), bundled with esbuild
//   cognito-email.mjs  the user pool's Custom Email Sender trigger (src/cognitoEmail.ts), on its own
//   public/          the web UI (Next.js export, built into apps/web/out-aws)
//   fallback/        the export's /unavailable page, which CloudFront shows while the function can't answer
//   migrations/, init.sql   applied by the function itself ({ "action": "migrate" })
//   rds-ca.pem       Amazon RDS's CA bundle (NODE_EXTRA_CA_CERTS: TLS to the database is verified)
//   build.json       the commit it was built from and when (infra/cdk's APP_COMMIT, APP_BUILT_AT)
//
//   node apps/aws/scripts/build.mjs [--skip-web]
//
// infra/cdk deploys dist/function.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const root = resolve(pkg, "../..");
const out = resolve(pkg, "dist/function");
const zip = resolve(pkg, "dist/function.zip");

// Which commit this package is, read before the build touches anything (it rewrites
// apps/web/next-env.d.ts): infra/cdk puts it in the functions' environment from build.json, and
// GET /api/version shows it, so a deploy can be checked at the public address.
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const buildInfo = { commit: `${git("rev-parse", "HEAD")}${git("status", "--porcelain") ? "-dirty" : ""}`, builtAt: new Date().toISOString() };

rmSync(resolve(pkg, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!process.argv.includes("--skip-web")) {
  const r = spawnSync("pnpm", ["--filter", "@app/web", "build"], { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, NEXT_EXPORT_DIR: "out-aws" } });
  if (r.status !== 0) throw new Error("web build failed");
}
cpSync(resolve(root, "apps/web/out-aws"), resolve(out, "public"), { recursive: true });
// The page CloudFront shows while the function can't answer (apps/web/src/app/unavailable): not one
// the function serves, so it moves to fallback/, which infra/cdk uploads to the site bucket.
mkdirSync(resolve(out, "fallback"));
renameSync(resolve(out, "public/unavailable.html"), resolve(out, "fallback/unavailable.html"));
for (const f of ["unavailable.txt", "unavailable"]) rmSync(resolve(out, "public", f), { recursive: true, force: true });

// Two bundles from one build: the app's functions, and Cognito's email trigger, which loads only
// what it needs (the AWS Encryption SDK and the mailer), not the API and the jobs.
await build({
  entryPoints: { index: resolve(pkg, "src/index.ts"), "cognito-email": resolve(pkg, "src/cognitoEmail.ts") },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
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

// Amazon's own CA bundle for RDS, so the database's certificate is checked (sslmode=verify-full).
const caFile = resolve(out, "rds-ca.pem");
const res = await fetch("https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem");
if (!res.ok) throw new Error(`Downloading the RDS CA bundle failed (${res.status})`);
const ca = await res.text();
if (!ca.includes("BEGIN CERTIFICATE")) throw new Error("The RDS CA bundle doesn't look like PEM certificates");
writeFileSync(caFile, ca);
writeFileSync(resolve(out, "build.json"), `${JSON.stringify(buildInfo)}\n`);

// Zip the folder's contents (at the root of the archive, as Lambda expects). Windows' bsdtar or zip(1).
const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : null;
if (tar && existsSync(tar)) execFileSync(tar, ["-a", "-c", "-f", zip, "-C", out, "."], { stdio: "inherit" });
else execFileSync("zip", ["-qr", zip, "."], { cwd: out, stdio: "inherit" });

const size = readFileSync(zip).length;
console.log(`built ${zip} (${(size / 1024 / 1024).toFixed(1)} MB)`);
