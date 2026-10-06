import { afterEach, describe, expect, it, vi } from "vitest";
import {
  declaredOptionalScopes,
  fetchGrantedScopes,
  optionalScopeGrantUrl,
  requestableScopes,
  resetEnvCache,
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
  Object.assign(process.env, BASE_ENV, { SHOPIFY_OPTIONAL_SCOPES: value });
  resetEnvCache();
  return fn();
}

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
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
