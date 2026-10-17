#!/usr/bin/env node
// Build the AWS Lambda package (infra/aws/staging.yaml): dist/function.zip with
//   index.mjs        the function (API + static UI), bundled with esbuild
//   cognito-email.mjs  the user pool's Custom Email Sender trigger (src/cognitoEmail.ts), on its own
//   public/          the web UI (Next.js export, built into apps/web/out-aws)
//   migrations/, init.sql   applied by the function itself ({ "action": "migrate" })
//   rds-ca.pem       Amazon RDS's CA bundle (NODE_EXTRA_CA_CERTS: TLS to the database is verified)
//   build.json       the commit it was built from and when (infra/cdk's APP_COMMIT, APP_BUILT_AT)
//
//   node apps/aws/scripts/build.mjs [--skip-web] [--no-staging-bundle]
//
// infra/cdk deploys dist/function; the staging bundle is the Phase 1 CloudShell path (docs/aws-staging.md).
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Two bundles from one build: the app's functions, and Cognito's email trigger, which loads only
// what it needs (the AWS Encryption SDK and the mailer), not the API and the jobs.
await build({
  entryPoints: { index: resolve(pkg, "src/index.ts"), "cognito-email": resolve(pkg, "src/cognitoEmail.ts") },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
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

if (process.argv.includes("--no-staging-bundle")) process.exit(0);

// One file to upload to CloudShell: the package, both templates and the deploy script (LF line
// endings: bash on Linux reads them), plus the commit they were built from.
const bundleDir = resolve(pkg, "dist/staging-bundle");
mkdirSync(bundleDir, { recursive: true });
cpSync(zip, resolve(bundleDir, "function.zip"));
for (const f of ["staging.yaml", "cognito.yaml", "deploy-staging.sh"]) {
  writeFileSync(resolve(bundleDir, f), readFileSync(resolve(root, "infra/aws", f), "utf8").replace(/\r\n/g, "\n"));
}
writeFileSync(resolve(bundleDir, "COMMIT"), `${buildInfo.commit}\n`);
const bundle = resolve(pkg, "dist/insights-staging-bundle.zip");
if (tar && existsSync(tar)) execFileSync(tar, ["-a", "-c", "-f", bundle, "-C", bundleDir, "."], { stdio: "inherit" });
else execFileSync("zip", ["-qr", bundle, "."], { cwd: bundleDir, stdio: "inherit" });
console.log(`built ${bundle} (commit ${buildInfo.commit})`);
