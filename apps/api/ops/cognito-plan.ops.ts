import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, it } from "vitest";
import { disconnectDb } from "@app/db";
import { cognitoAuth, cognitoConfig } from "../src/cognito.js";
import { listFirebaseAccounts, planMigration, planMarkdown, snapshotMappings } from "../src/migration.js";

/**
 * The Firebase → Cognito dry run (docs/cognito-setup.md, "Migrating existing accounts"): who moves
 * how, what would stop them, and a snapshot of who belongs where. Reads only.
 *   pnpm --filter @app/api ops:cognito-plan     (writes plan-<time>.json/.md, snapshot-<time>.json to OPS_REPORT_DIR)
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

it("cognito migration: plan", async () => {
  mkdirSync(dir, { recursive: true });
  const p = await plan();
  const snapshot = await snapshotMappings();
  writeFileSync(resolve(dir, `plan-${stamp}.json`), JSON.stringify(p, null, 2));
  writeFileSync(resolve(dir, `plan-${stamp}.md`), planMarkdown(p));
  writeFileSync(resolve(dir, `snapshot-${stamp}.json`), JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({ totals: p.totals, firebaseOnly: p.firebaseOnly.length, problems: p.problems }, null, 2));
  console.log(`wrote ${dir}/plan-${stamp}.md and snapshot-${stamp}.json (keep the snapshot for OPS_MODE=verify)`);
});
