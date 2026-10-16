import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertEmail, resetEnvCache } from "../src/index.js";

const LEAK = "connect ECONNREFUSED 10.0.3.7:5432 (prisma P1001)";
const alert = (code: string, message = LEAK, severity = "critical") => ({ id: "al_1", code, severity, message });

const saved = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "unit-session-secret-123456",
    OTP_PEPPER: "unit-pepper",
    TOKEN_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 1).toString("base64")}`,
    APP_URL: "https://app.test",
  });
  resetEnvCache();
});
afterAll(() => {
  process.env = saved;
  resetEnvCache();
});

describe("alertEmail", () => {
  it("words a sync failure like the bell, links to where it's fixed, and leaves the error's text out", () => {
    const mail = alertEmail(alert("sync_orders_failed", `We couldn't sync orders for a.myshopify.com: ${LEAK}`), { workspace: "Acme", store: "Acme Store" });
    expect(mail.subject).toBe("Couldn't sync your orders");
    expect(mail.text).toContain("Reconnect it in Settings → Shopify");
    expect(mail.text).toContain("Store: Acme Store · Workspace: Acme");
    expect(mail.text).toContain("Open bizinsights: https://app.test/settings/stores");
    expect(mail.text).toContain("an owner or admin of Acme");
    expect(mail.text).toContain("https://app.test/settings/notifications");
    expect(mail.html).toContain('href="https://app.test/settings/stores"');
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toContain("ECONNREFUSED");
      expect(part).not.toContain("sync_orders_failed");
    }
  });

  it("links each area to its page, and an unknown code to support", () => {
    expect(alertEmail(alert("webhook_failed"), { workspace: null, store: null }).text).toContain("https://app.test/settings/stores");
    expect(alertEmail(alert("email_account_reauth:acc1", "Reconnect shop@acme.test."), { workspace: null, store: null }).text).toContain(
      "https://app.test/settings/email/accounts",
    );
    expect(alertEmail(alert("staff_open_shifts", "2 shifts have been open"), { workspace: null, store: null }).text).toContain("https://app.test/staff/timesheets");
    const unknown = alertEmail(alert("brand_new_code"), { workspace: null, store: null });
    expect(unknown.subject).toBe("Something needs your attention");
    expect(unknown.text).toContain("Get help: https://app.test/support");
    expect(unknown.text).not.toContain("ECONNREFUSED");
  });

  it("passes on the messages the app composes itself", () => {
    const body = "The email account shop@acme.test must be reconnected before it can send again (Settings → Email → Accounts).";
    expect(alertEmail(alert("email_account_reauth:acc1", body, "warning"), { workspace: "Acme", store: null }).text).toContain(body);
  });

  it("escapes the merchant's names in the HTML", () => {
    const mail = alertEmail(alert("sync_shop_failed"), { workspace: "<b>Acme</b>", store: 'Tom & "Jerry"' });
    expect(mail.html).not.toContain("<b>Acme</b>");
    expect(mail.html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(mail.html).toContain("Tom &amp; &quot;Jerry&quot;");
    // The plain-text part is text: it keeps them as written.
    expect(mail.text).toContain('Store: Tom & "Jerry" · Workspace: <b>Acme</b>');
  });

  it("speaks to a workspace owner or admin when the workspace's name is unknown", () => {
    const mail = alertEmail(alert("sync_shop_failed"), { workspace: null, store: null });
    expect(mail.text).toContain("as a workspace owner or admin.");
    expect(mail.text).not.toContain("Store:");
  });
});
