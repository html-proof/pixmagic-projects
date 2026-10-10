import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb, withTenant } from "@app/db";
import {
  AD_PROVIDER_NAME,
  adsConfigured,
  adsenseAccounts,
  adsenseAuthorizeUrl,
  adsenseConfig,
  AdsApiError,
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
  holdPendingAdConnect,
  logger,
  metaAdAccounts,
  metaAuthorizeUrl,
  metaConfig,
  metaExchangeCode,
  metaGrantedPermissions,
  peekPendingAdConnect,
  pendingTokens,
  REQUIRED_AD_SCOPE,
  saveAdConnections,
  takePendingAdConnect,
  type AdAccount,
  type TokenSet,
} from "@app/core";
import { AD_PROVIDERS, randomToken, safeEqual, type AdProvider } from "@app/shared";
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

const cookieOpts = () => ({ path: "/", httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production", maxAge: STATE_TTL_S });

interface AdsState {
  userId: string;
  workspaceId: string;
  storeId: string;
  provider: AdProvider;
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
  input: { workspaceId: string; storeId: string; provider: AdProvider; accounts: AdAccount[]; tokens: TokenSet; userId: string },
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
    const state: AdsState = { userId: user.id, workspaceId: ws, storeId, provider };
    await deps.coord.put(`oauth:ads:${nonce}`, JSON.stringify(state), STATE_TTL_S);
    setCookie(c, STATE_COOKIE, nonce, cookieOpts());
    const redirectUri = adsRedirectUri(provider);
    const url =
      provider === "meta" ? metaAuthorizeUrl(meta!, redirectUri, nonce)
      : provider === "google" ? googleAuthorizeUrl(google!, redirectUri, nonce)
      : adsenseAuthorizeUrl(adsense!, redirectUri, nonce);
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

    try {
      const cookieState = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { path: "/" });
      if (!q.state || !cookieState || !safeEqual(cookieState, q.state)) return back({ error: "state_mismatch", provider });
      const raw = await deps.coord.take(`oauth:ads:${q.state}`);
      if (!raw) return back({ error: "state_expired", provider });
      const state = JSON.parse(raw) as AdsState;
      if (state.provider !== provider) return back({ error: "state_mismatch", provider }, state.storeId);
      // They pressed Cancel / "Not now" on the platform's screen.
      if (q.error || !q.code) return back({ error: q.error === "access_denied" || q.error_reason === "user_denied" ? "denied" : "missing_params", provider }, state.storeId);

      const user = await loadUser(c, deps);
      if (!user || user.id !== state.userId) return back({ error: "session_mismatch", provider }, state.storeId);

      const redirectUri = adsRedirectUri(provider);
      let tokens: TokenSet;
      let accounts: AdAccount[];
      // The person can untick the one permission on the platform's screen: then nothing can be read.
      const granted = (t: TokenSet) => !t.grantedScopes || t.grantedScopes.includes(REQUIRED_AD_SCOPE[provider]);
      try {
        if (provider === "meta") {
          const cfg = metaConfig(deps.fetchImpl)!;
          tokens = await metaExchangeCode(cfg, q.code, redirectUri);
          tokens.grantedScopes = await metaGrantedPermissions(cfg, tokens.accessToken);
          if (!granted(tokens)) return back({ error: "permission_missing", provider }, state.storeId);
          accounts = await metaAdAccounts(cfg, tokens.accessToken);
        } else if (provider === "google") {
          const cfg = googleConfig(deps.fetchImpl)!;
          tokens = await googleExchangeCode(cfg, q.code, redirectUri);
          if (!granted(tokens)) return back({ error: "permission_missing", provider }, state.storeId);
          if (!tokens.refreshToken) return back({ error: "no_refresh_token", provider }, state.storeId);
          accounts = await googleAdAccounts(cfg, tokens.accessToken);
        } else {
          const cfg = adsenseConfig(deps.fetchImpl)!;
          tokens = await googleExchangeCode(cfg, q.code, redirectUri);
          if (!granted(tokens)) return back({ error: "permission_missing", provider }, state.storeId);
          if (!tokens.refreshToken) return back({ error: "no_refresh_token", provider }, state.storeId);
          accounts = await adsenseAccounts(cfg, tokens.accessToken);
        }
      } catch (err) {
        // A Google login with no AdSense account: AdSense answers 403 rather than an empty list.
        if (provider === "adsense" && err instanceof AdsApiError && err.status === 403 && /adsense account/i.test(err.message)) {
          return back({ error: "no_accounts", provider }, state.storeId);
        }
        logger.error({ err, provider, storeId: state.storeId }, "ad platform connect failed");
        return back({ error: "exchange_failed", provider }, state.storeId);
      }
      if (!accounts.length) return back({ error: "no_accounts", provider }, state.storeId);

      // One account, or a reconnect that sees nothing new: there's nothing to choose.
      const known = await systemDb.adConnection.findMany({ where: { storeId: state.storeId, provider }, select: { accountId: true } });
      const knownIds = new Set(known.map((k) => k.accountId));
      if (accounts.length === 1 || accounts.every((a) => knownIds.has(a.accountId))) {
        const saved = await connectAccounts(deps, clientIp(c), { workspaceId: state.workspaceId, storeId: state.storeId, provider, accounts, tokens, userId: user.id });
        return toDashboard(provider, saved.length, state.storeId);
      }
      const pick = randomToken(24);
      await holdPendingAdConnect(deps.coord, pick, { userId: user.id, workspaceId: state.workspaceId, storeId: state.storeId, provider, accounts, tokens });
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
    const saved = await connectAccounts(deps, clientIp(c), { workspaceId: ws, storeId, provider: taken.provider, accounts: chosen, tokens: pendingTokens(taken), userId: access.user!.id });
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
    await audit({ workspaceId: ws, actorUserId: access.user?.id ?? null, action: enabled ? "ads.account_shown" : "ads.account_hidden", targetType: "ad_connection", targetId: conn.id, ip: clientIp(c) }).catch(() => {});
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
    await audit({
      workspaceId: ws,
      actorUserId: access.user?.id ?? null,
      action: "ads.disconnected",
      targetType: "store",
      targetId: storeId,
      metadata: { provider: conn.provider, accountId: conn.accountId },
      ip: clientIp(c),
    }).catch(() => {});
    return c.json({ ok: true });
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
