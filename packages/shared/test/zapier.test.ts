import { describe, expect, it } from "vitest";
import { ALERT_PATH, describeAlert, mayFixAlert } from "../src/alerts.js";
import {
  deliveryOutcome,
  integrationOfProvider,
  isZapierHookUrl,
  periodKey,
  periodRange,
  singleCurrencyTotal,
  thresholdReached,
  ZAPIER_EVENT_INFO,
  ZAPIER_EVENTS,
  ZAPIER_INTEGRATIONS,
  ZAPIER_SCHEMA_VERSION,
  zapierBackoffSeconds,
} from "../src/zapier.js";

describe("Zapier thresholds", () => {
  it("puts a day in its period: the day, or its month", () => {
    expect(periodKey("2026-10-28", "day")).toBe("2026-10-28");
    expect(periodKey("2026-10-28", "month")).toBe("2026-10");
  });

  it("spans a period from its first to its last day, leap years included", () => {
    expect(periodRange("2026-10-28")).toEqual({ since: "2026-10-28", until: "2026-10-28" });
    expect(periodRange("2026-10")).toEqual({ since: "2026-10-01", until: "2026-10-31" });
    expect(periodRange("2026-02")).toEqual({ since: "2026-02-01", until: "2026-02-28" });
    expect(periodRange("2028-02")).toEqual({ since: "2028-02-01", until: "2028-02-29" });
    expect(periodRange("2026-12")).toEqual({ since: "2026-12-01", until: "2026-12-31" });
  });

  it("adds up amounts of one currency, to the cent, and never two currencies", () => {
    expect(singleCurrencyTotal([{ currency: "AUD", amount: 0.1 }, { currency: "AUD", amount: 0.2 }])).toEqual({ total: 0.3, currency: "AUD" });
    // An account whose currency isn't known yet doesn't make a second currency.
    expect(singleCurrencyTotal([{ currency: "AUD", amount: 10 }, { currency: null, amount: 5 }])).toEqual({ total: 15, currency: "AUD" });
    expect(singleCurrencyTotal([{ currency: "USD", amount: 10 }, { currency: "AUD", amount: 5 }])).toEqual({ mixed: ["AUD", "USD"] });
    expect(singleCurrencyTotal([])).toEqual({ total: 0, currency: null });
  });

  it("is reached at the amount, not only above it", () => {
    expect(thresholdReached(499.99, 500)).toBe(false);
    expect(thresholdReached(500, 500)).toBe(true);
    expect(thresholdReached(500.01, 500)).toBe(true);
    expect(thresholdReached(500, 500, "above")).toBe(true);
  });

  it("falls below only under the amount: ending a period at the amount is not below it", () => {
    expect(thresholdReached(19.99, 20, "below")).toBe(true);
    expect(thresholdReached(0, 20, "below")).toBe(true);
    expect(thresholdReached(20, 20, "below")).toBe(false);
    expect(thresholdReached(25, 20, "below")).toBe(false);
  });
});

describe("where Zapier may ask bizinsights to send events", () => {
  it("is Zapier's own hook host over https, and nothing else", () => {
    expect(isZapierHookUrl("https://hooks.zapier.com/hooks/standard/123/abc/")).toBe(true);
    expect(isZapierHookUrl("https://hooks.zapier.com/hooks/catch/1/x")).toBe(true);
    for (const bad of [
      "http://hooks.zapier.com/hooks/standard/123/abc/",
      "https://hooks.zapier.com.attacker.example/hooks/x",
      "https://attacker.example/?u=https://hooks.zapier.com/hooks/x",
      "https://zapier.com/hooks/standard/1/a",
      "https://hooks.zapier.com:444/hooks/x",
      "https://a:b@hooks.zapier.com/hooks/x",
      "https://hooks.zapier.com/",
      "https://10.0.0.1/hooks/x",
      "not a url",
      "",
    ]) {
      expect(isZapierHookUrl(bad), bad).toBe(false);
    }
  });
});

describe("Zapier deliveries", () => {
  it("back off exponentially from 30 seconds to at most an hour, give or take a fifth", () => {
    expect(zapierBackoffSeconds(1, () => 0.5)).toBe(30);
    expect(zapierBackoffSeconds(2, () => 0.5)).toBe(60);
    expect(zapierBackoffSeconds(4, () => 0.5)).toBe(240);
    expect(zapierBackoffSeconds(20, () => 0.5)).toBe(3600);
    expect(zapierBackoffSeconds(1, () => 0)).toBe(24);
    expect(zapierBackoffSeconds(1, () => 0.9999)).toBe(36);
  });

  it("word each outcome, with the reason and Zapier's status where there is one", () => {
    expect(deliveryOutcome({ status: "delivered", errorCode: null, responseStatus: 200 })).toEqual({ label: "Delivered", tone: "good", reason: null });
    expect(deliveryOutcome({ status: "retrying", errorCode: "server_error", responseStatus: 502 })).toEqual({ label: "Retrying", tone: "warn", reason: "Zapier had a problem receiving it (HTTP 502)" });
    expect(deliveryOutcome({ status: "failed", errorCode: "authorizer_no_access", responseStatus: null }).reason).toBe("The person who connected Zapier no longer has access to this");
    expect(deliveryOutcome({ status: "failed", errorCode: null, responseStatus: null }).reason).toBe("Not delivered after several tries");
    expect(deliveryOutcome({ status: "cancelled", errorCode: "hook_gone", responseStatus: 410 })).toMatchObject({ label: "Not sent", tone: "neutral" });
  });

  it("names a permission for every trigger but alerts, which follow the bell", () => {
    for (const e of ZAPIER_EVENTS) expect(ZAPIER_EVENT_INFO[e].label.length, e).toBeGreaterThan(3);
    expect(ZAPIER_EVENT_INFO.alert_raised.needs).toBeNull();
    expect(ZAPIER_EVENT_INFO.ad_spend_threshold.needs).toBe("marketing.ads");
    expect(ZAPIER_EVENT_INFO.whatsapp_message_failed.needs).toBe("marketing.campaigns");
    // The connection's own state, which anyone who may connect Zapier sees; sales need their own permission.
    expect(ZAPIER_EVENT_INFO.integration_connected.needs).toBe("integrations.status");
    expect(ZAPIER_EVENT_INFO.integration_disconnected.needs).toBe("integrations.status");
    expect(ZAPIER_EVENT_INFO.sync_completed.needs).toBe("integrations.status");
    expect(ZAPIER_EVENT_INFO.order_paid.needs).toBe("analytics.sales");
    expect(Object.keys(ZAPIER_EVENT_INFO).sort()).toEqual([...ZAPIER_EVENTS].sort());
  });

  it("puts the payload's version in every envelope: 1 until a change would break a Zap", () => {
    expect(ZAPIER_SCHEMA_VERSION).toBe(1);
  });

  it("names the integrations by the ad platforms' providers", () => {
    expect(integrationOfProvider("meta")).toBe("meta_ads");
    expect(integrationOfProvider("google")).toBe("google_ads");
    expect(integrationOfProvider("adsense")).toBe("adsense");
    expect(integrationOfProvider("tiktok")).toBeNull();
    expect(ZAPIER_INTEGRATIONS.adsense).toBe("Google AdSense");
  });

  it("words an event Zapier never took for owners and admins, with the page that has Retry", () => {
    const w = describeAlert({ code: "zapier_delivery_failed", severity: "warning", message: "zapier delivery d1 failed: rejected" });
    expect(w).toMatchObject({ severity: "warning", area: "integrations", title: "Some events didn't reach Zapier" });
    // The internal message (ids, error codes) never shows.
    expect(w.body).not.toContain("d1");
    expect(w.body).toMatch(/Retry/);
    expect(ALERT_PATH.integrations).toBe("/settings/integrations");
    expect(mayFixAlert("integrations", { role: "admin", permissions: [] }, null)).toBe(true);
    expect(mayFixAlert("integrations", { role: "manager", permissions: ["integrations.status", "integrations.manage"] }, null)).toBe(false);
  });
});

describe("who may see an alert (the bell's rule, which Zapier follows)", () => {
  it("gives owners and admins every area, and others only what their permissions open", () => {
    const owner = { role: "owner" as const, permissions: [] };
    const integrations = { role: "manager" as const, permissions: ["integrations.status", "integrations.manage"] };
    for (const area of ["shopify", "ads", "email", "whatsapp", "privacy", "general", "staff"] as const) expect(mayFixAlert(area, owner, null), area).toBe(true);
    expect(mayFixAlert("ads", integrations, null)).toBe(true);
    expect(mayFixAlert("email", integrations, null)).toBe(true);
    expect(mayFixAlert("shopify", integrations, null)).toBe(false);
    expect(mayFixAlert("whatsapp", integrations, null)).toBe(false);
    expect(mayFixAlert("whatsapp", { role: "manager", permissions: ["marketing.campaigns"] }, null)).toBe(true);
    expect(mayFixAlert("staff", integrations, "supervisor")).toBe(true);
    expect(mayFixAlert("staff", integrations, null)).toBe(false);
  });
});
