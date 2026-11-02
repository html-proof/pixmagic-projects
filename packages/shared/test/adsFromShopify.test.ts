import { describe, expect, it } from "vitest";
import { redactOverview, type MemberAccess } from "../src/access";
import { adJourney, adPlatformSources, adsFromShopify, adsFromShopifyWithoutAttribution, visitsCounted, type AdSourceFacts, type SourcedDay, type SourcedSales } from "../src/adsFromShopify";

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

describe("the storefront's visits from each platform's sites", () => {
  const visits = { from: "2026-09-15", rows: [{ source: "facebook", visits: 40 }, { source: "instagram", visits: 10 }, { source: "google", visits: 7 }, { source: "direct", visits: 99 }] };

  it("adds up each platform's sources, from the dates' first day while the pixel recorded them all along", () => {
    const m = ask({ visits });
    expect(m.visitsFrom).toBe("2026-10-01");
    expect(m.platforms.map((p) => [p.provider, p.visits])).toEqual([
      ["meta", 50],
      ["google", 7],
    ]);
  });

  it("counts from the day the pixel began to record where visits came from, and none before it, never as 0", () => {
    expect(visitsCounted("2026-10-02", range)).toBe("2026-10-02");
    expect(visitsCounted("2026-09-01", range)).toBe("2026-10-01");
    // After the dates, or never: no day of them is counted.
    expect(visitsCounted("2026-10-04", range)).toBeNull();
    expect(visitsCounted(null, range)).toBeNull();
    const m = ask({ visits: { from: "2026-10-04", rows: [] } });
    expect(m.visitsFrom).toBeNull();
    expect(m.platforms.map((p) => p.visits)).toEqual([null, null]);
  });

  it("follows each platform's visits through the store: each counted once, at every step up to the furthest it reached", () => {
    const m = ask({
      visits: {
        from: "2026-09-15",
        rows: [
          { source: "facebook", visits: 30, furthestStep: 0 },
          { source: "facebook", visits: 10, furthestStep: 2 },
          { source: "instagram", visits: 6, furthestStep: 3 },
          { source: "instagram", visits: 4, furthestStep: 4 },
          { source: "google", visits: 7, furthestStep: 1 },
          { source: "direct", visits: 99, furthestStep: 4 },
        ],
      },
    });
    expect(m.platforms[0]!.journey).toEqual({ visits: 50, viewedProduct: 20, addedToCart: 20, startedCheckout: 10, purchased: 4 });
    expect(m.platforms[0]!.visits).toBe(50);
    expect(m.platforms[1]!.journey).toEqual({ visits: 7, viewedProduct: 7, addedToCart: 0, startedCheckout: 0, purchased: 0 });
    // Visits read without their steps count as visits only; none of the dates' days counted: none at all, never 0.
    expect(adJourney([{ visits: 5 }])).toEqual({ visits: 5, viewedProduct: 0, addedToCart: 0, startedCheckout: 0, purchased: 0 });
    expect(ask({ visits: { from: null, rows: [] } }).platforms[0]!.journey).toBeNull();
  });

  it("says nothing of visits without the pixel", () => {
    const m = ask();
    expect(m).not.toHaveProperty("visitsFrom");
    expect(m.platforms[0]).not.toHaveProperty("visits");
    expect(m.platforms[0]).not.toHaveProperty("journey");
  });

  it("goes only to whoever sees the Shopping Funnel's visits as well (View conversion rates)", () => {
    const report = () => ({ modules: { ads_from_shopify: ask({ visits }) as unknown }, capabilities: [] });
    const member = (permissions: string[]): MemberAccess => ({ role: "custom", permissions });
    const without = redactOverview(report(), member(["analytics.traffic"])).modules.ads_from_shopify as ReturnType<typeof ask>;
    expect(without).not.toHaveProperty("visitsFrom");
    expect(without.platforms[0]).not.toHaveProperty("visits");
    expect(without.platforms[0]).not.toHaveProperty("journey");
    expect(without.platforms[0]).toMatchObject({ orders: 4, sales: 200 });
    const seen = redactOverview(report(), member(["analytics.traffic", "analytics.conversion"])).modules.ads_from_shopify as ReturnType<typeof ask>;
    expect(seen.platforms[0]!.visits).toBe(50);
  });
});

describe("where each platform's figures come from", () => {
  const none: AdSourceFacts = { accounts: [], figures: false, hidden: 0, waiting: false };
  const active = { status: "active", errorCode: null, accountStatus: null };
  const expired = { status: "reconnect", errorCode: "auth_expired", accountStatus: null };
  const facts = (over: Partial<Record<"meta" | "google", Partial<AdSourceFacts>>> = {}) => ({ meta: { ...none, ...over.meta }, google: { ...none, ...over.google } });
  const sources = (f: ReturnType<typeof facts>, attribution = true) => Object.fromEntries(adPlatformSources(f, attribution).map((s) => [s.provider, [s.source, s.state]]));

  it("A: Shopify only — both from the store's orders", () => {
    expect(sources(facts())).toEqual({ meta: ["shopify", "not_connected"], google: ["shopify", "not_connected"] });
  });

  it("B and C: one platform connected — its own figures, the other from the orders, with no sign-in asked for", () => {
    expect(sources(facts({ meta: { accounts: [active], figures: true } }))).toEqual({ meta: ["platform", "connected"], google: ["shopify", "not_connected"] });
    expect(sources(facts({ google: { accounts: [active], figures: true } }))).toEqual({ meta: ["shopify", "not_connected"], google: ["platform", "connected"] });
  });

  it("D: both connected — both their own", () => {
    expect(sources(facts({ meta: { accounts: [active], figures: true }, google: { accounts: [active], figures: true } }))).toEqual({
      meta: ["platform", "connected"],
      google: ["platform", "connected"],
    });
  });

  it("E: no traffic sources to read (or not the member's to see) — none, rather than a made-up figure", () => {
    expect(sources(facts(), false)).toEqual({ meta: ["none", "not_connected"], google: ["none", "not_connected"] });
    // A connected platform is still its own.
    expect(sources(facts({ meta: { accounts: [active] } }), false).meta).toEqual(["platform", "connected"]);
  });

  it("keeps a connected platform's own figures while its first days are still being read, or a retry may fix a failure", () => {
    expect(sources(facts({ meta: { accounts: [active], figures: false } })).meta).toEqual(["platform", "connected"]);
    expect(sources(facts({ meta: { accounts: [{ status: "error", errorCode: "rate_limited", accountStatus: null }] } })).meta).toEqual(["platform", "connected"]);
    // One account of two lost: the other still syncs.
    expect(sources(facts({ meta: { accounts: [expired, active] } })).meta).toEqual(["platform", "connected"]);
  });

  it("falls back to the orders when access ended before the dates were read, and keeps what the platform reported for dates it stored", () => {
    expect(sources(facts({ meta: { accounts: [expired], figures: false } })).meta).toEqual(["shopify", "access_lost"]);
    expect(sources(facts({ google: { accounts: [{ status: "permission", errorCode: "no_access", accountStatus: null }] } })).google).toEqual(["shopify", "access_lost"]);
    expect(sources(facts({ meta: { accounts: [expired], figures: true } })).meta).toEqual(["platform", "access_lost"]);
    // Nothing to fall back to: the platform's own view, which says what to reconnect.
    expect(sources(facts({ meta: { accounts: [expired] } }), false).meta).toEqual(["platform", "access_lost"]);
    // Reconnected: its own again.
    expect(sources(facts({ meta: { accounts: [active], figures: true } })).meta).toEqual(["platform", "connected"]);
  });

  it("counts a closed account's spend as the platform's own 0, not lost access", () => {
    expect(sources(facts({ meta: { accounts: [{ status: "unavailable", errorCode: "account_closed", accountStatus: null }] } })).meta).toEqual(["platform", "connected"]);
  });

  it("falls back for a sign-in still waiting for an ad account, and for accounts all hidden from the store", () => {
    expect(sources(facts({ meta: { waiting: true } })).meta).toEqual(["shopify", "waiting"]);
    expect(sources(facts({ google: { hidden: 2 } })).google).toEqual(["shopify", "hidden"]);
  });
});
