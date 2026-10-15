import { importPKCS8, SignJWT } from "jose";
import { systemDb } from "@app/db";
import type { FetchLike } from "@app/core";
import type { CognitoAuth } from "./cognito.js";

/**
 * Planning and checking the move from Firebase Authentication to Cognito (docs/cognito-setup.md,
 * "Migrating existing accounts"). Nothing here signs anyone in or changes an account: the move
 * itself happens one person at a time, at their first sign-in (routes/auth.ts), which is what makes
 * it idempotent (auth_identities is unique per Cognito user) and auditable (auth_events). This is
 * the dry run before the cutover and the proof after it:
 *
 *   firebase_uid  ->  cognito sub  ->  users.id (unchanged), and every workspace still where it was.
 *
 * Password hashes are never read: Firebase's listing includes them, and they are dropped field by
 * field before anything else sees the account.
 */

export interface FirebaseAccount {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  disabled: boolean;
  /** "password", "google.com", "apple.com", ... */
  providers: string[];
  createdAt: string | null;
  lastSignInAt: string | null;
}

/** Every account in the Firebase project (Identity Toolkit, with the project's service account). */
export async function listFirebaseAccounts(serviceAccountB64: string, fetchImpl: FetchLike = fetch): Promise<FirebaseAccount[]> {
  const sa = JSON.parse(Buffer.from(serviceAccountB64, "base64").toString("utf8")) as { client_email: string; private_key: string; project_id: string };
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(await importPKCS8(sa.private_key, "RS256"));
  const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!tokenRes.ok) throw new Error(`Google token request failed (${tokenRes.status})`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const out: FirebaseAccount[] = [];
  let page: string | undefined;
  do {
    const q = new URLSearchParams({ maxResults: "1000", ...(page ? { nextPageToken: page } : {}) });
    const res = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/accounts:batchGet?${q}`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    if (!res.ok) throw new Error(`Listing Firebase accounts failed (${res.status})`);
    const body = (await res.json()) as {
      users?: Array<{ localId: string; email?: string; emailVerified?: boolean; disabled?: boolean; providerUserInfo?: Array<{ providerId: string }>; passwordHash?: string; createdAt?: string; lastLoginAt?: string }>;
      nextPageToken?: string;
    };
    for (const u of body.users ?? []) {
      // Only what the plan needs; passwordHash and salt are left behind here.
      out.push({
        uid: u.localId,
        email: u.email?.toLowerCase() ?? null,
        emailVerified: !!u.emailVerified,
        disabled: !!u.disabled,
        providers: [...new Set([...(u.providerUserInfo ?? []).map((p) => p.providerId), ...(u.passwordHash ? ["password"] : [])])].sort(),
        createdAt: u.createdAt ? new Date(Number(u.createdAt)).toISOString() : null,
        lastSignInAt: u.lastLoginAt ? new Date(Number(u.lastLoginAt)).toISOString() : null,
      });
    }
    page = body.nextPageToken || undefined;
  } while (page);
  return out;
}

/** Where one account stands, and what will move it. */
export type MigrationStatus =
  /** Already signs in through Cognito (auth_identities). */
  | "on_cognito"
  /** Firebase password account: moves at the first sign-in with that password (or by "Forgot password?"). */
  | "moves_at_password_sign_in"
  /** Google account: links at the first Google sign-in, by its verified email. */
  | "links_at_social_sign_in"
  /** Signed in with emailed codes or links (or Apple, no longer offered) only: "Forgot password?" (or a Google sign-in) moves it. */
  | "needs_password_reset"
  /** Its Firebase account is gone or disabled: only "Forgot password?" brings it back, to the same user. */
  | "firebase_account_missing"
  /** No Firebase uid and no identity: nothing can sign in to it (an anomaly to look at). */
  | "unreachable";

export interface PlanRow {
  userId: string;
  email: string;
  emailVerified: boolean;
  firebaseUid: string | null;
  status: MigrationStatus;
  firebase: Pick<FirebaseAccount, "providers" | "emailVerified" | "disabled" | "lastSignInAt"> | null;
  /** The Cognito email-and-password user for this address, when one exists. */
  cognitoPasswordUser: { sub: string; status: string; emailVerified: boolean } | null;
  identities: Array<{ method: string; subject: string; migratedFromFirebaseUid: string | null }>;
  workspaces: number;
  employments: number;
  notes: string[];
}

export interface MigrationPlan {
  generatedAt: string;
  totals: Record<MigrationStatus, number>;
  users: PlanRow[];
  /** Firebase accounts with no user of ours (never finished signing in): nothing to move. */
  firebaseOnly: Array<{ uid: string; email: string | null }>;
  /** Things to look at before the cutover. */
  problems: string[];
}

/**
 * The dry run: every user, how they will reach Cognito, and anything that would stop them. Reads
 * only. `firebase` (all Firebase accounts) and `auth` (to look up Cognito users) are optional: the
 * plan says what it couldn't check.
 */
export async function planMigration(input: { firebase?: FirebaseAccount[] | null; auth?: CognitoAuth | null }): Promise<MigrationPlan> {
  const users = await systemDb.user.findMany({
    include: {
      identities: { select: { method: true, subject: true, migratedFromFirebaseUid: true } },
      _count: { select: { memberships: true, employments: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const byUid = new Map((input.firebase ?? []).map((a) => [a.uid, a]));
  const byEmail = new Map<string, FirebaseAccount[]>();
  for (const a of input.firebase ?? []) if (a.email) byEmail.set(a.email, [...(byEmail.get(a.email) ?? []), a]);
  const problems: string[] = [];
  if (!input.firebase) problems.push("Firebase accounts not listed (no FIREBASE_SERVICE_ACCOUNT_B64): providers and missing accounts are not checked.");
  if (!input.auth) problems.push("Cognito not consulted (no COGNITO_* settings): existing Cognito users are not checked.");

  const rows: PlanRow[] = [];
  for (const u of users) {
    const fb = u.firebaseUid ? (byUid.get(u.firebaseUid) ?? null) : null;
    const notes: string[] = [];
    let cognitoPasswordUser: PlanRow["cognitoPasswordUser"] = null;
    if (input.auth) {
      const c = await input.auth.adminGetUser(u.email).catch((err: unknown) => {
        notes.push(`Cognito lookup failed: ${(err as Error).message}`);
        return null;
      });
      if (c) cognitoPasswordUser = { sub: c.sub, status: c.status, emailVerified: c.emailVerified };
    }
    let status: MigrationStatus;
    if (u.identities.length) status = "on_cognito";
    else if (!u.firebaseUid) status = "unreachable";
    else if (input.firebase && (!fb || fb.disabled)) status = "firebase_account_missing";
    else if (!fb) status = "moves_at_password_sign_in"; // unknown providers: password is the common case, reset covers the rest
    else if (fb.providers.includes("password")) status = "moves_at_password_sign_in";
    else if (fb.providers.includes("google.com")) status = "links_at_social_sign_in";
    else status = "needs_password_reset";

    if (fb && fb.email && fb.email !== u.email) notes.push(`Firebase has another address for this account (${fb.email}); the move follows the Firebase uid, not the address.`);
    if (!u.emailVerified) notes.push("Email not verified: after the move a code to the address verifies it.");
    if (fb?.providers.includes("apple.com")) notes.push("Signed in with Apple, which Insights no longer offers: \"Forgot password?\" moves it.");
    if (status === "links_at_social_sign_in" && !u.emailVerified) notes.push("Unverified address: a social sign-in can't link to it; use Forgot password.");
    if (cognitoPasswordUser && status !== "on_cognito") {
      notes.push("A Cognito password user already exists for this address: its password, not Firebase's, will be the one that works.");
    }
    if ((byEmail.get(u.email)?.length ?? 0) > 1) notes.push("Several Firebase accounts share this address.");
    if (status === "unreachable") problems.push(`User ${u.id} has neither a Firebase account nor a Cognito identity.`);
    rows.push({
      userId: u.id,
      email: u.email,
      emailVerified: u.emailVerified,
      firebaseUid: u.firebaseUid,
      status,
      firebase: fb ? { providers: fb.providers, emailVerified: fb.emailVerified, disabled: fb.disabled, lastSignInAt: fb.lastSignInAt } : null,
      cognitoPasswordUser,
      identities: u.identities,
      workspaces: u._count.memberships,
      employments: u._count.employments,
      notes,
    });
  }
  const known = new Set(users.map((u) => u.firebaseUid).filter(Boolean));
  const totals = Object.fromEntries(
    (["on_cognito", "moves_at_password_sign_in", "links_at_social_sign_in", "needs_password_reset", "firebase_account_missing", "unreachable"] as const).map((s) => [s, rows.filter((r) => r.status === s).length]),
  ) as Record<MigrationStatus, number>;
  return {
    generatedAt: new Date().toISOString(),
    totals,
    users: rows,
    firebaseOnly: (input.firebase ?? []).filter((a) => !known.has(a.uid)).map((a) => ({ uid: a.uid, email: a.email })),
    problems,
  };
}

/** Who belongs where: the part of the data a sign-in change must never move. */
export interface MappingSnapshot {
  takenAt: string;
  users: Record<string, { email: string; firebaseUid: string | null; memberships: string[]; employments: string[]; managedStaff: number }>;
}

export async function snapshotMappings(): Promise<MappingSnapshot> {
  const users = await systemDb.user.findMany({
    include: {
      memberships: { select: { workspaceId: true, role: true } },
      employments: { select: { id: true } },
      _count: { select: { managedStaff: true } },
    },
  });
  return {
    takenAt: new Date().toISOString(),
    users: Object.fromEntries(
      users.map((u) => [
        u.id,
        {
          email: u.email,
          firebaseUid: u.firebaseUid,
          memberships: u.memberships.map((m) => `${m.workspaceId}:${m.role}`).sort(),
          employments: u.employments.map((e) => e.id).sort(),
          managedStaff: u._count.managedStaff,
        },
      ]),
    ),
  };
}

/**
 * Every user from before is still there under the same id, with the same workspaces and roles,
 * employee records and Firebase uid. (Users added since, and email changes the person made, are fine.)
 */
export function compareSnapshots(before: MappingSnapshot, after: MappingSnapshot): { preserved: boolean; checked: number; differences: string[] } {
  const differences: string[] = [];
  for (const [id, b] of Object.entries(before.users)) {
    const a = after.users[id];
    if (!a) {
      differences.push(`user ${id} (${b.email}) is gone`);
      continue;
    }
    if (a.firebaseUid !== b.firebaseUid) differences.push(`user ${id}: firebase_uid changed`);
    if (a.memberships.join() !== b.memberships.join()) differences.push(`user ${id}: workspaces/roles changed (${b.memberships.join(" ")} -> ${a.memberships.join(" ")})`);
    if (a.employments.join() !== b.employments.join()) differences.push(`user ${id}: employee records changed`);
    if (a.managedStaff !== b.managedStaff) differences.push(`user ${id}: managed staff changed (${b.managedStaff} -> ${a.managedStaff})`);
  }
  return { preserved: differences.length === 0, checked: Object.keys(before.users).length, differences };
}

/** The plan as a page a person can read (the JSON beside it has every field). */
export function planMarkdown(plan: MigrationPlan): string {
  const lines = [
    `# Firebase → Cognito migration plan (${plan.generatedAt})`,
    "",
    "| Status | Users |",
    "| --- | --- |",
    ...Object.entries(plan.totals).map(([s, n]) => `| ${s} | ${n} |`),
    "",
    `Firebase accounts with no user of ours (nothing to move): ${plan.firebaseOnly.length}`,
    "",
    ...(plan.problems.length ? ["## Problems", "", ...plan.problems.map((p) => `- ${p}`), ""] : []),
    "## Users",
    "",
    "| users.id | email | status | Firebase providers | workspaces | notes |",
    "| --- | --- | --- | --- | --- | --- |",
    ...plan.users.map((r) => `| ${r.userId} | ${r.email} | ${r.status} | ${r.firebase?.providers.join(", ") ?? "?"} | ${r.workspaces} | ${r.notes.join(" ")} |`),
  ];
  return `${lines.join("\n")}\n`;
}
