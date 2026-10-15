import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { compareSnapshots, listFirebaseAccounts, planMigration, snapshotMappings, type FirebaseAccount } from "../src/migration.js";
import { clean, cookiesFrom, ORIGIN, setup, teardown, testBrowser, type TestCtx } from "./helpers.js";

/**
 * The move from Firebase, as a whole: the dry-run plan, the identity mapping
 * firebase_uid -> Cognito sub -> users.id, running it twice, and the proof afterwards that every
 * account and workspace is where it was.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

/** Four merchants from before the move, one workspace each; the Firebase accounts that go with them. */
async function seed() {
  const make = async (uid: string, email: string, verified = true) => {
    const user = await systemDb.user.create({ data: { firebaseUid: uid, email, emailVerified: verified } });
    const ws = await systemDb.workspace.create({ data: { name: `${uid} shop`, memberships: { create: { userId: user.id, role: "owner" } } } });
    return { user, ws };
  };
  const pw = await make("fb-pw", "pw@x.com");
  const google = await make("fb-google", "g@gmail.com");
  const codes = await make("fb-codes", "codes@x.com");
  const gone = await make("fb-gone", "gone@x.com");
  // The password merchant's teammate: a second member of the same workspace.
  await systemDb.membership.create({ data: { workspaceId: pw.ws.id, userId: codes.user.id, role: "analyst" } });
  const firebase: FirebaseAccount[] = [
    { uid: "fb-pw", email: "pw@x.com", emailVerified: true, disabled: false, providers: ["password"], createdAt: null, lastSignInAt: null },
    { uid: "fb-google", email: "g@gmail.com", emailVerified: true, disabled: false, providers: ["google.com"], createdAt: null, lastSignInAt: null },
    { uid: "fb-codes", email: "codes@x.com", emailVerified: true, disabled: false, providers: [], createdAt: null, lastSignInAt: null },
    { uid: "fb-never", email: "never@x.com", emailVerified: false, disabled: false, providers: ["password"], createdAt: null, lastSignInAt: null },
  ];
  ctx.legacy.accounts.set("pw@x.com", { uid: "fb-pw", password: "old-firebase-pass", emailVerified: true, displayName: null });
  return { pw, google, codes, gone, firebase };
}

describe("the dry run", () => {
  it("says how each account will reach Cognito, and what it couldn't check", async () => {
    const { pw, google, codes, gone, firebase } = await seed();
    const plan = await planMigration({ firebase, auth: ctx.auth });
    const status = Object.fromEntries(plan.users.map((r) => [r.userId, r.status]));
    expect(status).toEqual({
      [pw.user.id]: "moves_at_password_sign_in",
      [google.user.id]: "links_at_social_sign_in",
      [codes.user.id]: "needs_password_reset",
      [gone.user.id]: "firebase_account_missing",
    });
    expect(plan.firebaseOnly).toEqual([{ uid: "fb-never", email: "never@x.com" }]);
    expect(plan.totals.on_cognito).toBe(0);
    expect(plan.problems).toEqual([]);
    expect((await planMigration({})).problems).toHaveLength(2);
  });

  it("never carries a password hash, even when Firebase's listing has one", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "t" });
      return Response.json({ users: [{ localId: "fb-1", email: "A@X.com", emailVerified: true, passwordHash: "SECRET-HASH", salt: "SECRET-SALT", providerUserInfo: [{ providerId: "google.com" }] }] });
    }) as typeof fetch;
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = Buffer.from(JSON.stringify({ client_email: "sa@p.iam.gserviceaccount.com", project_id: "p", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) })).toString("base64");
    const accounts = await listFirebaseAccounts(sa, fetchImpl);
    expect(accounts).toEqual([{ uid: "fb-1", email: "a@x.com", emailVerified: true, disabled: false, providers: ["google.com", "password"], createdAt: null, lastSignInAt: null }]);
    expect(JSON.stringify(accounts)).not.toMatch(/SECRET/);
  });
});

describe("moving, and checking nothing moved", () => {
  it("maps firebase_uid -> Cognito sub -> the same users.id, is safe to run twice, and keeps every workspace", async () => {
    const { pw, google, codes, firebase } = await seed();
    const before = await snapshotMappings();

    // The password merchant signs in (twice: the second must change nothing).
    for (let i = 0; i < 2; i++) {
      const res = await ctx.app.inject({ method: "POST", url: "/auth/login", headers: ORIGIN, payload: { email: "pw@x.com", password: "old-firebase-pass" } });
      expect(res.json().user.id).toBe(pw.user.id);
    }
    // The Google merchant comes back through Google.
    const restore = { d: process.env.COGNITO_DOMAIN, p: process.env.COGNITO_IDENTITY_PROVIDERS };
    ctx.setEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "Google" });
    try {
      const browser = testBrowser(ctx);
      const start = await browser.get("/auth/oauth/google/start");
      const back = ctx.auth.federatedSignIn(start.headers.location!, { id: "g-1", email: "g@gmail.com" });
      expect((await browser.post("/auth/oauth/callback", { code: back.code, state: back.state })).json().user.id).toBe(google.user.id);
    } finally {
      ctx.setEnv({ COGNITO_DOMAIN: restore.d ?? "", COGNITO_IDENTITY_PROVIDERS: restore.p ?? "" });
    }
    // The code-only merchant resets a password, then signs in.
    await ctx.app.inject({ method: "POST", url: "/auth/password/forgot", headers: ORIGIN, payload: { email: "codes@x.com" } });
    const code = ctx.auth.code("reset", "codes@x.com");
    await ctx.app.inject({ method: "POST", url: "/auth/password/reset", headers: ORIGIN, payload: { email: "codes@x.com", code, password: "chosen-password", confirmPassword: "chosen-password" } });
    const codesLogin = await ctx.app.inject({ method: "POST", url: "/auth/login", headers: ORIGIN, payload: { email: "codes@x.com", password: "chosen-password" } });
    expect(codesLogin.json().user.id).toBe(codes.user.id);
    // ...and still sees both workspaces they belong to.
    const me = await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie: cookiesFrom(codesLogin) } });
    expect(me.json().workspaces.map((w: { role: string }) => w.role).sort()).toEqual(["analyst", "owner"]);

    // One identity each, linked to the right user, with where it came from.
    const identities = await systemDb.authIdentity.findMany({ orderBy: { createdAt: "asc" } });
    expect(identities.map((i) => [i.userId, i.method, i.migratedFromFirebaseUid])).toEqual([
      [pw.user.id, "password", "fb-pw"],
      [google.user.id, "google", null],
      [codes.user.id, "password", null],
    ]);
    expect(await systemDb.user.count()).toBe(4);
    // The audit trail: who moved how (the code-only merchant: provisioned for the reset, reset, then linked).
    const events = await systemDb.authEvent.findMany({ orderBy: { createdAt: "asc" }, select: { type: true, userId: true } });
    expect(events).toEqual([
      { type: "firebase_account_migrated", userId: pw.user.id },
      { type: "identity_linked", userId: google.user.id },
      { type: "firebase_account_provisioned", userId: codes.user.id },
      { type: "password_reset", userId: codes.user.id },
      { type: "identity_linked", userId: codes.user.id },
    ]);

    const after = await snapshotMappings();
    expect(compareSnapshots(before, after)).toEqual({ preserved: true, checked: 4, differences: [] });
    const plan = await planMigration({ firebase, auth: ctx.auth });
    expect(plan.totals).toMatchObject({ on_cognito: 3, firebase_account_missing: 1 });

    // And the check notices when something did move.
    await systemDb.membership.deleteMany({ where: { userId: codes.user.id, role: "analyst" } });
    const broken = compareSnapshots(before, await snapshotMappings());
    expect(broken.preserved).toBe(false);
    expect(broken.differences).toEqual([expect.stringContaining(`user ${codes.user.id}: workspaces/roles changed`)]);
  });
});
