import { describe, expect, it } from "vitest";
import { memoryCoord } from "../src/coord.js";
import { memoryQueues } from "../src/queues.js";
import { marketingFirstDay, marketingQuery, marketingWindow, parseMarketingRows, requestShopifyMarketing } from "../src/shopifyMarketing.js";

const SHOW = "SHOW engagements_ad_spend, engagements_impressions, engagements_clicks, engagements_orders, engagements_total_sales, engagements_first_time_customers";

describe("ShopifyQL for the marketing apps' figures", () => {
  it("asks for whole days by channel and app, or by campaign too, in a stable order to page through", () => {
    expect(marketingQuery("channel", { from: "2026-08-04", to: "2026-11-01" })).toBe(
      `FROM marketing_engagements ${SHOW} GROUP BY day, marketing_channel, marketing_app_name SINCE 2026-08-04 UNTIL 2026-11-01 ORDER BY day ASC, marketing_channel ASC, marketing_app_name ASC LIMIT 1000`,
    );
    expect(marketingQuery("campaign", { from: "2026-10-30", to: "2026-11-01" }, 2000)).toBe(
      `FROM marketing_engagements ${SHOW} GROUP BY day, marketing_channel, marketing_app_name, marketing_campaign SINCE 2026-10-30 UNTIL 2026-11-01 ORDER BY day ASC, marketing_channel ASC, marketing_app_name ASC, marketing_campaign ASC LIMIT 1000 OFFSET 2000`,
    );
  });

  it("refuses a window that isn't two dates in order (ShopifyQL takes no variables)", () => {
    expect(() => marketingQuery("channel", { from: "2026-10-01 UNTIL today FROM sales", to: "2026-10-02" })).toThrow();
    expect(() => marketingQuery("channel", { from: "2026-10-03", to: "2026-10-02" })).toThrow();
    expect(() => marketingQuery("channel", { from: "2026-10-01", to: "2026-10-02" }, -1)).toThrow();
  });
});

describe("Shopify's rows in ours", () => {
  const columns = ["day", "marketing_channel", "marketing_app_name", "marketing_campaign", "engagements_ad_spend", "engagements_impressions", "engagements_clicks", "engagements_orders", "engagements_total_sales", "engagements_first_time_customers"].map((name) => ({ name }));

  it("reads rows keyed by column or in column order, Shopify's money as text, a figure left empty as null", () => {
    const rows = parseMarketingRows("channel", {
      tableData: {
        columns,
        rows: [
          { day: "2026-10-01", marketing_channel: "Meta Ads", marketing_app_name: "Facebook & Instagram", engagements_ad_spend: "40.25", engagements_impressions: 10000, engagements_clicks: "200", engagements_orders: 4, engagements_total_sales: "320.00", engagements_first_time_customers: null },
          ["2026-10-01T00:00:00-04:00", "Google Ads", "Google & YouTube", null, "", 900, 30, null, null, null],
        ],
      },
      parseErrors: [],
    });
    expect(rows).toEqual([
      { day: "2026-10-01", channel: "Meta Ads", app: "Facebook & Instagram", campaign: null, spend: 40.25, impressions: 10000, clicks: 200, orders: 4, sales: 320, newCustomers: null },
      { day: "2026-10-01", channel: "Google Ads", app: "Google & YouTube", campaign: null, spend: null, impressions: 900, clicks: 30, orders: null, sales: null, newCustomers: null },
    ]);
  });

  it("names a row with no channel by its app, leaves out rows without a day or campaign, and adds up rows Shopify keys the same", () => {
    const rows = parseMarketingRows("campaign", {
      tableData: {
        columns,
        rows: [
          { day: "2026-10-01", marketing_channel: "", marketing_app_name: "Pinterest", marketing_campaign: "Autumn", engagements_ad_spend: "5" },
          { day: "2026-10-01", marketing_channel: "", marketing_app_name: "Pinterest", marketing_campaign: "Autumn", engagements_ad_spend: "2.5", engagements_clicks: 3 },
          { day: "2026-10-01", marketing_channel: "Meta Ads", marketing_app_name: "Facebook & Instagram", marketing_campaign: "", engagements_ad_spend: "9" },
          { day: null, marketing_channel: "Meta Ads", marketing_campaign: "Lost", engagements_ad_spend: "9" },
        ],
      },
      parseErrors: [],
    });
    expect(rows).toEqual([{ day: "2026-10-01", channel: "Pinterest", app: "Pinterest", campaign: "Autumn", spend: 7.5, impressions: null, clicks: 3, orders: null, sales: null, newCustomers: null }]);
    expect(parseMarketingRows("channel", { tableData: { columns, rows: [] }, parseErrors: [] })).toEqual([]);
  });
});

describe("the days each read covers", () => {
  const today = "2026-11-02";
  const first = "2024-03-15";

  it("reads a store's last 90 days the first time, whatever the mode", () => {
    for (const mode of ["recent", "reconcile", "backfill"] as const) expect(marketingWindow(mode, null, today, first)).toEqual({ from: "2026-08-05", to: today });
    // A store newer than that: from its first day.
    expect(marketingWindow("recent", null, today, "2026-10-20")).toEqual({ from: "2026-10-20", to: today });
  });

  it("reads the last 3 days every 6 hours, from the day before the last read after a gap, and the last week daily", () => {
    const state = { coveredFrom: "2026-08-05", syncedThrough: today, backfilled: false };
    expect(marketingWindow("recent", state, today, first)).toEqual({ from: "2026-10-31", to: today });
    expect(marketingWindow("recent", { ...state, syncedThrough: "2026-10-20" }, today, first)).toEqual({ from: "2026-10-19", to: today });
    expect(marketingWindow("recent", { ...state, syncedThrough: "2026-01-01" }, today, first)).toEqual({ from: "2026-08-05", to: today });
    expect(marketingWindow("reconcile", state, today, first)).toEqual({ from: "2026-10-26", to: today });
  });

  it("walks the history back 90 days at a time to the store's first day, then stops", () => {
    const state = { coveredFrom: "2026-08-05", syncedThrough: today, backfilled: false };
    expect(marketingWindow("backfill", state, today, first)).toEqual({ from: "2026-05-07", to: "2026-08-04" });
    expect(marketingWindow("backfill", { ...state, coveredFrom: "2024-05-01" }, today, first)).toEqual({ from: first, to: "2024-04-30" });
    expect(marketingWindow("backfill", { ...state, coveredFrom: first }, today, first)).toBeNull();
    expect(marketingWindow("backfill", { ...state, backfilled: true }, today, first)).toBeNull();
  });

  it("starts the history at the store's own first day, or three years back when that isn't known", () => {
    expect(marketingFirstDay({ shopCreatedAt: new Date("2024-03-15T02:00:00Z"), timezone: "Australia/Melbourne" }, today)).toBe("2024-03-15");
    expect(marketingFirstDay({ shopCreatedAt: null, timezone: "UTC" }, today)).toBe("2023-11-03");
  });
});

describe("asking for a read", () => {
  it("queues one per mode while its lease holds the store, and gives the lease back when the send fails", async () => {
    const coord = memoryCoord();
    const queues = memoryQueues();
    const store = { id: "s1" };
    expect(await requestShopifyMarketing({ queues, coord }, store, "recent")).toBe(true);
    expect(await requestShopifyMarketing({ queues, coord }, store, "recent")).toBe(false);
    expect(await requestShopifyMarketing({ queues, coord }, store, "reconcile")).toBe(true);
    expect(queues.sent.sync).toEqual([
      { kind: "shopify_marketing", storeId: "s1", mode: "recent" },
      { kind: "shopify_marketing", storeId: "s1", mode: "reconcile" },
    ]);
    const failing = { ...queues, sync: { send: async () => Promise.reject(new Error("queue down")) } } as unknown as typeof queues;
    await expect(requestShopifyMarketing({ queues: failing, coord }, store, "backfill")).rejects.toThrow("queue down");
    expect(await requestShopifyMarketing({ queues, coord }, store, "backfill")).toBe(true);
  });
});
