import {
  assertDeletable,
  deleteWorkspace,
  detachUserAdGrants,
  logger,
  releaseAdLoginsWhere,
  revokeReleasedAdGrants,
  workspaceDeletionSummary,
  type FetchLike,
  type WorkspaceDeletionSummary,
} from "@app/core";
import { revokeZapierGrants } from "@app/core/zapier";
import { crossTenant, systemDb } from "@app/db";
import type { CognitoAuth } from "./authContract.js";
import { recordAuthEvent } from "./identity.js";

/**
 * Deleting accounts on the owner's word, from the server's admin command (apps/aws/src/admin.ts,
 * `remove-accounts`): every account but one, each exactly as "Delete account" in Settings →
 * Security deletes it (routes/account.ts), without the emailed code, since the person asking is
 * the operator and not the account's holder.
 *
 * For each account: the workspaces it is the only owner of go first, through deleteWorkspace
 * (their stores' data, team, keys and the access they were given elsewhere; core
 * workspaceDeletion.ts), then its sign-in, then the person's own ad and Zapier grants, then the
 * user row, which takes its memberships of other people's workspaces with it. A workspace with
 * another owner keeps running without them. An account that stops part way is finished by running
 * the command again: every step is safe to repeat.
 *
 * Nothing here chooses who goes: the caller names the one address that stays, and the plan says
 * what each of the others owns before anything is removed.
 */

/** The workspaces `userId` is the only owner of, as their deletion would find them. */
export async function soleOwnedWorkspaces(userId: string): Promise<WorkspaceDeletionSummary[]> {
  const owned = await systemDb.membership.findMany({ where: { userId, role: "owner" }, select: { workspaceId: true }, orderBy: { createdAt: "asc" } });
  const sole: WorkspaceDeletionSummary[] = [];
  for (const m of owned) {
    const others = await systemDb.membership.count({ where: { workspaceId: m.workspaceId, role: "owner", userId: { not: userId } } });
    if (others) continue;
    const summary = await workspaceDeletionSummary(m.workspaceId);
    if (summary) sole.push(summary);
  }
  return sole;
}

export interface AccountToRemove {
  userId: string;
  email: string;
  /** How it signs in: "password", "google", both, or none (invited, never signed in). */
  signsInWith: string[];
  /** Workspaces that go with it (it is their only owner), with their stores. */
  workspaces: Array<{ id: string; name: string; stores: string[]; members: number; paidPlan: string | null }>;
  /** Other people's workspaces it loses its place in. */
  memberOf: number;
}

export interface AccountRemovalPlan {
  keep: { userId: string; email: string; workspaces: number; stores: number };
  remove: AccountToRemove[];
  /** Of the kept account's workspaces, how many members are among those removed. */
  membersLeavingKeptWorkspaces: number;
  totals: { accounts: number; workspaces: number; stores: number };
}

export class AccountRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountRemovalError";
  }
}

const lower = (s: string) => s.trim().toLowerCase();

/** What removing every account but `keepEmail`'s would take, without removing anything. */
export async function accountRemovalPlan(keepEmail: string): Promise<AccountRemovalPlan> {
  const wanted = lower(keepEmail);
  if (!wanted.includes("@")) throw new AccountRemovalError("--keep needs the full address of the account that stays");
  return crossTenant("maintenance", async () => {
    const users = await systemDb.user.findMany({ select: { id: true, email: true }, orderBy: { createdAt: "asc" } });
    const kept = users.filter((u) => lower(u.email) === wanted);
    // Refused rather than guessed: with no such account, "all but it" would be everyone.
    if (kept.length !== 1) throw new AccountRemovalError(`${kept.length} accounts have the address to keep: nothing is removed unless exactly one does`);
    const keep = kept[0]!;
    const keepWorkspaces = await systemDb.membership.findMany({ where: { userId: keep.id }, select: { workspaceId: true } });
    const keepIds = keepWorkspaces.map((m) => m.workspaceId);

    const remove: AccountToRemove[] = [];
    for (const u of users) {
      if (u.id === keep.id) continue;
      const sole = await soleOwnedWorkspaces(u.id);
      const identities = await systemDb.authIdentity.findMany({ where: { userId: u.id }, select: { method: true } });
      const memberOf = await systemDb.membership.count({ where: { userId: u.id, workspaceId: { notIn: sole.map((w) => w.id) } } });
      remove.push({
        userId: u.id,
        email: u.email,
        signsInWith: [...new Set(identities.map((i) => i.method))].sort(),
        workspaces: sole.map((w) => ({ id: w.id, name: w.name, stores: w.stores.map((s) => s.shopDomain), members: w.members, paidPlan: w.paidPlan })),
        memberOf,
      });
    }
    // A workspace the kept account belongs to but someone else alone owns would go with that owner.
    const goingIds = new Set(remove.flatMap((a) => a.workspaces.map((w) => w.id)));
    const lost = keepIds.filter((id) => goingIds.has(id));
    if (lost.length) throw new AccountRemovalError(`${lost.length} workspace(s) the kept account belongs to are owned only by an account to remove: make the kept account an owner first, or they would be deleted with it`);
    const removeIds = remove.map((a) => a.userId);
    return {
      keep: {
        userId: keep.id,
        email: keep.email,
        workspaces: keepIds.length,
        stores: keepIds.length ? await systemDb.store.count({ where: { workspaceId: { in: keepIds } } }) : 0,
      },
      remove,
      membersLeavingKeptWorkspaces: keepIds.length && removeIds.length ? await systemDb.membership.count({ where: { workspaceId: { in: keepIds }, userId: { in: removeIds } } }) : 0,
      totals: { accounts: remove.length, workspaces: goingIds.size, stores: remove.reduce((n, a) => n + a.workspaces.reduce((m, w) => m + w.stores.length, 0), 0) },
    };
  });
}

export interface RemovedAccount {
  userId: string;
  workspaces: number;
  stores: number;
  identities: number;
}

/** Remove one account, as "Delete account" does (routes/account.ts). Safe to run again after a failure. */
export async function removeAccount(userId: string, deps: { auth: CognitoAuth; fetchImpl?: FetchLike }): Promise<RemovedAccount | null> {
  return crossTenant("maintenance", async () => {
    const user = await systemDb.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return null;
    const sole = await soleOwnedWorkspaces(userId);
    // Before anything goes: a workspace Shopify bills for is refused (its charge would run on).
    for (const w of sole) assertDeletable(w);
    let stores = 0;
    for (const w of sole) {
      await recordAuthEvent("workspace_deletion_started", userId, null, { workspaceId: w.id, via: "support" });
      const done = await deleteWorkspace(w.id, { userId, via: "support" }, { fetchImpl: deps.fetchImpl });
      stores += done?.stores.length ?? 0;
    }
    const identities = await systemDb.authIdentity.findMany({ where: { userId } });
    // Sign-in first, so nobody can sign in to a half-deleted account.
    for (const id of identities) await deps.auth.adminDeleteUser(id.username);
    const released = await detachUserAdGrants(userId).catch((err: unknown) => {
      logger.error({ err, userId }, "account removal: the person's ad connections weren't released; their tokens remain until a disconnect");
      return null;
    });
    await revokeZapierGrants({ userId }, "account_deleted").catch((err: unknown) => logger.error({ err, userId }, "account removal: the person's Zapier connections weren't revoked"));
    await systemDb.user.delete({ where: { id: userId } });
    if (released?.grants.length) {
      const outcomes = await revokeReleasedAdGrants(released.grants, deps.fetchImpl);
      logger.info({ userId, released: released.released, outcomes }, "account removal: ad connections released");
    }
    await releaseAdLoginsWhere({ connectedByUserId: userId }, deps.fetchImpl).catch((err: unknown) => logger.error({ err, userId }, "account removal: waiting ad logins weren't released"));
    await recordAuthEvent("account_deleted", null, null, { userId, identities: identities.length, workspaces: sole.length, via: "support" });
    return { userId, workspaces: sole.length, stores, identities: identities.length };
  });
}

export interface AccountRemovalResult {
  kept: string;
  removed: RemovedAccount[];
  /** The account that stopped the run, if one did: the ones after it were not tried. */
  failed: { userId: string; error: string } | null;
  left: { users: number; workspaces: number; stores: number };
}

/**
 * Remove every account but `keepEmail`'s. `confirm` is how many accounts the caller expects to go
 * (the plan's count): a different number refuses the whole run, so a list that changed since it
 * was read is never deleted on an old answer.
 */
export async function removeAccountsExcept(keepEmail: string, confirm: number, deps: { auth: CognitoAuth; fetchImpl?: FetchLike }): Promise<AccountRemovalResult> {
  const plan = await accountRemovalPlan(keepEmail);
  if (confirm !== plan.remove.length) throw new AccountRemovalError(`--confirm says ${confirm} accounts, but ${plan.remove.length} would be removed: read the plan again`);
  const removed: RemovedAccount[] = [];
  let failed: AccountRemovalResult["failed"] = null;
  for (const a of plan.remove) {
    try {
      const done = await removeAccount(a.userId, deps);
      if (done) removed.push(done);
    } catch (err) {
      logger.error({ err, userId: a.userId }, "account removal stopped: run the command again to finish it");
      failed = { userId: a.userId, error: (err as Error).message };
      break;
    }
  }
  const left = await crossTenant("maintenance", async () => ({ users: await systemDb.user.count(), workspaces: await systemDb.workspace.count(), stores: await systemDb.store.count() }));
  return { kept: plan.keep.email, removed, failed, left };
}
