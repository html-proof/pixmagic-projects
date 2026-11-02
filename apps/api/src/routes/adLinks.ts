import { z } from "zod";
import { systemDb, withTenant } from "@app/db";
import {
  adsConfigured,
  audit,
  createAdConnectLink,
  currentAdConnectLink,
  dropUnusedGrant,
  env,
  logger,
  openAdConnectLink,
  peekPendingAdConnect,
  pendingTokens,
  revokeAdConnectLink,
  startAdSignIn,
  takePendingAdConnect,
  useUpAdConnectLink,
  type AdConnectLink,
} from "@app/core";
import { isAdAccountStatus, randomToken } from "@app/shared";
import { body, clientIp, HttpError, requireAppOrigin, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { connectAccounts, mayStillConnect, rememberSignIn, storeInWorkspace } from "./ads.js";

/**
 * Connect links (core's adConnections/links.ts): Meta ad accounts connected by someone with no
 * bizinsights login, such as the agency that runs a store's ads.
 *
 * - Settings → Advertising: whoever may manage the store's integrations makes the store's link (a new
 *   one replaces it), copies it again, or turns it off.
 * - The link's page (/connect/meta?t=…), for anyone holding the link: what it is for (the workspace's
 *   and the store's names only), "Continue with Meta Ads", and after Facebook, the choice of ad
 *   accounts. The token travels in request bodies, never in an API path. Starting a sign-in and
 *   finishing a choice are taken from bizinsights' own pages only (requireAppOrigin), as the sign-in's
 *   state cookie is set here and checked by the callback (routes/ads.ts finishLinkSignIn).
 */

const PROVIDER = "meta";

const tokenSchema = z.string().min(1).max(100);
/** A pending choice's nonce, as the callback put it in the link's address. */
const pickSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

const linkUrl = (token: string) => `${env().APP_URL}/connect/meta?${new URLSearchParams({ t: token })}`;

/** What the store's settings may see of its link: the link itself (it is theirs to send), when it ends, and who made it. */
async function publicLink(ws: string, held: { token: string; link: AdConnectLink }, viewerId: string | null) {
  const maker = await withTenant(ws, (tx) =>
    tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws, userId: held.link.createdBy } }, select: { user: { select: { displayName: true, email: true } } } }),
  );
  return {
    url: linkUrl(held.token),
    createdAt: held.link.createdAt,
    expiresAt: held.link.expiresAt,
    createdBy: maker ? { name: maker.user.displayName ?? maker.user.email, you: held.link.createdBy === viewerId } : null,
  };
}

/** The link a token opens, used or not, or the answer that there is none. */
async function openLink(deps: Deps, token: string): Promise<AdConnectLink> {
  const link = await openAdConnectLink(deps.coord, token);
  if (!link) throw new HttpError(404, "This link isn't valid any more. Ask whoever sent it for a new one.", "link_invalid");
  return link;
}

/** A link that can still connect: not used, and its maker still allowed to connect ad accounts to the store. */
async function usableLink(deps: Deps, token: string): Promise<AdConnectLink> {
  const link = await openLink(deps, token);
  if (link.usedAt) throw new HttpError(410, "This link has been used already. Ask whoever sent it for a new one if you need to connect more accounts.", "link_used");
  if (!(await mayStillConnect(link.workspaceId, link.storeId, link.createdBy))) throw new HttpError(410, "This link no longer works. Ask whoever sent it for a new one.", "link_ended");
  return link;
}

export function adLinkRoutes(app: App, deps: Deps) {
  /** The store's link, while it can be used; null when it has none. */
  app.get("/workspaces/:ws/stores/:storeId/ads/meta/link", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await storeInWorkspace(ws, storeId);
    const held = await currentAdConnectLink(deps.coord, storeId, PROVIDER);
    return c.json({ link: held && held.link.workspaceId === ws ? await publicLink(ws, held, access.user?.id ?? null) : null });
  });

  /** Make the store's link, ending the one it had. */
  app.post("/workspaces/:ws/stores/:storeId/ads/meta/link", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const user = access.user!;
    if (!user.emailVerified) throw new HttpError(403, "Verify your email first", "email_unverified");
    await storeInWorkspace(ws, storeId);
    if (!adsConfigured().meta) throw new HttpError(503, "Meta Ads isn't set up on this server yet.", "not_configured");
    await limit(deps.coord, `rl:ads-link:${user.id}`, LIMITS.adsConnect, "That's a lot of new links in a short time. Wait a few minutes and try again.");
    const held = await createAdConnectLink(deps.coord, { workspaceId: ws, storeId, provider: PROVIDER, userId: user.id });
    await audit({ workspaceId: ws, actorUserId: user.id, action: "ads.link_created", targetType: "store", targetId: storeId, metadata: { provider: PROVIDER, expiresAt: held.link.expiresAt }, ip: clientIp(c) }).catch(
      (err: unknown) => logger.warn({ err }, "audit failed"),
    );
    return c.json({ link: await publicLink(ws, held, user.id) });
  });

  /** Turn the store's link off: whoever holds it can no longer use it. */
  app.delete("/workspaces/:ws/stores/:storeId/ads/meta/link", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await storeInWorkspace(ws, storeId);
    const had = await revokeAdConnectLink(deps.coord, storeId, PROVIDER);
    if (had) {
      await audit({ workspaceId: ws, actorUserId: access.user?.id ?? null, action: "ads.link_revoked", targetType: "store", targetId: storeId, metadata: { provider: PROVIDER }, ip: clientIp(c) }).catch(
        (err: unknown) => logger.warn({ err }, "audit failed"),
      );
    }
    return c.json({ ok: true });
  });

  /**
   * The link's page opening: what the link is for, whether it can still be used, and (with `pick`,
   * after Facebook) the ad accounts to choose from. Nothing about the workspace beyond its name and the
   * store's.
   */
  app.post("/ads/links/open", async (c) => {
    await limit(deps.coord, `rl:ads-link-open:${clientIp(c)}`, LIMITS.adsLinkIp);
    const { token, pick } = z.object({ token: tokenSchema, pick: pickSchema.optional() }).parse(await body(c));
    const link = await openLink(deps, token);
    const store = await systemDb.store.findFirst({
      where: { id: link.storeId, workspaceId: link.workspaceId },
      select: { name: true, shopDomain: true, status: true, workspace: { select: { name: true } } },
    });
    if (!store || store.status === "uninstalled") throw new HttpError(404, "This link isn't valid any more. Ask whoever sent it for a new one.", "link_invalid");
    const usable = !link.usedAt && (await mayStillConnect(link.workspaceId, link.storeId, link.createdBy));
    const pending = pick && usable ? await peekPendingAdConnect(deps.coord, pick) : null;
    const mine = pending && pending.link === link.id ? pending : null;
    const known = mine ? await systemDb.adConnection.findMany({ where: { storeId: link.storeId, provider: mine.provider }, select: { accountId: true } }) : [];
    const connected = new Set(known.map((k) => k.accountId));
    return c.json({
      provider: link.provider,
      workspace: store.workspace.name,
      store: store.name ?? store.shopDomain,
      expiresAt: link.expiresAt,
      state: link.usedAt ? "used" : usable ? "open" : "ended",
      accounts: link.accounts ?? null,
      configured: adsConfigured().meta,
      // Asked for and gone (15 minutes, or finished): null, and the page offers the sign-in again.
      choice: mine
        ? {
            provider: mine.provider,
            expiresAt: new Date(mine.expiresAt).toISOString(),
            truncated: !!mine.truncated,
            accounts: mine.accounts.map((a) => ({
              accountId: a.accountId,
              name: a.name,
              currency: a.currency,
              timezone: a.timezone,
              connected: connected.has(a.accountId),
              enabled: null,
              status: isAdAccountStatus(a.status) ? a.status : null,
              statusDetail: a.statusDetail ?? null,
            })),
          }
        : null,
    });
  });

  /** "Continue with Meta Ads" on the link's page: where to send the browser. */
  app.post("/ads/links/start", async (c) => {
    requireAppOrigin(c);
    await limit(deps.coord, `rl:ads-link-open:${clientIp(c)}`, LIMITS.adsLinkIp);
    const { token } = z.object({ token: tokenSchema }).parse(await body(c));
    const link = await usableLink(deps, token);
    if (!adsConfigured().meta) throw new HttpError(503, "Meta Ads isn't set up on this server yet.", "not_configured");
    // Each sign-in writes a coordinator item, and its callback lists the login's accounts against Meta's quota.
    await limit(deps.coord, `rl:ads-connect:link:${link.id}`, LIMITS.adsConnect, "That's a lot of sign-ins in a short time. Wait a few minutes and try again.");
    const nonce = randomToken(24);
    const url = await startAdSignIn(deps.coord, nonce, { userId: link.createdBy, workspaceId: link.workspaceId, storeId: link.storeId, provider: link.provider, link: link.id, linkToken: token });
    if (!url) throw new HttpError(503, "Meta Ads isn't set up on this server yet.", "not_configured");
    rememberSignIn(c, nonce);
    return c.json({ url });
  });

  /** Connect the accounts ticked on the link's page. It uses the link up. */
  app.post("/ads/links/choose", async (c) => {
    requireAppOrigin(c);
    await limit(deps.coord, `rl:ads-link-open:${clientIp(c)}`, LIMITS.adsLinkIp);
    const input = z.object({ token: tokenSchema, pick: pickSchema, accountIds: z.array(z.string().min(1).max(64)).min(1).max(10_000) }).parse(await body(c));
    const link = await usableLink(deps, input.token);
    const p = await peekPendingAdConnect(deps.coord, input.pick);
    if (!p || p.link !== link.id || p.storeId !== link.storeId) throw new HttpError(404, "That choice has expired. Press Continue with Meta Ads to sign in again.", "pending_expired");
    const wanted = new Set(input.accountIds);
    const chosen = p.accounts.filter((a) => wanted.has(a.accountId));
    if (chosen.length !== wanted.size) throw new HttpError(400, "Choose from the accounts listed.", "invalid_accounts");
    // Used up only now, so a bad request doesn't cost the person their sign-in.
    const taken = await takePendingAdConnect(deps.coord, input.pick);
    if (!taken) throw new HttpError(404, "That choice has expired. Press Continue with Meta Ads to sign in again.", "pending_expired");
    const saved = await connectAccounts(deps, clientIp(c), {
      workspaceId: link.workspaceId,
      storeId: link.storeId,
      provider: taken.provider,
      accounts: chosen,
      tokens: pendingTokens(taken),
      userId: null,
      linkSentBy: link.createdBy,
      externalUserId: taken.externalUserId ?? null,
    });
    await useUpAdConnectLink(deps.coord, link, saved.length);
    logger.info({ provider: taken.provider, storeId: link.storeId, accounts: saved.length }, "ads: connected through a connect link");
    return c.json({ connected: saved.length });
  });

  /** "Cancel" on the link's page: nothing is connected, and the sign-in's grant goes back to Meta unless something relies on it. */
  app.post("/ads/links/cancel", async (c) => {
    requireAppOrigin(c);
    await limit(deps.coord, `rl:ads-link-open:${clientIp(c)}`, LIMITS.adsLinkIp);
    const { token, pick } = z.object({ token: tokenSchema, pick: pickSchema }).parse(await body(c));
    const link = await openLink(deps, token);
    const p = await peekPendingAdConnect(deps.coord, pick);
    if (p && p.link === link.id) {
      const taken = await takePendingAdConnect(deps.coord, pick);
      if (taken) await dropUnusedGrant(taken.provider, pendingTokens(taken), taken.externalUserId, deps.fetchImpl, { coord: deps.coord, exceptPending: pick, reusedRefreshToken: !!taken.reusedRefreshToken });
    }
    return c.json({ ok: true });
  });
}
