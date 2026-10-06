import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache, type FetchLike } from "@app/core";
import { FirebaseAuthError, firebaseAuthProvider, FirebaseUnavailableError } from "../src/authProvider.js";

// Talk to a fake Identity Toolkit through the emulator code path (no service account needed).
const EMULATOR = "fake-identitytoolkit:9099";
beforeAll(() => {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = EMULATOR;
  resetEnvCache();
});
afterAll(() => {
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  resetEnvCache();
});

type Account = { localId: string; email: string; emailVerified: boolean };

function fakeToolkit(accounts: Account[]) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const path = String(input)
      .replace(/^http:\/\/[^/]+\/identitytoolkit\.googleapis\.com\/v1\/projects\/[^/:]+/, "")
      .replace(/^http:\/\/[^/]+\/identitytoolkit\.googleapis\.com\/v1/, "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/accounts:lookup") {
      const email = (body.email as string[] | undefined)?.[0];
      return json({ users: accounts.filter((a) => a.email === email) });
    }
    if (path === "/accounts:update") return json({ localId: body.localId });
    if (path === "/accounts:sendOobCode") return json({ email: body.email });
    if (path.startsWith("/accounts:signInWithEmailLink")) {
      if (body.oobCode !== "good-code") return new Response(JSON.stringify({ error: { message: "INVALID_OOB_CODE" } }), { status: 400 });
      const known = accounts.find((a) => a.email === body.email);
      return json({ localId: known?.localId ?? "link-uid", email: body.email, idToken: "x" });
    }
    if (path === "/accounts") return json({ localId: "new-uid" });
    throw new Error(`unexpected call ${path}`);
  };
  return { calls, auth: firebaseAuthProvider(fetchImpl) };
}

describe("upsertVerifiedEmailUser", () => {
  it("creates a verified account when none exists", async () => {
    const { calls, auth } = fakeToolkit([]);
    expect(await auth.upsertVerifiedEmailUser("new@x.com")).toBe("new-uid");
    expect(calls.map((c) => c.path)).toEqual(["/accounts:lookup", "/accounts"]);
    expect(calls[1]!.body).toEqual({ email: "new@x.com", emailVerified: true });
  });

  it("returns an already verified account untouched", async () => {
    const { calls, auth } = fakeToolkit([{ localId: "u1", email: "ok@x.com", emailVerified: true }]);
    expect(await auth.upsertVerifiedEmailUser("ok@x.com")).toBe("u1");
    expect(calls.map((c) => c.path)).toEqual(["/accounts:lookup"]);
  });

  it("takes an unverified (possibly squatted) account away from whoever set it up", async () => {
    const { calls, auth } = fakeToolkit([{ localId: "u2", email: "victim@x.com", emailVerified: false }]);
    const before = Math.floor(Date.now() / 1000);
    expect(await auth.upsertVerifiedEmailUser("victim@x.com")).toBe("u2");
    const update = calls.find((c) => c.path === "/accounts:update")!;
    expect(update.body).toMatchObject({ localId: "u2", emailVerified: true, deleteProvider: ["password"] });
    // Every session and refresh token minted before the email was proven is revoked.
    expect(Number(update.body.validSince)).toBeGreaterThanOrEqual(before);
  });
});

describe("email sign-in links", () => {
  it("asks Firebase to email an in-app sign-in link", async () => {
    const { calls, auth } = fakeToolkit([]);
    await auth.sendEmailSignInLink("a@x.com", "https://app.example/login?emailLink=1");
    expect(calls[0]).toEqual({
      path: "/accounts:sendOobCode",
      body: { requestType: "EMAIL_SIGNIN", email: "a@x.com", continueUrl: "https://app.example/login?emailLink=1", canHandleCodeInApp: true },
    });
  });

  it("redeems a valid code, and secures an account that was never verified", async () => {
    const { calls, auth } = fakeToolkit([{ localId: "u3", email: "squatted@x.com", emailVerified: false }]);
    expect(await auth.redeemEmailSignInLink("squatted@x.com", "good-code")).toBe("u3");
    const update = calls.find((c) => c.path === "/accounts:update")!;
    expect(update.body).toMatchObject({ localId: "u3", emailVerified: true, deleteProvider: ["password"] });
  });

  it("rejects a bad code", async () => {
    const { auth } = fakeToolkit([]);
    await expect(auth.redeemEmailSignInLink("a@x.com", "bad")).rejects.toThrow(/INVALID_OOB_CODE/);
  });
});

describe("telling a bad credential from a broken Firebase", () => {
  /**
   * A provider whose account lookups work but whose every other Identity Toolkit call answers
   * `status` with `message` — i.e. the failure lands on the call that matters, not on the lookup.
   */
  function failing(status: number, message: string) {
    return firebaseAuthProvider(async (input) => {
      const json = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { "content-type": "application/json" } });
      if (String(input).endsWith("/accounts:lookup")) return json({ users: [] });
      return json({ error: { message } }, status);
    });
  }

  it("treats 5xx and 429 as Firebase being unavailable, not as a rejected credential", async () => {
    for (const status of [500, 503, 429]) {
      await expect(failing(status, "BACKEND_ERROR").upsertVerifiedEmailUser("a@x.com")).rejects.toThrow(FirebaseUnavailableError);
    }
  });

  it("treats a 4xx as a problem with what we sent", async () => {
    const err = await failing(400, "INVALID_ID_TOKEN").upsertVerifiedEmailUser("a@x.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FirebaseAuthError);
    expect(err).not.toBeInstanceOf(FirebaseUnavailableError);
    await expect(failing(404, "EMAIL_NOT_FOUND").upsertVerifiedEmailUser("a@x.com")).rejects.toMatchObject({ code: "auth/user-not-found" });
  });

  it("treats a request that never got a response as Firebase being unavailable", async () => {
    const offline = firebaseAuthProvider(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(offline.upsertVerifiedEmailUser("a@x.com")).rejects.toThrow(FirebaseUnavailableError);
  });

  it("doesn't call a sign-in link invalid when Firebase failed to check it", async () => {
    await expect(failing(503, "BACKEND_ERROR").redeemEmailSignInLink("a@x.com", "some-code")).rejects.toThrow(FirebaseUnavailableError);
    await expect(failing(400, "INVALID_OOB_CODE").redeemEmailSignInLink("a@x.com", "some-code")).rejects.toMatchObject({
      code: "auth/invalid-action-code",
    });
  });
});
