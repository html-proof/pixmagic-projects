import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb, withTenant } from "@app/db";
import {
  AD_PROVIDER_NAME,
  AdsApiError,
  AdsNoAccountsError,
  AdsRateLimitedError,
  AdsRetryableError,
  env,
  finishSupermetricsLink,
  holdPendingAdConnect,
  isSupermetricsConnection,
  logger,
  revokeSupermetricsLoginIfUnused,
  startSupermetricsLink,
  supermetricsConfig,
  supermetricsCredential,
  supermetricsLicensed,
  supermetricsProviders,
  SupermetricsLinkUnusedError,
  takeSupermetricsLinkState,
  type SupermetricsSignIn,
} from "@app/core";
import { AD_PROVIDERS, randomToken, safeEqual, type AdProvider } from "@app/shared";
import { body, clientIp, HttpError, loadUser, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { CALLBACK_DB_WAIT_MS, connectAccounts, connectFailure, DbUnavailable, mayStillConnect, storeInWorkspace, waitingOutDb } from "./ads.js";

/**
 * "Connect through Supermetrics" (docs/supermetrics.md): the merchant connects Meta Ads, Google Ads or
 * AdSense by signing in to the platform on Supermetrics' own page, through a data source login link
 * bizinsights' Supermetrics team creates for them, and bizinsights then reads the figures through
 * Supermetrics' API. Offered only once this server holds the team's API key (supermetricsProviders).
 *
 * The round trip is guarded like the platforms' own (routes/ads.ts): single-use state in the
 * coordinator, bound to this browser by a cookie and to the person who started it. What comes back is
 * never taken from the browser: the callback asks Supermetrics which login the link made (by the link's
 * id, kept server side), closes the link, and lists that login's accounts. From there it is the same as
 * a platform sign-in: one account (or a reconnect) is connected at once, several wait for the person's
 * choice on the integrations page, and a sign-in that ends without a connection gives its login back.
 */

const STATE_COOKIE = "ads_sm_state";
const STATE_TTL_S = 30 * 60;
const MAX_PENDING_STATES = 5;
const pendingStates = (cookie: string | undefined) => (cookie ?? "").split(".").filter((n) => /^[A-Za-z0-9_-]{16,64}$/.test(n));
const cookieOpts = () => ({ path: "/", httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production", maxAge: STATE_TTL_S });

const providerSchema = z.enum(AD_PROVIDERS);

/** A failure of Supermetrics' own while starting a sign-in, as the HTTP answer the card words. */
function startFailure(err: unknown, provider: AdProvider): unknown {
  if (err instanceof AdsRateLimitedError) return new HttpError(429, "Supermetrics asked bizinsights to slow down. Try again in a few minutes.", "rate_limited", 300);
  if (err instanceof AdsRetryableError) return new HttpError(503, "Supermetrics didn't answer. Try again in a minute.", "supermetrics_busy", 60);
  if (err instanceof AdsApiError) {
    logger.error({ err, provider }, "supermetrics login link not created");
    return new HttpError(503, `Connecting ${AD_PROVIDER_NAME[provider]} through Supermetrics isn't available right now. It's on our side, not yours.`, "not_configured");
  }
  return err;
}

export function adsSupermetricsRoutes(app: App, deps: Deps) {
  /**
   * Step 1: a login link for the platform, and where to send the browser (Supermetrics' page). With
   * `reconnect` (a connection read through Supermetrics whose login ended), the same platform user is
   * asked to sign in again, and the new login takes the old one's place.
   */
  app.post("/workspaces/:ws/stores/:storeId/ads/:provider/supermetrics/connect", async (c) => {
    const { ws, storeId } = c.req.param();
    const provider = providerSchema.parse(c.req.param("provider"));
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const user = access.user!;
    if (!user.emailVerified) throw new HttpError(403, "Verify your email first", "email_unverified");
    await storeInWorkspace(ws, storeId);
    const { reconnect } = z.object({ reconnect: z.string().min(1).max(64).optional() }).parse(await body(c));
    const cfg = supermetricsConfig(deps.fetchImpl);
    if (!cfg || !supermetricsProviders()[provider]) throw new HttpError(503, `${AD_PROVIDER_NAME[provider]} through Supermetrics isn't set up on this server.`, "not_configured");
    await limit(deps.coord, `rl:ads-connect:${user.id}`, LIMITS.adsConnect, "That's a lot of sign-ins in a short time. Wait a few minutes and try again.");

    let requireUsername: string | null = null;
    let replacesLoginId: string | null = null;
    if (reconnect) {
      const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id: reconnect, workspaceId: ws, storeId, provider } }));
      if (!conn || !isSupermetricsConnection(conn)) throw new HttpError(404, "Not found", "not_found");
      replacesLoginId = conn.sourceLoginId;
      // The platform user whose access ended signs in again; a row whose credential is gone (its person left) lets anyone with access do it.
      requireUsername = conn.accessTokenEnc ? supermetricsCredential(conn).dsUser : null;
    }

    try {
      // The licence's data sources aren't listed by Supermetrics: asked once an hour, so nobody signs in for nothing.
      if (!(await supermetricsLicensed(deps.coord, cfg, provider))) {
        throw new HttpError(503, `bizinsights' Supermetrics plan doesn't include ${AD_PROVIDER_NAME[provider]} yet. It's on our side, not yours.`, "not_licensed");
      }
      const nonce = randomToken(24);
      const url = await startSupermetricsLink(deps.coord, cfg, nonce, { userId: user.id, workspaceId: ws, storeId, provider, replacesLoginId, requireUsername });
      setCookie(c, STATE_COOKIE, [nonce, ...pendingStates(getCookie(c, STATE_COOKIE))].slice(0, MAX_PENDING_STATES).join("."), cookieOpts());
      return c.json({ url });
    } catch (err) {
      throw startFailure(err, provider);
    }
  });

  /** Step 2: Supermetrics sends the browser back here once the person signed in to the platform. */
  app.get("/ads/supermetrics/callback", async (c) => {
    const appUrl = env().APP_URL;
    const q = c.req.query();
    const back = (params: Record<string, string>, storeId?: string) => c.redirect(`${appUrl}/settings/ads?${new URLSearchParams({ ...params, via: "supermetrics", ...(storeId ? { store: storeId } : {}) })}`);
    const toDashboard = (provider: AdProvider, accounts: number, storeId: string) =>
      c.redirect(`${appUrl}/dashboard?${new URLSearchParams({ adsConnected: provider, accounts: String(accounts), store: storeId, via: "supermetrics" })}`);
    const deadline = Date.now() + CALLBACK_DB_WAIT_MS;
    const db = <T>(step: () => Promise<T>) => waitingOutDb(deps, deadline, step);
    try {
      const pending = pendingStates(getCookie(c, STATE_COOKIE));
      const ours = !!q.state && pending.some((n) => safeEqual(n, q.state!));
      const rest = pending.filter((n) => n !== q.state);
      if (rest.length) setCookie(c, STATE_COOKIE, rest.join("."), cookieOpts());
      else deleteCookie(c, STATE_COOKIE, { path: "/" });
      if (!ours) return back({ error: "state_mismatch" });
      const state = await takeSupermetricsLinkState(deps.coord, q.state!);
      if (!state) return back({ error: "state_expired" });
      const provider = state.provider;
      const cfg = supermetricsConfig(deps.fetchImpl);
      if (!cfg) return back({ error: "not_configured", provider }, state.storeId);
      const user = await db(() => loadUser(c, deps));
      if (!user || user.id !== state.userId) return back({ error: "session_mismatch", provider }, state.storeId);

      let signIn: SupermetricsSignIn;
      try {
        signIn = await finishSupermetricsLink(cfg, provider, state.linkId);
      } catch (err) {
        if (err instanceof SupermetricsLinkUnusedError) return back({ error: "denied", provider }, state.storeId);
        if (err instanceof AdsNoAccountsError) return back({ error: "no_accounts", provider }, state.storeId);
        return back({ error: connectFailure(err, provider, state.storeId), provider }, state.storeId);
      }
      const { login, accounts } = signIn;
      /** End without a connection: the login goes back to the platform, unless a connection already reads with it. */
      const fail = async (error: string) => {
        await revokeSupermetricsLoginIfUnused(login.loginId, deps.fetchImpl);
        return back({ error, provider }, state.storeId);
      };
      try {
        if (!(await db(() => mayStillConnect(state.workspaceId, state.storeId, user.id)))) return await fail("not_allowed");
        const tokens = { accessToken: login.username, refreshToken: null, expiresAt: null };
        const known = await db(() => systemDb.adConnection.findMany({ where: { storeId: state.storeId, provider }, select: { accountId: true } }));
        const knownIds = new Set(known.map((k) => k.accountId));
        // One account, or a reconnect that sees nothing new: nothing to choose.
        if (!accounts.truncated && (accounts.length === 1 || accounts.every((a) => knownIds.has(a.accountId)))) {
          const saved = await db(() =>
            connectAccounts(deps, clientIp(c), { workspaceId: state.workspaceId, storeId: state.storeId, provider, accounts, tokens, userId: user.id, sourceLoginId: login.loginId }),
          );
          return toDashboard(provider, saved.length, state.storeId);
        }
        const pick = randomToken(24);
        await holdPendingAdConnect(deps.coord, pick, { userId: user.id, workspaceId: state.workspaceId, storeId: state.storeId, provider, accounts, tokens, sourceLoginId: login.loginId });
        return back({ choose: pick, provider }, state.storeId);
      } catch (err) {
        // Nothing was connected with the new login: it isn't left behind in bizinsights' Supermetrics team.
        await revokeSupermetricsLoginIfUnused(login.loginId, deps.fetchImpl);
        throw err;
      }
    } catch (err) {
      // A browser navigation: land on a page that says what happened, never on raw JSON.
      logger.error({ err, dbUnavailable: err instanceof DbUnavailable }, "supermetrics callback failed");
      return back({ error: "temporarily_unavailable" });
    }
  });
}
