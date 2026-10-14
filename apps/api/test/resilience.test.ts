import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { audit } from "@app/core";
import { systemDb } from "@app/db";
import { clean, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

describe("audit log", () => {
  it("never throws: a failed write can't turn the change it records into an error", async () => {
    // No such workspace: the row violates its foreign key, as a failing write would.
    await expect(audit({ workspaceId: "ws_does_not_exist", action: "test.action" })).resolves.toBeUndefined();
  });

  it("still records changes", async () => {
    const u = await signIn(ctx, "u1", "u1@example.com");
    const ws = await createWorkspace(ctx, u.headers);
    await audit({ workspaceId: ws, actorUserId: u.user.id, action: "test.action", targetType: "thing", targetId: "t1" });
    expect(await systemDb.auditLog.count({ where: { workspaceId: ws, action: "test.action" } })).toBe(1);
  });
});

describe("WhatsApp webhook", () => {
  it("limits unsigned deliveries per address before looking anything up", async () => {
    const send = () =>
      ctx.app.inject({
        method: "POST",
        url: "/webhooks/whatsapp",
        headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00", "cf-connecting-ip": "203.0.113.9" },
        payload: JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-unknown" }] }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 301; i++) statuses.push((await send()).statusCode);
    expect(statuses.slice(0, 300).every((s) => s === 401)).toBe(true);
    expect(statuses[300]).toBe(429);
    // Another address is not affected.
    const other = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00", "cf-connecting-ip": "203.0.113.10" },
      payload: JSON.stringify({ entry: [] }),
    });
    expect(other.statusCode).toBe(401);
  });
});
