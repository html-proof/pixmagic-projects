import { crossTenant, forTenant, systemDb, type Subscription } from "@app/db";
import { releaseAdLoginsWhere } from "./adConnections.js";
import { revokeConnection } from "./email/tokens.js";
import { purgeEmailStoreData } from "./email/events.js";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";
import { purgeStoreData } from "./persist.js";
import type { FetchLike } from "./shopify.js";
import { dropStoreInstance } from "./whatsapp/connection.js";
import { revokeZapierGrants } from "./zapier/oauth.js";

/**
 * Deleting a workspace, by one of its owners (DELETE /workspaces/:ws), or with the account of its
 * only owner (POST /auth/account/delete): its stores' data, everything its team set up, and the
 * access it was given elsewhere. docs/RUNBOOK.md "Deleting a workspace" says what it removes and
 * how to finish one that stopped half way.
 *
 * In order, each step safe to run again, so a deletion that stopped half way is finished by running
 * it again (the owner asking again, or the runbook):
 *  1. Access ends: the workspace's API keys and email-event keys are revoked, its Zapier connections
 *     too, and its stores are disconnected (Shopify tokens deleted, so no import or sweep reads them
 *     any more).
 *  2. Each store is erased as shop/redact erases one (apps/worker webhooks.ts eraseStore): its
 *     WhatsApp instance at Evolution API, its synced data with its ad connections (their grants
 *     taken back at Google and Meta unless another connection still uses them), its customers'
 *     email records.
 *  3. Its email accounts' grants are taken back where the provider allows (Google).
 *  4. One transaction removes what no foreign key takes with it, then the workspace: members,
 *     invitations, stores and every table that cascades from them go with it.
 *  5. The deletion is recorded with no workspace (audit_logs, workspace_id null), so the record
 *     outlives it: who asked, when, and which shops.
 *
 * Refused while Shopify bills a paid plan for the workspace: the charge would run on with nothing
 * left to show for it, and deleting our copy of the store's token leaves no way to cancel it.
 * Switching to Free (Settings → Billing) cancels it first.
 */

export class WorkspaceDeletionError extends AppError {
  constructor(message: string, status: number, code: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "WorkspaceDeletionError";
  }
}

/** What deleting a workspace takes with it, for the dialog that confirms it. */
export interface WorkspaceDeletionSummary {
  id: string;
  name: string;
  /** Its stores, connected or not: each one's data goes. */
  stores: Array<{ id: string; shopDomain: string; name: string | null }>;
  /** Everyone who loses access with it, the asking owner included. */
  members: number;
  /** The paid plan Shopify bills for it (its id), or null on Free: a paid plan must end first. */
  paidPlan: string | null;
}

/** The plan Shopify is billing for the workspace, or null when no charge is in force. */
const paidPlanOf = (sub: Pick<Subscription, "plan" | "shopifyChargeId"> | null) => (sub?.shopifyChargeId ? sub.plan : null);

/** The workspace as its deletion would find it, or null when there is no such workspace. */
export async function workspaceDeletionSummary(workspaceId: string): Promise<WorkspaceDeletionSummary | null> {
  return forTenant(workspaceId, async () => {
    const ws = await systemDb.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, subscription: { select: { plan: true, shopifyChargeId: true } } } });
    if (!ws) return null;
    const stores = await systemDb.store.findMany({ where: { workspaceId }, select: { id: true, shopDomain: true, name: true }, orderBy: { createdAt: "asc" } });
    const members = await systemDb.membership.count({ where: { workspaceId } });
    return { id: ws.id, name: ws.name, stores, members, paidPlan: paidPlanOf(ws.subscription) };
  });
}

/** 409 paid_plan while Shopify bills a plan for the workspace (see above). */
export function assertDeletable(summary: WorkspaceDeletionSummary) {
  if (!summary.paidPlan) return;
  throw new WorkspaceDeletionError(
    `${summary.name} is on a paid plan billed through Shopify. Switch it to Free in Settings → Billing first, so the charge ends, then delete it.`,
    409,
    "paid_plan",
    { workspaceId: summary.id, plan: summary.paidPlan },
  );
}

export interface WorkspaceDeletion {
  workspaceId: string;
  stores: string[];
  members: number;
  emailAccounts: number;
}

/**
 * Delete the workspace (the steps above). `actor` is the owner who confirmed it, `via` where: one
 * of the two routes, or support finishing it (apps/worker ops/deleteWorkspace.ops.ts). Throws WorkspaceDeletionError (paid_plan) before anything is removed; any
 * other error leaves the workspace part way, for the caller to report as deletion_incomplete.
 * Null when the workspace is already gone.
 */
export async function deleteWorkspace(
  workspaceId: string,
  actor: { userId: string; ip?: string; via: "workspace" | "account" | "support" },
  deps: { fetchImpl?: FetchLike },
): Promise<WorkspaceDeletion | null> {
  const done = await forTenant(workspaceId, async () => {
    const summary = await workspaceDeletionSummary(workspaceId);
    if (!summary) return null;
    assertDeletable(summary);
    const now = new Date();

    // 1. Access ends before anything is erased.
    await systemDb.apiKey.updateMany({ where: { workspaceId, revokedAt: null }, data: { revokedAt: now } });
    await systemDb.emailIngestKey.updateMany({ where: { workspaceId, revokedAt: null }, data: { revokedAt: now } });
    await revokeZapierGrants({ workspaceId }, "workspace_deleted");
    await systemDb.store.updateMany({ where: { workspaceId, status: { not: "uninstalled" } }, data: { status: "uninstalled", uninstalledAt: now } });
    await systemDb.store.updateMany({ where: { workspaceId }, data: { accessTokenEnc: null, refreshTokenEnc: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, grantedScopes: [] } });

    // 2. Each store, as shop/redact erases one. Its WhatsApp instance first, while its row says which.
    for (const store of summary.stores) {
      await dropStoreInstance(store.id, { fetchImpl: deps.fetchImpl ?? fetch });
      await purgeStoreData(store.id, deps.fetchImpl);
      await purgeEmailStoreData(store.id);
    }
    // A sign-in still waiting for its ad accounts under no store of the list (none should be).
    await releaseAdLoginsWhere({ workspaceId }, deps.fetchImpl).catch((err: unknown) => logger.warn({ err, workspaceId }, "workspace deletion: a waiting ad login wasn't let go"));

    // 3. The email accounts' grants, best effort (revokeConnection never throws); their rows go below.
    const accounts = await systemDb.emailAccount.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, workspaceId: true, connectionMethod: true, emailAddress: true, provider: true } });
    for (const account of accounts) await revokeConnection(account, { fetchImpl: deps.fetchImpl ?? fetch });

    // 4. What no foreign key takes with the workspace, then the workspace and everything that cascades.
    const storeIds = summary.stores.map((s) => s.id);
    await systemDb.$transaction(async (tx) => {
      // Connecting a store or claiming the workspace takes the same lock (apps/api connectStore.ts, shopify.ts).
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
      // What the merchant entered for each store (a Disconnect keeps it; these cascade with the store too).
      await tx.storeExpense.deleteMany({ where: { storeId: { in: storeIds } } });
      await tx.storeExpenseSettings.deleteMany({ where: { storeId: { in: storeIds } } });
      await tx.businessEvent.deleteMany({ where: { storeId: { in: storeIds } } });
      await tx.syncJob.deleteMany({ where: { storeId: { in: storeIds } } });
      await tx.notificationPreference.deleteMany({ where: { workspaceId } });
      // Shopify's deliveries stay, by its webhook id, so a redelivery is still known; they hold no payload.
      await tx.webhookEvent.updateMany({ where: { storeId: { in: storeIds } }, data: { storeId: null } });
      await tx.workspace.delete({ where: { id: workspaceId } });
    });
    return { workspaceId, stores: summary.stores.map((s) => s.shopDomain), storeIds, members: summary.members, emailAccounts: accounts.length };
  });
  if (!done) return null;

  // 5. The record that outlives the workspace. Under the workspace's own scope row-level security
  // refuses a row with no workspace, so this one insert is made across workspaces.
  await crossTenant("workspace_deleted", () =>
    systemDb.auditLog.create({
      data: {
        workspaceId: null,
        actorUserId: actor.userId,
        action: "workspace.deleted",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { via: actor.via, shops: done.stores, storeIds: done.storeIds, members: done.members, emailAccounts: done.emailAccounts },
        ip: actor.ip,
      },
    }),
  ).catch((err: unknown) => logger.error({ err, workspaceId }, "workspace deletion: the workspace is gone but its record wasn't written"));
  logger.info({ workspaceId, userId: actor.userId, via: actor.via, shops: done.stores, members: done.members }, "workspace deleted");
  return { workspaceId, stores: done.stores, members: done.members, emailAccounts: done.emailAccounts };
}
