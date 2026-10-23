import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@app/core";
import { CODE_TTL_S, MAX_ATTEMPTS, RESEND_AFTER_S } from "../src/emailCode.js";
import { clean, cookiesFrom, ORIGIN, setup, teardown, testBrowser, userOf, type InjectResponse, type TestCtx } from "./helpers.js";

/**
 * The emailed 6-digit codes (apps/api/src/emailCode.ts): the sign-up code's minute, five guesses
 * and resend cooldown, enforced on the server's clock in front of Cognito; and the code emailed
 * after the password at sign-in, which the API issues itself and holds Cognito's tokens behind.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => {
  await clean(ctx);
  // The in-memory mailer keeps everything sent: each test reads only what it sent itself.
  ctx.mailer.sent.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => ctx.app.inject({ method: "POST", url, headers: { ...ORIGIN, ...headers }, payload });
const get = (url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: "GET", url, headers });
const cookie = (res: InjectResponse, name: string) => (res.headers["set-cookie"] ?? "").split(", ").find((c) => c.startsWith(`${name}=`));
const sessionCookie = (res: InjectResponse) => cookie(res, "__session")?.split(";")[0]?.split("=")[1] ?? "";

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

/** The newest 6-digit code the app itself emailed to `to` (the sign-in code; Cognito's are in ctx.auth.sent). */
function emailedCode(to: string): string {
  const mail = [...ctx.mailer.sent].reverse().find((m) => m.to === to && /\b\d{6}\b/.test(m.text));
  if (!mail) throw new Error(`no code emailed to ${to}`);
  return /\b(\d{6})\b/.exec(mail.text)![1]!;
}
const wrongCode = (right: string) => String((Number(right) + 1) % 1_000_000).padStart(6, "0");

const signup = (overrides: Record<string, unknown> = {}) =>
  post("/auth/signup", { name: "Ada Lovelace", email: "ada@example.com", password: "correct-horse", confirmPassword: "correct-horse", acceptTerms: true, ...overrides });
const confirm = (code: string, extra: Record<string, unknown> = {}) => post("/auth/signup/confirm", { email: "ada@example.com", code, ...extra });

describe("the sign-up code: a minute, five guesses, one resend a minute", () => {
  it("tells the page when the code expires and when another may be asked for, on the server's clock", async () => {
    const res = await signup();
    expect(res.statusCode).toBe(200);
    const { challenge } = res.json();
    expect(challenge.expiresAt - challenge.issuedAt).toBe(CODE_TTL_S * 1000);
    expect(challenge.resendAt - challenge.issuedAt).toBe(RESEND_AFTER_S * 1000);
    expect(Math.abs(challenge.now - Date.now())).toBeLessThan(5_000);
    // Within the minute: a wrong code is wrong, the right one confirms.
    expect((await confirm(wrongCode(ctx.auth.code("signup", "ada@example.com")))).json()).toMatchObject({ error: "invalid_code", message: "The verification code is incorrect. Please try again." });
    expect((await confirm(ctx.auth.code("signup", "ada@example.com"))).statusCode).toBe(200);
  });

  it("refuses the right code after 60 seconds, before Cognito is even asked", async () => {
    await signup();
    const code = ctx.auth.code("signup", "ada@example.com");
    advance(59_000);
    expect(ctx.auth.calls).not.toContain("confirmSignUp");
    advance(2_000);
    const late = await confirm(code);
    expect(late.statusCode).toBe(400);
    expect(late.json()).toMatchObject({ error: "expired_code", message: "This code has expired. Request a new code." });
    expect(ctx.auth.calls).not.toContain("confirmSignUp");
    // A new code works.
    const resent = await post("/auth/signup/resend", { email: "ada@example.com" });
    expect(resent.statusCode).toBe(200);
    expect(resent.json().message).toBe("A new verification code has been sent.");
    expect((await confirm(ctx.auth.code("signup", "ada@example.com"))).statusCode).toBe(200);
  });

  it("ends the code at the fifth wrong guess; the right code is then no use, a new one is", async () => {
    await signup();
    const code = ctx.auth.code("signup", "ada@example.com");
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect((await confirm(wrongCode(code))).json().error).toBe("invalid_code");
    const fifth = await confirm(wrongCode(code));
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ error: "too_many_attempts", message: "Too many attempts. Please try again later." });
    expect(fifth.headers["retry-after"]).toBeDefined();
    expect((await confirm(code)).json().error).toBe("expired_code");
    advance(61_000);
    await post("/auth/signup/resend", { email: "ada@example.com" });
    expect((await confirm(ctx.auth.code("signup", "ada@example.com"))).statusCode).toBe(200);
  });

  it("refuses a resend until the minute is up, naming the standing code's countdowns; then a new code replaces the old", async () => {
    const first = (await signup()).json().challenge;
    const oldCode = ctx.auth.code("signup", "ada@example.com");
    advance(30_000);
    const tooSoon = await post("/auth/signup/resend", { email: "ada@example.com" });
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json()).toMatchObject({ error: "resend_cooldown", detail: { challenge: { issuedAt: first.issuedAt, expiresAt: first.expiresAt, resendAt: first.resendAt } } });
    expect(Number(tooSoon.headers["retry-after"])).toBe(30);
    expect(ctx.auth.sent.filter((s) => s.kind === "signup")).toHaveLength(1);
    advance(31_000);
    const resent = await post("/auth/signup/resend", { email: "ada@example.com" });
    expect(resent.statusCode).toBe(200);
    expect(resent.json().challenge.issuedAt).toBeGreaterThan(first.issuedAt);
    expect(ctx.auth.sent.filter((s) => s.kind === "signup")).toHaveLength(2);
    // The previous code can't be used any more.
    expect((await confirm(oldCode)).json().error).toBe("invalid_code");
    expect((await confirm(ctx.auth.code("signup", "ada@example.com"))).statusCode).toBe(200);
  });

  it("works once: the same code again is refused without a session", async () => {
    await signup();
    const code = ctx.auth.code("signup", "ada@example.com");
    expect((await confirm(code, { password: "correct-horse" })).statusCode).toBe(200);
    const again = await confirm(code, { password: "correct-horse" });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("expired_code");
    expect(again.headers["set-cookie"] ?? "").not.toMatch(/__session=[^;]/);
  });

  it("caps the codes one address gets an hour and a day (configurable)", async () => {
    const restore = withEnv({ AUTH_CODE_LIMIT_HOURLY: "2", AUTH_CODE_LIMIT_DAILY: "3" });
    try {
      await signup();
      advance(61_000);
      expect((await post("/auth/signup/resend", { email: "ada@example.com" })).statusCode).toBe(200);
      advance(61_000);
      const third = await post("/auth/signup/resend", { email: "ada@example.com" });
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toBe("too_many_codes");
      // Another address is unaffected.
      expect((await post("/auth/signup/resend", { email: "someone-else@example.com" })).statusCode).toBe(200);
      // An hour on: one more, then the day's cap.
      advance(3_600_000);
      expect((await post("/auth/signup/resend", { email: "ada@example.com" })).statusCode).toBe(200);
      advance(3_600_000);
      expect((await post("/auth/signup/resend", { email: "ada@example.com" })).json().error).toBe("too_many_codes");
    } finally {
      restore();
    }
  });
});

describe("the code emailed after the password", () => {
  let restore: () => void;
  beforeEach(() => (restore = withEnv({ AUTH_LOGIN_EMAIL_CODE: "1" })));
  afterEach(() => restore());

  const user = (sub = "u1", email = "a@x.com") => ctx.auth.addUser({ sub, email, name: "Ada" });

  it("holds the sign-in until the emailed code is entered, then sets the session", async () => {
    const u = user();
    const browser = testBrowser(ctx);
    const first = await browser.post("/auth/login", { email: "a@x.com", password: u.password });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ next: "code", email: "a@x.com", challenge: { issuedAt: expect.any(Number), expiresAt: expect.any(Number), resendAt: expect.any(Number), now: expect.any(Number) } });
    expect(first.json().challenge.expiresAt - first.json().challenge.issuedAt).toBe(CODE_TTL_S * 1000);
    // No session, no Cognito token anywhere near the browser; the pending sign-in's cookie is httpOnly and narrow.
    expect(cookie(first, "__session")).toBeUndefined();
    expect(first.body + (first.headers["set-cookie"] ?? "")).not.toMatch(/rt-|at-|fake\./);
    expect(cookie(first, "__login")).toMatch(/HttpOnly/);
    expect(cookie(first, "__login")).toMatch(/Path=\/auth\/login/);
    expect((await browser.get("/me")).statusCode).toBe(401);
    // The email: the code, its lifetime, and the account's name; never the code in the subject.
    const mail = ctx.mailer.sent.at(-1)!;
    expect(mail.to).toBe("a@x.com");
    expect(mail.subject).toBe("Your bizinsights verification code");
    const code = emailedCode("a@x.com");
    expect(mail.subject).not.toContain(code);
    expect(mail.text).toContain("expires in 60 seconds");
    // From the support sender, signed by it; never the shared-link sender.
    expect(mail.from).toBe("BizInsights Support <support@bizinsights.io>");
    expect(mail.text).toMatch(/Regards,\nBizInsights Support\nsupport@bizinsights\.io$/);
    // No account here yet (the first sign-in makes it), so no name to greet by.
    expect(mail.text).toMatch(/^Hello,/);

    const wrong = await browser.post("/auth/login/code", { code: wrongCode(code) });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: "invalid_code", message: "The verification code is incorrect. Please try again." });
    expect((await browser.get("/me")).statusCode).toBe(401);

    const res = await browser.post("/auth/login/code", { code });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: "a@x.com" });
    expect(cookie(res, "__session")).toMatch(/Max-Age=\d+/);
    expect(cookie(res, "__login")).toMatch(/Max-Age=0/);
    expect((await browser.get("/me")).statusCode).toBe(200);
    expect((await userOf("u1")).email).toBe("a@x.com");
    // Spent: the same code (or any) can't sign in again.
    expect((await browser.post("/auth/login/code", { code })).json().error).toBe("login_expired");
    // The next sign-in's email greets the account by name.
    const again = testBrowser(ctx);
    await again.post("/auth/login", { email: "a@x.com", password: u.password });
    expect(ctx.mailer.sent.at(-1)!.text).toMatch(/^Hello Ada,/);
  });

  it("honours \"Keep me signed in\" as ticked with the password", async () => {
    const u = user();
    const browser = testBrowser(ctx);
    await browser.post("/auth/login", { email: "a@x.com", password: u.password, keep: false });
    const res = await browser.post("/auth/login/code", { code: emailedCode("a@x.com") });
    expect(res.statusCode).toBe(200);
    expect(cookie(res, "__session")).toBeDefined();
    expect(cookie(res, "__session")).not.toMatch(/Max-Age/);
  });

  it("refuses the code after 60 seconds; a resend gives a new one and retires the old", async () => {
    const u = user();
    const browser = testBrowser(ctx);
    await browser.post("/auth/login", { email: "a@x.com", password: u.password });
    const code = emailedCode("a@x.com");
    advance(61_000);
    const late = await browser.post("/auth/login/code", { code });
    expect(late.json()).toMatchObject({ error: "expired_code", message: "This code has expired. Request a new code." });
    const resent = await browser.post("/auth/login/code/resend");
    expect(resent.statusCode).toBe(200);
    expect(resent.json()).toMatchObject({ ok: true, message: "A new verification code has been sent.", challenge: { expiresAt: expect.any(Number) } });
    const fresh = emailedCode("a@x.com");
    expect(fresh).not.toBe(code);
    expect((await browser.post("/auth/login/code", { code })).json().error).toBe("invalid_code");
    expect((await browser.post("/auth/login/code", { code: fresh })).statusCode).toBe(200);
  });

  it("refuses a resend until the minute is up, with the standing countdowns, and says where the page stands after a reload", async () => {
    const u = user();
    const browser = testBrowser(ctx);
    const first = (await browser.post("/auth/login", { email: "a@x.com", password: u.password })).json().challenge;
    advance(20_000);
    const tooSoon = await browser.post("/auth/login/code/resend");
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json()).toMatchObject({ error: "resend_cooldown", detail: { challenge: { issuedAt: first.issuedAt, expiresAt: first.expiresAt } } });
    expect(Number(tooSoon.headers["retry-after"])).toBe(40);
    expect(ctx.mailer.sent).toHaveLength(1);
    // A reload asks where it stands: the same code's countdowns, not a reset one.
    const status = await browser.get("/auth/login/code");
    expect(status.json()).toMatchObject({ pending: true, email: "a@x.com", challenge: { issuedAt: first.issuedAt, expiresAt: first.expiresAt, resendAt: first.resendAt } });
    expect(status.json().challenge.now).toBe(Date.now());
    // Nothing pending for a browser that never gave the password.
    expect((await testBrowser(ctx).get("/auth/login/code")).json()).toEqual({ pending: false });
  });

  it("ends the sign-in at the fifth wrong guess and hands Cognito's tokens back", async () => {
    const u = user();
    const browser = testBrowser(ctx);
    await browser.post("/auth/login", { email: "a@x.com", password: u.password });
    const code = emailedCode("a@x.com");
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect((await browser.post("/auth/login/code", { code: wrongCode(code) })).json().error).toBe("invalid_code");
    const fifth = await browser.post("/auth/login/code", { code: wrongCode(code) });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ error: "too_many_attempts", message: "Too many attempts. Please try again later." });
    expect(ctx.auth.calls).toContain("revokeRefreshToken");
    expect((await browser.post("/auth/login/code", { code })).json().error).toBe("login_expired");
    expect((await browser.get("/auth/login/code")).json()).toEqual({ pending: false });
    // The password again starts afresh.
    expect((await browser.post("/auth/login", { email: "a@x.com", password: u.password })).json().next).toBe("code");
    expect((await browser.post("/auth/login/code", { code: emailedCode("a@x.com") })).statusCode).toBe(200);
  });

  it("wants the code in the browser that gave the password, and not after the pending sign-in's ten minutes", async () => {
    const u = user();
    const browser = testBrowser(ctx);
    await browser.post("/auth/login", { email: "a@x.com", password: u.password });
    const code = emailedCode("a@x.com");
    expect((await post("/auth/login/code", { code })).json().error).toBe("login_expired");
    expect((await testBrowser(ctx).post("/auth/login/code", { code })).json().error).toBe("login_expired");
    advance(601_000);
    expect((await browser.post("/auth/login/code/resend")).json().error).toBe("login_expired");
  });

  it("\"Use a different email\" drops the pending sign-in and hands the tokens back", async () => {
    const u = user();
    const browser = testBrowser(ctx);
    await browser.post("/auth/login", { email: "a@x.com", password: u.password });
    const code = emailedCode("a@x.com");
    expect((await browser.delete("/auth/login/code")).json()).toEqual({ ok: true });
    expect(ctx.auth.calls).toContain("revokeRefreshToken");
    expect((await browser.get("/auth/login/code")).json()).toEqual({ pending: false });
    expect((await browser.post("/auth/login/code", { code })).json().error).toBe("login_expired");
  });

  it("leaves an account with an authenticator app on its own code (no downgrade, no email)", async () => {
    const u = user();
    ctx.auth.enableTotp("u1");
    const res = await post("/auth/login", { email: "a@x.com", password: u.password });
    expect(res.json()).toEqual({ next: "mfa" });
    expect(ctx.mailer.sent).toHaveLength(0);
    expect(cookie(res, "__login")).toBeUndefined();
  });

  it("is off without the setting: the password alone signs in, as before", async () => {
    restore();
    const u = user();
    const res = await post("/auth/login", { email: "a@x.com", password: u.password });
    expect(res.json()).toEqual({ user: expect.objectContaining({ email: "a@x.com" }) });
    expect(cookie(res, "__session")).toBeDefined();
    expect(ctx.mailer.sent).toHaveLength(0);
    expect((await get("/auth/config")).json().loginCode).toBe(false);
    restore = () => {};
  });

  it("is announced to the pages", async () => {
    expect((await get("/auth/config")).json().loginCode).toBe(true);
  });

  it("fails closed when the email can't be sent: no session, nothing pending, tokens handed back", async () => {
    const u = user();
    ctx.mailer.fail.push(new Error("provider down"));
    const browser = testBrowser(ctx);
    const res = await browser.post("/auth/login", { email: "a@x.com", password: u.password });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("email_unavailable");
    expect(cookie(res, "__login")).toBeUndefined();
    expect(cookie(res, "__session")).toBeUndefined();
    expect(ctx.auth.calls).toContain("revokeRefreshToken");
    expect((await browser.get("/auth/login/code")).json()).toEqual({ pending: false });
  });

  it("keeps people apart: each browser's code signs in its own account only", async () => {
    const a = user("u1", "a@x.com");
    const b = user("u2", "b@x.com");
    const browserA = testBrowser(ctx);
    const browserB = testBrowser(ctx);
    await browserA.post("/auth/login", { email: "a@x.com", password: a.password });
    await browserB.post("/auth/login", { email: "b@x.com", password: b.password });
    const codeA = emailedCode("a@x.com");
    const codeB = emailedCode("b@x.com");
    expect((await browserB.post("/auth/login/code", { code: codeA })).json().error).toBe(codeA === codeB ? undefined : "invalid_code");
    expect((await browserA.post("/auth/login/code", { code: codeA })).json().user.email).toBe("a@x.com");
    expect((await browserB.post("/auth/login/code", { code: codeB })).json().user.email).toBe("b@x.com");
    expect((await browserA.get("/me")).json().user.email).toBe("a@x.com");
    expect((await browserB.get("/me")).json().user.email).toBe("b@x.com");
  });

  it("signs in exactly once when two right answers race", async () => {
    const u = user();
    const first = await post("/auth/login", { email: "a@x.com", password: u.password });
    const pending = cookiesFrom(first);
    const code = emailedCode("a@x.com");
    const [one, two] = await Promise.all([post("/auth/login/code", { code }, { cookie: pending }), post("/auth/login/code", { code }, { cookie: pending })]);
    const statuses = [one.statusCode, two.statusCode].sort();
    expect(statuses).toEqual([200, 400]);
    const refused = one.statusCode === 400 ? one : two;
    expect(refused.json().error).toBe("expired_code");
    expect([one, two].filter((r) => sessionCookie(r))).toHaveLength(1);
  });

  it("limits the codes an address may be emailed, counting sign-up and sign-in together", async () => {
    const inner = withEnv({ AUTH_CODE_LIMIT_HOURLY: "2" });
    try {
      const u = user();
      const browser = testBrowser(ctx);
      await browser.post("/auth/login", { email: "a@x.com", password: u.password });
      advance(61_000);
      expect((await browser.post("/auth/login/code/resend")).statusCode).toBe(200);
      advance(61_000);
      const refused = await browser.post("/auth/login/code/resend");
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error).toBe("too_many_codes");
      // Another password sign-in can't get a code for the address either, and signs nobody in.
      const again = await testBrowser(ctx).post("/auth/login", { email: "a@x.com", password: u.password });
      expect(again.statusCode).toBe(429);
      expect(cookie(again, "__session")).toBeUndefined();
      expect(ctx.mailer.sent).toHaveLength(2);
    } finally {
      inner();
    }
  });
});
