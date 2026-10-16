import { describe, expect, it } from "vitest";
import { ALERT_PATH, describeAlert } from "../src/alerts.js";

const LEAK = "connect ECONNREFUSED 10.0.3.7:5432 (prisma P1001)";

describe("describeAlert", () => {
  it.each([
    ["sync_orders_failed", "We couldn't sync orders for a.myshopify.com: " + LEAK],
    ["sync_products_stalled", "Syncing products stopped: " + LEAK],
    ["sync_install_pixel_failed", "We couldn't sync install_pixel: " + LEAK],
    ["sync_somethingnew_failed", LEAK],
    ["webhook_failed", "Processing orders/create failed: " + LEAK],
    ["brand_new_code", LEAK],
  ])("never repeats the stored message of %s", (code, message) => {
    const w = describeAlert({ code, severity: "critical", message });
    expect(`${w.title} ${w.body}`).not.toContain("ECONNREFUSED");
    expect(w.title).not.toBe("");
    expect(w.body).not.toBe("");
  });

  it("words syncs by kind and outcome, and sends the merchant to Settings → Shopify", () => {
    expect(describeAlert({ code: "sync_orders_failed", severity: "critical", message: LEAK })).toEqual({
      severity: "critical",
      area: "shopify",
      title: "Couldn't sync your orders",
      body: expect.stringContaining("Reconnect it in Settings → Shopify"),
    });
    const warning = describeAlert({ code: "sync_orders_failed", severity: "warning", message: LEAK });
    expect(warning.body).toContain("next scheduled sync");
    expect(describeAlert({ code: "sync_variants_stalled", severity: "warning", message: "" }).title).toBe("Syncing your product variants didn't finish");
    expect(describeAlert({ code: "sync_install_pixel_failed", severity: "warning", message: "" }).title).toBe("Visitor tracking isn't set up");
  });

  it("passes on the messages the app composes itself", () => {
    const reauth = "The email account shop@acme.test must be reconnected before it can send again (Settings → Email → Accounts).";
    expect(describeAlert({ code: "email_account_reauth:acc1", severity: "warning", message: reauth })).toEqual({ severity: "warning", area: "email", title: "An email account needs reconnecting", body: reauth });
    expect(describeAlert({ code: "email_sender_rejected:snd1", severity: "warning", message: "x" }).area).toBe("email");
    expect(describeAlert({ code: "staff_open_shifts", severity: "warning", message: "2 shifts have been open" })).toMatchObject({ area: "staff", body: "2 shifts have been open" });
    expect(describeAlert({ code: "wa_rule_r1", severity: "info", message: "VIP order (order #1001)" })).toMatchObject({ area: "whatsapp", severity: "info", body: "VIP order (order #1001)" });
  });

  it("links every area to an app page", () => {
    for (const path of Object.values(ALERT_PATH)) expect(path).toMatch(/^\/[a-z]/);
    expect(ALERT_PATH[describeAlert({ code: "sync_orders_failed", severity: "critical", message: "" }).area]).toBe("/settings/stores");
  });

  it("treats an unknown severity as a warning", () => {
    expect(describeAlert({ code: "webhook_failed", severity: "urgent", message: "" }).severity).toBe("warning");
  });
});
