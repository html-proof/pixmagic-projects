// node --test infra/ikorex/scripts/copy-db-lib.test.mjs (CI: the checks job)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { adminHostScript, compareFacts, composeServices, hostKeyFingerprint, parseResult, PINNED_FINGERPRINT, PINNED_HOST, preamble, queuesToDrain } from "./copy-db-lib.mjs";

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
