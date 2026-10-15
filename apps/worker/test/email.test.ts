import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, systemDb, type EmailAccount, type Store } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  addSuppression,
  connectOAuthAccount,
  createRule,
  createTemplate,
  disconnectEmailAccount,
  emailOnShopifyEvent,
  getValidAccessToken,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  processBusinessEvent,
  promoteAbandonedCheckouts,
  recordEvent,
  resetEnvCache,
  sendEmailMessage,
  setRuleEnabled,
  sweepEmail,
  type FetchLike,
} from "@app/core";
import { sampleEventData, type RuleInput } from "@app/shared/email";
import type { WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";
import { json } from "../../../test-support/emailFakes.js";

/**
 * Email automations inside the worker: events → rules → messages → the provider (Gmail and
 * Microsoft faked), with retries, limits, token refresh and the sweep. Real Postgres.
 */

const queues = memoryQueues();
const coord = memoryCoord();
const mailer = memoryMailer();
let fetchImpl: FetchLike;
let deps: WorkerDeps;

let gmailSent: string[];
let gmailMode: "ok" | "503" | "throw" | "401";
let refreshes: number;
let refreshMode: "ok" | "invalid_grant";
let msRefreshToken: string | undefined;

beforeAll(() => {
  Object.assign(process.env, { EMAIL_GOOGLE_CLIENT_ID: "g-email", EMAIL_GOOGLE_CLIENT_SECRET: "g-secret", EMAIL_MICROSOFT_CLIENT_ID: "ms-email", EMAIL_MICROSOFT_CLIENT_SECRET: "ms-secret" });
  resetEnvCache();
  deps = { coord, queues, payloads: memoryBlobs(), mailer, fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => disconnectDb());

let ws: string;
let userId: string;
let store: Store;
let account: EmailAccount;
let senderId: string;
let templateId: string;

beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  mailer.sent.length = 0;
  gmailSent = [];
  gmailMode = "ok";
  refreshes = 0;
  refreshMode = "ok";
  msRefreshToken = "MS_REFRESH_2";
  fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "gmail.googleapis.com") {
      if (gmailMode === "throw") throw new Error("Network connection lost");
      if (gmailMode === "503") return json({ error: { message: "Backend Error", status: "UNAVAILABLE" } }, 503);
      if (gmailMode === "401") return json({ error: { message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, 401);
      gmailSent.push(Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString());
      return json({ id: `gm-${gmailSent.length}`, threadId: "t" });
    }
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      refreshes++;
      await new Promise((r) => setTimeout(r, 30));
      if (refreshMode === "invalid_grant") return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      return json({ access_token: `G_ACCESS_${refreshes}`, expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.send" });
    }
    if (url.hostname === "login.microsoftonline.com") {
      refreshes++;
      return json({ access_token: `MS_ACCESS_${refreshes}`, expires_in: 3600, ...(msRefreshToken ? { refresh_token: msRefreshToken } : {}), scope: "Mail.Send User.Read" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const user = await systemDb.user.create({ data: { firebaseUid: "w-owner", email: "owner@shopmail.com", emailVerified: true } });
  userId = user.id;
  const w = await systemDb.workspace.create({ data: { name: "Shop", memberships: { create: { userId, role: "owner" } } } });
  ws = w.id;
  store = await systemDb.store.create({ data: { workspaceId: ws, shopDomain: "shop.myshopify.com", name: "Shop", grantedScopes: [], status: "active" } });
  ({ account } = await connectOAuthAccount({
    workspaceId: ws,
    userId,
    method: "oauth_google",
    identity: { provider: "google_workspace", providerAccountId: "g-sub", providerTenantId: "shopmail.com", email: "sales@shopmail.com", displayName: "Sales" },
    tokens: { accessToken: "G_ACCESS_0", refreshToken: "G_REFRESH", expiresAt: new Date(Date.now() + 3600_000), scopes: ["https://www.googleapis.com/auth/gmail.send"], idToken: null },
  }));
  senderId = (await systemDb.emailSenderIdentity.findFirstOrThrow({ where: { emailAccountId: account.id } })).id;
  templateId = (await createTemplate(ws, userId, { name: "Thanks", category: "transactional", eventType: "order.paid", subject: "Thanks for {{order.id}}", html: "<p>Hi {{customer.first_name}}</p>", text: "", status: "active" })).id;
});

async function rule(extra: Partial<RuleInput> = {}, enabled = true) {
  const input: RuleInput = {
    name: "Thanks",
    description: null,
    eventType: "order.paid",
    storeId: null,
    conditions: { op: "greater_than", field: "order.total", value: 100 },
    senderIdentityId: senderId,
    templateId,
    recipient: { type: "customer" },
    delayMinutes: 0,
    frequency: { type: "once_per_event" },
    maxAttempts: 5,
    priority: 100,
    ...extra,
  };
  const { rule } = await createRule(ws, userId, input);
  if (enabled) await setRuleEnabled(ws, rule.id, userId, true);
  return rule;
}

function orderData(over: { total?: number; email?: string | null } = {}) {
  const d = sampleEventData("order.paid") as { customer: Record<string, unknown>; order: Record<string, unknown> };
  if (over.total !== undefined) d.order.total = over.total;
  if (over.email === null) delete d.customer.email;
  else if (over.email) d.customer.email = over.email;
  return d;
}

async function event(externalId = "evt-1", data: Record<string, unknown> = orderData({ total: 150 })) {
  return recordEvent({ workspaceId: ws, storeId: store.id, source: "shopify", eventType: "order.paid", externalId, occurredAt: new Date(), data }, deps);
}

describe("automation engine", () => {
  it("sends one email for a matching event, through Gmail, with the rendered template", async () => {
    await rule();
    const e = await event();
    expect(queues.sent.email).toEqual([{ kind: "email_event", eventId: e.id }]);
    expect(await processBusinessEvent(e.id, deps)).toEqual({ rules: 1, scheduled: 1 });
    const msg = await systemDb.emailMessage.findFirstOrThrow({});
    expect(msg).toMatchObject({ status: "queued", subject: "Thanks for #1001", recipientMasked: "a***x@example.com", provider: "google_workspace" });
    expect(msg.recipientEnc).not.toContain("alex@example.com");
    expect(queues.sent.email[1]).toEqual({ kind: "email_send", messageId: msg.id });
    expect(await sendEmailMessage(msg.id, deps)).toBe("accepted");
    expect(gmailSent).toHaveLength(1);
    expect(gmailSent[0]).toContain("To: alex@example.com");
    expect(gmailSent[0]).toContain('From: "Sales" <sales@shopmail.com>');
    expect(gmailSent[0]).toContain(Buffer.from("<p>Hi Alex</p>").toString("base64"));
    const after = await systemDb.emailMessage.findFirstOrThrow({});
    expect(after).toMatchObject({ status: "accepted_by_provider", providerMessageId: "gm-1", attempts: 1 });
    expect(after.deliveredAt).toBeNull(); // acceptance is not delivery
    // Redelivered job: nothing more.
    expect(await sendEmailMessage(msg.id, deps)).toBe("gone");
    expect(gmailSent).toHaveLength(1);
    const events = await systemDb.emailMessageEvent.findMany({ where: { messageId: msg.id }, orderBy: { eventTimestamp: "asc" } });
    expect(events.map((x) => x.eventType)).toEqual(["queued", "processing", "accepted"]);
  });

  it("sends nothing when conditions don't match or the rule is off", async () => {
    const r = await rule();
    const low = await event("low", orderData({ total: 50 }));
    await processBusinessEvent(low.id, deps);
    expect(await systemDb.emailAutomationExecution.findFirstOrThrow({})).toMatchObject({ status: "skipped", failureReason: "conditions_not_met" });
    await setRuleEnabled(ws, r.id, userId, false);
    const high = await event("high");
    // Nothing listens any more: the event isn't even stored with data.
    expect(await processBusinessEvent(high.id, deps)).toEqual({ rules: 0, scheduled: 0 });
    expect(await systemDb.emailMessage.count()).toBe(0);
  });

  it("never schedules twice for the same event", async () => {
    await rule();
    const a = await event("dup");
    const b = await event("dup");
    expect(b).toEqual({ id: a.id, duplicate: true });
    await processBusinessEvent(a.id, deps);
    await systemDb.emailBusinessEvent.update({ where: { id: a.id }, data: { status: "received" } });
    await processBusinessEvent(a.id, deps);
    expect(await systemDb.emailMessage.count()).toBe(1);
  });

  it("fails safely without a recipient, and doesn't contact a suppressed one", async () => {
    await rule({ conditions: null });
    const none = await event("none", orderData({ email: null }));
    await processBusinessEvent(none.id, deps);
    expect(await systemDb.emailAutomationExecution.findFirstOrThrow({})).toMatchObject({ status: "failed", failureReason: "missing_recipient" });
    await addSuppression({ workspaceId: ws, email: "alex@example.com", reason: "bounced", scope: "all", source: "manual" });
    const sup = await event("sup");
    await processBusinessEvent(sup.id, deps);
    const msg = await systemDb.emailMessage.findFirstOrThrow({});
    expect(msg.status).toBe("suppressed");
    expect(queues.sent.email.filter((j) => j.kind === "email_send")).toHaveLength(0);
    expect(gmailSent).toHaveLength(0);
  });

  it("needs marketing consent for marketing email to a customer", async () => {
    const promo = await createTemplate(ws, userId, { name: "Promo", category: "marketing", eventType: "order.paid", subject: "Sale", html: "<p>Sale</p>", text: "", status: "active" });
    await rule({ templateId: promo.id, conditions: null });
    const d = orderData();
    (d.customer as Record<string, unknown>).accepts_marketing = false;
    await processBusinessEvent((await event("mk", d)).id, deps);
    expect(await systemDb.emailAutomationExecution.findFirstOrThrow({})).toMatchObject({ status: "skipped", failureReason: "no_marketing_consent" });
  });

  it("applies the frequency limit per recipient", async () => {
    await rule({ conditions: null, frequency: { type: "once_per_recipient", windowHours: 24 } });
    await processBusinessEvent((await event("f1")).id, deps);
    await processBusinessEvent((await event("f2")).id, deps);
    expect(await systemDb.emailMessage.count()).toBe(1);
    expect((await systemDb.emailAutomationExecution.findMany({ orderBy: { createdAt: "asc" } }))[1]).toMatchObject({ status: "skipped", failureReason: "frequency_limit" });
  });

  it("waits for a delay, on the queue", async () => {
    await rule({ delayMinutes: 5 });
    await processBusinessEvent((await event()).id, deps);
    const msg = await systemDb.emailMessage.findFirstOrThrow({});
    expect(msg.scheduledAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(queues.sentOpts.email[1]?.delaySeconds).toBeGreaterThanOrEqual(290);
    expect(await sendEmailMessage(msg.id, deps)).toBe("not_due");
    expect(gmailSent).toHaveLength(0);
  });
});

describe("delivery", () => {
  async function queued(extra: Partial<RuleInput> = {}) {
    await rule({ conditions: null, ...extra });
    await processBusinessEvent((await event()).id, deps);
    return systemDb.emailMessage.findFirstOrThrow({});
  }

  it("holds a message at the sending limit without spending an attempt", async () => {
    const msg = await queued();
    const minute = Math.floor(Date.now() / 60_000);
    for (let i = 0; i < 30; i++) await coord.hit(`email:rl:acct:${account.id}:${minute}`, 90);
    expect(await sendEmailMessage(msg.id, deps)).toBe("held");
    const after = await systemDb.emailMessage.findFirstOrThrow({});
    expect(after).toMatchObject({ status: "queued", attempts: 0, lastErrorCode: "rate_limited" });
    expect(after.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect(gmailSent).toHaveLength(0);
  });

  it("retries temporary failures with backoff, then fails visibly", async () => {
    const msg = await queued({ maxAttempts: 2 });
    gmailMode = "503";
    expect(await sendEmailMessage(msg.id, deps)).toBe("deferred");
    let m = await systemDb.emailMessage.findFirstOrThrow({});
    expect(m).toMatchObject({ status: "deferred", attempts: 1, lastErrorCode: "provider_unavailable" });
    expect(m.scheduledAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect((await systemDb.emailAccount.findFirstOrThrow({})).status).toBe("degraded");
    await systemDb.emailMessage.update({ where: { id: msg.id }, data: { scheduledAt: new Date() } });
    expect(await sendEmailMessage(msg.id, deps)).toBe("failed");
    m = await systemDb.emailMessage.findFirstOrThrow({});
    expect(m).toMatchObject({ status: "failed", attempts: 2, lastErrorCode: "retries_exhausted" });
  });

  it("marks a send without an answer unknown and never retries it", async () => {
    const msg = await queued();
    gmailMode = "throw";
    expect(await sendEmailMessage(msg.id, deps)).toBe("unknown");
    expect((await systemDb.emailMessage.findFirstOrThrow({})).status).toBe("unknown");
    expect(await sendEmailMessage(msg.id, deps)).toBe("gone");
  });

  it("refreshes an expired token once, even when two sends race", async () => {
    await systemDb.emailOAuthCredential.updateMany({ data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    const [a, b] = await Promise.all([getValidAccessToken(account, deps), getValidAccessToken(account, deps)]);
    expect(refreshes).toBe(1);
    expect(a).toBe("G_ACCESS_1");
    expect(b).toBe("G_ACCESS_1");
    const cred = await systemDb.emailOAuthCredential.findFirstOrThrow({});
    expect(cred.credentialVersion).toBe(2);
  });

  it("stops and alerts admins when the grant is revoked", async () => {
    const msg = await queued();
    await systemDb.emailOAuthCredential.updateMany({ data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    refreshMode = "invalid_grant";
    expect(await sendEmailMessage(msg.id, deps)).toBe("failed");
    expect((await systemDb.emailMessage.findFirstOrThrow({})).lastErrorCode).toBe("account_reauthorization_required");
    expect(await systemDb.emailAccount.findFirstOrThrow({})).toMatchObject({ status: "reauthorization_required", statusReason: "auth_failed" });
    expect(mailer.sent.some((m) => m.to === "owner@shopmail.com" && /reconnected/.test(m.text))).toBe(true);
    expect(await systemDb.alert.count({ where: { code: `email_account_reauth:${account.id}` } })).toBe(1);
    // Later mail from it waits (up to a day) instead of retrying a dead grant.
    const refreshesBefore = refreshes;
    await processBusinessEvent((await event("later")).id, deps);
    const later = await systemDb.emailMessage.findFirstOrThrow({ where: { status: "queued" } });
    expect(await sendEmailMessage(later.id, deps)).toBe("held");
    expect(refreshes).toBe(refreshesBefore);
  });

  it("keeps Microsoft's rotated refresh token, and the old one when none comes back", async () => {
    const { account: ms } = await connectOAuthAccount({
      workspaceId: ws,
      userId,
      method: "oauth_microsoft",
      identity: { provider: "microsoft_365", providerAccountId: "oid", providerTenantId: "tid", email: "billing@contoso.com", displayName: null },
      tokens: { accessToken: "MS_ACCESS_0", refreshToken: "MS_REFRESH_1", expiresAt: new Date(Date.now() - 1000), scopes: ["Mail.Send"], idToken: null },
    });
    const before = (await systemDb.emailOAuthCredential.findFirstOrThrow({ where: { emailAccountId: ms.id } })).refreshTokenEnc;
    await getValidAccessToken(ms, deps);
    const rotated = (await systemDb.emailOAuthCredential.findFirstOrThrow({ where: { emailAccountId: ms.id } })).refreshTokenEnc;
    expect(rotated).not.toBe(before);
    msRefreshToken = undefined;
    await getValidAccessToken(ms, deps, { forceRefresh: true });
    expect((await systemDb.emailOAuthCredential.findFirstOrThrow({ where: { emailAccountId: ms.id } })).refreshTokenEnc).toBe(rotated);
  });

  it("disconnecting an account cancels what it hadn't sent", async () => {
    const msg = await queued();
    const r = await disconnectEmailAccount(ws, account.id, userId, deps);
    expect(r.messagesCancelled).toBe(1);
    expect(await sendEmailMessage(msg.id, deps)).toBe("gone");
    expect((await systemDb.emailMessage.findFirstOrThrow({})).status).toBe("cancelled");
  });

  it("runs through the queue consumer", async () => {
    const msg = await queued();
    let acked = false;
    const m: QueueMessage = { id: "q1", body: { kind: "email_send", messageId: msg.id }, attempts: 1, ack: () => (acked = true), retry: () => undefined };
    await consume("email", m, deps);
    expect(acked).toBe(true);
    expect(gmailSent).toHaveLength(1);
  });
});

describe("Shopify events", () => {
  const order = { id: 501, name: "#1501", order_number: 1501, email: "Buyer@Example.com", total_price: "180.00", subtotal_price: "170.00", currency: "USD", financial_status: "paid", line_items: [{ title: "Lamp", quantity: 2 }], customer: { first_name: "Bo", email_marketing_consent: { state: "subscribed" } }, checkout_token: "ck-1" };

  it("records a listened-to order event once, normalized and encrypted", async () => {
    await rule({ conditions: null });
    await emailOnShopifyEvent(store, "orders/paid", order, deps);
    await emailOnShopifyEvent(store, "orders/paid", order, deps); // Shopify retried
    await emailOnShopifyEvent(store, "orders/create", order, deps); // nothing listens to order.created
    const events = await systemDb.emailBusinessEvent.findMany({});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "order.paid", storeId: store.id, status: "received" });
    expect(events[0]!.payloadEnc).not.toContain("Buyer");
    await processBusinessEvent(events[0]!.id, deps);
    const msg = await systemDb.emailMessage.findFirstOrThrow({});
    expect(msg).toMatchObject({ subject: "Thanks for #1501", recipientMasked: "b***r@example.com", storeId: store.id });
  });

  it("detects an abandoned checkout, and forgets one that became an order", async () => {
    const tpl = await createTemplate(ws, userId, { name: "Cart", category: "transactional", eventType: "checkout.abandoned", subject: "You left {{checkout.item_count}} items", html: "<p>x</p>", text: "", status: "active" });
    await rule({ eventType: "checkout.abandoned", templateId: tpl.id, conditions: null });
    const checkout = (token: string) => ({ token, email: "cart@example.com", total_price: "40.00", presentment_currency: "USD", line_items: [{ title: "Mug", quantity: 2 }], abandoned_checkout_url: "https://shop.myshopify.com/recover/x", updated_at: new Date().toISOString() });
    await emailOnShopifyEvent(store, "checkouts/update", checkout("ck-1"), deps);
    await emailOnShopifyEvent(store, "checkouts/update", checkout("ck-2"), deps);
    expect(await systemDb.emailBusinessEvent.count({ where: { status: "pending_detection" } })).toBe(2);
    // ck-1 became an order.
    await emailOnShopifyEvent(store, "orders/create", { ...order, checkout_token: "ck-1" }, deps);
    // Nothing yet: the hour hasn't passed.
    expect(await promoteAbandonedCheckouts(deps)).toBe(0);
    expect(await promoteAbandonedCheckouts(deps, new Date(Date.now() + 2 * 3600_000))).toBe(1);
    const abandoned = await systemDb.emailBusinessEvent.findFirstOrThrow({ where: { status: "received" } });
    expect(abandoned.externalId).toContain("ck-2");
    expect((await systemDb.emailBusinessEvent.findFirstOrThrow({ where: { externalId: { contains: "ck-1" } } })).status).toBe("cancelled");
    await processBusinessEvent(abandoned.id, deps);
    expect((await systemDb.emailMessage.findFirstOrThrow({})).subject).toBe("You left 2 items");
  });

  describe("payloads that don't fit", () => {
    // Checked against core's automation schemas once an automation listens: what doesn't fit is
    // logged by field (never by value) and skipped, since a retry would read the same payload.
    let warnings: Array<Record<string, unknown>>;
    let prevLevel: string | undefined;
    beforeEach(() => {
      warnings = [];
      prevLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = "warn";
      vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
        if (String(line).startsWith("{")) warnings.push(JSON.parse(String(line)) as Record<string, unknown>);
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      process.env.LOG_LEVEL = prevLevel;
    });

    it("an order nothing listens to isn't read; one a rule listens to but can't read is skipped, not failed", async () => {
      const unreadable = { ...order, updated_at: "later" };
      await emailOnShopifyEvent(store, "orders/paid", unreadable, deps);
      expect(warnings).toEqual([]);

      await rule({ conditions: null });
      // Before the schema this became an Invalid Date, which the database refused: the webhook failed and retried.
      await emailOnShopifyEvent(store, "orders/paid", unreadable, deps);
      expect(await systemDb.emailBusinessEvent.count()).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ payload: "orders/paid", module: "email", storeId: store.id, problems: ["updated_at: not a timestamp"] });
      expect(JSON.stringify(warnings)).not.toContain("Buyer");

      await emailOnShopifyEvent(store, "orders/paid", order, deps);
      expect(await systemDb.emailBusinessEvent.count()).toBe(1);
    });

    it("an order or a completed checkout ends the watch for abandonment even when the rest can't be read", async () => {
      const tpl = await createTemplate(ws, userId, { name: "Cart", category: "transactional", eventType: "checkout.abandoned", subject: "Cart", html: "<p>x</p>", text: "", status: "active" });
      await rule({ eventType: "checkout.abandoned", templateId: tpl.id, conditions: null });
      const checkout = (token: string, over: Record<string, unknown> = {}) => ({ token, email: "cart@example.com", total_price: "40.00", line_items: [{ title: "Mug", quantity: 2 }], updated_at: new Date().toISOString(), ...over });
      await emailOnShopifyEvent(store, "checkouts/update", checkout("ck-1"), deps);
      await emailOnShopifyEvent(store, "checkouts/update", checkout("ck-2"), deps);
      expect(await systemDb.emailBusinessEvent.count({ where: { status: "pending_detection" } })).toBe(2);

      await emailOnShopifyEvent(store, "checkouts/update", checkout("ck-1", { completed_at: new Date().toISOString(), total_price: "a lot" }), deps);
      await emailOnShopifyEvent(store, "orders/create", { ...order, checkout_token: "ck-2", line_items: "lots" }, deps);
      expect(await systemDb.emailBusinessEvent.count({ where: { status: "cancelled" } })).toBe(2);
      expect(warnings).toEqual([]);

      // A checkout still open that can't be read is skipped, with a warning.
      await emailOnShopifyEvent(store, "checkouts/update", checkout("ck-3", { total_price: "a lot" }), deps);
      expect(await systemDb.emailBusinessEvent.count({ where: { status: "pending_detection" } })).toBe(0);
      expect(warnings.map((w) => w.problems)).toEqual([["total_price: not an amount"]]);
    });
  });
});

describe("sweep", () => {
  it("marks a send cut off mid-way unknown and re-queues lost jobs", async () => {
    await rule({ conditions: null });
    await processBusinessEvent((await event()).id, deps);
    const msg = await systemDb.emailMessage.findFirstOrThrow({});
    await systemDb.emailMessage.update({ where: { id: msg.id }, data: { status: "processing", processingStartedAt: new Date(Date.now() - 20 * 60_000) } });
    const lost = await event("lost");
    await systemDb.emailBusinessEvent.update({ where: { id: lost.id }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    queues.clear();
    const r = await sweepEmail(deps);
    expect(r.interrupted).toBe(1);
    expect(r.events).toBe(1);
    expect((await systemDb.emailMessage.findFirstOrThrow({ where: { id: msg.id } })).status).toBe("unknown");
    expect(queues.sent.email).toContainEqual({ kind: "email_event", eventId: lost.id });
  });

  it("refreshes OAuth accounts nobody has used for a week", async () => {
    await systemDb.emailOAuthCredential.updateMany({ data: { lastRefreshedAt: new Date(Date.now() - 8 * 86_400_000) } });
    const r = await sweepEmail(deps);
    expect(r.refreshed).toBe(1);
    expect(refreshes).toBe(1);
  });
});
