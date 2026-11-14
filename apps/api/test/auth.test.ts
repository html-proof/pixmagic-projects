import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@app/core";
import { systemDb } from "@app/db";
import { signSession, readSession, REVALIDATE_MS } from "../src/session.js";
import { CLIENT_IP_HEADER } from "../src/context.js";
import { LIMITS } from "../src/rateLimit.js";
import { totpCode } from "./fakeCognito.js";
import { clean, cookiesFrom, createWorkspace, emailedDeletionCode, ORIGIN, setup, signIn, teardown, testBrowser, userOf, type TestCtx } from "./helpers.js";

/**
 * Sign-in on Amazon Cognito: what each screen sends, what Cognito is asked, and what the person
 * ends up with (a session, an account linked to the right users.id, or a message they can act on).
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));
afterEach(() => vi.useRealTimers());

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => ctx.app.inject({ method: "POST", url, headers: { ...ORIGIN, ...headers }, payload });
const get = (url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: "GET", url, headers });

/** Time travel (Date only): the API's clocks and the in-memory coordinator read Date.now(). */
function advance(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
}

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

describe("creating an account with email and password", () => {
  const signup = (overrides: Record<string, unknown> = {}) =>
    post("/auth/signup", { name: "Ada Lovelace", email: "Ada@Example.com", password: "correct-horse", confirmPassword: "correct-horse", acceptTerms: true, ...overrides });

  it("signs up, confirms the emailed code, signs in, and lands on a new user with its identity", async () => {
    const res = await signup();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ next: "confirm", email: "ada@example.com" });
    // Nothing is signed in, and nothing exists on our side, until the code is confirmed and they sign in.
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await systemDb.user.count()).toBe(0);

    expect((await post("/auth/login", { email: "ada@example.com", password: "correct-horse" })).json().error).toBe("unconfirmed");
    // Without the password chosen at sign-up the code isn't even looked at (nor a guess spent): the
    // account would otherwise keep whatever password the sign-up holds, maybe someone else's.
    expect((await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com") })).json().error).toBe("password_required");
    expect(ctx.auth.calls).not.toContain("confirmSignUp");
    expect((await post("/auth/signup/confirm", { email: "ada@example.com", code: "000000", password: "correct-horse" })).json().error).toBe("invalid_code");
    expect((await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com"), password: "correct-horse" })).statusCode).toBe(200);

    const login = await post("/auth/login", { email: "ADA@example.com", password: "correct-horse" });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toMatch(/__session=[^;]+;.*HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/__session_rt=v\d/);
    // No Cognito token ever reaches the page.
    expect(login.body).not.toMatch(/rt-|at-|fake\./);

    const me = await get("/me", { cookie: cookiesFrom(login) });
    expect(me.json().user).toMatchObject({ email: "ada@example.com", emailVerified: true, displayName: "Ada Lovelace" });
    const user = await systemDb.user.findUniqueOrThrow({ where: { email: "ada@example.com" }, include: { identities: true } });
    expect(user.identities).toEqual([expect.objectContaining({ provider: "cognito", method: "password", email: "ada@example.com" })]);
  });

  it("checks the form before asking Cognito", async () => {
    expect((await signup({ acceptTerms: false })).statusCode).toBe(400);
    expect((await signup({ confirmPassword: "something-else" })).json().error).toBe("password_mismatch");
    expect((await signup({ password: "short", confirmPassword: "short" })).json().error).toBe("weak_password");
    expect((await signup({ email: "not-an-email" })).statusCode).toBe(400);
    expect(ctx.auth.calls).not.toContain("signUp");
  });

  it("says an address is taken once its account is confirmed, but just resends the code to one that never was", async () => {
    const first = await signup();
    // Sent again within the code's minute (a double press, a reload): the code already in the
    // inbox is the one to enter, with the time it has left; no second email.
    const twice = await signup();
    expect(twice.statusCode).toBe(200);
    const { now: _now, ...standing } = first.json().challenge;
    expect(twice.json().challenge).toMatchObject(standing);
    expect(ctx.auth.sent.filter((s) => s.kind === "signup")).toHaveLength(1);
    // Past the minute: a fresh code.
    advance(61_000);
    const again = await signup();
    expect(again.statusCode).toBe(200);
    expect(again.json().next).toBe("confirm");
    expect(again.json().challenge.issuedAt).toBeGreaterThan(first.json().challenge.issuedAt);
    expect(ctx.auth.sent.filter((s) => s.kind === "signup")).toHaveLength(2);

    await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com"), password: "correct-horse" });
    const taken = await signup();
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("account_exists");
    expect(ctx.auth.calls).not.toContain("adminDeleteUser");
  });

  it("signing up again with another password before confirming replaces the first sign-up: the new password is the one that works", async () => {
    // Whoever typed the address first (anyone can) must not keep a password on the account its inbox's owner confirms.
    await signup({ password: "squatters-password", confirmPassword: "squatters-password" });
    const firstCode = ctx.auth.code("signup", "ada@example.com");
    // Another password emails a new code, which waits for the last one's minute like any other.
    const tooSoon = await signup({ password: "owners-password", confirmPassword: "owners-password" });
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().error).toBe("resend_cooldown");
    expect(ctx.auth.calls).not.toContain("adminDeleteUser");
    advance(61_000);
    const again = await signup({ password: "owners-password", confirmPassword: "owners-password" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ next: "confirm", email: "ada@example.com" });
    expect(ctx.auth.calls).toContain("adminDeleteUser");
    // The first sign-up's code went with it; the fresh one confirms the new sign-up.
    expect((await post("/auth/signup/confirm", { email: "ada@example.com", code: firstCode, password: "owners-password" })).json().error).toBe("invalid_code");
    expect((await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com"), password: "owners-password" })).statusCode).toBe(200);
    expect((await post("/auth/login", { email: "ada@example.com", password: "squatters-password" })).statusCode).toBe(401);
    const login = await post("/auth/login", { email: "ada@example.com", password: "owners-password" });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ email: "ada@example.com", emailVerified: true });
    expect(await systemDb.authEvent.count({ where: { type: "unconfirmed_signup_replaced" } })).toBe(1);
  });

  it("limits how often signing up again can email the same address (AUTH_CODE_LIMIT_HOURLY)", async () => {
    const restore = withEnv({ AUTH_CODE_LIMIT_HOURLY: "3" });
    try {
      await signup();
      for (let i = 0; i < 2; i++) {
        advance(61_000);
        expect((await signup()).statusCode).toBe(200);
      }
      advance(61_000);
      const res = await signup();
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("too_many_codes");
      expect(ctx.auth.sent.filter((s) => s.kind === "signup")).toHaveLength(3);
    } finally {
      restore();
    }
  });

  it("the code decides whose password the account keeps: confirming with the password chosen here replaces one a later sign-up set", async () => {
    // The owner signs up; someone else then signs up again with their address and another
    // password (each try replaces the pending sign-up and emails the owner a new code).
    await signup({ password: "owners-password", confirmPassword: "owners-password" });
    advance(61_000);
    await signup({ password: "squatters-password", confirmPassword: "squatters-password" });
    // The owner enters the newest code from their inbox; their sign-up page sends their password with it.
    const confirm = await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com"), password: "owners-password" });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({ ok: true, user: { email: "ada@example.com", emailVerified: true } });
    expect(String(confirm.headers["set-cookie"])).toMatch(/__session=[^;]/);
    expect((await post("/auth/login", { email: "ada@example.com", password: "squatters-password" })).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "ada@example.com", password: "owners-password" })).json().user.id).toBe(confirm.json().user.id);
    expect(await systemDb.authEvent.count({ where: { type: "signup_password_replaced" } })).toBe(1);
    // The other person's next try finds the address taken.
    expect((await signup({ password: "squatters-password", confirmPassword: "squatters-password" })).json().error).toBe("account_exists");
  });

  it("ends the session of anyone who signed in with the replaced password in the moment before it was replaced", async () => {
    await signup({ password: "owners-password", confirmPassword: "owners-password" });
    advance(61_000);
    await signup({ password: "squatters-password", confirmPassword: "squatters-password" });
    const confirmSignUp = ctx.auth.confirmSignUp;
    let squatter = "";
    vi.spyOn(ctx.auth, "confirmSignUp").mockImplementationOnce(async (email, code) => {
      await confirmSignUp(email, code);
      // Confirmed: the other person's password works for an instant, and they sign in with it.
      squatter = cookiesFrom(await post("/auth/login", { email, password: "squatters-password" }));
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 1_000);
    });
    const res = await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com"), password: "owners-password" });
    expect(res.statusCode).toBe(200);
    expect(squatter).toMatch(/__session=/);
    expect((await get("/me", { cookie: squatter })).statusCode).toBe(401);
    expect((await get("/me", { cookie: cookiesFrom(res) })).json().user.email).toBe("ada@example.com");
    expect(await systemDb.authEvent.findFirst({ where: { type: "signup_password_replaced" } })).toMatchObject({ userId: res.json().user.id });
    vi.restoreAllMocks();
  });

  it("leaves no earlier sign-up's password behind when the code comes with a password Cognito wouldn't take", async () => {
    // The sign-in page's code step sends whatever was typed there; the pending sign-up may be someone else's.
    await signup({ password: "squatters-password", confirmPassword: "squatters-password" });
    const res = await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com"), password: "short" });
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers["set-cookie"] ?? "").not.toMatch(/__session=[^;]/);
    expect((await post("/auth/login", { email: "ada@example.com", password: "squatters-password" })).statusCode).toBe(401);
    expect(ctx.auth.calls).toContain("adminSetPassword");
    // The code proved the inbox: "Forgot password?" sets the password from there.
    expect((await post("/auth/password/forgot", { email: "ada@example.com" })).statusCode).toBe(200);
    const reset = await post("/auth/password/reset", { email: "ada@example.com", code: ctx.auth.code("reset", "ada@example.com"), password: "owners-password", confirmPassword: "owners-password" });
    expect(reset.statusCode).toBe(200);
    expect((await post("/auth/login", { email: "ada@example.com", password: "owners-password" })).statusCode).toBe(200);
  });

  it("signs in straight away when the code comes with the password that signed up, honouring \"Keep me signed in\"", async () => {
    await signup();
    const res = await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com"), password: "correct-horse", keep: false });
    expect(res.json()).toMatchObject({ ok: true, user: { email: "ada@example.com", displayName: "Ada Lovelace" } });
    const session = String(res.headers["set-cookie"]).split(", ").find((c) => c.startsWith("__session="));
    expect(session).toBeDefined();
    expect(session).not.toMatch(/Max-Age/);
    expect(ctx.auth.calls).not.toContain("adminSetPassword");
    expect(await systemDb.authEvent.count({ where: { type: "signup_password_replaced" } })).toBe(0);
  });

  it("never signs in, or sets a password, for a sign-up that was already confirmed", async () => {
    await signup();
    expect((await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com"), password: "correct-horse" })).json()).toMatchObject({ ok: true });
    // The code was spent: a second confirmation is refused before Cognito is asked, whatever code
    // and password come with it, so it can't be a way to try passwords outside the sign-in page's limits.
    for (const password of ["a-guessed-password", "correct-horse"]) {
      const again = await post("/auth/signup/confirm", { email: "ada@example.com", code: "123456", password });
      expect(again.statusCode).toBe(400);
      expect(again.json().error).toBe("expired_code");
      expect(again.headers["set-cookie"] ?? "").not.toMatch(/__session=[^;]/);
    }
    expect(ctx.auth.calls.filter((c) => c === "confirmSignUp")).toHaveLength(1);
    // A second tab that confirmed while this one's code still stood: "already confirmed", no sign-in.
    advance(61_000);
    await post("/auth/signup/resend", { email: "ada@example.com" });
    const other = await post("/auth/signup/confirm", { email: "ada@example.com", code: "123456", password: "correct-horse" });
    expect(other.json()).toEqual({ ok: true });
    expect(other.headers["set-cookie"] ?? "").not.toMatch(/__session=[^;]/);
    expect(ctx.auth.calls).not.toContain("adminSetPassword");
    expect((await post("/auth/login", { email: "ada@example.com", password: "correct-horse" })).statusCode).toBe(200);
  });

  it("resends a code without saying whether the address has an account", async () => {
    await signup();
    // Past the first code's minute (the clock stands still from here, so the two answers' countdowns match).
    advance(61_000);
    const known = await post("/auth/signup/resend", { email: "ada@example.com" });
    const unknown = await post("/auth/signup/resend", { email: "nobody@example.com" });
    expect(known.json()).toEqual(unknown.json());
    expect(known.statusCode).toBe(unknown.statusCode);
    // And asking again too soon is refused the same way for both.
    const knownAgain = await post("/auth/signup/resend", { email: "ada@example.com" });
    const unknownAgain = await post("/auth/signup/resend", { email: "nobody@example.com" });
    expect(knownAgain.statusCode).toBe(429);
    expect(knownAgain.json()).toEqual(unknownAgain.json());
  });
});

describe("signing in with email and password", () => {
  it("gives the same answer for a wrong password and an unknown address", async () => {
    ctx.auth.addUser({ email: "a@x.com", password: "right-password" });
    const wrong = await post("/auth/login", { email: "a@x.com", password: "wrong-password" });
    const unknown = await post("/auth/login", { email: "b@x.com", password: "wrong-password" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json().message).toBe("That email and password don't match.");
  });

  it("rejects missing, forged, tampered and expired sessions", async () => {
    const { cookie } = await signIn(ctx, "u1", "a@x.com");
    expect((await get("/me")).statusCode).toBe(401);
    expect((await get("/me", { cookie: "__session=garbage" })).statusCode).toBe(401);
    const real = /__session=([^;]+)/.exec(cookie)![1]!;
    const claims = readSession(decodeURIComponent(real))!;
    // Someone else's user id with the old signature.
    const [, sig] = decodeURIComponent(real).split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...claims, uid: "someone-else" })).toString("base64url")}.${sig}`;
    expect((await get("/me", { cookie: `__session=${forged}` })).statusCode).toBe(401);
    expect((await get("/me", { cookie: `__session=${signSession({ ...claims, exp: Date.now() - 1 })}` })).statusCode).toBe(401);
    expect((await get("/me", { cookie })).statusCode).toBe(200);
  });

  it("ends a session that comes without its refresh-token cookie at its next check with Cognito", async () => {
    const { cookie } = await signIn(ctx, "u1", "a@x.com");
    const sessionOnly = cookie.split("; ").filter((c) => c.startsWith("__session=")).join("; ");
    // Between checks it is only our own cookie, as before.
    expect((await get("/me", { cookie: sessionOnly })).statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + REVALIDATE_MS + 1_000);
    // Due for its check: nothing Cognito could say would end it otherwise.
    const alone = await get("/me", { cookie: sessionOnly });
    expect(alone.statusCode).toBe(401);
    expect(alone.headers["set-cookie"]).toMatch(/__session=;.*Max-Age=0/);
    expect((await get("/me", { cookie })).statusCode).toBe(200);
  });

  it("\"Keep me signed in\" unticked: cookies that end with the browser, re-checks included", async () => {
    const u = ctx.auth.addUser({ sub: "u1", email: "a@x.com" });
    const kept = await post("/auth/login", { email: "a@x.com", password: u.password });
    expect(kept.headers["set-cookie"]).toMatch(/__session=[^;]+;[^,]*Max-Age=\d+/);

    const brief = await post("/auth/login", { email: "a@x.com", password: u.password, keep: false });
    expect(brief.statusCode).toBe(200);
    expect(brief.headers["set-cookie"]).toMatch(/__session=[^;]+/);
    expect(brief.headers["set-cookie"]).not.toMatch(/Max-Age/);

    // The minute's re-check with Cognito re-issues the cookies: still without a lifetime.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + REVALIDATE_MS + 1_000);
    const rechecked = await get("/me", { cookie: cookiesFrom(brief) });
    expect(rechecked.statusCode).toBe(200);
    expect(rechecked.headers["set-cookie"]).toMatch(/__session=[^;]+/);
    expect(rechecked.headers["set-cookie"]).not.toMatch(/Max-Age/);
  });

  it("/auth/whoami answers /me for a session and a plain 200 for visitors", async () => {
    const { cookie } = await signIn(ctx, "u1", "a@x.com");
    const signedIn = await get("/auth/whoami", { cookie });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toEqual((await get("/me", { cookie })).json());
    for (const headers of [{}, { cookie: "__session=garbage" }] as Array<Record<string, string>>) {
      const visitor = await get("/auth/whoami", headers);
      expect(visitor.statusCode).toBe(200);
      expect(visitor.json()).toEqual({ user: null, workspaces: [] });
    }
    expect((await get("/auth/session", { cookie })).json()).toMatchObject({ authenticated: true, method: "password" });
    expect((await get("/auth/session")).json()).toEqual({ authenticated: false });
  });

  it("blocks cross-site state-changing requests (CSRF)", async () => {
    const { cookie } = await signIn(ctx, "u1", "a@x.com");
    const res = await ctx.app.inject({ method: "POST", url: "/workspaces", headers: { cookie, origin: "https://evil.example" }, payload: { name: "x" } });
    expect(res.statusCode).toBe(403);
  });

});

describe("forgot password", () => {
  it("sends a code, sets the new password, and signs out every existing session", async () => {
    const before = await signIn(ctx, "u1", "a@x.com");
    const ask = await post("/auth/password/forgot", { email: "a@x.com" });
    expect(ask.statusCode).toBe(200);
    const code = ctx.auth.code("reset", "a@x.com");
    expect((await post("/auth/password/reset", { email: "a@x.com", code: "000000", password: "brand-new-pass", confirmPassword: "brand-new-pass" })).json().error).toBe("invalid_code");
    expect((await post("/auth/password/reset", { email: "a@x.com", code, password: "brand-new-pass", confirmPassword: "brand-new-pass!" })).json().error).toBe("password_mismatch");
    expect((await post("/auth/password/reset", { email: "a@x.com", code, password: "brand-new-pass", confirmPassword: "brand-new-pass" })).statusCode).toBe(200);

    expect((await get("/me", before.headers)).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "a@x.com", password: "brand-new-pass" })).statusCode).toBe(200);
    expect(await systemDb.authEvent.count({ where: { type: "password_reset" } })).toBe(1);
  });

  it("emails the account's address that the password was reset", async () => {
    await signIn(ctx, "u1", "a@x.com");
    await post("/auth/password/forgot", { email: "a@x.com" });
    const sentBefore = ctx.mailer.sent.length;
    const code = ctx.auth.code("reset", "a@x.com");
    expect((await post("/auth/password/reset", { email: "a@x.com", code, password: "brand-new-pass", confirmPassword: "brand-new-pass" })).statusCode).toBe(200);
    const notice = ctx.mailer.sent.slice(sentBefore);
    expect(notice).toEqual([expect.objectContaining({ to: "a@x.com", subject: "Your bizinsights password was reset" })]);
    expect(notice[0]!.text).toContain("http://localhost:3001/forgot-password");
  });

  it("ends the sessions of the account the password signs in to, even after a Google sign-in moved the account to another address", async () => {
    const { headers, user } = await signIn(ctx, "u1", "a@x.com");
    // The account's address is now another one; the password user still has the old one.
    await systemDb.user.update({ where: { id: user.id }, data: { email: "renamed@gmail.com" } });
    await post("/auth/password/forgot", { email: "a@x.com" });
    const reset = await post("/auth/password/reset", { email: "a@x.com", code: ctx.auth.code("reset", "a@x.com"), password: "brand-new-pass", confirmPassword: "brand-new-pass" });
    expect(reset.statusCode).toBe(200);
    expect((await get("/me", headers)).statusCode).toBe(401);
    expect(await systemDb.authEvent.count({ where: { type: "password_reset", userId: user.id } })).toBe(1);
  });

  it("says so (503), never \"done\", when the sessions can't be ended", async () => {
    const { headers } = await signIn(ctx, "u1", "a@x.com");
    await post("/auth/password/forgot", { email: "a@x.com" });
    const update = vi.spyOn(systemDb.user, "update").mockRejectedValueOnce(new Error("database unreachable"));
    try {
      const res = await post("/auth/password/reset", { email: "a@x.com", code: ctx.auth.code("reset", "a@x.com"), password: "brand-new-pass", confirmPassword: "brand-new-pass" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("sessions_not_ended");
    } finally {
      update.mockRestore();
    }
    // Nothing was recorded as reset: signing out everywhere is still to do, and the page says so.
    expect(await systemDb.authEvent.count({ where: { type: "password_reset" } })).toBe(0);
    expect((await get("/me", headers)).statusCode).toBe(200);
  });

  it("caps guesses at one address's code, whichever IPs they come from, and answers an unknown address the same", async () => {
    ctx.auth.addUser({ sub: "v", email: "victim@x.com" });
    await post("/auth/password/forgot", { email: "victim@x.com" });
    const right = ctx.auth.code("reset", "victim@x.com");
    const wrong = right === "000000" ? "111111" : "000000";
    const reset = (email: string, code: string, i: number) =>
      post("/auth/password/reset", { email, code, password: "a-new-password", confirmPassword: "a-new-password" }, { [CLIENT_IP_HEADER]: `10.0.1.${i}` });
    for (let i = 0; i < LIMITS.resetVerifyEmail.max; i++) {
      expect((await reset("victim@x.com", wrong, i)).json().error).toBe("invalid_code");
      expect((await reset("nobody@x.com", wrong, i)).json().error).toBe("invalid_code");
    }
    // Even the right code, from yet another address.
    const capped = await reset("victim@x.com", right, 99);
    expect(capped.statusCode).toBe(429);
    const unknown = await reset("nobody@x.com", wrong, 99);
    expect(unknown.statusCode).toBe(429);
    expect(unknown.json()).toEqual(capped.json());
    expect(ctx.auth.users.get("v")!.password).not.toBe("a-new-password");
  });

  it("names the account's other ways to sign in, which a new password doesn't end", async () => {
    const { user } = await signIn(ctx, "u1", "a@x.com");
    const reset = async () => {
      await post("/auth/password/forgot", { email: "a@x.com" });
      return post("/auth/password/reset", { email: "a@x.com", code: ctx.auth.code("reset", "a@x.com"), password: "brand-new-pass", confirmPassword: "brand-new-pass" });
    };
    expect((await reset()).json()).toEqual({ ok: true, otherMethods: [] });
    await systemDb.authIdentity.create({ data: { userId: user.id, provider: "cognito", subject: "g-sub", username: "google_1", method: "google", email: "someone@gmail.com" } });
    // Method names only, never the Google account's address.
    expect((await reset()).json()).toEqual({ ok: true, otherMethods: ["google"] });
  });

  it("answers an unknown address exactly like a known one", async () => {
    ctx.auth.addUser({ email: "a@x.com" });
    const known = await post("/auth/password/forgot", { email: "a@x.com" });
    const unknown = await post("/auth/password/forgot", { email: "nobody@x.com" });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(ctx.auth.sent.map((s) => s.email)).toEqual(["a@x.com"]);
  });
});

describe("an account with no Cognito user yet", () => {
  /** A users row with a workspace and no sign-in: merged in from another database, say. */
  async function accountWithoutSignIn() {
    const user = await systemDb.user.create({ data: { email: "old@x.com", emailVerified: true, displayName: "Old Timer" } });
    const ws = await systemDb.workspace.create({ data: { name: "Old Shop", memberships: { create: { userId: user.id, role: "owner" } } } });
    return { user, ws };
  }

  it("refuses a password without sending it anywhere but Cognito, and creates nothing", async () => {
    await accountWithoutSignIn();
    const outbound: string[] = [];
    ctx.setFetch(async (input) => {
      outbound.push(String(input));
      throw new Error("unexpected network call in test");
    });
    const res = await post("/auth/login", { email: "old@x.com", password: "their-old-password" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");
    expect(outbound).toEqual([]);
    expect(ctx.auth.users.size).toBe(0);
  });

  it("\"Forgot password?\" creates nothing for it either, and answers like an unknown address", async () => {
    const { user } = await accountWithoutSignIn();
    const known = await post("/auth/password/forgot", { email: "old@x.com" });
    const unknown = await post("/auth/password/forgot", { email: "nobody@x.com" });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual(unknown.json());
    expect(ctx.auth.users.size).toBe(0);
    expect(ctx.auth.sent).toEqual([]);
    expect(await systemDb.authEvent.count({ where: { userId: user.id } })).toBe(0);
  });

  it("signing up again with the same address links the new sign-in to the same user and everything it owns", async () => {
    const { user, ws } = await accountWithoutSignIn();
    const signup = await post("/auth/signup", { name: "Old Timer", email: "old@x.com", password: "fresh-password", confirmPassword: "fresh-password", acceptTerms: true });
    expect(signup.statusCode).toBe(200);
    expect((await post("/auth/signup/confirm", { email: "old@x.com", code: ctx.auth.code("signup", "old@x.com"), password: "fresh-password" })).statusCode).toBe(200);
    const login = await post("/auth/login", { email: "old@x.com", password: "fresh-password" });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.id).toBe(user.id);
    expect(await systemDb.user.count()).toBe(1);
    const me = await get("/me", { cookie: cookiesFrom(login) });
    expect(me.json().workspaces).toEqual([expect.objectContaining({ id: ws.id, role: "owner" })]);
    expect(await systemDb.authEvent.count({ where: { type: "identity_linked", userId: user.id } })).toBe(1);
  });
});

describe("Continue with Google", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withEnv({ GOOGLE_SIGNIN_CLIENT_ID: "test-google-client", GOOGLE_SIGNIN_CLIENT_SECRET: "test-google-secret" });
  });
  afterEach(() => restore());

  async function federated(person: { id: string; email: string | null; emailVerified?: boolean; name?: string; picture?: string }, provider = "google", returnTo?: string) {
    const browser = testBrowser(ctx);
    const start = await browser.get(`/auth/oauth/${provider}/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`);
    expect(start.statusCode).toBe(302);
    const back = ctx.auth.federatedSignIn(start.headers.location!, person);
    return { browser, start, back, finish: () => browser.post("/auth/oauth/callback", { code: back.code, state: back.state }) };
  }

  it("goes straight to the provider with PKCE, a nonce and a state bound to this browser", async () => {
    const browser = testBrowser(ctx);
    const res = await browser.get("/auth/oauth/google/start");
    const url = new URL(res.headers.location!);
    expect(url.origin + url.pathname).toBe("https://auth.example.test/oauth2/authorize");
    expect(url.searchParams.get("identity_provider")).toBe("Google");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3001/auth/callback");
    expect(browser.jar.get("__oauth")).toBe(url.searchParams.get("state"));
    // The verifier never leaves the server.
    expect(res.headers.location).not.toContain(JSON.parse((await ctx.deps.coord.peek(`oauth:signin:${url.searchParams.get("state")}`))!).verifier);
  });

  it("signs a new person in, creates their user from the verified identity, and goes back where they were headed", async () => {
    const picture = "https://lh3.googleusercontent.com/a/new-person=s96-c";
    const { browser, finish } = await federated({ id: "g-1", email: "new@gmail.com", name: "New Person", picture }, "google", "/settings/stores?x=1");
    const res = await finish();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { email: "new@gmail.com", emailVerified: true, displayName: "New Person", avatarUrl: picture }, redirect: "/settings/stores?x=1" });
    expect((await browser.get("/me")).statusCode).toBe(200);
    // No sign-up form: name, verified address, picture and the Google identity, nothing more.
    const user = await systemDb.user.findUniqueOrThrow({ where: { email: "new@gmail.com" }, include: { identities: true, memberships: true } });
    expect(user).toMatchObject({ emailVerified: true, displayName: "New Person", avatarUrl: picture, createdAt: expect.any(Date) });
    expect(user.identities).toEqual([
      expect.objectContaining({ provider: "cognito", subject: ctx.auth.users.get("google_g-1")!.sub, username: "google_g-1", method: "google", email: "new@gmail.com" }),
    ]);
    // A new account is nobody's administrator: no workspace, so no role anywhere yet.
    expect(user.memberships).toEqual([]);
    expect(await systemDb.authEvent.findFirst({ where: { type: "account_created", userId: user.id } })).toMatchObject({ metadata: expect.objectContaining({ method: "google" }) });
  });

  it("two first sign-ins with the same Google account at once make one account", async () => {
    const a = await federated({ id: "g-race", email: "race@gmail.com" });
    const b = await federated({ id: "g-race", email: "race@gmail.com" });
    const [ra, rb] = await Promise.all([a.finish(), b.finish()]);
    expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
    expect(ra.json().user.id).toBe(rb.json().user.id);
    expect(await systemDb.user.count()).toBe(1);
    expect(await systemDb.authIdentity.count()).toBe(1);
  });

  describe("an existing account with the Google account's address", () => {
    const password = (uid: string) => ctx.auth.users.get(uid)!.password!;

    it("links nothing and makes no second account until this browser signs in to that account; then the same button signs straight in", async () => {
      const { user, headers } = await signIn(ctx, "pw-sub", "merchant@gmail.com");
      const ws = await createWorkspace(ctx, headers);
      const picture = "https://lh3.googleusercontent.com/a/merchant=s96-c";
      const { browser, finish } = await federated({ id: "g-2", email: "merchant@gmail.com", picture });
      const revokedBefore = ctx.auth.calls.filter((c) => c === "revokeRefreshToken").length;
      const held = await finish();
      expect(held.statusCode).toBe(200);
      expect(held.json()).toEqual({ next: "link", provider: "google", email: "merchant@gmail.com" });
      // No session from the Google sign-in (its refresh token handed back), nothing linked, no duplicate.
      expect(held.headers["set-cookie"] ?? "").not.toMatch(/__session=[^;]/);
      expect(ctx.auth.calls.filter((c) => c === "revokeRefreshToken").length).toBe(revokedBefore + 1);
      expect((await browser.get("/me")).statusCode).toBe(401);
      expect(await systemDb.user.count()).toBe(1);
      expect(await systemDb.authIdentity.count()).toBe(1);
      expect((await browser.get("/auth/pending-link")).json()).toEqual({ pending: true, provider: "google", email: "merchant@gmail.com" });
      expect(await systemDb.authEvent.count({ where: { type: "identity_link_pending", userId: user.id } })).toBe(1);

      // A wrong password proves nothing: still held.
      expect((await browser.post("/auth/login", { email: "merchant@gmail.com", password: "not-the-password" })).statusCode).toBe(401);
      expect((await browser.get("/auth/pending-link")).json().pending).toBe(true);

      // The account's own sign-in, in this browser: Google joins it, and the account's address hears of it.
      const mailBefore = ctx.mailer.sent.length;
      const signedIn = await browser.post("/auth/login", { email: "merchant@gmail.com", password: password("pw-sub") });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json().user).toMatchObject({ id: user.id, avatarUrl: picture });
      expect((await systemDb.authIdentity.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } })).map((i) => i.method)).toEqual(["password", "google"]);
      expect(await systemDb.authEvent.findFirst({ where: { type: "identity_linked", userId: user.id } })).toMatchObject({
        metadata: expect.objectContaining({ method: "google", via: "sign_in", cognitoUsername: "google_g-2" }),
      });
      expect(ctx.mailer.sent.slice(mailBefore)).toEqual([expect.objectContaining({ to: "merchant@gmail.com", subject: "Google sign-in was added to your bizinsights account" })]);
      expect((await browser.get("/auth/pending-link")).json()).toEqual({ pending: false });

      // From now on Continue with Google signs in to the same account, its workspace and all.
      const again = await (await federated({ id: "g-2", email: "merchant@gmail.com" })).finish();
      expect(again.json().user.id).toBe(user.id);
      expect(await systemDb.user.count()).toBe(1);
      expect((await systemDb.membership.findFirstOrThrow({ where: { workspaceId: ws } })).userId).toBe(user.id);
    });

    it("needs the account's own second step: with two-step verification on, only the app's code links it", async () => {
      const { user } = await signIn(ctx, "pw-mfa", "careful@gmail.com");
      const secret = "JBSWY3DPEHPK3PXP";
      ctx.auth.users.get("pw-mfa")!.totp = { secret, enabled: true };
      const { browser, finish } = await federated({ id: "g-mfa", email: "careful@gmail.com" });
      expect((await finish()).json().next).toBe("link");
      expect((await browser.post("/auth/login", { email: "careful@gmail.com", password: password("pw-mfa") })).json()).toEqual({ next: "mfa" });
      expect(await systemDb.authIdentity.count({ where: { userId: user.id, method: "google" } })).toBe(0);
      expect((await browser.post("/auth/login/mfa", { code: totpCode(secret) })).statusCode).toBe(200);
      expect(await systemDb.authIdentity.count({ where: { userId: user.id, method: "google" } })).toBe(1);
    });

    it("never links to another account this browser signs in to, nor from another browser, nor after \"Don't link\" or the hold running out", async () => {
      const { user } = await signIn(ctx, "pw-owner", "owner@gmail.com");
      const googleIdentities = () => systemDb.authIdentity.count({ where: { method: "google" } });

      // Someone else signs in on this browser: nothing for their account, and the hold ends.
      const first = await federated({ id: "g-owner", email: "owner@gmail.com" });
      expect((await first.finish()).json().next).toBe("link");
      const other = await first.browser.signIn("pw-other", "other@x.com");
      expect(other.id).not.toBe(user.id);
      expect(await googleIdentities()).toBe(0);
      expect((await first.browser.get("/auth/pending-link")).json()).toEqual({ pending: false });

      // The owner signs in on another browser: that browser held nothing.
      const second = await federated({ id: "g-owner", email: "owner@gmail.com" });
      expect((await second.finish()).json().next).toBe("link");
      expect((await testBrowser(ctx).post("/auth/login", { email: "owner@gmail.com", password: password("pw-owner") })).statusCode).toBe(200);
      expect(await googleIdentities()).toBe(0);

      // "Don't link Google" lets it go.
      expect((await second.browser.delete("/auth/pending-link")).json()).toEqual({ ok: true });
      expect((await second.browser.get("/auth/pending-link")).json()).toEqual({ pending: false });
      expect((await second.browser.post("/auth/login", { email: "owner@gmail.com", password: password("pw-owner") })).statusCode).toBe(200);
      expect(await googleIdentities()).toBe(0);

      // Held longer than its quarter of an hour: gone.
      const third = await federated({ id: "g-owner", email: "owner@gmail.com" });
      expect((await third.finish()).json().next).toBe("link");
      advance(16 * 60_000);
      expect((await third.browser.get("/auth/pending-link")).json()).toEqual({ pending: false });
      expect((await third.browser.post("/auth/login", { email: "owner@gmail.com", password: password("pw-owner") })).statusCode).toBe(200);
      expect(await googleIdentities()).toBe(0);
      expect(await systemDb.user.count()).toBe(2);
    });

    it("refuses a second Google account for an account that signs in with another one, creating nothing", async () => {
      const first = await (await federated({ id: "g-a", email: "team@shop.com" })).finish();
      expect(first.statusCode).toBe(200);
      const second = await (await federated({ id: "g-b", email: "team@shop.com" })).finish();
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("google_other_linked");
      expect(second.headers["set-cookie"] ?? "").not.toMatch(/__(session|link)=[^;]/);
      expect(await systemDb.user.count()).toBe(1);
      expect(await systemDb.authIdentity.count()).toBe(1);
    });
  });

  it("never links on an address the provider hasn't verified", async () => {
    await signIn(ctx, "pw-sub", "merchant@x.com");
    const res = await (await federated({ id: "g-5", email: "merchant@x.com", emailVerified: false })).finish();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("email_in_use");
    expect(await systemDb.authIdentity.count()).toBe(1);
  });

  it("goes back only to a page of this site, however the path is written", async () => {
    // Dot segments pass a check of the raw text but resolve to another site ("//evil.example").
    const unsafe = ["//evil.example/x", "/..//evil.example/x", "/%2e%2e//evil.example/x", "/.//evil.example/x", "/a/..//evil.example/x"];
    for (const [i, returnTo] of unsafe.entries()) {
      const res = await (await federated({ id: `g-r${i}`, email: `r${i}@gmail.com` }, "google", returnTo)).finish();
      expect(res.statusCode).toBe(200);
      expect(res.json().redirect).toBeNull();
    }
    // One that stays on this site is kept, as the browser will read it.
    const ok = await (await federated({ id: "g-ok", email: "ok@gmail.com" }, "google", "/settings/../dashboard?view=sales")).finish();
    expect(ok.json().redirect).toBe("/dashboard?view=sales");
  });

  it("won't create an account from an address Google hasn't verified (it could never be verified here)", async () => {
    const res = await (await federated({ id: "g-unverified", email: "unverified@gmail.com", emailVerified: false })).finish();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("email_unverified_provider");
    expect(res.json().message).toMatch(/Google hasn't confirmed/);
    expect(await systemDb.user.count()).toBe(0);
    expect(res.headers["set-cookie"] ?? "").not.toMatch(/__session=[^;]/);
  });

  it("takes over an account whose address was never verified: the password someone else set there stops working", async () => {
    // Anyone can make a workspace, add an employee with someone's address and open the copied
    // invitation link themselves, choosing the password.
    const owner = await signIn(ctx, "owner-sub", "owner@x.com");
    const ws = await createWorkspace(ctx, owner.headers);
    const employee = {
      fullName: "Vic Tim",
      email: "victim@gmail.com",
      jobTitle: "Barista",
      employmentType: "full_time",
      joinedOn: "2026-10-01",
      standardWeeklyMinutes: 2400,
      workingDays: [1, 2, 3, 4, 5],
      hourlyRate: "20",
    };
    const hired = await post(`/workspaces/${ws}/staff/employees`, employee, owner.headers);
    expect(hired.statusCode).toBe(201);
    const invitation = await post(`/workspaces/${ws}/staff/employees/${hired.json().employee.id}/invitations`, { delivery: "link" }, owner.headers);
    const token = decodeURIComponent(/token=([^&]+)/.exec(invitation.json().url)![1]!);
    const accepted = await post("/staff/invitations/accept", { token, password: "Not-Theirs-42", confirmPassword: "Not-Theirs-42" });
    expect(accepted.json().emailVerified).toBe(false);
    const squatter = { cookie: cookiesFrom(accepted), ...ORIGIN };
    expect((await get("/me", squatter)).statusCode).toBe(200);
    const account = await systemDb.user.findUniqueOrThrow({ where: { email: "victim@gmail.com" } });

    // The address's owner signs in with Google, which has verified it.
    const { browser, finish } = await federated({ id: "g-victim", email: "victim@gmail.com", name: "Vic Tim" });
    const res = await finish();
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: account.id, emailVerified: true });
    // The password is gone, in Cognito and here, and so is every session from before.
    expect((await post("/auth/login", { email: "victim@gmail.com", password: "Not-Theirs-42" })).statusCode).toBe(401);
    expect((await get("/me", squatter)).statusCode).toBe(401);
    expect((await systemDb.authIdentity.findMany({ where: { userId: account.id } })).map((i) => i.method)).toEqual(["google"]);
    expect(await systemDb.authEvent.findFirst({ where: { type: "unverified_identity_removed", userId: account.id } })).toMatchObject({
      metadata: { removed: [expect.objectContaining({ method: "password" })], by: expect.objectContaining({ method: "google" }) },
    });
    // The owner of the address is signed in, and stays so.
    expect((await browser.get("/me")).statusCode).toBe(200);
    const again = await (await federated({ id: "g-victim", email: "victim@gmail.com" })).finish();
    expect(again.json().user.id).toBe(account.id);
  });

  it("links a Team & Access invitee's placeholder account (no sign-in yet) as before, ending nothing", async () => {
    const placeholder = await systemDb.user.create({ data: { email: "invitee@gmail.com", emailVerified: false } });
    const res = await (await federated({ id: "g-invitee", email: "invitee@gmail.com" })).finish();
    expect(res.json().user).toMatchObject({ id: placeholder.id, emailVerified: true });
    expect(await systemDb.authEvent.count({ where: { type: "unverified_identity_removed" } })).toBe(0);
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: placeholder.id } })).sessionsValidAfter).toBeNull();
    expect(ctx.auth.calls).not.toContain("adminDeleteUser");
  });

  it("\"Keep me signed in\" unticked carries through Google: cookies that end with the browser", async () => {
    const sessionCookies = (res: { headers: Record<string, string> }) => (res.headers["set-cookie"] ?? "").split(", ").filter((c) => /^__session(_rt)?=[^;]/.test(c));
    const kept = await (await federated({ id: "g-kept", email: "kept@gmail.com" })).finish();
    expect(sessionCookies(kept)).toHaveLength(2);
    for (const cookie of sessionCookies(kept)) expect(cookie).toMatch(/Max-Age=\d+/);

    const browser = testBrowser(ctx);
    const start = await browser.get("/auth/oauth/google/start?keep=0");
    const back = ctx.auth.federatedSignIn(start.headers.location!, { id: "g-brief", email: "brief@gmail.com" });
    const brief = await browser.post("/auth/oauth/callback", { code: back.code, state: back.state });
    expect(brief.statusCode).toBe(200);
    expect(sessionCookies(brief)).toHaveLength(2);
    for (const cookie of sessionCookies(brief)) expect(cookie).not.toMatch(/Max-Age/);
    // The minute's re-check keeps it that way.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + REVALIDATE_MS + 1_000);
    const rechecked = await browser.get("/me");
    expect(rechecked.statusCode).toBe(200);
    expect(sessionCookies(rechecked).length).toBeGreaterThan(0);
    for (const cookie of sessionCookies(rechecked)) expect(cookie).not.toMatch(/Max-Age/);
  });

  it("keeps the name from the first sign-in when the provider later sends none", async () => {
    const first = await (await federated({ id: "g-6", email: "grace@gmail.com", name: "Grace Hopper" })).finish();
    expect(first.json().user).toMatchObject({ email: "grace@gmail.com", displayName: "Grace Hopper" });
    ctx.auth.users.get("google_g-6")!.name = null;
    const second = await (await federated({ id: "g-6", email: "grace@gmail.com" })).finish();
    expect(second.json().user).toMatchObject({ id: first.json().user.id, displayName: "Grace Hopper" });
    expect(await systemDb.user.count()).toBe(1);
  });

  it("keeps the picture current from Google, and keeps the one there is when Google sends none", async () => {
    const [one, two] = ["https://lh3.googleusercontent.com/a/one", "https://lh3.googleusercontent.com/a/two"];
    const first = await (await federated({ id: "g-pic", email: "pic@gmail.com", picture: one })).finish();
    expect(first.json().user.avatarUrl).toBe(one);
    ctx.auth.users.get("google_g-pic")!.picture = two;
    const second = await (await federated({ id: "g-pic", email: "pic@gmail.com" })).finish();
    expect(second.json().user).toMatchObject({ id: first.json().user.id, avatarUrl: two });
    ctx.auth.users.get("google_g-pic")!.picture = null;
    expect((await (await federated({ id: "g-pic", email: "pic@gmail.com" })).finish()).json().user.avatarUrl).toBe(two);
    expect((await systemDb.user.findUniqueOrThrow({ where: { email: "pic@gmail.com" } })).avatarUrl).toBe(two);
  });

  it("refuses a state from another browser, a replayed one, a cancelled sign-in and a doctored code", async () => {
    const a = await federated({ id: "g-3", email: "c@gmail.com" });
    // Another browser (no __oauth cookie) presenting this sign-in's code and state: login CSRF.
    const elsewhere = await testBrowser(ctx).post("/auth/oauth/callback", { code: a.back.code, state: a.back.state });
    expect(elsewhere.json().error).toBe("state_mismatch");

    const b = await federated({ id: "g-3", email: "c@gmail.com" });
    expect((await b.browser.post("/auth/oauth/callback", { code: "doctored", state: b.back.state })).json().error).toBe("code_invalid");
    // Used up either way.
    expect((await b.browser.post("/auth/oauth/callback", { code: b.back.code, state: b.back.state })).json().error).toBe("state_mismatch");

    const c = await federated({ id: "g-3", email: "c@gmail.com" });
    const cancelled = await c.browser.post("/auth/oauth/callback", { state: c.back.state, error: "access_denied" });
    expect(cancelled.json().error).toBe("cancelled");
    expect(await systemDb.user.count()).toBe(0);
  });

  it("needs an email address from the provider", async () => {
    const res = await (await federated({ id: "g-7", email: null })).finish();
    expect(res.json().error).toBe("email_required");
  });

  it("sends a provider that isn't switched on to the sign-in error page", async () => {
    restore();
    // Google's client isn't configured, and Apple sign-in is gone.
    restore = withEnv({ GOOGLE_SIGNIN_CLIENT_ID: "", GOOGLE_SIGNIN_CLIENT_SECRET: "" });
    expect((await get("/auth/oauth/google/start")).headers.location).toBe("http://localhost:3001/auth/error?reason=provider_unavailable&provider=google");
    expect((await get("/auth/oauth/apple/start")).headers.location).toBe("http://localhost:3001/auth/error?reason=provider_unavailable&provider=apple");
    expect((await get("/auth/config")).json()).toEqual({ providers: { google: false }, emailOtp: false, loginCode: false });
  });

  it("signs out of the user pool's own session too after a federated sign-in", async () => {
    const { browser, finish } = await federated({ id: "g-4", email: "d@gmail.com" });
    await finish();
    const out = await browser.post("/auth/logout");
    expect(out.json().redirect).toMatch(/^https:\/\/auth\.example\.test\/logout\?/);
    expect((await browser.get("/me")).statusCode).toBe(401);
  });
});

describe("sessions over time", () => {
  it("re-checks with Cognito after a while: a disabled user is signed out, an outage is not", async () => {
    const { headers, user } = await signIn(ctx, "u1", "a@x.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    ctx.auth.state.refreshUnavailable = true;
    expect((await get("/me", headers)).statusCode).toBe(200);
    ctx.auth.state.refreshUnavailable = false;
    const fresh = await get("/me", headers);
    expect(fresh.statusCode).toBe(200);
    // Checked: the session cookie is re-issued with the new check time.
    expect(fresh.headers["set-cookie"]).toMatch(/__session=/);

    vi.setSystemTime(Date.now() + 11 * 60_000);
    ctx.auth.users.get("u1")!.enabled = false;
    const gone = await get("/me", headers);
    expect(gone.statusCode).toBe(401);
    expect(gone.headers["set-cookie"]).toMatch(/__session=;.*Max-Age=0/);
    expect(user.id).toBeTruthy();
  });

  it("signs out an account deleted in Cognito itself (console, CLI) within a minute, though its user is still here", async () => {
    const { headers } = await signIn(ctx, "u1", "a@x.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    ctx.auth.users.delete("u1");
    vi.setSystemTime(Date.now() + REVALIDATE_MS / 2);
    // Between checks the session is only our signed cookie: no call to Cognito on every request.
    expect((await get("/me", headers)).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + REVALIDATE_MS / 2 + 1_000);
    const gone = await get("/me", headers);
    expect(gone.statusCode).toBe(401);
    expect(gone.headers["set-cookie"]).toMatch(/__session=;.*Max-Age=0/);
    expect(REVALIDATE_MS).toBeLessThanOrEqual(60_000);
  });

  it("signs out everywhere: every session of the account and every Cognito refresh token", async () => {
    const laptop = await signIn(ctx, "u1", "a@x.com");
    const phone = await signIn(ctx, "u1", "a@x.com");
    const res = await post("/auth/logout-all", {}, laptop.headers);
    expect(res.statusCode).toBe(200);
    expect((await get("/me", phone.headers)).statusCode).toBe(401);
    expect((await get("/me", laptop.headers)).statusCode).toBe(401);
    expect(ctx.auth.calls).toContain("adminGlobalSignOut");
    // Signing in again afterwards works.
    expect((await get("/me", (await signIn(ctx, "u1", "a@x.com")).headers)).statusCode).toBe(200);
  });
});

describe("account security", () => {
  it("changes the password: the old one stops working, other devices are signed out, this one isn't", async () => {
    const here = await signIn(ctx, "u1", "a@x.com");
    const there = await signIn(ctx, "u1", "a@x.com");
    const old = ctx.auth.users.get("u1")!.password!;
    const change = (currentPassword: string, password = "a-better-password", confirmPassword = password) =>
      post("/auth/account/password", { currentPassword, password, confirmPassword }, here.headers);
    expect((await change("not-the-password")).json().error).toBe("wrong_password");
    expect((await change(old, "short")).json().error).toBe("weak_password");
    const sentBefore = ctx.mailer.sent.length;
    const res = await change(old);
    expect(res.statusCode).toBe(200);
    const nowHere = { cookie: cookiesFrom(res), ...ORIGIN };
    expect((await get("/me", nowHere)).statusCode).toBe(200);
    expect((await get("/me", there.headers)).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "a@x.com", password: old })).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "a@x.com", password: "a-better-password" })).statusCode).toBe(200);
    // The account's address hears of it (only the change that went through).
    expect(ctx.mailer.sent.slice(sentBefore)).toEqual([expect.objectContaining({ to: "a@x.com", subject: "Your bizinsights password was changed" })]);
  });

  it("tells the old address when the email changes, and signs out every other device but keeps this one", async () => {
    const here = await signIn(ctx, "u1", "a@x.com");
    const there = await signIn(ctx, "u1", "a@x.com");
    const password = ctx.auth.users.get("u1")!.password!;
    expect((await post("/auth/account/email", { email: "new@x.com", password }, here.headers)).statusCode).toBe(200);
    const sentBefore = ctx.mailer.sent.length;
    const done = await post("/auth/account/email/confirm", { code: ctx.auth.code("verify", "new@x.com") }, here.headers);
    expect(done.statusCode).toBe(200);
    // This browser carries on under its new session cookie; the old one and the other device's are refused.
    const nowHere = { cookie: cookiesFrom(done), ...ORIGIN };
    expect((await get("/me", nowHere)).json().user.email).toBe("new@x.com");
    expect((await get("/me", there.headers)).statusCode).toBe(401);
    expect((await get("/me", here.headers)).statusCode).toBe(401);
    // Its device stays listed as signed in; the other one doesn't.
    const devices = await systemDb.userSession.findMany({ where: { userId: here.user.id, endedAt: null } });
    expect(devices).toHaveLength(1);
    const session = nowHere.cookie.split("; ").find((c) => c.startsWith("__session="))!.slice("__session=".length);
    expect(readSession(session)!.sid).toBe(devices[0]!.sid);
    // Only the old address is told, and it sees the new one masked.
    const notice = ctx.mailer.sent.slice(sentBefore);
    expect(notice).toEqual([expect.objectContaining({ to: "a@x.com", subject: "The email address of your bizinsights account was changed" })]);
    expect(notice[0]!.text).toContain("n***w@x.com");
    expect(notice[0]!.text).not.toContain("new@x.com");
    expect(notice[0]!.text).toContain("http://localhost:3001/support");
  });

  it("changes the email only after a code sent to the new address, and never onto someone else's", async () => {
    const { headers, user } = await signIn(ctx, "u1", "a@x.com");
    await signIn(ctx, "u2", "taken@x.com");
    const password = ctx.auth.users.get("u1")!.password!;
    expect((await post("/auth/account/email", { email: "new@x.com" }, headers)).json().error).toBe("password_required");
    expect((await post("/auth/account/email", { email: "taken@x.com", password }, headers)).json().error).toBe("email_in_use");
    expect((await post("/auth/account/email", { email: "new@x.com", password }, headers)).json()).toEqual({ ok: true, pendingEmail: "new@x.com" });
    // Not changed until confirmed.
    expect((await get("/me", headers)).json().user.email).toBe("a@x.com");
    const code = ctx.auth.code("verify", "new@x.com");
    const done = await post("/auth/account/email/confirm", { code }, headers);
    expect(done.json().user).toMatchObject({ id: user.id, email: "new@x.com", emailVerified: true });
    expect((await post("/auth/login", { email: "new@x.com", password })).json().user.id).toBe(user.id);
    expect(await systemDb.authEvent.count({ where: { type: "email_changed" } })).toBe(1);
  });

  it("lists how the account signs in, and has no password to change after Google", async () => {
    const restore = withEnv({ GOOGLE_SIGNIN_CLIENT_ID: "test-google-client", GOOGLE_SIGNIN_CLIENT_SECRET: "test-google-secret" });
    try {
      const browser = testBrowser(ctx);
      const start = await browser.get("/auth/oauth/google/start");
      const back = ctx.auth.federatedSignIn(start.headers.location!, { id: "g-9", email: "g@gmail.com" });
      await browser.post("/auth/oauth/callback", { code: back.code, state: back.state });
      const account = (await browser.get("/auth/account")).json();
      expect(account).toMatchObject({ signedInWith: "google", canChangePassword: false, methods: [expect.objectContaining({ method: "google" })] });
      const res = await browser.post("/auth/account/password", { currentPassword: "x", password: "a-better-password", confirmPassword: "a-better-password" });
      expect(res.json().error).toBe("no_password");
    } finally {
      restore();
    }
  });

  it("deletes the account and its sign-in with a code emailed to its address, and refuses while a workspace it is the only owner of isn't confirmed", async () => {
    const owner = await signIn(ctx, "u1", "a@x.com");
    const password = ctx.auth.users.get("u1")!.password!;
    const ws = await createWorkspace(ctx, owner.headers, "Solo Shop");
    const del = (payload: Record<string, unknown>) => post("/auth/account/delete", payload, owner.headers);
    const askForCode = () => post("/auth/account/delete/code", {}, owner.headers);
    // The password no longer deletes it: the emailed code does, and none was asked for yet.
    expect((await del({ confirm: "DELETE", password })).statusCode).toBe(400);
    expect((await del({ confirm: "DELETE", code: "123456" })).json().error).toBe("code_required");
    // The only owner is shown the workspace that would go with it (workspaceDeletion.test.ts deletes one).
    expect((await get("/auth/account/deletion", owner.headers)).json()).toMatchObject({ workspaces: [{ id: ws, name: "Solo Shop", paidPlan: null }] });

    // A second owner takes over; the code goes to the account's address, from the support sender.
    const partner = await signIn(ctx, "u2", "b@x.com");
    const second = await systemDb.membership.create({ data: { workspaceId: ws, userId: partner.user.id, role: "owner" } });
    const asked = await askForCode();
    expect(asked.json()).toMatchObject({ ok: true, challenge: { expiresAt: expect.any(Number), resendAt: expect.any(Number) } });
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ to: "a@x.com", subject: "Confirm deleting your bizinsights account" });
    const code = emailedDeletionCode(ctx, "a@x.com");
    // Another one only after the minute.
    expect((await askForCode()).json().error).toBe("resend_cooldown");
    expect((await del({ confirm: "DELETE", code: String((Number(code) + 1) % 1_000_000).padStart(6, "0") })).json().error).toBe("invalid_code");
    expect((await del({ confirm: "delete", code })).statusCode).toBe(400);
    // Left the only owner after the code was sent: refused until that workspace is confirmed too, and the code isn't spent by the refusal.
    await systemDb.membership.delete({ where: { id: second.id } });
    expect((await del({ confirm: "DELETE", code })).json()).toMatchObject({ error: "sole_owner", workspaces: ["Solo Shop"], owned: [{ id: ws }] });
    await systemDb.membership.create({ data: { workspaceId: ws, userId: partner.user.id, role: "owner" } });
    const res = await del({ confirm: "DELETE", code });
    expect(res.statusCode).toBe(200);
    expect(await systemDb.user.findUnique({ where: { id: owner.user.id } })).toBeNull();
    expect(ctx.auth.users.has("u1")).toBe(false);
    expect((await get("/me", owner.headers)).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "a@x.com", password })).statusCode).toBe(401);
    // The workspace and the other owner are untouched; the event keeps no link to the person.
    expect((await systemDb.membership.findMany({ where: { workspaceId: ws } })).map((m) => m.userId)).toEqual([partner.user.id]);
    expect(await systemDb.authEvent.findFirst({ where: { type: "account_deleted" } })).toMatchObject({ userId: null });
  });

  it("shows a sole owner every workspace that goes with the account, and deletes them only once all are confirmed", async () => {
    const owner = await signIn(ctx, "u1", "a@x.com");
    const solo = await createWorkspace(ctx, owner.headers, "Solo Shop");
    const second = await createWorkspace(ctx, owner.headers, "Second Shop");
    const listed = (await get("/auth/account/deletion", owner.headers)).json().workspaces as Array<{ id: string }>;
    expect(listed.map((w) => w.id).sort()).toEqual([solo, second].sort());
    // The code is sent: the dialog sends the confirmed list back with it.
    expect((await post("/auth/account/delete/code", {}, owner.headers)).json()).toMatchObject({ ok: true });
    const code = emailedDeletionCode(ctx, "a@x.com");
    const del = (workspaces: string[]) => post("/auth/account/delete", { confirm: "DELETE", code, workspaces }, owner.headers);
    // One of the two confirmed: refused with both named and what to do, and the code isn't spent.
    const one = await del([solo]);
    expect(one.statusCode).toBe(409);
    expect(one.json()).toMatchObject({ error: "sole_owner", workspaces: expect.arrayContaining(["Solo Shop", "Second Shop"]), owned: expect.arrayContaining([expect.objectContaining({ id: second })]) });
    expect(one.json().message).toMatch(
      /^You're the only owner of (Solo Shop, Second Shop|Second Shop, Solo Shop)\. Deleting your account deletes those workspaces and their stores' data too: confirm that in the Delete account dialog, or make someone else an owner first\.$/,
    );
    expect(await systemDb.workspace.count({ where: { id: { in: [solo, second] } } })).toBe(2);
    expect((await del([second, solo])).statusCode).toBe(200);
    expect(await systemDb.workspace.count({ where: { id: { in: [solo, second] } } })).toBe(0);
    expect(await systemDb.user.findUnique({ where: { id: owner.user.id } })).toBeNull();
  });
});

describe("signing in with an emailed code (Cognito EMAIL_OTP)", () => {
  it("is off unless switched on", async () => {
    expect((await post("/auth/otp/start", { email: "a@x.com" })).statusCode).toBe(404);
  });

  it("sends a code, signs in with it once, and answers unknown addresses the same", async () => {
    const restore = withEnv({ AUTH_EMAIL_OTP: "1" });
    try {
      const u = ctx.auth.addUser({ email: "a@x.com" });
      const browser = testBrowser(ctx);
      const started = await browser.post("/auth/otp/start", { email: "a@x.com" });
      expect(started.json()).toEqual((await post("/auth/otp/start", { email: "nobody@x.com" })).json());
      expect((await browser.post("/auth/otp/verify", { email: "a@x.com", code: "000000" })).json().error).toBe("invalid_code");
      const res = await browser.post("/auth/otp/verify", { email: "a@x.com", code: ctx.auth.code("otp", "a@x.com") });
      expect(res.statusCode).toBe(200);
      expect((await userOf(u.sub)).email).toBe("a@x.com");
    } finally {
      restore();
    }
  });
});
