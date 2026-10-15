import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@app/core";
import { systemDb } from "@app/db";
import { buildApp } from "../src/app.js";
import { unconfiguredCognito } from "../src/cognito.js";
import { signSession, readSession, REVALIDATE_MS } from "../src/session.js";
import { clean, cookiesFrom, createWorkspace, ORIGIN, setup, signIn, teardown, testBrowser, userOf, type TestCtx } from "./helpers.js";

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
    expect((await post("/auth/signup/confirm", { email: "ada@example.com", code: "000000" })).json().error).toBe("invalid_code");
    expect((await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com") })).statusCode).toBe(200);

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
    expect(user.firebaseUid).toBeNull();
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
    await signup();
    const again = await signup();
    expect(again.statusCode).toBe(200);
    expect(again.json().next).toBe("confirm");
    expect(ctx.auth.sent.filter((s) => s.kind === "signup")).toHaveLength(2);

    await post("/auth/signup/confirm", { email: "ada@example.com", code: ctx.auth.code("signup", "ada@example.com") });
    const taken = await signup();
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("account_exists");
  });

  it("resends a code without saying whether the address has an account", async () => {
    await signup();
    const known = await post("/auth/signup/resend", { email: "ada@example.com" });
    const unknown = await post("/auth/signup/resend", { email: "nobody@example.com" });
    expect(known.json()).toEqual(unknown.json());
    expect(known.statusCode).toBe(unknown.statusCode);
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

  it("answers 'try again' while Cognito isn't configured, instead of signing anyone in or out", async () => {
    const app = buildApp({ ...ctx.deps, auth: unconfiguredCognito() });
    const res = await app.request("/auth/login", { method: "POST", headers: { ...ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "a@x.com", password: "whatever-it-is" }) });
    expect(res.status).toBe(503);
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

  it("answers an unknown address exactly like a known one", async () => {
    ctx.auth.addUser({ email: "a@x.com" });
    const known = await post("/auth/password/forgot", { email: "a@x.com" });
    const unknown = await post("/auth/password/forgot", { email: "nobody@x.com" });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(ctx.auth.sent.map((s) => s.email)).toEqual(["a@x.com"]);
  });
});

describe("moving accounts over from Firebase", () => {
  /** A merchant from before the move: a users row with its Firebase uid, a workspace, a Firebase password. */
  async function firebaseMerchant(opts: { password?: string; emailVerified?: boolean } = {}) {
    const user = await systemDb.user.create({ data: { firebaseUid: "fb-1", email: "old@x.com", emailVerified: opts.emailVerified ?? true, displayName: "Old Timer" } });
    const ws = await systemDb.workspace.create({ data: { name: "Old Shop", memberships: { create: { userId: user.id, role: "owner" } } } });
    ctx.legacy.accounts.set("old@x.com", { uid: "fb-1", password: opts.password ?? "their-old-password", emailVerified: opts.emailVerified ?? true, displayName: "Old Timer" });
    return { user, ws };
  }

  it("signs in with the Firebase password once, creates the Cognito user with it, and keeps users.id and everything it owns", async () => {
    const { user, ws } = await firebaseMerchant();
    const login = await post("/auth/login", { email: "old@x.com", password: "their-old-password" });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.id).toBe(user.id);
    const me = await get("/me", { cookie: cookiesFrom(login) });
    expect(me.json().workspaces).toEqual([expect.objectContaining({ id: ws.id, role: "owner" })]);

    const cognitoUser = [...ctx.auth.users.values()].find((u) => u.email === "old@x.com")!;
    expect(cognitoUser.password).toBe("their-old-password");
    const identity = await systemDb.authIdentity.findFirstOrThrow({ where: { userId: user.id } });
    expect(identity).toMatchObject({ subject: cognitoUser.sub, migratedFromFirebaseUid: "fb-1", method: "password" });
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: user.id } })).firebaseUid).toBe("fb-1");
    expect(await systemDb.authEvent.count({ where: { type: "firebase_account_migrated", userId: user.id } })).toBe(1);

    // From now on Cognito alone answers (Firebase isn't asked, even with a wrong password).
    ctx.auth.calls.length = 0;
    ctx.legacy.down = true;
    expect((await post("/auth/login", { email: "old@x.com", password: "their-old-password" })).statusCode).toBe(200);
    expect((await post("/auth/login", { email: "old@x.com", password: "not-it-at-all" })).statusCode).toBe(401);
    expect(await systemDb.user.count()).toBe(1);
    expect(await systemDb.authIdentity.count()).toBe(1);
  });

  it("creates nothing when Firebase doesn't accept the password either", async () => {
    await firebaseMerchant();
    const res = await post("/auth/login", { email: "old@x.com", password: "a-wrong-guess" });
    expect(res.statusCode).toBe(401);
    expect(ctx.auth.users.size).toBe(0);
  });

  it("never asks Firebase about an address Cognito already knows", async () => {
    await firebaseMerchant();
    ctx.auth.addUser({ email: "old@x.com", password: "the-cognito-one" });
    expect((await post("/auth/login", { email: "old@x.com", password: "their-old-password" })).statusCode).toBe(401);
  });

  it("says 'try again', not 'wrong password', when Firebase can't be asked", async () => {
    await firebaseMerchant();
    ctx.legacy.down = true;
    const res = await post("/auth/login", { email: "old@x.com", password: "their-old-password" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("auth_unavailable");
  });

  it("moves a password too short for Cognito by sending a reset code, then keeps the same user", async () => {
    const { user } = await firebaseMerchant({ password: "abc123" });
    const res = await post("/auth/login", { email: "old@x.com", password: "abc123" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("reset_required");
    const code = ctx.auth.code("reset", "old@x.com");
    expect((await post("/auth/password/reset", { email: "old@x.com", code, password: "a-longer-one", confirmPassword: "a-longer-one" })).statusCode).toBe(200);
    const login = await post("/auth/login", { email: "old@x.com", password: "a-longer-one" });
    expect(login.json().user.id).toBe(user.id);
  });

  it("lets someone who never signs in during the window reset their password, and keeps their user", async () => {
    const { user } = await firebaseMerchant();
    // Migration window over: Firebase is no longer consulted at all.
    const app = buildApp({ ...ctx.deps, legacy: null });
    const send = (url: string, payload: unknown) => app.request(url, { method: "POST", headers: { ...ORIGIN, "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect((await send("/auth/login", { email: "old@x.com", password: "their-old-password" })).status).toBe(401);
    expect((await send("/auth/password/forgot", { email: "old@x.com" })).status).toBe(200);
    const code = ctx.auth.code("reset", "old@x.com");
    expect((await send("/auth/password/reset", { email: "old@x.com", code, password: "fresh-password", confirmPassword: "fresh-password" })).status).toBe(200);
    const login = await send("/auth/login", { email: "old@x.com", password: "fresh-password" });
    expect(((await login.json()) as { user: { id: string } }).user.id).toBe(user.id);
  });

  it("keeps an unverified Firebase address unverified until the code Cognito sends to it is entered", async () => {
    const { user } = await firebaseMerchant({ emailVerified: false });
    const login = await post("/auth/login", { email: "old@x.com", password: "their-old-password" });
    expect(login.json().user).toMatchObject({ id: user.id, emailVerified: false });
    const headers = { cookie: cookiesFrom(login) };
    expect((await post("/auth/account/verify-email/send", {}, headers)).statusCode).toBe(200);
    const code = ctx.auth.code("verify", "old@x.com");
    const verified = await post("/auth/account/verify-email", { code }, headers);
    expect(verified.json().user.emailVerified).toBe(true);
  });
});

describe("Continue with Google / Apple", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "Google,SignInWithApple" });
  });
  afterEach(() => restore());

  async function federated(person: { id: string; email: string | null; emailVerified?: boolean; name?: string }, provider = "google", returnTo?: string) {
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

  it("signs a new person in, creates their user, and goes back where they were headed", async () => {
    const { browser, finish } = await federated({ id: "g-1", email: "new@gmail.com", name: "New Person" }, "google", "/settings/stores?x=1");
    const res = await finish();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { email: "new@gmail.com", emailVerified: true, displayName: "New Person" }, redirect: "/settings/stores?x=1" });
    expect((await browser.get("/me")).statusCode).toBe(200);
    expect((await systemDb.authIdentity.findFirstOrThrow()).method).toBe("google");
  });

  it("links Google to the existing account with the same verified address (no duplicate)", async () => {
    const { user, headers } = await signIn(ctx, "pw-sub", "merchant@gmail.com");
    const ws = await createWorkspace(ctx, headers);
    const res = await (await federated({ id: "g-2", email: "merchant@gmail.com" })).finish();
    expect(res.json().user.id).toBe(user.id);
    expect(await systemDb.user.count()).toBe(1);
    expect(await systemDb.authIdentity.count({ where: { userId: user.id } })).toBe(2);
    expect(await systemDb.authEvent.count({ where: { type: "identity_linked", userId: user.id } })).toBe(1);
    const again = await (await federated({ id: "g-2", email: "merchant@gmail.com" })).finish();
    expect(again.json().user.id).toBe(user.id);
    expect((await systemDb.membership.findFirstOrThrow({ where: { workspaceId: ws } })).userId).toBe(user.id);
  });

  it("never links on an address the provider hasn't verified", async () => {
    await signIn(ctx, "pw-sub", "merchant@x.com");
    const res = await (await federated({ id: "a-1", email: "merchant@x.com", emailVerified: false }, "apple")).finish();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("email_in_use");
    expect(await systemDb.authIdentity.count()).toBe(1);
  });

  it("handles Apple's private relay address, and the name Apple sends only the first time", async () => {
    const relay = "x7g2k9@privaterelay.appleid.com";
    const first = await (await federated({ id: "a-2", email: relay, name: "Grace Hopper" }, "apple")).finish();
    expect(first.json().user).toMatchObject({ email: relay, displayName: "Grace Hopper" });
    ctx.auth.users.get("signinwithapple_a-2")!.name = null;
    const second = await (await federated({ id: "a-2", email: relay }, "apple")).finish();
    expect(second.json().user).toMatchObject({ id: first.json().user.id, displayName: "Grace Hopper" });
    expect(await systemDb.user.count()).toBe(1);
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
    const res = await (await federated({ id: "a-3", email: null }, "apple")).finish();
    expect(res.json().error).toBe("email_required");
  });

  it("sends a provider that isn't switched on to the sign-in error page", async () => {
    restore();
    restore = withEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "Google" });
    const res = await get("/auth/oauth/apple/start");
    expect(res.headers.location).toBe("http://localhost:3001/auth/error?reason=provider_unavailable&provider=apple");
    expect((await get("/auth/config")).json()).toEqual({ providers: { google: true, apple: false }, emailOtp: false });
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
    const res = await change(old);
    expect(res.statusCode).toBe(200);
    const nowHere = { cookie: cookiesFrom(res), ...ORIGIN };
    expect((await get("/me", nowHere)).statusCode).toBe(200);
    expect((await get("/me", there.headers)).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "a@x.com", password: old })).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "a@x.com", password: "a-better-password" })).statusCode).toBe(200);
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
    const restore = withEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "Google" });
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

  it("deletes the account and its sign-in, but not while it is a workspace's only owner", async () => {
    const owner = await signIn(ctx, "u1", "a@x.com");
    const password = ctx.auth.users.get("u1")!.password!;
    const ws = await createWorkspace(ctx, owner.headers, "Solo Shop");
    const del = (payload: Record<string, unknown>) => post("/auth/account/delete", payload, owner.headers);
    expect((await del({ confirm: "DELETE" })).json().error).toBe("password_required");
    const blocked = await del({ confirm: "DELETE", password });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "sole_owner", workspaces: ["Solo Shop"] });

    // A second owner takes over.
    const partner = await signIn(ctx, "u2", "b@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: partner.user.id, role: "owner" } });
    const res = await del({ confirm: "DELETE", password });
    expect(res.statusCode).toBe(200);
    expect(await systemDb.user.findUnique({ where: { id: owner.user.id } })).toBeNull();
    expect(ctx.auth.users.has("u1")).toBe(false);
    expect((await get("/me", owner.headers)).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "a@x.com", password })).statusCode).toBe(401);
    // The workspace and the other owner are untouched; the event keeps no link to the person.
    expect((await systemDb.membership.findMany({ where: { workspaceId: ws } })).map((m) => m.userId)).toEqual([partner.user.id]);
    expect(await systemDb.authEvent.findFirst({ where: { type: "account_deleted" } })).toMatchObject({ userId: null });
  });
});

describe("signing in with an emailed code (Cognito EMAIL_OTP)", () => {
  it("is off unless switched on", async () => {
    expect((await post("/auth/otp/start", { email: "a@x.com" })).statusCode).toBe(404);
  });

  it("sends a code, signs in with it once, and answers unknown addresses the same", async () => {
    const restore = withEnv({ COGNITO_EMAIL_OTP: "1" });
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
