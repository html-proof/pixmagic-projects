import { describe, expect, it } from "vitest";
import type { Tx } from "@app/db";
import {
  ABANDONED_COUNTS_QUERY,
  ABANDONED_PAGE_QUERY,
  CHECKOUTS_MAX_PAGES,
  CHECKOUTS_PAGE,
  checkoutSearch,
  checkoutsVisible,
  checkoutValuesOf,
  readAbandonedCheckouts,
  type CheckoutValues,
} from "../src/shopifyCheckouts.js";
import { REPORT_DATASETS, REPORT_SCOPE } from "../src/shopifyReports.js";
import { abandonedCheckoutsModule } from "../src/reports/abandonedCheckouts.js";
import type { FetchLike } from "../src/shopify.js";

/** Shopify's own abandoned checkouts: the search, the reads (against a fake Admin API) and the module the funnel page shows. */

const MELBOURNE = "Australia/Melbourne";

describe("the search for a window's checkouts", () => {
  it("asks for the store's days as UTC instants, across a daylight-saving change, or up to a time of day", () => {
    // Melbourne moves from UTC+10 to UTC+11 on 4 October 2026.
    expect(checkoutSearch({ from: "2026-10-01", to: "2026-10-16" }, MELBOURNE)).toBe("created_at:>='2026-09-30T14:00:00.000Z' created_at:<'2026-10-16T13:00:00.000Z'");
    expect(checkoutSearch({ from: "2026-10-17", to: "2026-10-17", until: "16:40:00" }, MELBOURNE)).toBe("created_at:>='2026-10-16T13:00:00.000Z' created_at:<'2026-10-17T05:40:00.000Z'");
    expect(checkoutSearch({ from: "2026-10-17", to: "2026-10-17" }, "UTC")).toBe("created_at:>='2026-10-17T00:00:00.000Z' created_at:<'2026-10-18T00:00:00.000Z'");
  });

  it("refuses a window that isn't dates and a time (the search is text)", () => {
    expect(() => checkoutSearch({ from: "2026-10-01' OR status:open", to: "2026-10-02" }, "UTC")).toThrow();
    expect(() => checkoutSearch({ from: "2026-10-01", to: "2026-10-02", until: "16:40" }, "UTC")).toThrow();
  });

  it("is only asked for within the 60 days Shopify shares, unless the store granted older orders", () => {
    const today = "2026-10-30";
    expect(checkoutsVisible({ grantedScopes: ["read_orders"] }, { from: "2026-09-01" }, today)).toBe(true);
    expect(checkoutsVisible({ grantedScopes: ["read_orders"] }, { from: "2026-08-31" }, today)).toBe(false);
    expect(checkoutsVisible({ grantedScopes: ["read_orders", "read_all_orders"] }, { from: "2025-01-01" }, today)).toBe(true);
  });

  it("asks for no customer, address or contact field, and needs only the orders scope", () => {
    for (const q of [ABANDONED_COUNTS_QUERY, ABANDONED_PAGE_QUERY]) expect(q).not.toMatch(/customer|email|phone|address|firstName|lastName|abandonedCheckoutUrl/i);
    expect(REPORT_DATASETS).toContain("abandoned_checkouts");
    expect(REPORT_SCOPE.abandoned_checkouts).toBe("read_orders");
    expect(REPORT_SCOPE.sessions).toBe("read_reports");
  });
});

type Node = { createdAt: string; completedAt: string | null; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } | null } | null };
const node = (createdAt: string, amount: string, completedAt: string | null = null, currencyCode = "AUD"): Node => ({ createdAt, completedAt, totalPriceSet: { shopMoney: { amount, currencyCode } } });

/** A fake Admin API: the counts, then the list in pages. */
function shopify(opts: { all: number; recovered: number; precision?: string; pages?: Node[][]; endless?: boolean; counts?: unknown }) {
  const asked: Array<{ q: string; after: string | null }> = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: { q: string; rq?: string; after?: string | null } };
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    if (body.query.includes("abandonedCheckoutsCount")) {
      expect(body.variables.rq).toBe(`${body.variables.q} recovery_state:recovered`);
      return json(opts.counts ?? { data: { all: { count: opts.all, precision: opts.precision ?? "EXACT" }, recovered: { count: opts.recovered, precision: "EXACT" } } });
    }
    asked.push({ q: body.variables.q, after: body.variables.after ?? null });
    const i = asked.length - 1;
    const nodes = opts.endless ? Array.from({ length: 250 }, () => node("2026-10-02T01:00:00Z", "1.00")) : (opts.pages?.[i] ?? []);
    const more = opts.endless || i + 1 < (opts.pages?.length ?? 0);
    return json({ data: { abandonedCheckouts: { pageInfo: { hasNextPage: more, endCursor: more ? `c${i + 1}` : null }, nodes } } });
  };
  return { asked, call: { shop: "s.myshopify.com", accessToken: "shpat_x", apiVersion: "2026-10", fetchImpl } };
}

describe("reading a window's abandoned checkouts", () => {
  const window = { from: "2026-10-01", to: "2026-10-03" };

  it("takes Shopify's counts and adds up every page's prices, day by day in the store's zone", async () => {
    const s = shopify({
      all: 3,
      recovered: 1,
      pages: [
        // 11:00 on 1 October in Melbourne; 23:30 UTC on 1 October is already 2 October there.
        [node("2026-10-01T01:00:00Z", "10.10"), node("2026-10-01T23:30:00Z", "20.20", "2026-10-03T02:00:00Z")],
        [node("2026-10-02T03:00:00Z", "5.05")],
      ],
    });
    const answer = await readAbandonedCheckouts(s.call, window, MELBOURNE);
    expect(s.asked.map((a) => a.after)).toEqual([null, "c1"]);
    expect(answer).toEqual({
      values: {
        abandoned: 3,
        abandonedExact: true,
        recovered: 1,
        recoveredExact: true,
        value: 35.35,
        recoveredValue: 20.2,
        valueGap: null,
        currency: "AUD",
        days: [
          { day: "2026-10-01", abandoned: 1, recovered: 0, value: 10.1 },
          { day: "2026-10-02", abandoned: 2, recovered: 1, value: 25.25 },
          // A day with none is Shopify's answer (none), not a gap.
          { day: "2026-10-03", abandoned: 0, recovered: 0, value: 0 },
        ],
      },
    });
  });

  it("asks for no list when there are none", async () => {
    const s = shopify({ all: 0, recovered: 0 });
    const answer = await readAbandonedCheckouts(s.call, window, MELBOURNE);
    expect(s.asked).toEqual([]);
    expect(answer).toMatchObject({ values: { abandoned: 0, recovered: 0, value: 0, recoveredValue: 0, valueGap: null, currency: null } });
  });

  it("reads no page when the count is more than the pages hold: the counts stay Shopify's, the value isn't added up", async () => {
    const s = shopify({ all: CHECKOUTS_PAGE * CHECKOUTS_MAX_PAGES + 1, recovered: 400, endless: true });
    const answer = await readAbandonedCheckouts(s.call, window, MELBOURNE);
    expect(s.asked).toEqual([]);
    expect(answer).toMatchObject({ values: { abandoned: CHECKOUTS_PAGE * CHECKOUTS_MAX_PAGES + 1, recovered: 400, value: null, recoveredValue: null, valueGap: "too_many", days: null } });
  });

  it("stops after the page limit when the list outgrows the count while it is read", async () => {
    const s = shopify({ all: CHECKOUTS_PAGE * CHECKOUTS_MAX_PAGES, recovered: 400, endless: true });
    const answer = await readAbandonedCheckouts(s.call, window, MELBOURNE);
    expect(s.asked).toHaveLength(CHECKOUTS_MAX_PAGES);
    expect(answer).toMatchObject({ values: { value: null, recoveredValue: null, valueGap: "too_many", days: null } });
  });

  it("never adds up prices in different currencies, or ones Shopify withheld", async () => {
    const mixed = shopify({ all: 2, recovered: 0, pages: [[node("2026-10-01T01:00:00Z", "10.00"), node("2026-10-01T02:00:00Z", "10.00", null, "USD")]] });
    expect(await readAbandonedCheckouts(mixed.call, window, MELBOURNE)).toMatchObject({ values: { abandoned: 2, value: null, valueGap: "mixed_currency", days: null } });
    const withheld = shopify({ all: 1, recovered: 0, pages: [[{ createdAt: "2026-10-01T01:00:00Z", completedAt: null, totalPriceSet: null }]] });
    expect(await readAbandonedCheckouts(withheld.call, window, MELBOURNE)).toMatchObject({ values: { abandoned: 1, value: null, valueGap: "withheld" } });
  });

  it("says when a count is only a lower bound", async () => {
    const s = shopify({ all: 10_000, recovered: 50, precision: "AT_LEAST", endless: true });
    expect(await readAbandonedCheckouts(s.call, window, MELBOURNE)).toMatchObject({ values: { abandoned: 10_000, abandonedExact: false, valueGap: "too_many" } });
    expect(s.asked).toEqual([]);
  });

  it("is access_denied, never 0, when Shopify withholds the counts (protected customer data not approved)", async () => {
    const s = shopify({
      all: 0,
      recovered: 0,
      counts: { data: { all: null, recovered: null }, errors: [{ message: "Access denied for abandonedCheckoutsCount field.", extensions: { code: "ACCESS_DENIED" } }] },
    });
    expect(await readAbandonedCheckouts(s.call, window, MELBOURNE)).toEqual({ error: "access_denied" });
    expect(s.asked).toEqual([]);
  });

  it("reads back only what has this dataset's shape", () => {
    const v: CheckoutValues = { abandoned: 1, abandonedExact: true, recovered: 0, recoveredExact: true, value: 9, recoveredValue: 0, valueGap: null, currency: "AUD", days: null };
    expect(checkoutValuesOf(v)).toEqual(v);
    expect(checkoutValuesOf({ sessions: 4 })).toBeNull();
    expect(checkoutValuesOf(null)).toBeNull();
  });
});

describe("the funnel page's abandoned checkouts module", () => {
  const now = new Date("2026-10-30T02:00:00Z");
  const today = "2026-10-30";
  const store = { id: "s1", workspaceId: "w1", grantedScopes: ["read_orders", "read_products"] };
  const values = (abandoned: number, recovered: number, value: number | null, exact = true): CheckoutValues => ({
    abandoned,
    abandonedExact: exact,
    recovered,
    recoveredExact: true,
    value,
    recoveredValue: value === null ? null : value / 4,
    valueGap: value === null ? "too_many" : null,
    currency: "AUD",
    days: null,
  });
  type Row = { dataset: string; window: string; values: unknown; error: string | null; fetchedAt: Date };
  const kept = (window: string, v: unknown, error: string | null = null, fetchedAt = now): Row => ({ dataset: "abandoned_checkouts", window, values: v, error, fetchedAt });
  /** A transaction holding these kept answers (keptReports' query is the one thing it is asked). */
  const tx = (rows: Row[]) => ({ shopifyReport: { findMany: async () => rows } }) as unknown as Tx;
  const october = { range: { from: "2026-10-01", to: "2026-10-28" }, previous: { from: "2026-09-03", to: "2026-09-30" } };

  it("says it is asking Shopify, and asks for both windows, when nothing is kept", async () => {
    const { module, refresh } = await abandonedCheckoutsModule(tx([]), store, october, { today, now });
    expect(module).toMatchObject({ status: "loading", previousStatus: "loading", current: null, previous: null, visibleFrom: "2026-09-01" });
    expect(refresh).toEqual([
      { dataset: "abandoned_checkouts", window: { from: "2026-10-01", to: "2026-10-28" } },
      { dataset: "abandoned_checkouts", window: { from: "2026-09-03", to: "2026-09-30" } },
    ]);
  });

  it("shows the kept figures with the recovered rate and the changes, asking nothing again while they're fresh", async () => {
    const rows = [kept("2026-10-01|2026-10-28|", values(200, 30, 8000)), kept("2026-09-03|2026-09-30|", values(100, 10, 4000))];
    const { module, refresh } = await abandonedCheckoutsModule(tx(rows), store, october, { today, now });
    expect(refresh).toEqual([]);
    expect(module).toMatchObject({ status: "ready", previousStatus: "ready", until: null, asOf: now.toISOString(), current: { abandoned: 200, recovered: 30, recoveredRate: 0.15, value: 8000 }, previous: { abandoned: 100, recoveredRate: 0.1 } });
    expect(module.deltas.abandoned).toBe(1);
    expect(module.deltas.value).toBe(1);
    expect(module.deltas.recoveredRate).toBeCloseTo(0.5, 9);
    expect(module.previous).not.toHaveProperty("days");
  });

  it("has no exact change or rate for a count Shopify gives as a lower bound, and no value change without a value", async () => {
    const rows = [kept("2026-10-01|2026-10-28|", values(10_000, 30, null, false)), kept("2026-09-03|2026-09-30|", values(100, 10, 4000))];
    const { module } = await abandonedCheckoutsModule(tx(rows), store, october, { today, now });
    expect(module.current).toMatchObject({ abandonedExact: false, recoveredRate: null, value: null, valueGap: "too_many" });
    expect(module.deltas).toEqual({ abandoned: null, value: null, recoveredRate: null });
  });

  it("never asks for a comparison older than Shopify shares, and says so", async () => {
    const lastYear = { range: october.range, previous: { from: "2025-10-01", to: "2025-10-28" } };
    const { module, refresh } = await abandonedCheckoutsModule(tx([kept("2026-10-01|2026-10-28|", values(200, 30, 8000))]), store, lastYear, { today, now });
    expect(refresh).toEqual([]);
    expect(module).toMatchObject({ status: "ready", previousStatus: "beyond_history", previous: null, deltas: { abandoned: null, value: null, recoveredRate: null } });
  });

  it("is beyond_history for dates older than Shopify shares, asking nothing", async () => {
    const summer = { range: { from: "2026-07-01", to: "2026-07-31" }, previous: { from: "2026-06-01", to: "2026-06-30" } };
    const { module, refresh } = await abandonedCheckoutsModule(tx([]), store, summer, { today, now });
    expect(refresh).toEqual([]);
    expect(module).toMatchObject({ status: "beyond_history", previousStatus: "beyond_history", current: null });
    // With older orders granted, Shopify is asked.
    const all = await abandonedCheckoutsModule(tx([]), { ...store, grantedScopes: ["read_orders", "read_all_orders"] }, summer, { today, now });
    expect(all.refresh).toHaveLength(2);
    expect(all.module).toMatchObject({ status: "loading", visibleFrom: null });
  });

  it("shows Shopify's refusal as such, and asks again for an answer kept in another shape", async () => {
    const denied = await abandonedCheckoutsModule(tx([kept("2026-10-01|2026-10-28|", null, "access_denied"), kept("2026-09-03|2026-09-30|", null, "access_denied")]), store, october, { today, now });
    expect(denied.module).toMatchObject({ status: "access_denied", current: null });
    expect(denied.refresh).toEqual([]);
    const odd = await abandonedCheckoutsModule(tx([kept("2026-10-01|2026-10-28|", { abandoned: "lots" }), kept("2026-09-03|2026-09-30|", values(100, 10, 4000))]), store, october, { today, now });
    expect(odd.module).toMatchObject({ status: "loading", current: null });
    expect(odd.refresh.map((r) => r.window.from)).toEqual(["2026-10-01"]);
  });

  it("keeps a running range like for like: both windows at the same mark", async () => {
    const running = { range: { from: "2026-10-30", to: "2026-10-30" }, previous: { from: "2026-10-29", to: "2026-10-29", until: "13:07:42" } };
    const rows = [kept("2026-10-30|2026-10-30|13:00:00", values(5, 1, 100), null, new Date(now.getTime() - 60_000)), kept("2026-10-29|2026-10-29|13:00:00", values(4, 1, 80))];
    // 13:05 isn't kept yet: both are shown at 13:00 meanwhile, and 13:05 is asked for.
    const { module, refresh } = await abandonedCheckoutsModule(tx(rows), store, running, { today, now });
    expect(module).toMatchObject({ status: "ready", until: "13:00:00", current: { abandoned: 5 }, previous: { abandoned: 4 } });
    expect(refresh.map((r) => r.window.until)).toEqual(["13:05:00", "13:05:00"]);
    // The range's 13:05 alone isn't shown against yesterday's 13:00.
    const one = await abandonedCheckoutsModule(tx([...rows, kept("2026-10-30|2026-10-30|13:05:00", values(6, 1, 120))]), store, running, { today, now });
    expect(one.module).toMatchObject({ until: "13:00:00", current: { abandoned: 5 } });
    const both = await abandonedCheckoutsModule(tx([...rows, kept("2026-10-30|2026-10-30|13:05:00", values(6, 1, 120)), kept("2026-10-29|2026-10-29|13:05:00", values(4, 2, 80))]), store, running, { today, now });
    expect(both.module).toMatchObject({ until: "13:05:00", current: { abandoned: 6 }, previous: { recovered: 2 } });
  });
});
