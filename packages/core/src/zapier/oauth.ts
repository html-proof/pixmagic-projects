/**
 * bizinsights as an OAuth 2.0 provider for its Zapier app (RFC 6749, authorization code with refresh
 * tokens, confidential client). The member allows it on /connect/zapier; Zapier exchanges the code at
 * POST /api/oauth/token and refreshes there when an access token runs out.
 *
 * - Codes: random, single use, five minutes, bound to the client, the redirect URI, the member, the
 *   workspace and the store. Kept in the coordinator under their SHA-256 only. A code used twice
 *   revokes what the first use issued (RFC 6749 §4.1.2).
 * - Tokens: random with a prefix that says what they are (zat_, zrt_), stored as SHA-256 hashes only.
 *   Access tokens last an hour; each refresh token is used once and replaced (rotation), and one
 *   presented again after a short grace revokes the whole grant (it was copied).
 * - Every use re-checks the member who allowed it: still a member, access not revoked or ended, still
 *   allowed to manage integrations, the store still connected. Otherwise the token stops working.
 */
import { systemDb, type Tx, type ZapierGrant } from "@app/db";
import { randomToken, sha256Hex } from "@app/shared";
import {
  isZapierScope,
  ZAPIER_ACCESS_PREFIX,
  ZAPIER_ACCESS_TTL_S,
  ZAPIER_CODE_PREFIX,
  ZAPIER_CODE_TTL_S,
  ZAPIER_REFRESH_PREFIX,
  ZAPIER_REFRESH_REUSE_GRACE_MS,
  ZAPIER_REFRESH_TTL_S,
} from "@app/shared/zapier";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { authorizerAccess, type AuthorizerAccess } from "./access.js";
import { zapierConfig } from "./config.js";

/** An OAuth error as RFC 6749 names it (§5.2), answered as `{ error, error_description }`. */
export class ZapierOAuthError extends Error {
  constructor(
    public error: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type" | "unauthorized_client",
    public description: string,
    public status = 400,
  ) {
    super(description);
    this.name = "ZapierOAuthError";
  }
}

// ---------------------------------------------------------------------------
// The authorization request (/connect/zapier)
// ---------------------------------------------------------------------------

export interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  state: string;
}

/**
 * What is wrong with an authorization request, or null. A wrong client or redirect URI must never be
 * redirected to (it could be anyone's): the page shows the problem instead.
 */
export function authorizeProblem(p: AuthorizeParams): "client" | "redirect" | "response_type" | "state" | null {
  const c = zapierConfig();
  if (p.client_id !== c.clientId) return "client";
  if (p.redirect_uri !== c.redirectUri) return "redirect";
  if (p.response_type !== "code") return "response_type";
  if (!p.state || p.state.length > 2000) return "state";
  return null;
}

/** Where Zapier is sent back to, with `params` added to the redirect URI's own query. */
export function zapierReturnUrl(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

interface CodeRecord {
  v: 1;
  clientId: string;
  redirectUri: string;
  userId: string;
  workspaceId: string;
  storeId: string;
  /** What the member ticked beyond triggers and searches (ZAPIER_SCOPES); absent in a code issued before scopes. */
  scopes?: string[];
  /** Epoch ms. The coordinator expires it too; this is checked as well. */
  exp: number;
}

const codeKey = (code: string) => `zapier:code:${sha256Hex(code)}`;
/** A spent code's hash → the grant it made, for a while: a second use revokes that grant. */
const spentKey = (code: string) => `zapier:code-spent:${sha256Hex(code)}`;

/** A new authorization code for a member who allowed Zapier. */
export async function issueAuthorizationCode(coord: Coord, rec: Omit<CodeRecord, "v" | "exp">, now = Date.now()): Promise<string> {
  const code = `${ZAPIER_CODE_PREFIX}${randomToken(32)}`;
  const value: CodeRecord = { v: 1, ...rec, exp: now + ZAPIER_CODE_TTL_S * 1000 };
  await coord.put(codeKey(code), JSON.stringify(value), ZAPIER_CODE_TTL_S);
  return code;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

type Db = Tx | typeof systemDb;

async function issueTokens(db: Db, grant: Pick<ZapierGrant, "id" | "workspaceId">, now: Date): Promise<TokenResponse> {
  const access = `${ZAPIER_ACCESS_PREFIX}${randomToken(32)}`;
  const refresh = `${ZAPIER_REFRESH_PREFIX}${randomToken(32)}`;
  await db.zapierToken.createMany({
    data: [
      { workspaceId: grant.workspaceId, grantId: grant.id, kind: "access", tokenHash: sha256Hex(access), expiresAt: new Date(now.getTime() + ZAPIER_ACCESS_TTL_S * 1000) },
      { workspaceId: grant.workspaceId, grantId: grant.id, kind: "refresh", tokenHash: sha256Hex(refresh), expiresAt: new Date(now.getTime() + ZAPIER_REFRESH_TTL_S * 1000) },
    ],
  });
  return { access_token: access, token_type: "Bearer", expires_in: ZAPIER_ACCESS_TTL_S, refresh_token: refresh };
}

const INVALID_CODE = "The authorization code is invalid, expired or already used. Connect bizinsights again.";
const NO_ACCESS = "The person who connected bizinsights can no longer manage this store's integrations. Connect bizinsights again.";

/**
 * grant_type=authorization_code: the code (once), for the client and redirect URI it was issued to,
 * while the member who allowed it still may. Makes the grant and its first tokens.
 */
export async function exchangeAuthorizationCode(coord: Coord, input: { code: string; redirectUri: string; clientId: string }, now = new Date()): Promise<TokenResponse> {
  const raw = await coord.take(codeKey(input.code));
  if (!raw) {
    // Spent already: whatever the first use issued goes too (the code was intercepted, or replayed).
    const spentGrant = await coord.peek(spentKey(input.code)).catch(() => null);
    if (spentGrant) {
      await revokeZapierGrants({ id: spentGrant }, "code_reused");
      logger.warn({ grantId: spentGrant }, "zapier authorization code used twice: its grant was revoked");
    }
    throw new ZapierOAuthError("invalid_grant", INVALID_CODE);
  }
  let rec: CodeRecord;
  try {
    rec = JSON.parse(raw) as CodeRecord;
  } catch {
    throw new ZapierOAuthError("invalid_grant", INVALID_CODE);
  }
  if (rec.v !== 1 || rec.exp <= now.getTime()) throw new ZapierOAuthError("invalid_grant", INVALID_CODE);
  if (rec.clientId !== input.clientId) throw new ZapierOAuthError("invalid_grant", INVALID_CODE);
  if (rec.redirectUri !== input.redirectUri) throw new ZapierOAuthError("invalid_grant", "redirect_uri doesn't match the one the code was issued for.");
  const who = await authorizerAccess(rec, now);
  if (!who) throw new ZapierOAuthError("invalid_grant", NO_ACCESS);
  const { grant, tokens } = await systemDb.$transaction(async (tx) => {
    const grant = await tx.zapierGrant.create({ data: { workspaceId: rec.workspaceId, storeId: rec.storeId, userId: rec.userId, clientId: rec.clientId, scopes: (rec.scopes ?? []).filter(isZapierScope) } });
    return { grant, tokens: await issueTokens(tx, grant, now) };
  });
  await coord.put(spentKey(input.code), grant.id, ZAPIER_CODE_TTL_S * 2).catch((err: unknown) => logger.warn({ err }, "could not note a spent zapier code"));
  await audit({ workspaceId: grant.workspaceId, actorUserId: grant.userId, action: "zapier.connected", targetType: "zapier_grant", targetId: grant.id, metadata: { storeId: grant.storeId, scopes: grant.scopes } });
  logger.info({ grantId: grant.id, workspaceId: grant.workspaceId, storeId: grant.storeId }, "zapier connected");
  return tokens;
}

/**
 * grant_type=refresh_token: a new access token and a new refresh token for an unused refresh token
 * (the old one is spent). One spent within the last minute (Zapier's tasks refreshing at once, a
 * retried request) gets a pair too; one spent before that was copied: the whole grant is revoked.
 */
export async function exchangeRefreshToken(input: { refreshToken: string; clientId: string }, now = new Date()): Promise<TokenResponse> {
  const invalid = new ZapierOAuthError("invalid_grant", "The refresh token is invalid, expired or revoked. Connect bizinsights again.");
  if (!input.refreshToken.startsWith(ZAPIER_REFRESH_PREFIX)) throw invalid;
  const token = await systemDb.zapierToken.findUnique({ where: { tokenHash: sha256Hex(input.refreshToken) }, include: { grant: true } });
  if (!token || token.kind !== "refresh" || token.grant.revokedAt || token.grant.clientId !== input.clientId) throw invalid;
  if (token.expiresAt <= now) throw invalid;
  if (token.usedAt && now.getTime() - token.usedAt.getTime() > ZAPIER_REFRESH_REUSE_GRACE_MS) {
    await revokeZapierGrants({ id: token.grantId }, "refresh_token_reused");
    logger.warn({ grantId: token.grantId }, "zapier refresh token reused: the grant was revoked");
    throw invalid;
  }
  if (!(await authorizerAccess(token.grant, now))) throw new ZapierOAuthError("invalid_grant", NO_ACCESS);
  return systemDb.$transaction(async (tx) => {
    if (!token.usedAt) {
      // Only one exchange spends it; a concurrent one finds it spent within the grace and is answered too.
      await tx.zapierToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
    }
    return issueTokens(tx, token.grant, now);
  });
}

/**
 * `unknown_token`: no such token at all (made up, or pruned a day after it expired). `invalid_token`:
 * one bizinsights issued that has expired (every hour, before Zapier refreshes it) or was revoked.
 */
export type TokenCheck = { ok: true; grant: ZapierGrant; who: AuthorizerAccess } | { ok: false; reason: "unknown_token" | "invalid_token" | "no_access" };

/**
 * A request's bearer token: an unexpired access token of a grant that stands, whose member still may.
 * Notes the grant's last use (at most once a minute).
 */
export async function authenticateZapierToken(bearer: string, now = new Date()): Promise<TokenCheck> {
  if (!bearer.startsWith(ZAPIER_ACCESS_PREFIX) || bearer.length > 200) return { ok: false, reason: "unknown_token" };
  const token = await systemDb.zapierToken.findUnique({ where: { tokenHash: sha256Hex(bearer) }, include: { grant: true } });
  if (!token) return { ok: false, reason: "unknown_token" };
  if (token.kind !== "access" || token.expiresAt <= now || token.grant.revokedAt) return { ok: false, reason: "invalid_token" };
  const who = await authorizerAccess(token.grant, now);
  if (!who) return { ok: false, reason: "no_access" };
  if (!token.grant.lastUsedAt || now.getTime() - token.grant.lastUsedAt.getTime() > 60_000) {
    await systemDb.zapierGrant.updateMany({ where: { id: token.grantId }, data: { lastUsedAt: now } }).catch(() => {});
  }
  return { ok: true, grant: token.grant, who };
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export type ZapierRevokeReason = "disconnected" | "member_removed" | "account_deleted" | "workspace_deleted" | "account_taken_over" | "refresh_token_reused" | "code_reused";

/**
 * Revoke the grants `where` names: their tokens stop working, their triggers are deleted, and what was
 * waiting to be sent to them is cancelled (the deliveries stay as the record). Returns how many.
 * `db`: a transaction to take part in (an account take-over's), or the system connection.
 */
export async function revokeZapierGrants(
  where: { id?: string; workspaceId?: string; storeId?: string; userId?: string },
  reason: ZapierRevokeReason,
  db: Db = systemDb,
  now = new Date(),
): Promise<number> {
  const grants = await db.zapierGrant.findMany({ where: { ...where, revokedAt: null }, select: { id: true, workspaceId: true, userId: true } });
  if (!grants.length) return 0;
  const ids = grants.map((g) => g.id);
  await db.zapierDelivery.updateMany({ where: { hook: { grantId: { in: ids } }, status: { in: ["pending", "retrying"] } }, data: { status: "cancelled", errorCode: "grant_revoked" } });
  await db.zapierHook.deleteMany({ where: { grantId: { in: ids } } });
  await db.zapierToken.deleteMany({ where: { grantId: { in: ids } } });
  await db.zapierGrant.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
  if (db === systemDb) {
    for (const g of grants) await audit({ workspaceId: g.workspaceId, action: "zapier.revoked", targetType: "zapier_grant", targetId: g.id, metadata: { reason, userId: g.userId } });
  }
  logger.info({ grants: ids, reason }, "zapier grants revoked");
  return grants.length;
}
