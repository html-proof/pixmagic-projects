import { describe, expect, it } from "vitest";
import { summarize } from "@app/shared";
import { parseReport, reportQuery, windowKey } from "../src/shopifyReports.js";
import { pickAnswers, quantizeUntil, reconcileSales, reportStale, reportWindows } from "../src/reports/shopify.js";

describe("ShopifyQL for Shopify's own report figures", () => {
  it("asks for whole days, or up to a time of day while the window runs", () => {
    expect(reportQuery("sales", { from: "2026-10-01", to: "2026-10-16" })).toBe(
      "FROM sales SHOW gross_sales, discounts, sales_reversals, net_sales, shipping_charges, duties, additional_fees, taxes, total_sales, orders SINCE 2026-10-01 UNTIL 2026-10-16",
    );
    expect(reportQuery("sessions", { from: "2026-10-17", to: "2026-10-17", until: "16:40:00" })).toBe(
      "FROM sessions SHOW sessions, online_store_visitors, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout, pageviews WHERE human_or_bot_session = 'human' SINCE 2026-10-17 UNTIL 2026-10-17T16:39:59",
    );
    expect(reportQuery("profit", { from: "2026-09-01", to: "2026-09-30" })).toContain("SHOW gross_profit, cost_of_goods_sold, net_sales_with_cost_recorded, net_sales_without_cost_recorded");
  });

  it("refuses a window that isn't dates and a time (ShopifyQL takes no variables)", () => {
    expect(() => reportQuery("sales", { from: "2026-10-01 UNTIL now; FROM x", to: "2026-10-02" })).toThrow();
    expect(() => reportQuery("sales", { from: "2026-10-01", to: "2026-10-02", until: "16:40" })).toThrow();
    expect(windowKey({ from: "2026-10-01", to: "2026-10-02" })).toBe("2026-10-01|2026-10-02|");
  });

  it("reads a row of totals, keyed by column or in column order", () => {
    const columns = [{ name: "sessions" }, { name: "online_store_visitors" }, { name: "pageviews" }];
    expect(parseReport("sessions", { tableData: { columns, rows: [{ sessions: "120", online_store_visitors: 95, pageviews: "301" }] }, parseErrors: [] })).toMatchObject({ sessions: 120, visitors: 95, pageviews: 301 });
    expect(parseReport("sessions", { tableData: { columns, rows: [[120, "95", null]] }, parseErrors: [] })).toMatchObject({ sessions: 120, visitors: 95, pageviews: null });
    // Nothing happened in the window: Shopify's answer is zero, not a gap.
    expect(parseReport("sales", { tableData: { columns: [], rows: [] }, parseErrors: [] })).toMatchObject({ netSales: 0, orders: 0 });
  });
});

describe("windows and staleness", () => {
  it("stops a running range and its comparison at the same 5-minute mark", () => {
    expect(quantizeUntil("16:44:12")).toBe("16:40:00");
    expect(quantizeUntil("00:04:59")).toBe("00:00:00");
    expect(reportWindows({ from: "2026-10-17", to: "2026-10-17" }, { from: "2026-10-16", to: "2026-10-16", until: "09:07:30" })).toEqual({
      current: { from: "2026-10-17", to: "2026-10-17", until: "09:05:00" },
      previous: { from: "2026-10-16", to: "2026-10-16", until: "09:05:00" },
    });
    expect(reportWindows({ from: "2026-09-01", to: "2026-09-30" }, { from: "2026-08-01", to: "2026-08-31" }).current).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("asks again sooner for recent days and failed calls than for old days or refusals", () => {
    const now = new Date("2026-10-17T06:00:00Z");
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    const kept = (min: number, error: "failed" | "access_denied" | null = null) => ({ dataset: "sessions" as const, window: "", values: error ? null : {}, error, fetchedAt: ago(min) });
    const today = "2026-10-17";
    expect(reportStale(undefined, { from: today, to: today }, today, now)).toBe(true);
    expect(reportStale(kept(5), { from: today, to: today }, today, now)).toBe(false);
    expect(reportStale(kept(11), { from: today, to: today }, today, now)).toBe(true);
    expect(reportStale(kept(40), { from: "2026-10-15", to: "2026-10-16" }, today, now)).toBe(true);
    expect(reportStale(kept(120), { from: "2026-09-01", to: "2026-09-30" }, today, now)).toBe(false);
    expect(reportStale(kept(11, "failed"), { from: "2026-09-01", to: "2026-09-30" }, today, now)).toBe(true);
    expect(reportStale(kept(120, "access_denied"), { from: today, to: today }, today, now)).toBe(false);
  });

  it("asks again at once for a sales answer kept before duties and additional fees were asked for", () => {
    const now = new Date("2026-10-19T06:00:00Z");
    const today = "2026-10-19";
    const sales = (values: Record<string, number>) => ({ dataset: "sales" as const, window: "2026-09-01|2026-09-30|", values, error: null, fetchedAt: new Date(now.getTime() - 60_000) });
    const all = { grossSales: 1, discounts: 0, salesReversals: 0, netSales: 1, shipping: 0, duties: 0, additionalFees: 0, taxes: 0, totalSales: 1, orders: 1 };
    const { duties: _d, additionalFees: _f, ...older } = all;
    expect(reportStale(sales(all), { from: "2026-09-01", to: "2026-09-30" }, today, now)).toBe(false);
    expect(reportStale(sales(older), { from: "2026-09-01", to: "2026-09-30" }, today, now)).toBe(true);
  });
});

describe("our sales figures against Shopify's sales report", () => {
  const ours = summarize([
    { day: "2026-09-21", grossSales: 1699.08, discounts: 54.53, refunds: 45.5, shipping: 34.54, taxes: 167.91, duties: 0, additionalFees: 0, totalSales: 1801.5, orders: 5, orderValue: 1644.55, units: 6, ordersWithCustomer: 5, returningCustomerOrders: 0, refundedOrders: 1 },
  ]);

  it("matches to the cent whichever sign Shopify reports discounts and reversals with", () => {
    const negative = { grossSales: 1699.08, discounts: -54.53, salesReversals: -45.5, netSales: 1599.05, shipping: 34.54, duties: 0, additionalFees: 0, taxes: 167.91, totalSales: 1801.5, orders: 5 };
    const positive = { ...negative, discounts: 54.53, salesReversals: 45.5 };
    for (const shopify of [negative, positive]) {
      const rows = reconcileSales(ours, shopify, { behind: false });
      expect(rows.every((r) => r.state === "match"), JSON.stringify(rows)).toBe(true);
      expect(rows.find((r) => r.metric === "discounts")).toMatchObject({ shopify: 54.53, ours: 54.53, difference: 0 });
    }
  });

  it("flags a difference, or a delay while changes are still being counted, and a figure Shopify left out", () => {
    // The returns bug fixed on 2026-10-17 would have shown as this: 136.50 counted, 45.50 in Shopify.
    const before = summarize([{ ...{ day: "2026-09-21", grossSales: 1699.08, discounts: 54.53, refunds: 136.5, shipping: 34.54, taxes: 167.91, duties: 0, additionalFees: 0, totalSales: 1710.5, orders: 5, orderValue: 1644.55, units: 6, ordersWithCustomer: 5, returningCustomerOrders: 0, refundedOrders: 1 } }]);
    const shopify = { grossSales: 1699.08, discounts: -54.53, salesReversals: -45.5, netSales: 1599.05, shipping: 34.54, taxes: 167.91, totalSales: 1801.5, orders: null };
    const rows = reconcileSales(before, shopify, { behind: false });
    expect(rows.find((r) => r.metric === "returns")).toMatchObject({ shopify: 45.5, ours: 136.5, difference: 91, state: "differs" });
    expect(rows.find((r) => r.metric === "totalSales")).toMatchObject({ difference: -91, state: "differs" });
    expect(rows.find((r) => r.metric === "orders")).toMatchObject({ shopify: null, state: "unknown" });
    expect(reconcileSales(before, shopify, { behind: true }).find((r) => r.metric === "returns")!.state).toBe("delay");
  });
});

describe("duties and additional fees against Shopify's sales report", () => {
  // An international order: A$40 of duties and a A$2.50 retail delivery fee, each with its own line
  // in Shopify's total sales breakdown (ShopifyQL `duties`, `additional_fees`).
  const day = { day: "2026-10-18", grossSales: 500, discounts: 0, refunds: 0, shipping: 20, taxes: 56.25, duties: 40, additionalFees: 2.5, totalSales: 618.75, orders: 1, orderValue: 500, units: 2, ordersWithCustomer: 1, returningCustomerOrders: 0, refundedOrders: 0 };
  const shopify = { grossSales: 500, discounts: 0, salesReversals: 0, netSales: 500, shipping: 20, duties: 40, additionalFees: 2.5, taxes: 56.25, totalSales: 618.75, orders: 1 };

  it("compares each line, and they add up to Shopify's total sales", () => {
    const rows = reconcileSales(summarize([day]), shopify, { behind: false });
    expect(rows.map((r) => r.metric)).toEqual(["grossSales", "discounts", "returns", "netSales", "shipping", "duties", "additionalFees", "taxes", "totalSales", "orders"]);
    expect(rows.every((r) => r.state === "match"), JSON.stringify(rows)).toBe(true);
    expect(shopify.netSales + shopify.additionalFees + shopify.duties + shopify.shipping + shopify.taxes).toBe(shopify.totalSales);
  });

  it("shows a fee booked on the wrong line as two differences, while total sales still matches", () => {
    const rows = reconcileSales(summarize([{ ...day, duties: 42.5, additionalFees: 0 }]), shopify, { behind: false });
    expect(rows.find((r) => r.metric === "duties")).toMatchObject({ difference: 2.5, state: "differs" });
    expect(rows.find((r) => r.metric === "additionalFees")).toMatchObject({ difference: -2.5, state: "differs" });
    expect(rows.find((r) => r.metric === "totalSales")!.state).toBe("match");
  });

  it("says not reported for a kept answer from before the lines were asked for", () => {
    const { duties: _d, additionalFees: _f, ...older } = shopify;
    const rows = reconcileSales(summarize([day]), older, { behind: false });
    expect(rows.find((r) => r.metric === "duties")!.state).toBe("unknown");
    expect(rows.find((r) => r.metric === "totalSales")!.state).toBe("match");
  });
});

describe("answers while the next mark is fetched", () => {
  const kept = (window: string, sessions: number) => ({ dataset: "sessions" as const, window, values: { sessions }, error: null, fetchedAt: new Date() });
  const today = { from: "2026-10-17", to: "2026-10-17", until: "16:40:00" };
  const yesterday = { from: "2026-10-16", to: "2026-10-16", until: "16:40:00" };

  it("keeps the latest earlier mark both windows have, so the comparison stays like for like", () => {
    const rows = [
      kept("2026-10-17|2026-10-17|16:30:00", 1),
      kept("2026-10-16|2026-10-16|16:30:00", 2),
      kept("2026-10-17|2026-10-17|16:35:00", 3),
      // Yesterday's 16:35 answer isn't in yet: 16:35 can't be shown for today alone.
      kept("2026-10-16|2026-10-16|16:25:00", 4),
    ];
    const picked = pickAnswers(rows, "sessions", [today, yesterday]);
    expect(picked.until).toBe("16:30:00");
    expect(picked.reports.map((r) => r?.values)).toEqual([{ sessions: 1 }, { sessions: 2 }]);
    // Once both 16:40 answers are kept, they are the ones shown.
    const now = pickAnswers([...rows, kept("2026-10-17|2026-10-17|16:40:00", 5), kept("2026-10-16|2026-10-16|16:40:00", 6)], "sessions", [today, yesterday]);
    expect(now).toMatchObject({ until: "16:40:00", reports: [{ values: { sessions: 5 } }, { values: { sessions: 6 } }] });
    // Nothing earlier either: still asking Shopify.
    expect(pickAnswers([], "sessions", [today, yesterday]).reports).toEqual([undefined, undefined]);
  });
});
