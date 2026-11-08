// node --test infra/ikorex/scripts/copy-db-lib.test.mjs (CI: the checks job)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { adminHostScript, compareFacts, composeServices, exportedCredentials, hostKeyFingerprint, liveServices, parseResult, PINNED_FINGERPRINT, PINNED_HOST, preamble, presignS3, queueCounts, queuesToDrain, snapshotName } from "./copy-db-lib.mjs";

test("the pinned host key in infra/ikorex/known_hosts is the one in the administrator's guide", () => {
  const knownHosts = readFileSync(new URL("../known_hosts", import.meta.url), "utf8");
  assert.equal(hostKeyFingerprint(knownHosts, PINNED_HOST), PINNED_FINGERPRINT);
  assert.equal(hostKeyFingerprint(knownHosts, "203.0.113.9"), null);
  // A key that isn't the guide's has another fingerprint.
  const other = knownHosts.replace(/AAAAC3NzaC1lZDI1NTE5AAAAI\S+/, "AAAAC3NzaC1lZDI1NTE5AAAAIGq0dxZ3fBDWfsUn0dUyuZbYKg8i0ZjV3Ng3Bf7PN0Ab");
  assert.notEqual(hostKeyFingerprint(other, PINNED_HOST), PINNED_FINGERPRINT);
});

test("reads the result line among other output", () => {
  assert.deepEqual(parseResult('dnf: nothing to do\r\nCOPY-RESULT {"app":{"db":"app"}}\n'), { app: { db: "app" } });
  assert.throws(() => parseResult("REFUSED: no snapshot"), /no result line/);
});

test("passes settings on stdin as quoted exports, and refuses one that could break out", () => {
  assert.equal(preamble({ DBS: "app evolution", SOURCE_app: "https://b.s3.amazonaws.com/k?X-Amz-Signature=ab%2F&x=1", ROLE_evolution: "", MODE: "fresh" }), "export DBS='app evolution'\nexport SOURCE_app='https://b.s3.amazonaws.com/k?X-Amz-Signature=ab%2F&x=1'\nexport MODE='fresh'");
  assert.throws(() => preamble({ TARGET_app: "app'; rm -rf / #" }), /quote or a line break/);
  assert.throws(() => preamble({ TARGET_app: "app\nexport X=1" }), /quote or a line break/);
  assert.throws(() => preamble({ "PATH;x": "1" }), /not a setting name/);
});

const facts = (counts, extra = {}) => ({ counts, rls: ["public.stores"], policies: 2, policies_md5: "aa", ...extra });

test("a copy is whole only when every count, the row-level security and the policies match", () => {
  const source = facts({ "public.stores": 3, "public._prisma_migrations": 120 });
  assert.equal(compareFacts(source, facts({ "public.stores": 3, "public._prisma_migrations": 120 })).ok, true);
  const short = compareFacts(source, facts({ "public.stores": 2, "public._prisma_migrations": 120 }));
  assert.equal(short.ok, false);
  assert.match(short.lines[0], /^DIFF public\.stores/);
  assert.equal(compareFacts(source, facts({ "public._prisma_migrations": 120 })).ok, false, "a table missing");
  assert.equal(compareFacts(source, facts({ "public.stores": 3, "public._prisma_migrations": 120, "public.extra": 0 })).ok, false, "a table too many");
  assert.equal(compareFacts(source, facts(source.counts, { rls: [] })).ok, false, "row-level security lost");
  assert.equal(compareFacts(source, facts(source.counts, { policies_md5: "bb" })).ok, false, "a policy changed");
});

test("after the migrations, the ledger may grow and new tables appear; nothing may shrink", () => {
  const source = facts({ "public.stores": 3, "public._prisma_migrations": 120 });
  const migrated = facts({ "public.stores": 3, "public._prisma_migrations": 122, "public.new_table": 0 }, { policies: 3 });
  assert.equal(compareFacts(source, migrated, { afterMigrate: true }).ok, true);
  assert.equal(compareFacts(source, facts({ "public.stores": 2, "public._prisma_migrations": 122 }), { afterMigrate: true }).ok, false);
  assert.equal(compareFacts(source, facts({ "public.stores": 3, "public._prisma_migrations": 119 }), { afterMigrate: true }).ok, false);
});

test("the admin host's script reads the login from its secret there and never carries a password", () => {
  const copyScript = readFileSync(new URL("./copy-db.sh", import.meta.url), "utf8");
  const arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:insights/production/db-owner-AbCdEf";
  const script = adminHostScript({ settings: { DBS: "app evolution", DEST_app: "s3://b/db-export/x/app.dump" }, dbSecretArn: arn, copyScript });
  assert.match(script, /^set -euo pipefail\nexport DBS='app evolution'\nexport DEST_app='s3:\/\/b\/db-export\/x\/app.dump'\n/);
  assert.ok(script.includes(`--secret-id '${arn}'`));
  assert.ok(script.includes("unset S\n"));
  assert.ok(script.includes(`<<'COPYDB'\n${copyScript.replace(/\r\n/g, "\n")}`), "copy-db.sh inside a quoted heredoc, unchanged");
  assert.match(script, /\nCOPYDB\ntrap 'rm -f \/var\/tmp\/copy-db.sh' EXIT\nbash \/var\/tmp\/copy-db.sh dump\n$/);
  assert.doesNotMatch(script, /PGPASSWORD=[^$]/);
  assert.throws(() => adminHostScript({ settings: {}, dbSecretArn: "x'; curl evil #", copyScript }), /not a Secrets Manager ARN/);
  assert.throws(() => adminHostScript({ settings: {}, dbSecretArn: arn, copyScript: "echo\nCOPYDB\nrm -rf /" }), /end marker/);
});

test("drains every queue but the SMS events and the dead letters", () => {
  const base = "https://sqs.ap-southeast-2.amazonaws.com/123456789012/insights-production-";
  assert.deepEqual(queuesToDrain([`${base}shopify`, `${base}smsEvents`, `${base}dlq`, `${base}email`]), [`${base}shopify`, `${base}email`]);
});

test("reads docker compose ps in both of its JSON shapes", () => {
  assert.deepEqual(composeServices('{"Service":"postgres","Health":"healthy"}\n{"Service":"web","Health":""}\n').map((s) => s.Service), ["postgres", "web"]);
  assert.deepEqual(composeServices('[{"Service":"postgres","Health":"healthy"}]').map((s) => s.Health), ["healthy"]);
  assert.deepEqual(composeServices(""), []);
});

test("the admin host's script runs restore and facts too, with the dumps on its disk, and keeps links out of Systems Manager", () => {
  const copyScript = readFileSync(new URL("./copy-db.sh", import.meta.url), "utf8");
  const arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:insights/production/db-owner-AbCdEf";
  const restore = adminHostScript({ settings: { DBS: "app", SOURCE_app: "s3://b/db-export/x-back/app.dump", MODE: "replace" }, dbSecretArn: arn, copyScript, command: "restore" });
  assert.match(restore, /\nexport TMPDIR_COPY=\/var\/tmp\n/);
  assert.match(restore, /\nbash \/var\/tmp\/copy-db.sh restore\n$/);
  assert.match(adminHostScript({ settings: { DBS: "app", TARGET_app: "app" }, dbSecretArn: arn, copyScript, command: "facts" }), /\nbash \/var\/tmp\/copy-db.sh facts\n$/);
  assert.throws(() => adminHostScript({ settings: {}, dbSecretArn: arn, copyScript, command: "rm" }), /no command rm/);
  // Systems Manager keeps every command's text: a presigned link there would outlive the copy.
  assert.throws(() => adminHostScript({ settings: { SOURCE_app: "https://b.s3.amazonaws.com/k?X-Amz-Signature=ab" }, dbSecretArn: arn, copyScript, command: "restore" }), /command history/);
});

const EXAMPLE = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

test("presigns S3 links as AWS documents them (Signature Version 4, query parameters)", () => {
  // AWS's own example: "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)".
  const url = presignS3({ method: "GET", bucket: "examplebucket", key: "test.txt", region: "us-east-1", host: "examplebucket.s3.amazonaws.com", credentials: EXAMPLE, now: new Date("2013-05-24T00:00:00Z"), expires: 86400 });
  assert.equal(
    url,
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("an upload link: PUT, the session's token signed in, the key's slashes kept", () => {
  const now = new Date("2026-11-08T09:30:00Z");
  const put = presignS3({ method: "PUT", bucket: "insights-production-artifacts-123456789012", key: "db-export/20261108T093000Z-back/app.dump", region: "ap-southeast-2", credentials: { ...EXAMPLE, sessionToken: "tok/en+=" }, now });
  const u = new URL(put);
  assert.equal(u.host, "insights-production-artifacts-123456789012.s3.ap-southeast-2.amazonaws.com");
  assert.equal(u.pathname, "/db-export/20261108T093000Z-back/app.dump");
  assert.equal(u.searchParams.get("X-Amz-Security-Token"), "tok/en+=");
  assert.equal(u.searchParams.get("X-Amz-Expires"), "3600");
  assert.match(u.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
  // The signature covers the method and the token: neither can be changed on the way.
  const get = presignS3({ method: "GET", bucket: "insights-production-artifacts-123456789012", key: "db-export/20261108T093000Z-back/app.dump", region: "ap-southeast-2", credentials: { ...EXAMPLE, sessionToken: "tok/en+=" }, now });
  assert.notEqual(new URL(get).searchParams.get("X-Amz-Signature"), u.searchParams.get("X-Amz-Signature"));
  const other = presignS3({ method: "PUT", bucket: "insights-production-artifacts-123456789012", key: "db-export/20261108T093000Z-back/app.dump", region: "ap-southeast-2", credentials: { ...EXAMPLE, sessionToken: "other" }, now });
  assert.notEqual(new URL(other).searchParams.get("X-Amz-Signature"), u.searchParams.get("X-Amz-Signature"));
  // Nothing in it that copy-db.sh's curl config or the preamble refuses.
  assert.doesNotMatch(put, /[\s"'\\]/);
  assert.throws(() => presignS3({ method: "DELETE", bucket: "b", key: "k", region: "r", credentials: EXAMPLE }), /GET or PUT/);
  assert.throws(() => presignS3({ method: "PUT", bucket: "b", key: "k", region: "r", credentials: {} }), /no AWS credentials/);
  assert.throws(() => presignS3({ method: "PUT", bucket: "b", key: "k", region: "r", credentials: EXAMPLE, expires: 604_801 }), /7 days/);
});

test("reads the signed-in session's keys from the AWS CLI, and refuses an empty answer", () => {
  assert.deepEqual(exportedCredentials('{"Version":1,"AccessKeyId":"ASIA1","SecretAccessKey":"s","SessionToken":"t","Expiration":"2026-11-08T10:00:00Z"}'), { accessKeyId: "ASIA1", secretAccessKey: "s", sessionToken: "t", expiration: "2026-11-08T10:00:00Z" });
  assert.throws(() => exportedCredentials("{}"), /aws login first/);
});

test("finds AWS's WhatsApp service while a task runs, starts or is wanted", () => {
  const svc = (name, running, desired, pending = 0, status = "ACTIVE") => ({ serviceName: name, runningCount: running, desiredCount: desired, pendingCount: pending, status });
  assert.deepEqual(liveServices({ services: [svc("evolution-a", 0, 0)] }), []);
  assert.deepEqual(liveServices({ services: [svc("evolution-a", 1, 1)] }), [{ name: "evolution-a", running: 1, desired: 1 }]);
  assert.deepEqual(liveServices({ services: [svc("evolution-a", 1, 0)] }).length, 1, "still stopping");
  assert.deepEqual(liveServices({ services: [svc("evolution-a", 0, 1)] }).length, 1, "about to start");
  assert.deepEqual(liveServices({ services: [svc("evolution-a", 0, 0, 1)] }).length, 1, "starting");
  assert.deepEqual(liveServices({ services: [svc("old", 0, 1, 0, "INACTIVE")] }), []);
  assert.deepEqual(liveServices(null), []);
});

test("reads the server's queue per queue name", () => {
  assert.deepEqual(queueCounts(""), {});
  assert.deepEqual(queueCounts("shopify|3\r\nemail|1\n"), { shopify: 3, email: 1 });
  assert.throws(() => queueCounts("ERROR: relation does not exist"), /not a queue count/);
});

test("names the rollback's RDS snapshot as RDS allows", () => {
  assert.equal(snapshotName("insights-production", "20261108T093000Z"), "insights-production-before-rollback-20261108t093000z");
  assert.throws(() => snapshotName("9x", "1"), /not a snapshot name/);
});

test("both drivers refuse a wrong command line before they touch AWS or the server", () => {
  const run = (script, ...a) => spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...a], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  for (const a of [[], ["--rehearsal", "--cutover"]]) {
    const r = run("./copy-db.mjs", ...a);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: copy-db\.mjs/);
  }
  for (const a of [[], ["--rehearsal", "--rollback", "--replace"]]) {
    const r = run("./copy-db-back.mjs", ...a);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: copy-db-back\.mjs/);
  }
  // A rollback replaces RDS's databases: only when said so.
  const r = run("./copy-db-back.mjs", "--rollback");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--replace/);
});
