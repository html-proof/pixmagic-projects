import { logger, type Mailer } from "@app/core";
import type { AuthStore, CognitoIdentity } from "./authStore.js";

/**
 * Who still signs in through Amazon Cognito, and the email that brings them over before it goes
 * (docs/ikorex-migration/ROLLBACK_PLAN.md, "Before stage F starts", step 3).
 *
 * Cognito never hands over a password, so the app's own sign-in (localAuth.ts) learns each one at
 * that person's next sign-in while AUTH_MODE is "migrating". Whoever hasn't signed in by the time
 * Cognito is deleted has no password here. They lose nothing else: "Forgot password?" finds them
 * through auth_identities (AUTH_MODE "local") and sets a password under the same sub. The notice
 * tells them so before they meet "Incorrect email or password".
 *
 * People who sign in with Google need nothing from this: Google vouches for them at each sign-in,
 * and the app's own Google client (GOOGLE_SIGNIN_CLIENT_ID) finds them by the name Cognito gave
 * them. What they need is that client switched on before Cognito goes, which the report says.
 *
 * No address leaves this module except to the mailer: the results are counts.
 */
export interface SignInMoveReport {
  /** People with a Cognito password: `here` have one in the app too, `left` still have it only at Cognito. */
  password: { known: number; here: number; left: number };
  /** People who sign in with Google: `here` have already come through the app's own Google client. */
  google: { known: number; here: number; left: number };
  /** Of password.left, those with no address on record: no notice can reach them. */
  unreachable: number;
}

export interface SignInNoticeResult extends SignInMoveReport {
  dryRun: boolean;
  /** Notices handed to the mailer (with dryRun: that would be). */
  sent: number;
  failed: number;
}

interface Left {
  identity: CognitoIdentity;
  email: string | null;
}

/** One person per address: two Cognito users with one address get one notice. */
async function passwordsLeft(store: AuthStore, identities: CognitoIdentity[]): Promise<{ here: number; left: Left[] }> {
  let here = 0;
  const left: Left[] = [];
  const seen = new Set<string>();
  for (const identity of identities) {
    const email = identity.email?.trim().toLowerCase() || null;
    const account = (await store.bySub(identity.sub)) ?? (email ? await store.byLoginEmail(email) : null);
    if (account?.passwordHash) {
      here++;
      continue;
    }
    if (email && seen.has(email)) continue;
    if (email) seen.add(email);
    left.push({ identity, email });
  }
  return { here, left };
}

async function survey(store: AuthStore): Promise<{ report: SignInMoveReport; left: Left[] }> {
  const identities = await store.cognitoIdentities();
  const password = identities.filter((i) => i.method === "password");
  const google = identities.filter((i) => i.method === "google");
  const { here, left } = await passwordsLeft(store, password);
  let googleHere = 0;
  for (const i of google) if ((await store.bySub(i.sub))?.googleSub) googleHere++;
  return {
    report: {
      password: { known: password.length, here, left: left.length },
      google: { known: google.length, here: googleHere, left: google.length - googleHere },
      unreachable: left.filter((l) => !l.email).length,
    },
    left,
  };
}

/** Counts only: how many of Cognito's users the app's own sign-in already has. */
export async function signInMoveReport(store: AuthStore): Promise<SignInMoveReport> {
  return (await survey(store)).report;
}

export function signInNotice(appUrl: string): { subject: string; text: string; html: string } {
  const link = `${appUrl.replace(/\/+$/, "")}/forgot-password`;
  const lines = [
    "bizinsights has moved to its own servers, and its sign-in moved with it.",
    "Your account, your stores and your data are unchanged. Your password is the one thing that could not be carried over: passwords are kept so that nobody can read them, the old sign-in service included.",
    `So the next time you sign in, choose "Forgot password?" and set a password with the code we email you. You can keep the one you had.`,
  ];
  return {
    subject: "Set your bizinsights password again",
    text: `${lines.join("\n\n")}\n\n${link}\n\nIf you sign in with Google, nothing changes and you can ignore this email.`,
    html: `${lines.map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("")}<p><a href="${link}">Set your password</a></p><p>If you sign in with Google, nothing changes and you can ignore this email.</p>`,
  };
}

/**
 * Emails everyone whose password is still only at Cognito. Safe to run again: whoever has set a
 * password since is no longer on the list. One failed send doesn't stop the rest.
 */
export async function sendSignInNotices(deps: { store: AuthStore; mailer: Mailer; appUrl: string; dryRun?: boolean }): Promise<SignInNoticeResult> {
  const { report, left } = await survey(deps.store);
  const notice = signInNotice(deps.appUrl);
  let sent = 0;
  let failed = 0;
  for (const { email } of left) {
    if (!email) continue;
    if (deps.dryRun) {
      sent++;
      continue;
    }
    try {
      await deps.mailer.send(email, notice.subject, notice.text, notice.html, { purpose: "notice" });
      sent++;
    } catch (err) {
      failed++;
      logger.error({ err }, "sign-in move: could not email a notice");
    }
  }
  return { ...report, dryRun: !!deps.dryRun, sent, failed };
}
