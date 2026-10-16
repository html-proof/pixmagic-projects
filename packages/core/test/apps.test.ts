import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appForShop, installTarget, resetShopifyAppsCache, servesAnyShop, shopifyApp, shopifyApps } from "../src/apps.js";
import { resetEnvCache } from "../src/env.js";

const TEST_STORE = "my-test-store.myshopify.com";

/** Rebuild the app registry from a fresh env on every case (both are module-level caches). */
function configure(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  resetEnvCache();
  resetShopifyAppsCache();
}

describe("Shopify app registry: which stores the main app is offered to", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    configure({
      SESSION_SECRET: "0123456789abcdef",
      TOKEN_ENCRYPTION_KEYS: "1:" + "a".repeat(44),
      OTP_PEPPER: "pepper-value",
      SHOPIFY_API_KEY: "client-id",
      SHOPIFY_API_SECRET: "client-secret",
      SHOPIFY_EXTRA_APPS: "",
      SHOPIFY_DEFAULT_APP_SHOPS: "",
    });
  });

  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
    resetShopifyAppsCache();
    vi.restoreAllMocks();
  });

  it("serves any store when no allowlist is configured", () => {
    const main = shopifyApp("default");
    expect(servesAnyShop(main)).toBe(true);
    expect(appForShop("someone-elses-store.myshopify.com")).toBe(main);
  });

  it("serves only the listed stores once an allowlist is configured", () => {
    configure({ SHOPIFY_DEFAULT_APP_SHOPS: TEST_STORE });
    const main = shopifyApp("default");
    expect(servesAnyShop(main)).toBe(false);
    expect(appForShop(TEST_STORE)).toBe(main);
    expect(appForShop("someone-elses-store.myshopify.com")).toBeNull();
  });

  it("accepts the forms an operator actually types: bare handle, URL, mixed case, spaces", () => {
    configure({ SHOPIFY_DEFAULT_APP_SHOPS: " My-Test-Store , https://second-store.myshopify.com/admin " });
    expect(shopifyApps()[0]!.shops).toEqual([TEST_STORE, "second-store.myshopify.com"]);
  });

  it("keeps the valid stores when one entry of several is unreadable", () => {
    configure({ SHOPIFY_DEFAULT_APP_SHOPS: `${TEST_STORE},not a domain` });
    expect(shopifyApps()[0]!.shops).toEqual([TEST_STORE]);
    expect(appForShop(TEST_STORE)).not.toBeNull();
  });

  // The dangerous direction: an empty `shops` means "any store", so a typo in an allowlist
  // that was deliberately set must never read as "no restriction".
  it("fails closed when a configured allowlist yields no valid store", () => {
    configure({ SHOPIFY_DEFAULT_APP_SHOPS: "my-test-store.myshopify.con" });
    const main = shopifyApp("default");
    expect(servesAnyShop(main)).toBe(false);
    expect(appForShop("my-test-store.myshopify.con")).toBeNull();
    expect(appForShop(TEST_STORE)).toBeNull();
    expect(appForShop("someone-elses-store.myshopify.com")).toBeNull();
  });
});

/**
 * A client store is given its own app exactly because the main app may not be installed on it.
 * So when that app is configured but unusable, the store must NOT quietly fall back to the main
 * app: that hands the merchant a Shopify install link their store is refused — the dead-end
 * "This installation link can't be used" page, which Shopify never calls back from.
 *
 * This is not hypothetical. `SHOPIFY_EXTRA_APPS` was added to the app's settings and the app was
 * never redeployed, so in production the setting was absent, the client's store resolved to the
 * unapproved main app, and the merchant hit that page with nothing recorded but one log line.
 */
describe("Shopify app registry: a client store with its own app", () => {
  const CLIENT_STORE = "pixmagic.myshopify.com";
  const saved = { ...process.env };

  const base = {
    SESSION_SECRET: "0123456789abcdef",
    TOKEN_ENCRYPTION_KEYS: "1:" + "a".repeat(44),
    OTP_PEPPER: "pepper-value",
    SHOPIFY_API_KEY: "client-id",
    SHOPIFY_API_SECRET: "client-secret",
    // Empty: the main app claims to serve any store, which is what makes the fallback silent.
    SHOPIFY_DEFAULT_APP_SHOPS: "",
    SHOPIFY_EXTRA_APPS: JSON.stringify([{ key: "pixmagic", clientId: "pixmagic-client-id", shops: [CLIENT_STORE] }]),
  };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.SHOPIFY_APP_SECRET_PIXMAGIC;
    configure(base);
  });

  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
    resetShopifyAppsCache();
    vi.restoreAllMocks();
  });

  it("installs that store through its own app", () => {
    configure({ SHOPIFY_APP_SECRET_PIXMAGIC: "pixmagic-secret" });
    expect(appForShop(CLIENT_STORE)).toMatchObject({ key: "pixmagic", clientId: "pixmagic-client-id" });
    // Everyone else is still the main app's business.
    expect(appForShop("someone-elses-store.myshopify.com")).toBe(shopifyApp("default"));
  });

  it("refuses that store rather than offering the main app when the app's secret is missing", () => {
    expect(shopifyApps().map((a) => a.key)).toEqual(["default"]);
    expect(appForShop(CLIENT_STORE)).toBeNull();
    expect(appForShop("someone-elses-store.myshopify.com")).toBe(shopifyApp("default"));
  });

  it("refuses that store when its app collides with another key", () => {
    configure({
      SHOPIFY_APP_SECRET_PIXMAGIC: "pixmagic-secret",
      SHOPIFY_EXTRA_APPS: JSON.stringify([{ key: "default", clientId: "pixmagic-client-id", shops: [CLIENT_STORE] }]),
    });
    expect(appForShop(CLIENT_STORE)).toBeNull();
  });
});

describe("Shopify app registry: the App Store app new stores are sent to", () => {
  const CLIENT_STORE = "pixmagic.myshopify.com";
  const saved = { ...process.env };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    configure({
      SESSION_SECRET: "0123456789abcdef",
      TOKEN_ENCRYPTION_KEYS: "1:" + "a".repeat(44),
      OTP_PEPPER: "pepper-value",
      SHOPIFY_API_KEY: "client-id",
      SHOPIFY_API_SECRET: "client-secret",
      SHOPIFY_DEFAULT_APP_SHOPS: "",
      SHOPIFY_APP_SECRET_PIXMAGIC: "pixmagic-secret",
      SHOPIFY_APP_SECRET_PUBLIC: "public-secret",
      SHOPIFY_EXTRA_APPS: JSON.stringify([
        { key: "pixmagic", clientId: "pixmagic-client-id", shops: [CLIENT_STORE] },
        { key: "public", clientId: "public-client-id", shops: [] },
      ]),
      SHOPIFY_INSTALL_APP: "default",
    });
  });

  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
    resetShopifyAppsCache();
    vi.restoreAllMocks();
  });

  it("keeps sending new stores to the main app until the App Store app is chosen", () => {
    expect(shopifyApps().map((a) => a.key)).toEqual(["default", "pixmagic", "public"]);
    expect(installTarget().key).toBe("default");
    expect(appForShop("new-store.myshopify.com")?.key).toBe("default");
  });

  it("sends new stores to the App Store app once SHOPIFY_INSTALL_APP names it; a store's own app still wins", () => {
    configure({ SHOPIFY_INSTALL_APP: "public" });
    expect(installTarget()).toMatchObject({ key: "public", clientId: "public-client-id" });
    expect(appForShop("new-store.myshopify.com")?.key).toBe("public");
    expect(appForShop(CLIENT_STORE)?.key).toBe("pixmagic");
  });

  it("falls back to the main app for an unknown key, or an app limited to some stores", () => {
    configure({ SHOPIFY_INSTALL_APP: "nope" });
    expect(installTarget().key).toBe("default");
    configure({ SHOPIFY_INSTALL_APP: "pixmagic" });
    expect(installTarget().key).toBe("default");
  });
});
