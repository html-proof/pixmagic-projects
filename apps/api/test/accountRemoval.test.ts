import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { accountRemovalPlan, AccountRemovalError, removeAccountsExcept } from "../src/accountRemoval.js";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * The admin command `remove-accounts --keep <address>` (apps/aws/src/admin.ts): every account but
 * one, each as "Delete account" deletes it. The plan removes nothing; the run needs the plan's
 * count; without exactly one account at the address to keep, nothing goes.
 */
let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

/** The owner who stays (a workspace with a store and two other members) and three who don't. */
async function people() {
  const keep = await signIn(ctx, "keep", "keep@x.com");
  const keepWs = await createWorkspace(ctx, keep.headers, "Kept Shop");
  const keepStore = await createStore(keepWs, "kept.myshopify.com", ["read_orders"]);
  const other = await signIn(ctx, "other", "other@x.com");
  const otherWs = await createWorkspace(ctx, other.headers, "Other Shop");
  const otherStore = await createStore(otherWs, "other.myshopify.com", ["read_orders"]);
  const emptyWs = await createWorkspace(ctx, other.headers, "Empty");
  const member = await signIn(ctx, "member", "member@x.com");
  await systemDb.membership.create({ data: { workspaceId: keepWs, userId: member.user.id, role: "viewer" } });
  // Invited and never signed in: a user row with no sign-in at all.
  const invited = await systemDb.user.create({ data: { email: "invited@x.com", emailVerified: false } });
  await systemDb.membership.create({ data: { workspaceId: keepWs, userId: invited.id, role: "admin" } });
  return { keep, keepWs, keepStore, other, otherWs, otherStore, emptyWs, member, invited };
}

describe("removing every account but one (remove-accounts)", () => {
  it("plans without removing: each account, the workspaces and stores that go with it, and who leaves the kept workspace", async () => {
    const p = await people();
    const plan = await accountRemovalPlan("  Keep@X.com ");
    expect(plan.keep).toEqual({ userId: p.keep.user.id, email: "keep@x.com", workspaces: 1, stores: 1 });
    expect(plan.totals).toEqual({ accounts: 3, workspaces: 2, stores: 1 });
    expect(plan.membersLeavingKeptWorkspaces).toBe(2);
    const byEmail = Object.fromEntries(plan.remove.map((a) => [a.email, a]));
    expect(byEmail["other@x.com"]).toMatchObject({ signsInWith: ["password"], memberOf: 0, workspaces: [{ name: "Other Shop", stores: ["other.myshopify.com"], members: 1, paidPlan: null }, { name: "Empty", stores: [] }] });
    expect(byEmail["member@x.com"]).toMatchObject({ signsInWith: ["password"], memberOf: 1, workspaces: [] });
    expect(byEmail["invited@x.com"]).toMatchObject({ signsInWith: [], memberOf: 1, workspaces: [] });
    // Nothing went.
    expect(await systemDb.user.count()).toBe(4);
    expect(await systemDb.workspace.count()).toBe(3);
    expect(await systemDb.store.count()).toBe(2);
  });

  it("removes nothing unless exactly one account has the address to keep, or when the count isn't the plan's", async () => {
    await people();
    await expect(accountRemovalPlan("nobody@x.com")).rejects.toBeInstanceOf(AccountRemovalError);
    await expect(removeAccountsExcept("nobody@x.com", 4, { auth: ctx.auth })).rejects.toThrow(/0 accounts have the address to keep/);
    await expect(accountRemovalPlan("keep")).rejects.toThrow(/full address/);
    await expect(removeAccountsExcept("keep@x.com", 2, { auth: ctx.auth })).rejects.toThrow(/--confirm says 2 accounts, but 3 would be removed/);
    expect(await systemDb.user.count()).toBe(4);
    expect(await systemDb.workspace.count()).toBe(3);
  });

  it("refuses when the kept account belongs to a workspace only an account to remove owns", async () => {
    const p = await people();
    await systemDb.membership.create({ data: { workspaceId: p.otherWs, userId: p.keep.user.id, role: "admin" } });
    await expect(accountRemovalPlan("keep@x.com")).rejects.toThrow(/1 workspace\(s\) the kept account belongs to are owned only by an account to remove/);
    expect(await systemDb.workspace.count()).toBe(3);
  });

  it("removes the others as Delete account does: their workspaces, stores and sign-ins go, the kept account and its store stay", async () => {
    const p = await people();
    const done = await removeAccountsExcept("keep@x.com", 3, { auth: ctx.auth });
    expect(done.failed).toBeNull();
    expect(done.kept).toBe("keep@x.com");
    expect(done.left).toEqual({ users: 1, workspaces: 1, stores: 1 });
    expect(done.removed.find((r) => r.userId === p.other.user.id)).toMatchObject({ workspaces: 2, stores: 1, identities: 1 });
    expect(done.removed.find((r) => r.userId === p.invited.id)).toMatchObject({ workspaces: 0, stores: 0, identities: 0 });

    expect((await systemDb.user.findMany()).map((u) => u.email)).toEqual(["keep@x.com"]);
    expect((await systemDb.workspace.findMany()).map((w) => w.id)).toEqual([p.keepWs]);
    expect((await systemDb.store.findMany()).map((s) => s.id)).toEqual([p.keepStore.id]);
    expect((await systemDb.membership.findMany({ where: { workspaceId: p.keepWs } })).map((m) => m.userId)).toEqual([p.keep.user.id]);
    // Their sign-ins are gone; the kept one still signs in.
    expect([...ctx.auth.users.keys()]).toEqual(["keep"]);
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: p.keep.headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: p.other.headers })).statusCode).toBe(401);
    // Each deletion is on record with no link to the person, and each workspace's with its shops.
    expect(await systemDb.authEvent.count({ where: { type: "account_deleted", userId: null } })).toBe(3);
    const audits = await systemDb.auditLog.findMany({ where: { action: "workspace.deleted" } });
    expect(audits.map((a) => (a.metadata as { via: string; shops: string[] }).shops).flat()).toEqual(["other.myshopify.com"]);
    expect(audits.every((a) => (a.metadata as { via: string }).via === "support")).toBe(true);
    // Run again: nothing left to do.
    expect((await removeAccountsExcept("keep@x.com", 0, { auth: ctx.auth })).left).toEqual({ users: 1, workspaces: 1, stores: 1 });
  });

  it("stops at an account it can't finish, leaves the ones after it, and finishes when run again", async () => {
    const p = await people();
    let refuse = true;
    const auth = {
      ...ctx.auth,
      adminDeleteUser: async (username: string) => {
        if (refuse && username === "member") throw new Error("the sign-in directory is unavailable");
        return ctx.auth.adminDeleteUser(username);
      },
    };
    const first = await removeAccountsExcept("keep@x.com", 3, { auth });
    expect(first.failed).toEqual({ userId: p.member.user.id, error: "the sign-in directory is unavailable" });
    expect(first.removed.map((r) => r.userId)).toEqual([p.other.user.id]);
    // The one that failed and the one after it are still there, with their place in the kept workspace.
    expect(await systemDb.user.count()).toBe(3);
    expect(await systemDb.membership.count({ where: { workspaceId: p.keepWs } })).toBe(3);

    refuse = false;
    const second = await removeAccountsExcept("keep@x.com", 2, { auth });
    expect(second.failed).toBeNull();
    expect(second.left).toEqual({ users: 1, workspaces: 1, stores: 1 });
  });
});
