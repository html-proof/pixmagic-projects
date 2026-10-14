import { beforeAll, describe, expect, it } from "vitest";
import {
  buildMime,
  dotStuff,
  googleIdentity,
  idTokenClaims,
  microsoftErrorCode,
  MimeError,
  needsRewrap,
  OAuthError,
  open,
  queueIdFrom,
  resetCredentialKeyring,
  resetEnvCache,
  rewrap,
  seal,
  sealedKeyVersion,
  smtpSend,
  smtpSendError,
  SmtpError,
} from "../src/index.js";
import { fakeSmtp, idToken } from "../../../test-support/emailFakes.js";

const KEY1 = Buffer.alloc(32, 1).toString("base64");
const KEY2 = Buffer.alloc(32, 2).toString("base64");

function useEnv(vars: Record<string, string>) {
  Object.assign(process.env, { NODE_ENV: "test", SESSION_SECRET: "unit-session-secret-123456", OTP_PEPPER: "unit-pepper", TOKEN_ENCRYPTION_KEYS: `1:${KEY1}`, APP_URL: "https://app.example.com", ...vars });
  resetEnvCache();
  resetCredentialKeyring();
}

beforeAll(() => useEnv({ EMAIL_CREDENTIAL_KEYS: "" }));

describe("credential vault (envelope encryption)", () => {
  it("round-trips, binds to the AAD and never stores the plaintext", () => {
    const sealed = seal("refresh-token-secret", "email:oauth:acc1:refresh");
    expect(sealed).not.toContain("refresh-token-secret");
    expect(sealed.startsWith("env1.1.")).toBe(true);
    expect(open(sealed, "email:oauth:acc1:refresh")).toBe("refresh-token-secret");
    // Copied to another account's row: refuses.
    expect(() => open(sealed, "email:oauth:acc2:refresh")).toThrow();
  });

  it("uses a fresh data key each time", () => {
    expect(seal("same", "a")).not.toBe(seal("same", "a"));
  });

  it("rotates by re-wrapping the data key only", () => {
    useEnv({ EMAIL_CREDENTIAL_KEYS: `1:${KEY1}` });
    const sealed = seal("smtp-password", "email:smtp:acc1:password");
    useEnv({ EMAIL_CREDENTIAL_KEYS: `2:${KEY2},1:${KEY1}` });
    expect(needsRewrap(sealed)).toBe(true);
    const rewrapped = rewrap(sealed, "email:smtp:acc1:password");
    expect(sealedKeyVersion(rewrapped)).toBe(2);
    expect(rewrapped.split(".")[3]).toBe(sealed.split(".")[3]); // the secret's own ciphertext is untouched
    useEnv({ EMAIL_CREDENTIAL_KEYS: `2:${KEY2}` });
    expect(open(rewrapped, "email:smtp:acc1:password")).toBe("smtp-password");
    expect(() => open(sealed, "email:smtp:acc1:password")).toThrow(/Unknown key version/);
    useEnv({ EMAIL_CREDENTIAL_KEYS: "" });
  });
});

describe("MIME", () => {
  const base = { from: { email: "sales@shop.test", name: "Shop Sales" }, to: "alex@example.com", subject: "Your order", html: "<p>Hi</p>", text: "Hi", messageId: "abc123@app.example.com" };

  it("builds a multipart/alternative message with our Message-ID", () => {
    const m = buildMime({ ...base, headers: { "List-Unsubscribe": "<https://x.test/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    expect(m).toContain('From: "Shop Sales" <sales@shop.test>\r\n');
    expect(m).toContain("Message-ID: <abc123@app.example.com>\r\n");
    expect(m).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n");
    expect(m).toMatch(/Content-Type: multipart\/alternative; boundary="=_insights_[0-9a-f]+"/);
    expect(m).toContain(Buffer.from("Hi").toString("base64"));
  });

  it("encodes non-ASCII headers and refuses header injection", () => {
    expect(buildMime({ ...base, subject: "Danke für Ihre Bestellung" })).toContain("Subject: =?UTF-8?B?");
    expect(() => buildMime({ ...base, subject: "x\r\nBcc: victim@example.com" })).toThrow(MimeError);
    expect(() => buildMime({ ...base, to: "a@b.com\r\nBcc: c@d.com" })).toThrow(MimeError);
    expect(() => buildMime({ ...base, from: { email: "a@b.com", name: "A\nB" } })).toThrow(MimeError);
    expect(() => buildMime({ ...base, headers: { "X-Evil": "a\r\nBcc: x@y.com" } })).toThrow(MimeError);
  });
});

describe("SMTP client", () => {
  const cfg = { host: "smtp.shop.test", port: 587, encryption: "starttls" as const, username: "u@shop.test", password: "right-password" };
  const envelope = { from: "u@shop.test", to: "alex@example.com", data: "Subject: hi\r\n\r\n.leading dot\r\nbody\r\n" };

  it("upgrades with STARTTLS, signs in and sends, with dot-stuffing and the queue id", async () => {
    const smtp = fakeSmtp();
    const r = await smtpSend(smtp.connect, cfg, envelope);
    expect(r.queueId).toBe("FAKE123");
    expect(smtp.connections[0]).toMatchObject({ implicitTls: false, tls: true, authed: true });
    expect(smtp.delivered[0]!.data).toContain(".leading dot");
    expect(dotStuff(".a\r\nb")).toBe("..a\r\nb\r\n.\r\n");
  });

  it("uses implicit TLS on 465", async () => {
    const smtp = fakeSmtp();
    await smtpSend(smtp.connect, { ...cfg, port: 465, encryption: "tls" });
    expect(smtp.connections[0]).toMatchObject({ implicitTls: true, authed: true });
  });

  it("never signs in without TLS", async () => {
    const smtp = fakeSmtp({ starttls: false });
    await expect(smtpSend(smtp.connect, cfg)).rejects.toMatchObject({ code: "starttls_unavailable" });
    expect(smtp.connections[0]!.authed).toBe(false);
  });

  it("reports a failed TLS handshake, a wrong password and a refused connection", async () => {
    await expect(smtpSend(fakeSmtp({ failTls: true }).connect, cfg)).rejects.toMatchObject({ code: "tls_failed" });
    await expect(smtpSend(fakeSmtp({ password: "other" }).connect, cfg)).rejects.toMatchObject({ code: "auth_failed" });
    await expect(smtpSend(fakeSmtp({ refuse: true }).connect, cfg)).rejects.toMatchObject({ code: "connect_failed" });
  });

  it("classifies sender and recipient refusals, and a hard bounce", async () => {
    const sender = await smtpSend(fakeSmtp({ mailReply: "553 5.7.1 Sender address rejected: not owned by user" }).connect, cfg, envelope).catch((e) => e);
    expect(smtpSendError(sender)).toMatchObject({ kind: "sender_rejected" });
    const bounce = await smtpSend(fakeSmtp({ rcptReply: "550 5.1.1 User unknown" }).connect, cfg, envelope).catch((e) => e);
    expect(smtpSendError(bounce)).toMatchObject({ kind: "recipient_rejected", opts: { bounce: true } });
    const busy = await smtpSend(fakeSmtp({ rcptReply: "451 4.7.1 Try again later" }).connect, cfg, envelope).catch((e) => e);
    expect(smtpSendError(busy).kind).toBe("transient");
  });

  it("treats no answer after the data as uncertain (never retried)", async () => {
    const err = await smtpSend(fakeSmtp({ hangAfterData: true }).connect, cfg, envelope, { data: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.code).toBe("uncertain");
    expect(smtpSendError(err).kind).toBe("uncertain");
  });

  it("reads queue ids from common replies", () => {
    expect(queueIdFrom("2.0.0 Ok: queued as 4ABCD123")).toBe("4ABCD123");
    expect(queueIdFrom("OK id=1rABC-00011X-2c")).toBe("1rABC-00011X-2c");
    expect(queueIdFrom("Thanks")).toBeNull();
  });
});

describe("OAuth", () => {
  const google = { clientId: "g-client", clientSecret: "s" };

  it("takes the mailbox from a Google ID token for this client only", () => {
    const tokens = (claims: Record<string, unknown>) => ({ accessToken: "a", refreshToken: "r", expiresAt: null, scopes: [], idToken: idToken({ iss: "https://accounts.google.com", aud: "g-client", ...claims }) });
    expect(googleIdentity(google, tokens({ sub: "123", email: "Owner@Shop.com", email_verified: true, hd: "shop.com" }))).toMatchObject({ provider: "google_workspace", email: "owner@shop.com", providerAccountId: "123" });
    expect(googleIdentity(google, tokens({ sub: "1", email: "a@gmail.com", email_verified: true })).provider).toBe("gmail");
    expect(() => googleIdentity(google, tokens({ sub: "1", email: "a@gmail.com", email_verified: false }))).toThrow(OAuthError);
    expect(() => idTokenClaims(idToken({ iss: "https://accounts.google.com", aud: "someone-else" }), { audience: "g-client", issuer: () => true })).toThrow(/another app/);
    expect(() => idTokenClaims(idToken({ iss: "https://accounts.google.com", aud: "g-client", exp: 1 }), { audience: "g-client", issuer: () => true })).toThrow(/expired/);
  });

  it("maps Microsoft errors to what the merchant must do", () => {
    expect(microsoftErrorCode("invalid_grant", "AADSTS65001: The user or administrator has not consented")).toEqual({ kind: "permanent", code: "consent_required" });
    expect(microsoftErrorCode("invalid_grant", "AADSTS53003: Access has been blocked by Conditional Access policies")).toEqual({ kind: "permanent", code: "conditional_access" });
    expect(microsoftErrorCode("invalid_grant", "AADSTS700082: The refresh token has expired due to inactivity")).toEqual({ kind: "permanent", code: "auth_failed" });
    expect(microsoftErrorCode("invalid_grant", "AADSTS50057: The user account is disabled")).toEqual({ kind: "permanent", code: "account_disabled_by_provider" });
    expect(microsoftErrorCode("temporarily_unavailable", "")).toEqual({ kind: "transient", code: "provider_unavailable" });
    // Our own client secret being wrong must not mark every merchant's account for reconnecting.
    expect(microsoftErrorCode("invalid_client", "AADSTS7000215: Invalid client secret")).toEqual({ kind: "transient", code: "provider_unavailable" });
  });
});
