import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, type ZapierHook } from "@app/db";
import { resetDb } from "@app/db/testing";
import { applyMessageStatus, audit, encryptTokenFields, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, resetEnvCache, type FetchLike } from "@app/core";
import {
  checkZapierThresholds,
  deliverZapier,
  maybeSendAdsDailySummary,
  recordZapierEvent,
  retryZapierDelivery,
  sweepZapier,
  unsubscribeZapierHook,
  zapierAfterAdSync,
  zapierAfterMarketingRead,
  type ZapierJob,
} from "@app/core/zapier";
import { ZAPIER_MAX_ATTEMPTS } from "@app/shared/zapier";
import { processWebhook, type WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";
import { salesAnswer } from "./shopifySales.js";

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
  // Shopify, asked for an order's sales by the orders/paid webhook: none stored there.
  const sales = salesAnswer(input, init);
  if (sales) return sales;
  calls.push({ url: String(input), init: init ?? {} });
  const next = answers.shift() ?? new Response("ok", { status: 200 });
  if (next instanceof Error) throw next;
  return next;
}) as FetchLike;
const mailer = memoryMailer();
const deps: WorkerDeps = { coord, queues, payloads: memoryBlobs(), mailer, fetchImpl };

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
  mailer.sent.length = 0;
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
    expect(sent).toMatchObject({ id: `alert_raised:a1:${w.store.id}`, event: "alert_raised", schema_version: 1, store: { id: w.store.id, name: w.store.name }, data: { title: "Couldn't sync your orders" } });
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
    // (The "Some events didn't reach Zapier" alert they raise is a third, for the same "New alert" Zap.)
    expect((await systemDb.zapierDelivery.findMany({ where: { id: { in: [a!.id, b!.id] } }, orderBy: { createdAt: "asc" } })).map((d) => d.errorCode)).toEqual(["rejected", "redirect_refused"]);
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

  it("AdSense earnings count only the sites chosen for the store, as the dashboard does", async () => {
    const w = await world("adsense_earnings_threshold", { period: "day", amount: 20 });
    const c = await account(w, "adsense", "pub-2", "AUD", { sites: ["shop.example.com"] });
    const day = (site: string, earnings: number) =>
      systemDb.adsenseDaily.upsert({
        where: { connectionId_site_day: { connectionId: c.id, site, day: "2026-10-28" } },
        create: { workspaceId: w.ws.id, storeId: w.store.id, connectionId: c.id, accountId: "pub-2", site, day: "2026-10-28", earnings, currency: "AUD" },
        update: { earnings },
      });
    // Another site's earnings, and a day AdSense didn't split by site, aren't the store's: 15 counted, not 85.
    await day("shop.example.com", 15);
    await day("other.example.com", 30);
    await day("", 40);
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    await day("shop.example.com", 25);
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(1);
    const data = ((await systemDb.zapierEvent.findFirstOrThrow()).payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ earnings_estimated: 25, currency: "AUD" });
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

describe("ad spend reported to Shopify, for a platform without an ad account here", () => {
  const NOW = new Date("2026-10-28T09:00:00Z");
  /** A row of shopify_marketing_days: a channel's whole day, or (`campaign`) its part of it. */
  async function reported(w: { ws: { id: string }; store: { id: string } }, day: string, app: string, spend: number | null, extra: { campaign?: string; impressions?: number; clicks?: number; orders?: number; sales?: number } = {}) {
    const { campaign = "", impressions = null, clicks = null, orders = null, sales = null } = extra;
    await systemDb.shopifyMarketingDay.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, day, channel: app, app, campaign, spend, impressions, clicks, orders, sales, currency: "AUD", fetchedAt: NOW } });
  }
  /** The store granted its reports, and Shopify's marketing report is read from August up to `through`. */
  async function readThrough(w: { ws: { id: string }; store: { id: string } }, through: string, opts: { lastError?: string; lastSyncedAt?: Date | null } = {}) {
    await systemDb.store.update({ where: { id: w.store.id }, data: { grantedScopes: ["read_orders", "read_reports"] } });
    const row = { coveredFrom: "2026-08-01", syncedThrough: through, lastSyncedAt: opts.lastSyncedAt === undefined ? new Date("2026-10-28T06:00:00Z") : opts.lastSyncedAt, lastError: opts.lastError ?? null };
    await systemDb.shopifyMarketingSync.upsert({ where: { storeId: w.store.id }, create: { storeId: w.store.id, workspaceId: w.ws.id, ...row }, update: row });
  }
  async function account(w: { ws: { id: string }; store: { id: string } }, provider: string, accountId: string, extra: Record<string, unknown> = {}) {
    return systemDb.adConnection.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, provider, accountId, currency: "AUD", accessTokenEnc: "x", tokenKeyVersion: 1, lastSyncedAt: new Date(), ...extra } });
  }
  const eventData = async () => ((await systemDb.zapierEvent.findFirstOrThrow()).payload as { data: Record<string, unknown> }).data;

  it("a threshold with no ad account counts what Google's app reported to Shopify: whole days read only, once the reports are granted", async () => {
    const w = await world("ad_spend_threshold", { platform: "any", period: "month", amount: 100 });
    await reported(w, "2026-10-26", "Google & YouTube", 60, { clicks: 30, sales: 200 });
    await reported(w, "2026-10-27", "Google & YouTube", 50);
    // A campaign's row is part of its channel's day: never counted again.
    await reported(w, "2026-10-27", "Google & YouTube", 50, { campaign: "Summer sale" });
    // A channel that reported clicks but no spend has no spend, never a 0.
    await reported(w, "2026-10-27", "Facebook & Instagram", null, { clicks: 9 });
    // The store hasn't granted its reports: nothing of Shopify's counts.
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    // Read only up to the 26th: the 27th isn't known yet, so 60 so far.
    await readThrough(w, "2026-10-26");
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    expect(await systemDb.zapierEvent.count()).toBe(0);
    // The next read reaches today: checked after it, as the worker does after each read.
    await readThrough(w, "2026-10-28");
    await zapierAfterMarketingRead(w.store.id, { queues }, NOW);
    expect(await systemDb.zapierEvent.count()).toBe(1);
    const data = await eventData();
    expect(data).toMatchObject({
      period: "2026-10",
      spend: 110,
      currency: "AUD",
      accounts: [],
      platforms: [{ platform: "google", name: "Google Ads", source: "shopify_marketing", spend: 110, currency: "AUD", reported_by: ["Google & YouTube"], data_through: "2026-10-28", last_synced_at: "2026-10-28T06:00:00.000Z" }],
      last_successful_sync_at: "2026-10-28T06:00:00.000Z",
    });
    expect(String(data.shopify_marketing_note)).toMatch(/reported to Shopify/);
    // Once per trigger and period, wherever the spend came from.
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
  });

  it("never counts a platform's spend twice: its own API's while its account syncs, Shopify's only without one", async () => {
    const w = await world("ad_spend_threshold", { platform: "any", period: "day", amount: 50 });
    const meta = await account(w, "meta", "act_1", { syncedThrough: "2026-10-28" });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, connectionId: meta.id, provider: "meta", accountId: "act_1", campaignId: "c1", campaignName: "C", day: "2026-10-28", spend: 40, currency: "AUD" } });
    // What Meta's app told Shopify about the same ads: not added to Meta's own figures.
    await reported(w, "2026-10-28", "Facebook & Instagram", 35);
    await reported(w, "2026-10-28", "Google & YouTube", 20);
    await readThrough(w, "2026-10-28");
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(1);
    const data = await eventData();
    expect(data).toMatchObject({ spend: 60, accounts: [{ platform: "meta", account_id: "act_1", spend: 40 }] });
    expect(data.platforms).toEqual([
      expect.objectContaining({ platform: "meta", source: "platform_api", spend: 40 }),
      expect.objectContaining({ platform: "google", source: "shopify_marketing", spend: 20 }),
    ]);
    // Only Meta asked: Shopify's Meta spend still isn't counted next to its own account's.
    const metaOnly = await world("ad_spend_threshold", { platform: "meta", period: "day", amount: 41 });
    const own = await account(metaOnly, "meta", "act_2", { syncedThrough: "2026-10-28" });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: metaOnly.ws.id, storeId: metaOnly.store.id, connectionId: own.id, provider: "meta", accountId: "act_2", campaignId: "c1", campaignName: "C", day: "2026-10-28", spend: 40, currency: "AUD" } });
    await reported(metaOnly, "2026-10-28", "Facebook & Instagram", 35);
    await readThrough(metaOnly, "2026-10-28");
    expect(await checkZapierThresholds(metaOnly.store.id, queues, NOW)).toBe(0);
  });

  it("an account whose access ended before the dates gives way to what its app reported to Shopify", async () => {
    const w = await world("ad_spend_threshold", { platform: "meta", period: "day", amount: 30 });
    await account(w, "meta", "act_9", { status: "reconnect", syncedThrough: "2026-09-30" });
    await reported(w, "2026-10-28", "Facebook & Instagram", 35);
    await readThrough(w, "2026-10-28");
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(1);
    expect(await eventData()).toMatchObject({ spend: 35, accounts: [], platforms: [{ platform: "meta", source: "shopify_marketing", spend: 35 }] });
  });

  it("the daily summary of a store with no ad account goes once Shopify's report is read through yesterday", async () => {
    const w = await world("ads_daily_summary");
    await reported(w, "2026-10-27", "Google & YouTube", 25, { impressions: 800, clicks: 40, orders: 2, sales: 90 });
    // Reports not granted: nothing to send, nor to wait for.
    expect(await maybeSendAdsDailySummary(w.store.id, queues, NOW)).toBe(false);
    // Read up to the 26th, at 09:00 at the store: wait for the next read.
    await readThrough(w, "2026-10-26");
    expect(await maybeSendAdsDailySummary(w.store.id, queues, NOW)).toBe(false);
    await readThrough(w, "2026-10-28");
    expect(await maybeSendAdsDailySummary(w.store.id, queues, NOW)).toBe(true);
    expect(await maybeSendAdsDailySummary(w.store.id, queues, NOW)).toBe(false);
    const data = await eventData();
    expect(data).toMatchObject({
      day: "2026-10-27",
      platforms: [
        {
          platform: "google",
          name: "Google Ads",
          source: "shopify_marketing",
          spend: 25,
          currency: "AUD",
          impressions: 800,
          clicks: 40,
          conversions: 2,
          platform_attributed_purchase_value: 90,
          platform_attributed_roas: 3.6,
          accounts: [],
          reported_by: ["Google & YouTube"],
        },
      ],
      accounts_without_the_day: [],
    });
    expect(String(data.shopify_marketing_note)).toMatch(/reported to Shopify/);
  });

  it("isn't held for Shopify's report while its reads are refused", async () => {
    const w = await world("ads_daily_summary");
    const meta = await account(w, "meta", "act_1", { syncedThrough: "2026-10-27" });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, connectionId: meta.id, provider: "meta", accountId: "act_1", campaignId: "c1", campaignName: "C", day: "2026-10-27", spend: 40, currency: "AUD" } });
    // Shopify refused its marketing report from the start: Google has nothing to come from there.
    await readThrough(w, "2026-10-20", { lastError: "access_denied", lastSyncedAt: null });
    expect(await maybeSendAdsDailySummary(w.store.id, queues, NOW)).toBe(true);
    expect(await eventData()).toMatchObject({ platforms: [{ platform: "meta", source: "platform_api", spend: 40 }] });
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

describe("the envelope's version", () => {
  it("an event written before the envelope had one still goes out as version 1", async () => {
    const w = await world("alert_raised");
    await alertEvent(w);
    const ev = await systemDb.zapierEvent.findFirstOrThrow();
    const { schema_version: _v, ...old } = ev.payload as Record<string, unknown>;
    await systemDb.zapierEvent.update({ where: { id: ev.id }, data: { payload: old as never } });
    await deliverZapier((await onlyDelivery()).id, deps);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ event: "alert_raised", schema_version: 1 });
  });
});

describe("events that never reach Zapier", () => {
  const alertOpen = (storeId: string) => systemDb.alert.findFirst({ where: { storeId, code: "zapier_delivery_failed", resolvedAt: null } });

  it("raise the store's alert once; Retry sends each again, and the alert resolves once none is left failed", async () => {
    const w = await world("alert_raised");
    await alertEvent(w, "a1");
    await alertEvent(w, "a2");
    const [a, b] = await systemDb.zapierDelivery.findMany({ orderBy: { createdAt: "asc" } });
    answers = [new Response("", { status: 400 }), new Response("", { status: 404 })];
    expect(await deliverZapier(a!.id, deps)).toBe("failed");
    expect(await deliverZapier(b!.id, deps)).toBe("failed");
    // One alert while it is open, worded for owners and admins, emailed once.
    expect(await systemDb.alert.count({ where: { storeId: w.store.id, code: "zapier_delivery_failed" } })).toBe(1);
    expect(mailer.sent.filter((m) => m.subject.includes("Zapier"))).toHaveLength(1);

    queues.clear();
    expect(await retryZapierDelivery(w.ws.id, w.store.id, a!.id, queues, { userId: w.user.id })).toBe("queued");
    expect(await systemDb.zapierDelivery.findUniqueOrThrow({ where: { id: a!.id } })).toMatchObject({ status: "pending", attempts: 0, errorCode: null, responseStatus: null });
    expect(zapierJobs().map((j) => j.deliveryId)).toEqual([a!.id]);
    // Twice is once: it isn't failed any more.
    expect(await retryZapierDelivery(w.ws.id, w.store.id, a!.id, queues, { userId: w.user.id })).toBe("not_failed");
    expect(await deliverZapier(a!.id, deps)).toBe("delivered");
    // b is still failed: the alert stays.
    expect(await alertOpen(w.store.id)).not.toBeNull();
    expect(await retryZapierDelivery(w.ws.id, w.store.id, b!.id, queues, { userId: w.user.id })).toBe("queued");
    expect(await deliverZapier(b!.id, deps)).toBe("delivered");
    expect(await alertOpen(w.store.id)).toBeNull();
    expect(await systemDb.auditLog.count({ where: { workspaceId: w.ws.id, action: "zapier.delivery_retried" } })).toBe(2);

    // Another business's delivery, or none: not found.
    const other = await world("alert_raised");
    expect(await retryZapierDelivery(other.ws.id, other.store.id, a!.id, queues, { userId: other.user.id })).toBe("not_found");
  });

  it("a failed one whose Zap is gone can't be sent again; the sweep resolves the alert it left", async () => {
    const w = await world("alert_raised");
    await alertEvent(w);
    const d = await onlyDelivery();
    answers = [new Response("", { status: 400 })];
    expect(await deliverZapier(d.id, deps)).toBe("failed");
    expect(await alertOpen(w.store.id)).not.toBeNull();
    expect(await unsubscribeZapierHook(w.grant, w.hook.id)).toBe(true);
    expect(await retryZapierDelivery(w.ws.id, w.store.id, d.id, queues, { userId: w.user.id })).toBe("trigger_gone");
    expect((await sweepZapier(deps)).settled).toBe(1);
    expect(await alertOpen(w.store.id)).toBeNull();
  });
});

describe("AdSense earnings that fell below an amount", () => {
  const NOW = new Date("2026-10-28T09:00:00Z");
  async function adsense(w: { ws: { id: string }; store: { id: string } }, syncedThrough: string, days: Record<string, number>) {
    const c = await systemDb.adConnection.create({
      data: { workspaceId: w.ws.id, storeId: w.store.id, provider: "adsense", accountId: "pub-1", currency: "AUD", accessTokenEnc: "x", tokenKeyVersion: 1, lastSyncedAt: NOW, syncedThrough },
    });
    for (const [day, earnings] of Object.entries(days)) {
      await systemDb.adsenseDaily.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, connectionId: c.id, accountId: "pub-1", site: "", day, earnings, currency: "AUD" } });
    }
    return c;
  }
  /** A trigger made a week before NOW, so the finished day is news to it. */
  async function belowTrigger(amount: number) {
    const w = await world("adsense_earnings_threshold", { period: "day", amount, direction: "below" });
    await systemDb.zapierHook.update({ where: { id: w.hook.id }, data: { createdAt: new Date("2026-10-21T00:00:00Z") } });
    return w;
  }

  it("fires once for a finished day that ended below it, only once every account has the whole day", async () => {
    const w = await belowTrigger(20);
    // Today (the 28th) has nothing yet: still running, so never "below". Yesterday ended at 5, but the account is stored only through the 26th.
    const c = await adsense(w, "2026-10-26", { "2026-10-27": 5 });
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    await systemDb.adConnection.update({ where: { id: c.id }, data: { syncedThrough: "2026-10-28" } });
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(1);
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    const ev = await systemDb.zapierEvent.findFirstOrThrow();
    expect(ev.dedupeKey).toBe(`adsense_earnings_threshold:${w.hook.id}:2026-10-27`);
    expect((ev.payload as { data: Record<string, unknown> }).data).toMatchObject({
      trigger: { platform: "adsense", period: "day", amount: 20, direction: "below" },
      period: "2026-10-27",
      period_complete: true,
      earnings_estimated: 5,
      currency: "AUD",
    });
  });

  it("stays quiet for a day that ended at or above it", async () => {
    const w = await belowTrigger(20);
    await adsense(w, "2026-10-28", { "2026-10-27": 20, "2026-10-28": 0 });
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(0);
    expect(await systemDb.zapierEvent.count()).toBe(0);
  });

  it("an \"above\" trigger made before the direction existed still fires on reaching the amount", async () => {
    const w = await world("adsense_earnings_threshold", { period: "day", amount: 20 });
    await adsense(w, "2026-10-28", { "2026-10-28": 21 });
    expect(await checkZapierThresholds(w.store.id, queues, NOW)).toBe(1);
    expect(((await systemDb.zapierEvent.findFirstOrThrow()).payload as { data: { trigger: Record<string, unknown> } }).data.trigger.direction).toBe("above");
  });
});

describe("ad accounts synced", () => {
  const NOW = new Date("2026-10-28T09:05:00Z");
  it("one event per account and hour, with no figures; never for the demo", async () => {
    const w = await world("sync_completed");
    const c = await systemDb.adConnection.create({
      data: { workspaceId: w.ws.id, storeId: w.store.id, provider: "meta", accountId: "act_9", accountName: "Acme ads", currency: "AUD", accessTokenEnc: "x", tokenKeyVersion: 1, lastSyncedAt: NOW, syncedThrough: "2026-10-28" },
    });
    await zapierAfterAdSync(c.id, { queues }, NOW);
    await zapierAfterAdSync(c.id, { queues }, new Date(NOW.getTime() + 40 * 60_000));
    const events = await systemDb.zapierEvent.findMany();
    expect(events.map((e) => e.dedupeKey)).toEqual([`sync_completed:${c.id}:2026-10-28T09`]);
    expect((events[0]!.payload as { data: Record<string, unknown> }).data).toEqual({
      integration: "meta_ads",
      integration_name: "Meta Ads",
      connection_id: c.id,
      account_id: "act_9",
      account_name: "Acme ads",
      synced_at: NOW.toISOString(),
      data_through: "2026-10-28",
    });
    expect(zapierJobs()).toHaveLength(1);
    await zapierAfterAdSync(c.id, { queues }, new Date(NOW.getTime() + 60 * 60_000));
    expect(await systemDb.zapierEvent.count()).toBe(2);

    const demo = await systemDb.adConnection.create({
      data: { workspaceId: w.ws.id, storeId: w.store.id, provider: "google", accountId: "demo", currency: "USD", accessTokenEnc: "x", tokenKeyVersion: 1, isDemo: true, demoSeed: 1, lastSyncedAt: NOW },
    });
    await zapierAfterAdSync(demo.id, { queues }, NOW);
    expect(await systemDb.zapierEvent.count()).toBe(2);
  });
});

describe("integrations connected and disconnected", () => {
  it("become an event from the audit row, for the store it names; demos and other actions don't", async () => {
    const w = await world("integration_connected");
    const gone = await systemDb.zapierHook.create({ data: { workspaceId: w.ws.id, storeId: w.store.id, grantId: w.grant.id, event: "integration_disconnected", targetUrl: `${HOOK}d/` } });
    await audit({ workspaceId: w.ws.id, actorUserId: w.user.id, action: "ads.connected", targetType: "store", targetId: w.store.id, metadata: { provider: "adsense", accounts: 2 } });
    await audit({ workspaceId: w.ws.id, actorUserId: w.user.id, action: "ads.demo_connected", targetType: "store", targetId: w.store.id, metadata: { isNew: true } });
    await audit({ workspaceId: w.ws.id, actorUserId: w.user.id, action: "member.removed", targetType: "store", targetId: w.store.id });
    await audit({ workspaceId: w.ws.id, actorUserId: w.user.id, action: "whatsapp.disconnected", targetType: "store", targetId: w.store.id, metadata: { cancelledMessages: 0 } });
    await audit({ workspaceId: w.ws.id, actorUserId: w.user.id, action: "zapier.connected", targetType: "zapier_grant", targetId: "g1", metadata: { storeId: w.store.id } });
    const events = await systemDb.zapierEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(events.map((e) => [e.event, (e.payload as { data: { integration: string } }).data.integration])).toEqual([
      ["integration_connected", "adsense"],
      ["integration_disconnected", "whatsapp"],
      ["integration_connected", "zapier"],
    ]);
    expect((events[0]!.payload as { data: Record<string, unknown> }).data).toMatchObject({ integration_name: "Google AdSense", accounts: 2, settings_url: expect.stringMatching(/\/settings\/ads$/) });
    // Who did it is the audit log's, not the Zap's.
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain(w.user.id);
    expect(await systemDb.zapierDelivery.count({ where: { hookId: gone.id } })).toBe(1);
    // Written without a queue at hand: the cron sweep sends them.
    expect(zapierJobs()).toHaveLength(0);
    expect((await sweepZapier(deps)).queued).toBe(3);
  });
});

describe("orders paid", () => {
  async function paidWorld(permissions?: string[]) {
    const w = await world("order_paid", {}, permissions ? { permissions } : {});
    await systemDb.store.update({
      where: { id: w.store.id },
      data: encryptTokenFields(w.store.id, { accessToken: "shpat_x", scopes: ["read_orders"], accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
    });
    return w;
  }
  let seq = 0;
  async function webhook(shop: string, topic: string, payload: unknown) {
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: `zw${++seq}`, topic, shopDomain: shop } });
    return processWebhook({ eventId: ev.id, topic, shop, payload }, deps);
  }
  const order = (over: Record<string, unknown> = {}) => ({
    id: 5550001,
    name: "#1001",
    currency: "AUD",
    created_at: "2026-10-28T08:59:00Z",
    updated_at: "2026-10-28T09:00:00Z",
    processed_at: "2026-10-28T08:59:00Z",
    cancelled_at: null,
    financial_status: "paid",
    subtotal_price: "119.90",
    total_discounts: "10.00",
    total_tax: "11.81",
    total_price: "129.90",
    source_name: "web",
    customer: { id: 7, email: "pat@example.com", first_name: "Pat", phone: "+61400000000" },
    email: "pat@example.com",
    billing_address: { address1: "1 Secret St" },
    discount_codes: [{ code: "PAT-ONLY-10", amount: "10.00" }],
    line_items: [{ id: 1, product_id: 7001, variant_id: 8001, sku: "TEE-BLK-M", title: "Black T-shirt", quantity: 2, price: "59.95", total_discount: "0" }],
    ...over,
  });

  it("Shopify's orders/paid becomes one event per order, with its amounts and items and nothing about who bought it", async () => {
    const w = await paidWorld();
    await webhook(w.store.shopDomain, "orders/create", order());
    expect(await systemDb.zapierEvent.count()).toBe(0);
    await webhook(w.store.shopDomain, "orders/paid", order());
    // Shopify sends a webhook more than once.
    await webhook(w.store.shopDomain, "orders/paid", order());
    const events = await systemDb.zapierEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]!.dedupeKey).toBe(`order_paid:${w.store.id}:5550001`);
    expect((events[0]!.payload as { data: Record<string, unknown> }).data).toEqual({
      order_id: "5550001",
      order_name: "#1001",
      currency: "AUD",
      total_price: 129.9,
      subtotal: 119.9,
      total_discounts: 10,
      total_tax: 11.81,
      total_shipping: 0,
      financial_status: "paid",
      items: 2,
      line_items: [{ product_id: "7001", variant_id: "8001", sku: "TEE-BLK-M", title: "Black T-shirt", quantity: 2, price: 59.95 }],
      sales_channel: "web",
      processed_at: "2026-10-28T08:59:00.000Z",
    });
    expect(JSON.stringify(events[0]!.payload)).not.toMatch(/pat@example|Pat|\+614|Secret St|PAT-ONLY|customer/);
    // Queued at once: the worker has its queue at hand.
    expect(zapierJobs()).toHaveLength(1);
  });

  it("not for a test order, nor for a member who can't see the store's sales", async () => {
    const w = await paidWorld();
    await webhook(w.store.shopDomain, "orders/paid", order({ id: 5550002, test: true }));
    const noSales = await paidWorld(["integrations.status", "integrations.manage", "marketing.ads"]);
    await webhook(noSales.store.shopDomain, "orders/paid", order({ id: 5550003 }));
    expect(await systemDb.zapierEvent.count()).toBe(0);
    expect(await systemDb.zapierDelivery.count()).toBe(0);
  });
});
