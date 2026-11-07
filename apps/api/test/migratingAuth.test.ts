import { beforeEach, describe, expect, it } from "vitest";
import { memoryCoord, type Mailer } from "@app/core";
import { memoryAuthStore } from "../src/authStore.js";
import { CognitoError, type CognitoAuth, type CognitoTokens } from "../src/cognito.js";
import { localAuth, type LocalAuth } from "../src/localAuth.js";
import { migratingAuth } from "../src/migratingAuth.js";
import { fakeCognito, totpCode, type FakeCognito } from "./fakeCognito.js";

/**
 * AUTH_MODE "migrating" (migratingAuth.ts): Cognito's users come over at their next sign-in, under
 * the same sub, and from then on Cognito isn't asked about them.
 */
const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CognitoError);
  expect((e as CognitoError).code).toBe(code);
};

describe("moving Cognito's users over (migratingAuth)", () => {
  const coord = memoryCoord();
  let cognito: FakeCognito;
  let store: ReturnType<typeof memoryAuthStore>;
  let local: LocalAuth;
  let auth: CognitoAuth;
  let sent: Array<{ to: string; subject: string; text: string }>;

  beforeEach(() => {
    coord.clear();
    cognito = fakeCognito();
    store = memoryAuthStore();
    sent = [];
    const mailer: Mailer = {
      async send(to, subject, text) {
        sent.push({ to, subject, text });
      },
    };
    local = localAuth({ store, coord, mailer, findCognitoUsers: false });
    auth = migratingAuth({ local, cognito, coord, mailer, localGoogle: false });
  });

  it("checks a first password with Cognito, keeps it here under the same sub, and never asks Cognito again", async () => {
    const u = cognito.addUser({ email: "pat@example.com", password: "a long password", name: "Pat" });
    const r = (await auth.passwordSignIn("pat@example.com", "a long password")) as { tokens: CognitoTokens };
    expect(local.isLocalToken(r.tokens.idToken)).toBe(true);
    expect((await auth.verifyIdToken(r.tokens.idToken)).sub).toBe(u.sub);
    expect(store.accounts.get(u.sub)).toMatchObject({ movedFrom: "cognito", loginEmail: "pat@example.com", username: u.username });
    expect(store.accounts.get(u.sub)!.passwordHash).toMatch(/^\$argon2id\$/);
    // Cognito's refresh token from that sign-in was handed back.
    expect(cognito.calls).toContain("revokeRefreshToken");
    cognito.calls.length = 0;
    cognito.state.unavailable = true;
    const again = await auth.passwordSignIn("pat@example.com", "a long password");
    expect("tokens" in again).toBe(true);
    await rejects(auth.passwordSignIn("pat@example.com", "a wrong password"), "NotAuthorizedException");
    expect(cognito.calls).not.toContain("passwordSignIn");
  });

  it("moves nobody on a wrong password", async () => {
    cognito.addUser({ email: "pat@example.com", password: "a long password" });
    await rejects(auth.passwordSignIn("pat@example.com", "not the password"), "NotAuthorizedException");
    expect(store.accounts.size).toBe(0);
  });

  it("lets someone with an authenticator app at Cognito answer it there, then brings them over and asks them to set it up again", async () => {
    const u = cognito.addUser({ email: "pat@example.com", password: "a long password" });
    const secret = cognito.enableTotp(u.username);
    const r = await auth.passwordSignIn("pat@example.com", "a long password");
    if (!("challenge" in r)) throw new Error("expected the code step");
    expect(r.session.startsWith("cog.")).toBe(true);
    const t = (await auth.answerTotpChallenge(r.username!, r.session, totpCode(secret))) as { tokens: CognitoTokens };
    expect((await auth.verifyIdToken(t.tokens.idToken)).sub).toBe(u.sub);
    expect(store.accounts.get(u.sub)).toMatchObject({ totpEnabled: false });
    expect(sent.find((s) => s.to === "pat@example.com")?.subject).toBe("Set up two-step verification again");
    expect("tokens" in (await auth.passwordSignIn("pat@example.com", "a long password"))).toBe(true);
  });

  it("keeps sessions from before the switch on Cognito, and new ones here", async () => {
    const u = cognito.addUser({ email: "pat@example.com", password: "a long password" });
    const before = (await cognito.passwordSignIn("pat@example.com", "a long password")) as { tokens: CognitoTokens };
    const refreshed = await auth.refresh(before.tokens.refreshToken!, u.username);
    expect(refreshed.idToken.startsWith("fake.")).toBe(true);
    expect((await auth.verifyIdToken(before.tokens.idToken)).sub).toBe(u.sub);
    const now = (await auth.passwordSignIn("pat@example.com", "a long password")) as { tokens: CognitoTokens };
    expect(local.isLocalToken((await auth.refresh(now.tokens.refreshToken!, u.username)).idToken)).toBe(true);
  });

  it("brings in someone the app never saw sign in through Forgot password, asking Cognito who they are", async () => {
    const u = cognito.addUser({ email: "quiet@example.com", password: "forgotten password" });
    await auth.forgotPassword("quiet@example.com");
    const code = sent.at(-1)!.text.match(/\b(\d{6})\b/)![1]!;
    await auth.confirmForgotPassword("quiet@example.com", code, "a brand new password");
    const r = (await auth.passwordSignIn("quiet@example.com", "a brand new password")) as { tokens: CognitoTokens };
    expect((await auth.verifyIdToken(r.tokens.idToken)).sub).toBe(u.sub);
    await rejects(auth.forgotPassword("nobody@example.com"), "UserNotFoundException");
  });

  it("signs new people up here only, and refuses an address Cognito still has", async () => {
    cognito.addUser({ email: "old@example.com" });
    await auth.signUp({ email: "new@example.com", password: "a long password", name: "New" });
    expect(cognito.calls).not.toContain("signUp");
    await rejects(auth.adminCreateUser({ email: "old@example.com", emailVerified: true }), "UsernameExistsException");
  });

  it("deletes and signs out on both sides", async () => {
    const u = cognito.addUser({ email: "pat@example.com", password: "a long password" });
    await auth.passwordSignIn("pat@example.com", "a long password");
    await auth.adminGlobalSignOut(u.username);
    await auth.adminDeleteUser(u.username);
    expect(store.accounts.has(u.sub)).toBe(false);
    expect(cognito.users.has(u.sub)).toBe(false);
  });

  it("asks Cognito for an account that isn't here yet, with its two-step setting as it is", async () => {
    const u = cognito.addUser({ email: "pat@example.com", password: "a long password" });
    cognito.enableTotp(u.username);
    expect((await auth.adminGetUser(u.username))!.mfaEnabled).toBe(true);
  });
});
