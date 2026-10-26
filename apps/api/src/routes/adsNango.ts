import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb } from "@app/db";
import {
  abandonNangoConnection,
  AD_PROVIDER_NAME,
  ADS_PENDING_TTL_S,
  AdsApiError,
  AdsAuthError,
  AdsNoAccountsError,
  AdsRateLimitedError,
  AdsRetryableError,
  audit,
  claimNangoConsent,
  connectableAdProviders,
  countGoogleAdsOperations,
  countingGoogleAdsFetch,
  finishNangoSignIn,
  googleAdsPaused,
  handleNangoAuthEvent,
  holdAdLogin,
  holdNangoConnection,
  holdPendingAdConnect,
  isNangoConnectionId,
  peekNangoSessionState,
  logger,
  nangoConfig,
  nangoConnectionFromSession,
  nangoConsentProviders,
  nangoConsentReturned,
  NangoLoginWaitingError,
  NangoPermissionMissingError,
  nangoProviders,
  parseNangoWebhook,
  startNangoSession,
  takeNangoSessionState,
  verifyNangoSignature,
  env,
  type NangoSignIn,
} from "@app/core";
import { AD_PROVIDERS, adErrorMessage, randomToken, sha256Hex, type AdProvider } from "@app/shared";
import { body, clientIp, HttpError, loadUser, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { connectAccounts, connectFailure, mayStillConnect, storeInWorkspace } from "./ads.js";

/**
 * "Continue with Meta Ads" / "Google Ads" / "Google AdSense" through Nango (docs/nango.md), the one way
 * an ad platform is connected, for the platforms connectableAdProviders() offers. The card opens Nango's
 * Connect UI over the page with a short-lived session token; the merchant authorizes bizinsights' own
 * Meta app or Google client on the platform's consent screen there, and the page then tells bizinsights
 * which Nango connection was made.
 *
 * Nothing the browser says is trusted past that connection's id: the session's state (single-use, bound
 * to the person, workspace, store and platform) is kept here, and the connection must carry the session's
 * tags as Nango holds them. Then one account (or a reconnect) is connected at once, several wait for the
 * person's choice (routes/ads.ts), and a sign-in that ends without a connection gives its grant back and
 * its Nango connection is deleted.
 *
 * Also here: bizinsights' address for Nango's OAuth callback (forwarded to Nango, so the platforms'
 * consent screens name bizinsights.io), and Nango's signed webhooks about connections.
 */

const providerSchema = z.enum(AD_PROVIDERS);

/**
 * The Nango sessions this browser started, newest first: the platform's consent comes back through
 * bizinsights' callback forward (below) only in a browser that holds one, for the person signed in who
 * started it. Without it, a session token handed to someone else's page would bring that person's
 * consent back to the starter's store.
 */
const SESSION_COOKIE = "ads_nango_state";
/**
 * The sessions whose platform consent came back through bizinsights' callback in this browser, newest
 * first (the receipt the forward leaves): a finish needs its session's. A consent given in someone
 * else's browser is noted against that person's own session, never this one's.
 */
const CONSENT_COOKIE = "ads_nango_consent";
const MAX_SESSIONS = 5;
const sessionsOf = (cookie: string | undefined) => (cookie ?? "").split(".").filter((n) => /^[A-Za-z0-9_-]{16,64}$/.test(n));
const cookieOpts = () => ({ path: "/", httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production", maxAge: 30 * 60 });
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const connectionIdSchema = z.string().refine(isNangoConnectionId, "not a Nango connection id");

/** What the card says for each way a finish can fail (the codes are the direct callback's, worded the same on the page). */
const FINISH_MESSAGES: Record<string, string> = {
  state_expired: "That sign-in took too long. Press the button to connect again.",
  session_mismatch: "That sign-in was started by someone else. Press the button to connect again.",
  state_mismatch: "That sign-in couldn't be matched to this page. Press the button to connect again.",
  permission_missing: "The read-only permission wasn't granted, so nothing can be read. Connect again and leave it ticked.",
  no_accounts: "This login has no account that can be connected.",
  not_allowed: "You can no longer connect accounts to this store.",
  not_configured: "Connecting isn't available right now. It's on our side, not yours.",
  rate_limited: "The platform asked bizinsights to slow down. Try again in a few minutes.",
  temporarily_unavailable: "The platform didn't answer. Try again in a minute.",
};

const finishError = (code: string, status = 409, detail?: unknown) => new HttpError(status, FINISH_MESSAGES[code] ?? "Connecting didn't work. Try again.", code, undefined, detail);

/** A failure of Nango's own while starting a sign-in, as the HTTP answer the card words. */
function startFailure(err: unknown, provider: AdProvider): unknown {
  if (err instanceof AdsRateLimitedError) return new HttpError(429, "Too many sign-ins right now. Try again in a few minutes.", "rate_limited", 300);
  if (err instanceof AdsRetryableError) return new HttpError(503, "The sign-in window couldn't be opened. Try again in a minute.", "nango_busy", 60);
  if (err instanceof AdsApiError) {
    logger.error({ err, provider }, "nango connect session not created");
    return new HttpError(503, `Connecting ${AD_PROVIDER_NAME[provider]} isn't available right now. It's on our side, not yours.`, "not_configured");
  }
  return err;
}

export function adsNangoRoutes(app: App, deps: Deps) {
  /**
   * Step 1: a Nango connect session for the platform, for the Connect UI the card opens. The token is
   * Nango's, lasts 30 minutes, and can only connect this one integration; `nonce` goes back with the result.
   */
  app.post("/workspaces/:ws/stores/:storeId/ads/:provider/nango/session", async (c) => {
    const { ws, storeId } = c.req.param();
    const provider = providerSchema.parse(c.req.param("provider"));
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const user = access.user!;
    if (!user.emailVerified) throw new HttpError(403, "Verify your email first", "email_unverified");
    await storeInWorkspace(ws, storeId);
    const cfg = nangoConfig(deps.fetchImpl);
    if (!cfg || !(await connectableAdProviders(deps.coord, deps.fetchImpl))[provider]) throw new HttpError(503, `${AD_PROVIDER_NAME[provider]} isn't set up on this server yet.`, "not_configured");
    // Listing a login's Google Ads accounts spends bizinsights' daily operations: none while they're used up.
    if (provider === "google" && (await googleAdsPaused(deps.coord))) throw new HttpError(503, adErrorMessage("quota_exhausted", "google")!, "rate_limited", 3600);
    // Each session writes a coordinator item and a Nango session, and its finish lists accounts against the platform's quota.
    await limit(deps.coord, `rl:ads-connect:${user.id}`, LIMITS.adsConnect, "That's a lot of sign-ins in a short time. Wait a few minutes and try again.");
    const nonce = randomToken(24);
    try {
      const session = await startNangoSession(deps.coord, cfg, nonce, { userId: user.id, workspaceId: ws, storeId, provider });
      setCookie(c, SESSION_COOKIE, [nonce, ...sessionsOf(getCookie(c, SESSION_COOKIE))].slice(0, MAX_SESSIONS).join("."), cookieOpts());
      return c.json({ token: session.token, expiresAt: session.expiresAt, nonce });
    } catch (err) {
      throw startFailure(err, provider);
    }
  });

  /**
   * Step 2: the Connect UI said a connection was made (`connectionId`). Checked with Nango, read like a
   * fresh sign-in, then connected (one account, or nothing new) or held for the person's choice.
   */
  app.post("/workspaces/:ws/stores/:storeId/ads/:provider/nango/finish", async (c) => {
    const { ws, storeId } = c.req.param();
    const provider = providerSchema.parse(c.req.param("provider"));
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const user = access.user!;
    await storeInWorkspace(ws, storeId);
    const input = z.object({ nonce: nonceSchema, connectionId: connectionIdSchema }).parse(await body(c));
    const cfg = nangoConfig(deps.fetchImpl);
    if (!cfg || !nangoProviders()[provider]) throw finishError("not_configured", 503);
    // Used up whatever comes next: a finish is answered once.
    const state = await takeNangoSessionState(deps.coord, input.nonce);
    if (!state) throw finishError("state_expired");
    if (state.userId !== user.id || state.workspaceId !== ws || state.storeId !== storeId || state.provider !== provider) throw finishError("session_mismatch", 403);
    // The platform's consent for this session came back through the callback in this browser. Without
    // it, the connection carrying this session's tags was made from a consent given somewhere else (the
    // session's platform link handed to someone signed in with an open session of their own): never
    // touched, as for a connection that isn't this session's.
    if (!sessionsOf(getCookie(c, CONSENT_COOKIE)).includes(input.nonce) || !(await nangoConsentReturned(deps.coord, input.nonce))) {
      logger.warn({ provider, storeId, ip: clientIp(c) }, "nango finish refused: no consent for this session came back through this browser");
      throw finishError("state_mismatch", 403);
    }
    let ours: boolean;
    try {
      ours = await nangoConnectionFromSession(cfg, state, input.nonce, input.connectionId);
    } catch (err) {
      logger.warn({ err, provider }, "nango connection couldn't be checked");
      throw finishError("temporarily_unavailable", 503);
    }
    // Not this session's connection: never touched (it may be someone else's).
    if (!ours) {
      logger.warn({ provider, storeId, ip: clientIp(c) }, "nango finish refused: the connection doesn't carry this session's tags");
      throw finishError("state_mismatch", 403);
    }

    let signIn: NangoSignIn | undefined;
    /** End without a connection: the grant goes back and the Nango connection is deleted, unless a connection already reads through it. */
    const fail = async (code: string, status = 409, detail?: unknown) => {
      await abandonNangoConnection(provider, input.connectionId, state.integrationKey, signIn?.externalUserId, deps.fetchImpl, { coord: deps.coord });
      return finishError(code, status, detail);
    };
    // Listing a login's Google Ads accounts spends bizinsights' daily operations, as the direct callback's do.
    const counter = provider === "google" ? countingGoogleAdsFetch(deps.fetchImpl) : null;
    try {
      signIn = await finishNangoSignIn(provider, input.connectionId, state.integrationKey, counter?.fetchImpl ?? deps.fetchImpl);
    } catch (err) {
      // Signed in and granted, with no ad account to list yet (or the platform slow to list them): connected
      // all the same, never refused. The card says who is connected, and the accounts follow by themselves.
      if (err instanceof NangoLoginWaitingError) {
        signIn = { ...err.signIn, accounts: [] };
        // Logged as a refusal used to be, with Meta's diagnosis of the empty list (docs/ads-setup.md reads it).
        connectFailure(err.cause, provider, storeId);
        if (!(await mayStillConnect(ws, storeId, user.id))) throw await fail("not_allowed", 403);
        await holdAdLogin(
          {
            workspaceId: ws,
            storeId,
            provider,
            connectionId: input.connectionId,
            integrationKey: state.integrationKey,
            externalUserId: err.signIn.externalUserId,
            loginName: err.loginName,
            grantedScopes: err.signIn.grantedScopes,
            expiresAt: err.signIn.expiresAt,
            userId: user.id,
            reason: err.reason,
          },
          deps.fetchImpl,
        );
        await audit({ workspaceId: ws, actorUserId: user.id, action: "ads.login_connected", targetType: "store", targetId: storeId, metadata: { provider, reason: err.reason }, ip: clientIp(c) }).catch((e: unknown) =>
          logger.warn({ err: e }, "audit failed"),
        );
        return c.json({ connected: 0, waiting: true, reason: err.reason, provider });
      }
      if (err instanceof NangoPermissionMissingError) throw await fail("permission_missing");
      // A token Nango holds but the platform refuses, or one issued to another app (Meta: our appsecret_proof
      // refused): the Nango integration's keys aren't bizinsights' own.
      if (err instanceof AdsAuthError || (err instanceof AdsApiError && err.errorCode === "not_configured")) {
        logger.error({ err, provider }, "nango connection's token refused: check the integration's client id and secret (infra/cdk/scripts/nango-setup.mjs)");
        throw await fail("not_configured", 503);
      }
      const code = connectFailure(err, provider, storeId);
      // Nothing to connect: the card names the login the platform signed in, for the person who just used it
      // (the platform's screen may have picked a profile they didn't mean).
      const login = err instanceof AdsNoAccountsError && err.loginName ? { login: err.loginName } : undefined;
      throw await fail(code, code === "rate_limited" || code === "temporarily_unavailable" || code === "not_configured" ? 503 : 409, login);
    } finally {
      if (counter) await countGoogleAdsOperations(deps.coord, counter.operations());
    }
    const { accounts } = signIn;
    if (!accounts.length) throw await fail("no_accounts");
    try {
      if (!(await mayStillConnect(ws, storeId, user.id))) throw await fail("not_allowed", 403);
      const tokens = { accessToken: input.connectionId, refreshToken: null, expiresAt: signIn.expiresAt, grantedScopes: signIn.grantedScopes };
      const known = await systemDb.adConnection.findMany({ where: { storeId, provider }, select: { accountId: true } });
      const knownIds = new Set(known.map((k) => k.accountId));
      // One account, or a reconnect that sees nothing new: nothing to choose. A list cut short always goes to the choice.
      if (!accounts.truncated && (accounts.length === 1 || accounts.every((a) => knownIds.has(a.accountId)))) {
        const saved = await connectAccounts(deps, clientIp(c), {
          workspaceId: ws,
          storeId,
          provider,
          accounts,
          tokens,
          userId: user.id,
          externalUserId: signIn.externalUserId,
          sourceLoginId: input.connectionId,
          source: "nango",
          nangoIntegrationKey: state.integrationKey,
        });
        return c.json({ connected: saved.length, provider });
      }
      const pick = randomToken(24);
      await holdPendingAdConnect(deps.coord, pick, {
        userId: user.id,
        workspaceId: ws,
        storeId,
        provider,
        accounts,
        tokens,
        externalUserId: signIn.externalUserId,
        sourceLoginId: input.connectionId,
        source: "nango",
        nangoIntegrationKey: state.integrationKey,
      });
      await holdNangoConnection(deps.coord, input.connectionId, ADS_PENDING_TTL_S + 60);
      return c.json({ choose: pick, provider });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Nothing was connected with it: the Nango connection isn't left behind.
      await abandonNangoConnection(provider, input.connectionId, state.integrationKey, signIn.externalUserId, deps.fetchImpl, { coord: deps.coord });
      throw err;
    }
  });

  /** The person closed the Connect UI without connecting: the session is used up (a connection it made anyway is let go by the leftover sweep). */
  app.post("/workspaces/:ws/stores/:storeId/ads/:provider/nango/cancel", async (c) => {
    const { ws, storeId } = c.req.param();
    providerSchema.parse(c.req.param("provider"));
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const { nonce } = z.object({ nonce: nonceSchema }).parse(await body(c));
    // Only this person's own session for this store is used up; anyone else's is left alone.
    const state = await peekNangoSessionState(deps.coord, nonce);
    if (state && state.userId === access.user?.id && state.workspaceId === ws && state.storeId === storeId) await takeNangoSessionState(deps.coord, nonce);
    return c.json({ ok: true });
  });

  /**
   * Nango's OAuth callback, at bizinsights' own address: the platform sends the browser here after its
   * consent screen (this is the redirect URI registered with Meta and Google, and the Nango environment's
   * callback URL), and it goes on to Nango's, query and all (308 keeps the method). Only for a person
   * signed in here who started a Nango session in this browser that is still open: a consent given
   * anywhere else (signed out, someone else signed in, no open session of theirs) never reaches Nango, so
   * no connection is made from it.
   *
   * Which session a consent is for can't be read from it (the query's `state` is Nango's own, and Nango's
   * API has no lookup for it), so a consent uses up one session of the platform it is for (Google names
   * its scopes, Meta none): the newest of this person's open sessions in this browser that hasn't had one,
   * noted for that session's finish (the receipt cookie and the coordinator). Each session forwards one
   * consent; a consent for a platform this person has no open session for is refused. A callback without
   * a code (declined, an error) can't make a connection: it goes on to Nango and uses nothing up.
   */
  app.get("/ads/nango/oauth-callback", async (c) => {
    const cfg = nangoConfig();
    if (!cfg) return c.json({ error: "not_configured" }, 404);
    const url = new URL(c.req.url);
    const open = (
      await Promise.all(sessionsOf(getCookie(c, SESSION_COOKIE)).map(async (nonce) => ({ nonce, state: await peekNangoSessionState(deps.coord, nonce).catch(() => null) })))
    ).filter((s): s is { nonce: string; state: NonNullable<typeof s.state> } => !!s.state);
    // Not knowing who is signed in (an outage) refuses too: the person presses the button again.
    const user = open.length ? await loadUser(c, deps).catch(() => null) : null;
    const mine = user ? open.filter((s) => s.state.userId === user.id) : [];
    const refuse = (why: string) => {
      logger.warn({ ip: clientIp(c), sessions: open.length, signedIn: !!user }, `nango callback refused: ${why}`);
      return c.redirect(`${env().APP_URL}/settings/ads?${new URLSearchParams({ error: "state_mismatch" })}`);
    };
    if (!mine.length) return refuse("no open Nango session in this browser of the person signed in");
    const platforms = nangoConsentProviders(url.searchParams);
    if (platforms) {
      const candidates = mine.filter((s) => platforms.includes(s.state.provider));
      if (!candidates.length) return refuse("no open Nango session of this person for the platform the consent is for");
      let claimed: string | null = null;
      for (const s of candidates) {
        // A coordinator that doesn't answer claims nothing: refused, the person presses the button again.
        if (await claimNangoConsent(deps.coord, s.nonce).catch(() => false)) {
          claimed = s.nonce;
          break;
        }
      }
      if (!claimed) return refuse("every matching Nango session of this person already had its consent");
      setCookie(c, CONSENT_COOKIE, [claimed, ...sessionsOf(getCookie(c, CONSENT_COOKIE))].slice(0, MAX_SESSIONS).join("."), cookieOpts());
    }
    return c.redirect(`${cfg.apiUrl.replace(/\/+$/, "")}/oauth/callback${url.search}`, 308);
  });

  /**
   * Nango's webhooks (Environment Settings → Webhooks: <APP_URL>/api/webhooks/nango). Each is checked
   * against the environment's signing key (X-Nango-Hmac-Sha256 over the raw body) before anything is
   * read; refusals are limited per IP. Each body is acted on once (Nango retries, and may send to two
   * URLs). Machine endpoint: it answers `{ ok }` or `{ error: code }` only.
   */
  app.post("/webhooks/nango", async (c) => {
    const secret = env().NANGO_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "not_configured" }, 503);
    const raw = await c.req.text();
    if (!verifyNangoSignature(raw, c.req.header("x-nango-hmac-sha256"), secret.split(",").map((s) => s.trim()))) {
      const ip = clientIp(c);
      const n = await deps.coord.hit(`rl:nango-wh:${ip ?? "unknown"}`, LIMITS.metaCallbackRefusedIp.windowSec).catch(() => 0);
      if (n > LIMITS.metaCallbackRefusedIp.max) return c.json({ error: "rate_limited" }, 429, { "retry-after": String(LIMITS.metaCallbackRefusedIp.windowSec) });
      logger.warn({ ip }, "nango webhook rejected: its signature didn't verify");
      return c.json({ error: "invalid_signature" }, 401);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const event = parseNangoWebhook(parsed);
    // Other webhook types (syncs, forwards) aren't used: acknowledged, so Nango doesn't retry them.
    if (!event) return c.json({ ok: true });
    const seenKey = `nango-wh-seen:${sha256Hex(raw)}`;
    if (await deps.coord.peek(seenKey).catch(() => null)) return c.json({ ok: true });
    await handleNangoAuthEvent(deps.coord, event, deps.fetchImpl);
    await deps.coord.put(seenKey, "1", 24 * 3600).catch(() => undefined);
    return c.json({ ok: true });
  });
}

