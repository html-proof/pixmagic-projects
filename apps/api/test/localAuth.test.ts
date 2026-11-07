import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryCoord, type Mailer } from "@app/core";
import { memoryAuthStore } from "../src/authStore.js";
import { CognitoError, CognitoUnavailableError, type CognitoTokens } from "../src/cognito.js";
import { localAuth, type LocalAuth } from "../src/localAuth.js";
import { hashPassword, needsRehash, verifyPassword } from "../src/passwords.js";
import { totpCode } from "../src/totp.js";

/**
 * The app's own sign-in (localAuth.ts) against Cognito's behaviour where the app depends on it
 * (the same answers and error names fakeCognito.ts models), on the in-memory store. The PostgreSQL
 * store is the same interface (authStore.test.ts).
 */
interface Sent {
  to: string;
  subject: string;
  text: string;
}
function inbox() {
  const sent: Sent[] = [];
  const mailer: Mailer = {
    async send(to, subject, text) {
      sent.push({ to, subject, text });
    },
  };
  /** The newest 6-digit code emailed to an address. */
  const code = (to: string) => {
    const m = [...sent].reverse().find((s) => s.to === to);
    const c = m?.text.match(/\b(\d{6})\b/)?.[1];
    if (!c) throw new Error(`no code sent to ${to}`);
    return c;
  };
  return { sent, mailer, code };
}

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CognitoError);
  expect((e as CognitoError).code).toBe(code);
};

describe("passwords", () => {
  it("hashes with argon2id and checks, refusing anything else", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
    expect(await verifyPassword("x", "not a hash")).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA")).toBe(true);
  });
});

describe("the app's own sign-in (localAuth)", () => {
  let store: ReturnType<typeof memoryAuthStore>;
  let mail: ReturnType<typeof inbox>;
  let auth: LocalAuth;
  const coord = memoryCoord();

  beforeEach(() => {
    coord.clear();
    store = memoryAuthStore();
    mail = inbox();
    auth = localAuth({ store, coord, mailer: mail.mailer });
  });

  async function signedUp(email = "pat@example.com", password = "a long password") {
    await auth.signUp({ email, password, name: "Pat" });
    await auth.confirmSignUp(email, mail.code(email));
    const r = await auth.passwordSignIn(email, password);
    if (!("tokens" in r)) throw new Error("expected tokens");
    return r.tokens;
  }

  it("signs up, confirms by the emailed code, and signs in with the password", async () => {
    const { sub, confirmed } = await auth.signUp({ email: "Pat@Example.com", password: "a long password", name: "Pat" });
    expect(confirmed).toBe(false);
    expect(mail.sent[0]!.to).toBe("pat@example.com");
    await rejects(auth.passwordSignIn("pat@example.com", "a long password"), "UserNotConfirmedException");
    await auth.confirmSignUp("pat@example.com", mail.code("pat@example.com"));
    const r = await auth.passwordSignIn("PAT@example.com", "a long password");
    expect("tokens" in r).toBe(true);
    const claims = await auth.verifyIdToken((r as { tokens: CognitoTokens }).tokens.idToken);
    expect(claims).toMatchObject({ sub, username: sub, email: "pat@example.com", emailVerified: true, name: "Pat", method: "password" });
    expect(store.accounts.get(sub)!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("refuses a wrong password, an unknown address, a taken address and a short password, as Cognito does", async () => {
    await signedUp();
    await rejects(auth.passwordSignIn("pat@example.com", "a wrong password"), "NotAuthorizedException");
    await rejects(auth.passwordSignIn("nobody@example.com", "a long password"), "NotAuthorizedException");
    await rejects(auth.signUp({ email: "pat@example.com", password: "another password", name: "x" }), "UsernameExistsException");
    await rejects(auth.signUp({ email: "new@example.com", password: "short", name: "x" }), "InvalidPasswordException");
    await rejects(auth.signUp({ email: "new@example.com", password: " padded password", name: "x" }), "InvalidPasswordException");
  });

  it("takes five wrong guesses at a code, then needs a new one; a right code works once", async () => {
    await auth.signUp({ email: "pat@example.com", password: "a long password", name: "Pat" });
    const good = mail.code("pat@example.com");
    const bad = good === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await rejects(auth.confirmSignUp("pat@example.com", bad), "CodeMismatchException");
    await rejects(auth.confirmSignUp("pat@example.com", bad), "CodeMismatchException");
    await rejects(auth.confirmSignUp("pat@example.com", good), "ExpiredCodeException");
    await auth.resendSignUpCode("pat@example.com");
    await auth.confirmSignUp("pat@example.com", mail.code("pat@example.com"));
    await rejects(auth.confirmSignUp("pat@example.com", mail.code("pat@example.com")), "NotAuthorizedException");
  });

  it("refreshes for the right user name only, and not after signing out everywhere", async () => {
    const t = await signedUp();
    const { sub } = await auth.verifyIdToken(t.idToken);
    const again = await auth.refresh(t.refreshToken!, sub);
    expect(again.refreshToken).toBeUndefined();
    expect((await auth.verifyIdToken(again.idToken)).sub).toBe(sub);
    await rejects(auth.refresh(t.refreshToken!, "someone-else"), "NotAuthorizedException");
    await rejects(auth.refresh("rt-from-cognito", sub), "NotAuthorizedException");
    await auth.globalSignOut(t.accessToken);
    await rejects(auth.refresh(t.refreshToken!, sub), "NotAuthorizedException");
    await rejects(auth.changePassword(t.accessToken, "a long password", "a newer password"), "NotAuthorizedException");
  });

  it("revokes one refresh token without touching the others", async () => {
    const a = await signedUp();
    const r = await auth.passwordSignIn("pat@example.com", "a long password");
    const b = (r as { tokens: CognitoTokens }).tokens;
    const { sub } = await auth.verifyIdToken(a.idToken);
    await auth.revokeRefreshToken(a.refreshToken!);
    await rejects(auth.refresh(a.refreshToken!, sub), "NotAuthorizedException");
    expect((await auth.refresh(b.refreshToken!, sub)).idToken).toBeTruthy();
  });

  it("resets a password by code, and changes it with the old one", async () => {
    await signedUp();
    await auth.forgotPassword("pat@example.com");
    await rejects(auth.confirmForgotPassword("pat@example.com", "999999", "a reset password"), "CodeMismatchException");
    await auth.confirmForgotPassword("pat@example.com", mail.code("pat@example.com"), "a reset password");
    await rejects(auth.passwordSignIn("pat@example.com", "a long password"), "NotAuthorizedException");
    const r = (await auth.passwordSignIn("pat@example.com", "a reset password")) as { tokens: CognitoTokens };
    await rejects(auth.changePassword(r.tokens.accessToken, "not it", "a changed password"), "NotAuthorizedException");
    await auth.changePassword(r.tokens.accessToken, "a reset password", "a changed password");
    expect("tokens" in (await auth.passwordSignIn("pat@example.com", "a changed password"))).toBe(true);
    await rejects(auth.forgotPassword("nobody@example.com"), "UserNotFoundException");
  });

  it("changes the address only once the new one's code comes back", async () => {
    const t = await signedUp();
    await signedUp("taken@example.com");
    await rejects(auth.updateEmail(t.accessToken, "taken@example.com"), "AliasExistsException");
    await auth.updateEmail(t.accessToken, "New@Example.com");
    expect(mail.sent.at(-1)!.to).toBe("new@example.com");
    expect("tokens" in (await auth.passwordSignIn("pat@example.com", "a long password"))).toBe(true);
    await auth.verifyEmail(t.accessToken, mail.code("new@example.com"));
    await rejects(auth.passwordSignIn("pat@example.com", "a long password"), "NotAuthorizedException");
    const r = (await auth.passwordSignIn("new@example.com", "a long password")) as { tokens: CognitoTokens };
    expect((await auth.verifyIdToken(r.tokens.idToken)).email).toBe("new@example.com");
  });

  it("asks for the authenticator app's code once it is set up, three tries, each code once", async () => {
    const t = await signedUp();
    const { secret } = await auth.associateTotp(t.accessToken);
    await rejects(auth.verifyTotp(t.accessToken, "000000" === totpCode(secret) ? "111111" : "000000"), "EnableSoftwareTokenMFAException");
    expect(await auth.verifyTotp(t.accessToken, totpCode(secret))).toBe(true);
    expect((await auth.adminGetUser("pat@example.com"))!.mfaEnabled).toBe(false);
    await auth.setTotpEnabled(t.accessToken, true);
    expect((await auth.adminGetUser("pat@example.com"))!.mfaEnabled).toBe(true);
    const r = await auth.passwordSignIn("pat@example.com", "a long password");
    if (!("challenge" in r)) throw new Error("expected the code step");
    expect(r.challenge).toBe("SOFTWARE_TOKEN_MFA");
    const wrong = totpCode(secret) === "000000" ? "111111" : "000000";
    await rejects(auth.answerTotpChallenge(r.username!, r.session, wrong), "CodeMismatchException");
    const ok = await auth.answerTotpChallenge(r.username!, r.session, totpCode(secret));
    expect("tokens" in ok).toBe(true);
    // The same code again, on a new sign-in: refused.
    const r2 = (await auth.passwordSignIn("pat@example.com", "a long password")) as { session: string; username: string };
    await rejects(auth.answerTotpChallenge(r2.username, r2.session, totpCode(secret)), "CodeMismatchException");
    expect(store.accounts.get(r2.username)!.totpSecret).not.toContain(secret);
  });

  it("finds someone Cognito knew (auth_identities) and lets them in through Forgot password, under the same sub", async () => {
    const sub = randomUUID();
    store.identities.push({ sub, username: sub, email: "old@example.com", method: "password" });
    await rejects(auth.passwordSignIn("old@example.com", "whatever password"), "NotAuthorizedException");
    await auth.forgotPassword("old@example.com");
    expect(store.accounts.get(sub)).toMatchObject({ movedFrom: "cognito", passwordHash: null });
    await auth.confirmForgotPassword("old@example.com", mail.code("old@example.com"), "my new password");
    const r = (await auth.passwordSignIn("old@example.com", "my new password")) as { tokens: CognitoTokens };
    expect((await auth.verifyIdToken(r.tokens.idToken)).sub).toBe(sub);
    await rejects(auth.signUp({ email: "old@example.com", password: "a long password", name: "x" }), "UsernameExistsException");
  });

  it("creates, finds, sets a password for and deletes accounts as the administrator", async () => {
    const u = await auth.adminCreateUser({ email: "staff@example.com", emailVerified: true, name: "Sam" });
    expect(u).toMatchObject({ email: "staff@example.com", status: "CONFIRMED", enabled: true, mfaEnabled: false });
    await rejects(auth.adminCreateUser({ email: "staff@example.com", emailVerified: true }), "UsernameExistsException");
    await rejects(auth.passwordSignIn("staff@example.com", "a long password"), "NotAuthorizedException");
    await auth.adminSetPassword(u.username, "a long password");
    const t = (await auth.passwordSignIn("staff@example.com", "a long password")) as { tokens: CognitoTokens };
    expect((await auth.adminGetUser(u.username))!.sub).toBe(u.sub);
    await auth.adminGlobalSignOut(u.username);
    await rejects(auth.refresh(t.tokens.refreshToken!, u.username), "NotAuthorizedException");
    await auth.adminDeleteUser(u.username);
    expect(await auth.adminGetUser(u.username)).toBeNull();
    await auth.adminDeleteUser(u.username);
  });

  it("refuses tokens it didn't sign, and says which are its own", async () => {
    const t = await signedUp();
    expect(auth.isLocalToken(t.idToken)).toBe(true);
    expect(auth.isLocalRefreshToken(t.refreshToken!)).toBe(true);
    const forged = await new SignJWT({ token_use: "id" }).setProtectedHeader({ alg: "HS256" }).setIssuer("bizinsights:auth").setAudience("bizinsights").setSubject("x").setExpirationTime("1h").sign(Buffer.alloc(32, 1));
    await rejects(auth.verifyIdToken(forged), "InvalidToken");
    await rejects(auth.verifyIdToken(t.accessToken), "InvalidToken");
    await rejects(auth.verifyIdToken(t.idToken, { nonce: "other" }), "InvalidToken");
    expect(auth.isLocalToken("eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwczovL2NvZ25pdG8taWRwIn0.x")).toBe(false);
  });

  it("answers 'unavailable' when its store can't be reached, never 'wrong password'", async () => {
    const broken = { ...store, byLoginEmail: async () => Promise.reject(new Error("connection refused")) };
    const down = localAuth({ store: broken, coord, mailer: mail.mailer });
    await expect(down.passwordSignIn("pat@example.com", "a long password")).rejects.toBeInstanceOf(CognitoUnavailableError);
  });

  describe("Google, on the app's own client", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const clientId = "client.apps.googleusercontent.com";
    let next: Record<string, unknown> = {};
    let sentToGoogle: URLSearchParams | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) {
        const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
        return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
      }
      if (url === "https://oauth2.googleapis.com/token") {
        sentToGoogle = new URLSearchParams(String(init?.body));
        if (sentToGoogle.get("code") === "bad") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        const idToken = await new SignJWT(next).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://accounts.google.com").setAudience(clientId).setIssuedAt().setExpirationTime("5m").sign(privateKey);
        return new Response(JSON.stringify({ id_token: idToken, access_token: "g" }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const g = () => localAuth({ store, coord, mailer: mail.mailer, fetchImpl, google: { clientId, clientSecret: "s3cret" } });

    it("sends the person to Google with PKCE and a nonce, and signs them in from the code", async () => {
      const auth = g();
      const url = new URL(auth.authorizeUrl({ provider: "Google", redirectUri: "https://app.test/auth/callback", state: "st", codeChallenge: "ch", nonce: "n1", selectAccount: true }));
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: clientId, redirect_uri: "https://app.test/auth/callback", code_challenge: "ch", code_challenge_method: "S256", nonce: "n1", prompt: "select_account", scope: "openid email profile" });
      next = { sub: "g-123", email: "Pat@Gmail.com", email_verified: true, name: "Pat G", picture: "https://lh3.googleusercontent.com/p", nonce: "n1" };
      const t = await auth.exchangeCode({ code: "c1", redirectUri: "https://app.test/auth/callback", codeVerifier: "v1" });
      expect(Object.fromEntries(sentToGoogle!)).toMatchObject({ code: "c1", code_verifier: "v1", client_secret: "s3cret", grant_type: "authorization_code" });
      const claims = await auth.verifyIdToken(t.idToken, { nonce: "n1" });
      expect(claims).toMatchObject({ username: "google_g-123", email: "pat@gmail.com", emailVerified: true, method: "google", name: "Pat G" });
      expect(auth.logoutUrl("https://app.test")).toBeNull();
      // The same Google account again is the same account.
      const t2 = await auth.exchangeCode({ code: "c2", redirectUri: "https://app.test/auth/callback", codeVerifier: "v2" });
      expect((await auth.verifyIdToken(t2.idToken)).sub).toBe(claims.sub);
      await rejects(auth.exchangeCode({ code: "bad", redirectUri: "https://app.test/auth/callback", codeVerifier: "v" }), "invalid_grant");
    });

    it("keeps the sub of someone who used Google through Cognito", async () => {
      const sub = randomUUID();
      store.identities.push({ sub, username: "google_g-777", email: "old@gmail.com", method: "google" });
      next = { sub: "g-777", email: "old@gmail.com", email_verified: true, nonce: "n" };
      const t = await g().exchangeCode({ code: "c", redirectUri: "https://app.test/auth/callback", codeVerifier: "v" });
      expect((await g().verifyIdToken(t.idToken)).sub).toBe(sub);
      expect(store.accounts.get(sub)).toMatchObject({ movedFrom: "cognito", googleSub: "g-777" });
    });

    it("refuses a Google token for another client", async () => {
      const auth = localAuth({ store, coord, mailer: mail.mailer, fetchImpl, google: { clientId: "another-client", clientSecret: "x" } });
      next = { sub: "g-1", email: "a@b.c" };
      await rejects(auth.exchangeCode({ code: "c", redirectUri: "r", codeVerifier: "v" }), "InvalidToken");
    });
  });

  it("keeps refresh tokens only as a hash", async () => {
    const t = await signedUp();
    const hash = createHash("sha256").update(t.refreshToken!).digest("hex");
    expect([...store.tokens.keys()]).toContain(hash);
    expect([...store.tokens.keys()].join()).not.toContain(t.refreshToken!);
  });
});
