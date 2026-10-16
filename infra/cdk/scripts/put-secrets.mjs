#!/usr/bin/env node
// Fill the app secret (insights/<env>/app, created by the Data stack) without printing any value.
//
//   node infra/cdk/scripts/put-secrets.mjs [--env production] [--from <file>]... [--set NAME]... [--dry-run]
//
// --from <file>  a dotenv file (e.g. the main checkout's .env) to copy the values below from; the
//                ones that must match the old deployment's secrets (TOKEN_ENCRYPTION_KEYS decrypts
//                every stored store/ad token, OTP_PEPPER keys stored customer hashes) come from here.
// --set NAME     read NAME's value from the clipboard (Windows: Get-Clipboard), for a secret only
//                its owner has (META_APP_SECRET, GOOGLE_ADS_CLIENT_SECRET, ...). Copy it, run this.
//                When the clipboard has no usable value (taking a screenshot replaces copied text),
//                it asks for it instead: paste or type it, only a * per character is shown.
// --dry-run      everything but the write: says what would change.
//
// Values already in the secret are kept unless a source provides a new one; SESSION_SECRET,
// APP_RLS_PASSWORD are generated when missing; ORIGIN_VERIFY (CloudFront's) is never touched.
// Only key names are printed. The value goes to AWS through a temporary file, deleted at once.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
  return out;
};
const envName = opt("--env")[0] ?? "production";
const region = opt("--region")[0] ?? "ap-southeast-2";
const dryRun = args.includes("--dry-run");
const secretId = `insights/${envName}/app`;

/**
 * Values with a known shape, so a wrong paste (the client ID, a URL) or whatever was left on the
 * clipboard is refused, not stored.
 */
const GOOGLE_SECRET = [/^GOCSPX-[A-Za-z0-9_-]{20,}$/, "a Google OAuth client secret (it starts with GOCSPX-)"];
const SHOPIFY_SECRET = [/^(shpss_)?[0-9a-f]{32}$/i, "a Shopify app client secret (shpss_ and 32 letters and digits)"];
const SHAPES = {
  GOOGLE_SIGNIN_CLIENT_SECRET: GOOGLE_SECRET,
  GOOGLE_ADS_CLIENT_SECRET: GOOGLE_SECRET,
  SHOPIFY_API_SECRET: SHOPIFY_SECRET,
  // The app's email provider (packages/core/src/mail; docs/aws-deployment.md "App email").
  RESEND_API_KEY: [/^re_[A-Za-z0-9_]{20,}$/, "a Resend API key (it starts with re_)"],
  RESEND_WEBHOOK_SECRET: [/^whsec_[A-Za-z0-9+/=]{20,}$/, "a Resend webhook signing secret (it starts with whsec_)"],
};

/** Copied from --from files when present there. */
const COPY = [
  "TOKEN_ENCRYPTION_KEYS",
  "OTP_PEPPER",
  "CUSTOMER_HASH_KEY",
  "SHOPIFY_API_SECRET",
  "ALERT_SLACK_WEBHOOK_URL",
  "META_APP_SECRET",
  "GOOGLE_ADS_CLIENT_SECRET",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "EMAIL_GOOGLE_CLIENT_SECRET",
  "EMAIL_MICROSOFT_CLIENT_SECRET",
  "EMAIL_CREDENTIAL_KEYS",
  "TURNSTILE_SECRET",
];
const COPY_PREFIX = /^SHOPIFY_APP_SECRET_[A-Z0-9_]+$/;
/** Values anyone can read in this repository (packages/core/src/env.ts PUBLIC_SECRET_MARKERS). */
const PUBLIC = ["change-me", "insights-local-client-secret", "replace_with", "test-session-secret", "e2e-session-secret", "test-pepper", "e2e-pepper", "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="];

const aws = (cliArgs) => execFileSync("aws", [...cliArgs, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function clipboardText() {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Asks in the terminal; prints a * per character, never the value. Piped input is read as is. */
async function ask(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let piped = "";
    for await (const chunk of stdin) piped += chunk;
    return piped.trim();
  }
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk) => {
      // Arrow and function keys arrive as escape sequences: not part of the value.
      // eslint-disable-next-line no-control-regex -- ESC is exactly what these sequences start with
      for (const ch of chunk.replace(/\u001b(\[[0-9;?]*[ -/]*[@-~]|O.)?/g, "")) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") {
          finish();
          console.error("Cancelled: nothing was saved.");
          process.exit(1);
        }
        if (ch === "\b" || ch === "\u007f") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        // Ctrl+V reaching us as a key (a console that doesn't paste by itself): paste the clipboard.
        const add = ch === "\u0016" ? clipboardText() : ch >= " " ? ch : "";
        value += add;
        process.stdout.write("*".repeat(add.length));
      }
    };
    stdin.on("data", onData);
  });
}

const current = JSON.parse(JSON.parse(aws(["secretsmanager", "get-secret-value", "--secret-id", secretId])).SecretString);
const next = { ...current };
const report = [];

for (const file of opt("--from")) {
  const vars = parseDotenv(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(vars)) {
    if (!v || !(COPY.includes(k) || COPY_PREFIX.test(k))) continue;
    if (PUBLIC.some((p) => v.toLowerCase().includes(p.toLowerCase()))) {
      report.push(`${k}: skipped (a public placeholder value in ${file})`);
      continue;
    }
    if (next[k] !== v) report.push(`${k}: ${next[k] ? "replaced" : "set"} from ${file}`);
    next[k] = v;
  }
}

for (const name of opt("--set")) {
  if (!/^[A-Z][A-Z0-9_]+$/.test(name) || name === "ORIGIN_VERIFY") throw new Error(`Not a settable secret name: ${name}`);
  const [shape, what] = SHAPES[name] ?? (COPY_PREFIX.test(name) ? SHOPIFY_SECRET : [/./, "a value"]);
  let value = clipboardText();
  let source = "the clipboard";
  if (!shape.test(value)) {
    console.log(value ? `The clipboard doesn't hold ${what}.` : "The clipboard has no text (a screenshot replaces copied text).");
    value = await ask(`Paste or type ${name}, then press Enter: `);
    source = "what you entered";
  }
  if (!shape.test(value)) {
    console.error(`That isn't ${what} (${value.length} characters): nothing was saved.`);
    process.exit(1);
  }
  if (next[name] !== value) report.push(`${name}: ${next[name] ? "replaced" : "set"} from ${source}`);
  next[name] = value;
}

const generate = { SESSION_SECRET: () => randomBytes(48).toString("base64url"), APP_RLS_PASSWORD: () => randomBytes(24).toString("hex") };
for (const [k, make] of Object.entries(generate)) {
  if (!next[k]) {
    next[k] = make();
    report.push(`${k}: generated`);
  }
}
// --generate NAME: a new random value on purpose, for a secret that should match production's but
// can't be read back from the old deployment (OTP_PEPPER: then stored customer hashes need re-keying, or
// production's value as CUSTOMER_HASH_KEY, before this environment takes over).
for (const name of opt("--generate")) {
  if (!["OTP_PEPPER", "SESSION_SECRET", "APP_RLS_PASSWORD", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"].includes(name)) throw new Error(`Won't generate ${name}`);
  next[name] = randomBytes(32).toString("base64url");
  report.push(`${name}: generated (new value, on request)`);
}
if (!next.ORIGIN_VERIFY) throw new Error("ORIGIN_VERIFY is missing from the secret: it is created by the Data stack, deploy that first");

const missing = ["TOKEN_ENCRYPTION_KEYS", "OTP_PEPPER", "SHOPIFY_API_SECRET"].filter((k) => !next[k]);
if (dryRun) report.push("(dry run: nothing was written)");
else if (JSON.stringify(next) !== JSON.stringify(current)) {
  const dir = mkdtempSync(join(tmpdir(), "insights-secret-"));
  const file = join(dir, "value.json");
  try {
    writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
    aws(["secretsmanager", "put-secret-value", "--secret-id", secretId, "--secret-string", `file://${file}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`${secretId}:`);
for (const line of report.length ? report : ["no change"]) console.log(`  ${line}`);
console.log(`  keys now: ${Object.keys(next).sort().join(", ")}`);
if (missing.length) console.log(`  STILL MISSING (the app refuses to start without them): ${missing.join(", ")}`);
