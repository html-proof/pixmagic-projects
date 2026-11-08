/**
 * Which files still run, call or configure AWS, and when each one goes (the move to the iKorex
 * server, docs/ikorex-migration). Markdown and docs/ only describe AWS, so they are counted, not
 * listed. A line that is only a comment doesn't count either.
 *
 *   node scripts/aws-dependency-scan.mjs              the report (Markdown), grouped by when each file goes
 *   node scripts/aws-dependency-scan.mjs --check      exits 1 if a file not listed below touches AWS (pnpm lint)
 *   node scripts/aws-dependency-scan.mjs --none-left  exits 1 if any file still does (stage F's acceptance)
 *
 * --check keeps new AWS code out while the move is under way: a file that needs AWS is added to
 * GROUPS with the step that removes it, or doesn't use AWS. After stage F the groups are emptied and
 * --none-left takes --check's place in `pnpm lint`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What counts as using AWS: its libraries, endpoints, request signing, resource names and settings. */
export const PATTERNS = [
  ["library", /aws4fetch|@aws-sdk\/|@aws-crypto\/|aws-cdk/],
  ["endpoint", /amazonaws\.com|cognito-idp/],
  ["signing", /X-Amz-/],
  ["resource name", /arn:aws:/],
  // Prefixed names too: E2E_COGNITO_PORT, vars.AWS_WHATSAPP.
  ["setting", /\b[A-Z0-9_]*(AWS|COGNITO)_[A-Z0-9_]+|\bSES_(REGION|CONFIGURATION_SET)\b|\bSMS_EVENTS_QUEUE_URL\b|\b[A-Z_]+_SECRET_ARN\b/],
];

/** Lines that are only a comment, in the languages here (TypeScript, shell, YAML, env files, HTML). */
const COMMENT = /^\s*(\/\/|\/\*|\*|#|<!--)/;

/** Text the scan reads; images, fonts and the lockfile are skipped. */
const SKIP = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|pdf|zip|gz)$|(^|\/)pnpm-lock\.yaml$/;

/** Documentation: describes AWS, runs nothing. */
const isDocs = (path) => path.endsWith(".md") || path.startsWith("docs/");

/**
 * Every file allowed to touch AWS until the move is done, by when it goes. A path ending in "/"
 * covers the folder. The order is the order of the report; the first group that names a file wins.
 */
export const GROUPS = [
  {
    title: "AWS's infrastructure and its deploy",
    goes: "Stage F, with the resources it describes (ROLLBACK_PLAN.md, \"Order of decommissioning\")",
    paths: ["infra/cdk/", "infra/aws/", ".github/workflows/aws-deploy.yml"],
  },
  {
    title: "The Lambda functions and the AWS adapters only they load",
    goes: "Stage F, with the functions. The server's bundle (`server.ts`, `admin.ts`) loads none of these",
    paths: [
      "apps/aws/src/index.ts",
      "apps/aws/src/cognitoEmail.ts",
      "apps/aws/src/dynamoCoord.ts",
      "apps/aws/src/s3Blobs.ts",
      "apps/aws/src/secrets.ts",
      "apps/aws/scripts/build.mjs",
      "apps/aws/package.json",
      "apps/aws/.env.example",
      "apps/aws/test/",
    ],
  },
  {
    title: "AWS code the server loads, used only when a switch says so",
    goes: "Each when its switch is on the AWS-free side (`AUTH_MODE=local`, `SMS_PROVIDER=twilio`, no `SMS_EVENTS_QUEUE_URL`, no `SES_REGION`); the AWS side deleted at stage F",
    paths: [
      "apps/aws/src/selfhost.ts",
      "apps/aws/src/app.ts",
      "apps/aws/src/actions.ts",
      "apps/aws/src/awsClient.ts",
      "apps/aws/src/mailers.ts",
      "apps/aws/src/sesMailer.ts",
      "apps/aws/src/smsProvider.ts",
      "apps/aws/src/sqsBridge.ts",
      "infra/ikorex/env/",
      "infra/ikorex/monitoring/alerts.yml",
    ],
  },
  {
    title: "Cognito in the app, its settings and its test stand-in",
    goes: "After `AUTH_MODE=local` on the server (ROLLBACK_PLAN.md, \"Before stage F starts\", step 3)",
    paths: [
      "apps/api/src/cognito.ts",
      "apps/api/src/migratingAuth.ts",
      "apps/api/src/routes/auth.ts",
      "apps/api/package.json",
      "packages/core/src/env.ts",
      "packages/core/src/configReport.ts",
      "apps/api/test/account.test.ts",
      "apps/api/test/auth.test.ts",
      "apps/api/test/cognito.test.ts",
      "apps/api/test/cognito.live.test.ts",
      "apps/api/test/mfa.test.ts",
      "packages/core/test/configReport.test.ts",
      "packages/core/test/security.test.ts",
      "apps/web/e2e/",
      "apps/web/playwright.config.ts",
      ".github/workflows/ci.yml",
      "infra/cognito-local/",
      ".claude/",
    ],
  },
  {
    title: "SMS records shaped by AWS (sender ARNs, AWS's registration states, the SMS region)",
    goes: "After `SMS_PROVIDER=twilio`: rows already stored keep their AWS ARNs as history, new senders are Twilio's",
    paths: [
      "packages/core/src/sms/common.ts",
      "apps/web/src/components/messaging/Sender.tsx",
      "apps/aws/src/local.ts",
      "apps/api/test/automations.test.ts",
      "apps/api/test/integrations.test.ts",
      "apps/api/test/sms.test.ts",
      "apps/api/test/smsAutomations.test.ts",
      "apps/api/test/smsReadiness.test.ts",
      "apps/api/test/smsSetup.test.ts",
      "apps/worker/test/sms.test.ts",
      "apps/worker/load/automations.load.ts",
      "packages/shared/test/sms.test.ts",
    ],
  },
  {
    title: "Lambda's version number in `/api/version`",
    goes: "Stage F. On the server `release` is empty: the commit identifies the build",
    paths: ["apps/api/src/app.ts", "apps/api/test/observability.test.ts"],
  },
  {
    title: "The migration's own tools (copies between AWS and the server, the secrets export)",
    goes: "Stage F, after the final dump of RDS",
    paths: ["infra/ikorex/scripts/"],
  },
];

/** The group a path belongs to, or null. */
export function groupOf(path) {
  return GROUPS.find((g) => g.paths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p))) ?? null;
}

/** What kinds of AWS use a file's text shows, and on how many lines. */
export function awsUse(text) {
  const kinds = new Set();
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (COMMENT.test(line)) continue;
    const found = PATTERNS.filter(([, re]) => re.test(line)).map(([kind]) => kind);
    if (!found.length) continue;
    lines++;
    for (const k of found) kinds.add(k);
  }
  return { lines, kinds: [...kinds] };
}

export function scan(files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean), read = (p) => readFileSync(resolve(root, p), "utf8")) {
  const hits = [];
  let docs = 0;
  for (const path of files) {
    if (SKIP.test(path)) continue;
    let text;
    try {
      text = read(path);
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    const use = awsUse(text);
    if (!use.lines) continue;
    if (isDocs(path)) docs++;
    else hits.push({ path, ...use, group: groupOf(path) });
  }
  return { hits, docs };
}

function report({ hits, docs }) {
  const out = [];
  for (const g of GROUPS) {
    const mine = hits.filter((h) => h.group === g);
    if (!mine.length) continue;
    out.push(`### ${g.title} (${mine.length})`, "", `Goes: ${g.goes}.`, "", "| File | Lines | Kind |", "| --- | --- | --- |");
    for (const h of mine) out.push(`| \`${h.path}\` | ${h.lines} | ${h.kinds.join(", ")} |`);
    out.push("");
  }
  const strays = hits.filter((h) => !h.group);
  if (strays.length) {
    out.push(`### Not listed (${strays.length}): new AWS code`, "", "| File | Lines | Kind |", "| --- | --- | --- |");
    for (const h of strays) out.push(`| \`${h.path}\` | ${h.lines} | ${h.kinds.join(", ")} |`);
    out.push("");
  }
  const lines = hits.reduce((n, h) => n + h.lines, 0);
  out.push(`**${hits.length} files, ${lines} lines** touch AWS. Documentation that mentions it, not counted: ${docs} files.`);
  return out.join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mode = process.argv[2] ?? "";
  const result = scan();
  if (mode === "--check") {
    const strays = result.hits.filter((h) => !h.group);
    for (const h of strays) console.error(`${h.path}: uses AWS (${h.kinds.join(", ")}) but isn't listed in scripts/aws-dependency-scan.mjs. The app is leaving AWS (docs/ikorex-migration): use the provider's interface, or list the file with the step that removes it.`);
    process.exit(strays.length ? 1 : 0);
  } else if (mode === "--none-left") {
    for (const h of result.hits) console.error(`${h.path}: still uses AWS (${h.kinds.join(", ")})`);
    console.error(result.hits.length ? `${result.hits.length} files still use AWS` : "No file uses AWS");
    process.exit(result.hits.length ? 1 : 0);
  } else if (mode) {
    console.error(`unknown option ${mode}: --check, --none-left, or nothing for the report`);
    process.exit(2);
  } else {
    console.log(report(result));
  }
}
