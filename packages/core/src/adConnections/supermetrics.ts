/**
 * Connecting ad accounts through Supermetrics (docs/supermetrics.md): the login link a merchant signs in
 * through, what the login reaches once they have, and giving the login back to the platform once no
 * connection reads with it. The Supermetrics API itself is ads/supermetrics.ts; the routes are
 * apps/api/src/routes/adsSupermetrics.ts.
 *
 * A login made through a link belongs to bizinsights' Supermetrics team, so bizinsights is answerable
 * for it: it is revoked at Supermetrics when the merchant disconnects the last account that uses it, when
 * the person who connected it leaves, when the store's data is erased, and when a sign-in ends without a
 * connection.
 */
import { systemDb } from "@app/db";
import type { AdProvider } from "@app/shared";
import {
  AdsApiError,
  AdsNoAccountsError,
  SUPERMETRICS_DS,
  supermetricsCloseLoginLink,
  supermetricsCreateLoginLink,
  supermetricsLogin,
  supermetricsLoginAccounts,
  supermetricsLoginLink,
  supermetricsLoginUsable,
  supermetricsRevokeLogin,
  supermetricsSourceLicensed,
  type AdAccountList,
  type SupermetricsConfig,
  type SupermetricsLogin,
} from "../ads.js";
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { supermetricsConfig } from "./config.js";

/** How long a login link stays open: long enough to sign in to the platform, short enough not to linger. */
export const SUPERMETRICS_LINK_TTL_S = 30 * 60;

/** Where Supermetrics sends the merchant back after they signed in to the platform. */
export const supermetricsRedirectUri = () => `${env().APP_URL}/api/ads/supermetrics/callback`;

/** A Supermetrics sign-in on its way: who started it, for which store and platform, and its login link. */
export interface SupermetricsLinkState {
  userId: string;
  workspaceId: string;
  storeId: string;
  provider: AdProvider;
  linkId: string;
  /** Reconnecting: the login whose access ended (replaced once the new one is in). */
  replacesLoginId?: string | null;
}

const linkStateKey = (nonce: string) => `oauth:ads-sm:${nonce}`;

/** The licence check's answer, kept a while: Supermetrics is asked at most once an hour per platform. */
const licenceKey = (provider: AdProvider) => `ads-sm-licence:${provider}`;

/**
 * Whether the team's licence covers a platform (supermetricsSourceLicensed), cached for an hour. An
 * answer that can't be had lets the sign-in go on: a licence that doesn't cover it is caught on the
 * first sync instead (not_configured, alerted to the operator).
 */
export async function supermetricsLicensed(coord: Coord, cfg: SupermetricsConfig, provider: AdProvider): Promise<boolean> {
  const cached = await coord.peek(licenceKey(provider)).catch(() => null);
  if (cached === "licensed") return true;
  if (cached === "not_licensed") return false;
  const answer = await supermetricsSourceLicensed(cfg, provider);
  if (answer !== "unknown") await coord.put(licenceKey(provider), answer, 3600).catch(() => undefined);
  if (answer === "not_licensed") logger.error({ provider, dsId: SUPERMETRICS_DS[provider] }, "supermetrics: the team's licence doesn't include this data source");
  return answer !== "not_licensed";
}

/**
 * Start a Supermetrics sign-in: a login link for the platform that sends the merchant back to
 * bizinsights' callback with `nonce` (the state, bound to their browser by the caller's cookie), and the
 * state kept in the coordinator until the link expires. Returns where to send the browser.
 */
export async function startSupermetricsLink(
  coord: Coord,
  cfg: SupermetricsConfig,
  nonce: string,
  input: Omit<SupermetricsLinkState, "linkId"> & { requireUsername?: string | null },
): Promise<string> {
  const redirect = new URL(supermetricsRedirectUri());
  redirect.searchParams.set("state", nonce);
  const link = await supermetricsCreateLoginLink(cfg, {
    dsId: SUPERMETRICS_DS[input.provider],
    // For the team's own list of links: which workspace and store, never who.
    description: `bizinsights ${input.provider} · workspace ${input.workspaceId} · store ${input.storeId}`,
    expiresAt: new Date(Date.now() + SUPERMETRICS_LINK_TTL_S * 1000),
    redirectUrl: redirect.toString(),
    requireUsername: input.requireUsername ?? null,
  });
  const state: SupermetricsLinkState = {
    userId: input.userId,
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    provider: input.provider,
    linkId: link.linkId,
    ...(input.replacesLoginId ? { replacesLoginId: input.replacesLoginId } : {}),
  };
  await coord.put(linkStateKey(nonce), JSON.stringify(state), SUPERMETRICS_LINK_TTL_S);
  return link.loginUrl;
}

/** Use up a sign-in's state: the callback can be answered once. */
export async function takeSupermetricsLinkState(coord: Coord, nonce: string): Promise<SupermetricsLinkState | null> {
  const raw = await coord.take(linkStateKey(nonce));
  return raw ? (JSON.parse(raw) as SupermetricsLinkState) : null;
}

/** What a finished link gave: the login, and the accounts it can report on. */
export interface SupermetricsSignIn {
  login: SupermetricsLogin;
  accounts: AdAccountList;
}

/** The link wasn't used to sign in (the person turned back, or it expired before they finished). */
export class SupermetricsLinkUnusedError extends Error {}

/**
 * The login a link made, read from Supermetrics itself (never from what the browser brought back), and
 * the accounts it reaches. The link is closed first, so it can't make another login. A login for a
 * different platform than the link's, or one that is no longer usable, is refused; a login that reaches
 * nothing is given back at once (it is of no use to anyone).
 */
export async function finishSupermetricsLink(cfg: SupermetricsConfig, provider: AdProvider, linkId: string): Promise<SupermetricsSignIn> {
  const link = await supermetricsLoginLink(cfg, linkId);
  await supermetricsCloseLoginLink(cfg, linkId);
  if (!link.loginId) throw new SupermetricsLinkUnusedError(`Supermetrics login link ${link.status.toLowerCase()} without a sign-in`);
  const login = await supermetricsLogin(cfg, link.loginId);
  if (login.dsId && login.dsId !== SUPERMETRICS_DS[provider]) {
    await supermetricsRevokeLogin(cfg, login.loginId).catch(() => undefined);
    throw new AdsApiError(`Supermetrics login is for ${login.dsId}, not ${SUPERMETRICS_DS[provider]}`, 400);
  }
  if (!supermetricsLoginUsable(login)) throw new AdsApiError("The new Supermetrics login is already expired", 400);
  try {
    return { login, accounts: await supermetricsLoginAccounts(cfg, provider, login.loginId) };
  } catch (err) {
    if (err instanceof AdsNoAccountsError) await supermetricsRevokeLogin(cfg, login.loginId).catch(() => undefined);
    throw err;
  }
}

/** Connections that read with this login and still hold its credential (a released one holds none). */
export async function supermetricsLoginUsers(loginId: string, exceptId?: string): Promise<number> {
  return systemDb.adConnection.count({ where: { source: "supermetrics", sourceLoginId: loginId, accessTokenEnc: { not: "" }, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
}

/**
 * Revoke a Supermetrics login at Supermetrics unless a connection still reads with it (`exceptId`: one
 * being let go). Best effort: the connection is gone whatever Supermetrics answers. Never throws.
 */
export async function revokeSupermetricsLoginIfUnused(
  loginId: string | null | undefined,
  fetchImpl?: FetchLike,
  exceptId?: string,
): Promise<"revoked" | "still_used" | "unknown_person" | "not_configured" | "failed"> {
  if (!loginId) return "unknown_person";
  try {
    if ((await supermetricsLoginUsers(loginId, exceptId)) > 0) return "still_used";
    const cfg = supermetricsConfig(fetchImpl);
    if (!cfg) return "not_configured";
    const outcome = await supermetricsRevokeLogin(cfg, loginId);
    if (outcome === "gone") logger.info({ loginId }, "supermetrics login was gone already");
    return "revoked";
  } catch (err) {
    logger.warn({ err, loginId }, "supermetrics login revoke failed");
    return "failed";
  }
}
