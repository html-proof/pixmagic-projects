/**
 * Connect links: someone who manages a store's integrations makes a link on Settings → Advertising and
 * sends it to whoever runs the store's Meta ads (an agency, a colleague without a bizinsights login).
 * Opening it (the public page /connect/meta), that person signs in with Facebook, bizinsights' own Meta
 * app asking ads_read as "Continue with Meta Ads" does, and chooses which of their ad accounts belong to
 * the store. They need no bizinsights account, and the page shows them only the workspace's and the
 * store's names.
 *
 * One link per store and platform (a new one replaces it). It ends after AD_CONNECT_LINK_TTL_S, when it
 * is turned off, or with the first connection made through it, and it works only while the person who
 * made it may still connect ad accounts to the store (checked by the routes at every step). It lives in
 * the coordinator: the record under the token's hash, and the store's current link with its token, so
 * the people who manage the store can copy it again.
 *
 * A connection made through a link has no connecting member (connectedByUserId null): the grant is the
 * outside person's, so it never serves another store of the member who sent the link (reuse.ts), and it
 * stays when that member leaves. The audit log names who sent the link (routes/ads.ts connectAccounts).
 */
import { randomToken, sha256Hex } from "@app/shared";
import type { Coord } from "../coord.js";

/** How long a link works, unused. */
export const AD_CONNECT_LINK_TTL_S = 7 * 24 * 3600;

/** The platforms a link can connect: Meta only (Google's sign-in has its own consent rules: signIn.ts). */
export const AD_CONNECT_LINK_PROVIDERS = ["meta"] as const;
export type AdConnectLinkProvider = (typeof AD_CONNECT_LINK_PROVIDERS)[number];

export interface AdConnectLink {
  /** The token's hash: what names the link everywhere but in the link itself. */
  id: string;
  workspaceId: string;
  storeId: string;
  provider: AdConnectLinkProvider;
  /** The member who made it: the routes check they may still connect ad accounts to the store. */
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** Set by the connection made through it; the link then only says so, until it would have ended. */
  usedAt?: string;
  accounts?: number;
}

/** randomToken(32): 43 characters of base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Whether a value can be a link's token at all (it comes from an address bar). */
export const isAdConnectLinkToken = (t: unknown): t is string => typeof t === "string" && TOKEN.test(t);

export const adConnectLinkId = (token: string) => sha256Hex(`ads-link:${token}`);
const linkKey = (id: string) => `ads-link:${id}`;
const storeKey = (storeId: string, provider: string) => `ads-link-store:${storeId}:${provider}`;

/** The seconds left until `iso`, at least one (the coordinator's TTL). */
const secondsUntil = (iso: string, now: number) => Math.max(1, Math.ceil((Date.parse(iso) - now) / 1000));

function parse(raw: string | null, now: number): AdConnectLink | null {
  if (!raw) return null;
  try {
    const link = JSON.parse(raw) as AdConnectLink;
    return Date.parse(link.expiresAt) > now ? link : null;
  } catch {
    return null;
  }
}

/** Make the store's link, ending the one it had. Returns the token, which only the link itself carries. */
export async function createAdConnectLink(
  coord: Coord,
  input: { workspaceId: string; storeId: string; provider: AdConnectLinkProvider; userId: string },
  now = Date.now(),
): Promise<{ token: string; link: AdConnectLink }> {
  await revokeAdConnectLink(coord, input.storeId, input.provider);
  const token = randomToken(32);
  const link: AdConnectLink = {
    id: adConnectLinkId(token),
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    provider: input.provider,
    createdBy: input.userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + AD_CONNECT_LINK_TTL_S * 1000).toISOString(),
  };
  await coord.put(linkKey(link.id), JSON.stringify(link), AD_CONNECT_LINK_TTL_S);
  await coord.put(storeKey(input.storeId, input.provider), JSON.stringify({ token, link }), AD_CONNECT_LINK_TTL_S);
  return { token, link };
}

/** The store's link that can still be used, with its token; null when it has none. */
export async function currentAdConnectLink(coord: Coord, storeId: string, provider: AdConnectLinkProvider, now = Date.now()): Promise<{ token: string; link: AdConnectLink } | null> {
  const raw = await coord.peek(storeKey(storeId, provider));
  if (!raw) return null;
  try {
    const held = JSON.parse(raw) as { token: string; link: AdConnectLink };
    // The record is the truth: a link used up or turned off since is gone.
    const link = parse(await coord.peek(linkKey(held.link.id)), now);
    return link && !link.usedAt && isAdConnectLinkToken(held.token) ? { token: held.token, link } : null;
  } catch {
    return null;
  }
}

/** Turn the store's link off. Returns whether there was one. */
export async function revokeAdConnectLink(coord: Coord, storeId: string, provider: AdConnectLinkProvider): Promise<boolean> {
  const raw = await coord.take(storeKey(storeId, provider));
  if (!raw) return false;
  try {
    const { link } = JSON.parse(raw) as { link: AdConnectLink };
    await coord.take(linkKey(link.id));
  } catch {
    // Unreadable: the store no longer points at it, and its record ends by itself.
  }
  return true;
}

/** The link a token opens, used or not; null for anything else (never a reason: a token is right or not). */
export async function openAdConnectLink(coord: Coord, token: string, now = Date.now()): Promise<AdConnectLink | null> {
  if (!isAdConnectLinkToken(token)) return null;
  return parse(await coord.peek(linkKey(adConnectLinkId(token))), now);
}

/**
 * A connection was made through the link: it is used up. Whoever opens it again is told so until it
 * would have ended, and the store's settings no longer offer it.
 */
export async function useUpAdConnectLink(coord: Coord, link: AdConnectLink, accounts: number, now = Date.now()): Promise<void> {
  const used: AdConnectLink = { ...link, usedAt: new Date(now).toISOString(), accounts };
  await coord.put(linkKey(link.id), JSON.stringify(used), secondsUntil(link.expiresAt, now));
  const raw = await coord.peek(storeKey(link.storeId, link.provider));
  try {
    if (raw && (JSON.parse(raw) as { link: AdConnectLink }).link.id === link.id) await coord.take(storeKey(link.storeId, link.provider));
  } catch {
    // Unreadable: currentAdConnectLink reads the record, which says it is used.
  }
}
