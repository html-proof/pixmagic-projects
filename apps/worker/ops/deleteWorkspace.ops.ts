import { afterAll, it } from "vitest";
import { deleteWorkspace, workspaceDeletionSummary } from "@app/core";
import { disconnectDb, systemDb } from "@app/db";

/**
 * Delete one workspace as its owner would from Settings → Workspace (core workspaceDeletion.ts):
 * to finish one that stopped part way (the `deletion_incomplete` log), or for an emailed request
 * whose sender support has checked (docs/RUNBOOK.md, "Merchant asks for data deletion").
 *   OPS_WORKSPACE=<workspace id> OPS_ACTOR=<user id of the owner who asked> pnpm --filter @app/worker ops:delete-workspace
 * prints what would go; with OPS_CONFIRM=<the workspace's name> it deletes it. Safe to repeat.
 */
afterAll(async () => disconnectDb());

it("deletes the workspace", async () => {
  const id = process.env.OPS_WORKSPACE;
  const actor = process.env.OPS_ACTOR;
  if (!id || !actor) throw new Error("Set OPS_WORKSPACE (the workspace's id) and OPS_ACTOR (the user id of the owner who asked)");
  const summary = await workspaceDeletionSummary(id);
  if (!summary) {
    console.log(`no workspace ${id}: nothing to delete (already deleted?)`);
    return;
  }
  const asker = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: id, userId: actor } } });
  if (asker?.role !== "owner") throw new Error(`user ${actor} is not an owner of ${id}: only an owner's request deletes a workspace`);
  console.log(JSON.stringify({ id, name: summary.name, shops: summary.stores.map((s) => s.shopDomain), members: summary.members, paidPlan: summary.paidPlan }));
  if (process.env.OPS_CONFIRM !== summary.name) {
    console.log("dry run: set OPS_CONFIRM to the workspace's name (exactly as printed) to delete it");
    return;
  }
  const done = await deleteWorkspace(id, { userId: actor, via: "support" }, { fetchImpl: fetch });
  console.log(`deleted: ${JSON.stringify(done)}`);
});
