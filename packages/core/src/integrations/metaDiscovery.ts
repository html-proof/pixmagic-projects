/**
 * Meta, found through the store's Shopify connection (GET /workspaces/:ws/stores/:storeId/meta/discovery;
 * the states and why Shopify can't hand Meta's access over: @app/shared/metaDiscovery, docs/meta-discovery.md).
 *
 * Worked out on every read from what is already stored, so the answer follows the store by itself:
 * its Meta ad connections and waiting sign-in (bizinsights' own Meta authorization), and its Shopify
 * orders of the last 90 days whose visit came from Facebook or Instagram (read_orders, imported by the
 * store's own sync). Nothing here calls Meta or Shopify. Never a token: the Meta assets are named as
 * Settings → Advertising names them.
 */
import { withTenant, type AdConnection, type Store } from "@app/db";
import { allows } from "@app/shared/access";
import { AD_CONNECTION_STATUSES, isAdErrorCode, type AdConnectionStatus } from "@app/shared/ads";
import { PLATFORM_SOURCES } from "@app/shared/adsFromShopify";
import {
  META_EVIDENCE_DAYS,
  metaConnectionState,
  metaConnectionStateOf,
  metaDiscoveryAction,
  metaShopifyMarker,
  SHOPIFY_SHARES_META_ACCESS,
  type MetaConnectionFacts,
  type MetaConnectionState,
  type MetaDiscoveryAction,
  type MetaShopifyMarker,
} from "@app/shared/metaDiscovery";
import { adsConfigured } from "../adConnections/config.js";
import { reusableMetaSignIn } from "../adConnections/reuse.js";
import type { IntegrationsViewer } from "./status.js";

/** What the store's Shopify orders say about Meta. `D`: how dates travel (Date in core, a string in JSON). */
export interface MetaShopifyEvidence<D = Date> {
  /** The store's first import has finished: before it, no order can say anything yet. */
  ordersRead: boolean;
  /** How far back the orders were read. */
  days: number;
  /** Orders whose visit came from Facebook or Instagram. Null for a caller without "View traffic sources" (the state counts them all the same). */
  orders: number | null;
  facebook: number | null;
  instagram: number | null;
  /** Of them, through a link tagged as an ad. Null without "View conversion attribution". */
  paidOrders: number | null;
  /** When the latest of them was placed. */
  lastOrderAt: D | null;
}

export interface MetaAdAccountAsset<D = Date> {
  id: string;
  accountId: string;
  name: string | null;
  currency: string | null;
  state: MetaConnectionState;
  /** Shown on the dashboard (and synced). */
  enabled: boolean;
  lastSyncedAt: D | null;
}

export interface MetaDiscovery<D = Date> {
  state: MetaConnectionState;
  /** NOT_AUTHORIZED_FOR_OUR_APP for Meta seen in Shopify with no authorization given to bizinsights; null otherwise. */
  marker: MetaShopifyMarker | null;
  /** A Meta sign-in given to bizinsights serves this store (it may still wait for its first ad account). */
  authorizedForOurApp: boolean;
  /** Shopify hands no app Meta's access (SHOPIFY_SHARES_META_ACCESS): in every answer, so no caller takes Meta seen in Shopify for Meta connected. */
  shopifySharesMetaAccess: boolean;
  shopify: MetaShopifyEvidence<D>;
  /** The Meta assets bizinsights reads for the store: its ad accounts and the campaigns their syncs have seen. */
  assets: {
    adAccounts: MetaAdAccountAsset<D>[];
    campaigns: number;
    /** A Meta sign-in that waits for its first ad account: who it is. */
    waitingLogin: { name: string | null } | null;
  };
  /** The caller's own Meta sign-in for another of their stores, which can serve this one without Meta's screen. */
  reuse: { storeName: string | null } | null;
  /** What the caller is offered (none when they may not manage integrations, or Meta isn't set up here). */
  action: MetaDiscoveryAction | null;
  /** Meta's sign-in is set up on this server. */
  configured: boolean;
}

/** A connection's row as metaConnectionStateOf reads it (unknown statuses read as an error, as the cards do). */
const factsOf = (c: AdConnection): MetaConnectionFacts => ({
  status: (AD_CONNECTION_STATUSES as readonly string[]).includes(c.status) ? (c.status as AdConnectionStatus) : "error",
  errorCode: isAdErrorCode(c.errorCode) ? c.errorCode : null,
  enabled: c.enabled,
  accessTokenExpiresAt: c.accessTokenExpiresAt?.toISOString() ?? null,
});

/** The store's orders in the last META_EVIDENCE_DAYS whose visit came from Facebook or Instagram. */
async function shopifyEvidence(store: Store, now: number) {
  const since = new Date(now - META_EVIDENCE_DAYS * 86_400_000);
  const sources = [...PLATFORM_SOURCES.meta];
  const [row] = await withTenant(
    store.workspaceId,
    (tx) => tx.$queryRaw<Array<{ orders: number; facebook: number; instagram: number; paid: number; last: Date | null }>>`
      SELECT COUNT(*)::int AS orders,
             (COUNT(*) FILTER (WHERE o.traffic_source = 'facebook'))::int AS facebook,
             (COUNT(*) FILTER (WHERE o.traffic_source = 'instagram'))::int AS instagram,
             (COUNT(*) FILTER (WHERE o.traffic_medium = 'paid'))::int AS paid,
             MAX(o.shopify_created_at) AS last
      FROM orders o
      WHERE o.workspace_id = ${store.workspaceId} AND o.store_id = ${store.id}
        AND o.shopify_created_at >= ${since} AND NOT o.gift_card_only
        AND o.traffic_source = ANY(${sources}::text[])`,
  );
  return { orders: row?.orders ?? 0, facebook: row?.facebook ?? 0, instagram: row?.instagram ?? 0, paid: row?.paid ?? 0, last: row?.last ?? null };
}

/**
 * Where the store's Meta stands for bizinsights, for this caller. `userId`: the signed-in member asking
 * (their own Meta sign-in for another store is the one that can be reused); none for a shared link or
 * an API key, which only look.
 */
export async function metaDiscovery(store: Store, viewer: IntegrationsViewer & { userId?: string | null }, now = Date.now()): Promise<MetaDiscovery> {
  const ws = store.workspaceId;
  const [rows, login, campaigns, evidence] = await Promise.all([
    withTenant(ws, (tx) => tx.adConnection.findMany({ where: { workspaceId: ws, storeId: store.id, provider: "meta" }, orderBy: { createdAt: "asc" } })),
    withTenant(ws, (tx) => tx.adLogin.findFirst({ where: { workspaceId: ws, storeId: store.id, provider: "meta" }, select: { loginName: true } })),
    withTenant(ws, (tx) => tx.adCampaign.count({ where: { workspaceId: ws, storeId: store.id, provider: "meta" } })),
    shopifyEvidence(store, now),
  ]);
  const facts = rows.map(factsOf);
  const state = metaConnectionState({ connections: facts, waitingLogin: !!login, shopifyOrders: evidence.orders }, now);
  const configured = adsConfigured().meta;
  const manage = viewer.acts && allows(viewer.access, "integrations.manage");

  // Only worth looking for while bizinsights holds no working authorization for the store.
  const source = manage && configured && viewer.userId && state !== "AUTHORIZED_FOR_OUR_APP" ? await reusableMetaSignIn(viewer.userId, store.id, now) : null;
  // The other store is named when it is in this workspace; one in another workspace is "another of your stores".
  const storeName = source && source.workspaceId === ws ? await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: source.storeId, workspaceId: ws }, select: { name: true, shopDomain: true } })) : null;

  const traffic = allows(viewer.access, "analytics.traffic");
  const attribution = traffic && allows(viewer.access, "marketing.attribution");
  return {
    state,
    marker: metaShopifyMarker(state),
    authorizedForOurApp: state === "AUTHORIZED_FOR_OUR_APP",
    shopifySharesMetaAccess: SHOPIFY_SHARES_META_ACCESS,
    shopify: {
      ordersRead: !!store.lastSyncedAt,
      days: META_EVIDENCE_DAYS,
      orders: traffic ? evidence.orders : null,
      facebook: traffic ? evidence.facebook : null,
      instagram: traffic ? evidence.instagram : null,
      paidOrders: attribution ? evidence.paid : null,
      lastOrderAt: traffic ? evidence.last : null,
    },
    assets: {
      adAccounts: rows.map((c, i) => ({
        id: c.id,
        accountId: c.accountId,
        name: c.accountName,
        currency: c.currency,
        state: metaConnectionStateOf(facts[i]!, now),
        enabled: c.enabled,
        lastSyncedAt: c.lastSyncedAt,
      })),
      campaigns,
      waitingLogin: login ? { name: login.loginName } : null,
    },
    reuse: source ? { storeName: storeName ? (storeName.name ?? storeName.shopDomain) : null } : null,
    action: metaDiscoveryAction(state, { manage, configured, reusable: !!source }),
    configured,
  };
}
