/**
 * Meta, found through Shopify: where a store's Meta stands for bizinsights, worked out once for the
 * API and the UI (core's integrations/metaDiscovery.ts answers GET .../meta/discovery with it;
 * docs/meta-discovery.md).
 *
 * Shopify is a store's first connection, and many stores run Facebook and Instagram from Shopify's
 * own "Facebook & Instagram" app. Shopify keeps that app's Meta authorization to itself: no Admin API
 * scope, field or webhook hands another app a Meta token, nor the Business, Page, Instagram or ad
 * account ids behind it (SHOPIFY_SHARES_META_ACCESS). bizinsights never tries to take one. What
 * Shopify does send is each order's visit (read_orders, nothing more to grant), and that tells whether
 * Facebook and Instagram bring the store its orders: the store's Meta, seen in Shopify
 * (CONNECTED_IN_SHOPIFY), marked NOT_AUTHORIZED_FOR_OUR_APP. Meta's own figures (spend, impressions,
 * reach, clicks, what Meta credits to its ads) come only from a Meta authorization given to
 * bizinsights' own Meta app: the same "Connect Meta" sign-in as ever, asked for once, and not at all
 * when the person already gave bizinsights one for another of their stores (`reuse`).
 *
 * Imported by the UI through `@app/shared/metaDiscovery`: no I/O, no node: imports.
 */
// Without the ".js" the rest of the package uses: the web app imports this file directly (as integrations.ts).
import type { AdConnectionStatus, AdErrorCode } from "./ads";
import { ownErrorCode } from "./integrations";

/**
 * Shopify gives no app access to the Meta account a store connected in Shopify: checked against
 * Shopify's Admin API (2026-10) and its access scopes. Should Shopify ever offer it, this is the
 * switch, and nothing else may assume it.
 */
export const SHOPIFY_SHARES_META_ACCESS = false;

/**
 * | State                  | When                                                                                                  |
 * | ---------------------- | ----------------------------------------------------------------------------------------------------- |
 * | NOT_CONNECTED          | bizinsights holds no Meta authorization for the store, and its Shopify orders show no Meta visit       |
 * | CONNECTED_IN_SHOPIFY   | no Meta authorization of bizinsights', but the store's Shopify orders came from Facebook or Instagram  |
 * | AUTHORIZED_FOR_OUR_APP | a Meta sign-in given to bizinsights works: its ad accounts are read (or it waits for its first one)    |
 * | TOKEN_EXPIRED          | the Meta sign-in reached its end date (Meta's long-lived tokens last about 60 days)                    |
 * | REAUTH_REQUIRED        | Meta refused the sign-in before its end date (revoked, password changed), or the person who gave it left |
 * | PERMISSION_MISSING     | ads_read was taken back, or this sign-in can no longer read the ad account                             |
 *
 * With several ad accounts, the most pressing state of the ones shown on the dashboard is the store's
 * (as the cards do: someone must act on it).
 */
export const META_CONNECTION_STATES = ["NOT_CONNECTED", "CONNECTED_IN_SHOPIFY", "AUTHORIZED_FOR_OUR_APP", "TOKEN_EXPIRED", "REAUTH_REQUIRED", "PERMISSION_MISSING"] as const;
export type MetaConnectionState = (typeof META_CONNECTION_STATES)[number];

/** What a store whose Meta is seen in Shopify, with no authorization given to bizinsights, is marked: Shopify's access is never bizinsights'. */
export const NOT_AUTHORIZED_FOR_OUR_APP = "CONNECTED_IN_SHOPIFY_BUT_NOT_AUTHORIZED_FOR_OUR_APP";
export type MetaShopifyMarker = typeof NOT_AUTHORIZED_FOR_OUR_APP;

/** How far back the store's orders are read for a Meta visit. */
export const META_EVIDENCE_DAYS = 90;

/** What one Meta ad connection's state is worked out from (its ad_connections row; dates as ISO strings). */
export interface MetaConnectionFacts {
  status: AdConnectionStatus;
  errorCode: AdErrorCode | null;
  /** Shown on the dashboard (and synced). */
  enabled: boolean;
  /** When the Meta token stops working; null for one that doesn't end (a system user's) or isn't known. */
  accessTokenExpiresAt: string | null;
}

/** One ad connection's state. */
export function metaConnectionStateOf(c: MetaConnectionFacts, now = Date.now()): MetaConnectionState {
  const ends = c.accessTokenExpiresAt ? Date.parse(c.accessTokenExpiresAt) : Number.NaN;
  const ended = !Number.isNaN(ends) && ends <= now;
  const code = ownErrorCode(c);
  if (c.status === "reconnect") {
    if (code === "scope_missing") return "PERMISSION_MISSING";
    // Meta answers 190 both for a token past its date and for one taken back: the date tells them apart.
    return code !== "connector_left" && ended ? "TOKEN_EXPIRED" : "REAUTH_REQUIRED";
  }
  if (c.status === "permission") return "PERMISSION_MISSING";
  // Past its date before a sync noticed: it won't work again.
  if (ended) return "TOKEN_EXPIRED";
  // Working, or failing for a reason that isn't the authorization (Meta busy, an account Meta closed): authorized all the same.
  return "AUTHORIZED_FOR_OUR_APP";
}

/** Most pressing first. */
const PRECEDENCE: readonly MetaConnectionState[] = ["TOKEN_EXPIRED", "REAUTH_REQUIRED", "PERMISSION_MISSING", "AUTHORIZED_FOR_OUR_APP"];

export interface MetaDiscoveryFacts {
  /** The store's Meta ad connections. */
  connections: readonly MetaConnectionFacts[];
  /** A Meta sign-in that waits for its first ad account (ad_logins): authorized, nothing to read yet. */
  waitingLogin: boolean;
  /** The store's orders in the last META_EVIDENCE_DAYS whose visit came from Facebook or Instagram. */
  shopifyOrders: number;
}

/** Where the store's Meta stands for bizinsights. */
export function metaConnectionState(f: MetaDiscoveryFacts, now = Date.now()): MetaConnectionState {
  if (f.connections.length) {
    const shown = f.connections.filter((c) => c.enabled);
    const states = new Set((shown.length ? shown : f.connections).map((c) => metaConnectionStateOf(c, now)));
    return PRECEDENCE.find((s) => states.has(s)) ?? "AUTHORIZED_FOR_OUR_APP";
  }
  if (f.waitingLogin) return "AUTHORIZED_FOR_OUR_APP";
  return f.shopifyOrders > 0 ? "CONNECTED_IN_SHOPIFY" : "NOT_CONNECTED";
}

/** The marker for a state: only Meta seen in Shopify, and not authorized for bizinsights, carries one. */
export const metaShopifyMarker = (state: MetaConnectionState): MetaShopifyMarker | null => (state === "CONNECTED_IN_SHOPIFY" ? NOT_AUTHORIZED_FOR_OUR_APP : null);

/**
 * What the person is offered, by the state: nothing when the authorization works; using the Meta
 * sign-in they already gave bizinsights for another store ("reuse"), with no Meta screen, when there is
 * one; otherwise Meta's own sign-in, the one step Meta requires ("connect", or "reconnect" for a
 * sign-in that stopped). Only for someone who may manage integrations, on a server with Meta set up.
 */
export type MetaDiscoveryAction = "reuse" | "connect" | "reconnect";

export function metaDiscoveryAction(state: MetaConnectionState, can: { manage: boolean; configured: boolean; reusable: boolean }): MetaDiscoveryAction | null {
  if (!can.manage || !can.configured || state === "AUTHORIZED_FOR_OUR_APP") return null;
  if (can.reusable) return "reuse";
  return state === "NOT_CONNECTED" || state === "CONNECTED_IN_SHOPIFY" ? "connect" : "reconnect";
}

export type MetaStateTone = "neutral" | "info" | "good" | "warn" | "danger";

/** Each state as the pages badge it, and the one line under it. */
export const META_STATE_INFO: Record<MetaConnectionState, { label: string; tone: MetaStateTone; line: string }> = {
  NOT_CONNECTED: { label: "Not connected", tone: "neutral", line: "Connect Meta to see your Facebook and Instagram ads next to your sales." },
  CONNECTED_IN_SHOPIFY: {
    label: "Found in Shopify",
    tone: "info",
    line: "Facebook and Instagram bring this store orders, as Shopify records them. Shopify doesn't share its Meta access with other apps, so Meta's own figures need your OK for bizinsights once.",
  },
  AUTHORIZED_FOR_OUR_APP: { label: "Connected", tone: "good", line: "bizinsights reads this store's Meta ad accounts with the access you gave it." },
  TOKEN_EXPIRED: { label: "Sign-in expired", tone: "danger", line: "The Meta sign-in reached its end date. Sign in to Meta again to keep the figures coming." },
  REAUTH_REQUIRED: { label: "Reauthorization required", tone: "danger", line: "Meta no longer accepts this sign-in. Sign in to Meta again to keep the figures coming." },
  PERMISSION_MISSING: { label: "Permission missing", tone: "warn", line: "bizinsights can't read these ad accounts any more: sign in with a Facebook login that can see them, and allow reading ad performance." },
};

/** The buttons for the actions. */
export const META_ACTION_LABEL: Record<MetaDiscoveryAction, string> = {
  reuse: "Use my Meta sign-in",
  connect: "Connect Meta",
  reconnect: "Sign in to Meta again",
};
