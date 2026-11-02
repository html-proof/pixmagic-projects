import { describe, expect, it } from "vitest";
import { addDays, eachDay, type AdDayRow } from "@app/shared";
import { adsFigures, type AdConn, type AdsAsk } from "../src/reports/ads.js";

// Noon UTC on 19 Oct 2026, as in adsReport.test.ts.
const NOW = new Date("2026-10-19T12:00:00Z");
const TODAY = "2026-10-19";
const d = (n: number) => addDays(TODAY, n);

const conn = (over: Partial<AdConn> & Pick<AdConn, "id">): AdConn => ({
  provider: "meta",
  accountId: `act_${over.id}`,
  accountName: `Account ${over.id}`,
  currency: "USD",
  timezone: "UTC",
  status: "active",
  errorCode: null,
  accountStatus: null,
  lastSyncedAt: new Date("2026-10-19T11:00:00Z"),
  historyFrom: d(-89),
  syncedThrough: TODAY,
  ...over,
});

/** Every day of `from`..`to` for `c`: $10 spent, one purchase worth $40 credited to the ads. */
const daily = (c: AdConn, from: string, to: string, over: Partial<AdDayRow> = {}): Array<AdDayRow & { connectionId: string }> =>
  eachDay(from, to).map((day) => ({
    connectionId: c.id,
    provider: c.provider as "meta" | "google",
    accountId: c.accountId,
    campaignId: "1",
    campaignName: "Spring",
    day,
    spend: 10,
    impressions: 1000,
    clicks: 30,
    linkClicks: 20,
    conversions: 1,
    conversionValue: 40,
    purchases: 1,
    purchaseValue: 40,
    leads: 0,
    ...over,
  }));

const week = (over: Partial<AdsAsk> = {}): AdsAsk => ({
  range: { from: d(-6), to: TODAY },
  previous: { from: d(-13), to: d(-7), until: "12:00:00" },
  storeCurrency: "USD",
  storeTimeZone: "UTC",
  netSales: 1000,
  orders: 20,
  now: NOW,
  ...over,
});

describe("purchases across platforms", () => {
  it("says the purchase totals are one platform's while one is counted, however many of its accounts", () => {
    const a = conn({ id: "a" });
    const b = conn({ id: "b" });
    const m = adsFigures([a, b], [...daily(a, d(-13), TODAY), ...daily(b, d(-13), TODAY)], week())!;
    expect(m.claimsAddUp).toBe(true);
    expect(m.current).toMatchObject({ spend: 140, purchases: 14, purchaseValue: 560, roas: 4 });
  });

  it("with Meta and Google both counted, the purchase totals add claims that can overlap: each platform's own stays apart, and the store's sales count every order once", () => {
    const meta = conn({ id: "m" });
    const google = conn({ id: "g", provider: "google", accountId: "123" });
    // Both platforms credit the same 7 orders to their ads, one a day.
    const m = adsFigures([google, meta], [...daily(meta, d(-13), TODAY), ...daily(google, d(-13), TODAY)], week())!;
    expect(m.claimsAddUp).toBe(false);
    // The totals add the two claims up (14 purchases worth $560, for 7 orders): a page must not show them as one figure.
    expect(m.current).toMatchObject({ spend: 140, purchases: 14, purchaseValue: 560, roas: 4 });
    // Each platform's own claim, on its own spend.
    expect(m.byProvider.map((p) => [p.provider, p.spend, p.purchases, p.purchaseValue, p.roas, p.costPerPurchase])).toEqual([
      ["google", 70, 7, 280, 4, 10],
      ["meta", 70, 7, 280, 4, 10],
    ]);
    // Across platforms, the store's own sales against the spend added up (spend adds: each platform billed its own).
    expect(m.sales).toMatchObject({ netSales: 1000, orders: 20, salesPerSpend: 7.14 });
  });
});

describe("accounts left out in another currency", () => {
  it("lists the accounts not added up, once, so a cost from the spend shown is known to be short", () => {
    const usd = conn({ id: "u", accountName: "US shop" });
    const eur = conn({ id: "x", accountName: "EU shop", currency: "EUR" });
    const gbp = conn({ id: "y", provider: "google", accountId: "456", accountName: null, currency: "GBP" });
    const rows = [...daily(usd, d(-13), TODAY), ...daily(eur, d(-13), TODAY, { spend: 999 }), ...daily(gbp, d(-13), TODAY, { spend: 555 })];
    const m = adsFigures([usd, eur, gbp], rows, week())!;
    expect(m.currency).toBe("USD");
    // The dollar spend alone: the euro and pound accounts' spend is in none of the figures.
    expect(m.current?.spend).toBe(70);
    expect(m.leftOut).toEqual([
      { id: "x", provider: "meta", accountId: "act_x", name: "EU shop", currency: "EUR" },
      { id: "y", provider: "google", accountId: "456", name: null, currency: "GBP" },
    ]);
    // Only the counted platforms' claims are compared: a left-out Google account makes no second platform.
    expect(m.claimsAddUp).toBe(true);
    expect(m.byProvider.map((p) => p.provider)).toEqual(["meta"]);
  });

  it("never lists the Google Ads demo, whose spend is simulated, and lists nothing when every account is counted", () => {
    const usd = conn({ id: "u" });
    const demo = conn({ id: "demo", provider: "google", accountId: "999", currency: "EUR", isDemo: true });
    const m = adsFigures([usd, demo], [...daily(usd, d(-13), TODAY), ...daily(demo, d(-13), TODAY)], week())!;
    expect(m.accounts.find((a) => a.id === "demo")).toMatchObject({ counted: false, demo: true });
    expect(m.leftOut).toEqual([]);
    expect(adsFigures([usd], daily(usd, d(-13), TODAY), week())!.leftOut).toEqual([]);
  });

  it("with no account in the store's currency, the others are left out of the first account's", () => {
    const eur = conn({ id: "x", currency: "EUR" });
    const gbp = conn({ id: "y", currency: "GBP" });
    const m = adsFigures([eur, gbp], [...daily(eur, d(-13), TODAY), ...daily(gbp, d(-13), TODAY)], week())!;
    expect(m.currency).toBe("EUR");
    expect(m.leftOut.map((a) => a.id)).toEqual(["y"]);
    // Nothing in the store's currency: nothing set against its sales.
    expect(m.sales).toBeNull();
    expect(m.shareOfSales).toBeNull();
  });
});
