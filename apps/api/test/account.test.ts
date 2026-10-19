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

/** Link Google from Settings in `browser` (signed in already): the start's redirect and the callback's answer. */
async function linkGoogle(browser: ReturnType<typeof testBrowser>, person: { id: string; email: string }, returnTo = "/settings/integrations") {
  const start = await browser.get(`/auth/oauth/google/start?link=1&returnTo=${encodeURIComponent(returnTo)}`);
  expect(start.statusCode).toBe(302);
  if (!start.headers.location!.startsWith("https://auth.example.test/")) return { start, res: null };
  const back = ctx.auth.federatedSignIn(start.headers.location!, person);
  return { start, res: await browser.post("/auth/oauth/callback", { code: back.code, state: back.state }) };
}

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
    const authorize = new URL(start.headers.location!);
    expect(authorize.searchParams.get("identity_provider")).toBe("Google");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
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

  it("needs the account's own session: none, or one opened from a shared link, goes back with link_error", async () => {
    const nobody = await get("/auth/oauth/google/start?link=1&returnTo=/settings/integrations");
    expect(nobody.headers.location).toBe("http://localhost:3001/settings/integrations?link_error=signin_required");
    const { user, headers } = await signIn(ctx, "u1", "owner@shop.com");
    const ws = await createWorkspace(ctx, headers);
    const share = signSession(newLinkSession({ userId: user.id, workspaceId: ws }));
    const shared = await get("/auth/oauth/google/start?link=1&returnTo=/settings/integrations", { cookie: `__share=${share}` });
    expect(shared.headers.location).toBe("http://localhost:3001/settings/integrations?link_error=signin_required");
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
    expect(twice.start.headers.location).toBe("http://localhost:3001/settings/integrations?link_error=already_linked");

    const switched = testBrowser(ctx);
    await switched.signIn("u2", "two@shop.com");
    const start = await switched.get("/auth/oauth/google/start?link=1&returnTo=/settings/integrations");
    const back = ctx.auth.federatedSignIn(start.headers.location!, { id: "g-3", email: "g3@gmail.com" });
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
    const start = await browser.get("/auth/oauth/google/start?link=1&returnTo=/settings/integrations");
    const state = new URL(start.headers.location!).searchParams.get("state")!;
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
    // The start's own refusals too.
    const nobody = await get(`/auth/oauth/google/start?link=1&returnTo=${encodeURIComponent("/..//evil.example/x")}`);
    expect(nobody.headers.location).toBe("http://localhost:3001/settings/security?link_error=signin_required");
  });

  it("needs a sign-in in the last 15 minutes, or the password just now, which is good for one link", async () => {
    const browser = testBrowser(ctx);
    const user = await browser.signIn("u1", "owner@shop.com");
    const start = () => browser.get("/auth/oauth/google/start?link=1&returnTo=/settings/integrations");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect((await start()).headers.location).toBe("http://localhost:3001/settings/integrations?link_error=reauth_required");
    const prepare = (password: string) => browser.post("/auth/account/methods/google/prepare", { password });
    expect((await prepare("not-the-password")).json().error).toBe("wrong_password");
    const password = ctx.auth.users.get("u1")!.password!;
    expect((await prepare(password)).json()).toEqual({ ok: true, expiresInSeconds: 300 });
    const first = await start();
    expect(first.headers.location).toMatch(/^https:\/\/auth\.example\.test\//);
    // Spent by that start.
    expect((await start()).headers.location).toBe("http://localhost:3001/settings/integrations?link_error=reauth_required");
    // And it lasts five minutes.
    await prepare(password);
    vi.setSystemTime(Date.now() + 301_000);
    expect((await start()).headers.location).toBe("http://localhost:3001/settings/integrations?link_error=reauth_required");
    const back = ctx.auth.federatedSignIn(first.headers.location!, { id: "g-1", email: "owner.personal@gmail.com" });
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

  it("sends a start to the page's link_error while Google is off", async () => {
    restore();
    restore = withEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "" });
    const res = await get("/auth/oauth/google/start?link=1&returnTo=/settings/integrations");
    expect(res.headers.location).toBe("http://localhost:3001/settings/integrations?link_error=provider_unavailable");
  });
});

describe("an account whose address nobody has proved", () => {
  it("can't link Google, and a Google account under another address never proves it: the address's owner still takes the account over", async () => {
    // Opened by someone who doesn't own the address (an employee added with it, the copied invitation link).
    const squatter = testBrowser(ctx);
    const account = await squatter.signIn("u-sq", "victim@gmail.com", false);
    expect(account.emailVerified).toBe(false);
    expect((await squatter.get("/auth/oauth/google/start?link=1&returnTo=/settings/security")).headers.location).toBe(
      "http://localhost:3001/settings/security?link_error=email_unverified",
    );
    // Nor when the address stops being verified between the start and Google's answer.
    await systemDb.user.update({ where: { id: account.id }, data: { emailVerified: true } });
    const started = await squatter.get("/auth/oauth/google/start?link=1&returnTo=/settings/security");
    await systemDb.user.update({ where: { id: account.id }, data: { emailVerified: false } });
    const backLate = ctx.auth.federatedSignIn(started.headers.location!, { id: "g-late", email: "late@gmail.com" });
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
