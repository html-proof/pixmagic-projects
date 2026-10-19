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

  it("sends a start to the page's link_error while Google is off", async () => {
    restore();
    restore = withEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "" });
    const res = await get("/auth/oauth/google/start?link=1&returnTo=/settings/integrations");
    expect(res.headers.location).toBe("http://localhost:3001/settings/integrations?link_error=provider_unavailable");
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
