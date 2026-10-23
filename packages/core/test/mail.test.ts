import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "../src/env.js";
import { classifyMailError, EMAIL_PURPOSES, fromHeader, MailError, parseResendEvent, resendMailer, senderFor, signatureFor, verifyResendWebhook, withoutAddresses, type EmailPurpose, type SenderSettings } from "../src/mail/index.js";
import { memoryMailer, mailpitMailer } from "../src/notify.js";
import type { FetchLike } from "../src/shopify.js";

const saved = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "unit-session-secret-123456",
    OTP_PEPPER: "unit-pepper",
    TOKEN_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 1).toString("base64")}`,
    EMAIL_FROM: "bizinsights <invitations@bizinsights.io>",
    OTP_FROM_EMAIL: "support@bizinsights.io",
    OTP_FROM_NAME: "BizInsights Support",
    LINK_FROM_EMAIL: "link@bizinsights.io",
    LINK_FROM_NAME: "BizInsights",
    SUPPORT_EMAIL: "support@bizinsights.io",
  });
  resetEnvCache();
});
afterAll(() => {
  process.env = saved;
  resetEnvCache();
});

/** A fetch that answers one canned response and records the request. */
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { f, calls };
}

describe("Resend mailer", () => {
  it("sends one message to one recipient, with the reply-to, both parts and the idempotency key, and returns Resend's id", async () => {
    const { f, calls } = fakeFetch(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    const r = await resendMailer({ apiKey: "re_test_key", fetchImpl: f }).send("someone@gmail.com", "Subject", "Text", "<p>Html</p>", { replyTo: "owner@acme.test", idempotencyKey: "delivery-abc" });
    expect(r).toEqual({ provider: "resend", messageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer re_test_key");
    expect(h["idempotency-key"]).toBe("delivery-abc");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: "bizinsights <invitations@bizinsights.io>", to: ["someone@gmail.com"], subject: "Subject", text: "Text", html: "<p>Html</p>", reply_to: "owner@acme.test" });
  });

  it("tells a busy provider (retry) from an account that can't send yet (fix the setup) from a bad message, without repeating the address", async () => {
    const cases: Array<[number, unknown, string]> = [
      [429, { name: "rate_limit_exceeded", message: "Too many requests" }, "transient"],
      [429, { name: "daily_quota_exceeded", message: "quota" }, "transient"],
      [500, { name: "application_error", message: "oops" }, "transient"],
      [503, { name: "service_unavailable", message: "down" }, "transient"],
      [403, { name: "validation_error", message: "You can only send testing emails to your own email address (me@x.com)." }, "not_allowed"],
      [403, { name: "validation_error", message: "The bizinsights.io domain is not verified." }, "not_allowed"],
      [401, { name: "validation_error", message: "API key is invalid" }, "not_allowed"],
      [422, { name: "validation_error", message: "Invalid `to` field: bad@@x" }, "permanent"],
    ];
    for (const [status, body, failure] of cases) {
      const { f } = fakeFetch(status, body, status === 429 ? { "retry-after": "30" } : {});
      const err = await resendMailer({ apiKey: "k", fetchImpl: f })
        .send("bad@@x", "s", "t")
        .catch((e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(MailError);
      expect((err as MailError).failure, JSON.stringify(body)).toBe(failure);
      expect((err as MailError).message).not.toContain("me@x.com");
      if (status === 429) expect((err as MailError).retryAfterSec).toBe(30);
    }
    const down = resendMailer({ apiKey: "k", fetchImpl: async () => Promise.reject(new Error("ECONNRESET")) });
    expect(await down.send("a@b.co", "s", "t").catch((e: MailError) => e.failure)).toBe("transient");
  });
});

describe("who each email comes from", () => {
  const settings: SenderSettings = {
    EMAIL_FROM: "bizinsights <no-reply@bizinsights.io>",
    OTP_FROM_EMAIL: "support@bizinsights.io",
    OTP_FROM_NAME: "BizInsights Support",
    LINK_FROM_EMAIL: "link@bizinsights.io",
    LINK_FROM_NAME: "BizInsights",
    SUPPORT_EMAIL: "support@bizinsights.io",
  };

  it("sends every code from support@, every shared link from link@, and the rest from EMAIL_FROM", () => {
    const expected: Record<EmailPurpose, string> = {
      signup_code: "BizInsights Support <support@bizinsights.io>",
      login_code: "BizInsights Support <support@bizinsights.io>",
      verification_code: "BizInsights Support <support@bizinsights.io>",
      password_reset_code: "BizInsights Support <support@bizinsights.io>",
      temporary_password: "BizInsights Support <support@bizinsights.io>",
      team_invitation: "BizInsights <link@bizinsights.io>",
      staff_invitation: "BizInsights <link@bizinsights.io>",
      notice: "bizinsights <no-reply@bizinsights.io>",
    };
    expect(Object.keys(EMAIL_PURPOSES).sort()).toEqual(Object.keys(expected).sort());
    for (const [purpose, from] of Object.entries(expected)) expect(fromHeader(purpose as EmailPurpose, settings), purpose).toBe(from);
    expect(fromHeader(undefined, settings)).toBe("bizinsights <no-reply@bizinsights.io>");
  });

  it("never sends from an address the configuration doesn't name: anything that isn't a purpose of ours gets EMAIL_FROM", () => {
    for (const p of ["support@evil.test", "Evil <x@evil.test>", "toString", "__proto__", ""]) expect(fromHeader(p as EmailPurpose, settings), p).toBe("bizinsights <no-reply@bizinsights.io>");
  });

  it("falls back to EMAIL_FROM for an identity left unset, keeping EMAIL_FROM's name when the identity has none", () => {
    const bare = { ...settings, OTP_FROM_EMAIL: "", LINK_FROM_NAME: "" };
    expect(fromHeader("login_code", bare)).toBe("bizinsights <no-reply@bizinsights.io>");
    expect(fromHeader("team_invitation", bare)).toBe("bizinsights <link@bizinsights.io>");
    expect(senderFor("notice", { ...bare, EMAIL_FROM: "no-reply@bizinsights.io" })).toEqual({ name: null, email: "no-reply@bizinsights.io" });
    expect(fromHeader("notice", { ...bare, EMAIL_FROM: "no-reply@bizinsights.io" })).toBe("no-reply@bizinsights.io");
  });

  it("signs off as the sender, with the support address", () => {
    expect(signatureFor("login_code", settings)).toEqual({ name: "BizInsights Support", email: "support@bizinsights.io", support: "support@bizinsights.io" });
    expect(signatureFor("team_invitation", settings)).toEqual({ name: "BizInsights", email: "link@bizinsights.io", support: "support@bizinsights.io" });
    expect(signatureFor("team_invitation", { ...settings, SUPPORT_EMAIL: "" }).support).toBeNull();
    // Unset, the email signs as before, never showing EMAIL_FROM's no-reply address.
    expect(signatureFor("login_code", { ...settings, OTP_FROM_EMAIL: "" })).toEqual({ name: "bizinsights Team", email: null, support: "support@bizinsights.io" });
    expect(signatureFor("notice", settings)).toEqual({ name: "bizinsights Team", email: null, support: "support@bizinsights.io" });
  });

  it("takes the From address from the purpose in every provider: Resend, Mailpit, and the tests' own", async () => {
    const resend = fakeFetch(200, { id: "r1" });
    await resendMailer({ apiKey: "k", fetchImpl: resend.f }).send("a@b.co", "s", "t", undefined, { purpose: "signup_code" });
    await resendMailer({ apiKey: "k", fetchImpl: resend.f }).send("a@b.co", "s", "t", undefined, { purpose: "staff_invitation" });
    expect(resend.calls.map((c) => JSON.parse(String(c.init.body)).from)).toEqual(["BizInsights Support <support@bizinsights.io>", "BizInsights <link@bizinsights.io>"]);

    const mailpit = fakeFetch(200, { ID: "m1" });
    await mailpitMailer("http://mailpit.test", mailpit.f).send("a@b.co", "s", "t", undefined, { purpose: "password_reset_code" });
    expect(JSON.parse(String(mailpit.calls[0]!.init.body)).From).toEqual({ Email: "support@bizinsights.io", Name: "BizInsights Support" });

    const memory = memoryMailer();
    await memory.send("a@b.co", "s", "t", undefined, { purpose: "team_invitation" });
    await memory.send("a@b.co", "s", "t");
    expect(memory.sent.map((m) => m.from)).toEqual(["BizInsights <link@bizinsights.io>", "bizinsights <invitations@bizinsights.io>"]);
  });

  it("refuses a sender setting that isn't an address, or a name that would break the From header", async () => {
    const { env } = await import("../src/env.js");
    for (const [name, value] of [
      ["OTP_FROM_EMAIL", "support"],
      ["LINK_FROM_EMAIL", "link@"],
      ["SUPPORT_EMAIL", "help desk"],
      ["OTP_FROM_NAME", "Support <evil@x.test>"],
      ["LINK_FROM_NAME", "BizInsights\r\nBcc: x@y.z"],
    ] as const) {
      const before = process.env[name];
      process.env[name] = value;
      resetEnvCache();
      expect(() => env(), name).toThrow(new RegExp(name));
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
      resetEnvCache();
    }
  });
});

describe("mail errors", () => {
  it("reads other providers' plain errors: SES's sandbox is not_allowed, other 4xx permanent, the rest transient", () => {
    expect(classifyMailError(new Error("SES send failed (400): Email address is not verified.")).failure).toBe("not_allowed");
    expect(classifyMailError(new Error("Mailpit send failed (400)")).failure).toBe("permanent");
    expect(classifyMailError(new Error("Mailpit send failed (429)")).failure).toBe("transient");
    expect(classifyMailError(new Error("socket hang up")).failure).toBe("transient");
  });

  it("keeps addresses out of what it records", () => {
    expect(withoutAddresses("bounced: someone.new@gmail.com <x@y.co> does not exist")).toBe("bounced: [address] <[address]> does not exist");
  });
});

describe("Resend webhooks", () => {
  const secret = `whsec_${Buffer.from("super-secret-key").toString("base64")}`;
  const sign = (id: string, ts: string, body: string, key = "super-secret-key") => `v1,${createHmac("sha256", Buffer.from(key)).update(`${id}.${ts}.${body}`).digest("base64")}`;
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  const ts = String(now / 1000);
  const body = JSON.stringify({ type: "email.delivered", created_at: "2026-10-16T11:59:00.000Z", data: { email_id: "re_1" } });

  it("accepts a genuine signature (also among several), refuses a wrong, missing or stale one", () => {
    expect(verifyResendWebhook(secret, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) }, body, now)).toBe(true);
    expect(verifyResendWebhook(secret, { id: "msg_1", timestamp: ts, signature: `v1,AAAA ${sign("msg_1", ts, body)}` }, body, now)).toBe(true);
    expect(verifyResendWebhook(secret, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body, "other") }, body, now)).toBe(false);
    expect(verifyResendWebhook(secret, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) }, `${body} `, now)).toBe(false);
    expect(verifyResendWebhook(secret, { id: "msg_2", timestamp: ts, signature: sign("msg_1", ts, body) }, body, now)).toBe(false);
    expect(verifyResendWebhook(secret, { id: "msg_1", timestamp: ts, signature: null }, body, now)).toBe(false);
    expect(verifyResendWebhook("", { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) }, body, now)).toBe(false);
    const old = String(now / 1000 - 600);
    expect(verifyResendWebhook(secret, { id: "msg_1", timestamp: old, signature: sign("msg_1", old, body) }, body, now)).toBe(false);
  });

  it("reads delivery events and ignores opens, clicks and anything unreadable", () => {
    expect(parseResendEvent(JSON.parse(body))).toEqual({ provider: "resend", messageId: "re_1", status: "delivered", at: new Date("2026-10-16T11:59:00.000Z"), errorCode: null, errorMessage: null });
    expect(parseResendEvent({ type: "email.bounced", data: { email_id: "re_2", bounce: { type: "Permanent", subType: "Suppressed", message: "x@y.co is on the suppression list" } } })).toMatchObject({
      status: "bounced",
      errorCode: "Permanent:Suppressed",
      errorMessage: "[address] is on the suppression list",
    });
    expect(parseResendEvent({ type: "email.complained", data: { email_id: "re_3" } })).toMatchObject({ status: "complained" });
    expect(parseResendEvent({ type: "email.delivery_delayed", data: { email_id: "re_4" } })).toMatchObject({ status: "delayed" });
    expect(parseResendEvent({ type: "email.opened", data: { email_id: "re_5" } })).toBeNull();
    expect(parseResendEvent({ type: "email.clicked", data: { email_id: "re_5" } })).toBeNull();
    expect(parseResendEvent({ nope: true })).toBeNull();
  });
});
