import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cognitoAuth, cognitoConfig, CognitoError } from "../src/cognito.js";

/**
 * The real Cognito client against a real user pool API: AWS itself, or the local emulator
 * (cognito-local). Off unless COGNITO_LIVE=1, with COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID,
 * COGNITO_CLIENT_SECRET, COGNITO_ADMIN_* (and COGNITO_ENDPOINT for the emulator) set:
 *
 *   COGNITO_LIVE=1 COGNITO_ENDPOINT=http://127.0.0.1:9229 ... pnpm --filter @app/api exec vitest run test/cognito.live.test.ts
 *
 * Steps that need an emailed code read it from the emulator's database (COGNITO_LIVE_DB = its
 * .cognito/db directory); against AWS they are skipped, since the code goes to a real inbox.
 * Every user it creates is deleted again.
 */
const live = process.env.COGNITO_LIVE === "1";
const dbDir = process.env.COGNITO_LIVE_DB;
const run = Date.now().toString(36);

describe.skipIf(!live)("Cognito, live", () => {
  const cfg = live ? cognitoConfig() : null;
  const auth = cfg ? cognitoAuth(cfg) : null!;
  const email = (tag: string) => `live-${tag}-${run}@example.com`;
  /** The newest code "emailed" to an address (the emulator writes its database a moment after answering). */
  const codeFor = async (address: string, not?: string): Promise<string> => {
    for (let i = 0; i < 40; i++) {
      const pool = JSON.parse(readFileSync(join(dbDir!, `${cfg!.userPoolId}.json`), "utf8")) as {
        Users: Record<string, { Attributes: Array<{ Name: string; Value: string }>; ConfirmationCode?: string; AttributeVerificationCode?: string }>;
      };
      const u = Object.values(pool.Users).find((x) => x.Attributes.some((a) => a.Name === "email" && a.Value === address));
      const code = u?.AttributeVerificationCode ?? u?.ConfirmationCode;
      if (code && code !== not) return code;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no code for ${address}`);
  };

  it("is configured", () => {
    expect(cfg, "COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID").not.toBeNull();
  });

  it("creates a user, signs in, verifies the ID token against the pool's keys, refreshes, changes the password, revokes, deletes", async () => {
    const address = email("admin");
    const created = await auth.adminCreateUser({ email: address, emailVerified: true, name: "Live Test", password: "first-password-1" });
    try {
      expect(created.status).toBe("CONFIRMED");
      expect((await auth.adminGetUser(address))?.sub).toBe(created.sub);
      expect(await auth.adminGetUser(email("nobody"))).toBeNull();

      await expect(auth.passwordSignIn(address, "not-the-password")).rejects.toMatchObject({ code: "NotAuthorizedException" });
      const signedIn = await auth.passwordSignIn(address, "first-password-1");
      if (!("tokens" in signedIn)) throw new Error(`challenge ${signedIn.challenge}`);
      const claims = await auth.verifyIdToken(signedIn.tokens.idToken);
      expect(claims).toMatchObject({ sub: created.sub, email: address, method: "password" });
      expect(signedIn.tokens.refreshToken).toBeTruthy();

      const refreshed = await auth.refresh(signedIn.tokens.refreshToken!, claims.sub);
      expect((await auth.verifyIdToken(refreshed.idToken)).sub).toBe(created.sub);

      await auth.changePassword(refreshed.accessToken, "first-password-1", "second-password-2");
      await expect(auth.passwordSignIn(address, "first-password-1")).rejects.toBeInstanceOf(CognitoError);
      const again = await auth.passwordSignIn(address, "second-password-2");
      expect("tokens" in again).toBe(true);

      await auth.revokeRefreshToken(signedIn.tokens.refreshToken!);
      await expect(auth.refresh(signedIn.tokens.refreshToken!, claims.sub)).rejects.toMatchObject({ code: "NotAuthorizedException" });
    } finally {
      await auth.adminDeleteUser(created.username);
    }
    await expect(auth.passwordSignIn(address, "second-password-2")).rejects.toBeInstanceOf(CognitoError);
  });

  it.skipIf(!dbDir)("signs up, refuses sign-in until the emailed code is confirmed, and resets a password by code", async () => {
    const address = email("signup");
    const { sub } = await auth.signUp({ email: address, password: "signup-password-1", name: "Sign Up" });
    try {
      await expect(auth.passwordSignIn(address, "signup-password-1")).rejects.toMatchObject({ code: "UserNotConfirmedException" });
      await expect(auth.confirmSignUp(address, "000000")).rejects.toMatchObject({ code: "CodeMismatchException" });
      await auth.confirmSignUp(address, await codeFor(address));
      expect("tokens" in (await auth.passwordSignIn(address, "signup-password-1"))).toBe(true);

      // A reset code goes only to a verified address (the emulator, unlike Cognito, doesn't mark
      // it verified on confirmation, so verify it explicitly; on Cognito this is a no-op change).
      const s = await auth.passwordSignIn(address, "signup-password-1");
      if ("tokens" in s) {
        await auth.sendEmailVerificationCode(s.tokens.accessToken);
        await auth.verifyEmail(s.tokens.accessToken, await codeFor(address));
      }
      await auth.forgotPassword(address);
      await auth.confirmForgotPassword(address, await codeFor(address), "reset-password-3");
      expect("tokens" in (await auth.passwordSignIn(address, "reset-password-3"))).toBe(true);
    } finally {
      await auth.adminDeleteUser(sub);
    }
  });
});
