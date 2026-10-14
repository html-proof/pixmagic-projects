import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, importPKCS8, importX509, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { env, type FetchLike } from "@app/core";

/** Narrow interface over Firebase Auth so tests can substitute a fake. */
export interface AuthProvider {
  verifyIdToken(idToken: string): Promise<{ uid: string; email?: string; emailVerified: boolean; authTime: number; name?: string }>;
  createSessionCookie(idToken: string, expiresInMs: number): Promise<string>;
  verifySessionCookie(cookie: string): Promise<{ uid: string; email?: string; emailVerified: boolean }>;
  /**
   * Find/create the Firebase user for a proven email (OTP, Shopify). An existing account that was
   * never verified loses its password and earlier sessions: whoever created it hadn't proven the email.
   */
  upsertVerifiedEmailUser(email: string): Promise<string>;
  createCustomToken(uid: string): Promise<string>;
  /**
   * Have Firebase email a one-click sign-in link (sent from Firebase's own address, so it works
   * without an email domain of ours). The link opens `continueUrl` with `?mode=signIn&oobCode=…`.
   */
  sendEmailSignInLink(email: string, continueUrl: string): Promise<void>;
  /**
   * Redeem a sign-in link's code for `email` (proves the inbox) and return the uid. Like
   * upsertVerifiedEmailUser, an account that was never verified loses its password and sessions.
   */
  redeemEmailSignInLink(email: string, oobCode: string): Promise<string>;
  /** The Firebase account registered for `email`, if any. */
  findUserByEmail(email: string): Promise<{ uid: string; emailVerified: boolean } | null>;
  /**
   * Create an email/password account (employee invitations). Firebase stores only a salted scrypt
   * hash of the password. Throws FirebaseAuthError("auth/email-already-exists") when the address
   * already has an account.
   */
  createPasswordUser(input: { email: string; password: string; displayName: string; emailVerified: boolean }): Promise<string>;
  /** End every session of the account, on every device (refresh tokens and session cookies). */
  revokeSessions(uid: string): Promise<void>;
}

/** What jose hands back from importX509 (a CryptoKey on Workers, a KeyObject in Node). */
type SigningKey = Awaited<ReturnType<typeof importX509>>;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** The credential presented is not acceptable: bad signature, expired, revoked, unknown account. */
export class FirebaseAuthError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Firebase/Google could not be reached, or answered with a failure of its own. Nothing is wrong
 * with the credential we were given, so this must never be reported as a rejected sign-in: during
 * an outage that logs everyone out and sends them round a sign-in loop that cannot succeed.
 */
export class FirebaseUnavailableError extends Error {
  readonly code = "auth/unavailable";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/**
 * `.catch(unreachable(...))` for a `fetch` that rejected outright (DNS, TLS, connection reset):
 * no response came back, so this is never a verdict on the credential.
 */
function unreachable(what: string) {
  return (err: unknown): never => {
    throw new FirebaseUnavailableError(`${what}: ${(err as Error).message}`, err);
  };
}

/**
 * jose reports "this token is bad" and "Google's signing keys are unreachable" through the same
 * throw. Only the former may reach the user as a rejected sign-in.
 */
function fromJoseError(err: unknown): Error {
  const code = (err as { code?: string }).code;
  // ERR_JOSE_GENERIC is what jose throws when the JWKS endpoint answers anything but 200.
  if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JOSE_GENERIC" || err instanceof TypeError) {
    return new FirebaseUnavailableError(`Could not fetch Google's token signing keys: ${(err as Error).message}`, err);
  }
  if (code === "ERR_JWT_EXPIRED") return new FirebaseAuthError("auth/id-token-expired", (err as Error).message);
  return err as Error;
}

// Google's signing keys. jose caches them (honouring Cache-Control) between requests.
const ID_TOKEN_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
const SESSION_CERTS_URL = "https://www.googleapis.com/identitytoolkit/v3/relyingparty/publicKeys";
const CUSTOM_TOKEN_AUD = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";
const SCOPES = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/identitytoolkit";

/**
 * Google's session-cookie signing certificates (PEM by key id), kept for as long as Google's
 * Cache-Control allows. Google rotates them, and a cookie minted after our copy was fetched can name
 * a key we don't have yet: rejecting it signed a valid session out (a 401, so "log in again") until
 * the copy expired, which can be hours. An unknown key id is therefore looked up again before it is
 * called unknown, at most once per `cooldownMs` so junk cookies can't make us hammer Google.
 */
export function sessionCertCache(
  load: () => Promise<{ certs: Record<string, string>; maxAgeSec: number }>,
  cooldownMs = 60_000,
  now: () => number = Date.now,
) {
  let cache: { certs: Record<string, string>; fetchedAt: number; expiresAt: number } | undefined;
  const refresh = async () => {
    const { certs, maxAgeSec } = await load();
    cache = { certs, fetchedAt: now(), expiresAt: now() + maxAgeSec * 1000 };
    return cache;
  };
  return {
    /** The certificate for `kid`, or null when Google doesn't publish one. */
    async pem(kid: string): Promise<string | null> {
      let c = !cache || cache.expiresAt < now() ? await refresh() : cache;
      if (!c.certs[kid] && now() - c.fetchedAt > cooldownMs) c = await refresh();
      return c.certs[kid] ?? null;
    },
  };
}

/** localhost, 127.0.0.1, [::1], or a *.localhost / *.test name. */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host) || host.endsWith(".localhost") || host.endsWith(".test");
}

/**
 * Firebase Auth over its REST API (the Admin SDK needs Node's http stack and
 * does not run on Workers). Behaviour matches the Admin SDK calls this replaced:
 * signature/issuer/audience checks, revocation checks, session cookies, custom
 * tokens. With FIREBASE_AUTH_EMULATOR_HOST set it talks to the emulator, which
 * issues unsigned tokens, exactly as the Admin SDK does.
 */
export function firebaseAuthProvider(fetchImpl: FetchLike = fetch): AuthProvider {
  const e = env();
  const projectId = e.FIREBASE_PROJECT_ID;
  const emulator = e.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulator && e.FIREBASE_SERVICE_ACCOUNT_B64) {
    throw new Error(
      `FIREBASE_AUTH_EMULATOR_HOST=${emulator} is set alongside a real service account (project ${projectId}). ` +
        "Remove one of them: the emulator would reject real Google-signed tokens.",
    );
  }
  // Emulator tokens are unsigned and accepted as such, so the emulator setting is an auth bypass
  // anywhere real users can reach. Only a local APP_URL may use it; a deployment that carried it
  // over (a copied .dev.vars, a stray var) fails closed instead of accepting forged tokens.
  if (emulator && !isLocalUrl(e.APP_URL)) {
    throw new Error(
      `FIREBASE_AUTH_EMULATOR_HOST=${emulator} is set but APP_URL (${e.APP_URL}) is not local. ` +
        "The emulator accepts unsigned tokens; it must never be configured on a deployed app.",
    );
  }
  const sa: ServiceAccount | null = e.FIREBASE_SERVICE_ACCOUNT_B64
    ? (JSON.parse(atob(e.FIREBASE_SERVICE_ACCOUNT_B64)) as ServiceAccount)
    : null;
  const api = emulator
    ? `http://${emulator}/identitytoolkit.googleapis.com/v1/projects/${projectId}`
    : `https://identitytoolkit.googleapis.com/v1/projects/${projectId}`;
  // End-user endpoints (not project-scoped) take the public web API key instead of OAuth.
  const publicApi = emulator ? `http://${emulator}/identitytoolkit.googleapis.com/v1` : "https://identitytoolkit.googleapis.com/v1";
  const webApiKey = e.FIREBASE_WEB_API_KEY || (emulator ? "emulator" : "");

  let accessToken: { value: string; expiresAt: number } | undefined;
  // The PEMs and the keys imported from them: importX509 parses a certificate, which is far
  // too much CPU to repeat on every request that carries a session cookie.
  const sessionCerts = sessionCertCache(async () => {
    const res = await fetchImpl(SESSION_CERTS_URL).catch(unreachable("Fetching session cookie keys failed"));
    if (!res.ok) throw new FirebaseUnavailableError(`Fetching session cookie keys failed (${res.status})`);
    const maxAgeSec = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
    return { certs: (await res.json()) as Record<string, string>, maxAgeSec };
  });
  /** Keys imported from those certificates, by certificate. */
  const importedKeys = new Map<string, SigningKey>();

  function requireSa(): ServiceAccount {
    if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 is required (or set FIREBASE_AUTH_EMULATOR_HOST for local dev)");
    return sa;
  }

  async function googleAccessToken(): Promise<string> {
    if (emulator) return "owner";
    if (accessToken && accessToken.expiresAt - Date.now() > 60_000) return accessToken.value;
    const s = requireSa();
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPES })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(s.client_email)
      .setSubject(s.client_email)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(await importPKCS8(s.private_key, "RS256"));
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    }).catch(unreachable("Google OAuth token request failed"));
    if (!res.ok) throw new FirebaseUnavailableError(`Google OAuth token request failed (${res.status})`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    accessToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return accessToken.value;
  }

  async function call<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetchImpl(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await googleAccessToken()}` },
      body: JSON.stringify(payload),
    }).catch(unreachable(`Identity Toolkit ${path} unreachable`));
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      const msg = json.error?.message ?? `HTTP ${res.status}`;
      // 4xx is about what we sent (a bad token, an unknown account); 5xx and 429 are Firebase failing.
      if (res.status >= 500 || res.status === 429) throw new FirebaseUnavailableError(`Identity Toolkit ${path} failed (${res.status}): ${msg}`);
      throw new FirebaseAuthError(msg === "USER_NOT_FOUND" || msg === "EMAIL_NOT_FOUND" ? "auth/user-not-found" : "auth/internal-error", msg);
    }
    return json;
  }

  type Account = { localId: string; email?: string; emailVerified?: boolean; disabled?: boolean; validSince?: string };
  async function lookup(by: { localId: string[] } | { email: string[] }): Promise<Account | null> {
    const r = await call<{ users?: Account[] }>("/accounts:lookup", by);
    return r.users?.[0] ?? null;
  }

  /**
   * Anyone can register an unverified password account for any address. Once the real owner
   * has proven it, nothing set up before that proof may keep access: drop the password and
   * revoke every earlier session (validSince), then mark it verified.
   */
  async function secureProvenAccount(localId: string) {
    await call("/accounts:update", {
      localId,
      emailVerified: true,
      deleteProvider: ["password"],
      validSince: String(Math.floor(Date.now() / 1000)),
    });
  }

  /** Same semantics as the Admin SDK's checkRevoked=true. */
  async function assertNotRevoked(claims: JWTPayload & { auth_time?: number }) {
    const u = await lookup({ localId: [claims.sub!] });
    if (!u) throw new FirebaseAuthError("auth/user-not-found", "User no longer exists");
    if (u.disabled) throw new FirebaseAuthError("auth/user-disabled", "User is disabled");
    if (u.validSince && (claims.auth_time ?? 0) < Number(u.validSince)) {
      throw new FirebaseAuthError("auth/id-token-revoked", "Token has been revoked");
    }
  }

  async function sessionKey(kid: string | undefined) {
    if (!kid) throw new FirebaseAuthError("auth/argument-error", "Session cookie names no signing key");
    const pem = await sessionCerts.pem(kid);
    if (!pem) throw new FirebaseAuthError("auth/argument-error", "Unknown session cookie signing key");
    const cached = importedKeys.get(pem);
    if (cached) return cached;
    const key = await importX509(pem, "RS256");
    importedKeys.set(pem, key);
    return key;
  }

  /** Decode + verify a Firebase JWT (ID token or session cookie). */
  async function verify(token: string, kind: "id" | "session") {
    const issuer = kind === "id" ? `https://securetoken.google.com/${projectId}` : `https://session.firebase.google.com/${projectId}`;
    let claims: JWTPayload & { auth_time?: number; email?: string; email_verified?: boolean; name?: string };
    if (emulator) {
      // Emulator tokens are unsigned; check the claims we can.
      claims = decodeJwt(token);
      if (claims.aud !== projectId || claims.iss !== issuer) throw new FirebaseAuthError("auth/argument-error", "Wrong project");
      if ((claims.exp ?? 0) * 1000 < Date.now()) throw new FirebaseAuthError("auth/id-token-expired", "Token expired");
    } else {
      const key = kind === "id" ? ID_TOKEN_JWKS : await sessionKey(decodeProtectedHeader(token).kid);
      ({ payload: claims } = await jwtVerify(token, key, { issuer, audience: projectId, algorithms: ["RS256"] }).catch((err: unknown) => {
        throw fromJoseError(err);
      }));
    }
    if (!claims.sub) throw new FirebaseAuthError("auth/argument-error", "Token has no subject");
    await assertNotRevoked(claims);
    return claims;
  }

  return {
    async verifyIdToken(idToken) {
      const t = await verify(idToken, "id");
      return { uid: t.sub!, email: t.email, emailVerified: !!t.email_verified, authTime: t.auth_time ?? 0, name: t.name };
    },
    async createSessionCookie(idToken, expiresInMs) {
      const r = await call<{ sessionCookie: string }>(":createSessionCookie", { idToken, validDuration: String(Math.floor(expiresInMs / 1000)) });
      return r.sessionCookie;
    },
    async verifySessionCookie(cookie) {
      const t = await verify(cookie, "session");
      return { uid: t.sub!, email: t.email, emailVerified: !!t.email_verified };
    },
    async upsertVerifiedEmailUser(email) {
      const u = await lookup({ email: [email] });
      if (u) {
        if (!u.emailVerified) await secureProvenAccount(u.localId);
        return u.localId;
      }
      const created = await call<{ localId: string }>("/accounts", { email, emailVerified: true });
      return created.localId;
    },
    async sendEmailSignInLink(email, continueUrl) {
      await call("/accounts:sendOobCode", { requestType: "EMAIL_SIGNIN", email, continueUrl, canHandleCodeInApp: true });
    },
    async redeemEmailSignInLink(email, oobCode) {
      if (!webApiKey) throw new Error("FIREBASE_WEB_API_KEY is required to redeem email sign-in links");
      const before = await lookup({ email: [email] });
      const res = await fetchImpl(`${publicApi}/accounts:signInWithEmailLink?key=${encodeURIComponent(webApiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, oobCode }),
      }).catch(unreachable("Redeeming the sign-in link failed"));
      const json = (await res.json().catch(() => ({}))) as { localId?: string; error?: { message?: string } };
      if (!res.ok || !json.localId) {
        const msg = json.error?.message ?? `HTTP ${res.status}`;
        // Don't tell the user their link is bad because Firebase had a bad minute.
        if (res.status >= 500 || res.status === 429) throw new FirebaseUnavailableError(`Redeeming the sign-in link failed (${res.status}): ${msg}`);
        throw new FirebaseAuthError("auth/invalid-action-code", msg);
      }
      if (before && !before.emailVerified) await secureProvenAccount(json.localId);
      return json.localId;
    },
    async findUserByEmail(email) {
      const u = await lookup({ email: [email] });
      return u ? { uid: u.localId, emailVerified: !!u.emailVerified } : null;
    },
    async createPasswordUser(input) {
      try {
        const created = await call<{ localId: string }>("/accounts", {
          email: input.email,
          password: input.password,
          displayName: input.displayName,
          emailVerified: input.emailVerified,
        });
        return created.localId;
      } catch (err) {
        if (err instanceof FirebaseAuthError && /EMAIL_EXISTS/.test(err.message)) throw new FirebaseAuthError("auth/email-already-exists", err.message);
        throw err;
      }
    },
    async revokeSessions(uid) {
      await call("/accounts:update", { localId: uid, validSince: String(Math.floor(Date.now() / 1000)) });
    },
    async createCustomToken(uid) {
      const now = Math.floor(Date.now() / 1000);
      if (emulator) {
        // The emulator accepts unsigned custom tokens (what the Admin SDK sends it).
        const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
        return `${enc({ alg: "none", typ: "JWT" })}.${enc({ iss: "firebase-auth-emulator@example.com", sub: "firebase-auth-emulator@example.com", aud: CUSTOM_TOKEN_AUD, iat: now, exp: now + 3600, uid })}.`;
      }
      const s = requireSa();
      return new SignJWT({ uid })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(s.client_email)
        .setSubject(s.client_email)
        .setAudience(CUSTOM_TOKEN_AUD)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(await importPKCS8(s.private_key, "RS256"));
    },
  };
}
