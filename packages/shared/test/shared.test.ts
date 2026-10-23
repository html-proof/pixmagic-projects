import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  aggregateDaily,
  orderMoment,
  can,
  channelLabel,
  ALL_HISTORY,
  adsHistoryStart,
  clampCustomRange,
  comparisonImported,
  customRangeProblem,
  decrypt,
  eachDay,
  delta,
  encrypt,
  expandScopes,
  firstWholeDay,
  historyStart,
  isDay,
  keyVersionOf,
  localDay,
  localTime,
  normalizeShopDomain,
  parseKeyring,
  resolveCapabilities,
  resolvePreset,
  saleValue,
  scopesForModule,
  signShopifyQuery,
  signWebhookBody,
  summarize,
  summarizeJourney,
  verifyShopifyQueryHmac,
  verifyShopifyWebhookHmac,
  visitsHistoryStart,
  yearEarlier,
  type SaleInput,
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

  it("refuses a truncated authentication tag", () => {
    const ring = parseKeyring(`1:${k1}`);
    const [v, iv, tag, data] = encrypt("shpat_secret", ring).split(".");
    const short = Buffer.from(tag!, "base64").subarray(0, 4).toString("base64");
    expect(() => decrypt([v, iv, short, data].join("."), ring)).toThrow();
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
    expect(previous).toEqual({ from: "2026-09-19", to: "2026-09-25", until: "12:00:00" });
    expect(resolvePreset("mtd", now, "UTC").range.from).toBe("2026-10-01");
    expect(() => resolvePreset("custom", now, "UTC", { from: "2026-10-02", to: "2026-10-01" })).toThrow();
  });

  it("compares a range that is still running up to the same time of day, as Shopify does", () => {
    // 17 Oct, 4:44:12 pm in Melbourne (AEDT, UTC+11).
    const now = new Date("2026-10-17T05:44:12Z");
    const tz = "Australia/Melbourne";
    expect(localTime(now, tz)).toBe("16:44:12");
    // Today so far against yesterday until the same moment, not the whole of yesterday.
    expect(resolvePreset("today", now, tz)).toEqual({ range: { from: "2026-10-17", to: "2026-10-17" }, previous: { from: "2026-10-16", to: "2026-10-16", until: "16:44:12" } });
    expect(resolvePreset("7d", now, tz).previous).toEqual({ from: "2026-10-04", to: "2026-10-10", until: "16:44:12" });
    // A custom range ending today runs too; one that ended earlier doesn't.
    expect(resolvePreset("custom", now, tz, { from: "2026-10-15", to: "2026-10-31" }).previous.until).toBe("16:44:12");
    expect(resolvePreset("custom", now, tz, { from: "2026-10-01", to: "2026-10-16" }).previous.until).toBeUndefined();
    // Finished days are compared whole.
    for (const preset of ["yesterday", "lastmonth"] as const) expect(resolvePreset(preset, now, tz).previous.until, preset).toBeUndefined();
    // Just after midnight: a few seconds of yesterday, on a 24-hour clock ("00", never "24").
    expect(resolvePreset("today", new Date("2026-10-16T13:00:05Z"), tz).previous).toEqual({ from: "2026-10-16", to: "2026-10-16", until: "00:00:05" });
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

  it("resolves this year from 1 January, and last year as the whole calendar year against the year before it", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    // This year so far, against as many days just before it, up to the same time of day.
    expect(resolvePreset("ytd", now, "UTC")).toEqual({ range: { from: "2026-01-01", to: "2026-10-22" }, previous: { from: "2025-03-12", to: "2025-12-31", until: "12:00:00" } });
    expect(resolvePreset("ytd", now, "UTC", undefined, { mode: "year" }).previous).toEqual({ from: "2025-01-01", to: "2025-10-22", until: "12:00:00" });
    // A whole year is over: compared whole, with the whole year before, leap years included.
    expect(resolvePreset("lastyear", now, "UTC")).toEqual({ range: { from: "2025-01-01", to: "2025-12-31" }, previous: { from: "2024-01-01", to: "2024-12-31" } });
    expect(resolvePreset("lastyear", new Date("2029-02-01T12:00:00Z"), "UTC").range).toEqual({ from: "2028-01-01", to: "2028-12-31" });
    // The store's own calendar: 1 Jan in Sydney is still December in UTC.
    expect(resolvePreset("ytd", new Date("2026-12-31T20:00:00Z"), "Australia/Sydney").range).toEqual({ from: "2027-01-01", to: "2027-01-01" });
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
    // The 9th is still running (01:00), so the 30th counts up to 01:00.
    expect(resolvePreset("custom", now, sydney, { from: "2026-10-01", to: "2026-10-31" })).toEqual({
      range: { from: "2026-10-01", to: "2026-10-09" },
      previous: { from: "2026-09-22", to: "2026-09-30", until: "01:00:00" },
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

describe("what the dates are compared with", () => {
  // 17 Oct 2026, 4:44:12 pm in Melbourne (AEDT, UTC+11).
  const now = new Date("2026-10-17T05:44:12Z");
  const tz = "Australia/Melbourne";

  it("compares with the period just before unless asked otherwise", () => {
    expect(resolvePreset("30d", now, tz, undefined, { mode: "previous" })).toEqual(resolvePreset("30d", now, tz));
    expect(resolvePreset("lastmonth", now, tz, undefined, { mode: "previous" }).previous).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("compares with the same dates a year earlier, like for like while they run", () => {
    // Today until 4:44 pm against 17 Oct 2025 until 4:44 pm.
    expect(resolvePreset("today", now, tz, undefined, { mode: "year" })).toEqual({
      range: { from: "2026-10-17", to: "2026-10-17" },
      previous: { from: "2025-10-17", to: "2025-10-17", until: "16:44:12" },
    });
    expect(resolvePreset("mtd", now, tz, undefined, { mode: "year" }).previous).toEqual({ from: "2025-10-01", to: "2025-10-17", until: "16:44:12" });
    // Finished dates are compared whole: September against September.
    expect(resolvePreset("lastmonth", now, tz, undefined, { mode: "year" }).previous).toEqual({ from: "2025-09-01", to: "2025-09-30" });
    expect(resolvePreset("custom", now, tz, { from: "2026-03-01", to: "2026-03-14" }, { mode: "year" }).previous).toEqual({ from: "2025-03-01", to: "2025-03-14" });
  });

  it("maps 29 February to the 28th a year earlier", () => {
    expect(yearEarlier("2028-02-29")).toBe("2027-02-28");
    expect(yearEarlier("2028-03-01")).toBe("2027-03-01");
    expect(yearEarlier("2029-02-28")).toBe("2028-02-28");
    // February 2028 (29 days) against February 2027 (28).
    expect(resolvePreset("lastmonth", new Date("2028-03-05T12:00:00Z"), "UTC", undefined, { mode: "year" })).toEqual({
      range: { from: "2028-02-01", to: "2028-02-29" },
      previous: { from: "2027-02-01", to: "2027-02-28" },
    });
    expect(resolvePreset("custom", new Date("2028-03-05T12:00:00Z"), "UTC", { from: "2028-02-29", to: "2028-02-29" }, { mode: "year" }).previous).toEqual({
      from: "2027-02-28",
      to: "2027-02-28",
    });
  });

  it("compares with custom dates, cut at the same time of day while the range runs", () => {
    // Shopify's "Today" against 14 Mar 2026: that day until 4:44 pm.
    expect(resolvePreset("today", now, tz, undefined, { mode: "custom", from: "2026-03-14", to: "2026-03-14" }).previous).toEqual({
      from: "2026-03-14",
      to: "2026-03-14",
      until: "16:44:12",
    });
    // Any length, even overlapping the range; finished dates against whole days.
    expect(resolvePreset("yesterday", now, tz, undefined, { mode: "custom", from: "2026-10-01", to: "2026-10-16" }).previous).toEqual({ from: "2026-10-01", to: "2026-10-16" });
    // Running past the store's today: counted up to today, as a custom range is.
    expect(resolvePreset("lastmonth", now, tz, undefined, { mode: "custom", from: "2026-10-01", to: "2026-10-31" }).previous).toEqual({ from: "2026-10-01", to: "2026-10-17" });
  });

  it("refuses custom comparison dates that can't be reported on", () => {
    const custom = (from?: string, to?: string) => () => resolvePreset("7d", now, tz, undefined, { mode: "custom", from, to });
    expect(custom()).toThrow("Invalid comparison dates");
    expect(custom("2026-03-14")).toThrow("Invalid comparison dates");
    expect(custom("2026-03-14", "2026-02-31")).toThrow("Invalid comparison dates");
    expect(custom("2026-03-14", "2026-03-01")).toThrow("Invalid comparison dates");
    expect(custom("0202-03-01", "2026-03-14")).toThrow("Invalid comparison dates");
    expect(custom("2026-10-18", "2026-10-20")).toThrow("Comparison starts after today");
    expect(custom("2025-01-01", "2026-01-02")).toThrow("Comparison too long");
    // The dates picked are checked first.
    expect(() => resolvePreset("custom", now, tz, { from: "2026-10-18", to: "2026-10-19" }, { mode: "custom" })).toThrow("Range starts after today");
  });

  it("knows when the imported orders don't reach back to the comparison", () => {
    expect(comparisonImported({ from: "2026-08-18", to: "2026-09-16" }, "2026-08-18")).toBe(true);
    // Partly before the first imported order: a period mostly missing, not a drop.
    expect(comparisonImported({ from: "2026-08-17", to: "2026-09-16" }, "2026-08-18")).toBe(false);
    expect(comparisonImported({ from: "2025-10-17", to: "2025-10-17" }, "2026-08-18")).toBe(false);
    expect(comparisonImported({ from: "2026-10-16", to: "2026-10-16" }, null)).toBe(false);
  });

  it("starts the imported history where the import window did, not at a quiet store's first order", () => {
    const tz = "Australia/Melbourne";
    // Imported 17 Oct 2026 at 10:00 in Melbourne (23:00Z the day before): Shopify's 60 days begin
    // at 10:00 on 18 Aug, a day only partly imported, so 19 Aug is the first whole day.
    const window = new Date("2026-08-18T00:00:00Z");
    // A quiet store: its first order came on 25 Aug, but 19 to 24 Aug were imported too (no orders).
    expect(historyStart(window, tz, "2026-08-25")).toBe("2026-08-19");
    const lastThirty = { from: "2026-08-19", to: "2026-09-17" };
    expect(comparisonImported(lastThirty, historyStart(window, tz, "2026-08-25"))).toBe(true);
    // What the first order alone used to say about the same comparison.
    expect(comparisonImported(lastThirty, "2026-08-25")).toBe(false);
    // Still not before the window: that is what Shopify didn't share.
    expect(comparisonImported({ from: "2026-08-18", to: "2026-09-16" }, historyStart(window, tz, "2026-08-25"))).toBe(false);
    // A window from the store's midnight covers that whole day.
    expect(historyStart(new Date("2026-08-18T14:00:00Z"), tz, null)).toBe("2026-08-19");
    expect(historyStart(new Date("2026-08-18T14:00:01Z"), tz, null)).toBe("2026-08-20");
    // Orders older than the window (an earlier import, before the window was recorded) count from the first.
    expect(historyStart(window, tz, "2026-07-02")).toBe("2026-07-02");
    // A store whose import predates the record: the first order, as before.
    expect(historyStart(null, tz, "2026-08-25")).toBe("2026-08-25");
    expect(historyStart(null, tz, null)).toBeNull();
    // Imported, no orders at all: the window is still known, and its days hold no sales.
    expect(historyStart(window, tz, null)).toBe("2026-08-19");
    // read_all_orders: the whole history, so no comparison is "before the import".
    expect(historyStart(new Date(0), tz, "2026-08-25")).toBe(ALL_HISTORY);
    expect(comparisonImported({ from: "2019-01-01", to: "2019-01-31" }, historyStart(new Date(0), tz, "2026-08-25"))).toBe(true);
  });

  it("counts store visits from the first whole day after the pixel was put in place", () => {
    const tz = "Australia/Melbourne";
    // Put in place at 10:00 on 18 Aug in Melbourne (00:00Z): the 18th was only partly counted.
    const installed = new Date("2026-08-18T00:00:00Z");
    expect(firstWholeDay(installed, tz)).toBe("2026-08-19");
    // At the store's midnight, that day was counted whole.
    expect(firstWholeDay(new Date("2026-08-18T14:00:00Z"), tz)).toBe("2026-08-19");
    // Visits on the install day itself don't make it a whole day.
    expect(visitsHistoryStart(installed, tz, "2026-08-18")).toBe("2026-08-19");
    expect(visitsHistoryStart(installed, tz, "2026-08-25")).toBe("2026-08-19");
    expect(visitsHistoryStart(installed, tz, null)).toBe("2026-08-19");
    // Visits from an earlier day: a pixel already in place before bizinsights recorded it.
    expect(visitsHistoryStart(installed, tz, "2026-08-10")).toBe("2026-08-10");
    // No install recorded: the first visit's day.
    expect(visitsHistoryStart(null, tz, "2026-08-25")).toBe("2026-08-25");
    expect(visitsHistoryStart(null, tz, null)).toBeNull();
    // The last 30 days on 17 Oct reach back before a pixel added at noon on 1 Oct: not compared.
    const added = visitsHistoryStart(new Date("2026-10-01T02:00:00Z"), tz, "2026-10-01");
    expect(added).toBe("2026-10-02");
    expect(comparisonImported({ from: "2026-09-17", to: "2026-10-16" }, added)).toBe(false);
    expect(comparisonImported({ from: "2026-10-02", to: "2026-10-09" }, added)).toBe(true);
  });

  it("compares ad figures from the latest start among the accounts counted", () => {
    // Two accounts connected two months apart: only from the later one's start are both in.
    expect(adsHistoryStart(["2026-05-01", "2026-07-20"])).toBe("2026-07-20");
    expect(adsHistoryStart(["2026-07-20", "2026-05-01"])).toBe("2026-07-20");
    // One not synced yet holds no figures, so it changes neither period: left out.
    expect(adsHistoryStart(["2026-05-01", null])).toBe("2026-05-01");
    expect(adsHistoryStart([null])).toBeNull();
    expect(adsHistoryStart([])).toBeNull();
    expect(comparisonImported({ from: "2026-07-19", to: "2026-08-17" }, adsHistoryStart(["2026-05-01", "2026-07-20"]))).toBe(false);
  });
});

describe("KPIs", () => {
  const tz = "America/New_York";
  const orders = [
    { id: "o1", createdAt: new Date("2026-03-01T15:00:00Z"), customerKey: "c1", isReturningCustomer: false },
    { id: "o2", createdAt: new Date("2026-03-01T16:00:00Z"), customerKey: "c2", isReturningCustomer: true },
    // Cancelled later: still an order of the day it was placed, as in Shopify's reports.
    { id: "o3", createdAt: new Date("2026-03-01T17:00:00Z"), customerKey: null, isReturningCustomer: false },
    // 01:00 UTC on Mar 2 is still Mar 1 in New York
    { id: "o4", createdAt: new Date("2026-03-02T01:00:00Z"), customerKey: null, isReturningCustomer: false },
  ];
  const sale = (over: Partial<SaleInput> & Pick<SaleInput, "orderId" | "happenedAt">): SaleInput => ({
    actionType: "order",
    lineType: "product",
    quantity: 1,
    amount: 0,
    discount: 0,
    tax: 0,
    ...over,
  });
  const placed = new Date("2026-03-01T15:00:00Z");
  const sales: SaleInput[] = [
    // o1: two items at 50 less 10 discount, 10% tax on top, plus 5 shipping (tax 0.50).
    sale({ orderId: "o1", happenedAt: placed, quantity: 2, amount: 99, discount: 10, tax: 9 }),
    sale({ orderId: "o1", happenedAt: placed, lineType: "shipping", quantity: null, amount: 5.5, tax: 0.5 }),
    // o2: a 22 item whose price includes 2 of tax (GST-style), and a gift card and a tip, which count nowhere.
    sale({ orderId: "o2", happenedAt: new Date("2026-03-01T16:00:00Z"), amount: 22, tax: 2 }),
    sale({ orderId: "o2", happenedAt: new Date("2026-03-01T16:00:00Z"), lineType: "gift_card", amount: 50 }),
    sale({ orderId: "o2", happenedAt: new Date("2026-03-01T16:00:00Z"), lineType: "tip", amount: 3 }),
    // o3: 999 sold, then cancelled the same evening (a return on the day of the cancellation).
    sale({ orderId: "o3", happenedAt: new Date("2026-03-01T17:00:00Z"), amount: 999 }),
    sale({ orderId: "o3", happenedAt: new Date("2026-03-01T18:00:00Z"), actionType: "return", amount: -999 }),
    // o4: 30, late in the evening in New York.
    sale({ orderId: "o4", happenedAt: new Date("2026-03-02T01:00:00Z"), amount: 30 }),
    // o1 refunds one item on Mar 3 (45 + 4.50 tax).
    sale({ orderId: "o1", happenedAt: new Date("2026-03-03T15:00:00Z"), actionType: "return", amount: -49.5, tax: -4.5 }),
  ];

  it("counts orders on the day placed, cancelled ones too; sales on the day they happened", () => {
    const daily = aggregateDaily(orders, sales, tz, localDay);
    const d1 = daily.get("2026-03-01")!;
    expect(d1.orders).toBe(4);
    expect(d1.ordersWithCustomer).toBe(2);
    expect(d1.returningCustomerOrders).toBe(1);
    // 100 (o1) + 20 (o2, its tax taken out) + 999 (o3) + 30 (o4)
    expect(d1.grossSales).toBeCloseTo(1149, 6);
    expect(d1.discounts).toBe(10);
    // The cancellation is a return the same day.
    expect(d1.refunds).toBe(999);
    expect(d1.shipping).toBe(5);
    expect(d1.taxes).toBeCloseTo(11.5, 6);
    // Net 140 + shipping 5 + taxes 11.50; the gift card and the tip are in neither.
    expect(d1.totalSales).toBeCloseTo(156.5, 6);
    // The gift card is an item sold (Shopify's net items sold), though no sale; the tip isn't.
    expect(d1.units).toBe(6 - 1);
    expect(d1.refundedOrders).toBe(1);

    const d3 = daily.get("2026-03-03")!;
    expect(d3.orders).toBe(0);
    expect(d3.refunds).toBe(45);
    expect(d3.taxes).toBe(-4.5);
    expect(d3.totalSales).toBe(-49.5);
    expect(d3.units).toBe(-1);
    expect(d3.refundedOrders).toBe(1);
  });

  // Found 2026-10-19 by checking a dev store of seeded orders against its own ShopifyQL sales report.
  it("counts an order on the day Shopify processed it, as its reports do", () => {
    // Imported (or synced from POS offline) on 5 Mar for a sale on 1 Mar: Shopify reports it on 1 Mar.
    const imported = { createdAt: new Date("2026-03-05T15:00:00Z"), processedAt: new Date("2026-03-01T15:00:00Z"), customerKey: null, isReturningCustomer: false };
    const daily = aggregateDaily([imported], [sale({ orderId: "i", happenedAt: imported.processedAt, amount: 40 })], tz, localDay);
    expect(daily.get("2026-03-01")).toMatchObject({ orders: 1, grossSales: 40 });
    expect(daily.has("2026-03-05")).toBe(false);
    // Stored before its processed date was read: its creation stands in.
    expect(orderMoment({ createdAt: imported.createdAt, processedAt: null })).toEqual(imported.createdAt);
  });

  it("leaves orders of gift cards only out of orders and customers, but counts their cards as items", () => {
    const giftCards = { createdAt: placed, giftCardOnly: true, customerKey: "c9", isReturningCustomer: false };
    const daily = aggregateDaily([giftCards], [sale({ orderId: "g", happenedAt: placed, lineType: "gift_card", quantity: 2, amount: 100 })], tz, localDay);
    expect(daily.get("2026-03-01")).toMatchObject({ orders: 0, ordersWithCustomer: 0, grossSales: 0, totalSales: 0, units: 2 });
    expect(summarize([...daily.values()]).averageOrderValue).toBeNull();
  });

  it("values the average order on the day it was placed: an edit that day counts, one on a later day doesn't", () => {
    const o = { id: "e", createdAt: placed, customerKey: null, isReturningCustomer: false };
    const daily = aggregateDaily(
      [o],
      [
        sale({ orderId: "e", happenedAt: placed, amount: 110, discount: 10, tax: 10 }),
        // Edited the same evening (still 1 Mar in New York), then again on 3 Mar.
        sale({ orderId: "e", happenedAt: new Date("2026-03-01T20:00:00Z"), amount: 22, tax: 2 }),
        sale({ orderId: "e", happenedAt: new Date("2026-03-03T15:00:00Z"), amount: 33, tax: 3 }),
      ],
      tz,
      localDay,
    );
    const s = summarize([...daily.values()]);
    expect(s.grossSales).toBe(160);
    // (110 − 10) + (22 − 2): Shopify's AOV leaves out what an edit adds on a later day.
    expect(s.averageOrderValue).toBe(120);
  });

  it("summarizes with documented formulas", () => {
    const s = summarize([...aggregateDaily(orders, sales, tz, localDay).values()]);
    expect(s.grossSales).toBe(1149);
    expect(s.discounts).toBe(10);
    expect(s.refunds).toBe(1044);
    expect(s.netSales).toBe(1149 - 10 - 1044);
    expect(s.shipping).toBe(5);
    expect(s.taxes).toBe(7);
    expect(s.totalSales).toBe(95 + 5 + 7);
    // (gross − discounts) ÷ orders, before returns, as Shopify's average order value.
    expect(s.averageOrderValue).toBe(284.75);
    expect(s.refundRate).toBeCloseTo(1044 / 1139);
    expect(s.returningCustomerRate).toBe(0.5);
  });

  it("values a sale before tax, with the sign Shopify gave it", () => {
    expect(saleValue({ actionType: "order", amount: 110, tax: 10 })).toEqual({ value: 100, tax: 10 });
    expect(saleValue({ actionType: "return", amount: -110, tax: -10 })).toEqual({ value: -100, tax: -10 });
    // A refund's adjustment lines come with both signs; each keeps its own.
    expect(saleValue({ actionType: "return", amount: 225.1, tax: 0 })).toEqual({ value: 225.1, tax: 0 });
    // An edit can go either way.
    expect(saleValue({ actionType: "update", amount: -5, tax: 0 })).toEqual({ value: -5, tax: 0 });
  });

  // Regression: two PixMagic refunds as Shopify recorded them (2026-09). Forcing every return line
  // negative counted A$586.70 of returns where Shopify counts A$45.50, so net and total sales were
  // A$541.20 short.
  it("adds a refund's adjustment lines up with their signs, as Shopify's reports do", () => {
    const at = new Date("2026-09-11T05:33:05Z");
    const refunds: SaleInput[] = [
      // #2727S: the item (206.10 with 18.74 GST, 20.81 of it discount) and its shipping refunded, and
      // a pair of adjustments that cancel out.
      sale({ orderId: "a", happenedAt: at, actionType: "return", quantity: -1, amount: -206.1, discount: -20.81, tax: -18.74 }),
      sale({ orderId: "a", happenedAt: at, actionType: "return", lineType: "shipping", quantity: null, amount: -19, tax: -1.73 }),
      sale({ orderId: "a", happenedAt: at, actionType: "return", lineType: "adjustment", quantity: null, amount: 225.1 }),
      sale({ orderId: "a", happenedAt: at, actionType: "return", lineType: "adjustment", quantity: null, amount: -225.1 }),
      // #2804S: 45.50 given back with no item returned.
      sale({ orderId: "b", happenedAt: at, actionType: "return", lineType: "adjustment", quantity: null, amount: 45.5 }),
      sale({ orderId: "b", happenedAt: at, actionType: "return", lineType: "adjustment", quantity: null, amount: -45.5 }),
      sale({ orderId: "b", happenedAt: at, actionType: "return", lineType: "adjustment", quantity: null, amount: -45.5 }),
    ];
    const d = aggregateDaily([], refunds, "Australia/Melbourne", localDay).get("2026-09-11")!;
    expect(d.refunds).toBeCloseTo(187.36 + 45.5, 6);
    expect(d.shipping).toBeCloseTo(-17.27, 6);
    expect(d.taxes).toBeCloseTo(-20.47, 6);
    expect(d.totalSales).toBeCloseTo(-(206.1 + 19 + 45.5), 6);
    expect(d.units).toBe(-1);
    expect(d.refundedOrders).toBe(2);
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
