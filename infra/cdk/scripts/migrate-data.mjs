#!/usr/bin/env node
// Copy the production database from the Postgres container on the owner's PC to RDS, and prove
// the copy is whole (exact row counts per table, both sides).
//
//   node infra/cdk/scripts/migrate-data.mjs [--env production] [--container saas-project20-postgres-1] [--replace]
//
// Steps: back up (pg_dump, kept locally and in S3) → upload → restore on the admin host through
// Systems Manager (the database has no public address) → the cron function's migrate action
// (migrations newer than the dump, app_rls grants and password) → compare counts → stop the host.
//
// The source is only read. The target must be empty: it refuses to restore over existing tables
// unless --replace is given, which wipes the AWS copy first (for the final copy at cutover, when
// the PC is still the source of truth). Nothing is printed from the data itself.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const envName = opt("--env", "production");
const region = opt("--region", "ap-southeast-2");
const container = opt("--container", "saas-project20-postgres-1");
const replace = args.includes("--replace");
const prefix = `insights-${envName}`;

const sh = (cmd, cmdArgs, input) => execFileSync(cmd, cmdArgs, { encoding: "utf8", input, maxBuffer: 1024 * 1024 * 512, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
const aws = (cliArgs) => JSON.parse(sh("aws", [...cliArgs, "--region", region, "--output", "json"]) || "null");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`\n== ${msg}`);

/** One JSON object {table: rows} for every table in public: the same query on both sides. */
const COUNTS_SQL =
  "select coalesce(json_object_agg(table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::bigint order by table_name), '{}') from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'";

const resource = (stackName, logicalPrefix, type) => {
  const all = aws(["cloudformation", "list-stack-resources", "--stack-name", stackName]).StackResourceSummaries;
  const hit = all.find((r) => r.ResourceType === type && r.LogicalResourceId.startsWith(logicalPrefix));
  if (!hit) throw new Error(`No ${type} ${logicalPrefix}* in ${stackName}`);
  return hit.PhysicalResourceId;
};

// ---------------------------------------------------------------------------------------------
step("Backing up the source database (read only)");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
const backups = join(homedir(), "insights-backups");
mkdirSync(backups, { recursive: true });
// A custom-format dump too, as the restorable backup of record (same as infra/postgres/backup.mjs).
const custom = join(backups, `app-pre-aws-${stamp}.dump`);
writeFileSync(custom, execFileSync("docker", ["exec", container, "pg_dump", "-U", "app", "-d", "app", "--format=custom"], { maxBuffer: 1024 * 1024 * 512 }));
// Plain SQL for the restore: any psql version can load it, and it carries no owners or grants.
const plain = execFileSync("docker", ["exec", container, "pg_dump", "-U", "app", "-d", "app", "--no-owner", "--no-privileges", "--format=plain"], { maxBuffer: 1024 * 1024 * 512 });
const sourceCounts = JSON.parse(sh("docker", ["exec", "-i", container, "psql", "-U", "app", "-d", "app", "-At", "-c", COUNTS_SQL]).trim());
const gz = join(backups, `app-pre-aws-${stamp}.sql.gz`);
writeFileSync(gz, gzipSync(plain));
console.log(`backup ${custom} (${(statSync(custom).size / 1024 / 1024).toFixed(1)} MB), restore file ${(statSync(gz).size / 1024 / 1024).toFixed(1)} MB, ${Object.keys(sourceCounts).length} tables, ${Object.values(sourceCounts).reduce((a, b) => a + b, 0)} rows`);

// ---------------------------------------------------------------------------------------------
step("Uploading to the artifacts bucket");
const dataStack = `InsightsData-${envName}`;
const bucket = resource(dataStack, "Artifacts", "AWS::S3::Bucket");
const key = `db/app-pre-aws-${stamp}.sql.gz`;
sh("aws", ["s3", "cp", gz, `s3://${bucket}/${key}`, "--region", region, "--only-show-errors"]);
console.log(`s3://${bucket}/${key}`);

// ---------------------------------------------------------------------------------------------
step("Starting the admin host");
const instanceId = resource(dataStack, "AdminHost", "AWS::EC2::Instance");
const dbSecret = aws(["secretsmanager", "describe-secret", "--secret-id", `insights/${envName}/db-owner`]).ARN;
aws(["ec2", "start-instances", "--instance-ids", instanceId]);
for (let i = 0; ; i++) {
  const info = aws(["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceId}`]).InstanceInformationList;
  if (info[0]?.PingStatus === "Online") break;
  if (i > 60) throw new Error("The admin host did not come online in Systems Manager within 10 minutes");
  await sleep(10_000);
}
console.log(`${instanceId} online`);

async function run(script, label) {
  const cmd = aws(["ssm", "send-command", "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript", "--comment", label, "--timeout-seconds", "1800", "--parameters", JSON.stringify({ commands: [script], executionTimeout: ["1800"] })]).Command;
  for (;;) {
    await sleep(5_000);
    let inv;
    try {
      inv = aws(["ssm", "get-command-invocation", "--command-id", cmd.CommandId, "--instance-id", instanceId]);
    } catch {
      continue; // not registered yet
    }
    if (["Pending", "InProgress", "Delayed"].includes(inv.Status)) continue;
    if (inv.Status !== "Success") throw new Error(`${label} failed (${inv.Status}):\n${inv.StandardErrorContent}\n${inv.StandardOutputContent}`);
    return inv.StandardOutputContent;
  }
}

// ---------------------------------------------------------------------------------------------
step(replace ? "Restoring (replacing the AWS copy)" : "Restoring into the empty database");
const restore = `set -euo pipefail
export AWS_DEFAULT_REGION=${region}
command -v psql >/dev/null || dnf install -y -q postgresql17 jq || dnf install -y -q postgresql16 jq
S=$(aws secretsmanager get-secret-value --secret-id '${dbSecret}' --query SecretString --output text)
export PGHOST=$(echo "$S" | jq -r .host) PGPORT=$(echo "$S" | jq -r .port) PGUSER=$(echo "$S" | jq -r .username) PGPASSWORD=$(echo "$S" | jq -r .password) PGDATABASE=app PGSSLMODE=require
N=$(psql -Atc "select count(*) from pg_tables where schemaname = 'public'")
if [ "$N" != "0" ]; then
  if [ "${replace ? "1" : "0"}" != "1" ]; then echo "REFUSING: the AWS database already has $N tables (run with --replace to wipe the AWS copy)" >&2; exit 3; fi
  psql -v ON_ERROR_STOP=1 -q -c "drop schema public cascade" -c "create schema public" -c "grant usage, create on schema public to public"
fi
aws s3 cp 's3://${bucket}/${key}' /tmp/restore.sql.gz --only-show-errors
gunzip -c /tmp/restore.sql.gz | psql -v ON_ERROR_STOP=1 --single-transaction -q -o /dev/null
rm -f /tmp/restore.sql.gz
psql -Atc "${COUNTS_SQL.replace(/"/g, '\\"')}"
`;
const restored = JSON.parse((await run(restore, "insights restore")).trim().split("\n").pop());

// ---------------------------------------------------------------------------------------------
step("Applying newer migrations, tenant role grants and password (cron function: migrate)");
const fnName = `${prefix}-cron:live`;
const invoke = (payload) => {
  const out = join(backups, `.lambda-${stamp}.json`);
  const meta = aws(["lambda", "invoke", "--function-name", fnName, "--cli-binary-format", "raw-in-base64-out", "--payload", JSON.stringify(payload), out]);
  const body = readFileSync(out, "utf8");
  if (meta.FunctionError) throw new Error(`${payload.action} failed: ${body}`);
  return JSON.parse(body);
};
console.log(JSON.stringify(invoke({ action: "migrate" })));
const after = invoke({ action: "counts" });

// ---------------------------------------------------------------------------------------------
step("Comparing row counts");
let mismatches = 0;
for (const [table, rows] of Object.entries(sourceCounts)) {
  const got = after[table];
  const ok = got === rows && restored[table] === rows;
  if (!ok) mismatches++;
  console.log(`${ok ? "ok  " : "DIFF"} ${table.padEnd(34)} source ${String(rows).padStart(8)}  aws ${String(got ?? "missing").padStart(8)}`);
}
for (const table of Object.keys(after).filter((t) => !(t in sourceCounts))) console.log(`new  ${table.padEnd(34)} aws ${after[table]} (created by a newer migration)`);

step("Stopping the admin host");
aws(["ec2", "stop-instances", "--instance-ids", instanceId]);
console.log(mismatches ? `\n${mismatches} table(s) differ: do not use this copy.` : `\nAll ${Object.keys(sourceCounts).length} tables match.`);
process.exit(mismatches ? 1 : 0);
