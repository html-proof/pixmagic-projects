import { describe, expect, it } from "vitest";
import { AUTH_EMAIL_KINDS, authEmail, isAuthEmailTrigger } from "../src/mailer.js";

const base = { code: "482913", email: "merchant@example.test", appUrl: "https://bizinsights.io" };

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

  it("words each one for what it's for, with Cognito's lifetimes", () => {
    expect(authEmail({ ...base, trigger: "CustomEmailSender_SignUp" })!.text).toContain("finish creating your account");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_SignUp" })!.text).toContain("expires in 24 hours");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_ForgotPassword" })!.text).toContain("expires in 1 hour");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_ForgotPassword" })!.text).toContain("your password stays the same");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_UpdateUserAttribute" })!.text).toContain("keeps its current address");
    expect(authEmail({ ...base, trigger: "CustomEmailSender_Authentication" })!.subject).toBe("Your bizinsights sign-in code");
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
