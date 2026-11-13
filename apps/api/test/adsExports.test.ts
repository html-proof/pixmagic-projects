import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { encryptAdTokens, syncAdConnection, type AdsSyncData, type FetchLike } from "@app/core";
import { addDays, googleRowBlank, localDay, type GoogleReportMetrics, type GoogleReportRow } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * The Advertising area's own downloads: the Meta and Google Ads live reports as CSV (`format=csv`), built
 * from the answer the page shows without asking the platform again, and the Google Ads analytics page's
 * sections (GET …/ads/google/analytics/export). Each needs "Export approved reports" besides what its page
 * needs, is in the audit log with what was downloaded, and the demo's files say they are simulated.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

const ENV = { META_APP_ID: "meta_app", META_APP_SECRET: "meta_secret", GOOGLE_ADS_CLIENT_ID: "", GOOGLE_ADS_CLIENT_SECRET: "", GOOGLE_ADS_ENABLED: "", GOOGLE_ADS_DEMO_ENABLED: "1" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let headers: Record<string, string>;
let ws: string;
let storeId: string;
/** Every call the app made out: the downloads make none. */
let calls: string[];

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(ENV);
  calls = [];
  ctx.setFetch(async (input) => {
    calls.push(String(input));
    throw new Error(`unexpected network call: ${String(input)}`);
  });
  const u = await signIn(ctx, "export-owner", "owner@x.com");
  headers = u.headers;
  ws = await createWorkspace(ctx, headers);
  storeId = (await createStore(ws, "export-shop.myshopify.com", ["read_orders"], { currency: "AUD", timezone: "Australia/Melbourne" })).id;
});

const get = (url: string, h = headers) => ctx.app.inject({ method: "GET", url, headers: h });

/** A CSV answer's rows (RFC 4180: quoted text, "" inside quotes), without the BOM. */
function rowsOf(body: string): string[][] {
  const text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  return rows;
}

/** A member of the workspace with only `permissions` (Team & Access); returns their headers and a way to change them. */
async function member(email: string, permissions: string[]) {
  const m = await signIn(ctx, email, email);
  const row = await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role: "custom", permissions } });
  return { headers: m.headers, grant: (next: string[]) => systemDb.membership.update({ where: { id: row.id }, data: { permissions: next } }) };
}

const exported = () => systemDb.auditLog.findMany({ where: { workspaceId: ws, action: "report.exported" }, orderBy: { createdAt: "asc" } });

describe("the Meta Ads report as CSV", () => {
  /** Meta's insights for act_1: the account's totals and two campaigns, and the campaigns' delivery statuses. */
  const meta: FetchLike = async (input) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    if (u.pathname.endsWith("/act_1/insights")) {
      if (u.searchParams.get("level") === "account") {
        return json({
          data: [
            {
              spend: "120.50",
              impressions: "10000",
              reach: "4000",
              frequency: "2.5",
              clicks: "300",
              inline_link_clicks: "200",
              actions: [{ action_type: "omni_purchase", value: "6", "1d_click": "4", "7d_click": "6" }],
              action_values: [{ action_type: "omni_purchase", value: "482", "1d_click": "300", "7d_click": "482" }],
            },
          ],
        });
      }
      return json({
        data: [
          { campaign_id: "12", campaign_name: "=Retarget", spend: "20.50", impressions: "2000", reach: "900", frequency: "2.22", clicks: "50", inline_link_clicks: "20" },
          {
            campaign_id: "11",
            campaign_name: "Spring, sale",
            spend: "100",
            impressions: "8000",
            reach: "3500",
            frequency: "2.29",
            clicks: "250",
            inline_link_clicks: "180",
            actions: [{ action_type: "omni_purchase", value: "6", "1d_click": "4" }],
            action_values: [{ action_type: "omni_purchase", value: "482", "1d_click": "300" }],
            attribution_setting: "7d_click_1d_view",
          },
        ],
      });
    }
    if (u.pathname.endsWith("/act_1/campaigns")) return json({ data: [{ id: "12", effective_status: "CAMPAIGN_PAUSED" }, { id: "11", effective_status: "ACTIVE", objective: "OUTCOME_SALES", daily_budget: "5000" }] });
    return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
  };

  async function metaConnection() {
    return systemDb.adConnection.create({
      data: {
        workspaceId: ws,
        storeId,
        provider: "meta",
        accountId: "act_1",
        accountName: "Shop ads",
        currency: "USD",
        timezone: "UTC",
        ...encryptAdTokens(storeId, "meta", { accessToken: "META_TOKEN_SECRET", refreshToken: null, expiresAt: null }),
      },
    });
  }
  const url = (connection: string, q: Record<string, string> = {}) => `/workspaces/${ws}/stores/${storeId}/ads/meta/report?${new URLSearchParams({ connection, from: "2026-09-01", to: "2026-09-30", ...q })}`;

  it("downloads the answer on screen, every attribution at once, without asking Meta again; audited with the platform and level", async () => {
    const conn = await metaConnection();
    ctx.setFetch(meta);
    const page = await get(url(conn.id));
    expect(page.statusCode, page.body).toBe(200);
    const read = calls.length;
    expect(read).toBeGreaterThan(0);

    const res = await get(url(conn.id, { format: "csv" }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="bizinsights-meta-ads-act_1-campaign-2026-09-01-to-2026-09-30.csv"');
    // Nothing more was asked of Meta: the page's answer, from the cache.
    expect(calls).toHaveLength(read);
    expect(res.body).not.toContain("META_TOKEN_SECRET");

    const [header, top, ...rest] = rowsOf(res.body);
    expect(header!.slice(0, 9)).toEqual(["Campaign", "Meta id", "Status at Meta now", "Objective", "Daily budget now (USD)", "Lifetime budget now (USD)", "Attribution setting", "Spend (USD)", "Impressions"]);
    expect(header).toContain("Purchases (Meta's count, each ad set's own setting)");
    expect(header).toContain("Purchase value (USD; Meta's count, 1-day click)");
    expect(header).toContain("Purchases (Meta's count, 1-day view)");
    const col = (name: string) => header!.indexOf(name);
    // The account's own totals on top: reach is Meta's de-duplicated figure.
    expect(top![0]).toBe("Whole ad account");
    expect(top![col("Spend (USD)")]).toBe("120.5");
    expect(top![col("Reach")]).toBe("4000");
    expect(top![col("Purchases (Meta's count, 1-day click)")]).toBe("4");
    // A window Meta left out of its answer counted none, as each ad set's own setting reads it.
    expect(top![col("Purchases (Meta's count, 1-day view)")]).toBe("0");
    expect(top![col("Purchase ROAS (1-day view)")]).toBe("0");
    const spring = rest.find((r) => r[0] === "Spring, sale")!;
    expect(spring[col("Meta id")]).toBe("11");
    expect(spring[col("Status at Meta now")]).toBe("ACTIVE");
    expect(spring[col("Attribution setting")]).toBe("7-day click, 1-day view");
    expect(spring[col("Link click rate (%)")]).toBe("2.25");
    expect(spring[col("Purchase ROAS (each ad set's own setting)")]).toBe("4.82");
    // A name a spreadsheet would run as a formula is written as text.
    expect(rest.find((r) => r[1] === "12")![0]).toBe("'=Retarget");
    expect(rest.some((r) => r[0] === "Note" && /not Shopify orders/.test(r[1]!))).toBe(true);

    const [entry] = await exported();
    expect(entry).toMatchObject({ targetType: "store", targetId: storeId, metadata: { section: "ads_live_report", platform: "meta", level: "campaign", account: conn.id, from: "2026-09-01", to: "2026-09-30" } });
  });

  it("needs the export permission besides View campaigns, checked before anything is read", async () => {
    const conn = await metaConnection();
    ctx.setFetch(meta);
    const m = await member("analyst@x.com", ["marketing.ads", "marketing.campaigns"]);
    expect((await get(url(conn.id), m.headers)).statusCode).toBe(200);
    const refused = await get(url(conn.id, { format: "csv" }), m.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("forbidden");
    await m.grant(["marketing.ads", "marketing.campaigns", "reports.export"]);
    expect((await get(url(conn.id, { format: "csv" }), m.headers)).statusCode).toBe(200);
    // Export alone isn't seeing the campaigns.
    await m.grant(["reports.export"]);
    expect((await get(url(conn.id, { format: "csv" }), m.headers)).statusCode).toBe(403);
    expect(await exported()).toHaveLength(1);
  });

  it("a report the page hasn't read (or no longer keeps) isn't read for the download: report_expired, nothing asked, nothing logged, no download used", async () => {
    const conn = await metaConnection();
    ctx.setFetch(meta);
    const res = await get(url(conn.id, { level: "adset", format: "csv" }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("report_expired");
    expect(calls).toEqual([]);
    expect(await exported()).toHaveLength(0);
    // As many tries as the 30 downloads allowed in 10 minutes: none of them counted, so the page's read again
    // and its download still go through.
    for (let i = 1; i < 30; i++) expect((await get(url(conn.id, { level: "adset", format: "csv" }))).json().error).toBe("report_expired");
    expect((await get(url(conn.id, { level: "adset" }))).statusCode).toBe(200);
    expect((await get(url(conn.id, { level: "adset", format: "csv" }))).statusCode).toBe(200);
  });

  it("down from an ad set, with the dates compared: that ad set's own row on top, the dates compared with, each ad's change, and an ad not listed then said so", async () => {
    const conn = await metaConnection();
    const figures = (spend: number, purchases: number) => ({
      spend,
      impressions: 1000,
      reach: null,
      frequency: null,
      clicks: 10,
      linkClicks: 5,
      linkCtr: 0.005,
      costPerLinkClick: 2,
      cpm: 10,
      landingPageViews: 4,
      costPerLandingPageView: 2.5,
      purchases,
      purchaseValue: 50,
      costPerPurchase: 5,
      roas: 5,
      leads: 0,
      byWindow: { "1d_click": { purchases: 1, purchaseValue: 20, costPerPurchase: 10, roas: 2 }, "7d_click": { purchases: null, purchaseValue: null, costPerPurchase: null, roas: null }, "1d_view": { purchases: 0, purchaseValue: 0, costPerPurchase: null, roas: 0 } },
    });
    const ad = (id: string, name: string, spend: number, purchases: number) => ({ id, name, campaignId: "11", campaignName: "Spring", adsetId: "21", adsetName: "Lookalike", status: "ACTIVE", attribution: "7d_click", ...figures(spend, purchases) });
    // The page's read left both ranges in the cache, where the download finds them.
    const now = { level: "ad", since: "2026-09-01", until: "2026-09-30", totals: figures(10, 2), rows: [ad("31", "Video", 6, 2), ad("32", "Carousel", 4, 0)], truncated: false, attribution: ["7d_click"], campaigns: null };
    const before = { ...now, since: "2026-08-02", until: "2026-08-31", totals: figures(5, 1), rows: [ad("31", "Video", 3, 1)] };
    await ctx.deps.coord.put(`ads-report:v3:${conn.id}:ad:11:21:2026-09-01:2026-09-30`, JSON.stringify(now), 600);
    await ctx.deps.coord.put(`ads-report:v3:${conn.id}:ad:11:21:2026-08-02:2026-08-31:figures`, JSON.stringify(before), 600);

    const res = await get(url(conn.id, { level: "ad", campaign: "11", adset: "21", cfrom: "2026-08-02", cto: "2026-08-31", format: "csv" }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-disposition"]).toContain("bizinsights-meta-ads-act_1-ad-campaign-11-adset-21-2026-09-01-to-2026-09-30.csv");
    const [header, top, was, video, carousel] = rowsOf(res.body);
    expect(header!.slice(0, 5)).toEqual(["Ad", "Meta id", "Campaign", "Ad set", "Status at Meta now"]);
    expect(header!.slice(-4)).toEqual(["Spend before (USD)", "Spend change (%)", "Purchases before (Meta's count, each ad set's own setting)", "Purchases change (%)"]);
    expect(top![0]).toBe("Whole ad set");
    expect(top!.slice(-4)).toEqual(["5", "100", "1", "100"]);
    expect(was![0]).toBe("Before (2026-08-02 to 2026-08-31)");
    // Reach Meta didn't give is said, never 0.
    expect(top![header!.indexOf("Reach")]).toBe("Not reported");
    expect(video!.slice(-4)).toEqual(["3", "100", "1", "100"]);
    expect(carousel!.slice(-4)).toEqual(["Not listed for the dates compared", "", "Not listed for the dates compared", ""]);
    expect(calls).toEqual([]);
    expect((await exported())[0]!.metadata).toMatchObject({ platform: "meta", level: "ad", campaign: "11", adset: "21", cfrom: "2026-08-02", cto: "2026-08-31" });
  });
});

describe("the Google Ads demo's live report as CSV", () => {
  async function demo() {
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/demo/connect`, headers, payload: {} });
    expect(res.statusCode).toBe(200);
    const jobs = ctx.deps.queues.sent.sync as unknown as AdsSyncData[];
    for (const j of jobs.splice(0, jobs.length).filter((x) => x.kind === "ads")) {
      await syncAdConnection(j.connectionId, j.since, j.until, ctx.deps.fetchImpl, { trigger: j.trigger, queues: ctx.deps.queues, coord: ctx.deps.coord });
    }
    return systemDb.adConnection.findFirstOrThrow({ where: { storeId, isDemo: true } });
  }

  it("keywords and campaigns: the page's answer, marked simulated on its first row, its facts as columns", async () => {
    const conn = await demo();
    const today = localDay(new Date(), "Australia/Melbourne");
    const report = (q: Record<string, string>) => get(`/workspaces/${ws}/stores/${storeId}/ads/google/report?${new URLSearchParams({ connection: conn.id, from: addDays(today, -30), to: addDays(today, -1), ...q })}`);
    expect((await report({ level: "keyword", campaign: "demo-c2" })).statusCode).toBe(200);
    const res = await report({ level: "keyword", campaign: "demo-c2", format: "csv" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/filename="bizinsights-google-ads-demo-simulated-DEMO-ADS-001-keyword-campaign-demo-c2-/);
    const [header, simulated, top, first] = rowsOf(res.body);
    expect(simulated!.slice(0, 2)).toEqual(["Simulated data", expect.stringContaining("Simulated data generated by bizinsights")]);
    // Nothing in it is Google's: the demo's facts and figures are labelled simulated.
    expect(header!.slice(0, 7)).toEqual(["Keyword", "Google id", "Campaign", "Ad group", "Status now (simulated)", "Match type", "Quality Score now (1 to 10)"]);
    expect(header).toContain("Spend (AUD)");
    expect(header).toContain("Conversions (simulated, all conversion actions)");
    expect(res.body).not.toContain("Google's count");
    expect(top![0]).toBe("Whole campaign");
    expect(["Exact match", "Phrase match", "Broad match"]).toContain(first![5]);

    expect((await report({ level: "campaign" })).statusCode).toBe(200);
    const campaigns = rowsOf((await report({ level: "campaign", format: "csv" })).body);
    expect(campaigns[0]!.slice(0, 9)).toEqual(["Campaign", "Google id", "Campaign type", "Status now (simulated)", "Delivery now (simulated)", "Why", "Daily budget now (AUD)", "Total budget now (AUD)", "Spend (AUD)"]);
    const search = campaigns.find((r) => r[1] === "demo-c2")!;
    expect(search.slice(2, 6)).toEqual(["Search", "ENABLED", "Limited", "limited by budget"]);
    expect(campaigns.some((r) => r[0] === "Note" && /Generated by bizinsights for the Google Ads demo/.test(r[1]!))).toBe(true);

    expect(calls).toEqual([]);
    const logged = (await exported()).map((e) => e.metadata);
    expect(logged).toHaveLength(2);
    expect(logged).toContainEqual(expect.objectContaining({ section: "ads_live_report", platform: "google", level: "keyword", campaign: "demo-c2", account: conn.id, demo: true }));
    expect(logged).toContainEqual(expect.objectContaining({ platform: "google", level: "campaign", demo: true }));
  });
});

/** A real (not demo) Google Ads connection of the store: its report reads are what these tests set up. */
async function googleConnection() {
  return systemDb.adConnection.create({
    data: {
      workspaceId: ws,
      storeId,
      provider: "google",
      accountId: "1234567890",
      accountName: "Shop Google ads",
      currency: "USD",
      timezone: "UTC",
      ...encryptAdTokens(storeId, "google", { accessToken: "G_ACCESS_SECRET", refreshToken: "G_REFRESH_SECRET", expiresAt: new Date(Date.now() + 3600_000) }),
    },
  });
}

describe("a real Google Ads account's live report as CSV", () => {
  const g = (spend: number, conversions: number): GoogleReportMetrics => ({ spend, impressions: 1000, clicks: 50, ctr: 0.05, cpc: spend / 50, cpm: spend, conversions, conversionRate: conversions / 50, costPerConversion: conversions ? spend / conversions : null, conversionValue: 100, roas: 100 / spend });
  const report = (since: string, until: string, level: string, totals: GoogleReportMetrics, rows: Array<{ id: string; name: string } & GoogleReportMetrics & Partial<GoogleReportRow>>) => ({
    level,
    since,
    until,
    totals,
    rows: rows.map((r) => ({ ...googleRowBlank(), status: "ENABLED", channel: "SEARCH", ...r })),
    truncated: false,
  });
  const url = (connection: string, q: Record<string, string>) => `/workspaces/${ws}/stores/${storeId}/ads/google/report?${new URLSearchParams({ connection, ...q })}`;

  it("compared with other dates: Google's own wording, the account's row, each campaign's change, and one not listed then said so; nothing asked of Google", async () => {
    const conn = await googleConnection();
    const now = report("2026-09-01", "2026-09-30", "campaign", g(90, 6), [
      { id: "7", name: "Brand", ...g(60, 4) },
      { id: "8", name: "Shopping", ...g(30, 2) },
    ]);
    const before = report("2026-08-02", "2026-08-31", "campaign", g(45, 3), [{ id: "7", name: "Brand", ...g(30, 2) }]);
    await ctx.deps.coord.put(`ads-greport:v4:${conn.id}:campaign:-:-:2026-09-01:2026-09-30`, JSON.stringify(now), 600);
    await ctx.deps.coord.put(`ads-greport:v4:${conn.id}:campaign:-:-:2026-08-02:2026-08-31`, JSON.stringify(before), 600);

    const res = await get(url(conn.id, { from: "2026-09-01", to: "2026-09-30", cfrom: "2026-08-02", cto: "2026-08-31", format: "csv" }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="bizinsights-google-ads-1234567890-campaign-2026-09-01-to-2026-09-30.csv"');
    expect(res.body).not.toContain("G_ACCESS_SECRET");
    const [header, top, was, brand, shopping, ...notes] = rowsOf(res.body);
    expect(header!.slice(0, 5)).toEqual(["Campaign", "Google id", "Campaign type", "Status at Google now", "Delivery at Google now"]);
    expect(header).toContain("Conversions (Google's count, all conversion actions)");
    expect(header!.slice(-4)).toEqual(["Spend before (USD)", "Spend change (%)", "Conversions before (Google's count)", "Conversions change (%)"]);
    expect(top![0]).toBe("Whole ad account");
    expect(top!.slice(-4)).toEqual(["45", "100", "3", "100"]);
    expect(was![0]).toBe("Before (2026-08-02 to 2026-08-31)");
    expect(brand!.slice(-4)).toEqual(["30", "100", "2", "100"]);
    expect(shopping!.slice(-4)).toEqual(["Not listed for the dates compared", "", "Not listed for the dates compared", ""]);
    const said = notes.filter((r) => r[0] === "Note").map((r) => r[1]);
    expect(said).toContain("Google's figures for 2026-09-01 to 2026-09-30, days in the ad account's time zone (UTC), as Google reported them.");
    expect(said).toContain("Changes compare with 2026-08-02 to 2026-08-31, as Google reports those dates now.");
    expect(said.join(" ")).not.toContain("still coming in");
    expect(calls).toEqual([]);
    expect((await exported())[0]!.metadata).toMatchObject({ section: "ads_live_report", platform: "google", level: "campaign", account: conn.id, cfrom: "2026-08-02", cto: "2026-08-31" });
  });

  it("down from a campaign, with today in the dates: its ad groups added up on top, said so, and today's figures still coming in", async () => {
    const conn = await googleConnection();
    const today = localDay(new Date(), "UTC");
    const from = addDays(today, -6);
    const groups = report(from, today, "ad_group", g(20, 1), [{ id: "55", name: "Shoes", campaignId: "7", campaignName: "Brand", ...g(20, 1) }]);
    await ctx.deps.coord.put(`ads-greport:v4:${conn.id}:ad_group:7:-:${from}:${today}`, JSON.stringify(groups), 600);
    const res = await get(url(conn.id, { level: "ad_group", campaign: "7", from, to: today, format: "csv" }));
    expect(res.statusCode, res.body).toBe(200);
    const rows = rowsOf(res.body);
    expect(rows[1]![0]).toBe("All ad groups in this campaign");
    const said = rows.filter((r) => r[0] === "Note").map((r) => r[1]);
    expect(said).toContain("The top row adds up every row Google reported for these dates (not Google's own row for it).");
    expect(said).toContainEqual(expect.stringMatching(/^Today's numbers are still coming in: Google/));
    expect(calls).toEqual([]);
  });
});

describe("the Google Ads analytics page's downloads", () => {
  const base = () => `/workspaces/${ws}/stores/${storeId}/ads/google/analytics/export`;

  async function demo() {
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/demo/connect`, headers, payload: {} });
    expect(res.statusCode).toBe(200);
    const jobs = ctx.deps.queues.sent.sync as unknown as AdsSyncData[];
    for (const j of jobs.splice(0, jobs.length).filter((x) => x.kind === "ads")) {
      await syncAdConnection(j.connectionId, j.since, j.until, ctx.deps.fetchImpl, { trigger: j.trigger, queues: ctx.deps.queues, coord: ctx.deps.coord });
    }
    return systemDb.adConnection.findFirstOrThrow({ where: { storeId, isDemo: true } });
  }

  it("the overview: each figure, marked simulated; audited with the part", async () => {
    const conn = await demo();
    const res = await get(`${base()}?part=overview&preset=7d`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/filename="bizinsights-google-ads-demo-simulated-DEMO-ADS-001-overview-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
    const [header, simulated, ...rows] = rowsOf(res.body);
    expect(header).toEqual(["Measure", "Value", "Note"]);
    expect(simulated![0]).toBe("Simulated data");
    expect(rows.map((r) => r[0])).toEqual([
      "Spend (AUD)",
      "Impressions",
      "Clicks",
      "Click-through rate (%)",
      "Cost per click (AUD)",
      "Cost per 1,000 impressions (AUD)",
      "Conversions (simulated, all conversion actions)",
      "Conversion rate (%)",
      "Cost per conversion (AUD)",
      "Conversion value (AUD; simulated)",
      "Conversion value / cost",
    ]);
    // The same figures the page shows.
    const page = (await get(`/workspaces/${ws}/stores/${storeId}/ads/google/analytics?preset=7d`)).json();
    expect(Number(rows[0]![1])).toBe(page.overview.current.spend);
    expect(Number(rows[1]![1])).toBe(page.overview.current.impressions);
    expect(calls).toEqual([]);
    expect((await exported())[0]).toMatchObject({ targetId: storeId, metadata: { section: "google_ads_analytics", part: "overview", platform: "google", account: conn.id, demo: true } });
  });

  it("by day: every day of the dates, and a day the account hasn't stored says so, never 0", async () => {
    await demo();
    const today = localDay(new Date(), "Australia/Melbourne");
    const from = addDays(today, -120);
    const to = addDays(today, -1);
    const res = await get(`${base()}?part=days&preset=custom&from=${from}&to=${to}`);
    expect(res.statusCode, res.body).toBe(200);
    const [header, , ...days] = rowsOf(res.body);
    expect(header!.slice(0, 4)).toEqual(["Day", "From", "To", "Spend (AUD)"]);
    expect(header!.at(-1)).toBe("Note");
    expect(days).toHaveLength(120);
    // The demo holds 90 days: the first 30 of these aren't stored.
    expect(days[0]!.slice(0, 4)).toEqual([from, from, from, "Not stored"]);
    expect(days[0]!.at(-1)).toBe("No figures are stored for these days.");
    expect(days.at(-1)![3]).not.toBe("Not stored");
    expect(Number(days.at(-1)![3])).toBeGreaterThanOrEqual(0);
  });

  it("devices, audience, recommendations and the demo store: each section the page shows", async () => {
    await demo();
    const devices = rowsOf((await get(`${base()}?part=devices&preset=30d`)).body);
    expect(devices[0]!.slice(0, 3)).toEqual(["Device", "Share of spend (%)", "Spend (AUD)"]);
    expect(devices.length).toBeGreaterThan(3);
    const audience = rowsOf((await get(`${base()}?part=audience&preset=30d`)).body);
    expect(new Set(audience.slice(2).map((r) => r[0]))).toEqual(new Set(["Age group", "Country", "Audience segment", "Device", "Note"]));
    const recs = await get(`${base()}?part=recommendations&preset=30d`);
    expect(recs.statusCode).toBe(200);
    expect(rowsOf(recs.body)[0]).toEqual(["Kind", "Campaign", "Recommendation", "What it saw"]);
    const combined = rowsOf((await get(`${base()}?part=combined&preset=7d`)).body);
    expect(combined[0]![1]).toBe("Orders (simulated store)");
    expect(combined.some((r) => r[0] === "Total")).toBe(true);
    expect(calls).toEqual([]);
    expect(await exported()).toHaveLength(4);
  });

  it("needs the export permission and the page's own, and View campaigns for the campaigns; a part it doesn't know is refused", async () => {
    await demo();
    const m = await member("viewer@x.com", ["marketing.ads"]);
    expect((await get(`${base()}?part=overview&preset=7d`, m.headers)).statusCode).toBe(403);
    await m.grant(["reports.export"]);
    expect((await get(`${base()}?part=overview&preset=7d`, m.headers)).statusCode).toBe(403);
    await m.grant(["marketing.ads", "reports.export"]);
    expect((await get(`${base()}?part=overview&preset=7d`, m.headers)).statusCode).toBe(200);
    expect((await get(`${base()}?part=campaigns&preset=7d`, m.headers)).statusCode).toBe(403);
    expect((await get(`${base()}?part=recommendations&preset=7d`, m.headers)).statusCode).toBe(403);
    await m.grant(["marketing.ads", "marketing.campaigns", "reports.export"]);
    const campaigns = await get(`${base()}?part=campaigns&preset=7d`, m.headers);
    expect(campaigns.statusCode).toBe(200);
    expect(rowsOf(campaigns.body)[0]!.slice(0, 4)).toEqual(["Campaign", "Google id", "Campaign type", "Status"]);
    expect((await get(`${base()}?part=everything&preset=7d`)).statusCode).toBe(400);
    expect(await exported()).toHaveLength(2);
  });

  it("another business: its store and its connection are not found, before the query is read", async () => {
    const conn = await demo();
    const other = await signIn(ctx, "export-other", "other@y.com");
    const otherWs = await createWorkspace(ctx, other.headers, "Other");
    const otherStore = (await createStore(otherWs, "other-shop.myshopify.com", ["read_orders"])).id;
    expect((await get(`${base()}?part=overview&preset=7d`, other.headers)).statusCode).toBe(404);
    expect((await get(`/workspaces/${otherWs}/stores/${storeId}/ads/google/analytics/export`, other.headers)).statusCode).toBe(404);
    expect((await get(`/workspaces/${otherWs}/stores/${otherStore}/ads/google/analytics/export?part=overview&preset=7d&connection=${conn.id}`, other.headers)).statusCode).toBe(404);
    expect(await exported()).toHaveLength(0);
  });
});

describe("a real Google Ads account's analytics downloads: its device and country splits read from Google, as the page reads them", () => {
  const base = () => `/workspaces/${ws}/stores/${storeId}/ads/google/analytics/export`;
  const metrics = (cost: number) => ({ costMicros: String(cost * 1_000_000), impressions: "1000", clicks: "40", conversions: 2, conversionsValue: 80 });
  /** Google's answers for the splits: the account's own row, its devices, its countries and their codes. */
  const google = (queries: string[]): FetchLike => async (input, init) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    if (!u.pathname.endsWith("googleAds:searchStream")) return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    queries.push(query);
    if (query.includes("segments.device")) return json([{ results: [{ segments: { device: "MOBILE" }, metrics: metrics(30) }, { segments: { device: "DESKTOP" }, metrics: metrics(10) }] }]);
    if (query.includes("FROM user_location_view")) return json([{ results: [{ userLocationView: { countryCriterionId: "2036" }, metrics: metrics(40) }] }]);
    if (query.includes("FROM geo_target_constant")) return json([{ results: [{ geoTargetConstant: { id: "2036", countryCode: "AU" } }] }]);
    return json([{ results: [{ metrics: metrics(40) }] }]);
  };
  /** The account once its first sync has landed: Google isn't asked for its splits before (adsGoogleAnalytics.test.ts). */
  const synced = async () => systemDb.adConnection.update({ where: { id: (await googleConnection()).id }, data: { lastSyncedAt: new Date() } });

  it("read: each device's share of the spend and Google's figures, by the connection asked for, in the audit log", async () => {
    ctx.setEnv({ ...ENV, GOOGLE_ADS_CLIENT_ID: "g_client", GOOGLE_ADS_CLIENT_SECRET: "g_secret", GOOGLE_ADS_ENABLED: "1" });
    const conn = await synced();
    const queries: string[] = [];
    ctx.setFetch(google(queries));
    const res = await get(`${base()}?part=devices&preset=7d&connection=${conn.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/filename="bizinsights-google-ads-1234567890-devices-/);
    const [header, phones, computers, ...rest] = rowsOf(res.body);
    expect(header!.slice(0, 3)).toEqual(["Device", "Share of spend (%)", "Spend (USD)"]);
    expect(header).toContain("Conversions (Google's count, all conversion actions)");
    // A real account's file has no simulated row.
    expect(phones!.slice(0, 3)).toEqual(["Phones", "75", "30"]);
    expect(computers!.slice(0, 3)).toEqual(["Computers", "25", "10"]);
    expect(rest).toEqual([]);
    expect(queries.some((q) => q.includes("segments.device"))).toBe(true);
    expect(queries.some((q) => q.includes("FROM user_location_view"))).toBe(true);
    expect(res.body).not.toContain("G_ACCESS_SECRET");

    const audience = rowsOf((await get(`${base()}?part=audience&preset=7d&connection=${conn.id}`)).body);
    // Age and segments aren't read for a real account: said so, never 0.
    expect(audience.find((r) => r[0] === "Age group")).toEqual(["Age group", "Not available for this account"]);
    expect(audience.find((r) => r[0] === "Country")!.slice(1, 4)).toEqual(["Australia", "100", "40"]);
    expect(audience.find((r) => r[0] === "Device" && r[1] === "Phones")).toBeDefined();
    expect((await exported()).map((e) => e.metadata)).toEqual([
      expect.objectContaining({ section: "google_ads_analytics", part: "devices", platform: "google", account: conn.id }),
      expect.objectContaining({ part: "audience", account: conn.id }),
    ]);
    expect((await exported())[0]!.metadata).not.toHaveProperty("demo");
  });

  it("not read (Google not set up here, or not answering): the file says why, in place of figures", async () => {
    const conn = await synced();
    const res = await get(`${base()}?part=devices&preset=7d&connection=${conn.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const [header, why, ...rest] = rowsOf(res.body);
    expect(header!.slice(0, 2)).toEqual(["Device", "Share of spend (%)"]);
    expect(why).toEqual(["Not available", expect.stringMatching(/^Google's device and country splits couldn't be read just now/)]);
    expect(rest).toEqual([]);
    const audience = rowsOf((await get(`${base()}?part=audience&preset=7d&connection=${conn.id}`)).body);
    expect(audience.filter((r) => r[1] === "Not available for this account").map((r) => r[0])).toEqual(["Age group", "Country", "Audience segment", "Device"]);
    expect(audience.at(-1)).toEqual(["Note", expect.stringMatching(/^Google's device and country splits couldn't be read just now/)]);
    expect(calls).toEqual([]);
  });
});
