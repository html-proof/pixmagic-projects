import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, it } from "vitest";
import { disconnectDb } from "@app/db";
import { cognitoAuth, cognitoConfig } from "../src/cognito.js";
import { compareSnapshots, listFirebaseAccounts, planMigration, snapshotMappings, type MappingSnapshot } from "../src/migration.js";

/**
 * After the cutover (docs/cognito-setup.md): every user from the plan's snapshot is still there under
 * the same id, in the same workspaces with the same roles. Reads only; fails when anything moved.
 *   OPS_SNAPSHOT=<snapshot-*.json> pnpm --filter @app/api ops:cognito-verify
 */
afterAll(async () => disconnectDb());

const dir = resolve(process.env.OPS_REPORT_DIR ?? resolve(__dirname, "../../../ops-reports"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

async function plan() {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  const cfg = cognitoConfig();
  return planMigration({
    firebase: sa ? await listFirebaseAccounts(sa) : null,
    auth: cfg?.admin ? cognitoAuth(cfg) : null,
  });
}

it("cognito migration: verify", async () => {
  mkdirSync(dir, { recursive: true });
  if (!process.env.OPS_SNAPSHOT) throw new Error("OPS_SNAPSHOT=<snapshot-*.json from the plan run> is required");
  const before = JSON.parse(readFileSync(process.env.OPS_SNAPSHOT, "utf8")) as MappingSnapshot;
  const result = compareSnapshots(before, await snapshotMappings());
  const p = await plan();
  const report = { checkedAt: new Date().toISOString(), snapshotTakenAt: before.takenAt, ...result, totals: p.totals, problems: p.problems };
  writeFileSync(resolve(dir, `verify-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(
    resolve(dir, `verify-${stamp}.md`),
    [
      `# Migration verification (${report.checkedAt})`,
      "",
      `Against the snapshot of ${before.takenAt}: ${result.checked} users checked, mappings ${result.preserved ? "PRESERVED" : "CHANGED"}.`,
      "",
      ...result.differences.map((d) => `- ${d}`),
      "",
      "| Status | Users |",
      "| --- | --- |",
      ...Object.entries(p.totals).map(([s, n]) => `| ${s} | ${n} |`),
      "",
    ].join("\n"),
  );
  console.log(JSON.stringify({ preserved: result.preserved, checked: result.checked, differences: result.differences, totals: p.totals }, null, 2));
  if (!result.preserved) throw new Error("Account or tenant mappings changed since the snapshot: see the report");
});
