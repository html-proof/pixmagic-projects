import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, type ZapierHook } from "@app/db";
import { resetDb } from "@app/db/testing";
import { applyMessageStatus, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, resetEnvCache, type FetchLike } from "@app/core";
import { checkZapierThresholds, deliverZapier, maybeSendAdsDailySummary, recordZapierEvent, sweepZapier, zapierAfterAdSync, type ZapierJob } from "@app/core/zapier";
import { ZAPIER_MAX_ATTEMPTS } from "@app/shared/zapier";
import type { WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * Zapier's outbox delivered by the worker (docs/zapier.md): the delivery jobs on the sync queue, their
 * retries and outcomes, and the advertising triggers worked out from stored figures. Zapier itself is
 * a fake fetch; real Postgres.
 */

const queues = memoryQueues();
const coord = memoryCoord();
const HOOK = "https://hooks.zapier.com/hooks/standard/1/abc/";
let answers: Array<Response | Error> = [];
let calls: Array<{ url: string; init: RequestInit }> = [];
const fetchImpl = (async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
  calls.push({ url: String(input), init: init ?? {} });
  const next = answers.shift() ?? new Response("ok", { status: 200 });
  if (next instanceof Error) throw next;
  return next;
}) as FetchLike;
const deps: WorkerDeps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl };

function setEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars);
  resetEnvCache();
}

beforeAll(() => setEnv({ ZAPIER_CLIENT_ID: "zap-test", ZAPIER_CLIENT_SECRET: "zap-test-secret-0123456789012345678901234567", ZAPIER_REDIRECT_URI: "https://zapier.com/dashboard/auth/oauth/return/App1CLIAPI/" }));
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  answers = [];
  calls = [];
});

let n = 0;
/** A workspace, its store, a member (an owner unless `permissions` says otherwise), their Zapier connection and one trigger. */
async function world(event: string, inputs: Record<string, unknown> = {}, opts: { permissions?: string[]; timezone?: string } = {}) {
  n++;
  const user = await systemDb.user.create({ data: { email: `member${n}@zap.test` } });
  const ws = await systemDb.workspace.create({ data: { name: `Zap ${n}` } });
  const membership = await systemDb.membership.create({
    data: { workspaceId: ws.id, userId: user.id, role: opts.permissions ? "manager" : "owner", permissions: opts.permissions ?? [] },
  });
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `zap${n}.myshopify.com`, name: `Zap Store ${n}`, status: "active", timezone: opts.timezone ?? "UTC", currency: "AUD", grantedScopes: [] } });
  const grant = await systemDb.zapierGrant.create({ data: { workspaceId: ws.id, storeId: store.id, userId: user.id, clientId: "zap-test" } });
  const hook = await systemDb.zapierHook.create({ data: { workspaceId: ws.id, storeId: store.id, grantId: grant.id, event, targetUrl: HOOK, inputs: inputs as never } });
  return { user, ws, membership, store, grant, hook };
}

async function alertEvent(w: { ws: { id: string }; store: { id: string } }, key = "a1") {
  return recordZapierEvent({ workspaceId: w.ws.id, storeId: w.store.id, event: "alert_raised", dedupeKey: `alert_raised:${key}:${w.store.id}`, data: { alert_id: key, area: "shopify", title: "Couldn't sync your orders" } }, queues);
}
const onlyDelivery = () => systemDb.zapierDelivery.findFirstOrThrow();
const zapierJobs = () => queues.sent.sync.filter((j) => (j as unknown as ZapierJob).kind === "zapier") as unknown as ZapierJob[];

function message(body: ZapierJob, attempts = 1): QueueMessage & { acked: boolean; retried: boolean } {
  const m = { id: "m1", body, attempts, acked: false, retried: false, ack: () => (m.acked = true), retry: () => (m.retried = true) };
  return m;
}

describe("delivering an event to a Zap", () => {
  it("posts the envelope to Zapier's address once, without following redirects, and marks it delivered", async () => {
    const w = await world("alert_raised");
    expect(await alertEvent(w)).toBe(1);
    const [job] = zapierJobs();
    expect(job).toBeDefined();
    const msg = message(job!);
    await consume("sync", msg, deps);
    expect(msg.acked).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(HOOK);
    expect(calls[0]!.init.redirect).toBe("manual");
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({ id: `alert_raised:a1:${w.store.id}`, event: "alert_raised", store: { id: w.store.id, name: w.store.name }, data: { title: "Couldn't sync your orders" } });
    const d = await onlyDelivery();
    expect(d).toMatchObject({ status: "delivered", attempts: 1, responseStatus: 200, errorCode: null });
    expect((await systemDb.zapierHook.findUniqueOrThrow({ where: { id: w.hook.id } })).lastDeliveredAt).not.toBeNull();
    // The same message again (SQS delivers at least once): nothing is sent twice.
    await consume("sync", message(job!), deps);
    expect(calls).toHaveLength(1);
  });

  it("writes one event per happening and one delivery per trigger, however often it is reported", async () => {
    const w = await world("alert_raised");
    await systemDb.zapierHook.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, grantId: w.grant.id, event: "alert_raised", targetUrl: `${HOOK}2/` } });
    expect(await alertEvent(w)).toBe(2);
    expect(await alertEvent(w)).toBe(0);
    expect(await systemDb.zapierEvent.count()).toBe(1);
    expect(await systemDb.zapierDelivery.count()).toBe(2);
    // Another store's trigger never gets it.
    const other = await world("alert_raised");
    expect(await systemDb.zapierDelivery.count({ where: { hookId: other.hook.id } })).toBe(0);
  });

  it("retries a 5xx with backoff (no attempt spent by the queue), then gives up after the most attempts", async () => {
    const w = await world("alert_raised");
    await alertEvent(w);
    const d0 = await onlyDelivery();
    answers = [new Response("bad gateway", { status: 502 })];
    const before = Date.now();
    expect(await deliverZapier(d0.id, deps)).toBe("retrying");
    const d1 = await onlyDelivery();
    expect(d1).toMatchObject({ status: "retrying", attempts: 1, errorCode: "server_error", responseStatus: 502 });
    const wait = (d1.nextAttemptAt.getTime() - before) / 1000;
    expect(wait).toBeGreaterThanOrEqual(23);
    expect(wait).toBeLessThanOrEqual(37);
    const retry = queues.sentOpts.sync.at(-1);
    expect(retry?.delaySeconds).toBeGreaterThanOrEqual(24);
    // Not due yet: a copy of the message does nothing.
    expect(await deliverZapier(d0.id, deps)).toBe("skipped");

    // A timeout counts the same; at the last attempt it is marked failed for good.
    await systemDb.zapierDelivery.update({ where: { id: d0.id }, data: { nextAttemptAt: new Date(), attempts: ZAPIER_MAX_ATTEMPTS - 1 } });
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    answers = [timeout];
    expect(await deliverZapier(d0.id, deps)).toBe("failed");
    expect(await onlyDelivery()).toMatchObject({ status: "failed", attempts: ZAPIER_MAX_ATTEMPTS, errorCode: "timeout" });
    expect(await deliverZapier(d0.id, deps)).toBe("skipped");
  });

  it("deletes the trigger when Zapier answers 410 (its REST hook convention)", async () => {
    const w = await world("alert_raised");
    await alertEvent(w, "a1");
    await alertEvent(w, "a2");
    const [first] = await systemDb.zapierDelivery.findMany({ orderBy: { createdAt: "asc" } });
    answers = [new Response("gone", { status: 410 })];
    expect(await deliverZapier(first!.id, deps)).toBe("cancelled");
    expect(await systemDb.zapierHook.count()).toBe(0);
    const all = await systemDb.zapierDelivery.findMany();
    expect(all.map((d) => [d.status, d.errorCode])).toEqual([
      ["cancelled", "hook_gone"],
      ["cancelled", "hook_gone"],
    ]);
  });

  it("fails at once on a refusal or a redirect, which a retry would only meet again", async () => {
    const w = await world("alert_raised");
    await alertEvent(w, "a1");
    await alertEvent(w, "a2");
    const [a, b] = await systemDb.zapierDelivery.findMany({ orderBy: { createdAt: "asc" } });
    answers = [new Response("", { status: 400 }), new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } })];
    expect(await deliverZapier(a!.id, deps)).toBe("failed");
    expect(await deliverZapier(b!.id, deps)).toBe("failed");
    expect((await systemDb.zapierDelivery.findMany({ orderBy: { createdAt: "asc" } })).map((d) => d.errorCode)).toEqual(["rejected", "redirect_refused"]);
    expect(calls).toHaveLength(2);
  });

  it("sends nothing once the member behind the connection lost access, or the connection was revoked", async () => {
    const w = await world("alert_raised");
    await alertEvent(w, "a1");
    await alertEvent(w, "a2");
    const [a, b] = await systemDb.zapierDelivery.findMany({ orderBy: { createdAt: "asc" } });
    await systemDb.membership.update({ where: { id: w.membership.id }, data: { revokedAt: new Date() } });
    expect(await deliverZapier(a!.id, deps)).toBe("failed");
    expect((await systemDb.zapierDelivery.findUniqueOrThrow({ where: { id: a!.id } })).errorCode).toBe("authorizer_no_access");
    await systemDb.zapierGrant.update({ where: { id: w.grant.id }, data: { revokedAt: new Date() } });
    expect(await deliverZapier(b!.id, deps)).toBe("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("keeps at most three deliveries per store in flight: a fourth comes back later, spending nothing", async () => {
    const w = await world("alert_raised");
    await alertEvent(w);
    const d = await onlyDelivery();
    for (let i = 0; i < 3; i++) expect(await coord.acquire(`zapier:slot:${w.store.id}:${i}`, 60_000)).toBe(true);
    queues.clear();
    expect(await deliverZapier(d.id, deps)).toBe("deferred");
    expect(await onlyDelivery()).toMatchObject({ status: "pending", attempts: 0 });
    expect(zapierJobs()).toHaveLength(1);
    await coord.release(`zapier:slot:${w.store.id}:1`);
    expect(await deliverZapier(d.id, deps)).toBe("delivered");
  });

  it("the sweep sends what no message carries and picks up attempts cut short", async () => {
    const w = await world("alert_raised");
    // Written without a queue at hand (raiseAlert outside a job): pending, never queued.
    await recordZapierEvent({ workspaceId: w.ws.id, storeId: w.store.id, event: "alert_raised", dedupeKey: "k1", data: { area: "shopify" } });
    const d = await onlyDelivery();
    expect(d.enqueuedAt).toBeNull();
    const stuck = (await world("alert_raised")).store;
    await recordZapierEvent({ workspaceId: (await systemDb.store.findUniqueOrThrow({ where: { id: stuck.id } })).workspaceId, storeId: stuck.id, event: "alert_raised", dedupeKey: "k2", data: { area: "shopify" } });
    await systemDb.zapierDelivery.updateMany({ where: { storeId: stuck.id }, data: { status: "delivering", lastAttemptAt: new Date(Date.now() - 10 * 60_000), attempts: 1 } });
    queues.clear();
    const r = await sweepZapier(deps);
    expect(r).toMatchObject({ unstuck: 1, queued: 2 });
    expect(zapierJobs().map((j) => j.deliveryId).sort()).toEqual((await systemDb.zapierDelivery.findMany({ select: { id: true } })).map((x) => x.id).sort());
    // Queued now: the next sweep leaves them to their messages.
    queues.clear();
    expect((await sweepZapier(deps)).queued).toBe(0);
  });

  it("an attempt cut short on its last try is failed by the sweep, not tried a ninth time", async () => {
    const w = await world("alert_raised");
    await alertEvent(w);
    await systemDb.zapierDelivery.updateMany({ data: { status: "delivering", lastAttemptAt: new Date(Date.now() - 10 * 60_000), attempts: ZAPIER_MAX_ATTEMPTS } });
    queues.clear();
    expect((await sweepZapier(deps)).unstuck).toBe(0);
    expect(await onlyDelivery()).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(zapierJobs()).toHaveLength(0);
  });

  it("leaves Shopify's sales out of the daily summary for someone who can't see them", async () => {
    const w = await world("ads_daily_summary", {}, { permissions: ["integrations.status", "integrations.manage", "marketing.ads"] });
    await recordZapierEvent({ workspaceId: w.ws.id, storeId: w.store.id, event: "ads_daily_summary", dedupeKey: "s1", data: { day: "2026-10-27", platforms: [], shopify: { net_sales: 1234.5 } } }, queues);
    await deliverZapier((await onlyDelivery()).id, deps);
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.data.shopify).toBeNull();
    expect(String(calls[0]!.init.body)).not.toContain("1234.5");
  });
});

describe("the advertising triggers", () => {
  async function account(w: { ws: { id: string }; store: { id: string } }, provider: string, accountId: string, currency: string, extra: Record<string, unknown> = {}) {
    return systemDb.adConnection.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, provider, accountId, currency, accessTokenEnc: "x", tokenKeyVersion: 1, lastSyncedAt: new Date(), ...extra } });
  }
  async function spend(c: { id: string; workspaceId: string; storeId: string; provider: string; accountId: string; currency: string | null }, day: string, amount: number) {
    await systemDb.adCampaignDaily.upsert({
      where: { connectionId_campaignId_day: { connectionId: c.id, campaignId: "c1", day } },
      create: { workspaceId: c.workspaceId, storeId: c.storeId, connectionId: c.id, provider: c.provider, accountId: c.accountId, campaignId: "c1", campaignName: "Camp", day, spend: amount, currency: c.currency },
      update: { spend: amount },
    });
  }
  const NOW = new Date("2026-10-28T09:00:00Z");

  it("ad spend: fires once per period when the stored spend reaches the amount, after a sync", async () => {
    const w = await world("ad_spend_threshold", { platform: "meta", period: "month", amount: 500 });
    const meta = await account(w, "meta", "act_1", "AUD");
    await spend(meta, "2026-10-02", 300);
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    await spend(meta, "2026-10-27", 250);
    await zapierAfterAdSync(meta.id, { queues }, NOW);
    const events = await systemDb.zapierEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]!.dedupeKey).toBe(`ad_spend_threshold:${w.hook.id}:2026-10`);
    expect((events[0]!.payload as { data: Record<string, unknown> }).data).toMatchObject({ period: "2026-10", spend: 550, currency: "AUD", period_complete: false, trigger: { platform: "meta", period: "month", amount: 500 } });
    // Later syncs in the same month: no second event.
    await spend(meta, "2026-10-28", 100);
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    expect(await systemDb.zapierEvent.count()).toBe(1);
    // Google's spend isn't Meta's.
    const google = await world("ad_spend_threshold", { platform: "google", period: "day", amount: 1 });
    await spend(await account(google, "meta", "act_2", "AUD"), "2026-10-28", 999);
    expect(await checkZapierThresholds(google.store.id, queues, NOW)).toBe(0);
  });

  it("never adds up two currencies: the trigger isn't checked, and says why", async () => {
    const w = await world("ad_spend_threshold", { platform: "any", period: "day", amount: 10 });
    await spend(await account(w, "meta", "act_1", "AUD"), "2026-10-28", 50);
    await spend(await account(w, "google", "123", "USD"), "2026-10-28", 50);
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    const hook = (await systemDb.zapierHook.findUniqueOrThrow({ where: { id: w.hook.id } })) as ZapierHook;
    expect(hook.checkNote).toBe("mixed_currencies:AUD,USD");
  });

  it("leaves the Google Ads demo out: its figures are generated", async () => {
    const w = await world("ad_spend_threshold", { platform: "google", period: "day", amount: 1 });
    const demo = await account(w, "google", "demo", "USD", { isDemo: true, demoSeed: 1 });
    await spend(demo, "2026-10-28", 500);
    await zapierAfterAdSync(demo.id, { queues }, NOW);
    expect(await systemDb.zapierEvent.count()).toBe(0);
  });

  it("AdSense earnings: the same once per period, saying they are Google's estimates", async () => {
    const w = await world("adsense_earnings_threshold", { period: "day", amount: 20 });
    const c = await account(w, "adsense", "pub-1", "AUD");
    await systemDb.adsenseDaily.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, connectionId: c.id, accountId: "pub-1", site: "", day: "2026-10-28", earnings: 25.5, currency: "AUD" } });
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(1);
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    const data = ((await systemDb.zapierEvent.findFirstOrThrow()).payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ earnings_estimated: 25.5, currency: "AUD" });
    expect(String(data.estimates_note)).toMatch(/estimates/);
  });

  it("the daily summary goes once yesterday is in for every account, with Shopify's sales apart from the platforms' attribution", async () => {
    const w = await world("ads_daily_summary");
    const meta = await account(w, "meta", "act_1", "AUD", { syncedThrough: "2026-10-26" });
    await systemDb.adCampaignDaily.create({
      data: { workspaceId: w.ws.id, storeId: w.store.id, connectionId: meta.id, provider: "meta", accountId: "act_1", campaignId: "c1", campaignName: "C", day: "2026-10-27", spend: 40, impressions: 900, clicks: 30, conversions: 2, purchases: 2, purchaseValue: 160, currency: "AUD" },
    });
    await systemDb.dailyStoreMetrics.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, day: "2026-10-27", grossSales: 500, discounts: 20, refunds: 30, totalSales: 520, orders: 7 } });
    // 09:00 at the store and the account's 27th isn't stored yet: wait.
    expect(await maybeSendAdsDailySummary(w.store.id, queues, NOW)).toBe(false);
    await systemDb.adConnection.update({ where: { id: meta.id }, data: { syncedThrough: "2026-10-27" } });
    expect(await maybeSendAdsDailySummary(w.store.id, queues, NOW)).toBe(true);
    expect(await maybeSendAdsDailySummary(w.store.id, queues, NOW)).toBe(false);
    const data = ((await systemDb.zapierEvent.findFirstOrThrow()).payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      day: "2026-10-27",
      platforms: [{ platform: "meta", spend: 40, impressions: 900, clicks: 30, conversions: 2, platform_attributed_purchase_value: 160, platform_attributed_roas: 4 }],
      shopify: { net_sales: 450, total_sales: 520, orders: 7, currency: "AUD" },
      accounts_without_the_day: [],
    });
  });
});

describe("WhatsApp messages that fail", () => {
  it("become one event with the customer's number masked, never in full", async () => {
    const w = await world("whatsapp_message_failed", {}, { permissions: ["integrations.status", "integrations.manage", "marketing.campaigns"] });
    const conn = { id: "conn-1", storeId: w.store.id, workspaceId: w.ws.id };
    const m = await systemDb.wappMessage.create({
      data: { workspaceId: w.ws.id, storeId: w.store.id, connectionId: conn.id, providerMessageId: "wamid-1", source: "automation", type: "text", status: "sent", phoneMasked: "+61 4•• ••• 678", phoneEnc: "enc", phoneHash: "hash" },
    });
    expect(await applyMessageStatus(conn, { providerMessageId: "wamid-1", status: "FAILED", at: NOW_WA })).toBe("failed");
    // Reported again: still one event.
    await applyMessageStatus(conn, { providerMessageId: "wamid-1", status: "ERROR", at: NOW_WA });
    const events = await systemDb.zapierEvent.findMany();
    expect(events).toHaveLength(1);
    const data = (events[0]!.payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ message_id: m.id, phone_masked: "+61 4•• ••• 678", reason: "provider_rejected", reason_text: "WhatsApp refused it", source: "automation" });
    expect(JSON.stringify(events[0]!.payload)).not.toMatch(/enc|hash/);
  });
});

const NOW_WA = new Date("2026-10-28T10:00:00Z");
