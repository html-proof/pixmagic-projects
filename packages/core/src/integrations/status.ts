/**
 * Every connection of a store in one answer (GET /workspaces/:ws/stores/:storeId/integrations):
 * Shopify, Meta Ads, Google Ads, Google AdSense and WhatsApp, each on one scale of six
 * statuses (@app/shared/integrations), with its accounts, the figures it brings and what this caller
 * may do with it, so every page says the same thing and a new provider needs no logic of a page's own.
 *
 * It composes what each module already says about itself, and decides nothing again: the store's
 * status with the dashboard's reason for an import that stopped (syncProblem), the ad connections'
 * and waiting sign-ins' states as the cards work them out (connectionState, platformState), and
 * WhatsApp's connection as its page shows it (waConnectionView). Nothing here calls a provider.
 * Never a token, a full phone number or a password: each account is named as its page names it (the
 * store, an ad account, a masked number).
 */
import { withTenant, type AdConnection, type AdLogin, type Store } from "@app/db";
import { allows, type MemberAccess } from "@app/shared/access";
import { AD_CONNECTION_STATUSES, AD_PROVIDERS, adStatusCode, isAdAccountStatus, isAdErrorCode, type AdConnectionStatus, type AdProvider } from "@app/shared/ads";
import {
  AD_MODULE,
  adIntegrationStatus,
  connectionState,
  INTEGRATION_MODULE_INFO,
  orderedActions,
  platformState,
  shopifyIntegrationStatus,
  whatsappIntegrationStatus,
  type AdStateFacts,
  type IntegrationAccount,
  type IntegrationAction,
  type IntegrationModule,
  type IntegrationModuleId,
  type IntegrationStatus,
} from "@app/shared/integrations";
import { adsConfigured } from "../adConnections/config.js";
import { googleAdsDemoEnabled } from "../adConnections/demo.js";
import { isDemoConnection } from "../ads/googleAdsSource.js";
import { syncProblem } from "../reports/overview.js";
import { connectionOf } from "../whatsapp/common.js";
import { evolutionConfigured } from "../whatsapp/evolution.js";
import { waConnectionView } from "../whatsapp/overview.js";

export interface IntegrationsViewer {
  /** What the caller may see and do: their Team & Access permissions (for a shared link, the read-only part of them). */
  access: MemberAccess;
  /** A signed-in member in their own session. Only they are offered actions: an API key and a shared link are read-only. */
  acts: boolean;
}

export interface IntegrationsStatus {
  modules: IntegrationModule<Date>[];
}

type Account = IntegrationAccount<Date>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const latest = (dates: Array<Date | null>) => dates.reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);

/** `counted`: the accounts its status is the worst of (every one, but for the ad platforms' hidden accounts). */
function moduleOf(id: IntegrationModuleId, status: IntegrationStatus, accounts: Account[], rest: { code?: string | null; demo?: boolean; counted?: Account[]; actions: IntegrationAction[] }): IntegrationModule<Date> {
  const info = INTEGRATION_MODULE_INFO[id];
  const counted = rest.counted ?? accounts;
  return {
    id,
    title: info.title,
    status,
    // A module that works needs no reason; otherwise its own, or the account that decided its status.
    code: status === "connected" ? null : rest.code !== undefined ? rest.code : (counted.find((a) => a.status === status)?.code ?? null),
    demo: rest.demo ?? false,
    accounts,
    lastSyncedAt: latest(counted.map((a) => a.lastSyncedAt)),
    capabilities: [...info.capabilities],
    actions: rest.actions,
    href: info.href,
  };
}

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

async function shopifyModule(store: Store, viewer: IntegrationsViewer): Promise<IntegrationModule<Date>> {
  const [lastRun, failed] = await withTenant(store.workspaceId, async (tx) => [
    await tx.syncJob.findFirst({ where: { storeId: store.id, workspaceId: store.workspaceId, startedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    // Why a store in error stopped, as the dashboard says it: reconnecting fixes only lost access.
    store.status === "error"
      ? await tx.syncJob.findFirst({ where: { storeId: store.id, workspaceId: store.workspaceId, status: "failed" }, orderBy: { createdAt: "desc" }, select: { error: true } })
      : null,
  ] as const);
  const problem = store.status === "error" ? syncProblem(failed?.error) : null;
  const status = shopifyIntegrationStatus({ status: store.status, hasToken: !!store.accessTokenEnc, problem });
  const account: Account = {
    id: store.id,
    name: store.name ?? store.shopDomain,
    status,
    lastSyncedAt: store.lastSyncedAt,
    lastAttemptAt: lastRun?.startedAt ?? null,
    code: problem,
    demo: false,
  };
  // The store itself stays with owners and admins (Settings → Shopify): Sync now, reconnecting, disconnecting.
  const actions: IntegrationAction[] = [];
  if (viewer.acts && allows(viewer.access, "stores:manage")) {
    if (status === "reauthorization_required") actions.push("reconnect");
    if (store.status === "active" || store.status === "error") actions.push("refresh");
    actions.push("disconnect");
  }
  return moduleOf("shopify", status, [account], { actions });
}

// ---------------------------------------------------------------------------
// Meta Ads, Google Ads, Google AdSense
// ---------------------------------------------------------------------------

/** A connection's row as the cards read it (the same normalizing as the API's publicConnection). */
function factsOf(c: AdConnection): AdStateFacts & { provider: AdProvider; demo: boolean } {
  return {
    provider: c.provider as AdProvider,
    status: (AD_CONNECTION_STATUSES as readonly string[]).includes(c.status) ? (c.status as AdConnectionStatus) : "error",
    errorCode: isAdErrorCode(c.errorCode) ? c.errorCode : null,
    enabled: c.enabled,
    accountStatus: isAdAccountStatus(c.accountStatus) ? c.accountStatus : null,
    lastSyncedAt: iso(c.lastSyncedAt),
    syncRequestedAt: iso(c.syncRequestedAt),
    connectedAt: c.createdAt.toISOString(),
    demo: isDemoConnection(c),
  };
}

function adModule(provider: AdProvider, rows: AdConnection[], logins: AdLogin[], viewer: IntegrationsViewer, now: number): IntegrationModule<Date> {
  const configured = adsConfigured();
  const mine = rows.filter((r) => r.provider === provider);
  const waiting = logins.filter((l) => l.provider === provider);
  const facts = mine.map(factsOf);
  const card = platformState(
    provider,
    { answer: { configured, demo: { google: googleAdsDemoEnabled() }, logins: waiting.map((l) => ({ provider: l.provider as AdProvider })) }, failed: false, connections: facts },
    now,
  );
  const accounts: Account[] = [
    ...mine.map((c, i): Account => {
      const f = facts[i]!;
      return {
        id: c.id,
        name: c.accountName ?? c.accountId,
        status: adIntegrationStatus(connectionState(f, now)),
        lastSyncedAt: c.lastSyncedAt,
        lastAttemptAt: c.lastSyncAttemptAt,
        // Its error code, or what the platform says of the account when that's what holds it up.
        code: adStatusCode(f.status, f.errorCode) ?? (f.accountStatus && f.accountStatus !== "active" ? f.accountStatus : null),
        demo: f.demo,
      };
    }),
    // A sign-in that waits for its ad accounts is connected, as its card says; its reason is why nothing is read yet.
    ...waiting.map((l): Account => ({ id: l.id, name: l.loginName, status: "connected", lastSyncedAt: null, lastAttemptAt: l.checkedAt, code: l.reason, demo: false })),
  ];
  const status = adIntegrationStatus(card.state);
  // The card counts the accounts shown on the dashboard, or all of them when every one is hidden (the first accounts are `mine`, in order).
  const shown = mine.some((c) => c.enabled);
  const counted = accounts.filter((_, i) => i >= mine.length || !shown || mine[i]!.enabled);

  const actions: IntegrationAction[] = [];
  if (viewer.acts && allows(viewer.access, "integrations.manage")) {
    if (configured[provider]) actions.push("connect");
    if (configured[provider] && accounts.some((a) => a.status === "reauthorization_required")) actions.push("reconnect");
    // What Refresh and "Check for ad accounts" act on: a shown account with a working grant (or the demo), or a waiting sign-in.
    if (mine.some((c) => c.enabled && c.status !== "reconnect" && (!!c.accessTokenEnc || isDemoConnection(c))) || waiting.length) actions.push("refresh");
    if (mine.length || waiting.length) actions.push("disconnect");
  }
  return moduleOf(AD_MODULE[provider], status, accounts, { code: card.state === "coming_soon" ? "not_configured" : undefined, demo: card.demo, counted, actions: orderedActions(actions) });
}

async function adModules(store: Store, viewer: IntegrationsViewer, now: number): Promise<IntegrationModule<Date>[]> {
  const ws = store.workspaceId;
  const [rows, logins] = await withTenant(ws, async (tx) => [
    await tx.adConnection.findMany({ where: { workspaceId: ws, storeId: store.id }, orderBy: [{ provider: "asc" }, { createdAt: "asc" }] }),
    await tx.adLogin.findMany({ where: { workspaceId: ws, storeId: store.id }, orderBy: { provider: "asc" } }),
  ] as const);
  return AD_PROVIDERS.map((p) => adModule(p, rows, logins, viewer, now));
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

async function whatsappModule(store: Store, viewer: IntegrationsViewer): Promise<IntegrationModule<Date>> {
  const row = await connectionOf(store.id);
  const view = waConnectionView(row);
  const status = whatsappIntegrationStatus(view?.status);
  // Every way of connecting goes through bizinsights' Evolution API service: a QR code needs nothing
  // more, Meta's Cloud API its settings too (overview.ts cloudApiMissing, shown on WhatsApp's page).
  const configured = evolutionConfigured();
  // A connection that was disconnected is no account any more: its reason says why.
  const live = !!row && !!view && view.status !== "disconnected";
  const accounts: Account[] = live
    ? [{ id: row.id, name: view.profileName ?? view.phone, status, lastSyncedAt: null, lastAttemptAt: view.lastCheckedAt, code: status === "connected" ? null : row.statusReason, demo: false }]
    : [];
  const actions: IntegrationAction[] = [];
  if (viewer.acts) {
    const manage = allows(viewer.access, "integrations.manage");
    if (manage && configured && !live) actions.push("connect");
    if (manage && configured && live && (status === "reauthorization_required" || status === "error")) actions.push("reconnect");
    // "Check now" asks the provider for the connection's state: anyone who may see WhatsApp's page.
    if (live && allows(viewer.access, "marketing.campaigns")) actions.push("refresh");
    if (manage && live) actions.push("disconnect");
  }
  return moduleOf("whatsapp", status, accounts, { code: live ? undefined : !configured ? "not_configured" : (row?.statusReason ?? null), actions });
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export async function integrationsStatus(store: Store, viewer: IntegrationsViewer, now = Date.now()): Promise<IntegrationsStatus> {
  const [shopify, ads, whatsapp] = await Promise.all([shopifyModule(store, viewer), adModules(store, viewer, now), whatsappModule(store, viewer)]);
  return { modules: [shopify, ...ads, whatsapp] };
}
