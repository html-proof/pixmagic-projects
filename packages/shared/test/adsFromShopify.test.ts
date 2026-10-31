import { describe, expect, it } from "vitest";
import { redactOverview, type MemberAccess } from "../src/access";
import { adsFromShopify, adsFromShopifyWithoutAttribution, type SourcedDay, type SourcedSales } from "../src/adsFromShopify";

const range = { from: "2026-10-01", to: "2026-10-03" };
const compared = { from: "2026-09-28", to: "2026-09-30" };

const rows: SourcedSales[] = [
  { source: "facebook", medium: "paid", campaign: "Diwali", orders: 2, sales: 100 },
  { source: "facebook", medium: "unpaid", campaign: null, orders: 1, sales: 30 },
  { source: "instagram", medium: "paid", campaign: "Diwali", orders: 1, sales: 70 },
  { source: "google", medium: "paid", campaign: "Search brand", orders: 1, sales: 50 },
  { source: "youtube", medium: "unpaid", campaign: null, orders: 1, sales: 25.5 },
  { source: "direct", medium: "direct", campaign: null, orders: 3, sales: 200 },
  // Not read from Shopify yet.
  { source: null, medium: null, campaign: null, orders: 2, sales: 24.5 },
];
const days: SourcedDay[] = [
  { day: "2026-10-01", source: "facebook", medium: "paid", orders: 2, sales: 100 },
  { day: "2026-10-02", source: "instagram", medium: "paid", orders: 1, sales: 70 },
  { day: "2026-10-02", source: "facebook", medium: "unpaid", orders: 1, sales: 30 },
  { day: "2026-10-03", source: "google", medium: "paid", orders: 1, sales: 50 },
  { day: "2026-10-03", source: "youtube", medium: "unpaid", orders: 1, sales: 25.5 },
];

const ask = (over: Partial<Parameters<typeof adsFromShopify>[0]> = {}) =>
  adsFromShopify({ providers: ["meta", "google"], rows, days, previousRows: null, range, compared, currency: "AUD", historyFrom: "2026-01-01", ...over });

describe("Meta and Google advertising from the store's own orders", () => {
  it("adds up each platform's sources: Facebook and Instagram for Meta, Google and YouTube for Google, tagged ads apart", () => {
    const m = ask();
    expect(m.storeSales).toBe(500);
    expect(m.pending).toBe(2);
    const [meta, google] = m.platforms;
    expect(meta).toMatchObject({ provider: "meta", orders: 4, sales: 200, paidOrders: 3, paidSales: 170 });
    expect(meta!.share).toBeCloseTo(200 / 500);
    expect(meta!.sources).toEqual([
      { source: "facebook", label: "Facebook", orders: 3, sales: 130, paidOrders: 2, paidSales: 100 },
      { source: "instagram", label: "Instagram", orders: 1, sales: 70, paidOrders: 1, paidSales: 70 },
    ]);
    expect(google).toMatchObject({ provider: "google", orders: 2, sales: 75.5, paidOrders: 1, paidSales: 50 });
    // Each campaign under the source its links named, the biggest first; untagged visits have none.
    expect(meta!.campaigns).toEqual([
      { source: "facebook", label: "Facebook", campaign: "Diwali", orders: 2, sales: 100, paidSales: 100 },
      { source: "instagram", label: "Instagram", campaign: "Diwali", orders: 1, sales: 70, paidSales: 70 },
    ]);
    expect(google!.campaigns).toEqual([{ source: "google", label: "Google", campaign: "Search brand", orders: 1, sales: 50, paidSales: 50 }]);
  });

  it("gives every day of the dates, a day without orders as 0 and a day before the imported orders as unknown", () => {
    const [meta] = ask().platforms;
    expect(meta!.daily).toEqual([
      { day: "2026-10-01", orders: 2, sales: 100, paidSales: 100 },
      { day: "2026-10-02", orders: 2, sales: 100, paidSales: 70 },
      { day: "2026-10-03", orders: 0, sales: 0, paidSales: 0 },
    ]);
    const [late] = ask({ historyFrom: "2026-10-02" }).platforms;
    expect(late!.daily[0]).toEqual({ day: "2026-10-01", orders: null, sales: null, paidSales: null });
    expect(late!.daily[1]!.sales).toBe(100);
    const [none] = ask({ historyFrom: null }).platforms;
    expect(none!.daily.every((d) => d.sales === null)).toBe(true);
  });

  it("compares with the dates before only when their orders were read, never against a made-up 0", () => {
    const m = ask({ previousRows: [{ source: "facebook", medium: "paid", orders: 1, sales: 100 }, { source: "google", medium: "unpaid", orders: 1, sales: 0 }] });
    expect(m.compared).toEqual(compared);
    const [meta, google] = m.platforms;
    expect(meta!.previous).toEqual({ orders: 1, sales: 100, paidOrders: 1, paidSales: 100 });
    expect(meta!.deltas.sales).toBeCloseTo(1);
    expect(meta!.deltas.orders).toBeCloseTo(3);
    expect(meta!.deltas.paidSales).toBeCloseTo(0.7);
    // Nothing to set a change against: no change, rather than an infinite one.
    expect(google!.deltas.sales).toBeNull();

    const not = ask();
    expect(not.compared).toBeNull();
    expect(not.platforms[0]!.previous).toBeNull();
    expect(not.platforms[0]!.deltas).toEqual({ orders: null, sales: null, paidSales: null });
  });

  it("answers one platform alone, and has no share of no sales", () => {
    const m = ask({ providers: ["google"], rows: [{ source: "google", medium: "unpaid", orders: 1, sales: 0 }], days: [] });
    expect(m.platforms.map((p) => p.provider)).toEqual(["google"]);
    expect(m.platforms[0]!.share).toBeNull();
    expect(m.platforms[0]!.sources.map((s) => [s.source, s.orders])).toEqual([
      ["google", 1],
      ["youtube", 0],
    ]);
  });

  it("leaves out the tagged-ad figures and the campaigns without View conversion attribution", () => {
    const m = adsFromShopifyWithoutAttribution(ask({ previousRows: [{ source: "facebook", medium: "paid", orders: 1, sales: 100 }] }));
    const text = JSON.stringify(m);
    expect(text).not.toContain("paidOrders");
    expect(text).not.toContain("paidSales");
    expect(text).not.toContain("Diwali");
    const [meta] = m.platforms;
    expect(meta).toMatchObject({ orders: 4, sales: 200, previous: { orders: 1, sales: 100 } });
    expect(meta!.deltas).toEqual({ orders: 3, sales: 1 });
    expect(meta!.daily[0]).toEqual({ day: "2026-10-01", orders: 2, sales: 100 });
  });

  it("goes to whoever sees traffic sources (Team & Access), the tagged-ad figures only with attribution", () => {
    const report = () => ({ modules: { ads_from_shopify: ask() as unknown }, capabilities: [] });
    const member = (permissions: string[]): MemberAccess => ({ role: "custom", permissions });
    expect(redactOverview(report(), member(["marketing.ads"])).modules).not.toHaveProperty("ads_from_shopify");
    const seen = redactOverview(report(), member(["analytics.traffic", "marketing.ads"])).modules.ads_from_shopify as ReturnType<typeof ask>;
    expect(seen.platforms[0]).toMatchObject({ orders: 4, sales: 200 });
    expect(seen.platforms[0]).not.toHaveProperty("paidSales");
    expect(seen.platforms[0]).not.toHaveProperty("campaigns");
    const all = redactOverview(report(), member(["analytics.traffic", "marketing.attribution"])).modules.ads_from_shopify as ReturnType<typeof ask>;
    expect(all.platforms[0]).toMatchObject({ paidSales: 170, campaigns: expect.any(Array) });
  });
});
