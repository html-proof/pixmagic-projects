// The parts of copy-db.mjs that touch nothing (its tests: copy-db-lib.test.mjs).
import { createHash } from "node:crypto";

/** The fingerprint the administrator's SSH guide (5 Nov 2026) gives for the server's host key. */
export const PINNED_HOST = "103.146.112.176";
export const PINNED_FINGERPRINT = "SHA256:5whPPmUOtct7uImi8hLLqyVU5vv1j470FAfLI5Or+TA";

/** OpenSSH's SHA256 fingerprint of the ed25519 key a known_hosts file holds for `host`. */
export function hostKeyFingerprint(knownHosts, host) {
  const line = knownHosts
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find((f) => f.length >= 3 && !f[0].startsWith("#") && f[0].split(",").includes(host) && f[1] === "ssh-ed25519");
  if (!line) return null;
  return `SHA256:${createHash("sha256").update(Buffer.from(line[2], "base64")).digest("base64").replace(/=+$/, "")}`;
}

/** The `COPY-RESULT {json}` line copy-db.sh ends with. */
export function parseResult(stdout) {
  const line = String(stdout)
    .split(/\r?\n/)
    .find((l) => l.startsWith("COPY-RESULT "));
  if (!line) throw new Error("copy-db.sh printed no result line");
  return JSON.parse(line.slice("COPY-RESULT ".length));
}

/** A value for a line `export NAME='value'` of the shell preamble: refused if it could break out. */
export function shellValue(v) {
  const s = String(v);
  if (/['\r\n\0]/.test(s)) throw new Error("a setting for copy-db.sh holds a quote or a line break");
  return `'${s}'`;
}
export function preamble(vars) {
  return Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => {
      if (!/^[A-Z][A-Z0-9_]*(_[a-z][a-z0-9]*)?$/.test(k)) throw new Error(`not a setting name: ${k}`);
      return `export ${k}=${shellValue(v)}`;
    })
    .join("\n");
}

/**
 * What Systems Manager runs on AWS's admin host: the database owner's login read from its secret
 * there (it never leaves AWS, and the command's text, which Systems Manager keeps, holds only the
 * secret's ARN), copy-db.sh written to a file, then `dump`.
 */
export function adminHostScript({ settings, dbSecretArn, copyScript }) {
  if (!/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(dbSecretArn)) throw new Error("not a Secrets Manager ARN");
  if (/^COPYDB$/m.test(copyScript)) throw new Error("copy-db.sh holds the heredoc's end marker");
  return `set -euo pipefail
${preamble(settings)}
command -v pg_dump >/dev/null || dnf install -y -q postgresql17 jq >/dev/null 2>&1
# pg_dump refuses a server newer than itself: RDS runs 17.
[ "$(pg_dump --version | grep -oE '[0-9]+' | head -1)" -ge 17 ] || { echo "pg_dump 17 or newer is needed on the admin host" >&2; exit 1; }
S=$(aws secretsmanager get-secret-value --secret-id '${dbSecretArn}' --query SecretString --output text)
export PGHOST=$(echo "$S" | jq -r .host) PGPORT=$(echo "$S" | jq -r .port) PGUSER=$(echo "$S" | jq -r .username) PGPASSWORD=$(echo "$S" | jq -r .password) PGSSLMODE=require
unset S
cat > /var/tmp/copy-db.sh <<'COPYDB'
${copyScript.replace(/\r\n/g, "\n").replace(/\n?$/, "\n")}COPYDB
trap 'rm -f /var/tmp/copy-db.sh' EXIT
bash /var/tmp/copy-db.sh dump
`;
}

/**
 * The copy's proof: every table's row count the same on both sides, the same tables with
 * row-level security, the same policies. After the migrations (cutover), `afterMigrate` lets the
 * migrations' ledger grow and new tables appear, and leaves the security comparison to the first.
 */
export function compareFacts(source, target, { afterMigrate = false } = {}) {
  const lines = [];
  let mismatches = 0;
  for (const [table, rows] of Object.entries(source.counts)) {
    const got = target.counts[table];
    const ok = afterMigrate && table.endsWith("._prisma_migrations") ? got >= rows : got === rows;
    if (!ok) mismatches++;
    lines.push(`${ok ? "ok  " : "DIFF"} ${table.padEnd(42)} ${String(rows).padStart(10)} ${String(got ?? "missing").padStart(10)}`);
  }
  for (const table of Object.keys(target.counts).filter((t) => !(t in source.counts))) {
    if (!afterMigrate) mismatches++;
    lines.push(`${afterMigrate ? "new " : "DIFF"} ${table.padEnd(42)} ${"-".padStart(10)} ${String(target.counts[table]).padStart(10)}`);
  }
  if (!afterMigrate) {
    const rls = JSON.stringify(source.rls) === JSON.stringify(target.rls);
    const policies = source.policies === target.policies && source.policies_md5 === target.policies_md5;
    if (!rls) mismatches++;
    if (!policies) mismatches++;
    lines.push(`${rls ? "ok  " : "DIFF"} row-level security on ${source.rls.length} tables (${target.rls.length} restored)`);
    lines.push(`${policies ? "ok  " : "DIFF"} ${source.policies} policies, md5 ${source.policies_md5} (${target.policies}, ${target.policies_md5})`);
  }
  return { ok: mismatches === 0, mismatches, lines };
}

/** Queues that must be empty before the cutover's copy: all but the SMS events (read after) and the dead letters. */
export function queuesToDrain(urls) {
  return urls.filter((u) => !/(smsEvents|-dlq)$/.test(u));
}

/** `docker compose ps --format json`: one object per line (Compose 2.21+) or one array. */
export function composeServices(stdout) {
  const text = String(stdout).trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  return text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
