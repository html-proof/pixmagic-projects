import { describe, expect, it } from "vitest";
import { EMAIL_CODE_TTL_S } from "@app/shared/auth";
import { AUTH_EMAIL_KINDS, authEmail, EMAIL_PURPOSES, isAuthEmailTrigger, type SenderSettings } from "../src/mailer.js";

const base = { code: "482913", email: "merchant@example.test", appUrl: "https://bizinsights.io" };
const senders: SenderSettings = {
  EMAIL_FROM: "bizinsights <no-reply@bizinsights.io>",
  OTP_FROM_EMAIL: "support@bizinsights.io",
  OTP_FROM_NAME: "BizInsights Support",
  LINK_FROM_EMAIL: "link@bizinsights.io",
  LINK_FROM_NAME: "BizInsights",
  SUPPORT_EMAIL: "support@bizinsights.io",
};

describe("who sends them, and how they sign off", () => {
  it("names a purpose the support sender sends, for every trigger", () => {
    const purposes = Object.keys(AUTH_EMAIL_KINDS).map((trigger) => authEmail({ ...base, trigger })!.purpose);
    expect(purposes).toEqual(["signup_code", "signup_code", "password_reset_code", "verification_code", "verification_code", "login_code", "temporary_password"]);
    for (const p of purposes) expect(EMAIL_PURPOSES[p], p).toBe("support");
  });

  it("signs off as BizInsights Support with its address, and adds a support line only for another address", () => {
    const m = authEmail({ ...base, trigger: "CustomEmailSender_Authentication", senders })!;
    expect(m.text).toMatch(/Regards,\nBizInsights Support\nsupport@bizinsights\.io$/);
    expect(m.text).not.toContain("Questions?");
    expect(m.html).toContain('Regards,<br>BizInsights Support<br><a href="mailto:support@bizinsights.io"');
    const other = authEmail({ ...base, trigger: "CustomEmailSender_ForgotPassword", senders: { ...senders, SUPPORT_EMAIL: "help@bizinsights.io" } })!;
    expect(other.text).toContain("Questions? Contact help@bizinsights.io.");
    expect(other.html).toContain('<a href="mailto:help@bizinsights.io"');
  });
});

describe("copying the code from the email", () => {
  it("puts the code alone on its line, says how to copy it, and lets a tap select it whole", () => {
    for (const trigger of ["CustomEmailSender_SignUp", "CustomEmailSender_Authentication", "CustomEmailSender_ForgotPassword", "CustomEmailSender_VerifyUserAttribute"]) {
      const m = authEmail({ ...base, trigger })!;
      expect(m.text.split("\n"), trigger).toContain("    482913");
      expect(m.text, trigger).toContain("To copy the code, double-click it, or press and hold it on a phone.");
      expect(m.html, trigger).toMatch(/aria-label="Verification code" style="[^"]*user-select:all[^"]*">482913</);
    }
    // No link carries the code: the only links are the sign-in page and the support address.
    const html = authEmail({ ...base, trigger: "CustomEmailSender_Authentication", senders })!.html;
    for (const href of html.match(/href="[^"]*"/g) ?? []) expect(href).not.toContain("482913");
  });

  it("gives a temporary password its own box, without the code's hint", () => {
    const m = authEmail({ ...base, trigger: "CustomEmailSender_AdminCreateUser", code: "Tmp-9x!" })!;
    expect(m.text).not.toContain("To copy the code");
    expect(m.html).toContain('aria-label="Temporary password"');
  });
});

describe("Cognito's emails, as bizinsights sends them", () => {
  it("has a message for every trigger the user pool sends email for", () => {
    expect(Object.keys(AUTH_EMAIL_KINDS).sort()).toEqual([
      "CustomEmailSender_AdminCreateUser",
      "CustomEmailSender_Authentication",
      "CustomEmailSender_ForgotPassword",
      "CustomEmailSender_ResendCode",
      "CustomEmailSender_SignUp",
      "CustomEmailSender_UpdateUserAttribute",
      "CustomEmailSender_VerifyUserAttribute",
    ]);
    for (const trigger of Object.keys(AUTH_EMAIL_KINDS)) {
      const m = authEmail({ ...base, trigger })!;
      expect(m.subject, trigger).toMatch(/bizinsights/);
      expect(m.text, trigger).toContain("482913");
      expect(m.html, trigger).toContain("482913");
      expect(m.html, trigger).toMatch(/^<!doctype html>/);
      expect(m.text, trigger).toMatch(/bizinsights Team$/);
    }
  });

  it("keeps the code out of the subject and the preview line (shown on locked screens)", () => {
    for (const trigger of Object.keys(AUTH_EMAIL_KINDS)) {
      const m = authEmail({ ...base, trigger })!;
      expect(m.subject).not.toContain("482913");
      const preview = /<div style="display:none[^>]*>([^<]*)<\/div>/.exec(m.html)![1]!;
      expect(preview).not.toContain("482913");
    }
  });

  it("words each one for what it's for, with each code's lifetime", () => {
    expect(authEmail({ ...base, trigger: "CustomEmailSender_SignUp" })!.text).toContain("Use the verification code below to finish creating your bizinsights account.");
    // The API's own minute (apps/api/src/emailCode.ts reads the same constant).
    expect(EMAIL_CODE_TTL_S).toBe(60);
    expect(authEmail({ ...base, trigger: "CustomEmailSender_SignUp" })!.text).toContain("This code expires in 60 seconds.");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_ResendCode" })!.text).toContain("This code expires in 60 seconds.");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_Authentication" })!.text).toContain("This code expires in 60 seconds and works once.");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_VerifyUserAttribute" })!.text).toContain("expires in 24 hours");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_ForgotPassword" })!.text).toContain("expires in 1 hour");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_ForgotPassword" })!.text).toContain("your password stays the same");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_UpdateUserAttribute" })!.text).toContain("keeps its current address");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_Authentication" })!.subject).toBe("Your bizinsights verification code");
    const invite = authEmail({ ...base, trigger: "CustomEmailSender_AdminCreateUser", code: "Tmp-9x!" })!;
    expect(invite.text).toContain("Email: merchant@example.test");
    expect(invite.text).toContain("Temporary password: Tmp-9x!");
    expect(invite.text).toContain("expires in 7 days");
    expect(invite.html).toContain('href="https://bizinsights.io/login"');
  });

  it("greets by name, escaped, on one line", () => {
    expect(authEmail({ ...base, trigger: "CustomEmailSender_SignUp", name: "Alex" })!.text).toMatch(/^Hello Alex,/);
    expect(authEmail({ ...base, trigger: "CustomEmailSender_SignUp", name: "  " })!.text).toMatch(/^Hello,/);
    const m = authEmail({ ...base, trigger: "CustomEmailSender_SignUp", name: "<b>Eve</b>\r\nBcc: x@y.z" })!;
    expect(m.text).toMatch(/^Hello <b>Eve<\/b> Bcc: x@y.z,\n/);
    expect(m.html).toContain("Hello &lt;b&gt;Eve&lt;/b&gt; Bcc: x@y.z,");
    expect(m.html).not.toContain("<b>Eve");
  });

  it("escapes a temporary password in the HTML part", () => {
    const m = authEmail({ ...base, trigger: "CustomEmailSender_AdminCreateUser", code: `a<b>&"'` })!;
    expect(m.html).toContain("a&lt;b&gt;&amp;&quot;&#39;");
    expect(m.text).toContain(`Temporary password: a<b>&"'`);
  });

  it("sends nothing for a trigger it doesn't know (account-takeover notices need the Plus plan)", () => {
    expect(isAuthEmailTrigger("CustomEmailSender_AccountTakeOverNotification")).toBe(false);
    expect(isAuthEmailTrigger("toString")).toBe(false);
    expect(authEmail({ ...base, trigger: "CustomEmailSender_AccountTakeOverNotification" })).toBeNull();
  });
});
