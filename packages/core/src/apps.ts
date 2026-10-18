import { z } from "zod";
import { normalizeShopDomain } from "@app/shared";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Our Shopify apps. "default" is the main app (SHOPIFY_API_KEY / SHOPIFY_API_SECRET). Extra
 * apps, e.g. a custom-distribution app made for one client's store, come from:
 *
 *   SHOPIFY_EXTRA_APPS = [{"key":"pixmagic","clientId":"…","shops":["pixmagic.myshopify.com"]}]   (plain var)
 *   SHOPIFY_APP_SECRET_PIXMAGIC = <that app's client secret>                                          (secret)
 *
 * Every store remembers which app it is connected through (stores.shopify_app_key), so its
 * token refreshes, webhooks and OAuth use that app's credentials.
 *
 * `shops` is the allowlist of stores an app may be installed on, empty meaning any store.
 * It mirrors Shopify's distribution rules: a custom-distribution app only installs on the
 * store it was generated for, and the main app only installs on stores in our developer
 * organization until it passes Shopify's review (SHOPIFY_DEFAULT_APP_SHOPS). Sending a
 * merchant to an app their store may not install ends on Shopify's "This installation link
 * can't be used" page, so the allowlists decide which app each store is offered.
 */
export interface ShopifyApp {
  key: string;
  clientId: string;
  clientSecret: string;
  /** Stores this app may be installed on; empty means any store (public distribution). */
  shops: string[];
}

export const DEFAULT_APP = "default";

const extraSchema = z.array(
  z.object({
    key: z.string().regex(/^[a-z0-9_]{1,32}$/, "app keys are lowercase letters, digits and _"),
    clientId: z.string().min(1),
    shops: z.array(z.string()).default([]),
  }),
);

/** Env name holding an extra app's client secret. */
export const appSecretVar = (key: string) => `SHOPIFY_APP_SECRET_${key.toUpperCase()}`;

/**
 * A store domain no input can normalise to, so an app holding only this one is installable
 * nowhere. See `shopList`: it is how a misconfigured allowlist fails closed.
 */
const NO_SHOP = "\u0000none";

/**
 * Comma-separated store list from a plain env var; unparseable entries are dropped.
 *
 * An allowlist that was configured but yielded nothing usable must NOT collapse to an empty
 * list, because empty means "any store" (`servesAnyShop`) - so a single typo
 * ("shop.myshopify.con") would silently turn "only my test store" back into "every merchant",
 * sending strangers to a Shopify install link and defeating the point of the allowlist. Keep
 * the dangerous direction unreachable: when the operator asked for a restriction and we could
 * not read one, serve no store at all. The logged error says which entry to fix.
 */
function shopList(raw: string): string[] {
  const shops: string[] = [];
  let rejected = false;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const shop = normalizeShopDomain(trimmed);
    if (shop) shops.push(shop);
    else {
      rejected = true;
      logger.error({ shop: trimmed }, "SHOPIFY_DEFAULT_APP_SHOPS entry is not a store domain; ignored");
    }
  }
  if (!shops.length && rejected) {
    logger.error({}, "SHOPIFY_DEFAULT_APP_SHOPS has no valid store; the main app is now installable nowhere");
    return [NO_SHOP];
  }
  return shops;
}

interface Registry {
  apps: ShopifyApp[];
  /**
   * Stores an extra app was configured to serve but cannot, because that entry was skipped.
   *
   * Skipping has to leave a mark, or the store quietly falls through to the main app below —
   * and that is the worst outcome available. A store gets its own app precisely because the
   * main one may not be installed on it, so the fallback hands the merchant a Shopify install
   * link their store is refused: the dead-end "This installation link can't be used" page,
   * which Shopify never calls back from, so nothing on our side records the failure either.
   * It has happened: `SHOPIFY_EXTRA_APPS` was edited into the app's settings but never deployed,
   * so the client's store was offered the unapproved main app and the only trace was one log
   * line nobody was looking for. Fail closed instead - `appForShop` returns null for these
   * stores, so the merchant gets our own `app_unavailable` message, which names the problem.
   */
  blocked: Set<string>;
}

let cached: Registry | undefined;

function buildRegistry(): Registry {
  const e = env();
  const apps: ShopifyApp[] = [
    { key: DEFAULT_APP, clientId: e.SHOPIFY_API_KEY, clientSecret: e.SHOPIFY_API_SECRET, shops: shopList(e.SHOPIFY_DEFAULT_APP_SHOPS) },
  ];
  const blocked = new Set<string>();
  const raw = e.SHOPIFY_EXTRA_APPS.trim();
  // A mistake in the extra apps must never take the main app down: log it and skip that entry.
  let extras: z.infer<typeof extraSchema> = [];
  try {
    if (raw) extras = extraSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.error({ err: (err as Error).message }, "SHOPIFY_EXTRA_APPS is invalid; extra Shopify apps disabled");
  }
  for (const a of extras) {
    const secret = process.env[appSecretVar(a.key)] ?? "";
    const shops = a.shops.map((s) => normalizeShopDomain(s));
    const problem =
      a.key === DEFAULT_APP || apps.some((x) => x.key === a.key)
        ? "duplicate app key"
        : !secret
          ? `${appSecretVar(a.key)} is not set`
          : shops.some((s) => !s)
            ? "invalid shop domain"
            : null;
    if (problem) {
      logger.error({ app: a.key }, `Shopify app "${a.key}" skipped: ${problem}; its stores can no longer install`);
      // Whatever we could read of its allowlist is still what that app was meant to serve.
      for (const s of shops) if (s) blocked.add(s);
      continue;
    }
    apps.push({ key: a.key, clientId: a.clientId, clientSecret: secret, shops: shops as string[] });
  }
  return { apps, blocked };
}

const registry = (): Registry => (cached ??= buildRegistry());

export function shopifyApps(): ShopifyApp[] {
  return registry().apps;
}

/** The app a store is connected through (unknown keys fall back to the default app). */
export function shopifyApp(key: string | null | undefined): ShopifyApp {
  const apps = shopifyApps();
  return apps.find((a) => a.key === key) ?? apps[0]!;
}

/** True when `app` may be installed on any store, so a merchant can pick one on Shopify. */
export const servesAnyShop = (app: ShopifyApp): boolean => app.shops.length === 0;

/**
 * The app stores without one of their own install (SHOPIFY_INSTALL_APP): the App Store app once
 * Shopify approves it, the main app until then. Only an app that may go on any store qualifies;
 * otherwise, or for a key no app has, the main app.
 */
export function installTarget(): ShopifyApp {
  const apps = shopifyApps();
  const chosen = apps.find((a) => a.key === env().SHOPIFY_INSTALL_APP);
  return chosen && servesAnyShop(chosen) ? chosen : apps[0]!;
}

/**
 * The app to install on `shop`: the one distributed to that store, else the install target
 * (`installTarget`) when it may be installed anywhere. Null when no app of ours can be installed there — the merchant
 * needs their own app (docs/shopify-setup.md "A client's store with its own app").
 */
export function appForShop(shop: string): ShopifyApp | null {
  const { apps, blocked } = registry();
  const own = apps.find((a) => a.shops.includes(shop));
  if (own) return own;
  // A store whose own app is misconfigured must not fall through to the main app: see `blocked`.
  if (blocked.has(shop)) return null;
  const main = installTarget();
  return servesAnyShop(main) ? main : null;
}

/**
 * The App Store app's key (shopify-app/shopify.app.appstore.toml): the app of ours submitted to the
 * Shopify App Store, which App Store workspaces connect new stores through (`connectApp`).
 */
export const APP_STORE_APP = "appstore";

/**
 * Every key whose stores came from an App Store listing: the App Store app, and "public"
 * (shopify.app.public.toml, 658431ae), the first App Store app, replaced 2026-10-18 when its
 * submission was started over with a new app. Stores connected through "public" stay on it (their
 * tokens, webhooks and reconnects use its credentials), and their workspaces keep looking the way
 * the listing describes.
 */
export const APP_STORE_APPS: readonly string[] = [APP_STORE_APP, "public"];

/** A store as far as choosing its app goes. */
export interface StoreApp {
  shopDomain: string;
  shopifyAppKey: string;
}

/**
 * Whether a workspace is shown as a merchant who installed from the App Store sees bizinsights: only
 * what the listing describes (apps/web/src/lib/features.ts, APP_STORE_MODULES), with in-app connects
 * going through the App Store app (`connectApp`). True when it holds a store and every one of them
 * came through an App Store app (`APP_STORE_APPS`) or is one of SHOPIFY_APP_STORE_PREVIEW_SHOPS.
 * `stores` includes disconnected and uninstalled ones, which keep their app. A workspace with a
 * store from any other of our apps keeps everything it had.
 */
export function appStoreWorkspace(stores: readonly StoreApp[]): boolean {
  if (!stores.length) return false;
  const preview = new Set(
    env()
      .SHOPIFY_APP_STORE_PREVIEW_SHOPS.split(",")
      .map((s) => normalizeShopDomain(s.trim()))
      .filter(Boolean),
  );
  return stores.every((s) => APP_STORE_APPS.includes(s.shopifyAppKey) || preview.has(s.shopDomain));
}

/**
 * The app an in-app connect goes through, for `shop` (null: Shopify's store picker chooses the store)
 * in a workspace holding `stores`. `existing` is the shop's store, wherever it is, when it has one.
 *
 * - A store with an app of its own gets that one, and none while that app is misconfigured
 *   (`appForShop`).
 * - A store connected before keeps the app it came through, when that app may go on any store: a
 *   reconnect never moves a merchant to an app their store may refuse.
 * - An App Store workspace adds stores through the App Store app (`APP_STORE_APP`, also for a
 *   workspace whose stores came through the earlier "public"), so a merchant who installed from
 *   the listing is never sent to an app Shopify hasn't approved for their store.
 * - Everyone else: the install target.
 *
 * Null when no app of ours may be installed there (by name), or picked on Shopify (no name).
 */
export function connectApp(shop: string | null, stores: readonly StoreApp[], existing?: StoreApp | null): ShopifyApp | null {
  const { apps, blocked } = registry();
  if (shop) {
    const own = apps.find((a) => a.shops.includes(shop));
    if (own) return own;
    if (blocked.has(shop)) return null;
    const kept = existing ? apps.find((a) => a.key === existing.shopifyAppKey) : undefined;
    if (kept && servesAnyShop(kept)) return kept;
  }
  // The App Store app, or while it is misconfigured (its secret missing) the first one: both are in
  // the organization whose development stores an App Store workspace's merchant can install on.
  const listed = appStoreWorkspace(stores)
    ? APP_STORE_APPS.map((k) => apps.find((a) => a.key === k)).find((a) => a && servesAnyShop(a))
    : undefined;
  const target = listed ?? installTarget();
  return servesAnyShop(target) ? target : null;
}

/** For tests. */
export function resetShopifyAppsCache() {
  cached = undefined;
}
