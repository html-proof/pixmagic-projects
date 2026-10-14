/**
 * "Connect Gmail / Google Workspace" and "Connect Outlook / Microsoft 365": the OAuth 2.0
 * authorization-code flow with PKCE, for sending only.
 *
 * Scopes are the minimum that sends mail and says which mailbox it is: Google `gmail.send` plus
 * `openid email`; Microsoft delegated `Mail.Send` and `User.Read` plus `openid email profile
 * offline_access`. Nothing reads, lists or deletes mail. Microsoft's application permissions
 * (Mail.Send for every mailbox in a directory) are never requested: everything here acts as the
 * person who signed in (/me), and nothing else exists in the code.
 *
 * Errors come back as OAuthError: `permanent` means the stored authorization is dead (revoked,
 * expired, consent withdrawn, a blocking sign-in policy) and someone must reconnect; `transient`
 * means try again later and leave the account alone.
 */
import type { EmailProvider, OAuthProvider } from "@app/shared/email";
import { env } from "../env.js";
import type { FetchLike } from "../shopify.js";

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}
export interface MicrosoftConfig extends OAuthClientConfig {
  authority: string;
}

export function googleEmailConfig(fetchImpl?: FetchLike): OAuthClientConfig | null {
  const e = env();
  if (!e.EMAIL_GOOGLE_CLIENT_ID || !e.EMAIL_GOOGLE_CLIENT_SECRET) return null;
  return { clientId: e.EMAIL_GOOGLE_CLIENT_ID, clientSecret: e.EMAIL_GOOGLE_CLIENT_SECRET, fetchImpl };
}

export function microsoftEmailConfig(fetchImpl?: FetchLike): MicrosoftConfig | null {
  const e = env();
  if (!e.EMAIL_MICROSOFT_CLIENT_ID || !e.EMAIL_MICROSOFT_CLIENT_SECRET) return null;
  return { clientId: e.EMAIL_MICROSOFT_CLIENT_ID, clientSecret: e.EMAIL_MICROSOFT_CLIENT_SECRET, authority: e.EMAIL_MICROSOFT_AUTHORITY, fetchImpl };
}

export const emailOAuthConfigured = (): Record<OAuthProvider, boolean> => ({ google: googleEmailConfig() !== null, microsoft: microsoftEmailConfig() !== null });

/** Must be registered exactly like this with Google and Microsoft. Never taken from the request. */
export const emailRedirectUri = (provider: OAuthProvider) => `${env().APP_URL}/api/email/oauth/${provider}/callback`;

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_EMAIL_SCOPES = ["openid", "email", GMAIL_SEND_SCOPE];
export const GRAPH_MAIL_SEND_SCOPE = "https://graph.microsoft.com/Mail.Send";
export const MICROSOFT_EMAIL_SCOPES = ["openid", "email", "profile", "offline_access", GRAPH_MAIL_SEND_SCOPE, "https://graph.microsoft.com/User.Read"];
/** The directory personal Microsoft accounts (Outlook.com, Hotmail, Live) sign in through. */
export const MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

export class OAuthError extends Error {
  constructor(
    message: string,
    public kind: "permanent" | "transient",
    /** For the UI and the account's status_reason (ERROR_LABEL). */
    public code: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface OAuthTokens {
  accessToken: string;
  /** Null when the provider sent none (Google, on a repeat consent): keep the stored one. */
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  idToken: string | null;
}

export interface OAuthIdentity {
  provider: EmailProvider;
  /** Google `sub` / Microsoft `oid`: stable for the mailbox. */
  providerAccountId: string;
  /** Google Workspace `hd` / Microsoft `tid`. */
  providerTenantId: string | null;
  email: string;
  displayName: string | null;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const expiry = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(Date.now() + s * 1000) : null);

async function tokenRequest(fetchImpl: FetchLike, url: string, form: Record<string, string>) {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form).toString() });
  } catch (err) {
    throw new OAuthError(`The sign-in service couldn't be reached: ${(err as Error).message}`, "transient", "provider_unavailable");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, body };
}

/**
 * The payload of an ID token received straight from the provider's token endpoint over TLS, with
 * client authentication: OpenID Connect Core 3.1.3.7 lets TLS stand in for the signature check
 * there. Audience, issuer and expiry are still checked.
 */
export function idTokenClaims(idToken: string, expect: { audience: string; issuer: (iss: string) => boolean }): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("The sign-in service sent an unreadable identity", "permanent", "auth_failed");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OAuthError("The sign-in service sent an unreadable identity", "permanent", "auth_failed");
  }
  const aud = claims.aud;
  if (!(aud === expect.audience || (Array.isArray(aud) && aud.includes(expect.audience)))) throw new OAuthError("The identity was issued to another app", "permanent", "auth_failed");
  if (typeof claims.iss !== "string" || !expect.issuer(claims.iss)) throw new OAuthError("The identity came from an unexpected issuer", "permanent", "auth_failed");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 300_000) throw new OAuthError("The identity has expired", "permanent", "auth_failed");
  return claims;
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

export function googleEmailAuthorizeUrl(c: OAuthClientConfig, input: { state: string; codeChallenge: string; loginHint?: string | null }): string {
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: emailRedirectUri("google"),
    response_type: "code",
    scope: GOOGLE_EMAIL_SCOPES.join(" "),
    // A refresh token for sending while nobody is signed in; `consent` makes Google issue one again
    // on a reconnect, which it otherwise only does the first time.
    access_type: "offline",
    prompt: "consent",
    // Only what is asked for here, never the scopes this person granted Insights' other features.
    include_granted_scopes: "false",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

function googleError(status: number, body: Record<string, unknown>): OAuthError {
  const error = String(body.error ?? "");
  const desc = String(body.error_description ?? error ?? `Google returned ${status}`);
  // Our own client id or secret is wrong: every account would fail the same way, so no account is
  // marked for reconnecting over it.
  if (error === "invalid_client" || error === "unauthorized_client") return new OAuthError(`Google rejected Insights' OAuth client: ${desc}`, "transient", "provider_unavailable");
  if (error === "invalid_grant") return new OAuthError(`Google no longer accepts this authorization: ${desc}`, "permanent", "auth_failed");
  if (status === 429 || status >= 500) return new OAuthError(`Google is unavailable: ${desc}`, "transient", "provider_unavailable");
  return new OAuthError(`Google refused: ${desc}`, "permanent", "auth_failed");
}

function googleTokens(body: Record<string, unknown>): OAuthTokens {
  if (typeof body.access_token !== "string") throw new OAuthError("Google sent no access token", "transient", "provider_unavailable");
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    expiresAt: expiry(body.expires_in),
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [],
    idToken: typeof body.id_token === "string" ? body.id_token : null,
  };
}

export async function googleEmailExchangeCode(c: OAuthClientConfig, code: string, codeVerifier: string): Promise<OAuthTokens> {
  const { res, body } = await tokenRequest(c.fetchImpl ?? fetch, "https://oauth2.googleapis.com/token", {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: emailRedirectUri("google"),
  });
  if (!res.ok) throw googleError(res.status, body);
  return googleTokens(body);
}

/** A fresh access token. Google rarely rotates the refresh token; when it does, the new one is returned. */
export async function googleEmailRefresh(c: OAuthClientConfig, refreshToken: string): Promise<OAuthTokens> {
  const { res, body } = await tokenRequest(c.fetchImpl ?? fetch, "https://oauth2.googleapis.com/token", {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (!res.ok) throw googleError(res.status, body);
  return googleTokens(body);
}

/** End the grant at Google. A token Google already considers dead counts as revoked. */
export async function googleEmailRevoke(c: OAuthClientConfig, token: string): Promise<void> {
  const { res, body } = await tokenRequest(c.fetchImpl ?? fetch, "https://oauth2.googleapis.com/revoke", { token });
  if (res.ok || body.error === "invalid_token") return;
  throw googleError(res.status, body);
}

/** Which mailbox signed in, from the ID token: a verified Google address, and its Workspace domain if any. */
export function googleIdentity(c: OAuthClientConfig, tokens: OAuthTokens): OAuthIdentity {
  if (!tokens.idToken) throw new OAuthError("Google didn't say which account signed in", "permanent", "auth_failed");
  const claims = idTokenClaims(tokens.idToken, { audience: c.clientId, issuer: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com" });
  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  if (!sub || !email) throw new OAuthError("Google didn't say which account signed in", "permanent", "auth_failed");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new OAuthError("That Google account's address isn't verified", "permanent", "auth_failed");
  const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : null;
  return { provider: hd ? "google_workspace" : "gmail", providerAccountId: sub, providerTenantId: hd, email, displayName: typeof claims.name === "string" ? claims.name.slice(0, 100) : null };
}

// ---------------------------------------------------------------------------
// Microsoft identity platform
// ---------------------------------------------------------------------------

const msBase = (c: MicrosoftConfig) => `https://login.microsoftonline.com/${encodeURIComponent(c.authority)}/oauth2/v2.0`;

export function microsoftEmailAuthorizeUrl(c: MicrosoftConfig, input: { state: string; codeChallenge: string; loginHint?: string | null }): string {
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: emailRedirectUri("microsoft"),
    response_type: "code",
    response_mode: "query",
    scope: MICROSOFT_EMAIL_SCOPES.join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  });
  return `${msBase(c)}/authorize?${q}`;
}

/**
 * What a Microsoft error means. AADSTS codes: 65001/65004/90094 consent; 50076/50079/50158/53003
 * MFA or Conditional Access; 50057/50053 disabled or locked; 700082/70008/50173/54005/70043
 * expired or revoked grants.
 */
export function microsoftErrorCode(error: string, description: string, codes: number[] = []): { kind: "permanent" | "transient"; code: string } {
  const has = (...n: number[]) => n.some((x) => codes.includes(x) || description.includes(`AADSTS${x}`));
  if (error === "temporarily_unavailable" || error === "server_error") return { kind: "transient", code: "provider_unavailable" };
  if (error === "invalid_client" || error === "unauthorized_client" || has(7000215, 7000222, 700016)) return { kind: "transient", code: "provider_unavailable" };
  if (error === "consent_required" || has(65001, 65004, 90094, 90095)) return { kind: "permanent", code: "consent_required" };
  if (error === "interaction_required" || has(50076, 50079, 50158, 53003, 53000, 530003)) return { kind: "permanent", code: "conditional_access" };
  if (has(50057, 50053, 50034)) return { kind: "permanent", code: "account_disabled_by_provider" };
  if (error === "invalid_grant" || has(700082, 70008, 50173, 54005, 70043, 50126)) return { kind: "permanent", code: "auth_failed" };
  if (error === "access_denied") return { kind: "permanent", code: "permission_missing" };
  return { kind: "permanent", code: "auth_failed" };
}

function microsoftError(status: number, body: Record<string, unknown>): OAuthError {
  const error = String(body.error ?? "");
  const desc = String(body.error_description ?? error ?? `Microsoft returned ${status}`).split("\r\n")[0]!;
  if (status === 429 || status >= 500) return new OAuthError(`Microsoft is unavailable: ${desc}`, "transient", "provider_unavailable");
  const { kind, code } = microsoftErrorCode(error, desc, Array.isArray(body.error_codes) ? (body.error_codes as number[]) : []);
  return new OAuthError(`Microsoft refused: ${desc}`, kind, code);
}

function microsoftTokens(body: Record<string, unknown>): OAuthTokens {
  if (typeof body.access_token !== "string") throw new OAuthError("Microsoft sent no access token", "transient", "provider_unavailable");
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    expiresAt: expiry(body.expires_in),
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [],
    idToken: typeof body.id_token === "string" ? body.id_token : null,
  };
}

export async function microsoftEmailExchangeCode(c: MicrosoftConfig, code: string, codeVerifier: string): Promise<OAuthTokens> {
  const { res, body } = await tokenRequest(c.fetchImpl ?? fetch, `${msBase(c)}/token`, {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: emailRedirectUri("microsoft"),
    scope: MICROSOFT_EMAIL_SCOPES.join(" "),
  });
  if (!res.ok) throw microsoftError(res.status, body);
  return microsoftTokens(body);
}

/** Microsoft rotates the refresh token on every refresh: the caller must store the new one. */
export async function microsoftEmailRefresh(c: MicrosoftConfig, refreshToken: string): Promise<OAuthTokens> {
  const { res, body } = await tokenRequest(c.fetchImpl ?? fetch, `${msBase(c)}/token`, {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: MICROSOFT_EMAIL_SCOPES.join(" "),
  });
  if (!res.ok) throw microsoftError(res.status, body);
  return microsoftTokens(body);
}

/**
 * Which mailbox signed in: the directory and object ids from the ID token, and the mailbox address
 * from Graph's /me (`mail`, or the sign-in name for accounts without a separate mail attribute).
 */
export async function microsoftIdentity(c: MicrosoftConfig, tokens: OAuthTokens): Promise<OAuthIdentity> {
  if (!tokens.idToken) throw new OAuthError("Microsoft didn't say which account signed in", "permanent", "auth_failed");
  const claims = idTokenClaims(tokens.idToken, { audience: c.clientId, issuer: (iss) => /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(iss) });
  const oid = typeof claims.oid === "string" ? claims.oid : null;
  const tid = typeof claims.tid === "string" ? claims.tid : null;
  if (!oid || !tid || claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new OAuthError("Microsoft didn't say which account signed in", "permanent", "auth_failed");
  let res: Response;
  try {
    res = await (c.fetchImpl ?? fetch)("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName", { headers: { authorization: `Bearer ${tokens.accessToken}` } });
  } catch (err) {
    throw new OAuthError(`Microsoft Graph couldn't be reached: ${(err as Error).message}`, "transient", "provider_unavailable");
  }
  const me = (await res.json().catch(() => ({}))) as { id?: string; mail?: string | null; userPrincipalName?: string; displayName?: string; error?: { code?: string; message?: string } };
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) throw new OAuthError("Microsoft Graph is unavailable", "transient", "provider_unavailable");
    throw new OAuthError(`Microsoft Graph refused: ${me.error?.message ?? res.status}`, "permanent", me.error?.code === "MailboxNotEnabledForRESTAPI" ? "account_failed" : "auth_failed");
  }
  const email = (me.mail || me.userPrincipalName || "").toLowerCase();
  if (!email || !email.includes("@") || email.includes("#ext#")) throw new OAuthError("This Microsoft account has no mailbox address Insights can send from", "permanent", "account_failed");
  return { provider: tid === MSA_TENANT_ID ? "outlook" : "microsoft_365", providerAccountId: oid, providerTenantId: tid, email, displayName: me.displayName?.slice(0, 100) ?? null };
}
