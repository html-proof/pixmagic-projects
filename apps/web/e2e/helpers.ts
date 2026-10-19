import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import type pg from "pg";
import { E2E_BASE_URL, E2E_COGNITO_DATA, E2E_COGNITO_PORT, E2E_MAILPIT_URL } from "../playwright.config";

export const uniqueEmail = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

/** The password `signUp` gives every account it creates. */
export const PASSWORD = "correct-horse-battery";

/**
 * The newest code the Cognito emulator "emailed" to an address (sign-up, password reset, email
 * verification): it keeps them in its database, and writes that a moment after answering.
 */
export async function latestCode(email: string, kind: "confirm" | "verify" = "confirm"): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const pool = JSON.parse(readFileSync(join(E2E_COGNITO_DATA, ".cognito/db/local_insights.json"), "utf8")) as {
        Users: Record<string, { Attributes: Array<{ Name: string; Value: string }>; ConfirmationCode?: string; AttributeVerificationCode?: string }>;
      };
      const u = Object.values(pool.Users).find((x) => x.Attributes.some((a) => a.Name === "email" && a.Value === email.toLowerCase()));
      const code = kind === "verify" ? u?.AttributeVerificationCode : u?.ConfirmationCode;
      if (code) return code;
    } catch {
      /* mid-write: try again */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${kind} code for ${email}`);
}

/**
 * Cognito marks a sign-up's address verified when its emailed code is confirmed; the emulator
 * doesn't. Mark it verified in the emulator first, so confirming leaves the account as Cognito would.
 */
export async function verifiedOnConfirm(email: string) {
  const res = await fetch(`http://127.0.0.1:${E2E_COGNITO_PORT}/`, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.AdminUpdateUserAttributes" },
    body: JSON.stringify({ UserPoolId: "local_insights", Username: email, UserAttributes: [{ Name: "email", Value: email.toLowerCase() }, { Name: "email_verified", Value: "true" }] }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

/**
 * Two-step verification (an authenticator app) in the emulator's pool: optional, as in
 * production, so accounts without it sign in as before. The seed has it off.
 */
export async function poolMfa(on: boolean) {
  const res = await fetch(`http://127.0.0.1:${E2E_COGNITO_PORT}/`, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.SetUserPoolMfaConfig" },
    body: JSON.stringify({ UserPoolId: "local_insights", MfaConfiguration: on ? "OPTIONAL" : "OFF", SoftwareTokenMfaConfiguration: { Enabled: on } }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

/** What an authenticator app shows now for a base32 key (RFC 6238: HMAC-SHA1, 6 digits, 30 seconds). */
export function totpCode(key: string, at = Date.now()): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of key.replace(/[\s=]+/g, "").toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const secret = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", secret).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** The subjects of the emails the app sent to `email`, newest first (Mailpit, or its stand-in). */
export async function mailSubjects(email: string): Promise<string[]> {
  const res = await fetch(`${E2E_MAILPIT_URL}/api/v1/search?${new URLSearchParams({ query: `to:${email}` })}`);
  const body = (await res.json()) as { messages?: Array<{ Subject: string }> };
  return (body.messages ?? []).map((m) => m.Subject);
}

/** A signed-in account whose email isn't verified sits on /verify-email: send the code and enter it. */
export async function verifyEmail(page: Page, email: string) {
  await expect(page).toHaveURL(/verify-email/);
  await page.getByRole("button", { name: "Email me a verification code" }).click();
  await page.getByLabel("Verification code").fill(await latestCode(email, "verify"));
  await page.getByRole("button", { name: "Verify email" }).click();
}

/**
 * Every test runs from 127.0.0.1, and sign-up and sign-in are rate limited per IP (rateLimit.ts),
 * so a whole suite of new accounts would trip the limit. Each visitor gets its own address in the
 * header the API reads it from (the local server passes it on; on AWS the front overwrites it).
 */
export async function asNewVisitor(page: Page) {
  const n = () => Math.floor(Math.random() * 250) + 1;
  await page.setExtraHTTPHeaders({ "x-insights-client-ip": `10.${n()}.${n()}.${n()}` });
}

/** Fill in the create-account form (without sending it). */
export async function fillSignUp(page: Page, email: string, password = PASSWORD, name = "E2E User") {
  await asNewVisitor(page);
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email Address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByLabel(/I agree to the Terms/).check();
}

/** Send the create-account form already filled in, and confirm the code Cognito "emailed". */
export async function confirmSignUp(page: Page, email: string) {
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await verifiedOnConfirm(email);
  await page.getByLabel("Verification code").fill(await latestCode(email));
  await page.getByRole("button", { name: "Verify and continue" }).click();
}

/**
 * Create an account with email and password and confirm the code Cognito sent, which signs it in:
 * a new account lands on onboarding (connect a store), verified.
 */
export async function signUp(page: Page, email: string) {
  await asNewVisitor(page);
  await page.goto("/signup");
  await fillSignUp(page, email);
  await confirmSignUp(page, email);
  await expect(page).toHaveURL(/onboarding/);
}

/** Sign in on /login with email and password. */
export async function logIn(page: Page, email: string, password = PASSWORD) {
  await asNewVisitor(page);
  await page.getByLabel("Email Address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
}

/** Our App URL as Shopify opens it (after a managed install, or from the admin): signed query string. */
/** Sign out from the account menu in the top bar (the avatar). */
export async function signOutFromMenu(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
}

export function signedLaunchUrl(shop: string) {
  const params: Record<string, string> = { shop, timestamp: String(Math.floor(Date.now() / 1000)) };
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hmac = createHmac("sha256", "e2e_secret").update(message).digest("hex");
  return `/api/shopify/launch?${new URLSearchParams({ ...params, hmac })}`;
}

/** Shopify can't run in CI: answer its pages with a stub so redirects there are observable but inert. */
export async function stubShopify(page: Page) {
  await page.route(/^https:\/\/([a-z0-9-]+\.myshopify\.com|admin\.shopify\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Shopify (stub)</title><h1>Shopify (stub)</h1>" }),
  );
}

export function signedWebhook(topic: string, shop: string, payload: unknown, id: string) {
  const body = JSON.stringify(payload);
  return fetch(`${E2E_BASE_URL}/api/webhooks/shopify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": id,
      "x-shopify-hmac-sha256": createHmac("sha256", "e2e_secret").update(body).digest("base64"),
    },
    body,
  });
}

/** A workspace for the signed-in account (POST /api/workspaces from the page); its id. */
export async function createWorkspace(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n) => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
    if (!r.ok) throw new Error(`POST /workspaces failed: ${r.status}`);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  }, name);
}

/** A connected Shopify store, written straight into the database (Shopify's side can't run in e2e); its id. */
export async function insertStore(db: pg.Pool, ws: string, shop: string, scopes: string[] = ["read_orders", "read_products"], timezone = "UTC"): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, pixel_ingest_key, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'active', $4, 'USD', $3, gen_random_uuid()::text, now(), now()) RETURNING id`,
    [ws, shop, scopes, timezone],
  );
  return rows[0].id as string;
}

export interface SeededAdConnection {
  workspaceId: string;
  storeId: string;
  provider: "google" | "meta" | "adsense";
  accountId: string;
  accountName?: string | null;
  currency?: string | null;
  timezone?: string | null;
  enabled?: boolean;
  status?: "active" | "reconnect" | "permission" | "unavailable" | "error";
  errorCode?: string | null;
  lastError?: string | null;
  lastSyncedAt?: Date | null;
  syncedThrough?: string | null;
  historyFrom?: string | null;
  syncRequestedAt?: Date | null;
  accountStatus?: string | null;
  grantedScopes?: string[];
  loginCustomerId?: string | null;
  sites?: string[];
  /** When it was connected (created_at); three days ago when left out. */
  connectedAt?: Date;
}

/** A moment as the UTC wall-clock time the timestamp columns hold (node-pg would write the machine's local time). */
const utc = (d: Date | null | undefined) => (d ? d.toISOString().replace("Z", "") : null);

/**
 * A connected ad account, written straight into ad_connections (Google and Meta can't run in e2e),
 * in whatever state a test needs; its id. Its token is a placeholder nothing can read with, so a
 * sync it starts fails and a disconnect can't hand the access back to the platform.
 */
export async function insertAdConnection(db: pg.Pool, c: SeededAdConnection): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO ad_connections (id, workspace_id, store_id, provider, account_id, account_name, currency, timezone, enabled, status, error_code, last_error,
       last_synced_at, synced_through, history_from, sync_requested_at, account_status, granted_scopes, login_customer_id, sites,
       access_token_enc, token_key_version, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'e2e-placeholder', 1,
       COALESCE($20::timestamp, (now() at time zone 'utc') - interval '3 days'), now() at time zone 'utc')
     RETURNING id`,
    [
      c.workspaceId,
      c.storeId,
      c.provider,
      c.accountId,
      c.accountName ?? null,
      c.currency ?? "USD",
      c.timezone ?? "UTC",
      c.enabled ?? true,
      c.status ?? "active",
      c.errorCode ?? null,
      c.lastError ?? null,
      utc(c.lastSyncedAt),
      c.syncedThrough ?? null,
      c.historyFrom ?? null,
      utc(c.syncRequestedAt),
      c.accountStatus ?? null,
      c.grantedScopes ?? [],
      c.loginCustomerId ?? null,
      c.sites ?? [],
      utc(c.connectedAt),
    ],
  );
  return rows[0].id as string;
}
