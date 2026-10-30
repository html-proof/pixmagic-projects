/**
 * Shopify's own abandoned checkouts for one store-local window: how many, their value, and how many
 * were recovered, read from the Admin GraphQL `abandonedCheckoutsCount` and `abandonedCheckouts`
 * (scope `read_orders`). Kept with Shopify's report answers as the dataset `abandoned_checkouts`
 * (shopifyReports.ts): the worker asks, the Shopping Funnel page reads what is kept
 * (reports/abandonedCheckouts.ts).
 *
 * Shopify's definition: a checkout is abandoned once the shopper has given contact details (an email
 * or a phone number) and hasn't paid; the list keeps the ones that were recovered later (completed),
 * and the ones the merchant archived. Different from the web pixel's "left at checkout" (tracked
 * visits) and from Shopify Analytics' "sessions that reached checkout" (sessions, any checkout).
 *
 * Counts, money and dates only: no customer, address or email field is ever asked for, so only
 * Level 1 protected customer data access is needed, and nothing personal reaches our database.
 * Shopify lists checkouts created in the last 60 days without `read_all_orders` (AbandonedCheckout
 * is under `read_orders`): an older window is never asked for (`checkoutsVisible`).
 */
import type { Store } from "@app/db";
import { addDays, eachDay, expandScopes, localDay, startOfLocalDay } from "@app/shared";
import { zonedTimeToUtc } from "@app/shared/staff";
import { shopifyGraphql, type FetchLike } from "./shopify.js";
import type { ReportWindow } from "./shopifyReports.js";

/** Checkouts read per page: 753 of a query's 1,000 points (packages/core/test/pipeline.test.ts). */
export const CHECKOUTS_PAGE = 250;
/** Pages read at most per window: beyond 2,000 checkouts the value isn't added up (the counts still are). */
export const CHECKOUTS_MAX_PAGES = 8;

/** Why a window's checkouts have no value added up: more than the pages read, more than one currency, or Shopify withholding it. */
export type CheckoutValueGap = "too_many" | "mixed_currency" | "withheld";

/** One store-local day of a window: checkouts abandoned that day (by creation), their value, and how many of them were recovered. */
export interface CheckoutDay {
  day: string;
  abandoned: number;
  recovered: number;
  value: number;
}

/** What is kept for one window (`shopify_reports.values` of the `abandoned_checkouts` dataset). */
export interface CheckoutValues {
  /** Shopify's count of abandoned checkouts created in the window (recovered and archived ones included). */
  abandoned: number;
  /** False when Shopify says the count is a lower bound (`precision: AT_LEAST`). */
  abandonedExact: boolean;
  /** Of them, the ones Shopify marks recovered (`recovery_state:recovered`): completed later. */
  recovered: number;
  recoveredExact: boolean;
  /** Their total price (Shopify's: items, shipping and taxes, after discounts) in the shop's currency; null when `valueGap` says why not. */
  value: number | null;
  /** The total price of the ones completed later; null with `value`. */
  recoveredValue: number | null;
  valueGap: CheckoutValueGap | null;
  /** The shop currency of those prices; null when there were none. */
  currency: string | null;
  /** Day by day, when every checkout was read and added up; null otherwise. */
  days: CheckoutDay[] | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}:\d{2}$/;

/** The UTC instant a store-local wall-clock moment ("HH:MM:SS") happens, as dayTotals' `until` cuts a day. */
function localInstant(day: string, time: string, timeZone: string): Date {
  const [h, m, s] = time.split(":").map(Number) as [number, number, number];
  return new Date(zonedTimeToUtc(day, h, m, timeZone) + s * 1000);
}

/** The window as UTC instants: from the first day's start to the day after the last (or, while it runs, to `until` on the last day). */
export function checkoutWindow(w: ReportWindow, timeZone: string): { start: Date; end: Date } {
  if (!DAY.test(w.from) || !DAY.test(w.to) || (w.until !== undefined && !TIME.test(w.until))) throw new Error(`Bad checkouts window ${w.from}|${w.to}|${w.until ?? ""}`);
  return { start: startOfLocalDay(w.from, timeZone), end: w.until ? localInstant(w.to, w.until, timeZone) : startOfLocalDay(addDays(w.to, 1), timeZone) };
}

/**
 * Shopify's search for the checkouts created in a window, as explicit UTC instants (the shop's own
 * zone never has to be guessed). The dates are checked against their formats first (checkoutWindow):
 * the search is text, so nothing else can get into it.
 */
export function checkoutSearch(w: ReportWindow, timeZone: string): string {
  const { start, end } = checkoutWindow(w, timeZone);
  return `created_at:>='${start.toISOString()}' created_at:<'${end.toISOString()}'`;
}

/** The search for the recovered ones among them. */
export const recoveredSearch = (search: string) => `${search} recovery_state:recovered`;

/** Whether Shopify shares a window's checkouts: without `read_all_orders`, only those created in the last 60 days (as reconcile.ts's checkWindow). */
export function checkoutsVisible(store: Pick<Store, "grantedScopes">, w: Pick<ReportWindow, "from">, today: string): boolean {
  if (expandScopes(store.grantedScopes).has("read_all_orders")) return true;
  return w.from >= firstVisibleDay(today);
}

/** The first store-local day whose checkouts Shopify shares without `read_all_orders`. */
export const firstVisibleDay = (today: string) => addDays(today, -59);

export const ABANDONED_COUNTS_QUERY = /* GraphQL */ `
  query AbandonedCheckoutCounts($q: String!, $rq: String!) {
    all: abandonedCheckoutsCount(query: $q, limit: null) { count precision }
    recovered: abandonedCheckoutsCount(query: $rq, limit: null) { count precision }
  }`;

export const ABANDONED_PAGE_QUERY = /* GraphQL */ `
  query AbandonedCheckoutsPage($q: String!, $first: Int!, $after: String) {
    abandonedCheckouts(first: $first, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes { createdAt completedAt totalPriceSet { shopMoney { amount currencyCode } } }
    }
  }`;

interface ShopifyCount {
  count: number;
  precision: string;
}

interface CountsAnswer {
  all: ShopifyCount | null;
  recovered: ShopifyCount | null;
}

interface PageAnswer {
  abandonedCheckouts: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ createdAt: string; completedAt: string | null; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } | null } | null }>;
  } | null;
}

export interface CheckoutCall {
  shop: string;
  accessToken: string;
  apiVersion: string;
  fetchImpl: FetchLike;
}

/** Money as whole thousandths, so adding up thousands of prices never drifts (no shop currency has more than 3 decimals). */
const mils = (amount: string) => Math.round(Number(amount) * 1000);

/**
 * Ask Shopify for one window's abandoned checkouts. Throws Shopify's errors (the caller,
 * fetchShopifyReport, keeps them as refusals or failures); counts withheld next to otherwise valid
 * data (protected customer data not approved) are `access_denied`, never 0.
 */
export async function readAbandonedCheckouts(call: CheckoutCall, w: ReportWindow, timeZone: string): Promise<{ values: CheckoutValues } | { error: "access_denied" }> {
  const q = checkoutSearch(w, timeZone);
  const counts = await shopifyGraphql<CountsAnswer>({ ...call, query: ABANDONED_COUNTS_QUERY, variables: { q, rq: recoveredSearch(q) } });
  if (!counts?.all || !counts.recovered || typeof counts.all.count !== "number" || typeof counts.recovered.count !== "number") return { error: "access_denied" };

  let after: string | null = null;
  let gap: CheckoutValueGap | null = null;
  let currency: string | null = null;
  let value = 0;
  let recoveredValue = 0;
  const byDay = new Map<string, CheckoutDay>(eachDay(w.from, w.to).map((day) => [day, { day, abandoned: 0, recovered: 0, value: 0 }]));
  // No checkouts: nothing to add up (Shopify's answer is none, worth 0). Otherwise every one, page by
  // page, paced by Shopify's cost budget, up to CHECKOUTS_MAX_PAGES.
  for (let page = 0; counts.all.count > 0 && !gap; page++) {
    if (page === CHECKOUTS_MAX_PAGES) {
      gap = "too_many";
      break;
    }
    const answer: PageAnswer = await shopifyGraphql<PageAnswer>({ ...call, query: ABANDONED_PAGE_QUERY, variables: { q, first: CHECKOUTS_PAGE, after } });
    const list = answer?.abandonedCheckouts;
    if (!list) {
      gap = "withheld";
      break;
    }
    for (const n of list.nodes) {
      const money = n.totalPriceSet?.shopMoney;
      if (!money || !Number.isFinite(Number(money.amount))) gap = "withheld";
      else if (currency && money.currencyCode !== currency) gap = "mixed_currency";
      if (gap || !money) break;
      currency = money.currencyCode;
      const amount = mils(money.amount);
      value += amount;
      if (n.completedAt) recoveredValue += amount;
      const d = byDay.get(localDay(new Date(n.createdAt), timeZone));
      if (d) {
        d.abandoned++;
        d.value += amount;
        if (n.completedAt) d.recovered++;
      }
    }
    if (!list.pageInfo.hasNextPage || !list.pageInfo.endCursor) break;
    after = list.pageInfo.endCursor;
  }

  const days = gap ? null : [...byDay.values()].map((d) => ({ ...d, value: d.value / 1000 }));
  return {
    values: {
      abandoned: counts.all.count,
      abandonedExact: counts.all.precision === "EXACT",
      recovered: counts.recovered.count,
      recoveredExact: counts.recovered.precision === "EXACT",
      value: gap ? null : value / 1000,
      recoveredValue: gap ? null : recoveredValue / 1000,
      valueGap: gap,
      currency: gap ? null : currency,
      days,
    },
  };
}

/** A kept answer read back (JSON from the database): the values when they are this shape, else null (asked for again). */
export function checkoutValuesOf(v: unknown): CheckoutValues | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const num = (k: string) => typeof x[k] === "number";
  const numOrNull = (k: string) => x[k] === null || typeof x[k] === "number";
  if (!num("abandoned") || !num("recovered") || typeof x.abandonedExact !== "boolean" || typeof x.recoveredExact !== "boolean") return null;
  if (!numOrNull("value") || !numOrNull("recoveredValue") || !(x.days === null || Array.isArray(x.days))) return null;
  return x as unknown as CheckoutValues;
}
