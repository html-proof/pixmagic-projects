import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "../src/env.js";
import { classifyMailError, MailError, parseResendEvent, resendMailer, verifyResendWebhook, withoutAddresses } from "../src/mail/index.js";
import type { FetchLike } from "../src/shopify.js";

const saved = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "unit-session-secret-123456",
    OTP_PEPPER: "unit-pepper",
    TOKEN_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 1).toString("base64")}`,
    EMAIL_FROM: "bizinsights <invitations@bizinsights.io>",
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
