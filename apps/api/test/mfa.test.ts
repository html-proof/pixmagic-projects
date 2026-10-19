import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@app/core";
import { systemDb } from "@app/db";
import { totpCode } from "./fakeCognito.js";
import { clean, cookiesFrom, ORIGIN, setup, signIn, teardown, testBrowser, userOf, type InjectResponse, type TestCtx } from "./helpers.js";

/**
 * Two-step verification with an authenticator app (Cognito TOTP), opt-in for password accounts:
 * setting it up in Settings → Security, the code step at sign-in, and turning it off. An account
 * without it signs in exactly as before.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => ctx.app.inject({ method: "POST", url, headers: { ...ORIGIN, ...headers }, payload });
const get = (url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: "GET", url, headers });
const cookie = (res: InjectResponse, name: string) => (res.headers["set-cookie"] ?? "").split(", ").find((c) => c.startsWith(`${name}=`));
const wrongCode = (secret: string) => String((Number(totpCode(secret)) + 500_000) % 1_000_000).padStart(6, "0");

/** Env settings for one test, put back afterwards. */
function withEnv(vars: Record<string, string>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  ctx.setEnv(vars);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
  };
}

/** A password account with two-step verification on (as Settings would leave it). */
function mfaUser(sub = "u1", email = "a@x.com") {
  const u = ctx.auth.addUser({ sub, email });
  const secret = ctx.auth.enableTotp(sub);
  return { password: u.password!, secret, email };
}

describe("an account without two-step verification", () => {
  it("signs in exactly as before: no code step, no cookie for one", async () => {
    const u = ctx.auth.addUser({ sub: "u1", email: "a@x.com" });
    const res = await post("/auth/login", { email: "a@x.com", password: u.password });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: expect.objectContaining({ email: "a@x.com" }) });
    expect(cookie(res, "__mfa")).toBeUndefined();
    expect(cookie(res, "__session")).toBeDefined();
    expect(ctx.auth.calls).not.toContain("answerTotpChallenge");
    const account = (await get("/auth/account", { cookie: cookiesFrom(res) })).json();
    expect(account).toMatchObject({ hasPassword: true, mfaEnabled: false });
  });
});

describe("setting it up (Settings → Security)", () => {
  it("shows the app's secret once, turns on with a code from the app, and is asked for at the next sign-in", async () => {
    const { headers, user } = await signIn(ctx, "u1", "a@x.com");
    const setupRes = await post("/auth/account/mfa/setup", {}, headers);
    expect(setupRes.statusCode).toBe(200);
    expect(setupRes.headers["cache-control"]).toBe("no-store");
    const { secret, otpauthUri } = setupRes.json();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    const uri = new URL(otpauthUri);
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/bizinsights:a%40x\.com\?/);
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/bizinsights:a@x.com");
    expect(Object.fromEntries(uri.searchParams)).toEqual({ secret, issuer: "bizinsights", algorithm: "SHA1", digits: "6", period: "30" });
    // Not on until a code from the app proves it is set up.
    expect((await get("/auth/account", headers)).json().mfaEnabled).toBe(false);
    expect((await post("/auth/account/mfa/verify", { code: wrongCode(secret) }, headers)).json().error).toBe("invalid_code");
    expect((await post("/auth/account/mfa/verify", { code: "12345" }, headers)).statusCode).toBe(400);
    const verified = await post("/auth/account/mfa/verify", { code: totpCode(secret) }, headers);
    expect(verified.json()).toEqual({ ok: true, mfaEnabled: true });
    expect((await get("/auth/account", headers)).json().mfaEnabled).toBe(true);
    expect(await systemDb.authEvent.count({ where: { type: "mfa_enabled", userId: user.id } })).toBe(1);
    // This session carries on; the next sign-in asks for a code.
    expect((await get("/me", headers)).statusCode).toBe(200);
    const password = ctx.auth.users.get("u1")!.password!;
    expect((await post("/auth/login", { email: "a@x.com", password })).json()).toEqual({ next: "mfa" });
    // Setting it up again is refused while it is on.
    expect((await post("/auth/account/mfa/setup", {}, headers)).json().error).toBe("mfa_already_on");
  });

  it("needs a recent sign-in or the current password", async () => {
    const { headers } = await signIn(ctx, "u1", "a@x.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    // Past the session's re-check too, which is fine: it is still the same sign-in.
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect((await post("/auth/account/mfa/setup", {}, headers)).json().error).toBe("password_required");
    expect((await post("/auth/account/mfa/setup", { password: "not-the-password" }, headers)).json().error).toBe("wrong_password");
    const password = ctx.auth.users.get("u1")!.password!;
    expect((await post("/auth/account/mfa/setup", { password }, headers)).statusCode).toBe(200);
  });

  it("is for password sign-ins only: a Google session is pointed to Google's own", async () => {
    const restore = withEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "Google" });
    try {
      const browser = testBrowser(ctx);
      const start = await browser.get("/auth/oauth/google/start");
      const back = ctx.auth.federatedSignIn(start.headers.location!, { id: "g-1", email: "g@gmail.com" });
      expect((await browser.post("/auth/oauth/callback", { code: back.code, state: back.state })).statusCode).toBe(200);
      const res = await browser.post("/auth/account/mfa/setup", {});
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("mfa_password_only");
      expect((await browser.get("/auth/account")).json()).toMatchObject({ hasPassword: false, mfaEnabled: false });
    } finally {
      restore();
    }
  });

  it("says it can't tell (null) rather than \"off\" while Cognito can't be asked", async () => {
    const { headers } = await signIn(ctx, "u1", "a@x.com");
    ctx.auth.state.unavailable = true;
    const res = await get("/auth/account", headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().mfaEnabled).toBeNull();
  });
});

describe("signing in with it", () => {
  it("asks for the app's code after the password, keeping Cognito's session on the server", async () => {
    const { password, secret } = mfaUser();
    const answer = vi.spyOn(ctx.auth, "answerTotpChallenge");
    const browser = testBrowser(ctx);
    const first = await browser.post("/auth/login", { email: "a@x.com", password });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ next: "mfa" });
    // No session yet, and Cognito's challenge session never reaches the browser.
    expect(cookie(first, "__session")).toBeUndefined();
    expect(first.body + (first.headers["set-cookie"] ?? "")).not.toMatch(/mfa-session/);
    expect(cookie(first, "__mfa")).toMatch(/HttpOnly/);
    expect(cookie(first, "__mfa")).toMatch(/Path=\/auth\/login/);
    expect((await browser.get("/me")).statusCode).toBe(401);

    const wrong = await browser.post("/auth/login/mfa", { code: wrongCode(secret) });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("invalid_code");
    const res = await browser.post("/auth/login/mfa", { code: totpCode(secret) });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: "a@x.com" });
    // Answered as the user the challenge named (Cognito's own name, "u1" here), never the email.
    expect(answer).toHaveBeenLastCalledWith("u1", expect.any(String), expect.any(String));
    expect(cookie(res, "__session")).toMatch(/Max-Age=\d+/);
    expect((await browser.get("/me")).statusCode).toBe(200);
    expect((await userOf("u1")).email).toBe("a@x.com");
    // Used up: the same step can't sign in again.
    expect((await browser.post("/auth/login/mfa", { code: totpCode(secret) })).json().error).toBe("mfa_expired");
  });

  it("honours \"Keep me signed in\" as ticked with the password", async () => {
    const { password, secret } = mfaUser();
    const browser = testBrowser(ctx);
    await browser.post("/auth/login", { email: "a@x.com", password, keep: false });
    const res = await browser.post("/auth/login/mfa", { code: totpCode(secret) });
    expect(res.statusCode).toBe(200);
    expect(cookie(res, "__session")).toBeDefined();
    expect(cookie(res, "__session")).not.toMatch(/Max-Age/);
  });

  it("wants the password first, in the same browser, within Cognito's three minutes", async () => {
    const { password, secret } = mfaUser();
    // No password step at all, or another browser's.
    expect((await post("/auth/login/mfa", { code: totpCode(secret) })).json().error).toBe("mfa_expired");
    const browser = testBrowser(ctx);
    await browser.post("/auth/login", { email: "a@x.com", password });
    expect((await testBrowser(ctx).post("/auth/login/mfa", { code: totpCode(secret) })).json().error).toBe("mfa_expired");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 181_000);
    const late = await browser.post("/auth/login/mfa", { code: totpCode(secret) });
    expect(late.json().error).toBe("mfa_expired");
    expect(late.json().message).toMatch(/email and password again/);
  });

  it("starts over once Cognito has ended the sign-in after wrong codes", async () => {
    const { password, secret } = mfaUser();
    const browser = testBrowser(ctx);
    await browser.post("/auth/login", { email: "a@x.com", password });
    for (let i = 0; i < 3; i++) expect((await browser.post("/auth/login/mfa", { code: wrongCode(secret) })).json().error).toBe("invalid_code");
    expect((await browser.post("/auth/login/mfa", { code: totpCode(secret) })).json().error).toBe("mfa_expired");
    // A fresh password step works.
    await browser.post("/auth/login", { email: "a@x.com", password });
    expect((await browser.post("/auth/login/mfa", { code: totpCode(secret) })).statusCode).toBe(200);
  });

  it("limits code guesses per account, across fresh password steps", async () => {
    const { password, secret } = mfaUser();
    const browser = testBrowser(ctx);
    let last: InjectResponse | undefined;
    for (let round = 0; round < 4 && last?.statusCode !== 429; round++) {
      await browser.post("/auth/login", { email: "a@x.com", password });
      for (let i = 0; i < 3; i++) {
        last = await browser.post("/auth/login/mfa", { code: wrongCode(secret) });
        if (last.statusCode === 429) break;
      }
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.headers["retry-after"]).toBeDefined();
  });
});

describe("turning it off", () => {
  it("needs the password and a current code, then sign-in asks for neither code nor step", async () => {
    const { headers, user } = await signIn(ctx, "u1", "a@x.com");
    const password = ctx.auth.users.get("u1")!.password!;
    const secret = ctx.auth.enableTotp("u1");
    expect((await get("/auth/account", headers)).json().mfaEnabled).toBe(true);
    expect((await post("/auth/account/mfa/disable", { code: totpCode(secret) }, headers)).statusCode).toBe(400);
    expect((await post("/auth/account/mfa/disable", { password: "not-the-password", code: totpCode(secret) }, headers)).json().error).toBe("wrong_password");
    expect((await post("/auth/account/mfa/disable", { password, code: wrongCode(secret) }, headers)).json().error).toBe("invalid_code");
    expect((await get("/auth/account", headers)).json().mfaEnabled).toBe(true);
    const res = await post("/auth/account/mfa/disable", { password, code: totpCode(secret) }, headers);
    expect(res.json()).toEqual({ ok: true, mfaEnabled: false });
    expect((await get("/auth/account", headers)).json().mfaEnabled).toBe(false);
    expect(await systemDb.authEvent.count({ where: { type: "mfa_disabled", userId: user.id } })).toBe(1);
    // The check's own tokens were handed back.
    expect(ctx.auth.calls).toContain("revokeRefreshToken");
    expect((await post("/auth/login", { email: "a@x.com", password })).json().user).toMatchObject({ id: user.id });
  });

  it("a password change with it on signs this browser out too (the new password needs a code)", async () => {
    const { headers } = await signIn(ctx, "u1", "a@x.com");
    const old = ctx.auth.users.get("u1")!.password!;
    ctx.auth.enableTotp("u1");
    const res = await post("/auth/account/password", { currentPassword: old, password: "a-better-password", confirmPassword: "a-better-password" }, headers);
    expect(res.json()).toEqual({ ok: true, signedIn: false });
    expect(cookie(res, "__session")).toMatch(/Max-Age=0/);
    expect((await get("/me", headers)).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "a@x.com", password: "a-better-password" })).json()).toEqual({ next: "mfa" });
  });
});
