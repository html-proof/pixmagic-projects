// Copy production's databases from RDS to the iKorex server and prove the copy whole
// (docs/ikorex-migration/DATABASE_MIGRATION_REPORT.md). Run on the owner's PC, signed in to AWS
// (`aws login`), with the SSH key for the server (ssh-agent, or its passphrase typed at each prompt).
// The way back, for a rollback: copy-db-back.mjs.
//
//   node infra/ikorex/scripts/copy-db.mjs --rehearsal            # stage B: into throwaway databases, then dropped
//   node infra/ikorex/scripts/copy-db.mjs --cutover [--replace]  # stage D, in the window: into app and evolution
//     [--ssh deployer@103.146.112.176] [--project bizinsights-staging|bizinsights] [--keep] [--identity <key file>]
//
//  1. Checks: the server's host key is the pinned one (infra/ikorex/known_hosts, the guide's
//     fingerprint); its postgres is healthy; at cutover, AWS's queues are empty (step 2 of the
//     cutover: schedules off, webhooks answered 503, the queues drained) and AWS's WhatsApp service
//     has no task (AWS_WHATSAPP=off: it would keep writing its database, and fight the server's for
//     every linked number).
//  2. AWS's admin host starts; copy-db.sh dump there reads one snapshot of `app` and of `evolution`
//     (every table's row count, the row-level security and the policies, inside the same snapshot)
//     into the artifacts bucket (db-export/<time>/, deleted by the bucket after a day if not here);
//     the host stops again.
//  3. copy-db.sh restore in the server's postgres container, from links that work for an hour, given
//     on stdin (never a command line). The checksums are checked before any database changes.
//  4. Every count, the row-level security and the policies compared with the snapshot's.
//  5. Cutover only: web, worker and evolution stopped first (not live yet: DNS still points at AWS);
//     after the restore, the admin `migrate` (newer migrations, grants, the server's passwords) and
//     the counts again.
//  6. The dumps deleted from the bucket, every version; a report (counts only, no data) in
//     ~/insights-backups. Exits 1 when anything differs.
import { homedir } from "node:os";
import { join } from "node:path";
import { adminHostScript, compareFacts, composeServices, liveServices, parseResult, PINNED_FINGERPRINT, PINNED_HOST, preamble, queuesToDrain } from "./copy-db-lib.mjs";
import { adminHost, awsCli, copyScript as readCopyScript, option, removeExport, runReport, server, sh, stackResource, step, timeStamp } from "./copy-db-run.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => option(args, name, fallback);
const cutover = args.includes("--cutover");
if (cutover === args.includes("--rehearsal")) {
  console.error("usage: copy-db.mjs --rehearsal | --cutover [--replace]  (the comment at the top)");
  process.exit(2);
}
const sshTarget = opt("--ssh", `deployer@${PINNED_HOST}`);
const project = opt("--project", cutover ? "bizinsights" : "bizinsights-staging");
if (!/^bizinsights(-staging)?$/.test(project)) throw new Error("--project must be bizinsights or bizinsights-staging");
const identity = opt("--identity", join(homedir(), ".ssh", "id_ed25519"));
const region = opt("--region", "ap-southeast-2");
const envName = opt("--env", "production");
const prefix = `insights-${envName}`;
const stamp = timeStamp();
const KEYS = ["app", "evolution"];

const aws = awsCli(region);
const { remote, compose } = server({ sshTarget, identity, project });
const copyScript = readCopyScript();

const report = { stamp, mode: cutover ? "cutover" : "rehearsal", project, steps: {} };
const { file: reportFile, save, timed } = runReport("ikorex-copy", report);

// ---------------------------------------------------------------------------------------------
step("Checks");
const account = aws(["sts", "get-caller-identity"]).Account;
console.log(`AWS account ${account}; server ${sshTarget}, host key ${PINNED_FINGERPRINT}; project ${project}`);
const services = composeServices(remote(compose("ps --format json postgres")));
if (services[0]?.Health !== "healthy") throw new Error(`The server's postgres (${project}) isn't healthy: ${JSON.stringify(services.map((s) => [s.Service, s.State, s.Health]))}`);
console.log("server postgres healthy");
if (cutover) {
  const urls = aws(["sqs", "list-queues", "--queue-name-prefix", `${prefix}-`])?.QueueUrls ?? [];
  const busy = [];
  for (const url of urls) {
    const a = aws(["sqs", "get-queue-attributes", "--queue-url", url, "--attribute-names", "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"]).Attributes;
    const n = Number(a.ApproximateNumberOfMessages) + Number(a.ApproximateNumberOfMessagesNotVisible) + Number(a.ApproximateNumberOfMessagesDelayed);
    const name = url.split("/").pop();
    console.log(`queue ${name.padEnd(40)} ${n}`);
    if (n > 0 && queuesToDrain([url]).length) busy.push(name);
  }
  if (busy.length) throw new Error(`Not empty: ${busy.join(", ")}. Cutover step 2 first (schedules off, webhooks 503, queues drained).`);
  const whatsapp = awsWhatsapp();
  if (whatsapp.length) {
    throw new Error(
      `AWS's WhatsApp service still runs (${whatsapp.map((s) => `${s.name}: ${s.running} running, ${s.desired} wanted`).join("; ")}). Cutover step 2 first: GitHub variable AWS_WHATSAPP=off, and at once \`aws ecs update-service --cluster ${prefix}-whatsapp --service <name> --desired-count 0\`, then wait for it to stop.`,
    );
  }
  console.log("AWS's WhatsApp service: no task");
}

/** AWS's Evolution services with a task running or wanted (none when the stack isn't there). */
function awsWhatsapp() {
  const cluster = `${prefix}-whatsapp`;
  let arns;
  try {
    arns = aws(["ecs", "list-services", "--cluster", cluster]).serviceArns ?? [];
  } catch (err) {
    if (/ClusterNotFoundException/.test(String(err.message))) return [];
    throw err;
  }
  return arns.length ? liveServices(aws(["ecs", "describe-services", "--cluster", cluster, "--services", ...arns])) : [];
}

// ---------------------------------------------------------------------------------------------
const dataStack = `InsightsData-${envName}`;
const bucket = stackResource(aws, dataStack, "Artifacts", "AWS::S3::Bucket");
const exportPrefix = `db-export/${stamp}/`;
const s3 = (key) => `s3://${bucket}/${exportPrefix}${key}.dump`;
const host = adminHost(aws, stackResource(aws, dataStack, "AdminHost", "AWS::EC2::Instance"));

let dumped;
let mismatches = 0;
try {
  step("Dumping on AWS's admin host (one snapshot per database)");
  const dbSecret = aws(["secretsmanager", "describe-secret", "--secret-id", `insights/${envName}/db-owner`]).ARN;
  await host.start();
  try {
    const settings = { AWS_DEFAULT_REGION: region, DBS: KEYS.join(" "), DB_app: "app", DEST_app: s3("app"), DB_evolution: "evolution", DEST_evolution: s3("evolution") };
    const script = adminHostScript({ settings, dbSecretArn: dbSecret, copyScript });
    dumped = await timed("dump", async () => parseResult(await host.ssm(script, "bizinsights copy to iKorex: dump")));
  } finally {
    host.stop();
  }
  for (const key of KEYS) {
    const d = dumped[key];
    report.steps[`dump.${key}`] = { bytes: d.bytes, sha256: d.sha256, seconds: d.seconds, server: d.server, tables: Object.keys(d.facts.counts).length, rows: Object.values(d.facts.counts).reduce((a, b) => a + b, 0) };
    console.log(`${key}: ${(d.bytes / 1024 / 1024).toFixed(1)} MB, ${report.steps[`dump.${key}`].tables} tables, ${report.steps[`dump.${key}`].rows} rows, PostgreSQL ${d.server}, ${d.seconds} s`);
  }
  report.source = Object.fromEntries(KEYS.map((k) => [k, dumped[k].facts]));
  save();

  if (cutover) {
    step("Stopping web, worker and evolution on the server (not live yet)");
    remote(compose("stop web worker evolution"));
  }

  step(`Restoring on the server (${project})`);
  const targets = cutover ? { app: "app", evolution: "evolution" } : { app: "app_copy_test", evolution: "evolution_copy_test" };
  const links = Object.fromEntries(KEYS.map((k) => [k, sh("aws", ["s3", "presign", s3(k), "--expires-in", "3600", "--region", region]).trim()]));
  const settings = preamble({
    PGHOST: "/var/run/postgresql",
    PGUSER: "app",
    PGDATABASE: "postgres",
    DBS: KEYS.join(" "),
    MODE: cutover ? (args.includes("--replace") ? "replace" : "empty") : "fresh",
    DROP_AFTER: !cutover && !args.includes("--keep") ? "1" : "",
    SOURCE_app: links.app,
    SHA_app: dumped.app.sha256,
    BYTES_app: dumped.app.bytes,
    TARGET_app: targets.app,
    NEED_ROLES_app: "app_rls app_system",
    SOURCE_evolution: links.evolution,
    SHA_evolution: dumped.evolution.sha256,
    BYTES_evolution: dumped.evolution.bytes,
    TARGET_evolution: targets.evolution,
    ROLE_evolution: cutover ? "evolution" : "",
  });
  const restored = await timed("restore", async () => parseResult(remote(compose("exec -T -u postgres postgres bash -s -- restore"), `${settings}\n${copyScript}`)));

  step("Comparing with the snapshot");
  report.restored = {};
  for (const key of KEYS) {
    const r = restored[key];
    if (r.sha256 !== dumped[key].sha256) mismatches++;
    const cmp = compareFacts(dumped[key].facts, r.facts);
    mismatches += cmp.mismatches;
    report.restored[key] = { db: r.db, seconds: r.seconds, ok: cmp.ok };
    console.log(`\n${key} → ${r.db} (${r.seconds} s)\n${cmp.lines.join("\n")}`);
  }

  if (cutover && !mismatches) {
    step("Migrations, grants and the server's passwords (admin migrate), then the counts again");
    console.log(remote(compose("--profile admin run --rm -T admin migrate")).trim());
    const after = parseResult(remote(compose("exec -T -u postgres postgres bash -s -- facts"), `${preamble({ PGHOST: "/var/run/postgresql", PGUSER: "app", DBS: KEYS.join(" "), TARGET_app: "app", TARGET_evolution: "evolution" })}\n${copyScript}`));
    for (const key of KEYS) {
      const cmp = compareFacts(dumped[key].facts, after[key].facts, { afterMigrate: true });
      mismatches += cmp.mismatches;
      report.restored[key].afterMigrate = cmp.ok;
      console.log(`\n${key} after migrate\n${cmp.lines.filter((l) => !l.startsWith("ok  ")).join("\n") || "every table as copied"}`);
    }
  }
} finally {
  step("Removing the dumps from the bucket");
  try {
    removeExport(aws, bucket, exportPrefix);
  } catch (err) {
    console.error(`Could not delete s3://${bucket}/${exportPrefix} (${err.message}); the bucket deletes it after a day.`);
  }
  report.mismatches = mismatches;
  save();
  console.log(`report ${reportFile}`);
}

if (mismatches) {
  console.log(`\n${mismatches} difference(s): this copy is not the snapshot. ${cutover ? "Do not go on with the cutover (ROLLBACK_PLAN.md)." : ""}`);
  process.exit(1);
}
console.log(`\nThe copy matches the snapshot table by table.${cutover ? " Next: cutover step 4 (start app, worker, evolution with production settings)." : " The throwaway databases are gone."}`);
