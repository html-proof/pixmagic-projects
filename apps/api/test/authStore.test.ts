import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryCoord } from "@app/core";
import { systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { AccountExistsError, prismaAuthStore, type NewAuthAccount } from "../src/authStore.js";
import { localAuth } from "../src/localAuth.js";

/**
 * The app's own sign-in directory in PostgreSQL (auth_accounts, auth_refresh_tokens) through the
 * system role, as production runs it: the same rules the in-memory store keeps, and the way people
 * Cognito knew are found through auth_identities.
 */
const account = (over: Partial<NewAuthAccount> = {}): NewAuthAccount => {
  const sub = over.sub ?? randomUUID();
  return {
    sub,
    username: sub,
    loginEmail: `${sub.slice(0, 8)}@example.com`,
    email: `${sub.slice(0, 8)}@example.com`,
    emailVerified: true,
    pendingEmail: null,
    name: null,
    picture: null,
    method: "password",
    passwordHash: null,
    googleSub: null,
    confirmed: true,
    enabled: true,
    totpSecret: null,
    totpPending: null,
    totpEnabled: false,
    movedFrom: null,
    movedAt: null,
    ...over,
  };
};

describe("the sign-in directory in PostgreSQL (prismaAuthStore)", () => {
  const store = prismaAuthStore();
  beforeEach(async () => resetDb());

  it("creates, finds, updates and removes accounts, refusing a second address or user name", async () => {
    const a = await store.create(account({ loginEmail: "pat@example.com", email: "pat@example.com" }));
    expect((await store.byLoginEmail("PAT@example.com"))?.sub).toBe(a.sub);
    expect((await store.byUsername(a.username))?.sub).toBe(a.sub);
    await expect(store.create(account({ loginEmail: "pat@example.com" }))).rejects.toBeInstanceOf(AccountExistsError);
    await expect(store.create(account({ username: a.username }))).rejects.toBeInstanceOf(AccountExistsError);
    const b = await store.create(account());
    await expect(store.update(b.sub, { loginEmail: "pat@example.com" })).rejects.toBeInstanceOf(AccountExistsError);
    expect((await store.update(a.sub, { name: "Pat" }))?.name).toBe("Pat");
    expect(await store.update(randomUUID(), { name: "x" })).toBeNull();
    await store.remove(a.sub);
    expect(await store.bySub(a.sub)).toBeNull();
  });

  it("keeps refresh tokens, revokes one or all, and drops them with their account", async () => {
    const a = await store.create(account());
    const later = new Date(Date.now() + 60_000);
    await store.addRefreshToken("h1", a.sub, later);
    await store.addRefreshToken("h2", a.sub, later);
    await store.revokeRefreshToken("h1");
    expect((await store.refreshToken("h1"))?.revokedAt).toBeInstanceOf(Date);
    expect((await store.refreshToken("h2"))?.revokedAt).toBeNull();
    await store.revokeRefreshTokens(a.sub);
    expect((await store.refreshToken("h2"))?.revokedAt).toBeInstanceOf(Date);
    await store.remove(a.sub);
    expect(await store.refreshToken("h2")).toBeNull();
  });

  it("finds the people Cognito knew through auth_identities, by user name and by address", async () => {
    const user = await systemDb.user.create({ data: { email: "old@example.com", emailVerified: true } });
    const sub = randomUUID();
    await systemDb.authIdentity.create({ data: { userId: user.id, provider: "cognito", subject: sub, username: sub, method: "password", email: "Old@Example.com" } });
    await systemDb.authIdentity.create({ data: { userId: user.id, provider: "cognito", subject: randomUUID(), username: "google_42", method: "google", email: "old@gmail.com" } });
    expect(await store.cognitoPasswordIdentityByEmail("old@example.com")).toEqual({ sub, username: sub, email: "old@example.com", method: "password" });
    expect((await store.cognitoIdentityByUsername("google_42"))?.method).toBe("google");
    expect(await store.cognitoPasswordIdentityByEmail("old@gmail.com")).toBeNull();
    // All of them, for the count of who still has to come over (signInMove.ts).
    expect((await store.cognitoIdentities()).map((i) => `${i.method}:${i.email}`).sort()).toEqual(["google:old@gmail.com", "password:old@example.com"]);

    // And the app's own sign-in lets them back in under that sub (AUTH_MODE "local").
    const mail: string[] = [];
    const auth = localAuth({ store, coord: memoryCoord(), mailer: { send: async (_to, _s, text) => void mail.push(text) } });
    await auth.forgotPassword("old@example.com");
    const code = mail.at(-1)!.match(/\b(\d{6})\b/)![1]!;
    await auth.confirmForgotPassword("old@example.com", code, "a new long password");
    const r = await auth.passwordSignIn("old@example.com", "a new long password");
    if (!("tokens" in r)) throw new Error("expected tokens");
    expect((await auth.verifyIdToken(r.tokens.idToken)).sub).toBe(sub);
    expect((await systemDb.authAccount.findUnique({ where: { sub } }))?.movedFrom).toBe("cognito");
  });
});
