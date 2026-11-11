// The way back (ROLLBACK_PLAN.md, "D/E, after writes on iKorex"): the iKorex server's databases
// copied into RDS and proved whole, so AWS can take over again with every write made on the server.
// copy-db.mjs's mirror image (docs/ikorex-migration/DATABASE_MIGRATION_REPORT.md). Run on the owner's
// PC, signed in to AWS (`aws login`), with the SSH key for the server.
//
//   node infra/ikorex/scripts/copy-db-back.mjs --rehearsal            # before the cutover, timed: the staging
//        project's kept copy (copy-db.mjs --rehearsal --keep) into throwaway databases on RDS, then dropped
//   node infra/ikorex/scripts/copy-db-back.mjs --rollback --replace   # in the rollback window: the server's
//        app and evolution replace RDS's
//     [--ssh deployer@103.146.112.176] [--project ...] [--identity <key file>] [--source-app <db>] [--source-evolution <db>]
//
//  1. Checks: the pinned host key; the server's postgres healthy and the source databases there; RDS
//     available. Rollback: the server's schedules off (SCHEDULES=off, so nothing new is queued), AWS's
//     WhatsApp service with no task (it holds RDS's `evolution`), and a manual snapshot of RDS started
//     (RDS's data as it was, kept until stage F).
//  2. Rollback: the server frozen: web stopped (Shopify and the other senders retry their webhooks,
//     and reach AWS once DNS is back), its queue drained by the worker (up to 10 minutes), then worker
//     and evolution stopped. If anything after this fails, they are started again: the server, which
//     DNS still points at, carries on as before.
//  3. copy-db.sh dump in the server's postgres container: one snapshot per database, counts read in
//     it, uploaded straight to the artifacts bucket (db-export/<time>-back/) with presigned links made
//     here and given on stdin (never a command line). The data never passes through the PC.
//  4. AWS's admin host: copy-db.sh restore from the bucket (its own role reads it), with RDS's free
//     storage from CloudWatch for the disk check; every count, the row-level security and the
//     policies compared. Rollback: the cron function's `migrate` (init.sql's grants, which a restore
//     without privileges leaves out), then the counts again.
//  5. The dumps deleted from the bucket, every version; a report (counts only) in ~/insights-backups.
//     Exits 1 when anything differs. What is left to do (DNS, AWS's schedules and WhatsApp) is printed.
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { adminHostScript, compareFacts, composeServices, exportedCredentials, liveServices, parseResult, PINNED_FINGERPRINT, PINNED_HOST, preamble, presignS3, queueCounts, snapshotName } from "./copy-db-lib.mjs";
import { adminHost, awsCli, copyScript as readCopyScript, option, removeExport, runReport, server, sh, sleep, stackResource, step, timeStamp } from "./copy-db-run.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => option(args, name, fallback);
const rollback = args.includes("--rollback");
if (rollback === args.includes("--rehearsal")) {
  console.error("usage: copy-db-back.mjs --rehearsal | --rollback --replace  (the comment at the top)");
  process.exit(2);
}
if (rollback && !args.includes("--replace")) {
  console.error("--rollback replaces RDS's app and evolution with the server's: say so with --replace (a snapshot of RDS is taken first)");
  process.exit(2);
}
const sshTarget = opt("--ssh", `deployer@${PINNED_HOST}`);
const project = opt("--project", rollback ? "bizinsights" : "bizinsights-staging");
if (!/^bizinsights(-staging)?$/.test(project)) throw new Error("--project must be bizinsights or bizinsights-staging");
const identity = opt("--identity", join(homedir(), ".ssh", "id_ed25519"));
const region = opt("--region", "ap-southeast-2");
const envName = opt("--env", "production");
const prefix = `insights-${envName}`;
const stamp = timeStamp();
const KEYS = ["app", "evolution"];
const sources = { app: opt("--source-app", rollback ? "app" : "app_copy_test"), evolution: opt("--source-evolution", rollback ? "evolution" : "evolution_copy_test") };
const targets = rollback ? { app: "app", evolution: "evolution" } : { app: "app_copy_test", evolution: "evolution_copy_test" };
for (const db of Object.values(sources)) if (!/^[a-z_][a-z0-9_]{0,62}$/.test(db)) throw new Error(`not a database name: ${db}`);

const aws = awsCli(region);
const { remote, compose } = server({ sshTarget, identity, project });
const copyScript = readCopyScript();
const report = { stamp, mode: rollback ? "rollback" : "rehearsal", project, sources, targets, steps: {} };
const { file: reportFile, save, timed } = runReport("ikorex-copy-back", report);
// The image's superuser is `app` (POSTGRES_USER), over the container's own socket, as copy-db.sh signs in.
const psql = (db, sql) => remote(compose(`exec -T -u postgres postgres psql -X -q -A -t -v ON_ERROR_STOP=1 -h /var/run/postgresql -U app -d ${db}`), sql).replace(/\r/g, "").trim();

// ---------------------------------------------------------------------------------------------
step("Checks");
const account = aws(["sts", "get-caller-identity"]).Account;
console.log(`AWS account ${account}; server ${sshTarget}, host key ${PINNED_FINGERPRINT}; project ${project}`);
const pgService = composeServices(remote(compose("ps --format json postgres")));
if (pgService[0]?.Health !== "healthy") throw new Error(`The server's postgres (${project}) isn't healthy: ${JSON.stringify(pgService.map((s) => [s.Service, s.State, s.Health]))}`);
const present = psql("postgres", `SELECT datname FROM pg_database WHERE datname IN ('${sources.app}', '${sources.evolution}')`).split("\n").filter(Boolean);
const missing = Object.values(sources).filter((db) => !present.includes(db));
if (missing.length) throw new Error(`Not on the server (${project}): ${missing.join(", ")}.${rollback ? "" : " A rehearsal copies back the forward one's copy: node infra/ikorex/scripts/copy-db.mjs --rehearsal --keep first."}`);
console.log(`server postgres healthy; ${Object.values(sources).join(" and ")} there`);
const rds = aws(["rds", "describe-db-instances", "--db-instance-identifier", prefix]).DBInstances[0];
if (rds.DBInstanceStatus !== "available") throw new Error(`RDS ${prefix} is ${rds.DBInstanceStatus}, not available`);
console.log(`RDS ${prefix}: available, PostgreSQL ${rds.EngineVersion}`);

let snapshot;
if (rollback) {
  const schedules = remote(`${compose("exec -T worker printenv SCHEDULES")} || true`).trim();
  if (schedules === "on") {
    throw new Error(`The server's schedules are on: they would queue work after the copy that AWS never sees. First: cd ~/${project} && sed -i 's/^SCHEDULES=.*/SCHEDULES=off/' .env && docker compose -p ${project} up -d worker`);
  }
  const whatsapp = awsWhatsapp();
  if (whatsapp.length) throw new Error(`AWS's WhatsApp service has a task (${whatsapp.map((s) => s.name).join(", ")}): it holds RDS's evolution database. It stays off (AWS_WHATSAPP=off) until this copy is checked.`);
  console.log("server schedules off; AWS's WhatsApp service: no task");
  snapshot = snapshotName(prefix, stamp);
  aws(["rds", "create-db-snapshot", "--db-instance-identifier", prefix, "--db-snapshot-identifier", snapshot]);
  report.snapshot = snapshot;
  console.log(`RDS snapshot ${snapshot} started (RDS as it was before this copy; stage F deletes it)`);
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
const exportPrefix = `db-export/${stamp}-back/`;
const objectKey = (key) => `${exportPrefix}${key}.dump`;
const host = adminHost(aws, stackResource(aws, dataStack, "AdminHost", "AWS::EC2::Instance"));

let frozen = false;
let done = false;
let mismatches = 0;
try {
  if (rollback) {
    step("Freezing the server: web stopped, its queue drained, then worker and evolution stopped");
    frozen = true;
    remote(compose("stop web"));
    const queued = () => queueCounts(psql(sources.app, "SELECT queue, count(*) FROM job_queue GROUP BY queue ORDER BY queue"));
    let left = queued();
    for (let i = 0; Object.keys(left).length && i < 60; i++) {
      console.log(`queued on the server: ${JSON.stringify(left)}`);
      await sleep(10_000);
      left = queued();
    }
    if (Object.keys(left).length) throw new Error(`The server's queue did not drain in 10 minutes: ${JSON.stringify(left)}. AWS's queues are its own (SQS): these jobs would be lost.`);
    remote(compose("stop worker evolution"));
    left = queued();
    if (Object.keys(left).length) throw new Error(`Jobs queued while the worker stopped: ${JSON.stringify(left)}`);
    console.log("server frozen, its queue empty");
  }

  step(`Dumping on the server (${project}: ${sources.app}, ${sources.evolution}), straight into the bucket`);
  // The signed-in session's keys sign two upload links here; only the links go to the server.
  const credentials = exportedCredentials(sh("aws", ["configure", "export-credentials", "--format", "process"]));
  const put = (key) => presignS3({ method: "PUT", bucket, key: objectKey(key), region, credentials, expires: 3600 });
  const dumpSettings = preamble({ PGHOST: "/var/run/postgresql", PGUSER: "app", PGDATABASE: "postgres", DBS: KEYS.join(" "), DB_app: sources.app, DEST_app: put("app"), DB_evolution: sources.evolution, DEST_evolution: put("evolution") });
  const dumped = await timed("dump", async () => parseResult(remote(compose("exec -T -u postgres postgres bash -s -- dump"), `${dumpSettings}\n${copyScript}`)));
  for (const key of KEYS) {
    const d = dumped[key];
    const head = aws(["s3api", "head-object", "--bucket", bucket, "--key", objectKey(key)]);
    if (head.ContentLength !== d.bytes) throw new Error(`${key}: the bucket holds ${head.ContentLength} bytes, the dump was ${d.bytes}`);
    report.steps[`dump.${key}`] = { bytes: d.bytes, sha256: d.sha256, seconds: d.seconds, server: d.server, tables: Object.keys(d.facts.counts).length, rows: Object.values(d.facts.counts).reduce((a, b) => a + b, 0) };
    console.log(`${key}: ${(d.bytes / 1024 / 1024).toFixed(1)} MB, ${report.steps[`dump.${key}`].tables} tables, ${report.steps[`dump.${key}`].rows} rows, PostgreSQL ${d.server}, ${d.seconds} s; in the bucket`);
  }
  report.source = Object.fromEntries(KEYS.map((k) => [k, dumped[k].facts]));
  save();

  if (snapshot) {
    step(`Waiting for the RDS snapshot ${snapshot}`);
    await timed("snapshot", async () => aws(["rds", "wait", "db-snapshot-available", "--db-snapshot-identifier", snapshot]));
    console.log("snapshot available");
  }

  // CloudWatch's last five minutes: the admin host can't see RDS's disk.
  const now = Date.now();
  const free = aws(["cloudwatch", "get-metric-statistics", "--namespace", "AWS/RDS", "--metric-name", "FreeStorageSpace", "--dimensions", `Name=DBInstanceIdentifier,Value=${prefix}`, "--start-time", new Date(now - 15 * 60_000).toISOString(), "--end-time", new Date(now).toISOString(), "--period", "300", "--statistics", "Minimum"]).Datapoints;
  const freeBytes = free.length ? Math.floor(Math.min(...free.map((d) => d.Minimum))) : undefined;
  console.log(`RDS free storage: ${freeBytes === undefined ? "unknown (no recent figure)" : `${(freeBytes / 1024 ** 3).toFixed(1)} GB`}`);

  step(`Restoring into RDS (${targets.app}, ${targets.evolution}) on AWS's admin host`);
  const dbSecret = aws(["secretsmanager", "describe-secret", "--secret-id", `insights/${envName}/db-owner`]).ARN;
  await host.start();
  try {
    const settings = {
      AWS_DEFAULT_REGION: region,
      PGDATABASE: "postgres",
      DBS: KEYS.join(" "),
      MODE: rollback ? "replace" : "fresh",
      DROP_AFTER: rollback ? "" : "1",
      FREE_BYTES: freeBytes,
      SOURCE_app: `s3://${bucket}/${objectKey("app")}`,
      SHA_app: dumped.app.sha256,
      BYTES_app: dumped.app.bytes,
      TARGET_app: targets.app,
      NEED_ROLES_app: "app_rls app_system",
      SOURCE_evolution: `s3://${bucket}/${objectKey("evolution")}`,
      SHA_evolution: dumped.evolution.sha256,
      BYTES_evolution: dumped.evolution.bytes,
      TARGET_evolution: targets.evolution,
      // RDS's master is a member of `evolution` (apps/aws/src/evolutionDb.ts), so its tables stay the service's.
      ROLE_evolution: "evolution",
    };
    const restored = await timed("restore", async () => parseResult(await host.ssm(adminHostScript({ settings, dbSecretArn: dbSecret, copyScript, command: "restore" }), "bizinsights copy back from iKorex: restore")));

    step("Comparing with the server's snapshot");
    report.restored = {};
    for (const key of KEYS) {
      const r = restored[key];
      if (r.sha256 !== dumped[key].sha256) mismatches++;
      const cmp = compareFacts(dumped[key].facts, r.facts);
      mismatches += cmp.mismatches;
      report.restored[key] = { db: r.db, seconds: r.seconds, ok: cmp.ok };
      console.log(`\n${key} → ${r.db} (${r.seconds} s)\n${cmp.lines.join("\n")}`);
    }

    if (rollback && !mismatches) {
      step("Grants and the roles' passwords (the cron function's migrate), then the counts again");
      const out = join(homedir(), "insights-backups", `.lambda-${stamp}.json`);
      const meta = aws(["lambda", "invoke", "--function-name", `${prefix}-cron:live`, "--cli-binary-format", "raw-in-base64-out", "--cli-read-timeout", "0", "--payload", JSON.stringify({ action: "migrate" }), out]);
      const body = readFileSync(out, "utf8");
      rmSync(out, { force: true });
      if (meta.FunctionError) throw new Error(`migrate failed: ${body}`);
      console.log(body.trim());
      const facts = { AWS_DEFAULT_REGION: region, PGDATABASE: "postgres", DBS: KEYS.join(" "), TARGET_app: targets.app, TARGET_evolution: targets.evolution };
      const after = parseResult(await host.ssm(adminHostScript({ settings: facts, dbSecretArn: dbSecret, copyScript, command: "facts" }), "bizinsights copy back from iKorex: facts"));
      for (const key of KEYS) {
        const cmp = compareFacts(dumped[key].facts, after[key].facts, { afterMigrate: true });
        mismatches += cmp.mismatches;
        report.restored[key].afterMigrate = cmp.ok;
        console.log(`\n${key} after migrate\n${cmp.lines.filter((l) => !l.startsWith("ok  ")).join("\n") || "every table as copied"}`);
      }
    }
  } finally {
    host.stop();
  }
  done = !mismatches;
} finally {
  step("Removing the dumps from the bucket");
  try {
    removeExport(aws, bucket, exportPrefix);
  } catch (err) {
    console.error(`Could not delete s3://${bucket}/${exportPrefix} (${err.message}); the bucket deletes it after a day.`);
  }
  if (frozen && !done) {
    // DNS still points at the server: it carries on as before. RDS stays as it was or as copied, unused.
    step("The copy back did not finish: starting the server's web, worker and evolution again");
    try {
      remote(compose("start web worker evolution"));
      console.log(`started. The server's schedules are still off: cd ~/${project} && sed -i 's/^SCHEDULES=.*/SCHEDULES=on/' .env && docker compose -p ${project} up -d worker`);
    } catch (err) {
      console.error(`Could not start them (${err.message}): on the server, cd ~/${project} && docker compose -p ${project} start web worker evolution`);
    }
  }
  report.mismatches = mismatches;
  save();
  console.log(`report ${reportFile}`);
}

if (mismatches) {
  console.log(`\n${mismatches} difference(s): RDS is not the server's snapshot.${rollback ? " AWS stays off; the server is running again (above)." : ""}`);
  process.exit(1);
}
if (rollback) {
  console.log(`
RDS now holds the server's data, table by table, and the server is stopped. To finish the rollback (ROLLBACK_PLAN.md):
  1. Cloudflare: bizinsights.io and www back to CloudFront (proxied).
  2. GitHub variables AWS_SCHEDULES and AWS_WHATSAPP back to on (or unset), then run Deploy to AWS; meanwhile, for WhatsApp at once:
     aws ecs update-service --cluster ${prefix}-whatsapp --service <name> --desired-count 1
  3. Smoke tests (node infra/cdk/scripts/smoke.mjs --env production); sign in; WhatsApp numbers connected.
  RDS as it was before: snapshot ${snapshot}.`);
} else {
  console.log("\nThe copy back matches the server's snapshot table by table; the throwaway databases on RDS are gone. Times are in the report.");
}
