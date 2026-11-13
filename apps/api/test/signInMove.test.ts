import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryCoord } from "@app/core";
import { memoryAuthStore, type NewAuthAccount } from "../src/authStore.js";
import { localAuth } from "../src/localAuth.js";
import { hashPassword } from "../src/passwords.js";
import { sendSignInNotices, signInMoveReport, signInNotice } from "../src/signInMove.js";

/**
 * Leaving Cognito (docs/ikorex-migration): who still has a password only there, and the email that
 * tells them how to set it again in the app, before AUTH_MODE goes to "local" and Cognito is deleted.
 */
const account = (over: Partial<NewAuthAccount> & { sub: string }): NewAuthAccount => ({
  username: over.sub,
  loginEmail: null,
  email: "",
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
  movedFrom: "cognito",
  movedAt: new Date(),
  ...over,
});

describe("who is still at Cognito, and their notice (signInMove)", () => {
  let store: ReturnType<typeof memoryAuthStore>;
  let sent: Array<{ to: string; subject: string; text: string; html?: string; purpose?: string }>;
  const mailer = {
    send: async (to: string, subject: string, text: string, html?: string, opts?: { purpose?: string }) => {
      if (to === "bounce@example.com") throw new Error("the mail provider refused it");
      sent.push({ to, subject, text, html, purpose: opts?.purpose });
    },
  };
  const moved = randomUUID();
  const waiting = randomUUID();
  const shell = randomUUID();
  const viaGoogle = randomUUID();

  beforeEach(async () => {
    sent = [];
    store = memoryAuthStore([
      { sub: moved, username: moved, email: "moved@example.com", method: "password" },
      { sub: waiting, username: waiting, email: "waiting@example.com", method: "password" },
      { sub: shell, username: shell, email: "shell@example.com", method: "password" },
      { sub: randomUUID(), username: "google_1", email: "one@gmail.com", method: "google" },
      { sub: viaGoogle, username: "google_2", email: "two@gmail.com", method: "google" },
    ]);
    // Signed in since the switch: Cognito checked the password once and it is kept here.
    await store.create(account({ sub: moved, loginEmail: "moved@example.com", email: "moved@example.com", passwordHash: await hashPassword("a long password") }));
    // Asked for a reset and never finished it: an account here, still without a password.
    await store.create(account({ sub: shell, loginEmail: "shell@example.com", email: "shell@example.com" }));
    // Came through the app's own Google client.
    await store.create(account({ sub: viaGoogle, username: "google_2", email: "two@gmail.com", method: "google", googleSub: "2" }));
  });

  it("counts who has come over and who hasn't, without naming anyone", async () => {
    const report = await signInMoveReport(store);
    expect(report).toEqual({ password: { known: 3, here: 1, left: 2 }, google: { known: 2, here: 1, left: 1 }, unreachable: 0 });
    expect(JSON.stringify(report)).not.toContain("@");
  });

  it("emails only the people whose password is still at Cognito, and never a Google user", async () => {
    const r = await sendSignInNotices({ store, mailer, appUrl: "https://app.example.com/" });
    expect(r).toMatchObject({ dryRun: false, sent: 2, failed: 0, password: { left: 2 } });
    expect(sent.map((m) => m.to).sort()).toEqual(["shell@example.com", "waiting@example.com"]);
    expect(sent[0]).toMatchObject({ subject: "Set your bizinsights password again", purpose: "notice" });
    expect(sent[0]!.text).toContain("https://app.example.com/forgot-password");
    expect(sent[0]!.html).toContain('href="https://app.example.com/forgot-password"');
  });

  it("only counts with dryRun", async () => {
    const r = await sendSignInNotices({ store, mailer, appUrl: "https://app.example.com", dryRun: true });
    expect(r).toMatchObject({ dryRun: true, sent: 2, failed: 0 });
    expect(sent).toEqual([]);
  });

  it("sends one notice to an address two Cognito users share, none where there is no address, and goes on after a failed send", async () => {
    store.identities.push(
      { sub: randomUUID(), username: "second", email: " Waiting@Example.com", method: "password" },
      { sub: randomUUID(), username: "no-address", email: null, method: "password" },
      { sub: randomUUID(), username: "bounces", email: "bounce@example.com", method: "password" },
    );
    const r = await sendSignInNotices({ store, mailer, appUrl: "https://app.example.com" });
    expect(r).toMatchObject({ sent: 2, failed: 1, unreachable: 1 });
    expect(sent.filter((m) => m.to === "waiting@example.com")).toHaveLength(1);
  });

  it("stops naming someone once they have set a password, and someone who signed up again with the same address", async () => {
    const mail: string[] = [];
    const auth = localAuth({ store, coord: memoryCoord(), mailer: { send: async (_to, _s, text) => void mail.push(text) }, findCognitoUsers: true });
    // What the notice asks for: "Forgot password?", the emailed code, a password. Same sub as at Cognito.
    await auth.forgotPassword("waiting@example.com");
    await auth.confirmForgotPassword("waiting@example.com", mail.at(-1)!.match(/\b(\d{6})\b/)![1]!, "a new long password");
    expect(store.accounts.get(waiting)?.passwordHash).toBeTruthy();
    // An identity whose address now belongs to an account made in the app.
    store.identities.push({ sub: randomUUID(), username: "old-self", email: "fresh@example.com", method: "password" });
    await store.create(account({ sub: randomUUID(), loginEmail: "fresh@example.com", email: "fresh@example.com", passwordHash: await hashPassword("another long one"), movedFrom: null, movedAt: null }));

    const r = await sendSignInNotices({ store, mailer, appUrl: "https://app.example.com" });
    expect(r.password).toEqual({ known: 4, here: 3, left: 1 });
    expect(sent.map((m) => m.to)).toEqual(["shell@example.com"]);
  });

  it("writes a notice that says what to do and where", () => {
    const n = signInNotice("https://bizinsights.io");
    expect(n.text).toMatch(/Forgot password\?/);
    expect(n.text).toContain("https://bizinsights.io/forgot-password");
    expect(n.html).not.toMatch(/<script/i);
  });
});
