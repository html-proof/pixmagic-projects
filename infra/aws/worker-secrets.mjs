#!/usr/bin/env node
// Copy the Cognito stack's secrets (infra/aws/cognito.yaml: the app client secret and the admin
// access key, kept in Secrets Manager) into the Worker's secrets, without printing any of them.
//
//   node infra/aws/worker-secrets.mjs <secret id or ARN> [--region <region>] [--env <wrangler env>]
//
// Needs the AWS CLI signed in to the account (aws configure / aws sso login) and wrangler signed in
// to Cloudflare. Each value goes from one program's stdout to the other's stdin; nothing is written
// to disk. `wrangler secret put` makes a new Worker version with the secret: run it as part of a
// deploy (docs/cognito-setup.md), not on its own against production.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [secretId, ...rest] = process.argv.slice(2);
if (!secretId) {
  console.error("usage: node infra/aws/worker-secrets.mjs <secret id or ARN> [--region <region>] [--env <wrangler env>]");
  process.exit(2);
}
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const region = opt("region");
const wranglerEnv = opt("env");

const raw = execFileSync(
  "aws",
  ["secretsmanager", "get-secret-value", "--secret-id", secretId, "--query", "SecretString", "--output", "text", ...(region ? ["--region", region] : [])],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" },
);
const values = JSON.parse(raw);
const names = ["COGNITO_CLIENT_SECRET", "COGNITO_ADMIN_ACCESS_KEY_ID", "COGNITO_ADMIN_SECRET_ACCESS_KEY"];
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/cloudflare");
for (const name of names) {
  if (!values[name]) throw new Error(`${secretId} has no ${name}`);
  const r = spawnSync("npx", ["wrangler", "secret", "put", name, ...(wranglerEnv ? ["--env", wranglerEnv] : [])], {
    cwd,
    input: values[name],
    stdio: ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  if (r.status !== 0) throw new Error(`wrangler secret put ${name} failed`);
  console.log(`set ${name}`);
}
