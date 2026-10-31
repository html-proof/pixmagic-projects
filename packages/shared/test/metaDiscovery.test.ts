import { describe, expect, it } from "vitest";
import {
  META_CONNECTION_STATES,
  META_STATE_INFO,
  metaConnectionState,
  metaConnectionStateOf,
  metaDiscoveryAction,
  metaShopifyMarker,
  NOT_AUTHORIZED_FOR_OUR_APP,
  SHOPIFY_SHARES_META_ACCESS,
  type MetaConnectionFacts,
} from "../src/metaDiscovery";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const later = new Date(NOW + 30 * 86_400_000).toISOString();
const earlier = new Date(NOW - 60_000).toISOString();

const conn = (over: Partial<MetaConnectionFacts> = {}): MetaConnectionFacts => ({ status: "active", errorCode: null, enabled: true, accessTokenExpiresAt: later, ...over });

describe("one Meta connection's state", () => {
  it("is authorized while it works, and while it fails for reasons that aren't the sign-in", () => {
    expect(metaConnectionStateOf(conn(), NOW)).toBe("AUTHORIZED_FOR_OUR_APP");
    // A system user's token doesn't end.
    expect(metaConnectionStateOf(conn({ accessTokenExpiresAt: null }), NOW)).toBe("AUTHORIZED_FOR_OUR_APP");
    expect(metaConnectionStateOf(conn({ status: "error", errorCode: "rate_limited" }), NOW)).toBe("AUTHORIZED_FOR_OUR_APP");
    expect(metaConnectionStateOf(conn({ status: "unavailable", errorCode: "account_closed" }), NOW)).toBe("AUTHORIZED_FOR_OUR_APP");
  });

  it("tells a sign-in past its end date from one Meta refused before it", () => {
    expect(metaConnectionStateOf(conn({ status: "reconnect", errorCode: "auth_expired", accessTokenExpiresAt: earlier }), NOW)).toBe("TOKEN_EXPIRED");
    expect(metaConnectionStateOf(conn({ status: "reconnect", errorCode: "auth_expired", accessTokenExpiresAt: later }), NOW)).toBe("REAUTH_REQUIRED");
    expect(metaConnectionStateOf(conn({ status: "reconnect", errorCode: "auth_expired", accessTokenExpiresAt: null }), NOW)).toBe("REAUTH_REQUIRED");
    // Past its date before a sync noticed.
    expect(metaConnectionStateOf(conn({ accessTokenExpiresAt: earlier }), NOW)).toBe("TOKEN_EXPIRED");
  });

  it("needs the sign-in again when the person who gave it left, even past its date", () => {
    expect(metaConnectionStateOf(conn({ status: "reconnect", errorCode: "connector_left", accessTokenExpiresAt: earlier }), NOW)).toBe("REAUTH_REQUIRED");
  });

  it("says a permission is missing when ads_read was taken back or the login lost the account", () => {
    expect(metaConnectionStateOf(conn({ status: "reconnect", errorCode: "scope_missing" }), NOW)).toBe("PERMISSION_MISSING");
    expect(metaConnectionStateOf(conn({ status: "permission", errorCode: "no_access" }), NOW)).toBe("PERMISSION_MISSING");
  });

  it("ignores a code left over from another status", () => {
    // no_access belongs to "permission": on a "reconnect" row it says nothing more.
    expect(metaConnectionStateOf(conn({ status: "reconnect", errorCode: "no_access", accessTokenExpiresAt: later }), NOW)).toBe("REAUTH_REQUIRED");
  });
});

describe("the store's Meta state", () => {
  const facts = (over: Partial<Parameters<typeof metaConnectionState>[0]> = {}) => ({ connections: [], waitingLogin: false, shopifyOrders: 0, ...over });

  it("is not connected with nothing of bizinsights' and no Meta order in Shopify", () => {
    expect(metaConnectionState(facts(), NOW)).toBe("NOT_CONNECTED");
  });

  it("is seen in Shopify, and never authorized, when only Shopify's orders show Meta", () => {
    const state = metaConnectionState(facts({ shopifyOrders: 3 }), NOW);
    expect(state).toBe("CONNECTED_IN_SHOPIFY");
    expect(metaShopifyMarker(state)).toBe(NOT_AUTHORIZED_FOR_OUR_APP);
    expect(NOT_AUTHORIZED_FOR_OUR_APP).toBe("CONNECTED_IN_SHOPIFY_BUT_NOT_AUTHORIZED_FOR_OUR_APP");
    expect(SHOPIFY_SHARES_META_ACCESS).toBe(false);
  });

  it("is authorized by bizinsights' own sign-in, whatever Shopify shows, and carries no marker then", () => {
    expect(metaConnectionState(facts({ connections: [conn()], shopifyOrders: 9 }), NOW)).toBe("AUTHORIZED_FOR_OUR_APP");
    // Signed in, waiting for a first ad account.
    expect(metaConnectionState(facts({ waitingLogin: true, shopifyOrders: 9 }), NOW)).toBe("AUTHORIZED_FOR_OUR_APP");
    expect(metaShopifyMarker("AUTHORIZED_FOR_OUR_APP")).toBeNull();
  });

  it("shows the most pressing state of the accounts on the dashboard", () => {
    const expired = conn({ status: "reconnect", errorCode: "auth_expired", accessTokenExpiresAt: earlier });
    const missing = conn({ status: "permission", errorCode: "no_access" });
    expect(metaConnectionState(facts({ connections: [conn(), missing] }), NOW)).toBe("PERMISSION_MISSING");
    expect(metaConnectionState(facts({ connections: [missing, expired, conn()] }), NOW)).toBe("TOKEN_EXPIRED");
    // A hidden account's trouble doesn't stand for the store while a shown one works.
    expect(metaConnectionState(facts({ connections: [conn(), { ...expired, enabled: false }] }), NOW)).toBe("AUTHORIZED_FOR_OUR_APP");
    // Every account hidden: they all count.
    expect(metaConnectionState(facts({ connections: [{ ...expired, enabled: false }] }), NOW)).toBe("TOKEN_EXPIRED");
  });
});

describe("what the person is offered", () => {
  const can = { manage: true, configured: true, reusable: false };

  it("asks for Meta's sign-in only where Meta requires it", () => {
    expect(metaDiscoveryAction("NOT_CONNECTED", can)).toBe("connect");
    expect(metaDiscoveryAction("CONNECTED_IN_SHOPIFY", can)).toBe("connect");
    expect(metaDiscoveryAction("TOKEN_EXPIRED", can)).toBe("reconnect");
    expect(metaDiscoveryAction("REAUTH_REQUIRED", can)).toBe("reconnect");
    expect(metaDiscoveryAction("PERMISSION_MISSING", can)).toBe("reconnect");
    expect(metaDiscoveryAction("AUTHORIZED_FOR_OUR_APP", can)).toBeNull();
  });

  it("offers the person's own Meta sign-in instead of Meta's screen when there is one", () => {
    expect(metaDiscoveryAction("CONNECTED_IN_SHOPIFY", { ...can, reusable: true })).toBe("reuse");
    expect(metaDiscoveryAction("TOKEN_EXPIRED", { ...can, reusable: true })).toBe("reuse");
    expect(metaDiscoveryAction("AUTHORIZED_FOR_OUR_APP", { ...can, reusable: true })).toBeNull();
  });

  it("offers nothing to someone who may not manage integrations, or where Meta isn't set up", () => {
    expect(metaDiscoveryAction("CONNECTED_IN_SHOPIFY", { ...can, manage: false })).toBeNull();
    expect(metaDiscoveryAction("CONNECTED_IN_SHOPIFY", { ...can, configured: false, reusable: true })).toBeNull();
  });

  it("words every state, and never calls Meta seen in Shopify connected", () => {
    for (const s of META_CONNECTION_STATES) expect(META_STATE_INFO[s].label).toBeTruthy();
    expect(META_STATE_INFO.CONNECTED_IN_SHOPIFY.label).not.toMatch(/connected/i);
  });
});
