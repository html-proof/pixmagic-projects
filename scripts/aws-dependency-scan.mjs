/**
 * Does any file run, call or configure AWS? bizinsights left AWS on 2026-11-13 (the iKorex server,
 * docs/ikorex-migration/LEAVING_AWS.md) and the last AWS code left the repository after it, so the
 * answer is no, and `pnpm lint` keeps it so. Markdown and docs/ only describe AWS, so they are
 * counted, not listed. A line that is only a comment doesn't count either.
 *
 *   node scripts/aws-dependency-scan.mjs              the report (Markdown)
 *   node scripts/aws-dependency-scan.mjs --none-left  exits 1 if any file touches AWS (pnpm lint)
 *   node scripts/aws-dependency-scan.mjs --check      the same, for a file not listed in GROUPS
 *
 * GROUPS is empty. A file that must name AWS again (a new integration that happens to live there)
 * is listed in it with why, and `pnpm lint` goes back to --check.
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
  ["setting", /\b[A-Z0-9_]*(AWS|COGNITO)_[A-Z0-9_]+|\bSES_(REGION|CONFIGURATION_SET)\b|\b[A-Z_]+_SECRET_ARN\b/],
];

/** Lines that are only a comment, in the languages here (TypeScript, shell, YAML, env files, HTML). */
const COMMENT = /^\s*(\/\/|\/\*|\*|#|<!--)/;

/** Text the scan reads; images, fonts and the lockfile are skipped. */
const SKIP = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|pdf|zip|gz)$|(^|\/)pnpm-lock\.yaml$/;

/** This file names AWS's libraries and endpoints to find them; it uses none. */
const SELF = "scripts/aws-dependency-scan.mjs";

/** Documentation: describes AWS, runs nothing. */
const isDocs = (path) => path.endsWith(".md") || path.startsWith("docs/");

/**
 * Files allowed to touch AWS, by why. A path ending in "/" covers the folder. Empty since the last
 * AWS code was removed.
 * @type {Array<{ title: string, goes: string, paths: string[] }>}
 */
export const GROUPS = [];

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
    if (SKIP.test(path) || path === SELF) continue;
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
