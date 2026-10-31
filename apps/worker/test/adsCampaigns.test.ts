import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { encryptAdTokens, resetEnvCache, syncAdConnection, type FetchLike } from "@app/core";
import { addDays, localDay } from "@app/shared";

/**
 * Each campaign as its platform last described it (ad_campaigns): the syncs keep its name and delivery
 * status, Google's from the daily query itself, Meta's from the account's campaign list read alongside
 * its insights, for the Advertising pages' campaign filters.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const KEYS = { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1" };

beforeAll(() => {
  Object.assign(process.env, KEYS);
  resetEnvCache();
});
afterAll(async () => disconnectDb());
beforeEach(async () => resetDb());

let n = 0;
async function connection(provider: "meta" | "google") {
  const ws = await systemDb.workspace.create({ data: { name: `W${++n}` } });
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `c${n}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-c${n}` } });
  const enc = encryptAdTokens(store.id, provider, { accessToken: "ACCESS", refreshToken: provider === "meta" ? null : "REFRESH", expiresAt: new Date(Date.now() + 86_400_000) });
  return systemDb.adConnection.create({
    data: { workspaceId: ws.id, storeId: store.id, provider, accountId: provider === "meta" ? "act_1" : "111", accountName: "Shop ads", currency: "USD", timezone: "UTC", ...enc },
  });
}

const today = () => localDay(new Date(), "UTC");
const campaigns = (connectionId: string) => systemDb.adCampaign.findMany({ where: { connectionId }, orderBy: { campaignId: "asc" }, select: { campaignId: true, name: true, status: true, provider: true, accountId: true } });

describe("campaign statuses", () => {
  it("Google: read with the daily figures, kept per campaign under its latest name", async () => {
    const conn = await connection("google");
    const day = today();
    const yesterday = addDays(day, -1);
    const google = (status: string): FetchLike => async (_input, init) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      expect(query).toContain("campaign.status");
      if (query.includes("conversion_action_category")) return json([{ results: [] }]);
      return json([
        {
          results: [
            { campaign: { id: "5", name: "Brand (old name)", status }, segments: { date: yesterday }, metrics: { costMicros: "1000000", impressions: "10", clicks: "1", conversions: 0 } },
            { campaign: { id: "5", name: "Brand", status }, segments: { date: day }, metrics: { costMicros: "2000000", impressions: "20", clicks: "2", conversions: 0 } },
            { campaign: { id: "6", name: "Old promo", status: "REMOVED" }, segments: { date: day }, metrics: { costMicros: "0", impressions: "0", clicks: "0", conversions: 0 } },
          ],
        },
      ]);
    };
    await syncAdConnection(conn.id, yesterday, day, google("ENABLED"));
    expect(await campaigns(conn.id)).toEqual([
      { campaignId: "5", name: "Brand", status: "ENABLED", provider: "google", accountId: "111" },
      { campaignId: "6", name: "Old promo", status: "REMOVED", provider: "google", accountId: "111" },
    ]);
    // Paused since: the next sync says so; one row per campaign, never a second.
    await syncAdConnection(conn.id, day, day, google("PAUSED"));
    expect((await campaigns(conn.id)).map((c) => [c.campaignId, c.status])).toEqual([["5", "PAUSED"], ["6", "REMOVED"]]);
  });

  it("Meta: read from the account's campaign list alongside the insights; a list that fails keeps what was known", async () => {
    const conn = await connection("meta");
    const day = today();
    let listFails = false;
    const asked: string[] = [];
    const meta: FetchLike = async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/act_1/insights") && u.searchParams.get("level") === "account") return json({ data: [] });
      if (u.pathname.endsWith("/act_1/insights")) {
        return json({ data: [{ campaign_id: "9", campaign_name: "Spring", date_start: day, spend: "5", impressions: "100", clicks: "4", inline_link_clicks: "3" }] });
      }
      if (u.pathname.endsWith("/act_1/campaigns")) {
        asked.push(u.searchParams.get("fields") ?? "");
        if (listFails) return json({ error: { message: "Please reduce the amount of data", code: 1 } }, 500);
        return json({ data: [{ id: "9", effective_status: "CAMPAIGN_PAUSED" }, { id: "10", effective_status: "ACTIVE" }] });
      }
      return json({ error: { message: `unexpected ${u.pathname}`, code: 100 } }, 400);
    };
    const first = await syncAdConnection(conn.id, day, day, meta);
    expect(first).toMatchObject({ stored: 1 });
    expect(await campaigns(conn.id)).toEqual([{ campaignId: "9", name: "Spring", status: "CAMPAIGN_PAUSED", provider: "meta", accountId: "act_1" }]);
    expect(asked).toHaveLength(1);

    // Meta's list fails this time: the days are stored all the same, the status stays as last read.
    listFails = true;
    const second = await syncAdConnection(conn.id, day, day, meta);
    expect(second).toMatchObject({ stored: 1 });
    expect((await campaigns(conn.id)).map((c) => c.status)).toEqual(["CAMPAIGN_PAUSED"]);
    expect(await systemDb.adCampaignDaily.count({ where: { connectionId: conn.id } })).toBe(1);
  });

  it("go with their connection when it is disconnected", async () => {
    const conn = await connection("google");
    await systemDb.adCampaign.create({ data: { workspaceId: conn.workspaceId, storeId: conn.storeId, connectionId: conn.id, provider: "google", accountId: "111", campaignId: "5", name: "Brand", status: "ENABLED", checkedAt: new Date() } });
    await systemDb.adConnection.delete({ where: { id: conn.id } });
    expect(await systemDb.adCampaign.count()).toBe(0);
  });
});

const facts = (connectionId: string) =>
  systemDb.adCampaign
    .findMany({ where: { connectionId }, orderBy: { campaignId: "asc" }, select: { campaignId: true, status: true, channelType: true, primaryStatus: true, primaryStatusReasons: true, budgetPeriod: true, budgetAmount: true } })
    .then((rows) => rows.map((r) => ({ ...r, budgetAmount: r.budgetAmount === null ? null : Number(r.budgetAmount) })));

describe("campaign facts: type, primary status and budget", () => {
  it("Google: read in the days' own query (one operation), kept per campaign; a sync Google refuses them to keeps what was known", async () => {
    const conn = await connection("google");
    const day = today();
    let refuse = false;
    const queries: string[] = [];
    const google: FetchLike = async (_input, init) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      queries.push(query);
      if (refuse && query.includes("primary_status")) {
        return json([{ error: { code: 400, status: "INVALID_ARGUMENT", message: "bad field", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure", errors: [{ errorCode: { queryError: "UNRECOGNIZED_FIELD" }, message: "bad field" }] }] } }], 400);
      }
      const extra = (c: Record<string, unknown>, b: Record<string, unknown>) => (query.includes("primary_status") ? { campaign: c, campaignBudget: b } : { campaign: { id: c.id, name: c.name, status: c.status } });
      return json([
        {
          results: [
            { ...extra({ id: "5", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"] }, { period: "DAILY", amountMicros: "40000000" }), segments: { date: day }, metrics: { costMicros: "2000000", impressions: "20", clicks: "2", conversions: 0 } },
            { ...extra({ id: "6", name: "Launch", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", primaryStatus: "ELIGIBLE" }, { period: "CUSTOM_PERIOD", totalAmountMicros: "500000000" }), segments: { date: day }, metrics: { costMicros: "1000000", impressions: "10", clicks: "1", conversions: 0 } },
          ],
        },
      ]);
    };
    await syncAdConnection(conn.id, day, day, google);
    // One query: the facts cost no operation of their own.
    expect(queries).toHaveLength(1);
    expect(await facts(conn.id)).toEqual([
      { campaignId: "5", status: "ENABLED", channelType: "SEARCH", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"], budgetPeriod: "DAILY", budgetAmount: 40 },
      { campaignId: "6", status: "ENABLED", channelType: "PERFORMANCE_MAX", primaryStatus: "ELIGIBLE", primaryStatusReasons: [], budgetPeriod: "CUSTOM_PERIOD", budgetAmount: 500 },
    ]);
    // Google refuses the facts' fields this time: the days are read without them, and the facts stay as last read.
    refuse = true;
    queries.length = 0;
    expect(await syncAdConnection(conn.id, day, day, google)).toMatchObject({ skipped: false, stored: 2 });
    expect(queries).toHaveLength(2);
    expect((await facts(conn.id)).map((c) => [c.campaignId, c.primaryStatus, c.budgetAmount])).toEqual([["5", "LIMITED", 40], ["6", "ELIGIBLE", 500]]);
  });

  it("Meta: each campaign's own budget from the same campaign list as its status, in the account's currency; a list without its settings keeps the budgets", async () => {
    const conn = await connection("meta");
    const day = today();
    let bare = false;
    const asked: string[] = [];
    const meta: FetchLike = async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/act_1/insights") && u.searchParams.get("level") === "account") return json({ data: [] });
      if (u.pathname.endsWith("/act_1/insights")) {
        return json({
          data: [
            { campaign_id: "9", campaign_name: "Spring", date_start: day, spend: "5", impressions: "100", clicks: "4", inline_link_clicks: "3" },
            { campaign_id: "10", campaign_name: "Evergreen", date_start: day, spend: "3", impressions: "50", clicks: "1", inline_link_clicks: "1" },
            { campaign_id: "11", campaign_name: "By ad set", date_start: day, spend: "1", impressions: "20", clicks: "0", inline_link_clicks: "0" },
          ],
        });
      }
      if (u.pathname.endsWith("/act_1/campaigns")) {
        const fields = u.searchParams.get("fields") ?? "";
        asked.push(fields);
        // Meta refusing the settings' fields (a permission it no longer grants): the list is read again for statuses alone.
        if (bare && fields.includes("daily_budget")) return json({ error: { message: "(#100) Tried accessing nonexisting field (daily_budget)", type: "OAuthException", code: 100 } }, 400);
        return json({
          data: bare
            ? [{ id: "9", effective_status: "PAUSED" }, { id: "10", effective_status: "ACTIVE" }, { id: "11", effective_status: "ACTIVE" }]
            : [
                { id: "9", effective_status: "ACTIVE", daily_budget: "2500" },
                { id: "10", effective_status: "ACTIVE", lifetime_budget: "90000" },
                { id: "11", effective_status: "ACTIVE" },
              ],
        });
      }
      return json({ error: { message: `unexpected ${u.pathname}`, code: 100 } }, 400);
    };
    await syncAdConnection(conn.id, day, day, meta);
    expect(asked).toHaveLength(1);
    expect(await facts(conn.id)).toEqual([
      { campaignId: "10", status: "ACTIVE", channelType: null, primaryStatus: null, primaryStatusReasons: [], budgetPeriod: "LIFETIME", budgetAmount: 900 },
      // Its budgets are its ad sets': none of its own.
      { campaignId: "11", status: "ACTIVE", channelType: null, primaryStatus: null, primaryStatusReasons: [], budgetPeriod: null, budgetAmount: null },
      { campaignId: "9", status: "ACTIVE", channelType: null, primaryStatus: null, primaryStatusReasons: [], budgetPeriod: "DAILY", budgetAmount: 25 },
    ]);
    bare = true;
    await syncAdConnection(conn.id, day, day, meta);
    // The status is read again; the budgets weren't, so they stay as last read.
    expect((await facts(conn.id)).map((c) => [c.campaignId, c.status, c.budgetPeriod, c.budgetAmount])).toEqual([
      ["10", "ACTIVE", "LIFETIME", 900],
      ["11", "ACTIVE", null, null],
      ["9", "PAUSED", "DAILY", 25],
    ]);
  });
});
