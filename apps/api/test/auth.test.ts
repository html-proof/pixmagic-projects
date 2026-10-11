import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { clean, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { FirebaseAuthError, FirebaseUnavailableError } from "../src/authProvider.js";

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

describe("session", () => {
  it("creates a session from an ID token and returns /me", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/auth/session", headers: ORIGIN, payload: { idToken: "idt|u1|A@Example.com|1" } });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("__session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const me = await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie: "__session=sess|u1|a@example.com|1" } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("a@example.com");
  });

  it("rejects unauthenticated and forged sessions", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie: "__session=garbage" } })).statusCode).toBe(401);
  });

  it("/auth/whoami answers /me for a session and a plain 200 for visitors", async () => {
    const { cookie } = await signIn(ctx, "u1", "a@x.com");
    const signedIn = await ctx.app.inject({ method: "GET", url: "/auth/whoami", headers: { cookie } });
    const me = await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie } });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toEqual(me.json());

    const visitors: Record<string, string>[] = [{}, { cookie: "__session=garbage" }];
    for (const headers of visitors) {
      const visitor = await ctx.app.inject({ method: "GET", url: "/auth/whoami", headers });
      expect(visitor.statusCode).toBe(200);
      expect(visitor.json()).toEqual({ user: null, workspaces: [] });
    }
  });

  it("blocks cross-site state-changing requests (CSRF)", async () => {
    const { cookie } = await signIn(ctx, "u1", "a@x.com");
    const res = await ctx.app.inject({ method: "POST", url: "/workspaces", headers: { cookie, origin: "https://evil.example" }, payload: { name: "x" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("when a sign-in can't be verified", () => {
  /** Run `fn` with every Firebase verification failing the given way. */
  async function failingWith(err: unknown, fn: () => Promise<void>) {
    const idToken = ctx.auth.verifyIdToken;
    const session = ctx.auth.verifySessionCookie;
    ctx.auth.verifyIdToken = async () => {
      throw err;
    };
    ctx.auth.verifySessionCookie = async () => {
      throw err;
    };
    try {
      await fn();
    } finally {
      ctx.auth.verifyIdToken = idToken;
      ctx.auth.verifySessionCookie = session;
    }
  }

  const mintSession = () =>
    ctx.app.inject({ method: "POST", url: "/auth/session", headers: ORIGIN, payload: { idToken: "idt|u1|a@example.com|1" } });

  it("says so, retryably, when Firebase is unreachable instead of blaming the token", async () => {
    await failingWith(new FirebaseUnavailableError("Could not fetch Google's token signing keys: fetch failed"), async () => {
      const res = await mintSession();
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("auth_unavailable");
      // And an already signed-in user isn't logged out for the length of the outage.
      const me = await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie: "__session=sess|u1|a@example.com|1" } });
      expect(me.statusCode).toBe(503);
      expect(me.json().error).toBe("auth_unavailable");
    });
  });

  it("distinguishes a disabled account, a deleted one, and a token that needs re-minting", async () => {
    const cases = [
      { err: new FirebaseAuthError("auth/user-disabled", "User is disabled"), status: 403, code: "account_disabled" },
      { err: new FirebaseAuthError("auth/user-not-found", "User no longer exists"), status: 401, code: "account_not_found" },
      { err: new FirebaseAuthError("auth/id-token-revoked", "Token has been revoked"), status: 401, code: "stale_sign_in" },
      { err: new FirebaseAuthError("auth/id-token-expired", "Token expired"), status: 401, code: "stale_sign_in" },
    ];
    for (const { err, status, code } of cases) {
      await failingWith(err, async () => {
        const res = await mintSession();
        expect(res.statusCode, code).toBe(status);
        expect(res.json().error).toBe(code);
      });
    }
  });

  it("still rejects a token that is simply bad", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/auth/session", headers: ORIGIN, payload: { idToken: "not-a-token" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });

  it("doesn't call a sign-in link invalid when it couldn't be checked at all", async () => {
    const redeem = ctx.auth.redeemEmailSignInLink;
    ctx.auth.redeemEmailSignInLink = async () => {
      throw new FirebaseUnavailableError("Redeeming the sign-in link failed (503): backend error");
    };
    try {
      const res = await ctx.app.inject({ method: "POST", url: "/auth/email-link/verify", headers: ORIGIN, payload: { email: "link@x.com", oobCode: "link-link@x.com" } });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("auth_unavailable");
    } finally {
      ctx.auth.redeemEmailSignInLink = redeem;
    }
  });
});

describe("email OTP", () => {
  const request = (email: string) => ctx.app.inject({ method: "POST", url: "/auth/otp/request", headers: ORIGIN, payload: { email } });
  const verify = (email: string, code: string) => ctx.app.inject({ method: "POST", url: "/auth/otp/verify", headers: ORIGIN, payload: { email, code } });
  const lastCode = () => /(\d{6})/.exec(ctx.mailer.sent.at(-1)!.subject)![1]!;

  it("issues a code by email, stores only a hash, and verifies once", async () => {
    expect((await request("Bob@x.com")).statusCode).toBe(200);
    const code = lastCode();
    const row = await systemDb.emailOtp.findFirstOrThrow({ where: { email: "bob@x.com" } });
    expect(row.codeHash).not.toContain(code);
    const ok = await verify("bob@x.com", code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().customToken).toBe("custom-otp-bob@x.com");
    expect((await verify("bob@x.com", code)).statusCode).toBe(400); // single use
  });

  it("locks after 5 wrong attempts even if the right code is then sent", async () => {
    await request("c@x.com");
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await verify("c@x.com", wrong)).statusCode).toBe(400);
    expect((await verify("c@x.com", code)).statusCode).toBe(400);
  });

  it("only the newest code is valid", async () => {
    await request("d@x.com");
    const first = lastCode();
    await request("d@x.com");
    const second = lastCode();
    if (first !== second) expect((await verify("d@x.com", first)).statusCode).toBe(400);
    expect((await verify("d@x.com", second)).statusCode).toBe(200);
  });

  it("rejects expired codes", async () => {
    await request("e@x.com");
    const code = lastCode();
    await systemDb.emailOtp.updateMany({ where: { email: "e@x.com" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify("e@x.com", code)).statusCode).toBe(400);
  });

  it("rate limits requests per email", async () => {
    for (let i = 0; i < 3; i++) expect((await request("f@x.com")).statusCode).toBe(200);
    expect((await request("f@x.com")).statusCode).toBe(429);
  });

  describe("when codes can't be emailed", () => {
    /** Run `fn` with the app's mailer failing (e.g. no sending domain set up in production). */
    async function withBrokenMailer(fn: () => Promise<void>) {
      const send = ctx.deps.mailer.send;
      ctx.deps.mailer.send = async () => {
        throw new Error("email from example.com not allowed because domain is not owned by the same account");
      };
      try {
        await fn();
      } finally {
        ctx.deps.mailer.send = send;
      }
    }

    it("falls back to a Firebase sign-in link that returns to /login", async () => {
      await withBrokenMailer(async () => {
        const res = await request("Link@x.com");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, method: "link" });
        // The destination is always ours: whatever the client says about it is ignored.
        const evil = await ctx.app.inject({ method: "POST", url: "/auth/otp/request", headers: ORIGIN, payload: { email: "e@x.com", continuePath: "https://evil.example" } });
        expect(evil.json().method).toBe("link");
      });
      expect(ctx.auth.links).toEqual([
        { email: "link@x.com", continueUrl: "http://localhost:3001/login?emailLink=1" },
        { email: "e@x.com", continueUrl: "http://localhost:3001/login?emailLink=1" },
      ]);
    });

    it("redeems the link's code for a sign-in token, once and only for that email", async () => {
      await withBrokenMailer(async () => {
        await request("link@x.com");
      });
      const redeem = (email: string, oobCode: string) => ctx.app.inject({ method: "POST", url: "/auth/email-link/verify", headers: ORIGIN, payload: { email, oobCode } });
      const bad = await redeem("other@x.com", "link-link@x.com");
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe("invalid_link");
      const ok = await redeem("Link@x.com", "link-link@x.com");
      expect(ok.statusCode).toBe(200);
      expect(ok.json().customToken).toBe("custom-link-link@x.com");
    });

    it("says so plainly when no email can be sent at all", async () => {
      const sendLink = ctx.auth.sendEmailSignInLink;
      ctx.auth.sendEmailSignInLink = async () => {
        throw new Error("firebase down");
      };
      try {
        await withBrokenMailer(async () => {
          const res = await request("none@x.com");
          expect(res.statusCode).toBe(503);
          expect(res.json().error).toBe("email_unavailable");
        });
      } finally {
        ctx.auth.sendEmailSignInLink = sendLink;
      }
    });
  });
});
