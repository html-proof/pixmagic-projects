#!/usr/bin/env node
// Local development and e2e only: run the Cognito emulator (cognito-local) with the app's user pool
// already in it (seed/: pool local_insights, app client insightslocalwebclient00, test-only secret).
//
//   node infra/cognito-local/start.mjs                     port 9229, data in infra/cognito-local/data
//   node infra/cognito-local/start.mjs --port 9239 --data <dir> --fresh
//
// --fresh starts from the seed again (no users). It listens on 127.0.0.1 only, and its tokens'
// issuer is http://127.0.0.1:<port>/local_insights, which is what COGNITO_ENDPOINT points the
// Worker at. Codes it would email are printed in its log and kept in <data>/.cognito/db/local_insights.json.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", "9229"));
const data = resolve(arg("data", resolve(here, "data")));

if (process.argv.includes("--fresh")) rmSync(data, { recursive: true, force: true });
if (!existsSync(resolve(data, ".cognito/db/local_insights.json"))) {
  mkdirSync(data, { recursive: true });
  cpSync(resolve(here, "seed/.cognito"), resolve(data, ".cognito"), { recursive: true });
}
writeFileSync(resolve(data, ".cognito/config.json"), JSON.stringify({ TokenConfig: { IssuerDomain: `http://127.0.0.1:${port}` } }, null, 2));

const child = spawn("npx", ["-y", "cognito-local@5.3.0"], {
  cwd: data,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
  stdio: "inherit",
  shell: process.platform === "win32",
});
const stop = () => child.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
