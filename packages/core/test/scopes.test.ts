import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appOptionalScopes,
  customersFromChange,
  declaredOptionalScopes,
  fetchGrantedScopes,
  logger,
  optionalScopeGrantUrl,
  optionalScopesFor,
  requestableScopes,
  resetEnvCache,
  revocableOptionalScopesFor,
  revocableScopes,
  revokeAccessScopes,
  ScopeRevokeError,
  scopeFollowUpKinds,
  storeHandle,
} from "../src/index.js";

/** The env schema's required fields; `declaredOptionalScopes` parses the whole of it. */
const BASE_ENV = {
  SESSION_SECRET: "0123456789abcdef",
  TOKEN_ENCRYPTION_KEYS: "1:" + "a".repeat(44),
  OTP_PEPPER: "pepper-value",
};

const saved = { ...process.env };

/** SHOPIFY_OPTIONAL_SCOPES is read through the cached env, so set it before the first read. */
function withOptionalScopes<T>(value: string, fn: () => T): T {
  return withEnv({ SHOPIFY_OPTIONAL_SCOPES: value }, fn);
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  Object.assign(process.env, BASE_ENV, vars);
  resetEnvCache();
  return fn();
}

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
  vi.restoreAllMocks();
});

/** What production declares for every app (apps/aws/src/settings.ts), and read_reports for two of them. */
const COMMON = "read_customers,write_pixels,read_customer_events";
const PER_APP = { SHOPIFY_OPTIONAL_SCOPES: COMMON, SHOPIFY_APP_OPTIONAL_SCOPES: "default:read_reports;pixmagic:read_reports" };

describe("optional scopes per app", () => {
  it("adds an app's own extras to the common list", () => {
    withEnv(PER_APP, () => {
      expect(declaredOptionalScopes("pixmagic")).toEqual(["read_customers", "write_pixels", "read_customer_events", "read_reports"]);
      expect(declaredOptionalScopes("default")).toContain("read_reports");
      // No app named, or one without extras (an App Store app): the common list only.
      expect(declaredOptionalScopes()).toEqual(COMMON.split(","));
      expect(declaredOptionalScopes("appstore")).toEqual(COMMON.split(","));
      expect(declaredOptionalScopes("nope")).toEqual(COMMON.split(","));
    });
  });

  it("offers nothing extra in the shipped configuration (the setting empty)", () => {
    withEnv({ SHOPIFY_OPTIONAL_SCOPES: COMMON, SHOPIFY_APP_OPTIONAL_SCOPES: "" }, () => {
      expect(appOptionalScopes()).toEqual({});
      expect(declaredOptionalScopes("default")).toEqual(COMMON.split(","));
    });
  });

  it("leaves out an entry it can't read, and keeps the rest", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    withEnv({ SHOPIFY_OPTIONAL_SCOPES: COMMON, SHOPIFY_APP_OPTIONAL_SCOPES: "default=read_reports; pixmagic:read_reports, read_reports ;PixMagic:read_x;public:" }, () => {
      // Fails closed: a typo offers the scope to no app, never to every app.
      expect(appOptionalScopes()).toEqual({ pixmagic: ["read_reports"] });
      expect(declaredOptionalScopes("default")).toEqual(COMMON.split(","));
      // Read once per value: every request asks, the log says it once.
      appOptionalScopes();
      expect(error).toHaveBeenCalledTimes(3);
    });
  });

  it("offers the App Store reviewer's test store only what the App Store app declares", () => {
    withEnv({ ...PER_APP, SHOPIFY_APP_STORE_PREVIEW_SHOPS: "Review-Store.myshopify.com" }, () => {
      // On the main app, which declares read_reports, but shown as the App Store app, which doesn't.
      expect(optionalScopesFor({ shopifyAppKey: "default", shopDomain: "review-store.myshopify.com" })).not.toContain("read_reports");
      expect(optionalScopesFor({ shopifyAppKey: "default", shopDomain: "dev-store.myshopify.com" })).toContain("read_reports");
      expect(optionalScopesFor({ shopifyAppKey: "pixmagic", shopDomain: "pixmagic.myshopify.com" })).toContain("read_reports");
      expect(optionalScopesFor({ shopifyAppKey: "appstore", shopDomain: "merchant.myshopify.com" })).toEqual(COMMON.split(","));
    });
  });

  it("asks for and gives back only what the store's own app declares", () => {
    withEnv(PER_APP, () => {
      const appstore = optionalScopesFor({ shopifyAppKey: "appstore", shopDomain: "merchant.myshopify.com" });
      const pixmagic = optionalScopesFor({ shopifyAppKey: "pixmagic", shopDomain: "pixmagic.myshopify.com" });
      expect(requestableScopes(["read_reports"], ["read_orders"], appstore)).toEqual([]);
      expect(requestableScopes(["read_reports"], ["read_orders"], pixmagic)).toEqual(["read_reports"]);
      expect(requestableScopes(["read_reports"], ["read_orders", "read_reports"], pixmagic)).toEqual([]);
      // The default stays the common list, which has no read_reports.
      expect(requestableScopes(["read_reports"], ["read_orders"])).toEqual([]);
      expect(revocableScopes(["read_reports"], ["read_orders", "read_reports"], revocableOptionalScopesFor({ shopifyAppKey: "pixmagic" }))).toEqual(["read_reports"]);
      expect(revocableScopes(["read_reports"], ["read_orders", "read_reports"], revocableOptionalScopesFor({ shopifyAppKey: "appstore" }))).toEqual([]);
    });
  });

  it("lets a store give back what its app's toml declares, though the setting no longer offers it", () => {
    // The off switch in docs/shopify-setup.md: the setting emptied, the grant kept.
    withEnv({ SHOPIFY_OPTIONAL_SCOPES: COMMON, SHOPIFY_APP_OPTIONAL_SCOPES: "", SHOPIFY_APP_STORE_PREVIEW_SHOPS: "review-store.myshopify.com" }, () => {
      expect(optionalScopesFor({ shopifyAppKey: "default", shopDomain: "dev-store.myshopify.com" })).not.toContain("read_reports");
      expect(revocableOptionalScopesFor({ shopifyAppKey: "default" })).toEqual([...COMMON.split(","), "read_reports"]);
      expect(revocableOptionalScopesFor({ shopifyAppKey: "pixmagic" })).toContain("read_reports");
      // An App Store app's toml declares nothing extra, and neither does an app we don't know.
      expect(revocableOptionalScopesFor({ shopifyAppKey: "appstore" })).toEqual(COMMON.split(","));
      expect(revocableOptionalScopesFor({ shopifyAppKey: "nope" })).toEqual(COMMON.split(","));
    });
  });
});

describe("optional scope grant URL", () => {
  it("is Shopify's documented request URL for a non-embedded app", () => {
    const url = new URL(optionalScopeGrantUrl("abc123", "demo-shop.myshopify.com", ["read_customers", "write_pixels"]));
    expect(url.origin + url.pathname).toBe("https://admin.shopify.com/store/demo-shop/oauth/install");
    expect(url.searchParams.get("client_id")).toBe("abc123");
    expect(url.searchParams.get("optional_scopes")).toBe("read_customers,write_pixels");
    // No state and no redirect_uri: Shopify accepts neither, and the grant comes back through
    // app/scopes_update or a refresh, never on this redirect. See optionalScopeGrantUrl.
    expect(url.searchParams.get("state")).toBeNull();
    expect(url.searchParams.get("redirect_uri")).toBeNull();
  });

  it("uses the store handle, not the full domain", () => {
    expect(storeHandle("Demo-Shop.myshopify.com")).toBe("demo-shop");
    expect(() => storeHandle("not a shop")).toThrow();
  });

  it("refuses to build a URL that asks for nothing", () => {
    expect(() => optionalScopeGrantUrl("abc123", "demo-shop.myshopify.com", [])).toThrow();
  });
});

describe("requestableScopes", () => {
  it("asks for nothing while the app declares no optional scopes", () => {
    // The state the app ships in. Everything downstream depends on this being empty, so the
    // dashboard offers no button and the API refuses with scope_unavailable.
    withOptionalScopes("", () => {
      expect(declaredOptionalScopes()).toEqual([]);
      expect(requestableScopes(["read_customers"], ["read_orders"])).toEqual([]);
    });
  });

  it("drops scopes the app has not declared as optional", () => {
    withOptionalScopes("read_customers", () => {
      // write_pixels isn't declared: asking for it would land the merchant on a Shopify error.
      expect(requestableScopes(["read_customers", "write_pixels"], ["read_orders"])).toEqual(["read_customers"]);
    });
  });

  it("drops scopes the store already granted, including via an implied read", () => {
    withOptionalScopes("read_customers,read_customer_events,write_pixels", () => {
      expect(requestableScopes(["read_customers"], ["read_orders", "read_customers"])).toEqual([]);
      // Shopify's write_X implies read_X, so a store with write_pixels already has read_pixels.
      expect(requestableScopes(["read_customer_events", "write_pixels"], ["write_pixels"])).toEqual(["read_customer_events"]);
    });
  });

  it("de-duplicates the request", () => {
    withOptionalScopes("read_customers", () => {
      expect(requestableScopes(["read_customers", "read_customers"], [])).toEqual(["read_customers"]);
    });
  });
});

describe("scopeFollowUpKinds", () => {
  /**
   * The point of this function: a granted scope does not backfill the data behind it. Getting
   * read_customers wrong is invisible rather than loud — the orders are already imported without
   * a customer hash, so "New vs returning" would read as 100% new instead of failing.
   */
  it("re-imports orders in full when read_customers arrives", () => {
    expect(scopeFollowUpKinds(["read_customers"])).toEqual(["orders"]);
  });

  it("imports the whole order history when read_all_orders arrives", () => {
    // Without it Shopify shared 60 days, so a comparison with dates before them (14 Mar against
    // 18 Oct) said "No earlier data". The grant fills nothing in by itself: the orders import,
    // with no sinceDays, is what reads the older orders and records the history as complete.
    expect(scopeFollowUpKinds(["read_all_orders"])).toEqual(["orders"]);
    // One import covers both reasons to re-read the orders.
    expect(scopeFollowUpKinds(["read_customers", "read_all_orders"])).toEqual(["orders"]);
  });

  it("installs the web pixel when write_pixels arrives", () => {
    // read_customer_events alone grants nothing to do: the pixel is what produces the events.
    expect(scopeFollowUpKinds(["read_customer_events"])).toEqual([]);
    expect(scopeFollowUpKinds(["write_pixels", "read_customer_events"])).toEqual(["install_pixel"]);
  });

  it("queues nothing for a scope with no backfill behind it", () => {
    expect(scopeFollowUpKinds([])).toEqual([]);
    expect(scopeFollowUpKinds(["read_orders"])).toEqual([]);
  });
});

describe("customersFromChange", () => {
  const at = new Date("2026-10-30T03:00:00Z");

  it("records the moment read_customers arrives: orders read from then on carry their customer", () => {
    expect(customersFromChange(["read_orders"], ["read_orders", "read_customers"], at)).toEqual({ customersFrom: at });
    // write_customers holds read_customers.
    expect(customersFromChange(["read_orders"], ["read_orders", "write_customers"], at)).toEqual({ customersFrom: at });
  });

  it("clears it when read_customers goes: a grant again starts over", () => {
    expect(customersFromChange(["read_orders", "read_customers"], ["read_orders"], at)).toEqual({ customersFrom: null });
    expect(customersFromChange(["read_customers"], [], at)).toEqual({ customersFrom: null });
  });

  it("leaves it alone while read_customers stays, or stays away", () => {
    // Held all along (granted before it was recorded, maybe): the start isn't moved to now.
    expect(customersFromChange(["read_orders", "read_customers"], ["read_orders", "read_customers", "write_pixels"], at)).toEqual({});
    expect(customersFromChange(["read_customers"], ["write_customers"], at)).toEqual({});
    expect(customersFromChange(["read_orders"], ["read_orders", "read_products"], at)).toEqual({});
  });
});

describe("fetchGrantedScopes", () => {
  const ok = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

  it("reads the handles Shopify reports for this installation", async () => {
    const fetchImpl = ok({
      data: { currentAppInstallation: { accessScopes: [{ handle: "read_orders" }, { handle: " read_customers " }] } },
    });
    const scopes = await fetchGrantedScopes({
      shop: "demo-shop.myshopify.com",
      accessToken: "tok",
      apiVersion: "2025-10",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(scopes).toEqual(["read_orders", "read_customers"]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://demo-shop.myshopify.com/admin/api/2025-10/graphql.json");
    expect((init.headers as Record<string, string>)["x-shopify-access-token"]).toBe("tok");
  });

  it("throws rather than reporting an empty grant when there is no installation", async () => {
    // Returning [] here would look exactly like "the merchant granted nothing", which would
    // revoke every module on the dashboard off the back of a bad response.
    const fetchImpl = ok({ data: { currentAppInstallation: null } });
    await expect(
      fetchGrantedScopes({
        shop: "demo-shop.myshopify.com",
        accessToken: "tok",
        apiVersion: "2025-10",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no app installation/i);
  });
});

describe("revocableScopes", () => {
  it("gives nothing back while the app declares no optional scopes", () => {
    // The shipped state. Every scope a store has is then part of the install grant, and Shopify
    // will not take those back — the API refuses with scope_unavailable instead of asking.
    withOptionalScopes("", () => {
      expect(revocableScopes(["read_customers"], ["read_orders", "read_customers"])).toEqual([]);
    });
  });

  it("keeps only scopes that are declared optional and actually granted", () => {
    withOptionalScopes("read_customers,write_pixels", () => {
      // read_orders is required, read_customer_events is not declared, write_pixels was never
      // granted: one scope survives.
      expect(
        revocableScopes(
          ["read_orders", "read_customers", "read_customer_events", "write_pixels"],
          ["read_orders", "read_customers"],
        ),
      ).toEqual(["read_customers"]);
    });
  });

  it("does not treat a granted write_X as a grant of read_X", () => {
    // The opposite of requestableScopes, and deliberately: you can only hand back a handle the
    // store actually granted, and giving up write_pixels is not the same act as giving up
    // read_pixels.
    withOptionalScopes("read_pixels,write_pixels", () => {
      expect(revocableScopes(["read_pixels"], ["write_pixels"])).toEqual([]);
      expect(revocableScopes(["write_pixels"], ["write_pixels"])).toEqual(["write_pixels"]);
    });
  });
});

describe("revokeAccessScopes", () => {
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

  it("sends the scopes to appRevokeAccessScopes and returns what Shopify took back", async () => {
    let body: { query: string; variables: { scopes: string[] } } | undefined;
    const revoked = await withOptionalScopes("read_customers", () =>
      revokeAccessScopes({
        shop: "demo-shop.myshopify.com",
        accessToken: "shpat_x",
        scopes: ["read_customers"],
        apiVersion: "2025-10",
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return ok({ appRevokeAccessScopes: { revoked: [{ handle: "read_customers" }], userErrors: [] } });
        },
      }),
    );
    expect(revoked).toEqual(["read_customers"]);
    expect(body?.variables.scopes).toEqual(["read_customers"]);
    expect(body?.query).toContain("appRevokeAccessScopes");
  });

  it("throws on userErrors, which Shopify returns inside a successful response", async () => {
    // The failure mode worth a test: a refusal arrives as HTTP 200 with no GraphQL error, so a
    // caller that only checked for those would record a revoke that never happened.
    await expect(
      revokeAccessScopes({
        shop: "demo-shop.myshopify.com",
        accessToken: "shpat_x",
        scopes: ["read_orders"],
        apiVersion: "2025-10",
        fetchImpl: async () =>
          ok({ appRevokeAccessScopes: { revoked: [], userErrors: [{ message: "Cannot revoke required scope" }] } }),
      }),
    ).rejects.toThrow(ScopeRevokeError);
  });

  it("refuses to call Shopify with an empty list", async () => {
    await expect(
      revokeAccessScopes({ shop: "demo-shop.myshopify.com", accessToken: "shpat_x", scopes: [], apiVersion: "2025-10" }),
    ).rejects.toThrow();
  });
});
