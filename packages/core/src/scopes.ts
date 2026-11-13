import { systemDb, type Store } from "@app/db";
import { expandScopes, normalizeShopDomain } from "@app/shared";
import { APP_EXTRA_OPTIONAL_SCOPES, APP_STORE_APP, previewShops, type StoreApp } from "./apps.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import type { FetchLike } from "./shopify.js";
import { shopifyGraphql } from "./shopify.js";
import type { Queues, SyncKind } from "./queues.js";

/**
 * Optional (dynamic) access scopes: the ones a merchant grants *after* installation, one
 * feature at a time, instead of up front on the install screen.
 *
 * Under Shopify managed installation (`use_legacy_install_flow = false`) the install screen
 * asks for exactly the `scopes` in `shopify.app*.toml` and nothing else. A scope listed under
 * `optional_scopes` is never part of that grant; the only way to obtain it is to send the
 * merchant to the request URL below. This module is that mechanism.
 *
 * Two things are therefore true at once, and both matter:
 *
 *  - a scope we have NOT declared as optional can never be granted, however many times we ask;
 *  - a scope we HAVE declared is subject to Shopify's protected customer data review before
 *    the grant will actually stick.
 *
 * So a scope stays dormant until it is in `optional_scopes` in the tomls and mirrored into
 * `SHOPIFY_OPTIONAL_SCOPES` (every app) or `SHOPIFY_APP_OPTIONAL_SCOPES` (one app's own) —
 * `declaredOptionalScopes` leaves it out until then, and every entry point below refuses rather
 * than sending a merchant somewhere that cannot work.
 * See docs/shopify-setup.md "Optional scopes".
 */

/** "demo-shop.myshopify.com" → "demo-shop" (the store handle Shopify's admin URLs use). */
export function storeHandle(shop: string): string {
  const normalized = normalizeShopDomain(shop);
  if (!normalized) throw new Error("Invalid shop domain");
  return normalized.replace(/\.myshopify\.com$/, "");
}

/**
 * Scopes the deployed app declares as optional: `SHOPIFY_OPTIONAL_SCOPES`, which every app
 * declares, plus what `appKey`'s own toml adds (`appOptionalScopes`). No key: the common list.
 *
 * These env vars mirror `optional_scopes` in the tomls and cannot substitute for them: Shopify
 * reads the toml (via `shopify app deploy`), never our env. `packages/core/test/appConfig.test.ts`
 * fails the build if they drift apart, which is what makes reading the env safe here.
 */
export function declaredOptionalScopes(appKey?: string | null): string[] {
  const common = splitScopes(env().SHOPIFY_OPTIONAL_SCOPES);
  const extra = appKey ? (appOptionalScopes()[appKey] ?? []) : [];
  return [...new Set([...common, ...extra])];
}

/**
 * The optional scopes one store's merchant may be offered: what the app it is connected through
 * declares. A store in SHOPIFY_APP_STORE_PREVIEW_SHOPS (the App Store reviewer's test store, on
 * the main app) is offered only what the App Store app declares, so the reviewer never sees a
 * permission the app under review doesn't ask for.
 */
export function optionalScopesFor(store: StoreApp): string[] {
  return declaredOptionalScopes(previewShops().has(store.shopDomain) ? APP_STORE_APP : store.shopifyAppKey);
}

/**
 * The optional scopes one store's merchant may give back: everything its own app's toml declares as
 * optional (`APP_EXTRA_OPTIONAL_SCOPES` on top of the common list), which can be more than it is
 * offered. SHOPIFY_APP_OPTIONAL_SCOPES may lag the toml or be emptied again to stop offering a
 * scope (docs/shopify-setup.md, "Shopify's reports"); a store that granted it then still holds an
 * optional scope, and has to see it as one and be able to return it. The preview store is on the
 * main app, so it may return what the main app declares too. `revocableScopes` keeps only the
 * granted ones.
 */
export function revocableOptionalScopesFor(store: Pick<StoreApp, "shopifyAppKey">): string[] {
  return [...new Set([...declaredOptionalScopes(store.shopifyAppKey), ...(APP_EXTRA_OPTIONAL_SCOPES[store.shopifyAppKey] ?? [])])];
}

/**
 * `SHOPIFY_APP_OPTIONAL_SCOPES` ("default:read_reports;pixmagic:read_reports") as app key →
 * scopes: the optional scopes only some apps declare, such as `read_reports` on the apps whose
 * ShopifyQL access is set up, and not on an App Store app while Shopify reviews it.
 *
 * Fails closed, like SHOPIFY_EXTRA_APPS: an entry that can't be read is logged and left out, so a
 * typo offers a scope to no app rather than to every app.
 */
export function appOptionalScopes(): Record<string, string[]> {
  return appScopesSetting("SHOPIFY_APP_OPTIONAL_SCOPES");
}

/**
 * `SHOPIFY_APP_SCOPES` ("pixmagic:read_all_orders") as app key → scopes: the *required* scopes only
 * some apps declare, on top of `SHOPIFY_SCOPES`. A scope Shopify approves app by app
 * (`read_all_orders`) reaches each app's stores when that app's toml is released with it, not when
 * the last app's is. Read as `appOptionalScopes` is, and failing closed the same way.
 */
export function appRequiredScopes(): Record<string, string[]> {
  return appScopesSetting("SHOPIFY_APP_SCOPES");
}

type AppScopesSetting = "SHOPIFY_APP_OPTIONAL_SCOPES" | "SHOPIFY_APP_SCOPES";

/** Parsed once per value: every request reads it, and a bad entry should be logged once. */
const parsedAppScopes: Partial<Record<AppScopesSetting, { raw: string; byApp: Record<string, string[]> }>> = {};

function appScopesSetting(name: AppScopesSetting): Record<string, string[]> {
  const raw = env()[name].trim();
  let parsed = parsedAppScopes[name];
  if (parsed?.raw !== raw) parsed = parsedAppScopes[name] = { raw, byApp: parseAppScopes(raw, name) };
  return parsed.byApp;
}

const APP_SCOPES_ENTRY = /^([a-z0-9_]{1,32})\s*:\s*([a-z_]{1,64}(?:\s*,\s*[a-z_]{1,64})*)$/;

function parseAppScopes(raw: string, name: AppScopesSetting): Record<string, string[]> {
  const byApp: Record<string, string[]> = {};
  for (const part of raw.split(";")) {
    const entry = part.trim();
    if (!entry) continue;
    const m = APP_SCOPES_ENTRY.exec(entry);
    if (!m) {
      logger.error({ entry }, `${name} entry is not appKey:scope,scope; ignored`);
      continue;
    }
    byApp[m[1]!] = [...new Set([...(byApp[m[1]!] ?? []), ...splitScopes(m[2]!)])];
  }
  return byApp;
}

/**
 * An app's declared *required* scopes, mirroring `scopes` in its toml: `SHOPIFY_SCOPES`, which
 * every app declares, plus what `appKey`'s own toml adds (`appRequiredScopes`). No key: the common
 * list.
 *
 * A store can be missing one of these — its install predates the scope, or the grant is stale —
 * and that is the one case reconnecting the store actually fixes, since managed installation then
 * asks for the current declared set. Telling those merchants to wait for Shopify instead would
 * strand them, which is why the dashboard distinguishes the two (`resolveCapabilities`).
 */
export function declaredScopes(appKey?: string | null): string[] {
  const common = splitScopes(env().SHOPIFY_SCOPES);
  const extra = appKey ? (appRequiredScopes()[appKey] ?? []) : [];
  return [...new Set([...common, ...extra])];
}

/**
 * The required scopes one store's app declares: what reconnecting it would grant. The App Store
 * reviewer's preview store is read as the App Store app, as in `optionalScopesFor`.
 */
export function requiredScopesFor(store: StoreApp): string[] {
  return declaredScopes(previewShops().has(store.shopDomain) ? APP_STORE_APP : store.shopifyAppKey);
}

const splitScopes = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Of `wanted`, the scopes we can actually ask this store's merchant for: declared as optional
 * and not already granted. Anything else is dropped — asking for an undeclared scope lands the
 * merchant on a Shopify error, and asking for one they already have is a pointless prompt.
 * `optional`: what the store's app declares (`optionalScopesFor`); by default the common list.
 */
export function requestableScopes(wanted: string[], granted: string[] | string, optional: string[] = declaredOptionalScopes()): string[] {
  const declared = new Set(optional);
  const have = new Set(Array.isArray(granted) ? granted : granted.split(",").map((s) => s.trim()));
  // Shopify's write_X implies read_X, so a granted write_ covers the matching read_ request.
  for (const s of [...have]) if (s.startsWith("write_")) have.add(`read_${s.slice(6)}`);
  return [...new Set(wanted)].filter((s) => declared.has(s) && !have.has(s));
}

/**
 * Of `wanted`, the scopes we can actually revoke for this store: declared as optional and
 * currently granted.
 *
 * Required scopes are excluded on purpose. Shopify only lets an app revoke scopes it declared
 * as `optional_scopes` — a required one is part of the install grant, and the only way out of
 * that is uninstalling. Filtering here turns "we won't do that" into a clear refusal instead of
 * a Shopify `userErrors` entry the caller has to interpret.
 *
 * Unlike `requestableScopes` this does NOT treat a granted `write_X` as covering `read_X`: you
 * can only revoke a handle that was actually granted, and revoking `write_X` is not the same
 * ask as revoking `read_X`.
 *
 * `optional`: what the store's app declares (`revocableOptionalScopesFor`); by default the common list.
 */
export function revocableScopes(wanted: string[], granted: string[] | string, optional: string[] = declaredOptionalScopes()): string[] {
  const declared = new Set(optional);
  const have = new Set(Array.isArray(granted) ? granted : granted.split(",").map((s) => s.trim()));
  return [...new Set(wanted)].filter((s) => declared.has(s) && have.has(s));
}

/**
 * Where to send the merchant's browser to be asked for `scopes`.
 *
 * This is Shopify's documented request URL for apps that don't use App Bridge — which is us:
 * the app is `embedded = false`, so `shopify.scopes.request()` is not available. Note what it
 * does NOT take: no `redirect_uri`, no `state`, and it returns no authorization code. Shopify
 * asks the merchant, records the answer, and then opens the app's own application_url
 * (`/shopify/launch`). The grant therefore has to be learned rather than received — from the
 * `app/scopes_update` webhook, or by asking Shopify directly (`fetchGrantedScopes`). Anything
 * built on getting an answer back on this redirect would be building on sand.
 *
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes
 */
export function optionalScopeGrantUrl(clientId: string, shop: string, scopes: string[]): string {
  if (!scopes.length) throw new Error("No scopes to request");
  const url = new URL(`https://admin.shopify.com/store/${storeHandle(shop)}/oauth/install`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("optional_scopes", scopes.join(","));
  return url.toString();
}

/**
 * What this installation is *actually* granted, straight from Shopify. Declaring a scope is not
 * having it, and an optional scope is granted long after install, so this is the only answer
 * that is true by construction — the stored `grantedScopes` is a cache of it.
 */
export const GRANTED_SCOPES_QUERY = `#graphql
  query AppGrantedScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

export async function fetchGrantedScopes(opts: {
  shop: string;
  accessToken: string;
  apiVersion?: string;
  fetchImpl?: FetchLike;
}): Promise<string[]> {
  const data = await shopifyGraphql<{ currentAppInstallation: { accessScopes: Array<{ handle: string }> } | null }>({
    shop: opts.shop,
    accessToken: opts.accessToken,
    apiVersion: opts.apiVersion ?? env().SHOPIFY_API_VERSION,
    query: GRANTED_SCOPES_QUERY,
    fetchImpl: opts.fetchImpl,
  });
  const scopes = data.currentAppInstallation?.accessScopes;
  if (!scopes) throw new Error("Shopify returned no app installation");
  return scopes.map((s) => s.handle.trim()).filter(Boolean);
}

/**
 * Hand an optional scope back.
 *
 * Shopify's advice is to hold only the scopes a feature currently needs, so that a leaked token
 * can do less: an optional scope the app has stopped using is pure blast radius. This is the
 * only way to give one up short of the merchant uninstalling — `appRevokeAccessScopes` works on
 * `optional_scopes` only, and rejects anything in the install grant.
 *
 * Shopify reports the outcome in `userErrors`, not as a GraphQL error, so a plain "no" arrives
 * looking like success. Callers get an exception either way; `revocableScopes` keeps the
 * predictable refusals (not declared optional, not currently granted) from reaching Shopify at
 * all, so a `userErrors` entry here is genuinely unexpected.
 *
 * Revoking does not undo the data the scope let us import, and does not remove a web pixel that
 * `write_pixels` allowed us to create. What it changes is what the token can do next.
 *
 * @see https://shopify.dev/docs/api/admin-graphql/latest/mutations/appRevokeAccessScopes
 */
export const REVOKE_SCOPES_MUTATION = `#graphql
  mutation AppRevokeAccessScopes($scopes: [String!]!) {
    appRevokeAccessScopes(scopes: $scopes) {
      revoked { handle }
      userErrors { field message }
    }
  }
`;

export async function revokeAccessScopes(opts: {
  shop: string;
  accessToken: string;
  scopes: string[];
  apiVersion?: string;
  fetchImpl?: FetchLike;
}): Promise<string[]> {
  if (!opts.scopes.length) throw new Error("No scopes to revoke");
  const data = await shopifyGraphql<{
    appRevokeAccessScopes: {
      revoked: Array<{ handle: string }> | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    } | null;
  }>({
    shop: opts.shop,
    accessToken: opts.accessToken,
    apiVersion: opts.apiVersion ?? env().SHOPIFY_API_VERSION,
    query: REVOKE_SCOPES_MUTATION,
    variables: { scopes: opts.scopes },
    fetchImpl: opts.fetchImpl,
  });
  const result = data.appRevokeAccessScopes;
  if (!result) throw new Error("Shopify returned no revoke result");
  if (result.userErrors.length) {
    throw new ScopeRevokeError(result.userErrors.map((e) => e.message).join("; "));
  }
  return (result.revoked ?? []).map((s) => s.handle.trim()).filter(Boolean);
}

/** Shopify refused a revoke (`userErrors`), as opposed to failing to answer at all. */
export class ScopeRevokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeRevokeError";
  }
}

/**
 * The import work a newly granted scope makes possible — and, for the ones below, *necessary*.
 *
 * Granting a scope does not retroactively fill in the data it guards, and two of ours are
 * easy to get wrong in opposite directions:
 *
 *  - `read_customers` changes what the orders query asks for (`includeCustomer` in the worker),
 *    so every order already imported carries no customer hash. "New vs returning" would
 *    silently read as 100% new until the orders are re-imported, which is worse than the
 *    module staying locked. The re-import is deliberately a FULL one (no `sinceDays`): the
 *    gap is the whole history, not the last few days.
 *  - `read_all_orders` lifts Shopify's 60-day limit, but the orders older than that are still
 *    not here: until they are imported, a comparison with earlier dates (a Shopify screen set to
 *    14 Mar against 18 Oct) keeps saying "No earlier data". The same full import reads them all
 *    (`ordersSearch` drops its date filter once the scope is held) and records the history as
 *    complete (`importedFrom` → the epoch).
 *  - `write_pixels` only grants permission to create the web pixel; nothing has created it
 *    yet, and until it exists the storefront sends no events, so the funnel stays empty with
 *    no indication why.
 *
 * Returned as sync kinds so the API (after a merchant grants) and the worker (on
 * `app/scopes_update`, whoever triggered it) queue exactly the same work.
 */
export function scopeFollowUpKinds(newlyGranted: string[]): SyncKind[] {
  const granted = new Set(newlyGranted);
  const kinds: SyncKind[] = [];
  if (granted.has("read_customers") || granted.has("read_all_orders")) kinds.push("orders");
  if (granted.has("read_products")) kinds.push("products", "variants");
  if (granted.has("write_pixels")) kinds.push("install_pixel");
  // Stock levels (read_inventory, read_locations; write_inventory implies the first): the catalog
  // again, so every variant has its inventory item, then a full pass over every location's levels.
  if (granted.has("read_inventory") || granted.has("write_inventory") || granted.has("read_locations")) {
    if (!kinds.includes("variants")) kinds.push("variants");
    kinds.push("inventory");
  }
  return kinds;
}

/**
 * Queue the work `scopeFollowUpKinds` calls for, from either side of the flow: the API (right
 * after the merchant comes back from granting) or the worker (`app/scopes_update`, which also
 * fires when the grant happened somewhere we weren't watching).
 *
 * At-least-once is fine, and expected — both callers can fire for the same grant. Every job
 * here is idempotent: the imports upsert, and `webPixelCreate` answers TAKEN for a pixel that
 * already exists. What duplication does cost is Shopify rate limit, so callers pass only the
 * scopes that were *newly* granted, never everything the store has.
 */
export async function seedScopeFollowUp(
  deps: { queues: Pick<Queues, "sync"> },
  store: Pick<Store, "id" | "workspaceId">,
  newlyGranted: string[],
  /** Hold the jobs back this long: for a caller that saves the new scopes *after* seeding. */
  opts: { delaySeconds?: number } = {},
) {
  const jobs = [];
  for (const kind of scopeFollowUpKinds(newlyGranted)) {
    const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind } });
    // Deliberately no `sinceDays`: a scope that changes what the orders query asks for leaves a
    // gap the whole way back, not just in recent days (see scopeFollowUpKinds).
    await deps.queues.sync.send({ storeId: store.id, kind, syncJobId: job.id }, opts.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
    jobs.push(job);
  }
  return jobs;
}

/**
 * What stores.customers_from becomes when a store's granted scopes go from `before` to `after`,
 * written with them wherever they are saved (docs/customer-analytics.md "Where it starts").
 *
 * - read_customers newly held: `at`, the moment it was granted. Orders read from then on carry their
 *   customer, the ones already stored don't. Take `at` before queueing the import the grant calls
 *   for (`seedScopeFollowUp`): the worker moves the start back to that import's window once it is
 *   in, for an import queued at `at` or after (stores.customers_from).
 * - read_customers given up: null. Orders updated from then on lose their customer; a grant again
 *   starts over.
 * - Neither: nothing to write.
 */
export function customersFromChange(before: readonly string[], after: readonly string[], at: Date): { customersFrom: Date | null } | Record<string, never> {
  const had = expandScopes([...before]).has("read_customers");
  const has = expandScopes([...after]).has("read_customers");
  if (had === has) return {};
  return { customersFrom: has ? at : null };
}
