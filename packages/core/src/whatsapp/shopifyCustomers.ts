/**
 * The store's customers for WhatsApp Automation's Customers tab (docs/whatsapp.md, "The page"): one
 * page at a time, read live from Shopify's Admin GraphQL API with each customer's number as complete
 * as Shopify has it (customerPhones.ts), and what WhatsApp already knows of that number next to it.
 *
 * Nothing here is written to our database: the list passes through to the merchant's browser, the
 * way the dashboard's Customers to follow up does (apps/api/src/routes/contacts.ts). WhatsApp's own
 * records (consent, the do-not-message list) are found by the number's keyed hash, so nothing is
 * decrypted to join them. Who may see what (numbers, names, order figures) is the caller's to check.
 */
import { systemDb, type Store } from "@app/db";
import { normalizePhone, type WaMarketingState, type WaSuppressionScope } from "@app/shared";
import { CUSTOMER_PHONE_FIELDS, customerPhone, SHOP_COUNTRY_FIELD, storeCountryOf, type ContactPhone, type GqlCustomerPhones, type GqlShopCountry } from "../customerPhones.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { ShopifyGraphqlError, ShopifyHttpError, shopifyGraphql } from "../shopify.js";
import { getAccessToken, StoreDisconnectedError } from "../tokens.js";
import { waPhoneHash, WhatsappError, type WaDeps } from "./common.js";

/** Customers per page: one Admin GraphQL call (about 45 of Shopify's cost points). */
export const WA_CUSTOMER_PAGE = 50;

// Both validated against Shopify's 2026-10 schema (docs/shopify-app-store-compliance.md, "Shopify API version").
const CUSTOMERS_QUERY = `#graphql
  query WaCustomers($first: Int!, $after: String, $query: String, $sortKey: CustomerSortKeys!, $reverse: Boolean!) {
    ${SHOP_COUNTRY_FIELD}
    customers(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        displayName
        numberOfOrders
        amountSpent { amount currencyCode }
        ${CUSTOMER_PHONE_FIELDS}
      }
    }
  }`;

/** Only the store's own country, to read a local number the merchant searched for. */
const SHOP_COUNTRY_QUERY = `#graphql
  query WaShopCountry { ${SHOP_COUNTRY_FIELD} }`;

interface GqlCustomer extends GqlCustomerPhones {
  id: string;
  displayName: string | null;
  numberOfOrders: string | number | null;
  amountSpent: { amount: string; currencyCode: string } | null;
}

interface GqlCustomers extends GqlShopCountry {
  customers?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<GqlCustomer | null> } | null;
}

/** What WhatsApp knows of a customer's number at this store. */
export interface WaCustomerWhatsapp {
  /** The WhatsApp contact (null: only on the do-not-message list). */
  contactId: string | null;
  optedOut: boolean;
  optedIn: boolean;
  marketing: WaMarketingState;
  /** On the do-not-message list: for every message, or for marketing. */
  suppressed: WaSuppressionScope | null;
  /** WhatsApp said in the last 30 days that the number has no account (sends to it are skipped). */
  notOnWhatsapp: boolean;
  lastOutboundAt: Date | null;
}

export interface WaShopifyCustomer extends ContactPhone {
  customerId: string;
  name: string | null;
  adminUrl: string | null;
  orders: number | null;
  spent: number | null;
  currency: string | null;
  /** Null: WhatsApp has never messaged, heard from or recorded anything about this number. */
  whatsapp: WaCustomerWhatsapp | null;
}

export interface WaShopifyCustomers {
  fetchedAt: string;
  /** Shopify withheld customers' details: the store hasn't approved bizinsights for them yet. */
  restricted: boolean;
  customers: WaShopifyCustomer[];
  /** Shopify's cursor for the next page, or null on the last one. */
  nextCursor: string | null;
  /** About the rows on this page only (Shopify gives no total). */
  page: { count: number; withNumber: number; withoutCountryCode: number };
  /** The store's Shopify admin ("https://<shop>/admin"): its customers, and where checkout asks for a phone number (/settings/checkout). */
  shopAdminUrl: string;
}

/** A WhatsApp contact counts as "not on WhatsApp" this long after WhatsApp said so (messages.ts skips sends to it as long). */
const NOT_ON_WHATSAPP_MS = 30 * 86_400_000;

/** "gid://shopify/Customer/123" → "123". */
const numericId = (gid: string) => gid.split("/").pop() ?? gid;

/** A number as people type one: digits, spaces, "+", brackets, dots and dashes, with at least 6 digits. */
const looksLikePhone = (s: string) => /^[+\d\s().-]+$/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 6;

/**
 * The merchant's search as Shopify's customer search syntax, or null for none. Quotes, colons,
 * brackets and backslashes are dropped (they would be Shopify's own syntax: a field filter, a
 * phrase), as is a leading "-" (Shopify's NOT). A number is searched as one, in its international
 * form (`country` reads a local number); Shopify matches it against the customer's own number.
 */
export function waCustomerSearch(text: string | null | undefined, country: string | null): { query: string; byPhone: boolean } | null {
  const raw = (text ?? "").trim().slice(0, 80);
  if (!raw) return null;
  if (looksLikePhone(raw)) {
    const n = normalizePhone(raw, country);
    if (n) return { query: `phone:${n.e164}`, byPhone: true };
    return { query: raw.replace(/\D/g, ""), byPhone: false };
  }
  const words = raw
    .replace(/["'`:()\\]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+/, ""))
    .filter(Boolean);
  return words.length ? { query: words.join(" "), byPhone: false } : null;
}

/**
 * One page of the store's customers, newest first (or best match first when searching), each with
 * their best phone number and WhatsApp's state for it. `after` is the cursor from the previous page.
 */
export async function waShopifyCustomers(
  deps: Pick<WaDeps, "coord" | "fetchImpl">,
  store: Pick<Store, "id" | "workspaceId" | "shopDomain" | "status" | "currency">,
  opts: { after?: string | null; search?: string | null; first?: number } = {},
): Promise<WaShopifyCustomers> {
  const first = Math.max(1, Math.min(WA_CUSTOMER_PAGE, Math.trunc(opts.first ?? WA_CUSTOMER_PAGE)));
  const shopAdminUrl = `https://${store.shopDomain}/admin`;
  const empty = (restricted: boolean): WaShopifyCustomers => ({
    fetchedAt: new Date().toISOString(),
    restricted,
    customers: [],
    nextCursor: null,
    page: { count: 0, withNumber: 0, withoutCountryCode: 0 },
    shopAdminUrl,
  });

  let data: GqlCustomers;
  try {
    const token = await getAccessToken(store, deps.coord, deps.fetchImpl);
    const gql = <T>(query: string, variables: Record<string, unknown>) =>
      shopifyGraphql<T>({ shop: store.shopDomain, accessToken: token, apiVersion: env().SHOPIFY_API_VERSION, query, variables, fetchImpl: deps.fetchImpl, maxRetries: 2 });
    // A local number ("0412 345 678") is read in the store's country, which only Shopify knows.
    const typed = opts.search?.trim() ?? "";
    let country: string | null = null;
    if (typed && looksLikePhone(typed) && !normalizePhone(typed, null)) country = await storeCountryOf(store.id, await gql<GqlShopCountry>(SHOP_COUNTRY_QUERY, {}));
    const search = waCustomerSearch(typed, country);
    data = await gql<GqlCustomers>(CUSTOMERS_QUERY, {
      first,
      after: opts.after || null,
      query: search?.query ?? null,
      sortKey: search ? "RELEVANCE" : "CREATED_AT",
      reverse: !search,
    });
  } catch (err) {
    if (err instanceof StoreDisconnectedError) throw new WhatsappError("This store isn't connected any more. Reconnect it to see its customers.", 409, "store_disconnected");
    if (err instanceof ShopifyHttpError && (err.status === 401 || err.status === 403)) {
      throw new WhatsappError("Shopify stopped accepting our access. Reconnect the store to see its customers.", 409, "store_disconnected");
    }
    if (err instanceof ShopifyGraphqlError && err.codes.includes("ACCESS_DENIED")) return empty(true);
    logger.warn({ err, storeId: store.id }, "whatsapp customers fetch failed");
    throw new WhatsappError("Shopify didn't answer just now. Please try again in a moment.", 502, "shopify_unavailable");
  }

  // Shopify withholds unapproved fields as nulls next to otherwise valid data (shopifyGraphqlWithCost):
  // a list withheld whole comes back null, and rows with neither a name nor a number mean the store
  // hasn't approved this app for customers' details, not that none of them left any.
  const list = data.customers;
  if (!list) return empty(true);
  const nodes = list.nodes.filter((n): n is GqlCustomer => n !== null);
  const storeCountry = await storeCountryOf(store.id, data);
  const rows = nodes.map((c) => ({ c, phone: customerPhone(c, { storeCountry }) }));
  if (rows.length > 0 && rows.every(({ c, phone }) => !c.displayName?.trim() && !phone.phone)) return empty(true);

  const known = await whatsappStateOf(store, rows.map((r) => r.phone.phoneE164));
  const customers = rows.map(({ c, phone }): WaShopifyCustomer => {
    const id = numericId(c.id);
    return {
      customerId: id,
      name: c.displayName?.trim() || null,
      adminUrl: `${shopAdminUrl}/customers/${encodeURIComponent(id)}`,
      ...phone,
      orders: Number(c.numberOfOrders ?? 0),
      spent: Number(c.amountSpent?.amount ?? 0),
      currency: c.amountSpent?.currencyCode ?? store.currency ?? null,
      whatsapp: phone.phoneE164 ? (known.get(phone.phoneE164) ?? null) : null,
    };
  });
  return {
    fetchedAt: new Date().toISOString(),
    restricted: false,
    customers,
    nextCursor: list.pageInfo.hasNextPage ? list.pageInfo.endCursor : null,
    page: { count: customers.length, withNumber: customers.filter((c) => c.phone).length, withoutCountryCode: customers.filter((c) => c.phone && !c.phoneE164).length },
    shopAdminUrl,
  };
}

/**
 * WhatsApp's contacts and do-not-message entries for these numbers (E.164), by their keyed hash:
 * one query each, nothing decrypted. Numbers WhatsApp knows nothing of are left out.
 */
async function whatsappStateOf(store: Pick<Store, "id" | "workspaceId">, numbers: Array<string | null>): Promise<Map<string, WaCustomerWhatsapp>> {
  const byHash = new Map<string, string>();
  for (const e164 of numbers) if (e164) byHash.set(waPhoneHash(store.id, e164.slice(1)), e164);
  const out = new Map<string, WaCustomerWhatsapp>();
  if (!byHash.size) return out;
  const where = { workspaceId: store.workspaceId, storeId: store.id, phoneHash: { in: [...byHash.keys()] } };
  const [contacts, suppressions] = await Promise.all([
    systemDb.wappContact.findMany({ where, select: { id: true, phoneHash: true, optedOut: true, optedIn: true, marketing: true, notOnWhatsappAt: true, lastOutboundAt: true } }),
    systemDb.wappSuppression.findMany({ where, select: { phoneHash: true, scope: true } }),
  ]);
  const scopes = new Map<string, Set<string>>();
  for (const s of suppressions) scopes.set(s.phoneHash, (scopes.get(s.phoneHash) ?? new Set()).add(s.scope));
  const suppressedOf = (hash: string): WaSuppressionScope | null => {
    const s = scopes.get(hash);
    return s?.has("all") ? "all" : s?.has("marketing") ? "marketing" : null;
  };
  const now = Date.now();
  for (const c of contacts) {
    out.set(byHash.get(c.phoneHash)!, {
      contactId: c.id,
      optedOut: c.optedOut,
      optedIn: c.optedIn,
      marketing: c.marketing as WaMarketingState,
      suppressed: suppressedOf(c.phoneHash),
      notOnWhatsapp: !!c.notOnWhatsappAt && now - c.notOnWhatsappAt.getTime() < NOT_ON_WHATSAPP_MS,
      lastOutboundAt: c.lastOutboundAt,
    });
  }
  // A number only on the do-not-message list (a STOP from someone WhatsApp never messaged, one the team added).
  for (const hash of scopes.keys()) {
    const e164 = byHash.get(hash)!;
    if (!out.has(e164)) out.set(e164, { contactId: null, optedOut: false, optedIn: false, marketing: "unknown", suppressed: suppressedOf(hash), notOnWhatsapp: false, lastOutboundAt: null });
  }
  return out;
}
