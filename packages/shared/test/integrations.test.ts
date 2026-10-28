import { describe, expect, it } from "vitest";
import { AD_ERROR_CODES, AD_ERROR_STATUS, googleReportMetrics, metaReportMetrics } from "../src/ads";
import { CHANNEL_INFO } from "../src/automations";
import { CAPABILITIES } from "../src/capabilities";
import { ACCOUNT_STATUSES } from "../src/email/constants";
import { WA_CONNECTION_STATUSES } from "../src/whatsapp";
import {
  adIntegrationStatus,
  adLoginOf,
  connectionState,
  emailAccountIntegrationStatus,
  emailIntegrationStatus,
  firstSyncOverdue,
  hubCardActions,
  INTEGRATION_MODULE_INFO,
  INTEGRATION_MODULES,
  INTEGRATION_STATUSES,
  orderedActions,
  ownErrorCode,
  platformState,
  shopifyIntegrationStatus,
  smsIntegrationStatus,
  syncRunning,
  whatsappIntegrationStatus,
  worstStatus,
  type AdState,
  type AdStateFacts,
  type PlatformInput,
} from "../src/integrations";

const NOW = Date.parse("2026-10-29T10:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

/** An active account shown on the dashboard, connected two days ago and synced an hour ago. */
const conn = (over: Partial<AdStateFacts> = {}): AdStateFacts => ({
  status: "active",
  errorCode: null,
  enabled: true,
  accountStatus: null,
  lastSyncedAt: ago(60),
  syncRequestedAt: null,
  connectedAt: ago(2 * 24 * 60),
  ...over,
});
const meta = (over: Partial<AdStateFacts> = {}, demo = false) => ({ ...conn(over), provider: "meta" as const, demo });
const answer = (over: Partial<NonNullable<PlatformInput["answer"]>> = {}) => ({ configured: { meta: true, google: true, adsense: true }, ...over });

describe("an ad connection's state", () => {
  it("is connected once a sync has worked", () => {
    expect(connectionState(conn(), NOW)).toBe("connected");
  });

  it("names each reconnect by its code, and a code that isn't the status's own never decides it", () => {
    expect(connectionState(conn({ status: "reconnect", errorCode: "auth_expired" }), NOW)).toBe("reconnect_required");
    expect(connectionState(conn({ status: "reconnect", errorCode: "connector_left" }), NOW)).toBe("authorization_required");
    expect(connectionState(conn({ status: "reconnect", errorCode: "scope_missing" }), NOW)).toBe("permission_missing");
    expect(connectionState(conn({ status: "reconnect", errorCode: null }), NOW)).toBe("reconnect_required");
    // A code left over from an earlier failure (a writer changed only the status).
    expect(ownErrorCode({ status: "reconnect", errorCode: "account_closed" })).toBeNull();
    expect(connectionState(conn({ status: "reconnect", errorCode: "account_closed" }), NOW)).toBe("reconnect_required");
    for (const code of AD_ERROR_CODES) expect(ownErrorCode({ status: AD_ERROR_STATUS[code], errorCode: code })).toBe(code);
  });

  it("says synchronizing while a requested sync is on its way (30 minutes at most), never for a hidden account or one waiting for a reconnect", () => {
    expect(connectionState(conn({ syncRequestedAt: ago(5) }), NOW)).toBe("synchronizing");
    expect(connectionState(conn({ status: "error", errorCode: "temporary", syncRequestedAt: ago(5) }), NOW)).toBe("synchronizing");
    expect(connectionState(conn({ syncRequestedAt: ago(31) }), NOW)).toBe("connected");
    expect(syncRunning({ enabled: false, syncRequestedAt: ago(5) }, NOW)).toBe(false);
    expect(syncRunning({ enabled: true, syncRequestedAt: "not a date" }, NOW)).toBe(false);
    expect(connectionState(conn({ status: "reconnect", errorCode: "auth_expired", syncRequestedAt: ago(5) }), NOW)).toBe("reconnect_required");
  });

  it("waits 30 minutes for a first sync, then calls it failed; a hidden account never synced is simply connected", () => {
    expect(connectionState(conn({ lastSyncedAt: null, connectedAt: ago(10) }), NOW)).toBe("synchronizing");
    expect(firstSyncOverdue(conn({ lastSyncedAt: null, connectedAt: ago(31) }), NOW)).toBe(true);
    expect(connectionState(conn({ lastSyncedAt: null, connectedAt: ago(31) }), NOW)).toBe("sync_failed");
    expect(connectionState(conn({ lastSyncedAt: null, connectedAt: ago(31), enabled: false }), NOW)).toBe("connected");
  });

  it("reads the platform's own account status and the other failures", () => {
    expect(connectionState(conn({ status: "permission", errorCode: "no_access" }), NOW)).toBe("permission_missing");
    expect(connectionState(conn({ status: "unavailable", errorCode: "account_closed" }), NOW)).toBe("disconnected");
    expect(connectionState(conn({ status: "unavailable", errorCode: "account_disabled" }), NOW)).toBe("sync_failed");
    expect(connectionState(conn({ status: "unavailable", errorCode: "account_not_ready" }), NOW)).toBe("verification_pending");
    expect(connectionState(conn({ status: "error", errorCode: "not_approved" }), NOW)).toBe("verification_pending");
    expect(connectionState(conn({ status: "error", errorCode: "rate_limited" }), NOW)).toBe("sync_failed");
    expect(connectionState(conn({ accountStatus: "closed" }), NOW)).toBe("disconnected");
    expect(connectionState(conn({ accountStatus: "disabled" }), NOW)).toBe("sync_failed");
    for (const s of ["under_review", "setup_unfinished", "needs_attention"] as const) expect(connectionState(conn({ accountStatus: s }), NOW)).toBe("verification_pending");
  });
});

describe("a platform's card", () => {
  const input = (connections: PlatformInput["connections"], over: Partial<PlatformInput> = {}): PlatformInput => ({ answer: answer(), failed: false, connections, ...over });

  it("waits for its answer, and never says not connected when the answer failed", () => {
    expect(platformState("meta", { answer: null, failed: false, connections: [] }, NOW).state).toBe("checking");
    expect(platformState("meta", { answer: null, failed: true, connections: [] }, NOW).state).toBe("unknown");
    expect(platformState("meta", input([], { connecting: true }), NOW).state).toBe("connecting");
  });

  it("with nothing connected: not connected, coming soon where the server can't connect it (unless it offers a demo), connected for a sign-in that waits for its accounts", () => {
    expect(platformState("meta", input([]), NOW).state).toBe("not_connected");
    const unset = answer({ configured: { meta: false, google: false, adsense: false } });
    expect(platformState("meta", { ...input([]), answer: unset }, NOW).state).toBe("coming_soon");
    expect(platformState("google", { ...input([]), answer: { ...unset, demo: { google: true } } }, NOW).state).toBe("not_connected");
    expect(platformState("meta", { ...input([]), answer: answer({ logins: [{ provider: "meta" }] }) }, NOW).state).toBe("connected");
    expect(platformState("google", { ...input([]), answer: answer({ logins: [{ provider: "meta" }] }) }, NOW).state).toBe("not_connected");
  });

  it("shows the worst of the accounts on the dashboard, all of them when every one is hidden, and reads as a demo only when every one is", () => {
    const broken = meta({ status: "reconnect", errorCode: "auth_expired", enabled: false });
    expect(platformState("meta", input([meta(), broken]), NOW)).toEqual({ state: "connected", hidden: false, demo: false });
    expect(platformState("meta", input([{ ...meta(), enabled: false }, broken]), NOW)).toEqual({ state: "reconnect_required", hidden: true, demo: false });
    expect(platformState("meta", input([meta({ status: "error", errorCode: "temporary" }), meta({ syncRequestedAt: ago(1) })]), NOW).state).toBe("sync_failed");
    const demo = { ...meta({}, true), provider: "google" as const };
    expect(platformState("google", input([demo]), NOW).demo).toBe(true);
    expect(platformState("google", input([demo, { ...meta(), provider: "google" }]), NOW).demo).toBe(false);
  });

  it("finds the store's waiting sign-in for a platform", () => {
    const login = { provider: "meta" as const, name: "Pat" };
    expect(adLoginOf({ logins: [login] }, "meta")).toBe(login);
    expect(adLoginOf({ logins: [login] }, "google")).toBeNull();
    expect(adLoginOf(null, "meta")).toBeNull();
  });
});

describe("the six statuses", () => {
  it("puts the most pressing first, and nothing at all is disconnected", () => {
    expect(worstStatus(["connected", "syncing", "pending", "error", "reauthorization_required"])).toBe("reauthorization_required");
    expect(worstStatus(["connected", "syncing"])).toBe("syncing");
    expect(worstStatus(["connected", "disconnected"])).toBe("connected");
    expect(worstStatus([])).toBe("disconnected");
  });

  it("maps every ad state onto one of them", () => {
    const expected: Record<AdState, string> = {
      checking: "pending",
      unknown: "error",
      coming_soon: "disconnected",
      not_connected: "disconnected",
      connecting: "pending",
      synchronizing: "syncing",
      connected: "connected",
      authorization_required: "reauthorization_required",
      permission_missing: "reauthorization_required",
      verification_pending: "pending",
      sync_failed: "error",
      reconnect_required: "reauthorization_required",
      disconnected: "disconnected",
    };
    for (const [state, status] of Object.entries(expected)) expect(adIntegrationStatus(state as AdState)).toBe(status);
  });

  it("maps a Shopify store: lost access needs a sign-in, Shopify's own refusals and approvals don't", () => {
    const store = (status: string, problem: string | null = null, hasToken = true) => shopifyIntegrationStatus({ status, hasToken, problem });
    expect(store("active")).toBe("connected");
    expect(store("pending")).toBe("pending");
    expect(store("syncing")).toBe("syncing");
    expect(store("active", null, false)).toBe("reauthorization_required");
    expect(store("error", "access")).toBe("reauthorization_required");
    expect(store("error", "other", false)).toBe("reauthorization_required");
    expect(store("error", "not_approved")).toBe("pending");
    for (const p of ["shop_unavailable", "shop_gone", "shop_locked", "other"]) expect(store("error", p)).toBe("error");
    expect(store("uninstalled", null, false)).toBe("disconnected");
  });

  it("maps every WhatsApp connection status, and one it doesn't know as an error", () => {
    expect(WA_CONNECTION_STATUSES.map((s) => whatsappIntegrationStatus(s))).toEqual(["pending", "connected", "syncing", "reauthorization_required", "error", "disconnected"]);
    expect(whatsappIntegrationStatus(null)).toBe("disconnected");
    expect(whatsappIntegrationStatus("something_new")).toBe("error");
  });

  it("maps the hub's SMS card: a failed check at AWS is an error, the store's setup still to finish is pending", () => {
    expect(smsIntegrationStatus({ state: "connected", problems: [{ code: "test_mode" }] })).toBe("connected");
    expect(smsIntegrationStatus({ state: "needs_attention", problems: [{ code: "connection_failed" }, { code: "no_sender" }] })).toBe("error");
    expect(smsIntegrationStatus({ state: "needs_attention", problems: [{ code: "test_mode" }, { code: "no_budget" }] })).toBe("pending");
    expect(smsIntegrationStatus({ state: "not_connected", problems: [] })).toBe("disconnected");
    expect(smsIntegrationStatus({ state: "unavailable", problems: [{ code: "platform_off" }] })).toBe("disconnected");
  });

  it("maps every email account status, and email as a whole from the hub's card", () => {
    expect(Object.fromEntries(ACCOUNT_STATUSES.map((s) => [s, emailAccountIntegrationStatus(s)]))).toEqual({
      pending: "pending",
      connected: "connected",
      testing: "syncing",
      degraded: "error",
      reauthorization_required: "reauthorization_required",
      disabled: "disconnected",
      revoked: "disconnected",
      failed: "error",
    });
    expect(emailAccountIntegrationStatus("something_new")).toBe("error");
    const card = (state: string, ...codes: string[]) => ({ state, problems: codes.map((code) => ({ code })) });
    expect(emailIntegrationStatus(card("connected", "account_disabled"), ["connected", "disconnected"])).toBe("connected");
    expect(emailIntegrationStatus(card("not_connected"), [])).toBe("disconnected");
    expect(emailIntegrationStatus(card("needs_attention", "reauthorization_required"), ["connected", "reauthorization_required"])).toBe("reauthorization_required");
    // Every mailbox works: the workspace's own step is left, or bizinsights suspended its sending.
    expect(emailIntegrationStatus(card("needs_attention", "no_verified_sender"), ["connected"])).toBe("pending");
    expect(emailIntegrationStatus(card("needs_attention", "suspended"), ["connected"])).toBe("error");
    // Every mailbox switched off or disconnected: nothing sends.
    expect(emailIntegrationStatus(card("needs_attention", "account_disabled"), ["disconnected", "disconnected"])).toBe("disconnected");
  });

  it("is the same six everywhere", () => {
    expect([...INTEGRATION_STATUSES]).toEqual(["connected", "pending", "reauthorization_required", "syncing", "error", "disconnected"]);
  });
});

describe("the modules", () => {
  it("names each one, links its page and lists the figures it brings from the metric sets that exist", () => {
    expect([...INTEGRATION_MODULES]).toEqual(["shopify", "meta_ads", "google_ads", "adsense", "whatsapp", "sms", "email"]);
    expect(INTEGRATION_MODULE_INFO.shopify.capabilities).toEqual(CAPABILITIES.map((c) => c.id));
    expect(INTEGRATION_MODULE_INFO.meta_ads.capabilities).toEqual(Object.keys(metaReportMetrics({})));
    expect(INTEGRATION_MODULE_INFO.meta_ads.capabilities).toContain("purchaseValue");
    expect(INTEGRATION_MODULE_INFO.google_ads.capabilities).toEqual(Object.keys(googleReportMetrics({})));
    expect(INTEGRATION_MODULE_INFO.adsense.capabilities).toEqual(["earnings", "pageViews", "impressions", "clicks", "pageRpm", "perClick", "ctr"]);
    expect(INTEGRATION_MODULE_INFO.whatsapp.capabilities).toEqual(["sent", "delivered", "read", "failed"]);
    // The messaging channels' pages are their homes in the hub.
    expect(INTEGRATION_MODULE_INFO.whatsapp.href).toBe(CHANNEL_INFO.whatsapp.home);
    expect(INTEGRATION_MODULE_INFO.sms.href).toBe(CHANNEL_INFO.sms.home);
    expect(INTEGRATION_MODULE_INFO.email.href).toBe(CHANNEL_INFO.email.home);
  });

  it("orders actions one way, and reads the hub's test as a refresh", () => {
    expect(orderedActions(["disconnect", "connect", "refresh", "connect"])).toEqual(["connect", "refresh", "disconnect"]);
    expect(hubCardActions(["connect", "test", "reconnect", "disconnect"])).toEqual(["connect", "reconnect", "refresh", "disconnect"]);
    expect(hubCardActions(["test", "something_else"])).toEqual(["refresh"]);
    expect(hubCardActions([])).toEqual([]);
  });
});
