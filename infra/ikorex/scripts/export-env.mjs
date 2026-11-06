// Copy production's settings and secrets from AWS into env-file lines, for env/app.env and
// env/evolution.env on the iKorex server (docs/ikorex-migration). Run on a PC signed in to AWS
// (`aws login`), straight into a file on the server, so no value is ever shown or stored here:
//
//   node infra/ikorex/scripts/export-env.mjs app | ssh deployer@103.146.112.176 "umask 077; cat > ~/bizinsights/env/app.env.from-aws"
//   node infra/ikorex/scripts/export-env.mjs evolution | ssh deployer@103.146.112.176 "umask 077; cat > ~/bizinsights/env/evolution.env.from-aws"
//
// It refuses to write to a terminal. On stderr it lists the names it wrote and the ones it left out,
// never a value. What it leaves out belongs to AWS alone (the CloudFront origin secret, RDS's
// passwords): the server's database gets new passwords (env/owner.env.example).
import { execFileSync } from "node:child_process";

const which = process.argv[2];
if (which !== "app" && which !== "evolution") {
  console.error("usage: export-env.mjs app|evolution  (pipe it into a file on the server)");
  process.exit(2);
}
if (process.stdout.isTTY) {
  console.error("Refusing to print secrets to a terminal: pipe the output into a file on the server (see the comment at the top).");
  process.exit(2);
}

const env = process.argv[3] ?? "production";
const region = process.env.AWS_REGION || "ap-southeast-2";
const aws = (...args) => JSON.parse(execFileSync("aws", [...args, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, MSYS_NO_PATHCONV: "1" } }));
const secret = (id) => JSON.parse(aws("secretsmanager", "get-secret-value", "--secret-id", id).SecretString);

/** Only meaningful on AWS. */
const AWS_ONLY = new Set(["ORIGIN_VERIFY", "APP_RLS_PASSWORD", "SYSTEM_DB_USER", "SYSTEM_DB_PASSWORD", "EVOLUTION_DB_USER", "EVOLUTION_DB_PASSWORD"]);

const out = new Map();
const skipped = [];
const add = (k, v) => {
  if (typeof v !== "string" || AWS_ONLY.has(k)) return void skipped.push(k);
  // An env file holds one line per setting: Docker reads the rest of the line literally.
  if (/[\r\n]/.test(v)) return void skipped.push(`${k} (spans lines: copy by hand)`);
  out.set(k, v);
};

if (which === "app") {
  for (const [k, v] of Object.entries(secret(`insights/${env}/app`))) add(k, v);
  for (const [k, v] of Object.entries(secret(`insights/${env}/worker-cognito`))) add(k, v);
  for (const [k, v] of Object.entries(secret(`insights/${env}/evolution-api`))) add(k, v);
  const runtime = JSON.parse(aws("ssm", "get-parameter", "--name", `/insights/${env}/runtime`).Parameter.Value);
  for (const [k, v] of Object.entries(runtime)) add(k, v);
} else {
  const { EVOLUTION_API_KEY } = secret(`insights/${env}/evolution-api`);
  add("AUTHENTICATION_API_KEY", EVOLUTION_API_KEY);
}

process.stdout.write(`# From AWS (${env}), ${new Date().toISOString()}: merge into env/${which}.env, then delete this file.\n`);
for (const [k, v] of out) process.stdout.write(`${k}=${v}\n`);
console.error(`wrote ${out.size}: ${[...out.keys()].join(", ")}`);
if (skipped.length) console.error(`left out: ${skipped.join(", ")}`);
