import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { dbReachable, systemDb, withTenant } from "@app/db";
import {
  AD_PROVIDER_NAME,
  adsConfigured,
  adsenseAccounts,
  adsenseAuthorizeUrl,
  adsenseConfig,
  AdsApiError,
  AdsAuthError,
  AdsNotApprovedError,
  AdsRetryableError,
  adToday,
  adsRedirectUri,
  ADS_BACKFILL_DAYS,
  ADS_RECHECK_DAYS,
  audit,
  enqueueAdSync,
  env,
  googleAdAccounts,
  googleAuthorizeUrl,
  googleConfig,
  googleExchangeCode,
  googleReportForConnection,
  googleUserId,
  holdPendingAdConnect,
  logger,
  metaAdAccounts,
  metaAuthorizeUrl,
  metaConfig,
  metaExchangeCode,
  metaGrantedPermissions,
  metaReportForConnection,
  metaUserId,
  peekPendingAdConnect,
  pendingTokens,
  REQUIRED_AD_SCOPE,
  reusableRefreshToken,
  revokeAdAccessIfUnused,
  saveAdConnections,
  takePendingAdConnect,
  type AdAccount,
  type GoogleReport,
  type MetaReport,
  type TokenSet,
} from "@app/core";
import {
  AD_PROVIDERS,
  daysBetweenInclusive,
  GOOGLE_REPORT_LEVELS,
  isDay,
  MAX_CUSTOM_DAYS,
  META_REPORT_VIEWS,
  pkcePair,
  randomToken,
  safeEqual,
  type AdProvider,
} from "@app/shared";
import { body, clientIp, HttpError, loadUser, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * "Continue with Meta" / "Continue with Google Ads": connect a store's ad accounts, read-only, so
 * the dashboard can show what's spent on ads next to what the store sells. "Continue with Google
 * AdSense" connects the other direction: what the store's site earns from ads shown on it.
 *
 * The OAuth round trip mirrors the Shopify connect: single-use state in the coordinator, bound
 * to this browser by a cookie, and the callback only accepted for the person who started it.
 * When the sign-in can see several accounts (and some are new), the person chooses which to
 * connect on the integrations page; the sign-in's tokens wait, encrypted, in the coordinator.
 * A finished connection lands on the dashboard, where the numbers are.
 */

const STATE_TTL_S = 600;
const STATE_COOKIE = "ads_oauth_state";
/**
 * The sign-ins this browser started that haven't come back yet, newest first. A second press of the
 * button (or a second tab) mustn't void the first: the platform may still send the person back with
 * the first one's state. Each is still single-use and bound to this browser.
 */
const MAX_PENDING_STATES = 5;
const pendingStates = (cookie: string | undefined) => (cookie ?? "").split(".").filter((n) => /^[A-Za-z0-9_-]{16,64}$/.test(n));

const cookieOpts = () => ({ path: "/", httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production", maxAge: STATE_TTL_S });

interface AdsState {
  userId: string;
  workspaceId: string;
  storeId: string;
  provider: AdProvider;
  /** PKCE verifier (Google): kept here on the server; only its challenge went to the browser. */
  codeVerifier?: string;
}

const providerSchema = z.enum(AD_PROVIDERS);

/** What the browser may see of a connection: never a token. */
function publicConnection(c: {
  id: string;
  provider: string;
  accountId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastSyncedAt: Date | null;
  accessTokenExpiresAt: Date | null;
  grantedScopes?: string[];
  createdAt: Date;
}) {
  return {
    id: c.id,
    provider: c.provider,
    accountId: c.accountId,
    accountName: c.accountName,
    currency: c.currency,
    timezone: c.timezone,
    enabled: c.enabled,
    status: c.status,
    lastError: c.lastError,
    lastSyncedAt: c.lastSyncedAt,
    // Meta access lasts about 60 days; Settings warns before it runs out. Google's renews itself.
    accessExpiresAt: c.provider === "meta" ? c.accessTokenExpiresAt : null,
    connectedAt: c.createdAt,
    /** The one read-only permission this connection was granted (checked when connecting). */
    permission: REQUIRED_AD_SCOPE[c.provider as AdProvider] ?? null,
    /** Every permission that was granted, when the platform said. */
    grantedScopes: c.grantedScopes ?? [],
  };
}

async function storeInWorkspace(ws: string, storeId: string) {
  const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true, status: true } }));
  if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
  return store;
}

/** Save the chosen accounts, fetch their history, and record who connected them. */
async function connectAccounts(
  deps: Deps,
  ip: string | undefined,
  input: { workspaceId: string; storeId: string; provider: AdProvider; accounts: AdAccount[]; tokens: TokenSet; userId: string; externalUserId?: string | null },
) {
  const saved = await saveAdConnections(input);
  // New accounts fetch their history; ones connected before just catch up on the re-check window.
  for (const conn of saved) {
    if (conn.enabled) await enqueueAdSync(deps.queues, conn, conn.isNew ? ADS_BACKFILL_DAYS : ADS_RECHECK_DAYS);
  }
  await audit({
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
    action: "ads.connected",
    targetType: "store",
    targetId: input.storeId,
    metadata: { provider: input.provider, accounts: saved.length },
    ip,
  }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
  return saved;
}

/** A pending choice that belongs to this person, workspace and store, or a 404 that says it's gone. */
async function ownPending(deps: Deps, nonce: string, userId: string | undefined, ws: string, storeId: string) {
  const p = await peekPendingAdConnect(deps.coord, nonce);
  if (!p || !userId || p.userId !== userId || p.workspaceId !== ws || p.storeId !== storeId) {
    throw new HttpError(404, "That choice has expired. Press the button to connect again.", "pending_expired");
  }
  return p;
}

/**
 * How long a callback waits for the database before giving up on it. Production's Postgres is reached
 * through a tunnel that drops for 10-20 seconds at a time, and the person has just been through the
 * platform's sign-in, which is not theirs to repeat because of us.
 */
const CALLBACK_DB_WAIT_MS = 20_000;
const DB_POLL_MS = 1_000;

/** The database didn't answer before the callback's deadline. `cause` is the step's own error. */
class DbUnavailable extends Error {}

/**
 * Run one database step of the callback, waiting out an outage: when the step fails and the database
 * doesn't answer, wait for it to answer again (until `deadline`) and run the step again. A failure while
 * the database answers is the step's own, and is thrown as it is.
 */
async function waitingOutDb<T>(deps: Deps, deadline: number, step: () => Promise<T>): Promise<T> {
  const answers = deps.dbHealthy ?? (() => dbReachable());
  for (;;) {
    try {
      return await step();
    } catch (err) {
      if (await answers()) throw err;
      do {
        if (Date.now() + DB_POLL_MS > deadline) throw new DbUnavailable("database unreachable", { cause: err });
        await new Promise((r) => setTimeout(r, DB_POLL_MS));
      } while (!(await answers()));
    }
  }
}

export function adsRoutes(app: App, deps: Deps) {
  /** Connected ad accounts for a store, and which platforms this server can connect at all. */
  app.get("/workspaces/:ws/stores/:storeId/ads", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    await storeInWorkspace(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.adConnection.findMany({ where: { workspaceId: ws, storeId }, orderBy: [{ provider: "asc" }, { createdAt: "asc" }] }));
    return c.json({ configured: adsConfigured(), connections: rows.map(publicConnection) });
  });

  /** Step 1: where to send the browser to approve read access to ads. */
  app.post("/workspaces/:ws/stores/:storeId/ads/:provider/connect", async (c) => {
    const { ws, storeId } = c.req.param();
    const provider = providerSchema.parse(c.req.param("provider"));
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const user = access.user!;
    if (!user.emailVerified) throw new HttpError(403, "Verify your email first", "email_unverified");
    await storeInWorkspace(ws, storeId);
    const meta = metaConfig();
    const google = googleConfig();
    const adsense = adsenseConfig();
    if ((provider === "meta" && !meta) || (provider === "google" && !google) || (provider === "adsense" && !adsense)) {
      throw new HttpError(503, `${AD_PROVIDER_NAME[provider]} isn't set up on this server yet.`, "not_configured");
    }
    const nonce = randomToken(24);
    // Google takes PKCE on top of the client secret: a code intercepted on its way back is useless without the verifier.
    const pkce = provider === "meta" ? null : pkcePair();
    const state: AdsState = { userId: user.id, workspaceId: ws, storeId, provider, ...(pkce ? { codeVerifier: pkce.verifier } : {}) };
    await deps.coord.put(`oauth:ads:${nonce}`, JSON.stringify(state), STATE_TTL_S);
    setCookie(c, STATE_COOKIE, [nonce, ...pendingStates(getCookie(c, STATE_COOKIE))].slice(0, MAX_PENDING_STATES).join("."), cookieOpts());
    const redirectUri = adsRedirectUri(provider);
    const url =
      provider === "meta" ? metaAuthorizeUrl(meta!, redirectUri, nonce)
      : provider === "google" ? googleAuthorizeUrl(google!, redirectUri, nonce, pkce!.challenge)
      : adsenseAuthorizeUrl(adsense!, redirectUri, nonce, pkce!.challenge);
    return c.json({ url });
  });

  /** Step 2: the platform sends the browser back here with a code (or with the person's "no"). */
  app.get("/ads/:provider/callback", async (c) => {
    const appUrl = env().APP_URL;
    const parsed = providerSchema.safeParse(c.req.param("provider"));
    // Problems and the account choice stay on the integrations page; success goes to the numbers.
    const back = (params: Record<string, string>, storeId?: string) =>
      c.redirect(`${appUrl}/settings/ads?${new URLSearchParams({ ...params, ...(storeId ? { store: storeId } : {}) })}`);
    const toDashboard = (provider: AdProvider, accounts: number, storeId: string) =>
      c.redirect(`${appUrl}/dashboard?${new URLSearchParams({ adsConnected: provider, accounts: String(accounts), store: storeId })}`);
    if (!parsed.success) return back({ error: "unknown_provider" });
    const provider = parsed.data;
    const q = c.req.query();
    const deadline = Date.now() + CALLBACK_DB_WAIT_MS;
    const db = <T>(step: () => Promise<T>) => waitingOutDb(deps, deadline, step);

    try {
      const pending = pendingStates(getCookie(c, STATE_COOKIE));
      const ours = !!q.state && pending.some((n) => safeEqual(n, q.state!));
      // This one is used up either way; the others this browser started stay usable.
      const rest = pending.filter((n) => n !== q.state);
      if (rest.length) setCookie(c, STATE_COOKIE, rest.join("."), cookieOpts());
      else deleteCookie(c, STATE_COOKIE, { path: "/" });
      if (!ours) return back({ error: "state_mismatch", provider });
      const raw = await deps.coord.take(`oauth:ads:${q.state}`);
      if (!raw) return back({ error: "state_expired", provider });
      const state = JSON.parse(raw) as AdsState;
      if (state.provider !== provider) return back({ error: "state_mismatch", provider }, state.storeId);
      // They pressed Cancel / "Not now" on the platform's screen.
      if (q.error || !q.code) return back({ error: q.error === "access_denied" || q.error_reason === "user_denied" ? "denied" : "missing_params", provider }, state.storeId);

      // Still no database at the deadline: go on with the sign-in and hold it for the person (below).
      // Then the check that they are who started it happens when they finish (ownPending).
      const user = await db(() => loadUser(c, deps)).catch((err: unknown) => {
        if (err instanceof DbUnavailable) return undefined;
        throw err;
      });
      if (user === null || (user && user.id !== state.userId)) return back({ error: "session_mismatch", provider }, state.storeId);

      const redirectUri = adsRedirectUri(provider);
      let tokens: TokenSet;
      let accounts: AdAccount[];
      let externalUserId: string | null = null;
      // The person can untick the one permission on the platform's screen: then nothing can be read.
      const granted = (t: TokenSet) => !t.grantedScopes || t.grantedScopes.includes(REQUIRED_AD_SCOPE[provider]);
      // Who signed in, so a later disconnect knows whether anything else still relies on their grant. Never blocks a connect.
      const whoIs = (p: Promise<string | null>) =>
        p.catch((err: unknown) => {
          logger.warn({ err, provider }, "ad platform user id lookup failed");
          return null;
        });
      try {
        if (provider === "meta") {
          const cfg = metaConfig(deps.fetchImpl)!;
          tokens = await metaExchangeCode(cfg, q.code, redirectUri);
          // A Login for Business system-user token may not answer /me/permissions; then the account list below is the test.
          tokens.grantedScopes = await metaGrantedPermissions(cfg, tokens.accessToken).catch((err: unknown) => {
            if (err instanceof AdsApiError) return undefined;
            throw err;
          });
          if (!granted(tokens)) return back({ error: "permission_missing", provider }, state.storeId);
          externalUserId = await whoIs(metaUserId(cfg, tokens.accessToken));
          accounts = await metaAdAccounts(cfg, tokens.accessToken);
        } else {
          const google = provider === "google" ? googleConfig(deps.fetchImpl)! : null;
          const cfg = google ?? adsenseConfig(deps.fetchImpl)!;
          tokens = await googleExchangeCode(cfg, q.code, redirectUri, state.codeVerifier);
          if (!granted(tokens)) return back({ error: "permission_missing", provider }, state.storeId);
          externalUserId = await whoIs(googleUserId(cfg, tokens.accessToken));
          // Google sends a refresh token on first consent; a person who gave one before keeps using theirs.
          if (!tokens.refreshToken) tokens.refreshToken = await db(() => reusableRefreshToken(provider, externalUserId));
          if (!tokens.refreshToken) return back({ error: "no_refresh_token", provider }, state.storeId);
          accounts = google ? await googleAdAccounts(google, tokens.accessToken) : await adsenseAccounts(cfg, tokens.accessToken);
        }
      } catch (err) {
        // Ours, not the platform's.
        if (err instanceof DbUnavailable) throw err;
        // Insights' Google Cloud project isn't approved for real Google Ads accounts yet: say so, don't blame the account.
        if (err instanceof AdsNotApprovedError) {
          logger.warn({ err, provider, storeId: state.storeId }, "google ads: project not approved for production accounts");
          return back({ error: "not_approved", provider }, state.storeId);
        }
        // A Google login with no AdSense account: AdSense answers 403 rather than an empty list.
        if (provider === "adsense" && err instanceof AdsApiError && err.status === 403 && /adsense account/i.test(err.message)) {
          return back({ error: "no_accounts", provider }, state.storeId);
        }
        logger.error({ err, provider, storeId: state.storeId }, "ad platform connect failed");
        return back({ error: "exchange_failed", provider }, state.storeId);
      }
      if (!accounts.length) return back({ error: "no_accounts", provider }, state.storeId);

      // One account, or a reconnect that sees nothing new: there's nothing to choose.
      // With the database still out of reach, the sign-in waits for the person in the coordinator
      // (which doesn't need it), and they finish on the integrations page once it answers.
      let dbDown = !user;
      if (user) {
        try {
          const known = await db(() => systemDb.adConnection.findMany({ where: { storeId: state.storeId, provider }, select: { accountId: true } }));
          const knownIds = new Set(known.map((k) => k.accountId));
          if (accounts.length === 1 || accounts.every((a) => knownIds.has(a.accountId))) {
            const saved = await db(() => connectAccounts(deps, clientIp(c), { workspaceId: state.workspaceId, storeId: state.storeId, provider, accounts, tokens, userId: user.id, externalUserId }));
            return toDashboard(provider, saved.length, state.storeId);
          }
        } catch (err) {
          if (!(err instanceof DbUnavailable)) throw err;
          dbDown = true;
        }
      }
      if (dbDown) logger.warn({ provider, storeId: state.storeId }, "database unreachable after an ad platform sign-in; holding it for the person to finish");
      const pick = randomToken(24);
      await holdPendingAdConnect(deps.coord, pick, { userId: state.userId, workspaceId: state.workspaceId, storeId: state.storeId, provider, accounts, tokens, externalUserId });
      return back({ choose: pick, provider }, state.storeId);
    } catch (err) {
      // A browser navigation: land on a page that says what happened, never on raw JSON.
      logger.error({ err, provider }, "ads callback failed");
      return back({ error: "temporarily_unavailable", provider });
    }
  });

  /** The accounts a sign-in can see, while the person chooses which to connect. No tokens. */
  app.get("/workspaces/:ws/stores/:storeId/ads/pending/:nonce", async (c) => {
    const { ws, storeId, nonce } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await storeInWorkspace(ws, storeId);
    const p = await ownPending(deps, nonce, access.user?.id, ws, storeId);
    const known = await withTenant(ws, (tx) => tx.adConnection.findMany({ where: { workspaceId: ws, storeId, provider: p.provider }, select: { accountId: true } }));
    const knownIds = new Set(known.map((k) => k.accountId));
    return c.json({
      provider: p.provider,
      expiresAt: new Date(p.expiresAt).toISOString(),
      accounts: p.accounts.map((a) => ({ accountId: a.accountId, name: a.name, currency: a.currency, timezone: a.timezone, connected: knownIds.has(a.accountId) })),
    });
  });

  /** Connect the accounts the person ticked. A choice can be used once. */
  app.post("/workspaces/:ws/stores/:storeId/ads/pending/:nonce", async (c) => {
    const { ws, storeId, nonce } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await storeInWorkspace(ws, storeId);
    // Bounded by the accounts the sign-in listed (checked below), not by a small number: agency logins see thousands.
    const { accountIds } = z.object({ accountIds: z.array(z.string().min(1).max(64)).min(1).max(10_000) }).parse(await body(c));
    const p = await ownPending(deps, nonce, access.user?.id, ws, storeId);
    const wanted = new Set(accountIds);
    const chosen = p.accounts.filter((a) => wanted.has(a.accountId));
    if (chosen.length !== wanted.size) throw new HttpError(400, "Choose from the accounts listed.", "invalid_accounts");
    // Used up only now, so a bad request doesn't cost the person their sign-in.
    const taken = await takePendingAdConnect(deps.coord, nonce);
    if (!taken) throw new HttpError(404, "That choice has expired. Press the button to connect again.", "pending_expired");
    // The choice is about what shows on this store's dashboard: a ticked account that was hidden
    // comes back, and an already-connected one left unticked is hidden (not deleted).
    const scope = { workspaceId: ws, storeId, provider: taken.provider };
    const unticked = taken.accounts.map((a) => a.accountId).filter((id) => !wanted.has(id));
    await systemDb.adConnection.updateMany({ where: { ...scope, accountId: { in: [...wanted] }, enabled: false }, data: { enabled: true } });
    if (unticked.length) await systemDb.adConnection.updateMany({ where: { ...scope, accountId: { in: unticked } }, data: { enabled: false } });
    const saved = await connectAccounts(deps, clientIp(c), {
      workspaceId: ws,
      storeId,
      provider: taken.provider,
      accounts: chosen,
      tokens: pendingTokens(taken),
      userId: access.user!.id,
      externalUserId: taken.externalUserId ?? null,
    });
    return c.json({ provider: taken.provider, connected: saved.length });
  });

  /** "Cancel" on the choice: the sign-in's tokens are dropped and nothing is connected. */
  app.delete("/workspaces/:ws/stores/:storeId/ads/pending/:nonce", async (c) => {
    const { ws, storeId, nonce } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await ownPending(deps, nonce, access.user?.id, ws, storeId);
    await takePendingAdConnect(deps.coord, nonce);
    return c.json({ ok: true });
  });

  /** Show an account on the dashboard (and keep syncing it), or not. */
  app.patch("/workspaces/:ws/stores/:storeId/ads/connections/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await body(c));
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    const updated = await systemDb.adConnection.update({ where: { id: conn.id }, data: { enabled } });
    if (enabled && !conn.enabled) await enqueueAdSync(deps.queues, updated, ADS_RECHECK_DAYS);
    await audit({ workspaceId: ws, actorUserId: access.user?.id ?? null, action: enabled ? "ads.account_shown" : "ads.account_hidden", targetType: "ad_connection", targetId: conn.id, ip: clientIp(c) }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
    return c.json({ connection: publicConnection(updated) });
  });

  /** Disconnect one ad account: its token and every number fetched for it are deleted. */
  app.delete("/workspaces/:ws/stores/:storeId/ads/connections/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    await systemDb.$transaction([
      systemDb.adCampaignDaily.deleteMany({ where: { connectionId: conn.id } }),
      systemDb.adsenseDaily.deleteMany({ where: { connectionId: conn.id } }),
      systemDb.adConnection.delete({ where: { id: conn.id } }),
    ]);
    // Insights' copy is gone; now the platform access too, unless another connection relies on it.
    const revoked = await revokeAdAccessIfUnused(conn, deps.fetchImpl);
    await audit({
      workspaceId: ws,
      actorUserId: access.user?.id ?? null,
      action: "ads.disconnected",
      targetType: "store",
      targetId: storeId,
      metadata: { provider: conn.provider, accountId: conn.accountId, revoked },
      ip: clientIp(c),
    }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
    return c.json({ ok: true, revoked });
  });

  /**
   * The Meta Ads report for one connected account and range: campaigns, ad sets or ads with reach,
   * frequency, link clicks, purchases and their value, asked of Meta for exactly those dates.
   * Read-only, and cached briefly so the dashboard's polling doesn't spend Meta's rate limit.
   */
  app.get("/workspaces/:ws/stores/:storeId/ads/meta/report", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "dashboard:read");
    await storeInWorkspace(ws, storeId);
    const q = z
      .object({
        connection: z.string().min(1).max(64),
        level: z.enum(META_REPORT_VIEWS).default("campaign"),
        from: z.string().refine(isDay, "must be a YYYY-MM-DD day"),
        to: z.string().refine(isDay, "must be a YYYY-MM-DD day"),
      })
      .refine((v) => v.from <= v.to, "from is after to")
      // Meta keeps 37 months of insights; a year at a time is what the dashboard asks for.
      .refine((v) => daysBetweenInclusive(v.from, v.to) <= MAX_CUSTOM_DAYS, "Pick up to a year at a time")
      .parse(c.req.query());
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id: q.connection, workspaceId: ws, storeId, provider: "meta" } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    if (conn.status === "reconnect") throw new HttpError(409, "Meta access for this ad account has ended. Reconnect it in Settings → Advertising.", "reconnect");
    const account = { id: conn.id, accountId: conn.accountId, name: conn.accountName, currency: conn.currency, timezone: conn.timezone };
    const today = adToday(conn);
    const key = `ads-report:${conn.id}:${q.level}:${q.from}:${q.to}`;
    const cached = await deps.coord.peek(key);
    if (cached) return c.json({ account, today, cached: true, report: JSON.parse(cached) as MetaReport });
    await limit(deps.coord, `rl:ads-report:${storeId}:${access.user?.id ?? clientIp(c)}`, LIMITS.adsReport);
    let report: MetaReport;
    try {
      report = await metaReportForConnection(conn, q.level, q.from, q.to, deps.fetchImpl);
    } catch (err) {
      if (err instanceof AdsAuthError) throw new HttpError(409, "Meta access for this ad account has ended. Reconnect it in Settings → Advertising.", "reconnect");
      if (err instanceof AdsRetryableError) throw new HttpError(503, "Meta is busy right now. Try again in a minute.", "meta_busy");
      if (err instanceof AdsApiError) {
        logger.warn({ err, connectionId: conn.id }, "meta report failed");
        throw new HttpError(502, `Meta didn't return the report: ${err.message}`, "meta_error");
      }
      throw err;
    }
    // Days that are over change little (Meta still revises purchases for a while); today's keep coming in.
    await deps.coord.put(key, JSON.stringify(report), q.to >= today ? 600 : 3600);
    return c.json({ account, today, cached: false, report });
  });

  /**
   * The Google Ads report for one connected account and range: campaigns (with status, type and
   * daily budget), ad groups, devices or countries, asked of Google for exactly those dates.
   * Read-only, and cached briefly so the dashboard's polling doesn't spend Google's quota.
   */
  app.get("/workspaces/:ws/stores/:storeId/ads/google/report", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "dashboard:read");
    await storeInWorkspace(ws, storeId);
    const q = z
      .object({
        connection: z.string().min(1).max(64),
        level: z.enum(GOOGLE_REPORT_LEVELS).default("campaign"),
        from: z.string().refine(isDay, "must be a YYYY-MM-DD day"),
        to: z.string().refine(isDay, "must be a YYYY-MM-DD day"),
      })
      .refine((v) => v.from <= v.to, "from is after to")
      .refine((v) => daysBetweenInclusive(v.from, v.to) <= MAX_CUSTOM_DAYS, "Pick up to a year at a time")
      .parse(c.req.query());
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id: q.connection, workspaceId: ws, storeId, provider: "google" } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    const ended = "Google Ads access for this account has ended. Reconnect it in Settings → Advertising.";
    if (conn.status === "reconnect") throw new HttpError(409, ended, "reconnect");
    const account = { id: conn.id, accountId: conn.accountId, name: conn.accountName, currency: conn.currency, timezone: conn.timezone };
    const today = adToday(conn);
    const key = `ads-greport:${conn.id}:${q.level}:${q.from}:${q.to}`;
    const cached = await deps.coord.peek(key);
    if (cached) return c.json({ account, today, cached: true, report: JSON.parse(cached) as GoogleReport });
    await limit(deps.coord, `rl:ads-report:${storeId}:${access.user?.id ?? clientIp(c)}`, LIMITS.adsReport);
    let report: GoogleReport;
    try {
      report = await googleReportForConnection(conn, q.level, q.from, q.to, deps.fetchImpl);
    } catch (err) {
      if (err instanceof AdsAuthError) throw new HttpError(409, ended, "reconnect");
      if (err instanceof AdsNotApprovedError) throw new HttpError(503, "Google is still approving Insights for live Google Ads accounts. The report will work once that's done.", "google_not_approved");
      if (err instanceof AdsRetryableError) throw new HttpError(503, "Google Ads is busy right now. Try again in a minute.", "google_busy");
      if (err instanceof AdsApiError) {
        logger.warn({ err, connectionId: conn.id }, "google ads report failed");
        throw new HttpError(502, `Google Ads didn't return the report: ${err.message}`, "google_error");
      }
      throw err;
    }
    // Google finishes most of a day's numbers within about three hours, and still revises conversions after.
    await deps.coord.put(key, JSON.stringify(report), q.to >= today ? 600 : 3600);
    return c.json({ account, today, cached: false, report });
  });

  /** "Sync now" / "Refresh": fetch the last 30 days of every shown account, or one platform's. */
  app.post("/workspaces/:ws/stores/:storeId/ads/sync", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const { provider } = z.object({ provider: providerSchema.optional() }).parse(await body(c));
    await limit(deps.coord, `rl:ads-sync:${storeId}:${access.user?.id ?? clientIp(c)}`, LIMITS.adsSync);
    await storeInWorkspace(ws, storeId);
    const conns = await withTenant(ws, (tx) =>
      tx.adConnection.findMany({ where: { workspaceId: ws, storeId, enabled: true, status: { not: "reconnect" }, ...(provider ? { provider } : {}) } }),
    );
    for (const conn of conns) await enqueueAdSync(deps.queues, conn, ADS_RECHECK_DAYS);
    return c.json({ queued: conns.length });
  });
}
