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
