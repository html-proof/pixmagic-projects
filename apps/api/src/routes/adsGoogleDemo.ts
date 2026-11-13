import { z } from "zod";
import { withTenant, type AdConnection } from "@app/db";
import {
  AD_REPORT_BUDGET_MS,
  adsConfigured,
  adsRestricted,
  audit,
  connectGoogleAdsDemo,
  DEMO_RETENTION,
  demoAccountView,
  disconnectGoogleAdsDemo,
  enqueueAdCatchUp,
  findGoogleAdsDemo,
  googleAdsBudget,
  googleAdsBudgetAllows,
  googleAdsConnectionStatus,
  googleAdsDemoEnabled,
  googleProductionMissing,
  googleReportForConnection,
  isDemoConnection,
  logger,
  resetGoogleAdsDemo,
  type GoogleReport,
} from "@app/core";
import { GOOGLE_ANALYTICS_PART_IDS, GOOGLE_ANALYTICS_PARTS, googleAdsAnalytics, googleAnalyticsTable, type GoogleAdsAnalytics, type GoogleAnalyticsPart } from "@app/core/reports";
import { allows, CAMPAIGN_SORTS, DEMO_BADGE, DEMO_DISCLAIMER, pageCampaigns, type DemoBreakdownRow, type GoogleReportRow } from "@app/shared";
import { body, clientIp, HttpError, requireWorkspace, type Ctx, type Deps, type WorkspaceAccess } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { publicConnections, sendCsv, storeInWorkspace } from "./ads.js";
import { datesQuery, resolveQueryDates } from "./dashboard.js";

/**
 * Google Ads in its two modes, and the analytics page they share (docs/ads-demo.md).
 *
 * The demo: a simulated Google Ads account bizinsights connects to a store without any Google account,
 * token, API call or spend ("Try demo" on the Google Ads card). Its row is like a real account's except
 * that it holds no token and is marked is_demo; its figures are generated from a seed by the same sync
 * job that reads Google for real accounts (ads/googleAdsSource.ts). Everything about it says so: the
 * status, the account's facts and every answer carry "demo", "simulated" and "not verified by Google",
 * and nothing a browser sends can turn a demo row into a production one (the row decides).
 *
 * Production: "Continue with Google Ads", the real OAuth sign-in in routes/ads.ts. When this server lacks
 * its settings, the status says which (names only), and nothing switches to the demo in its place.
 *
 * The analytics endpoints answer for any of the store's Google Ads connections (`connection`), the demo
 * by default, from the stored campaign-days; a real account's device and country splits come from
 * Google's live report (cached and counted against the daily allowance like any report, and only once
 * the account has synced), a demo's from its generator.
 */

const base = "/workspaces/:ws/stores/:storeId/ads/google";
/** The route's workspace and store ids from a context typed without its path (a missing one answers 404 through requireWorkspace). */
const params = (c: Ctx) => ({ ws: c.req.param("ws") ?? "", storeId: c.req.param("storeId") ?? "" });
/** A seed for the demo's figures: any positive 31-bit integer (isDemoSeed in @app/shared). */
const seedSchema = z.number().int().positive().max(0x7fffffff);
const analyticsQuery = z.object({ connection: z.string().min(1).max(64).optional(), ...datesQuery });
const campaignsQuery = analyticsQuery.extend({
  q: z.string().max(100).optional(),
  status: z.string().max(20).optional(),
  type: z.string().max(30).optional(),
  sort: z.enum(CAMPAIGN_SORTS).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
const exportQuery = analyticsQuery.extend({ part: z.enum(GOOGLE_ANALYTICS_PART_IDS as [GoogleAnalyticsPart, ...GoogleAnalyticsPart[]]) });

/** A live report's rows as the analytics page's split rows (share of the report's spend). */
function splitRows(report: GoogleReport): DemoBreakdownRow[] {
  const total = report.totals.spend;
  return report.rows.map(({ campaignId: _ci, campaignName: _c, adGroupId: _gi, adGroupName: _g, adType: _t, status: _s, channel: _ch, primaryStatus: _ps, primaryStatusReasons: _pr, budgetPeriod: _bp, dailyBudget: _b, totalBudget: _tb, matchType: _m, qualityScore: _q, ...row }: GoogleReportRow) => ({
    ...row,
    share: total > 0 ? row.spend / total : null,
  }));
}

export function adsGoogleDemoRoutes(app: App, deps: Deps) {
  /** The store's demo connection, or a 404 that says there is none. Scoped to the workspace as every read is. */
  async function demoOf(ws: string, storeId: string): Promise<AdConnection> {
    const row = await findGoogleAdsDemo(storeId);
    if (!row || row.workspaceId !== ws) throw new HttpError(404, "No Google Ads demo is connected to this store.", "no_demo");
    return row;
  }

  /** Both modes for a store: the demo (simulated) and production (Google's own sign-in), each with where it stands. */
  app.get(`${base}/status`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, ["marketing.ads", "integrations.status"]);
    await storeInWorkspace(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.adConnection.findMany({ where: { workspaceId: ws, storeId, provider: "google" }, orderBy: { createdAt: "asc" } }));
    const connections = await publicConnections(ws, rows, { id: access.user?.id ?? null, seesEmail: allows(access.access, "integrations.manage") });
    const demoRow = rows.find((r) => isDemoConnection(r)) ?? null;
    const real = rows.filter((r) => !isDemoConnection(r));
    return c.json({
      provider: "google_ads",
      demo: {
        /** Whether this server offers "Try demo" (GOOGLE_ADS_DEMO_ENABLED). */
        enabled: googleAdsDemoEnabled(),
        status: demoRow ? googleAdsConnectionStatus(demoRow) : "not_connected",
        connection: connections.find((x) => x.id === demoRow?.id) ?? null,
        account: demoRow ? demoAccountView(demoRow) : null,
        badge: DEMO_BADGE,
        disclaimer: DEMO_DISCLAIMER,
      },
      production: {
        /** The real sign-in works on this server (its settings are all there). */
        configured: adsConfigured().google,
        /** Google still shows "Google hasn't verified this app" before its consent screen. */
        restricted: adsRestricted().google,
        /** The settings the sign-in still lacks, by name; never a value. */
        missing: googleProductionMissing(),
        status: real.length ? (real.every((r) => r.status === "active") ? "connected_production" : "production_error") : "not_connected",
        connections: connections.filter((x) => x.id !== demoRow?.id),
      },
    });
  });

  /**
   * Connect the demo to the store: the row is written, its first 90 days are queued (the card says
   * "Synchronizing" until they land), and the answer reports what was done. One demo per store;
   * connecting again brings an existing one back, shown and active.
   */
  app.post(`${base}/demo/connect`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const user = access.user!;
    await storeInWorkspace(ws, storeId);
    const { seed } = z.object({ seed: seedSchema.optional() }).parse(await body(c));
    await limit(deps.coord, `rl:ads-demo:${user.id}`, LIMITS.adsDemo, "That's a lot of demo changes in a short time. Wait a few minutes and try again.");
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { currency: true, timezone: true } }));
    const { connection, isNew, window } = await connectGoogleAdsDemo(deps.queues, { workspaceId: ws, storeId, userId: user.id, seed, store: { currency: store?.currency ?? null, timezone: store?.timezone ?? null } });
    await audit({ workspaceId: ws, actorUserId: user.id, action: "ads.demo_connected", targetType: "store", targetId: storeId, metadata: { isNew, seed: connection.demoSeed }, ip: clientIp(c) });
    const [pub] = await publicConnections(ws, [connection], { id: user.id, seesEmail: true });
    return c.json({
      success: true,
      provider: "google_ads",
      connection_type: "demo",
      connection_status: googleAdsConnectionStatus(connection),
      account: { id: connection.accountId, name: connection.accountName, currency: connection.currency, is_demo: true },
      verification_status: "simulated",
      message: isNew ? "Demo account connected successfully" : "Demo account already connected",
      disclaimer: "No Google authorization or verification occurred.",
      /** The connection as the integrations pages list it, the demo's facts, and the days queued. */
      connection: pub,
      demo: demoAccountView(connection),
      sync: window,
    });
  });

  /** Disconnect the demo: its figures and its row go (DEMO_RETENTION), nothing else is touched. */
  app.post(`${base}/demo/disconnect`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await storeInWorkspace(ws, storeId);
    const row = await demoOf(ws, storeId);
    await disconnectGoogleAdsDemo(row);
    await audit({ workspaceId: ws, actorUserId: access.user?.id ?? null, action: "ads.demo_disconnected", targetType: "store", targetId: storeId, metadata: { accountId: row.accountId }, ip: clientIp(c) });
    return c.json({ ok: true, provider: "google_ads", connection_status: "disconnected", retention: DEMO_RETENTION });
  });

  /** The demo account's facts and state, and what it may read (its fictional permissions). */
  app.get(`${base}/demo/account`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, ["marketing.ads", "integrations.status"]);
    await storeInWorkspace(ws, storeId);
    const row = await demoOf(ws, storeId);
    const [connection] = await publicConnections(ws, [row], { id: access.user?.id ?? null, seesEmail: allows(access.access, "integrations.manage") });
    return c.json({ account: demoAccountView(row), connection });
  });

  /**
   * "Sync demo data": bring the demo up to date the way a real account is (a catch-up job on the sync
   * queue, which generates the days and stores them); the card says "Synchronizing" until it lands.
   * One already on its way isn't queued again. Nothing is asked of Google.
   */
  app.post(`${base}/demo/sync`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await storeInWorkspace(ws, storeId);
    await limit(deps.coord, `rl:ads-sync:${storeId}:${access.user?.id ?? clientIp(c)}`, LIMITS.adsSync);
    const row = await demoOf(ws, storeId);
    if (!row.enabled) throw new HttpError(409, "The demo is hidden from the dashboard: show it first, then sync it.", "demo_hidden");
    const window = await enqueueAdCatchUp(deps.queues, row, { interactive: true });
    await audit({ workspaceId: ws, actorUserId: access.user?.id ?? null, action: "ads.demo_synced", targetType: "ad_connection", targetId: row.id, metadata: { queued: !!window, window }, ip: clientIp(c) });
    const fresh = await demoOf(ws, storeId);
    return c.json({ queued: !!window, window, status: googleAdsConnectionStatus(fresh), lastSyncedAt: fresh.lastSyncedAt, syncRequestedAt: fresh.syncRequestedAt });
  });

  /** "Reset demo data": a new seed (or the one given), the stored days gone, the 90 days generated again. */
  app.post(`${base}/demo/reset`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const user = access.user!;
    await storeInWorkspace(ws, storeId);
    const { seed } = z.object({ seed: seedSchema.optional() }).parse(await body(c));
    await limit(deps.coord, `rl:ads-demo:${user.id}`, LIMITS.adsDemo, "That's a lot of demo changes in a short time. Wait a few minutes and try again.");
    const row = await demoOf(ws, storeId);
    const reset = await resetGoogleAdsDemo(deps.queues, row, seed);
    await audit({ workspaceId: ws, actorUserId: user.id, action: "ads.demo_reset", targetType: "ad_connection", targetId: row.id, metadata: { seed: reset.seed }, ip: clientIp(c) });
    return c.json({ ok: true, seed: reset.seed, status: googleAdsConnectionStatus(reset.connection), account: demoAccountView(reset.connection) });
  });

  // ---- The analytics page: any of the store's Google Ads connections, the demo by default.

  interface Asked {
    conn: AdConnection;
    campaigns: boolean;
    analytics: GoogleAdsAnalytics;
    q: z.infer<typeof analyticsQuery>;
  }

  /** The connection asked about and its analytics for the dates asked, for a member who may see ads (campaign figures only with "View campaigns"). */
  async function asked(c: Ctx, query: z.infer<typeof analyticsQuery>, need: "marketing.ads" | "marketing.campaigns" = "marketing.ads"): Promise<Asked> {
    const { ws, storeId } = params(c);
    const access = await requireWorkspace(c, deps, ws, need);
    await storeInWorkspace(ws, storeId);
    return analyticsOf(ws, storeId, access, query);
  }

  /** The analytics of a store the member's workspace was checked to have (asked, the download). */
  async function analyticsOf(ws: string, storeId: string, access: WorkspaceAccess, query: z.infer<typeof analyticsQuery>): Promise<Asked> {
    const where = query.connection ? { workspaceId: ws, storeId, provider: "google", id: query.connection } : { workspaceId: ws, storeId, provider: "google", isDemo: true };
    const conn: AdConnection | null = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where, orderBy: { createdAt: "asc" } }));
    if (!conn) throw new HttpError(404, query.connection ? "Not found" : "No Google Ads demo is connected to this store.", query.connection ? "not_found" : "no_demo");
    const now = new Date();
    // Days in the ad account's own time zone: that is what its figures are stored by.
    const dates = resolveQueryDates(query, now, conn.timezone || "UTC");
    const campaigns = allows(access.access, "marketing.campaigns");
    const analytics: GoogleAdsAnalytics = await withTenant(ws, (tx) => googleAdsAnalytics(tx, conn, dates.range, { now, campaigns }));
    return { conn, campaigns, analytics, q: query };
  }

  /**
   * A real account's device and country splits, from Google's live report (a demo's are generated with
   * the rest), read as the live Google Ads report reads them (routes/ads.ts): from the answer it cached
   * for the same account and dates (the same key, kept as long: 10 minutes while the dates take in today,
   * an hour once they're over), else from Google, cached the same way. So the page, its sections, its
   * downloads and that report ask Google once for the same dates. Google isn't asked before the account's
   * first sync has landed, while its syncs fail, or once bizinsights has used the keyword reports' share
   * of the day's allowance (GOOGLE_ADS_DETAIL_SHARE), so the splits never hold back the syncs. Best
   * effort: splits not read are left null, and the note says why.
   */
  async function liveSplits(c: Ctx, a: Asked): Promise<void> {
    if (a.analytics.account.demo) return;
    if (a.conn.status !== "active") {
      a.analytics.audience.note = "Google's device and country splits aren't read while this account's syncs fail: Settings → Advertising says why. The rest of the page is from the stored figures.";
      return;
    }
    if (!a.conn.lastSyncedAt) {
      a.analytics.audience.note = "Google's device and country splits are read once this account's first sync has finished.";
      return;
    }
    const { storeId } = params(c);
    const { from, to } = a.analytics.range;
    const levels = ["device", "country"] as const;
    const key = (level: (typeof levels)[number]) => `ads-greport:v4:${a.conn.id}:${level}:-:-:${from}:${to}`;
    try {
      const cached = await Promise.all(levels.map((level) => deps.coord.peek(key(level))));
      if (cached.some((v) => !v)) {
        // Before anything is counted: while the allowance is held back, Google isn't asked, so none of the account's reads is used.
        const budget = await googleAdsBudget(deps.coord);
        if (!googleAdsBudgetAllows(budget, "detail")) {
          a.analytics.audience.note = budget.paused
            ? "Google's device and country splits aren't read just now: bizinsights has used today's allowance of Google Ads requests. The rest of the page is from the stored figures."
            : "Google's device and country splits are paused for a few hours so your Google Ads figures keep syncing: bizinsights has used most of today's Google Ads allowance. Splits already read stay available.";
          return;
        }
        await limit(deps.coord, `rl:ads-report:${storeId}:${a.conn.id}`, LIMITS.adsReport);
      }
      const deadline = Date.now() + AD_REPORT_BUDGET_MS;
      // Both read at once and each cached once read; the first failure is thrown once both have ended.
      const results = await Promise.allSettled(
        levels.map(async (level, i) => {
          if (cached[i]) return JSON.parse(cached[i]!) as GoogleReport;
          const report = await googleReportForConnection(a.conn, level, from, to, deps.fetchImpl, { coord: deps.coord, deadline });
          await deps.coord.put(key(level), JSON.stringify(report), to >= a.analytics.today ? 600 : 3600);
          return report;
        }),
      );
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
      const [devices, countries] = results.map((r) => (r as PromiseFulfilledResult<GoogleReport>).value);
      a.analytics.devices = splitRows(devices!);
      a.analytics.audience.devices = a.analytics.devices;
      a.analytics.audience.countries = splitRows(countries!);
    } catch (err) {
      logger.info({ err, connectionId: a.conn.id }, "google ads analytics: live splits not read");
      a.analytics.audience.note = "Google's device and country splits couldn't be read just now; the rest of the page is from the stored figures. Try again in a minute.";
    }
  }

  const parse = (c: Ctx) => analyticsQuery.parse(c.req.query());
  /** The spec's /demo/... names answer the same as /analytics/... (the demo is the default connection). */
  const paths = (part: string) => [`${base}/analytics${part}`, `${base}/demo${part}`];

  for (const path of paths("")) {
    app.get(path, async (c) => {
      const a = await asked(c, parse(c));
      await liveSplits(c, a);
      return c.json(a.analytics);
    });
  }
  for (const path of paths("/overview")) {
    app.get(path, async (c) => {
      const { analytics: x } = await asked(c, parse(c));
      return c.json({ account: x.account, range: x.range, today: x.today, coverage: x.coverage, disclaimer: x.disclaimer, overview: x.overview, series: x.series });
    });
  }
  for (const path of paths("/campaigns")) {
    app.get(path, async (c) => {
      const q = campaignsQuery.parse(c.req.query());
      const { analytics: x } = await asked(c, q, "marketing.campaigns");
      return c.json({ account: x.account, range: x.range, disclaimer: x.disclaimer, ...pageCampaigns(x.campaigns ?? [], q) });
    });
  }
  for (const path of paths("/performance")) {
    app.get(path, async (c) => {
      const { analytics: x } = await asked(c, parse(c));
      // Spend against budget per campaign needs the campaigns; without "View campaigns" the series alone.
      const budgets = x.campaigns?.map((cm) => ({ id: cm.id, name: cm.name, dailyBudget: cm.dailyBudget, budget: cm.budget, spend: cm.spend, budgetUse: cm.budgetUse, activeDays: cm.activeDays })) ?? null;
      return c.json({ account: x.account, range: x.range, disclaimer: x.disclaimer, series: x.series, budgets });
    });
  }
  for (const path of paths("/conversions")) {
    app.get(path, async (c) => {
      const { analytics: x } = await asked(c, parse(c));
      return c.json({ account: x.account, range: x.range, disclaimer: x.disclaimer, ...x.conversions });
    });
  }
  for (const path of paths("/devices")) {
    app.get(path, async (c) => {
      const a = await asked(c, parse(c));
      await liveSplits(c, a);
      return c.json({ account: a.analytics.account, range: a.analytics.range, disclaimer: a.analytics.disclaimer, devices: a.analytics.devices, note: a.analytics.account.demo ? null : a.analytics.audience.note });
    });
  }
  for (const path of paths("/audience")) {
    app.get(path, async (c) => {
      const a = await asked(c, parse(c));
      await liveSplits(c, a);
      return c.json({ account: a.analytics.account, range: a.analytics.range, disclaimer: a.analytics.disclaimer, ...a.analytics.audience });
    });
  }
  for (const path of paths("/recommendations")) {
    app.get(path, async (c) => {
      const { analytics: x } = await asked(c, parse(c), "marketing.campaigns");
      return c.json({ account: x.account, range: x.range, disclaimer: x.disclaimer, recommendations: x.recommendations ?? [] });
    });
  }
  for (const path of paths("/combined")) {
    app.get(path, async (c) => {
      const { analytics: x } = await asked(c, parse(c));
      return c.json({ account: x.account, range: x.range, disclaimer: x.disclaimer, combined: x.combined });
    });
  }

  /**
   * One section of the analytics page as CSV (`part`, GOOGLE_ANALYTICS_PARTS in core's reports/adsExport.ts),
   * from the same answer the page shows: needs "Export approved reports" and "View advertising analytics"
   * (and "View campaigns" for the campaigns and recommendations), checked before the store or the query;
   * held to the downloads' allowance and in the audit log (sendCsv). A real account's devices and audience
   * read Google's splits as the page does; the demo's file says on its first row that it is simulated.
   */
  app.get(`${base}/analytics/export`, async (c) => {
    const { ws, storeId } = params(c);
    const access = await requireWorkspace(c, deps, ws, "reports.export");
    if (!allows(access.access, "marketing.ads")) throw new HttpError(403, "You don't have permission to see advertising analytics, so you can't download them.", "forbidden");
    await storeInWorkspace(ws, storeId);
    const q = exportQuery.parse(c.req.query());
    if (GOOGLE_ANALYTICS_PARTS[q.part].campaigns && !allows(access.access, "marketing.campaigns")) {
      throw new HttpError(403, "You don't have permission to see campaigns, so you can't download them.", "forbidden");
    }
    return sendCsv(c, deps, access, storeId, async () => {
      const a = await analyticsOf(ws, storeId, access, q);
      if (q.part === "devices" || q.part === "audience") await liveSplits(c, a);
      const x = a.analytics;
      const demo = x.account.demo;
      return {
        name: ["bizinsights", "google-ads", ...(demo ? ["demo-simulated"] : []), x.account.accountId, q.part, x.range.from, "to", x.range.to].join("-"),
        table: googleAnalyticsTable(q.part, x),
        metadata: { section: "google_ads_analytics", part: q.part, platform: "google", account: a.conn.id, from: x.range.from, to: x.range.to, ...(demo ? { demo: true } : {}) },
      };
    });
  });
}
