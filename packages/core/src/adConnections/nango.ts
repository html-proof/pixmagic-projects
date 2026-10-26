/**
 * Connecting ad accounts through Nango (docs/nango.md), the only way any platform is connected: which
 * platforms Nango can connect now, the connect session a merchant authorizes in, checking what Nango
 * made of it, and Nango's webhooks about connections. The Nango API itself is ads/nango.ts; the routes
 * are apps/api/src/routes/adsNango.ts; moving the connections made before Nango is migrate.ts.
 *
 * Nango only brokers the OAuth and keeps the tokens: the grant is to bizinsights' own Meta app or Google
 * client, every token is checked to be one (Meta's appsecret_proof, Google's tokeninfo audience), and the
 * accounts are listed and read with bizinsights' own clients. Grants are taken back the same way as
 * they always were (connect.ts).
 */
import { systemDb } from "@app/db";
import type { AdProvider } from "@app/shared";
import {
  adsenseAccounts,
  AdsApiError,
  AdsAuthError,
  AdsNoAccountsError,
  googleAdAccounts,
  metaAdAccounts,
  metaGrantedPermissions,
  NANGO_INTEGRATION,
  nangoConnections,
  nangoCreateConnectSession,
  nangoIntegrations,
  nangoIntegrationsReady,
  nangoProviderOf,
  REQUIRED_AD_SCOPE,
  type AdAccountList,
  type NangoAuthEvent,
  type NangoConfig,
} from "../ads.js";
import type { Coord } from "../coord.js";
import { pendingSource, type PendingAdConnect } from "./connect.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { adsenseConfig, googleClient, metaConfig, nangoConfig, nangoProviders } from "./config.js";
import { forgetNangoToken, nangoTokenFor, platformPerson } from "./credentials.js";
import { releaseNangoConnectionIfUnused } from "./connect.js";
import { recordAdFailure } from "./status.js";

/** How long a connect session (and its state here) lasts: Nango's own session lifetime. */
export const NANGO_SESSION_TTL_S = 30 * 60;

const NONE: Record<AdProvider, boolean> = { meta: false, google: false, adsense: false };
const READY_KEY = "nango-integrations-ready";
/** How long what Nango said about its integrations is kept: a fix in Nango's dashboard shows within this. */
export const NANGO_READY_TTL_S = 5 * 60;

/**
 * The platforms that can be connected right now: this server connects them through Nango
 * (nangoProviders: listed, key set, the platform's own app set up) and Nango holds each one's integration,
 * made from the right provider and lacking no credential (asked of Nango, kept NANGO_READY_TTL_S). So a
 * card offers Connect only for a platform whose sign-in can actually work, never one whose integration
 * nobody made yet. Nango not answering offers the listed platforms (starting a sign-in then says Nango is
 * busy); Nango refusing bizinsights' key offers none, for a minute.
 */
export async function connectableAdProviders(coord: Coord, fetchImpl?: FetchLike): Promise<Record<AdProvider, boolean>> {
  const listed = nangoProviders();
  const cfg = nangoConfig(fetchImpl);
  if (!cfg || !Object.values(listed).some(Boolean)) return { ...NONE };
  let ready: Record<AdProvider, boolean> | null = null;
  const cached = await coord.peek(READY_KEY).catch(() => null);
  if (cached) ready = JSON.parse(cached) as Record<AdProvider, boolean>;
  else {
    try {
      ready = nangoIntegrationsReady(await nangoIntegrations(cfg));
      for (const p of Object.keys(listed) as AdProvider[]) {
        if (listed[p] && !ready[p]) logger.warn({ provider: p, integrationKey: NANGO_INTEGRATION[p] }, "nango has no usable integration for this platform: run infra/cdk/scripts/nango-setup.mjs --apply");
      }
      await coord.put(READY_KEY, JSON.stringify(ready), NANGO_READY_TTL_S).catch(() => undefined);
    } catch (err) {
      if (err instanceof AdsApiError && err.errorCode === "not_configured") {
        logger.error({ err }, "nango refused bizinsights' key: no ad platform can be connected");
        await coord.put(READY_KEY, JSON.stringify(NONE), 60).catch(() => undefined);
        return { ...NONE };
      }
      logger.warn({ err }, "nango's integrations couldn't be listed; offering the platforms set up here");
      ready = { meta: true, google: true, adsense: true };
    }
  }
  return { meta: listed.meta && ready.meta, google: listed.google && ready.google, adsense: listed.adsense && ready.adsense };
}

/** For tests, and after nango-setup.mjs changed the integrations: ask Nango again on the next look. */
export async function forgetNangoIntegrations(coord: Coord) {
  await coord.take(READY_KEY).catch(() => null);
}

/** A Nango sign-in on its way: who started it, for which store and platform, through which integration. */
export interface NangoSessionState {
  userId: string;
  workspaceId: string;
  storeId: string;
  provider: AdProvider;
  integrationKey: string;
}

const sessionKey = (nonce: string) => `oauth:ads-nango:${nonce}`;

/**
 * The platform's authorize-URL parameters Nango adds for bizinsights, as the direct sign-in sends them:
 * Meta's Facebook Login for Business configuration (META_CONFIG_ID) when there is one, else a re-ask
 * for a permission declined before; Google's are Nango's own template (offline access, consent screen).
 */
export function nangoAuthorizationParams(provider: AdProvider): Record<string, string> {
  if (provider !== "meta") return {};
  const cfg = metaConfig();
  return cfg?.configId ? { config_id: cfg.configId } : { auth_type: "rerequest" };
}

/**
 * Start a Nango sign-in: a connect session limited to the platform's integration, tagged with ids only
 * (never an email), among them `nonce`, by which finishNangoSignIn later knows the connection came from
 * this session. The state is kept in the coordinator for the session's lifetime.
 */
export async function startNangoSession(
  coord: Coord,
  cfg: NangoConfig,
  nonce: string,
  input: Omit<NangoSessionState, "integrationKey">,
): Promise<{ token: string; expiresAt: string | null }> {
  const integrationKey = NANGO_INTEGRATION[input.provider];
  const session = await nangoCreateConnectSession(cfg, {
    integrationKey,
    tags: { end_user_id: input.userId, organization_id: input.workspaceId, bi_store: input.storeId, bi_provider: input.provider, bi_session: nonce },
    authorizationParams: nangoAuthorizationParams(input.provider),
  });
  const state: NangoSessionState = { ...input, integrationKey };
  await coord.put(sessionKey(nonce), JSON.stringify(state), NANGO_SESSION_TTL_S);
  return session;
}

/** A sign-in's state, without using it up. */
export async function peekNangoSessionState(coord: Coord, nonce: string): Promise<NangoSessionState | null> {
  const raw = await coord.peek(sessionKey(nonce));
  return raw ? (JSON.parse(raw) as NangoSessionState) : null;
}

/** Use up a sign-in's state: it can be finished (or abandoned) once. */
export async function takeNangoSessionState(coord: Coord, nonce: string): Promise<NangoSessionState | null> {
  const raw = await coord.take(sessionKey(nonce));
  return raw ? (JSON.parse(raw) as NangoSessionState) : null;
}

const consentKey = (nonce: string) => `oauth:ads-nango-consent:${nonce}`;

/**
 * Which platforms a consent arriving at bizinsights' OAuth callback can be for, from what the platform
 * sends back with it: Google names the scopes granted (`scope`), so its consent is for the Google
 * platforms whose read-only scope it carries; Meta sends no scope. Null when it carries no authorization
 * code (the person declined, or an error at the platform): no connection can be made from it.
 */
export function nangoConsentProviders(query: URLSearchParams): AdProvider[] | null {
  if (!query.get("code")) return null;
  const scope = query.get("scope");
  if (scope === null) return ["meta"];
  const granted = new Set(scope.split(/[\s,]+/).filter(Boolean));
  return (["adsense", "google"] as const).filter((p) => granted.has(REQUIRED_AD_SCOPE[p]));
}

/**
 * A session's consent came back through bizinsights' callback: noted once per session (false when one
 * already did), so a started session forwards at most one consent. Its finish requires the note.
 */
export async function claimNangoConsent(coord: Coord, nonce: string): Promise<boolean> {
  return coord.acquire(consentKey(nonce), NANGO_SESSION_TTL_S * 1000);
}

/** Whether a consent for this session came back through bizinsights' callback (claimNangoConsent). */
export async function nangoConsentReturned(coord: Coord, nonce: string): Promise<boolean> {
  return (await coord.peek(consentKey(nonce))) !== null;
}

/** The connection the browser named isn't one this session made (another session's, or someone else's). */
export class NangoConnectionMismatchError extends Error {}

/**
 * Whether Nango's connection `connectionId` was made by this session: it belongs to the session's
 * integration and carries the session's tags (nonce, person, workspace, store, platform), all read from
 * Nango, never from the browser. Nothing the browser says about a connection is trusted past its id.
 */
export async function nangoConnectionFromSession(cfg: NangoConfig, state: NangoSessionState, nonce: string, connectionId: string): Promise<boolean> {
  const found = await nangoConnections(cfg, connectionId);
  return found.some(
    (x) =>
      x.connectionId === connectionId &&
      x.integrationKey === state.integrationKey &&
      x.tags.bi_session === nonce &&
      x.tags.end_user_id === state.userId &&
      x.tags.organization_id === state.workspaceId &&
      x.tags.bi_store === state.storeId &&
      x.tags.bi_provider === state.provider,
  );
}

/** What a finished Nango sign-in gave: who signed in, what they granted, and the accounts they can connect. */
export interface NangoSignIn {
  connectionId: string;
  integrationKey: string;
  /** When the token Nango holds ends, when it says (Meta's long-lived token). */
  expiresAt: Date | null;
  externalUserId: string | null;
  grantedScopes?: string[];
  accounts: AdAccountList;
}

/** The person unticked the one permission on the platform's screen: nothing can be read. */
export class NangoPermissionMissingError extends Error {}

/**
 * Read a new Nango connection the way the direct callback reads a fresh sign-in: a working token from
 * Nango, the permission it carries, who granted it (which also proves, for Google, that the token was
 * issued to bizinsights' own client; for Meta every call is signed with bizinsights' app secret), and
 * the accounts it can see. Platform failures are thrown as the ad errors connectFailure() words.
 */
export async function finishNangoSignIn(provider: AdProvider, connectionId: string, integrationKey: string, fetchImpl?: FetchLike): Promise<NangoSignIn> {
  const cred = { connectionId, integrationKey };
  forgetNangoToken(connectionId);
  const { token, expiresAt } = await nangoTokenFor(cred, fetchImpl);
  if (provider === "meta") {
    const cfg = metaConfig(fetchImpl);
    if (!cfg) throw new AdsApiError("Meta isn't set up on this server", 503, undefined, "not_configured");
    // A Login for Business system-user token may not answer /me/permissions; then the account list is the test.
    const granted = await metaGrantedPermissions(cfg, token).catch((err: unknown) => {
      if (err instanceof AdsApiError) return undefined;
      throw err;
    });
    if (granted && !granted.includes(REQUIRED_AD_SCOPE.meta)) throw new NangoPermissionMissingError("ads_read was not granted");
    const externalUserId = await platformPerson("meta", token, fetchImpl).catch(() => null);
    return { connectionId, integrationKey, expiresAt, externalUserId, grantedScopes: granted, accounts: await metaAdAccounts(cfg, token) };
  }
  const cfg = provider === "adsense" ? adsenseConfig(fetchImpl) : googleClient(fetchImpl);
  if (!cfg) throw new AdsApiError(`${provider === "adsense" ? "Google AdSense" : "Google Ads"} isn't set up on this server`, 503, undefined, "not_configured");
  // Google: tokeninfo says whose token it is and refuses one issued to another client (AdsAuthError).
  const externalUserId = await platformPerson(provider, token, fetchImpl);
  const { scopes, email } = await googleTokenInfo(token, fetchImpl);
  if (scopes && !scopes.includes(REQUIRED_AD_SCOPE[provider])) throw new NangoPermissionMissingError(`${REQUIRED_AD_SCOPE[provider]} was not granted`);
  const listed = provider === "adsense" ? adsenseAccounts(cfg, token) : googleAdAccounts(googleClient(fetchImpl)!, token);
  // Nothing to connect: the card names the Google account Google picked (its email), for the person who just used it.
  const accounts = await listed.catch((err: unknown) => {
    if (err instanceof AdsNoAccountsError && email && !err.loginName) err.loginName = email;
    throw err;
  });
  return { connectionId, integrationKey, expiresAt, externalUserId, grantedScopes: scopes, accounts };
}

/**
 * What tokeninfo says of a Google access token: its scopes (undefined when Google doesn't say), and the
 * account's email address when the token carries GOOGLE_EMAIL_SCOPE (null otherwise).
 */
async function googleTokenInfo(token: string, fetchImpl?: FetchLike): Promise<{ scopes: string[] | undefined; email: string | null }> {
  const res = await (fetchImpl ?? fetch)(`https://oauth2.googleapis.com/tokeninfo?${new URLSearchParams({ access_token: token })}`, { method: "GET" }).catch(() => null);
  if (!res?.ok) return { scopes: undefined, email: null };
  const body = (await res.json().catch(() => ({}))) as { scope?: unknown; email?: unknown };
  const email = typeof body.email === "string" && /^[^\s@]+@[^\s@]+$/.test(body.email.trim()) ? body.email.trim().slice(0, 120) : null;
  return { scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : undefined, email };
}

/**
 * A sign-in that ended without a connection (cancelled, refused, nothing to connect, or the person
 * closed the window after authorizing): its Nango connection goes, with the grant it made, unless a
 * connection already reads through it (a reconnect), or (with `coord`) the person has another account
 * choice waiting on the same grant (`exceptPending`: the one being dropped). Best effort.
 */
export async function abandonNangoConnection(
  provider: AdProvider,
  connectionId: string,
  integrationKey: string,
  externalUserId: string | null | undefined,
  fetchImpl?: FetchLike,
  opts: { coord?: Coord; exceptPending?: string } = {},
) {
  return releaseNangoConnectionIfUnused({ provider, connectionId, integrationKey, externalUserId, coord: opts.coord, exceptPending: opts.exceptPending }, fetchImpl);
}

/**
 * The Nango connections of account choices that were dropped unanswered (Meta's deauthorize or data
 * deletion callbacks): let go, with the person's token Nango held. Best effort.
 */
export async function releaseDroppedNangoChoices(dropped: PendingAdConnect[], fetchImpl?: FetchLike): Promise<number> {
  let released = 0;
  const done = new Set<string>();
  for (const p of dropped) {
    if (pendingSource(p) !== "nango" || !p.sourceLoginId || done.has(p.sourceLoginId)) continue;
    done.add(p.sourceLoginId);
    const outcome = await abandonNangoConnection(p.provider, p.sourceLoginId, p.nangoIntegrationKey ?? NANGO_INTEGRATION[p.provider], p.externalUserId, fetchImpl);
    if (outcome !== "still_used" && outcome !== "failed") released++;
  }
  return released;
}

/** How long a connection Nango says it made is given to be finished by its person before it is let go. */
export const NANGO_ORPHAN_GRACE_S = 20 * 60;

const orphanKey = (connectionId: string) => `nango-created:${connectionId}`;

/**
 * Nango's auth webhook, already checked to be Nango's (its signature). What it changes:
 *
 * - `deletion`: the connection was deleted at Nango. Every account reading through it waits for a
 *   reconnect (auth_expired), as a sync that met ended access leaves it; its days stay.
 * - `refresh` that failed: Nango is asked for a token itself. Only a grant the platform refused (or Nango
 *   gave up renewing) puts the accounts on Reconnect; a passing failure (an outage at the platform, Nango
 *   backing off) is left to the next sync, which retries.
 * - `refresh` that worked again (Nango's recovery webhook): accounts on Reconnect for an ended Nango
 *   grant whose token now works are put back to active, and the scheduler syncs them again.
 * - `creation` for one of bizinsights' integrations: noted, so a connection whose person closed the
 *   window before bizinsights could finish it is found and let go (sweepNangoOrphans).
 *
 * Everything else is acknowledged and left alone. Idempotent: marking rows twice changes nothing.
 * Returns how many connections were marked.
 */
export async function handleNangoAuthEvent(coord: Coord, event: NangoAuthEvent, fetchImpl?: FetchLike): Promise<number> {
  const provider = nangoProviderOf(event.integrationKey);
  if (!provider) {
    logger.info({ integrationKey: event.integrationKey, operation: event.operation }, "nango webhook for an integration bizinsights didn't make; ignored");
    return 0;
  }
  if (event.operation === "creation" && event.success) {
    await coord
      .put(orphanKey(event.connectionId), JSON.stringify({ provider, integrationKey: event.integrationKey, at: Date.now() }), NANGO_ORPHAN_GRACE_S * 3)
      .catch(() => undefined);
    await rememberOrphanCandidate(coord, event.connectionId);
    return 0;
  }
  if (event.operation !== "refresh" && event.operation !== "deletion") return 0;
  forgetNangoToken(event.connectionId);
  if (event.operation === "refresh") {
    // What Nango says now, not what one renewal said: a refused grant, or a token that works (or a passing failure).
    const now = await nangoTokenFor({ connectionId: event.connectionId, integrationKey: event.integrationKey }, fetchImpl).then(
      () => "works" as const,
      (err: unknown) => (err instanceof AdsAuthError ? ("ended" as const) : ("unsure" as const)),
    );
    if (now === "works") return restoreNangoRows(event.connectionId);
    if (now === "unsure") {
      logger.info({ provider, success: event.success, errorType: event.errorType }, "nango: a renewal failed for now; the next sync retries");
      return 0;
    }
  }
  const rows = await systemDb.adConnection.findMany({ where: { source: "nango", sourceLoginId: event.connectionId, accessTokenEnc: { not: "" }, status: { not: "reconnect" } }, select: { id: true } });
  for (const r of rows) await recordAdFailure(r.id, { status: "reconnect", code: "auth_expired", detail: `Nango: ${event.operation}${event.errorType ? ` (${event.errorType})` : ""}`, retryable: false, retryAfterS: null }, "sync");
  logger.info({ provider, operation: event.operation, errorType: event.errorType, connections: rows.length }, "nango: a connection's access ended");
  return rows.length;
}

/**
 * Accounts put on Reconnect because their Nango grant ended (auth_expired) while its token works again:
 * back to active, so the scheduler syncs them; their alerts close with the next sweep. Returns how many.
 */
async function restoreNangoRows(connectionId: string): Promise<number> {
  const { count } = await systemDb.adConnection.updateMany({
    where: { source: "nango", sourceLoginId: connectionId, accessTokenEnc: { not: "" }, status: "reconnect", errorCode: "auth_expired" },
    data: { status: "active", errorCode: null, lastError: null, consecutiveFailures: 0 },
  });
  if (count) logger.info({ connections: count }, "nango: a connection's access works again; its accounts are back");
  return count;
}

const ORPHANS_KEY = "nango-orphan-candidates";

/** The connections Nango made lately, for sweepNangoOrphans. Best effort (a lost entry only leaves one behind at Nango). */
async function rememberOrphanCandidate(coord: Coord, connectionId: string) {
  try {
    const raw = await coord.peek(ORPHANS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    const ids = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x !== connectionId) : [];
    await coord.put(ORPHANS_KEY, JSON.stringify([...ids, connectionId].slice(-200)), NANGO_ORPHAN_GRACE_S * 3);
  } catch {
    // Best effort.
  }
}

/**
 * Let go of the connections Nango made that bizinsights never finished (the person closed the window
 * after authorizing, or the browser lost the answer): older than the grace period, read through by no
 * account, and held by no account choice. Run every 15 minutes (the cron tick). Returns how many were let go.
 */
export async function sweepNangoOrphans(coord: Coord, fetchImpl?: FetchLike): Promise<number> {
  const raw = await coord.peek(ORPHANS_KEY).catch(() => null);
  const ids = raw ? ((JSON.parse(raw) as unknown[]) ?? []).filter((x): x is string => typeof x === "string") : [];
  if (!ids.length) return 0;
  const keep: string[] = [];
  let released = 0;
  for (const id of ids) {
    const note = await coord.peek(orphanKey(id)).catch(() => null);
    if (!note) continue;
    const { provider, integrationKey, at } = JSON.parse(note) as { provider: AdProvider; integrationKey: string; at: number };
    if (Date.now() - at < NANGO_ORPHAN_GRACE_S * 1000) {
      keep.push(id);
      continue;
    }
    // Finished (an account reads through it) or still being chosen from (finishNangoSignIn's pending choice marks it).
    const used = (await systemDb.adConnection.count({ where: { source: "nango", sourceLoginId: id } })) > 0 || !!(await coord.peek(nangoHeldKey(id)).catch(() => null));
    if (!used) {
      const outcome = await abandonNangoConnection(provider, id, integrationKey, null, fetchImpl, { coord });
      // Nango didn't answer the delete: tried again on the next tick (the note is renewed, its time kept).
      if (outcome === "failed") {
        keep.push(id);
        await coord.put(orphanKey(id), note, NANGO_ORPHAN_GRACE_S * 3).catch(() => undefined);
        continue;
      }
      released++;
    }
    await coord.take(orphanKey(id)).catch(() => null);
  }
  // Connections Nango made while this ran were added to the list meanwhile: kept, never written over.
  const latest = await coord.peek(ORPHANS_KEY).catch(() => null);
  const seen = new Set(ids);
  const added = latest ? ((JSON.parse(latest) as unknown[]) ?? []).filter((x): x is string => typeof x === "string" && !seen.has(x)) : [];
  await coord.put(ORPHANS_KEY, JSON.stringify([...keep, ...added].slice(-200)), NANGO_ORPHAN_GRACE_S * 3).catch(() => undefined);
  if (released) logger.info({ released }, "nango: connections nobody finished were let go");
  return released;
}

/** Marks a Nango connection as held by an account choice (so the orphan sweep leaves it for the choice's lifetime). */
export const nangoHeldKey = (connectionId: string) => `nango-held:${connectionId}`;

/** A Nango connection is being chosen from: keep it out of the orphan sweep while the choice lasts. */
export async function holdNangoConnection(coord: Coord, connectionId: string, ttlS: number) {
  await coord.put(nangoHeldKey(connectionId), "1", ttlS).catch(() => undefined);
}

/** For the routes: an AdsAuthError from Nango while finishing means the authorization didn't hold. */
export const nangoAuthEnded = (err: unknown) => err instanceof AdsAuthError;
