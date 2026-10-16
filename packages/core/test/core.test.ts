import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  gidToId,
  normalizeGraphqlOrder,
  normalizeRestOrder,
  refreshAccessToken,
  shopifyGraphql,
  shopifyGraphqlWithCost,
} from "../src/index.js";

const cfg = {
  apiKey: "key",
  apiSecret: "secret",
  scopes: "read_orders,read_products",
  apiVersion: "2025-10",
  redirectUri: "http://localhost:4000/shopify/callback",
};

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("OAuth helpers", () => {
  it("builds an authorize URL only for valid shops", () => {
    const url = new URL(buildAuthorizeUrl(cfg, "My-Shop", "st4te"));
    expect(url.host).toBe("my-shop.myshopify.com");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("scope")).toBe("read_orders,read_products");
    expect(url.searchParams.has("grant_options[]")).toBe(false);
    expect(() => buildAuthorizeUrl(cfg, "evil.com", "s")).toThrow();
  });

  it("exchanges the code for a permanent offline token, never opting into expiring tokens", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ client_id: "key", client_secret: "secret", code: "c0de" });
      // `expiring: 1` would ask Shopify for a 1-hour token plus a single-use refresh token,
      // making rotation a liveness requirement for every store. It must not be sent.
      expect(body).not.toHaveProperty("expiring");
      return jsonResponse({ access_token: "shpat_x", scope: "read_orders,read_products" });
    });
    const t = await exchangeCodeForToken(cfg, "s.myshopify.com", "c0de", fetchImpl as typeof fetch);
    expect(t.accessToken).toBe("shpat_x");
    expect(t.scopes).toEqual(["read_orders", "read_products"]);
    // No expiry and no refresh token: nothing to rotate, nothing for a later authorize to invalidate.
    expect(t.accessTokenExpiresAt).toBeNull();
    expect(t.refreshToken).toBeNull();
    expect(t.refreshTokenExpiresAt).toBeNull();
  });

  it("refresh uses grant_type=refresh_token", async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "old" });
      return jsonResponse({ access_token: "new", scope: "read_orders", expires_in: 60, refresh_token: "new_r" });
    });
    const t = await refreshAccessToken(cfg, "s.myshopify.com", "old", fetchImpl as typeof fetch);
    expect(t.refreshToken).toBe("new_r");
  });

  it("surfaces token errors", async () => {
    const fetchImpl = async () => jsonResponse({ error: "invalid_request" }, 400);
    await expect(exchangeCodeForToken(cfg, "s.myshopify.com", "x", fetchImpl as typeof fetch)).rejects.toThrow(/400/);
  });
});

describe("shopifyGraphql", () => {
  it("retries on THROTTLED then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 9, restoreRate: 1000 } } },
        });
      }
      return jsonResponse({ data: { shop: { name: "S" } } });
    };
    const data = await shopifyGraphql<{ shop: { name: string } }>({
      shop: "s.myshopify.com",
      accessToken: "t",
      apiVersion: "2025-10",
      query: "{shop{name}}",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(data.shop.name).toBe("S");
    expect(calls).toBe(2);
  });

  it("does not retry auth errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    await expect(
      shopifyGraphql({ shop: "s.myshopify.com", accessToken: "t", apiVersion: "x", query: "{}", fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a frozen store's 402 plainly and does not retry it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: "Unavailable Shop" }), { status: 402 }));
    const call = shopifyGraphql({ shop: "s.myshopify.com", accessToken: "t", apiVersion: "x", query: "{}", fetchImpl: fetchImpl as typeof fetch });
    await expect(call).rejects.toThrow("Shopify 402: Unavailable Shop");
    await expect(call).rejects.toMatchObject({ status: 402, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * The delay these return is what decides how fast a backfill runs: it is paid once per page,
 * and a store's import is hundreds of pages. The previous version waited whenever
 * `currentlyAvailable < requestedQueryCost * 2` and then slept long enough to restore the
 * *whole* query cost, which for the 864-point orders query against a 2000-point bucket meant a
 * guaranteed ~8.6s after every page of 7 orders - roughly double what the budget requires, on
 * every page, for ever.
 */
describe("shopifyGraphqlWithCost: cost-budget pacing", () => {
  const costed = (requestedQueryCost: number, throttle: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number }) =>
    (async () => jsonResponse({ data: { ok: true }, extensions: { cost: { requestedQueryCost, throttleStatus: throttle } } })) as unknown as typeof fetch;

  const call = (fetchImpl: typeof fetch) =>
    shopifyGraphqlWithCost<{ ok: boolean }>({ shop: "s.myshopify.com", accessToken: "t", apiVersion: "2025-10", query: "{ok}", fetchImpl });

  it("asks for no delay while the bucket can afford the next call", async () => {
    // 1136 left, next call needs 864: it can run right now.
    const r = await call(costed(864, { maximumAvailable: 2000, currentlyAvailable: 1136, restoreRate: 100 }));
    expect(r.requiredDelayMs).toBe(0);
  });

  it("waits for the shortfall only, not the whole query cost", async () => {
    // 300 left, next call needs 864 → short by 564, restoring at 100/s = 5.64s.
    // The old formula asked for 864/100 = 8.64s regardless of what was left.
    const r = await call(costed(864, { maximumAvailable: 2000, currentlyAvailable: 300, restoreRate: 100 }));
    expect(r.requiredDelayMs).toBe(5640);
  });

  it("clamps to the bucket ceiling so an oversized query cannot ask for a wait that never ends", async () => {
    // Needs more than the bucket can ever hold: wait for a full bucket, not for the cost.
    const r = await call(costed(3000, { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 100 }));
    expect(r.requiredDelayMs).toBe(20_000);
  });

  it("asks for no delay when the response carries no cost accounting", async () => {
    const r = await call((async () => jsonResponse({ data: { ok: true } })) as unknown as typeof fetch);
    expect(r.requiredDelayMs).toBe(0);
  });

  it("returns the delay instead of sleeping it", async () => {
    const started = Date.now();
    const r = await call(costed(864, { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 100 }));
    expect(r.requiredDelayMs).toBe(8640);
    // The point of the change: the caller decides when to wait, so the call itself is immediate.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("normalizers", () => {
  it("normalizes REST webhook orders", () => {
    const n = normalizeRestOrder({
      id: 820982911946154500,
      name: "#1001",
      currency: "AUD",
      created_at: "2026-03-01T10:00:00+11:00",
      updated_at: "2026-03-01T10:05:00+11:00",
      cancelled_at: null,
      subtotal_price: "90.00",
      total_discounts: "10.00",
      total_tax: "9.00",
      total_price: "104.00",
      total_shipping_price_set: { shop_money: { amount: "5.00" } },
      customer: { id: 77, email: "secret@example.com" },
      line_items: [
        { id: 1, product_id: 5, title: "Tee", quantity: 2, price: "50.00", discount_allocations: [{ amount: "10.00" }] },
      ],
      refunds: [{ id: 9, created_at: "2026-03-02T00:00:00Z", refund_line_items: [{ subtotal: "25.00" }] }],
    });
    expect(n.shopifyId).toBe("820982911946154500");
    expect(n.totalShipping).toBe(5);
    expect(n.lineItems[0]).toMatchObject({ price: 50, quantity: 2, discount: 10, productShopifyId: "5" });
    // Returns come from Shopify's sales records, which REST payloads don't carry.
    expect(n.sales).toBeNull();
    expect(n.customerId).toBe("77");
    expect(JSON.stringify(n)).not.toContain("secret@example.com");
  });

  it("normalizes GraphQL orders", () => {
    const g = normalizeGraphqlOrder({
      id: "gid://shopify/Order/42",
      name: "#42",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      currencyCode: "USD",
      displayFinancialStatus: "PAID",
      subtotalPriceSet: { shopMoney: { amount: "10.0" } },
      totalDiscountsSet: { shopMoney: { amount: "0.0" } },
      totalTaxSet: { shopMoney: { amount: "1.0" } },
      totalShippingPriceSet: { shopMoney: { amount: "0.0" } },
      totalPriceSet: { shopMoney: { amount: "11.0" } },
      customer: { id: "gid://shopify/Customer/3", numberOfOrders: "4" },
      lineItems: { nodes: [{ id: "gid://shopify/LineItem/7", title: "A", quantity: 1, product: { id: "gid://shopify/Product/8" }, originalUnitPriceSet: { shopMoney: { amount: "10.0" } }, totalDiscountSet: { shopMoney: { amount: "0" } } }] },
      agreements: { nodes: [] },
    });
    expect(g.sales).toEqual([]);
    expect(g.shopifyId).toBe("42");
    expect(g.customerOrderCount).toBe(4);
    expect(g.lineItems[0]!.productShopifyId).toBe("8");
    expect(g.financialStatus).toBe("paid");
    expect(gidToId(null)).toBeNull();
  });
});
