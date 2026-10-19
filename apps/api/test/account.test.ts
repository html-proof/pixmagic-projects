import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@app/core";
import { systemDb } from "@app/db";
import { CognitoError } from "../src/cognito.js";
import { newLinkSession, signSession } from "../src/session.js";
import { clean, cookiesFrom, createWorkspace, ORIGIN, setup, signIn, teardown, testBrowser, type TestCtx } from "./helpers.js";

/**
 * Settings → Security's sign-in methods: adding a password to a Google account, linking a Google
 * account (whatever its address) to a signed-in one, and removing a method.
 */

let ctx: TestCtx;
let restore: () => void;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => {
  await clean(ctx);
  restore = withEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "Google" });
});
afterEach(() => {
  restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => ctx.app.inject({ method: "POST", url, headers: { ...ORIGIN, ...headers }, payload });
const get = (url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: "GET", url, headers });
const del = (url: string, headers: Record<string, string>, payload: unknown = {}) => ctx.app.inject({ method: "DELETE", url, headers: { ...ORIGIN, ...headers }, payload });

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

/** Continue with Google in a fresh browser (signing in, or creating the account). */
async function googleSignIn(person: { id: string; email: string }) {
  const browser = testBrowser(ctx);
  const start = await browser.get("/auth/oauth/google/start");
  const back = ctx.auth.federatedSignIn(start.headers.location!, person);
  const res = await browser.post("/auth/oauth/callback", { code: back.code, state: back.state });
  expect(res.statusCode).toBe(200);
  return { browser, user: res.json().user as { id: string } };
}

/** Start linking Google from Settings in `browser`, as the page does: its answer names the provider's address, or why not. */
const startLink = (browser: ReturnType<typeof testBrowser>, returnTo = "/settings/integrations") => browser.post("/auth/oauth/google/link", { returnTo });

/** Link Google from Settings in `browser` (signed in already): the start's answer and the callback's. */
async function linkGoogle(browser: ReturnType<typeof testBrowser>, person: { id: string; email: string }, returnTo = "/settings/integrations") {
  const start = await startLink(browser, returnTo);
  if (start.statusCode !== 200) return { start, res: null };
  const back = ctx.auth.federatedSignIn(start.json().redirect, person);
  return { start, res: await browser.post("/auth/oauth/callback", { code: back.code, state: back.state }) };
}

const cookieOf = (browser: ReturnType<typeof testBrowser>) => [...browser.jar].map(([k, v]) => `${k}=${v}`).join("; ");

describe("GET /auth/account", () => {
  it("lists each method with its id, whether there is a password, and whether Google can be linked", async () => {
    const browser = testBrowser(ctx);
    await browser.signIn("u1", "a@x.com");
    const account = (await browser.get("/auth/account")).json();
    expect(account).toMatchObject({ signedInWith: "password", hasPassword: true, canLinkGoogle: true, canChangePassword: true, mfaEnabled: false });
    expect(account.methods).toEqual([{ id: expect.any(String), method: "password", email: "a@x.com", linkedAt: expect.any(String), lastUsedAt: expect.any(String) }]);
    expect((await linkGoogle(browser, { id: "g-1", email: "a.other@gmail.com" })).res!.statusCode).toBe(200);
    expect((await browser.get("/auth/account")).json()).toMatchObject({ canLinkGoogle: false, methods: [{ method: "password" }, { method: "google", email: "a.other@gmail.com" }] });
    // Google switched off for the deployment: nothing to link.
    restore();
    restore = withEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "" });
    const other = testBrowser(ctx);
    await other.signIn("u2", "b@x.com");
    expect((await other.get("/auth/account")).json().canLinkGoogle).toBe(false);
  });
});

describe("adding a password to a Google account", () => {
  it("creates the password for the account's address and links it: both ways sign in to the same account", async () => {
    const { browser, user } = await googleSignIn({ id: "g-1", email: "merchant@gmail.com" });
    expect((await browser.get("/auth/account")).json()).toMatchObject({ signedInWith: "google", hasPassword: false, canChangePassword: false });
    const add = (password: string, confirmPassword = password) => browser.post("/auth/account/password/add", { password, confirmPassword });
    expect((await add("short")).json().error).toBe("weak_password");
    expect((await add("a-good-password", "another-password")).json().error).toBe("password_mismatch");
    const res = await add("a-good-password");
    expect(res.statusCode).toBe(200);
    expect((await browser.get("/auth/account")).json()).toMatchObject({ hasPassword: true, methods: [{ method: "google" }, { method: "password", email: "merchant@gmail.com" }] });
    const login = await post("/auth/login", { email: "merchant@gmail.com", password: "a-good-password" });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.id).toBe(user.id);
    expect(await systemDb.authEvent.findFirst({ where: { type: "identity_linked", userId: user.id } })).toMatchObject({ metadata: expect.objectContaining({ method: "password", via: "settings" }) });
    // Once is enough.
    expect((await add("a-good-password")).json().error).toBe("password_exists");
    // Signed in with Google, a password change points to the password's own ways.
    const change = await browser.post("/auth/account/password", { currentPassword: "x", password: "a-better-password", confirmPassword: "a-better-password" });
    expect(change.json()).toMatchObject({ error: "no_password", message: expect.stringMatching(/sign in with your email and password/) });
  });

  it("needs a Google sign-in in the last few minutes", async () => {
    const { browser } = await googleSignIn({ id: "g-1", email: "merchant@gmail.com" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const res = await browser.post("/auth/account/password/add", { password: "a-good-password", confirmPassword: "a-good-password" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("reauth_required");
    expect(ctx.auth.calls).not.toContain("adminCreateUser");
  });

  it("replaces someone's unfinished sign-up with that address, whose password would otherwise win", async () => {
    const { browser, user } = await googleSignIn({ id: "g-1", email: "merchant@gmail.com" });
    // Someone else typed the address on the sign-up page and never got the code.
    await post("/auth/signup", { name: "Not Them", email: "merchant@gmail.com", password: "squatters-password", confirmPassword: "squatters-password", acceptTerms: true });
    const res = await browser.post("/auth/account/password/add", { password: "a-good-password", confirmPassword: "a-good-password" });
    expect(res.statusCode).toBe(200);
    expect((await post("/auth/login", { email: "merchant@gmail.com", password: "squatters-password" })).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "merchant@gmail.com", password: "a-good-password" })).json().user.id).toBe(user.id);
  });

  it("points to the existing password when the address already has one in Cognito", async () => {
    const { browser } = await googleSignIn({ id: "g-1", email: "merchant@gmail.com" });
    // Confirmed sign-up that never signed in (so not linked yet).
    ctx.auth.addUser({ email: "merchant@gmail.com", password: "their-own-password" });
    const res = await browser.post("/auth/account/password/add", { password: "a-good-password", confirmPassword: "a-good-password" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("password_exists");
    expect((await post("/auth/login", { email: "merchant@gmail.com", password: "their-own-password" })).statusCode).toBe(200);
  });
});

describe("linking Google from Settings", () => {
  it("links a Google account with another address to the signed-in account, which keeps its session", async () => {
    const browser = testBrowser(ctx);
    const user = await browser.signIn("u1", "owner@shop.com");
    const { start, res } = await linkGoogle(browser, { id: "g-1", email: "owner.personal@gmail.com" });
    const authorize = new URL(start.json().redirect);
    expect(authorize.searchParams.get("identity_provider")).toBe("Google");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    // Google's account chooser every time: the person picks the account, the browser's doesn't just go.
    expect(authorize.searchParams.get("prompt")).toBe("select_account");
    expect(res!.statusCode).toBe(200);
    expect(res!.json()).toEqual({ linked: "google", redirect: "/settings/integrations?linked=google" });
    // No second session: the Google sign-in's refresh token went straight back.
    expect(res!.headers["set-cookie"] ?? "").not.toMatch(/__session=[^;]/);
    expect(ctx.auth.calls).toContain("revokeRefreshToken");
    expect((await browser.get("/auth/session")).json()).toMatchObject({ authenticated: true, method: "password" });
    expect(await systemDb.authEvent.findFirst({ where: { type: "identity_linked", userId: user.id } })).toMatchObject({ metadata: expect.objectContaining({ method: "google", via: "settings" }) });
    // Continue with Google with that account now signs in to this account, not a new one.
    const { user: viaGoogle } = await googleSignIn({ id: "g-1", email: "owner.personal@gmail.com" });
    expect(viaGoogle.id).toBe(user.id);
    expect(await systemDb.user.count()).toBe(1);
  });

  it("never renames the account after a Google account linked under another address, while a Google-only account follows Google's", async () => {
    const browser = testBrowser(ctx);
    const user = await browser.signIn("u1", "owner@shop.com");
    await linkGoogle(browser, { id: "g-1", email: "owner.personal@gmail.com" });
    ctx.auth.users.get("google_g-1")!.email = "owner.renamed@gmail.com";
    expect((await googleSignIn({ id: "g-1", email: "owner.renamed@gmail.com" })).user.id).toBe(user.id);
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe("owner@shop.com");

    const { user: solo } = await googleSignIn({ id: "g-2", email: "solo@gmail.com" });
    ctx.auth.users.get("google_g-2")!.email = "solo.renamed@gmail.com";
    await googleSignIn({ id: "g-2", email: "solo.renamed@gmail.com" });
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: solo.id } })).email).toBe("solo.renamed@gmail.com");
  });

  it("keeps the page's query and refuses anywhere but this site", async () => {
    const browser = testBrowser(ctx);
    await browser.signIn("u1", "owner@shop.com");
    const { res } = await linkGoogle(browser, { id: "g-1", email: "g@gmail.com" }, "/settings/integrations?tab=google");
    expect(res!.json().redirect).toBe("/settings/integrations?tab=google&linked=google");
    const other = testBrowser(ctx);
    await other.signIn("u2", "two@shop.com");
    const unsafe = await linkGoogle(other, { id: "g-2", email: "g2@gmail.com" }, "//evil.example/x");
    expect(unsafe.res!.json().redirect).toBe("/settings/security?linked=google");
  });

  it("needs the account's own session: none, or one opened from a shared link, is refused with signin_required", async () => {
    const nobody = await post("/auth/oauth/google/link", { returnTo: "/settings/integrations" });
    expect(nobody.statusCode).toBe(401);
    expect(nobody.json().error).toBe("signin_required");
    const { user, headers } = await signIn(ctx, "u1", "owner@shop.com");
    const ws = await createWorkspace(ctx, headers);
    const share = signSession(newLinkSession({ userId: user.id, workspaceId: ws }));
    const shared = await post("/auth/oauth/google/link", { returnTo: "/settings/integrations" }, { cookie: `__share=${share}` });
    expect(shared.json().error).toBe("signin_required");
  });

  it("starts only from this site's own pages: a plain link (any site can open one) or another site's request links nothing", async () => {
    const browser = testBrowser(ctx);
    await browser.signIn("u1", "owner@shop.com");
    // The old navigation start, opened by a page anywhere: back to the page, nothing started.
    const opened = await browser.get("/auth/oauth/google/start?link=1&returnTo=/settings/security");
    expect(opened.headers.location).toBe("http://localhost:3001/settings/security?link_error=start_again");
    expect(opened.headers["set-cookie"] ?? "").not.toContain("__oauth=");
    // Another site's POST, cookies and all.
    const cross = await ctx.app.inject({ method: "POST", url: "/auth/oauth/google/link", headers: { cookie: cookieOf(browser), origin: "https://evil.example" }, payload: { returnTo: "/settings/security" } });
    expect(cross.statusCode).toBe(403);
    expect(cross.headers["set-cookie"] ?? "").not.toContain("__oauth=");
    expect(ctx.auth.calls).not.toContain("exchangeCode");
  });

  it("refuses a Google account that already signs in to another account", async () => {
    await googleSignIn({ id: "g-taken", email: "someone@gmail.com" });
    const browser = testBrowser(ctx);
    const user = await browser.signIn("u1", "owner@shop.com");
    const { res } = await linkGoogle(browser, { id: "g-taken", email: "someone@gmail.com" });
    expect(res!.statusCode).toBe(409);
    expect(res!.json()).toMatchObject({ error: "google_in_use", redirect: "/settings/integrations?link_error=google_in_use" });
    expect(await systemDb.authIdentity.count({ where: { userId: user.id } })).toBe(1);
  });

  it("refuses when the account already has Google, or another person is signed in by the time Google answers", async () => {
    const browser = testBrowser(ctx);
    await browser.signIn("u1", "owner@shop.com");
    expect((await linkGoogle(browser, { id: "g-1", email: "g@gmail.com" })).res!.statusCode).toBe(200);
    const twice = await linkGoogle(browser, { id: "g-2", email: "g2@gmail.com" });
    expect(twice.start.statusCode).toBe(409);
    expect(twice.start.json().error).toBe("already_linked");

    const switched = testBrowser(ctx);
    await switched.signIn("u2", "two@shop.com");
    const start = await startLink(switched);
    const back = ctx.auth.federatedSignIn(start.json().redirect, { id: "g-3", email: "g3@gmail.com" });
    // Signed out, and someone else signed in, in the same browser meanwhile.
    await switched.post("/auth/logout");
    const intruder = await switched.signIn("u3", "three@shop.com");
    const res = await switched.post("/auth/oauth/callback", { code: back.code, state: back.state });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "signin_changed", redirect: "/settings/integrations?link_error=signin_changed" });
    expect(await systemDb.authIdentity.count({ where: { userId: intruder.id, method: "google" } })).toBe(0);
  });

  it("goes back with link_error when the person cancels at Google", async () => {
    const browser = testBrowser(ctx);
    await browser.signIn("u1", "owner@shop.com");
    const start = await startLink(browser);
    const state = new URL(start.json().redirect).searchParams.get("state")!;
    const res = await browser.post("/auth/oauth/callback", { state, error: "access_denied" });
    expect(res.json()).toMatchObject({ error: "cancelled", redirect: "/settings/integrations?link_error=cancelled" });
  });

  it("goes back only to a page of this site, however the path is written", async () => {
    // Dot segments pass a check of the raw text, but the browser reads them as "//evil.example/x".
    const unsafe = ["/..//evil.example/x", "/%2e%2e//evil.example/x", "/.//evil.example/x", "/a/..//evil.example/x"];
    for (const [i, returnTo] of unsafe.entries()) {
      const browser = testBrowser(ctx);
      await browser.signIn(`u${i}`, `owner${i}@shop.com`);
      const { res } = await linkGoogle(browser, { id: `g-${i}`, email: `g${i}@gmail.com` }, returnTo);
      expect(res!.json()).toEqual({ linked: "google", redirect: "/settings/security?linked=google" });
    }
    // The old navigation start's answer too.
    const opened = await get(`/auth/oauth/google/start?link=1&returnTo=${encodeURIComponent("/..//evil.example/x")}`);
    expect(opened.headers.location).toBe("http://localhost:3001/settings/security?link_error=start_again");
  });

  it("needs a sign-in in the last 15 minutes, or the password just now, which is good for one link", async () => {
    const browser = testBrowser(ctx);
    const user = await browser.signIn("u1", "owner@shop.com");
    const start = () => startLink(browser);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect((await start()).json().error).toBe("reauth_required");
    const prepare = (password: string) => browser.post("/auth/account/methods/google/prepare", { password });
    expect((await prepare("not-the-password")).json().error).toBe("wrong_password");
    const password = ctx.auth.users.get("u1")!.password!;
    expect((await prepare(password)).json()).toEqual({ ok: true, expiresInSeconds: 300 });
    const first = await start();
    expect(first.json().redirect).toMatch(/^https:\/\/auth\.example\.test\//);
    // Spent by that start.
    expect((await start()).json().error).toBe("reauth_required");
    // And it lasts five minutes.
    await prepare(password);
    vi.setSystemTime(Date.now() + 301_000);
    expect((await start()).json().error).toBe("reauth_required");
    const back = ctx.auth.federatedSignIn(first.json().redirect, { id: "g-1", email: "owner.personal@gmail.com" });
    expect((await browser.post("/auth/oauth/callback", { code: back.code, state: back.state })).json().linked).toBe("google");
    expect(await systemDb.authIdentity.count({ where: { userId: user.id, method: "google" } })).toBe(1);
    // The password's check left no Cognito session behind.
    expect(ctx.auth.calls).toContain("revokeRefreshToken");
  });

  it("is prepared with the password from a password session only", async () => {
    const { browser } = await googleSignIn({ id: "g-1", email: "merchant@gmail.com" });
    expect((await browser.post("/auth/account/methods/google/prepare", { password: "anything-at-all" })).json().error).toBe("password_session_required");
  });

  it("emails the account's address whenever a way to sign in is added from Settings", async () => {
    const before = ctx.mailer.sent.length;
    const browser = testBrowser(ctx);
    await browser.signIn("u1", "owner@shop.com");
    await linkGoogle(browser, { id: "g-1", email: "owner.personal@gmail.com" });
    const linked = ctx.mailer.sent.slice(before);
    expect(linked).toEqual([expect.objectContaining({ to: "owner@shop.com", subject: "Google sign-in was added to your bizinsights account" })]);
    expect(linked[0]!.text).toContain("owner.personal@gmail.com");
    expect(linked[0]!.text).toContain("http://localhost:3001/forgot-password");
    expect(linked[0]!.text).toContain("http://localhost:3001/settings/security");

    const { browser: google } = await googleSignIn({ id: "g-2", email: "merchant@gmail.com" });
    // A mail outage changes nothing about the password being added.
    ctx.mailer.fail.push(new Error("mail provider down"));
    expect((await google.post("/auth/account/password/add", { password: "a-good-password", confirmPassword: "a-good-password" })).statusCode).toBe(200);
    expect((await google.get("/auth/account")).json().hasPassword).toBe(true);
    const { browser: g3 } = await googleSignIn({ id: "g-3", email: "solo@gmail.com" });
    const sentBefore = ctx.mailer.sent.length;
    await g3.post("/auth/account/password/add", { password: "a-good-password", confirmPassword: "a-good-password" });
    expect(ctx.mailer.sent.slice(sentBefore)).toEqual([expect.objectContaining({ to: "solo@gmail.com", subject: "A password was added to your bizinsights account" })]);
  });

  it("refuses a start while Google is off", async () => {
    restore();
    restore = withEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "" });
    const browser = testBrowser(ctx);
    await browser.signIn("u1", "owner@shop.com");
    const res = await startLink(browser);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("provider_unavailable");
  });
});

describe("an account whose address nobody has proved", () => {
  /** victim@gmail.com's account, opened by someone else with a password (an employee added with that address, the copied link). */
  async function squatted() {
    const squatter = testBrowser(ctx);
    const account = await squatter.signIn("u-sq", "victim@gmail.com", false);
    expect(account.emailVerified).toBe(false);
    return { squatter, account, password: ctx.auth.users.get("u-sq")!.password! };
  }

  /** An email change to the squatter's own inbox, started in Cognito anyway (as it could be before these checks): its code. */
  async function changeStartedAnyway(password: string) {
    const signedIn = await ctx.auth.passwordSignIn("victim@gmail.com", password);
    if (!("tokens" in signedIn)) throw new Error("expected tokens");
    await ctx.auth.updateEmail(signedIn.tokens.accessToken, "squatter@evil.test");
    return ctx.auth.code("verify", "squatter@evil.test");
  }

  it("can't be moved to another address, and a code that proved the squatter's own inbox never verifies it: the owner's Google takes it over", async () => {
    const { squatter, account, password } = await squatted();
    // The reviewer's sequence: an email change to the squatter's inbox, its code entered as the address's verification.
    const change = await squatter.post("/auth/account/email", { email: "squatter@evil.test", password });
    expect(change.statusCode).toBe(403);
    expect(change.json().error).toBe("email_unverified");
    expect(ctx.auth.calls).not.toContain("updateEmail");
    const code = await changeStartedAnyway(password);
    expect((await squatter.post("/auth/account/email/confirm", { code })).json().error).toBe("email_unverified");
    const verify = await squatter.post("/auth/account/verify-email", { code });
    expect(verify.statusCode).toBe(400);
    expect(verify.json().error).toBe("invalid_code");
    expect(await systemDb.user.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ email: "victim@gmail.com", emailVerified: false });
    // Signing in with the address Cognito now has neither moves the account there nor verifies it.
    const moved = await post("/auth/login", { email: "squatter@evil.test", password });
    expect(moved.json().user).toMatchObject({ id: account.id, email: "victim@gmail.com", emailVerified: false });

    // The address's owner continues with Google: the account is theirs alone.
    const owner = await googleSignIn({ id: "g-victim", email: "victim@gmail.com" });
    expect(owner.user.id).toBe(account.id);
    expect((await systemDb.authIdentity.findMany({ where: { userId: account.id } })).map((i) => i.username)).toEqual(["google_g-victim"]);
    expect((await squatter.get("/me")).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "squatter@evil.test", password })).statusCode).toBe(401);
  });

  it("is taken over by the owner's own sign-up with the address, after the same attempt", async () => {
    const { squatter, account, password } = await squatted();
    await squatter.post("/auth/account/verify-email", { code: await changeStartedAnyway(password) });
    // Without Google (production today): the owner signs up with their address, free in Cognito
    // now that the squatter's user carries the other one, and confirms the code from their inbox.
    const owner = testBrowser(ctx);
    expect((await owner.post("/auth/signup", { name: "Vic", email: "victim@gmail.com", password: "owners-password", confirmPassword: "owners-password", acceptTerms: true })).statusCode).toBe(200);
    const confirmed = await owner.post("/auth/signup/confirm", { email: "victim@gmail.com", code: ctx.auth.code("signup", "victim@gmail.com"), password: "owners-password" });
    expect(confirmed.json().user).toMatchObject({ id: account.id, email: "victim@gmail.com", emailVerified: true, displayName: "Vic" });
    expect((await systemDb.authIdentity.findMany({ where: { userId: account.id } })).map((i) => i.method)).toEqual(["password"]);
    expect((await squatter.get("/me")).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "squatter@evil.test", password })).statusCode).toBe(401);
    expect((await owner.get("/me")).json().user.id).toBe(account.id);
  });

  /** The code we emailed `to` last (an address claim's: Cognito sends no code to an address it hasn't verified). */
  const ourCode = (to: string) => {
    const mail = [...ctx.mailer.sent].reverse().find((m) => m.to === to && /\b\d{6}\b/.test(m.text));
    if (!mail) throw new Error(`no code emailed to ${to}`);
    return /\b(\d{6})\b/.exec(mail.text)![1]!;
  };

  it("doesn't lock the owner out of signing up: our code to the address, and whoever enters it takes the account over", async () => {
    // Cognito holds the address for the squatter's password user, so a sign-up used to answer
    // "account exists" and "Forgot password?" sent nothing (Cognito won't email an unverified address).
    const { squatter, account, password } = await squatted();
    const owner = testBrowser(ctx);
    const signup = await owner.post("/auth/signup", { name: "Vic", email: "victim@gmail.com", password: "owners-password", confirmPassword: "owners-password", acceptTerms: true });
    expect(signup.json()).toMatchObject({ ok: true, next: "confirm", email: "victim@gmail.com" });
    const code = ourCode("victim@gmail.com");
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ subject: "Your bizinsights verification code", html: expect.stringContaining(code) });
    // Until the code is entered nothing changes: a claim anyone starts costs the account nothing.
    expect((await post("/auth/login", { email: "victim@gmail.com", password })).statusCode).toBe(200);
    expect((await owner.post("/auth/signup/confirm", { email: "victim@gmail.com", code: code === "000000" ? "111111" : "000000", password: "owners-password" })).json().error).toBe("invalid_code");
    expect((await owner.post("/auth/signup/confirm", { email: "victim@gmail.com", code })).json().error).toBe("password_required");

    const res = await owner.post("/auth/signup/confirm", { email: "victim@gmail.com", code, password: "owners-password", keep: false });
    expect(res.json()).toMatchObject({ ok: true, user: { id: account.id, email: "victim@gmail.com", emailVerified: true, displayName: "Vic" } });
    expect(String(res.headers["set-cookie"])).not.toMatch(/__session=[^;]+;[^,]*Max-Age/);
    expect((await squatter.get("/me")).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "victim@gmail.com", password })).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "victim@gmail.com", password: "owners-password" })).json().user.id).toBe(account.id);
    expect(await systemDb.authIdentity.count({ where: { userId: account.id } })).toBe(1);
    expect(await systemDb.authEvent.count({ where: { type: "unverified_identity_removed", userId: account.id } })).toBe(1);
    // The code worked once; Cognito's own rules apply again from here.
    expect((await post("/auth/signup", { name: "X", email: "victim@gmail.com", password: "another-password", confirmPassword: "another-password", acceptTerms: true })).json().error).toBe("account_exists");
  });

  it("lets the owner reset a password for such an address, with our code", async () => {
    const { squatter, account, password } = await squatted();
    expect((await post("/auth/password/forgot", { email: "victim@gmail.com" })).statusCode).toBe(200);
    expect(ctx.auth.calls).not.toContain("forgotPassword");
    const code = ourCode("victim@gmail.com");
    expect(ctx.mailer.sent.at(-1)!.subject).toBe("Reset your bizinsights password");
    const reset = await post("/auth/password/reset", { email: "victim@gmail.com", code, password: "owners-password", confirmPassword: "owners-password" });
    expect(reset.json()).toEqual({ ok: true, otherMethods: [] });
    // Taken over at once, not at the owner's next sign-in.
    expect((await squatter.get("/me")).statusCode).toBe(401);
    expect(await systemDb.user.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ emailVerified: true });
    expect((await post("/auth/login", { email: "victim@gmail.com", password })).statusCode).toBe(401);
    expect((await post("/auth/login", { email: "victim@gmail.com", password: "owners-password" })).json().user).toMatchObject({ id: account.id, emailVerified: true });
  });

  it("allows a few guesses an hour at our code, and a new code from \"Resend\"", async () => {
    await squatted();
    await post("/auth/signup", { name: "Vic", email: "victim@gmail.com", password: "owners-password", confirmPassword: "owners-password", acceptTerms: true });
    const first = ourCode("victim@gmail.com");
    expect((await post("/auth/signup/resend", { email: "victim@gmail.com" })).statusCode).toBe(200);
    const second = ourCode("victim@gmail.com");
    const wrong = ["000000", "111111", "222222", "333333", "444444"].filter((c) => c !== second);
    for (const guess of wrong.slice(0, 4)) expect((await post("/auth/signup/confirm", { email: "victim@gmail.com", code: guess, password: "owners-password" })).json().error).toBe("invalid_code");
    if (first !== second) expect((await post("/auth/signup/confirm", { email: "victim@gmail.com", code: first, password: "owners-password" })).json().error).toBe("invalid_code");
    else expect((await post("/auth/signup/confirm", { email: "victim@gmail.com", code: wrong[4]!, password: "owners-password" })).json().error).toBe("invalid_code");
    expect((await post("/auth/signup/confirm", { email: "victim@gmail.com", code: second, password: "owners-password" })).statusCode).toBe(429);
  });

  it("verifies with the code sent to its own address", async () => {
    const { squatter, account } = await squatted();
    expect((await squatter.post("/auth/account/verify-email/send")).statusCode).toBe(200);
    const res = await squatter.post("/auth/account/verify-email", { code: ctx.auth.code("verify", "victim@gmail.com") });
    expect(res.json().user).toMatchObject({ id: account.id, email: "victim@gmail.com", emailVerified: true });
    expect(await systemDb.authEvent.count({ where: { type: "email_verified", userId: account.id } })).toBe(1);
  });

  it("leaves what it set up behind when the owner takes it over: its workspace, API keys, invitations and the access it gave", async () => {
    const { squatter, account } = await squatted();
    // As the unverified account: a workspace, an API key, an admin (the squatter's other account), an invitation.
    const ws = (await squatter.post("/workspaces", { name: "Victim Store" })).json().workspace.id as string;
    const key = await squatter.post(`/workspaces/${ws}/api-keys`, { name: "sync" });
    expect(key.statusCode).toBe(200);
    const secret = key.json().secret as string;
    const accomplice = await signIn(ctx, "u-x", "attacker@evil.test");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: accomplice.user.id, role: "admin", invitedById: account.id } });
    expect((await squatter.post(`/workspaces/${ws}/team/invitations`, { email: "another@evil.test", role: "viewer", permissions: [] })).statusCode).toBe(200);
    // A workspace a real owner gave the address: that stays the address owner's.
    const realOwner = await signIn(ctx, "u-o", "real.owner@shop.com");
    const theirs = await createWorkspace(ctx, realOwner.headers, "Their Store");
    await systemDb.membership.create({ data: { workspaceId: theirs, userId: account.id, role: "viewer", invitedById: realOwner.user.id } });
    // The name it gave the account, for whoever owns the address next.
    await systemDb.user.update({ where: { id: account.id }, data: { displayName: "Support: call +1 555 0100" } });

    const owner = await googleSignIn({ id: "g-victim", email: "victim@gmail.com" });
    expect(owner.user.id).toBe(account.id);
    const me = (await owner.browser.get("/me")).json();
    expect(me.workspaces.map((w: { name: string }) => w.name)).toEqual(["Their Store"]);
    expect(me.user.displayName).toBeNull();
    // The key reads nothing, the admin the squatter made has no access, the invitation can't be used.
    expect((await get(`/workspaces/${ws}/stores`, { authorization: `Bearer ${secret}` })).statusCode).toBe(404);
    expect((await get(`/workspaces/${ws}/stores`, accomplice.headers)).json().error).toBe("access_revoked");
    expect(await systemDb.invitation.findFirstOrThrow({ where: { workspaceId: ws } })).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await systemDb.authEvent.findFirst({ where: { type: "unverified_identity_removed", userId: account.id } })).toMatchObject({
      metadata: expect.objectContaining({ revokedApiKeys: 1, revokedInvitations: 1, revokedMembers: 1, leftWorkspaces: [ws] }),
    });
    // The real owner's workspace is untouched.
    expect((await get(`/workspaces/${theirs}/stores`, realOwner.headers)).statusCode).toBe(200);
  });

  it("can't link Google, and a Google account under another address never proves it: the address's owner still takes the account over", async () => {
    // Opened by someone who doesn't own the address (an employee added with it, the copied invitation link).
    const squatter = testBrowser(ctx);
    const account = await squatter.signIn("u-sq", "victim@gmail.com", false);
    expect(account.emailVerified).toBe(false);
    expect((await startLink(squatter, "/settings/security")).json().error).toBe("email_unverified");
    // Nor when the address stops being verified between the start and Google's answer.
    await systemDb.user.update({ where: { id: account.id }, data: { emailVerified: true } });
    const started = await startLink(squatter, "/settings/security");
    await systemDb.user.update({ where: { id: account.id }, data: { emailVerified: false } });
    const backLate = ctx.auth.federatedSignIn(started.json().redirect, { id: "g-late", email: "late@gmail.com" });
    const late = await squatter.post("/auth/oauth/callback", { code: backLate.code, state: backLate.state });
    expect(late.json()).toMatchObject({ error: "email_unverified", redirect: "/settings/security?link_error=email_unverified" });

    // A Google account under another address linked anyway (as it could be before these checks).
    await systemDb.user.update({ where: { id: account.id }, data: { emailVerified: true } });
    expect((await linkGoogle(squatter, { id: "g-sq", email: "squatter@gmail.com" })).res!.statusCode).toBe(200);
    await systemDb.user.update({ where: { id: account.id }, data: { emailVerified: false } });

    // Signing in with it, and that session's re-checks with Cognito, vouch for squatter@gmail.com only.
    const viaGoogle = await googleSignIn({ id: "g-sq", email: "squatter@gmail.com" });
    expect(viaGoogle.user.id).toBe(account.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await viaGoogle.browser.get("/me")).statusCode).toBe(200);
    expect(ctx.auth.calls).toContain("refresh");
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: account.id } })).emailVerified).toBe(false);
    vi.useRealTimers();

    // The address's owner continues with Google: the account is theirs, with only their way in.
    const owner = await googleSignIn({ id: "g-victim", email: "victim@gmail.com" });
    expect(owner.user.id).toBe(account.id);
    expect((await systemDb.authIdentity.findMany({ where: { userId: account.id } })).map((i) => i.username)).toEqual(["google_g-victim"]);
    expect((await post("/auth/login", { email: "victim@gmail.com", password: "pw-u-sq-secret" })).statusCode).toBe(401);
    expect((await viaGoogle.browser.get("/me")).statusCode).toBe(401);
    // The other Google account now starts an account of its own.
    expect((await googleSignIn({ id: "g-sq", email: "squatter@gmail.com" })).user.id).not.toBe(account.id);
  });
});

describe("removing a sign-in method", () => {
  it("removes Google from a password session, with the password, and its Cognito user goes too", async () => {
    const browser = testBrowser(ctx);
    const user = await browser.signIn("u1", "owner@shop.com");
    await linkGoogle(browser, { id: "g-1", email: "g@gmail.com" });
    const google = (await browser.get("/auth/account")).json().methods.find((m: { method: string }) => m.method === "google");
    const remove = (payload: unknown = {}) => ctx.app.inject({ method: "DELETE", url: `/auth/account/methods/${google.id}`, headers: { ...ORIGIN, cookie: [...browser.jar].map(([k, v]) => `${k}=${v}`).join("; ") }, payload });
    expect((await remove()).json().error).toBe("password_required");
    expect((await remove({ password: "not-it" })).json().error).toBe("wrong_password");
    const res = await remove({ password: ctx.auth.users.get("u1")!.password });
    expect(res.statusCode).toBe(200);
    expect(ctx.auth.users.has("google_g-1")).toBe(false);
    expect((await browser.get("/auth/account")).json()).toMatchObject({ canLinkGoogle: true, methods: [{ method: "password" }] });
    expect(await systemDb.authEvent.findFirst({ where: { type: "identity_removed", userId: user.id } })).toMatchObject({ metadata: expect.objectContaining({ method: "google" }) });
  });

  it("keeps a removed Google account out even when it has the account's address, until it is linked again", async () => {
    const browser = testBrowser(ctx);
    const user = await browser.signIn("u1", "owner@shop.com");
    await linkGoogle(browser, { id: "g-1", email: "owner@shop.com" });
    const google = (await browser.get("/auth/account")).json().methods.find((m: { method: string }) => m.method === "google");
    const cookie = [...browser.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    expect((await del(`/auth/account/methods/${google.id}`, { cookie }, { password: ctx.auth.users.get("u1")!.password })).statusCode).toBe(200);
    expect(await systemDb.authEvent.findFirst({ where: { type: "identity_removed", userId: user.id } })).toMatchObject({
      metadata: expect.objectContaining({ method: "google", cognitoUsername: "google_g-1" }),
    });

    // Continue with Google with it: Cognito makes its Google user again, but the address alone
    // doesn't link it back, and no account is made for it.
    const again = testBrowser(ctx);
    const start = await again.get("/auth/oauth/google/start");
    const back = ctx.auth.federatedSignIn(start.headers.location!, { id: "g-1", email: "owner@shop.com" });
    const res = await again.post("/auth/oauth/callback", { code: back.code, state: back.state });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("google_removed");
    expect(res.headers["set-cookie"] ?? "").not.toMatch(/__session=[^;]/);
    expect(await systemDb.authIdentity.count({ where: { userId: user.id } })).toBe(1);
    expect(await systemDb.user.count()).toBe(1);

    // Linked again from Settings, it signs in as before.
    expect((await linkGoogle(browser, { id: "g-1", email: "owner@shop.com" })).res!.json().linked).toBe("google");
    expect((await googleSignIn({ id: "g-1", email: "owner@shop.com" })).user.id).toBe(user.id);
  });

  it("ends the removed method's sessions at once, even one that kept only its session cookie, and tells the account's address", async () => {
    const owner = testBrowser(ctx);
    await owner.signIn("u1", "owner@shop.com");
    // Someone linked their own Google account at the owner's computer, then signed in with it elsewhere.
    await linkGoogle(owner, { id: "g-intruder", email: "intruder@gmail.com" });
    const intruder = await googleSignIn({ id: "g-intruder", email: "intruder@gmail.com" });
    const sessionOnly = { cookie: `__session=${intruder.browser.jar.get("__session")}` };
    expect((await get("/me", sessionOnly)).statusCode).toBe(200);

    const google = (await owner.get("/auth/account")).json().methods.find((m: { method: string }) => m.method === "google");
    const before = ctx.mailer.sent.length;
    expect((await del(`/auth/account/methods/${google.id}`, { cookie: cookieOf(owner) }, { password: ctx.auth.users.get("u1")!.password })).statusCode).toBe(200);
    // No waiting for a re-check with Cognito, and no refresh-token cookie needed for it to end.
    expect((await get("/me", sessionOnly)).statusCode).toBe(401);
    expect((await intruder.browser.get("/me")).statusCode).toBe(401);
    expect((await owner.get("/me")).statusCode).toBe(200);
    const notice = ctx.mailer.sent.slice(before);
    expect(notice).toEqual([expect.objectContaining({ to: "owner@shop.com", subject: "Google sign-in was removed from your bizinsights account" })]);
    expect(notice[0]!.text).toContain("intruder@gmail.com");
    expect(notice[0]!.text).toContain("http://localhost:3001/forgot-password");
  });

  it("needs the account's password from a Google account linked under another address: it can't take the owner's ways in, nor add its own password", async () => {
    // The reviewer's escalation: a Google account linked in a stolen minute, used later from elsewhere.
    const owner = testBrowser(ctx);
    const user = await owner.signIn("u1", "owner@shop.com");
    await linkGoogle(owner, { id: "g-x", email: "intruder@gmail.com" });
    const intruder = await googleSignIn({ id: "g-x", email: "intruder@gmail.com" });
    const account = (await intruder.browser.get("/auth/account")).json();
    expect(account).toMatchObject({ signedInWith: "google", confirmWith: "password", canAddPassword: false });
    const pw = account.methods.find((m: { method: string }) => m.method === "password");
    const remove = (payload: unknown) => del(`/auth/account/methods/${pw.id}`, { cookie: cookieOf(intruder.browser) }, payload);
    expect((await remove({})).json().error).toBe("password_required");
    expect((await remove({ password: "a-guess-at-it" })).json().error).toBe("wrong_password");
    expect((await post("/auth/account/delete", { confirm: "DELETE" }, { cookie: cookieOf(intruder.browser) })).json().error).toBe("password_required");
    expect((await post("/auth/login", { email: "owner@shop.com", password: ctx.auth.users.get("u1")!.password })).statusCode).toBe(200);

    // An account left with only that Google account (its password gone another way): nothing it has proves the address.
    await systemDb.authIdentity.deleteMany({ where: { userId: user.id, method: "password" } });
    await ctx.auth.adminDeleteUser("u1");
    expect((await intruder.browser.get("/auth/account")).json()).toMatchObject({ confirmWith: "own_address_sign_in", canAddPassword: false, hasPassword: false });
    const add = await intruder.browser.post("/auth/account/password/add", { password: "intruders-password", confirmPassword: "intruders-password" });
    expect(add.statusCode).toBe(401);
    expect(add.json()).toMatchObject({ error: "reauth_required", message: expect.stringContaining("owner@shop.com") });
    expect(ctx.auth.calls).not.toContain("adminCreateUser");
    expect((await post("/auth/account/delete", { confirm: "DELETE" }, { cookie: cookieOf(intruder.browser) })).json().error).toBe("reauth_required");
  });

  it("lets a recent Google sign-in with the account's own address confirm changes, as before", async () => {
    const { browser } = await googleSignIn({ id: "g-1", email: "merchant@gmail.com" });
    expect((await browser.get("/auth/account")).json()).toMatchObject({ confirmWith: "recent_sign_in", canAddPassword: true });
    const password = testBrowser(ctx);
    await password.signIn("u2", "two@shop.com");
    expect((await password.get("/auth/account")).json()).toMatchObject({ confirmWith: "password", canAddPassword: false });
  });

  it("never removes the last method, the one signed in with, or someone else's", async () => {
    const { headers, user } = await signIn(ctx, "u1", "owner@shop.com");
    const [own] = await systemDb.authIdentity.findMany({ where: { userId: user.id } });
    const password = ctx.auth.users.get("u1")!.password;
    expect((await del(`/auth/account/methods/${own!.id}`, headers, { password })).json().error).toBe("last_method");
    const other = await signIn(ctx, "u2", "two@shop.com");
    const [theirs] = await systemDb.authIdentity.findMany({ where: { userId: other.user.id } });
    expect((await del(`/auth/account/methods/${theirs!.id}`, headers, { password })).statusCode).toBe(404);
    expect(ctx.auth.users.has("u2")).toBe(true);

    // Signed in with Google: the password can go (a recent Google sign-in is the proof), Google can't.
    const { browser } = await googleSignIn({ id: "g-1", email: "owner@shop.com" });
    const methods = (await browser.get("/auth/account")).json().methods as Array<{ id: string; method: string }>;
    const cookie = [...browser.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const google = methods.find((m) => m.method === "google")!;
    expect((await del(`/auth/account/methods/${google.id}`, { cookie })).json().error).toBe("method_in_use");
    const pw = methods.find((m) => m.method === "password")!;
    expect((await del(`/auth/account/methods/${pw.id}`, { cookie })).statusCode).toBe(200);
    expect((await post("/auth/login", { email: "owner@shop.com", password })).statusCode).toBe(401);
    // The password session elsewhere ends at its next check with Cognito.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await get("/me", headers)).statusCode).toBe(401);
  });
});

describe("account changes Cognito refuses for this session", () => {
  it("say \"sign in again\", never \"wrong password\"", async () => {
    const { headers } = await signIn(ctx, "u1", "a@x.com", false);
    // What Cognito answers a token from Google's sign-in, which can't change the account there.
    vi.spyOn(ctx.auth, "sendEmailVerificationCode").mockRejectedValueOnce(new CognitoError("NotAuthorizedException", "Access Token does not have required scopes"));
    const res = await post("/auth/account/verify-email/send", {}, headers);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("reauth_required");
    // Still signed in: a 401 with this code is not "signed out".
    expect((await get("/me", { cookie: cookiesFrom(res) || headers.cookie! })).statusCode).toBe(200);
  });
});
