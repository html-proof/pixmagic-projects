// The parts of copy-db.mjs and copy-db-back.mjs that touch nothing (their tests: copy-db-lib.test.mjs).
import { createHash, createHmac } from "node:crypto";

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
 * secret's ARN), copy-db.sh written to a file, then `command`: dump (copy-db.mjs), restore or facts
 * (copy-db-back.mjs). No setting may be a link: Systems Manager keeps the command's text.
 */
export function adminHostScript({ settings, dbSecretArn, copyScript, command = "dump" }) {
  if (!/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(dbSecretArn)) throw new Error("not a Secrets Manager ARN");
  if (/^COPYDB$/m.test(copyScript)) throw new Error("copy-db.sh holds the heredoc's end marker");
  if (!["dump", "restore", "facts"].includes(command)) throw new Error(`copy-db.sh has no command ${command}`);
  if (Object.values(settings).some((v) => /^https?:/i.test(String(v)))) throw new Error("a link in the admin host's settings would stay in Systems Manager's command history");
  return `set -euo pipefail
${preamble(settings)}
# Amazon Linux 2023 holds /tmp in memory (half of this host's 0.5 GB): the dumps go to its disk.
export TMPDIR_COPY=/var/tmp
command -v pg_dump >/dev/null || dnf install -y -q postgresql17 jq >/dev/null 2>&1
# pg_dump refuses a server newer than itself, pg_restore an archive newer than itself: 17 on both sides.
[ "$(pg_dump --version | grep -oE '[0-9]+' | head -1)" -ge 17 ] || { echo "pg_dump 17 or newer is needed on the admin host" >&2; exit 1; }
S=$(aws secretsmanager get-secret-value --secret-id '${dbSecretArn}' --query SecretString --output text)
export PGHOST=$(echo "$S" | jq -r .host) PGPORT=$(echo "$S" | jq -r .port) PGUSER=$(echo "$S" | jq -r .username) PGPASSWORD=$(echo "$S" | jq -r .password) PGSSLMODE=require
unset S
cat > /var/tmp/copy-db.sh <<'COPYDB'
${copyScript.replace(/\r\n/g, "\n").replace(/\n?$/, "\n")}COPYDB
trap 'rm -f /var/tmp/copy-db.sh' EXIT
bash /var/tmp/copy-db.sh ${command}
`;
}

/** S3's encoding for a SigV4 query (RFC 3986: all but A-Z a-z 0-9 - _ . ~ escaped). */
const s3Encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * A presigned S3 link (Signature Version 4 in the query, the payload unsigned): what `aws s3
 * presign` makes for GET, and for PUT, which the CLI can't. The reverse copy's dumps go from the
 * server straight into the bucket with one, so the data never passes through the PC. Good for one
 * method on one key until `expires` seconds pass or the credentials it was signed with expire.
 */
export function presignS3({ method, bucket, key, region, credentials, now = new Date(), expires = 3600, host }) {
  if (!["GET", "PUT"].includes(method)) throw new Error("GET or PUT");
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) throw new Error("no AWS credentials to sign with");
  if (!Number.isInteger(expires) || expires < 1 || expires > 604_800) throw new Error("a presigned link lasts 1 s to 7 days");
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const h = host ?? `${bucket}.s3.${region}.amazonaws.com`;
  const path = `/${key.split("/").map(s3Encode).join("/")}`;
  const scope = `${day}/${region}/s3/aws4_request`;
  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
    ...(credentials.sessionToken ? { "X-Amz-Security-Token": credentials.sessionToken } : {}),
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${s3Encode(k)}=${s3Encode(params[k])}`)
    .join("&");
  const canonical = [method, path, query, `host:${h}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const hmac = (k, v) => createHmac("sha256", k).update(v).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), "s3"), "aws4_request");
  return `https://${h}${path}?${query}&X-Amz-Signature=${createHmac("sha256", signingKey).update(toSign).digest("hex")}`;
}

/** `aws configure export-credentials --format process`: the signed-in session's keys. */
export function exportedCredentials(stdout) {
  const c = JSON.parse(String(stdout));
  if (!c?.AccessKeyId || !c?.SecretAccessKey) throw new Error("the AWS CLI gave no credentials (aws login first)");
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
}

/**
 * AWS's WhatsApp services (`aws ecs describe-services`) with a task running, starting or wanted.
 * Two Evolution services on one WhatsApp session push each other off it, and AWS's keeps writing
 * its `evolution` database: neither copy may run while AWS's does.
 */
export function liveServices(described) {
  return (described?.services ?? [])
    .filter((s) => s.status !== "INACTIVE" && (s.runningCount > 0 || s.pendingCount > 0 || s.desiredCount > 0))
    .map((s) => ({ name: s.serviceName, running: s.runningCount, desired: s.desiredCount }));
}

/** psql -A -t of `SELECT queue, count(*) FROM job_queue GROUP BY 1`, as { queue: jobs }. */
export function queueCounts(stdout) {
  return Object.fromEntries(
    String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [queue, n] = l.split("|");
        if (!queue || !/^\d+$/.test(n ?? "")) throw new Error(`not a queue count: ${l}`);
        return [queue, Number(n)];
      }),
  );
}

/** A manual RDS snapshot's name: lowercase letters, digits and single hyphens, a letter first. */
export function snapshotName(instance, stamp) {
  const name = `${instance}-before-rollback-${stamp}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  if (!/^[a-z][a-z0-9-]{0,254}$/.test(name) || name.endsWith("-")) throw new Error(`not a snapshot name: ${name}`);
  return name;
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

/** Queues that must be empty before the cutover's copy: all but the dead letters. */
export function queuesToDrain(urls) {
  return urls.filter((u) => !/-dlq$/.test(u));
}

/** `docker compose ps --format json`: one object per line (Compose 2.21+) or one array. */
export function composeServices(stdout) {
  const text = String(stdout).trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  return text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
