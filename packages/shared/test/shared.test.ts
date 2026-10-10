import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  aggregateDaily,
  can,
  channelLabel,
  clampCustomRange,
  customRangeProblem,
  decrypt,
  eachDay,
  delta,
  encrypt,
  expandScopes,
  generateOtp,
  hashOtp,
  isDay,
  keyVersionOf,
  localDay,
  normalizeShopDomain,
  parseKeyring,
  resolveCapabilities,
  resolvePreset,
  scopesForModule,
  signShopifyQuery,
  signWebhookBody,
  summarize,
  summarizeJourney,
  verifyOtp,
  verifyShopifyQueryHmac,
  verifyShopifyWebhookHmac,
} from "../src/index.js";

const SECRET = "shpss_test_secret";

describe("normalizeShopDomain", () => {
  it.each([
    ["my-store", "my-store.myshopify.com"],
    ["My-Store.myshopify.com", "my-store.myshopify.com"],
    ["https://my-store.myshopify.com/admin/orders?x=1", "my-store.myshopify.com"],
    ["  shop1.myshopify.com  ", "shop1.myshopify.com"],
    ["https://admin.shopify.com/store/My-Store/orders?x=1", "my-store.myshopify.com"],
    ["admin.shopify.com/store/shop1", "shop1.myshopify.com"],
  ])("%s -> %s", (input, out) => expect(normalizeShopDomain(input)).toBe(out));

  it.each(["", "evil.com", "my-store.myshopify.com.evil.com", "-bad.myshopify.com", "a b.myshopify.com", "shop.myshopify.co", "admin.shopify.com", "admin.shopify.com/store/evil.com"])(
    "rejects %s",
    (input) => expect(normalizeShopDomain(input)).toBeNull(),
  );
});

describe("Shopify HMAC", () => {
  it("accepts a correctly signed OAuth query and rejects tampering", () => {
    const params = { code: "abc", shop: "s.myshopify.com", state: "n1", timestamp: "1700000000" };
    const hmac = signShopifyQuery(params, SECRET);
    expect(verifyShopifyQueryHmac({ ...params, hmac }, SECRET)).toBe(true);
    expect(verifyShopifyQueryHmac({ ...params, shop: "x.myshopify.com", hmac }, SECRET)).toBe(false);
    expect(verifyShopifyQueryHmac({ ...params, hmac: "00" }, SECRET)).toBe(false);
    expect(verifyShopifyQueryHmac(params, SECRET)).toBe(false);
  });

  it("verifies webhook bodies byte-for-byte", () => {
    const body = Buffer.from('{"id":1,"total":"10.00"}');
    const sig = signWebhookBody(body, SECRET);
    expect(verifyShopifyWebhookHmac(body, sig, SECRET)).toBe(true);
    expect(verifyShopifyWebhookHmac(Buffer.from('{"id":1,"total":"99.00"}'), sig, SECRET)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, undefined, SECRET)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, sig, "other")).toBe(false);
  });
});

describe("token encryption", () => {
  const k1 = randomBytes(32).toString("base64");
  const k2 = randomBytes(32).toString("base64");

  it("round-trips and binds AAD", () => {
    const ring = parseKeyring(`1:${k1}`);
    const ct = encrypt("shpat_secret", ring, "store-1");
    expect(ct).not.toContain("shpat_secret");
    expect(decrypt(ct, ring, "store-1")).toBe("shpat_secret");
    expect(() => decrypt(ct, ring, "store-2")).toThrow();
  });

  it("supports key rotation", () => {
    const old = parseKeyring(`1:${k1}`);
    const ct = encrypt("tok", old);
    const rotated = parseKeyring(`2:${k2},1:${k1}`);
    expect(decrypt(ct, rotated)).toBe("tok");
    expect(keyVersionOf(encrypt("tok", rotated))).toBe(2);
  });

  it("rejects bad keys", () => {
    expect(() => parseKeyring("1:short")).toThrow();
    expect(() => parseKeyring("")).toThrow();
  });
});

describe("OTP", () => {
  it("generates 6 digits and verifies only the right code for the right email", () => {
    for (let i = 0; i < 50; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
    const h = hashOtp("012345", "A@x.com", "pep");
    expect(verifyOtp("012345", "a@x.com", "pep", h)).toBe(true);
    expect(verifyOtp("012346", "a@x.com", "pep", h)).toBe(false);
    expect(verifyOtp("012345", "b@x.com", "pep", h)).toBe(false);
    expect(verifyOtp("12345", "a@x.com", "pep", h)).toBe(false);
  });
});

describe("capabilities", () => {
  it("expands write_ to read_", () => {
    expect(expandScopes("write_orders").has("read_orders")).toBe(true);
  });

  it("only enables modules backed by granted scopes", () => {
    const caps = resolveCapabilities(["read_orders"]);
    const on = caps.filter((c) => c.enabled).map((c) => c.id);
    expect(on).toEqual(["sales_overview", "refunds", "channels", "order_timing", "fulfillment", "discount_codes", "recent_orders"]);
    expect(caps.find((c) => c.id === "customers")?.missingScopes).toEqual(["read_customers"]);
    expect(caps.find((c) => c.id === "inventory")?.missingScopes).toEqual(["read_products"]);
  });

  it("splits missing scopes into the three answers a merchant can be given", () => {
    // What the deployed app declares; the API passes both in (@app/core declaredScopes /
    // declaredOptionalScopes), because only it reads the env that mirrors the toml.
    const caps = resolveCapabilities(["read_orders"], {
      declaredScopes: ["read_orders", "read_products"],
      optionalScopes: ["read_customers"],
    });

    // Asked for at install but not granted by this store → reconnecting re-asks and fixes it.
    const inventory = caps.find((c) => c.id === "inventory")!;
    expect(inventory.missingScopes).toEqual(["read_products"]);
    expect(inventory.reconnectableScopes).toEqual(["read_products"]);
    expect(inventory.requestableScopes).toEqual([]);

    // Declared optional → one merchant consent away, so "Enable" is offerable.
    const customers = caps.find((c) => c.id === "customers")!;
    expect(customers.missingScopes).toEqual(["read_customers"]);
    expect(customers.requestableScopes).toEqual(["read_customers"]);
    expect(customers.reconnectableScopes).toEqual([]);

    // Declared nowhere → nothing the merchant can do; the UI must offer no action.
    const funnel = caps.find((c) => c.id === "funnel")!;
    expect(funnel.missingScopes).toEqual(["write_pixels", "read_customer_events"]);
    expect(funnel.requestableScopes).toEqual([]);
    expect(funnel.reconnectableScopes).toEqual([]);
  });

  it("offers nothing at all when the caller passes no scope lists", () => {
    for (const c of resolveCapabilities(["read_orders"])) {
      expect(c.requestableScopes).toEqual([]);
      expect(c.reconnectableScopes).toEqual([]);
    }
  });

  it("counts a declared write_ scope as covering the read_ a module asks for", () => {
    // The funnel needs read_customer_events; declaring write_pixels must not imply it.
    const caps = resolveCapabilities([], { optionalScopes: ["write_pixels"] });
    const funnel = caps.find((c) => c.id === "funnel")!;
    expect(funnel.requestableScopes).toEqual(["write_pixels"]);
  });

  it("maps a module back to the scopes a grant request must ask for", () => {
    expect(scopesForModule("funnel")).toEqual(["write_pixels", "read_customer_events"]);
    expect(scopesForModule("customers")).toEqual(["read_orders", "read_customers"]);
  });

  it("labels Shopify sales channels in plain language", () => {
    expect(channelLabel("web")).toBe("Online Store");
    expect(channelLabel("pos")).toBe("Point of Sale");
    expect(channelLabel("shopify_draft_order")).toBe("Draft orders");
    expect(channelLabel("580111")).toBe("Other sales channel app");
    expect(channelLabel("my_custom-channel")).toBe("My custom channel");
    expect(channelLabel(null)).toBe("Unknown");
  });

  it("funnel requires pixel installed", () => {
    const scopes = ["read_orders", "write_pixels", "read_customer_events"];
    expect(resolveCapabilities(scopes).find((c) => c.id === "funnel")?.enabled).toBe(false);
    expect(resolveCapabilities(scopes, { pixelInstalled: true }).find((c) => c.id === "funnel")?.enabled).toBe(true);
  });
});

describe("roles", () => {
  it("enforces matrix", () => {
    expect(can("owner", "billing:manage")).toBe(true);
    expect(can("admin", "billing:manage")).toBe(false);
    expect(can("viewer", "stores:manage")).toBe(false);
  });
});

describe("dates & time zones", () => {
  it("buckets by store time zone", () => {
    const t = new Date("2026-03-01T03:00:00Z");
    expect(localDay(t, "UTC")).toBe("2026-03-01");
    expect(localDay(t, "America/New_York")).toBe("2026-02-28");
    expect(localDay(t, "Australia/Sydney")).toBe("2026-03-01");
  });

  it("resolves presets with previous period of equal length", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const { range, previous } = resolvePreset("7d", now, "UTC");
    expect(range).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    expect(previous).toEqual({ from: "2026-09-19", to: "2026-09-25" });
    expect(resolvePreset("mtd", now, "UTC").range.from).toBe("2026-10-01");
    expect(() => resolvePreset("custom", now, "UTC", { from: "2026-10-02", to: "2026-10-01" })).toThrow();
  });

  it("resolves last month as the whole calendar month, against the whole month before it", () => {
    expect(resolvePreset("lastmonth", new Date("2026-10-02T12:00:00Z"), "UTC")).toEqual({
      range: { from: "2026-09-01", to: "2026-09-30" },
      previous: { from: "2026-08-01", to: "2026-08-31" },
    });
    // January looks back across the year; March compares with a short February.
    expect(resolvePreset("lastmonth", new Date("2026-01-15T12:00:00Z"), "UTC").range).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(resolvePreset("lastmonth", new Date("2026-04-01T12:00:00Z"), "UTC")).toEqual({
      range: { from: "2026-03-01", to: "2026-03-31" },
      previous: { from: "2026-02-01", to: "2026-02-28" },
    });
    // The store's own calendar: 1 Nov in Sydney is still October in UTC.
    expect(resolvePreset("lastmonth", new Date("2026-10-31T20:00:00Z"), "Australia/Sydney").range).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("only treats a finished, in-order custom range as one to report on", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    expect(customRangeProblem({ from: "2026-09-01", to: "2026-09-15" })).toBeNull();
    expect(resolvePreset("custom", now, "UTC", { from: "2026-09-01", to: "2026-09-15" }).previous).toEqual({ from: "2026-08-17", to: "2026-08-31" });
    expect(customRangeProblem({ from: "2026-09-01", to: "" })).toBe("incomplete");
    expect(customRangeProblem({})).toBe("incomplete");
    // What Chrome reports while "2026" is typed into the year, one digit at a time.
    for (const partial of ["0002-09-15", "0020-09-15", "0202-09-15"]) {
      expect(customRangeProblem({ from: "2026-09-01", to: partial })).toBe("incomplete");
      expect(() => resolvePreset("custom", now, "UTC", { from: "2026-09-01", to: partial })).toThrow("Invalid custom range");
    }
    expect(customRangeProblem({ from: "2026-09-15", to: "2026-09-01" })).toBe("reversed");
    expect(customRangeProblem({ from: "2025-01-01", to: "2025-12-31" })).toBeNull();
    expect(customRangeProblem({ from: "2025-01-01", to: "2026-01-02" })).toBe("too_long");
    expect(() => resolvePreset("custom", now, "UTC", { from: "2025-01-01", to: "2026-01-02" })).toThrow("Range too long");
  });

  it("accepts only real calendar days", () => {
    expect(isDay("2024-02-29")).toBe(true);
    // The shape alone let these through, and month 13 then threw a RangeError (a 500) in addDays.
    for (const bad of ["2026-02-29", "2026-02-31", "2026-13-01", "2026-00-10", "2026-9-1", "", null, undefined]) {
      expect(isDay(bad)).toBe(false);
    }
    expect(customRangeProblem({ from: "2026-13-01", to: "2026-13-05" })).toBe("incomplete");
    expect(() => resolvePreset("custom", new Date("2026-10-02T12:00:00Z"), "UTC", { from: "2026-09-01", to: "2026-02-31" })).toThrow("Invalid custom range");
  });

  it("lists every day of a range, across month ends and DST", () => {
    expect(eachDay("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(eachDay("2026-03-07", "2026-03-09")).toHaveLength(3);
    expect(eachDay("2026-10-09", "2026-10-09")).toEqual(["2026-10-09"]);
    expect(eachDay("2026-10-09", "2026-10-08")).toEqual([]);
  });

  it("reports a custom range only up to the store's today", () => {
    // 9 Oct, 01:00 in Sydney is still 8 Oct in UTC.
    const now = new Date("2026-10-08T14:00:00Z");
    const sydney = "Australia/Sydney";
    const today = localDay(now, sydney);
    expect(today).toBe("2026-10-09");

    // 1–31 Oct is reported as 1–9 Oct and compared with the 9 days before, not with 31.
    expect(customRangeProblem({ from: "2026-10-01", to: "2026-10-31" }, today)).toBeNull();
    expect(resolvePreset("custom", now, sydney, { from: "2026-10-01", to: "2026-10-31" })).toEqual({
      range: { from: "2026-10-01", to: "2026-10-09" },
      previous: { from: "2026-09-22", to: "2026-09-30" },
    });
    expect(clampCustomRange({ from: "2026-10-01", to: "2026-10-05" }, today)).toEqual({ from: "2026-10-01", to: "2026-10-05" });

    // Starting after today has nothing to report.
    expect(customRangeProblem({ from: "2026-10-10", to: "2026-10-12" }, today)).toBe("future");
    expect(() => resolvePreset("custom", now, sydney, { from: "2026-10-10", to: "2026-10-12" })).toThrow("Range starts after today");
    // Today itself is fine, in the store's zone rather than UTC's.
    expect(resolvePreset("custom", now, sydney, { from: "2026-10-09", to: "2026-10-09" }).range).toEqual({ from: "2026-10-09", to: "2026-10-09" });
    expect(() => resolvePreset("custom", now, "UTC", { from: "2026-10-09", to: "2026-10-09" })).toThrow("Range starts after today");

    // The year limit counts the days actually reported.
    expect(customRangeProblem({ from: "2025-10-09", to: "2026-12-31" }, today)).toBeNull();
    expect(customRangeProblem({ from: "2025-10-08", to: "2026-12-31" }, today)).toBe("too_long");
  });
});

describe("KPIs", () => {
  const tz = "America/New_York";
  const orders = [
    {
      createdAt: new Date("2026-03-01T15:00:00Z"),
      cancelledAt: null,
      customerKey: "c1",
      isReturningCustomer: false,
      lineItems: [{ price: 50, quantity: 2, discount: 10 }],
    },
    {
      createdAt: new Date("2026-03-01T16:00:00Z"),
      cancelledAt: null,
      customerKey: "c2",
      isReturningCustomer: true,
      lineItems: [{ price: 20, quantity: 1, discount: 0 }],
    },
    {
      createdAt: new Date("2026-03-01T17:00:00Z"),
      cancelledAt: new Date("2026-03-01T18:00:00Z"),
      customerKey: null,
      isReturningCustomer: false,
      lineItems: [{ price: 999, quantity: 1, discount: 0 }],
    },
    {
      // 01:00 UTC on Mar 2 is still Mar 1 in New York
      createdAt: new Date("2026-03-02T01:00:00Z"),
      cancelledAt: null,
      customerKey: null,
      isReturningCustomer: false,
      lineItems: [{ price: 30, quantity: 1, discount: 0 }],
    },
  ];
  const refunds = [
    { orderId: "o1", createdAt: new Date("2026-03-03T15:00:00Z"), lineSubtotal: 45 },
  ];

  it("aggregates per local day, excludes cancelled orders, books refunds on refund date", () => {
    const daily = aggregateDaily(orders, refunds, tz, localDay);
    const d1 = daily.get("2026-03-01")!;
    expect(d1.orders).toBe(3);
    expect(d1.grossSales).toBe(150);
    expect(d1.discounts).toBe(10);
    expect(d1.ordersWithCustomer).toBe(2);
    expect(d1.returningCustomerOrders).toBe(1);
    expect(daily.get("2026-03-03")!.refunds).toBe(45);
    expect(daily.get("2026-03-03")!.refundedOrders).toBe(1);
  });

  it("summarizes with documented formulas", () => {
    const s = summarize([...aggregateDaily(orders, refunds, tz, localDay).values()]);
    expect(s.grossSales).toBe(150);
    expect(s.netSales).toBe(150 - 10 - 45);
    expect(s.averageOrderValue).toBe(46.67);
    expect(s.refundRate).toBeCloseTo(45 / 140);
    expect(s.returningCustomerRate).toBe(0.5);
  });

  it("returns null ratios for empty data instead of fake zeros", () => {
    const s = summarize([]);
    expect(s.averageOrderValue).toBeNull();
    expect(s.refundRate).toBeNull();
    expect(summarizeJourney([], []).conversionRate).toBeNull();
    expect(delta(10, 0)).toBeNull();
    expect(delta(15, 10)).toBe(0.5);
  });
});
