/**
 * Parts of the app that are built but switched off for now. Flip one to `true` to bring it back;
 * the pages, API routes and Shopify webhooks behind it are all still in place.
 */

/**
 * Settings → Billing (plans charged through Shopify). Hidden 2026-10-15 until paid plans launch.
 * Turn it on together with the API's BILLING_ENABLED setting (apps/aws/src/settings.ts), which
 * lets merchants start a paid plan and applies each plan's store limit. Before launch:
 * docs/shopify-app-store-compliance.md, "Billing".
 */
export const BILLING_ENABLED: boolean = false;

/**
 * Whether Settings → Billing is shown: once billing is on, and in the e2e build before that
 * (apps/web/playwright.config.ts sets NEXT_PUBLIC_E2E_BILLING; next.config.ts refuses it in any
 * other build), so the page is tested before it launches.
 */
export const BILLING_PAGE: boolean = BILLING_ENABLED || process.env.NEXT_PUBLIC_E2E_BILLING === "1";

/**
 * Settings → API keys (read-only `sk_live_` keys for other tools). Hidden 2026-10-15; keys that
 * already exist keep working, since the API still accepts them.
 */
export const API_KEYS_ENABLED: boolean = false;

/**
 * The simpler Home (2026-11-05, the owner's approved prototype): what needs you, four numbers,
 * sales by day and what changed
 * (components/dashboard/SimpleHome.tsx). "Show the full dashboard" under the greeting brings back
 * every panel on that device, and "Back to the simple Home" returns. Flip to `false` to make the
 * full dashboard everyone's Home again, with no way to the simple one.
 */
export const SIMPLE_HOME: boolean = true;

/**
 * The short menu (2026-11-11): the sidebar lists the everyday pages and folds the rest into groups
 * that open with a click (lib/menu.ts, components/AppShell.tsx). Every page keeps its name and its
 * address. "Show every page" at the foot of the menu brings back the whole list on that device, and
 * "Show fewer pages" returns. Flip to `false` to make the whole list everyone's menu again, with no
 * switch.
 */
export const SIMPLE_MENU: boolean = true;

/**
 * The Zapier card on Settings → Integrations (docs/zapier.md): connect the store to the merchant's own
 * Zapier account through bizinsights' Zapier app. On in production since 2026-10-29: the app is
 * registered and its ZAPIER_* settings are live, and the first test Zap passed (docs/zapier.md,
 * "Owner setup"). The consent page Zapier opens (/connect/zapier) and the API don't depend on it: they
 * answer `not_configured` until the settings are there, and the card then says Zapier isn't set up yet.
 */
export const ZAPIER_ENABLED: boolean = true;
export const ZAPIER_CARD: boolean = ZAPIER_ENABLED || process.env.NODE_ENV !== "production";

/** The parts of the app beyond the Shopify dashboard, each built on another company's accounts. */
export type AppModule = "whatsapp" | "staff" | "ads" | "inventory" | "zapier";

/**
 * What a workspace whose stores came in through the App Store app offers (`MeWorkspace.appStore`,
 * packages/core/src/apps.ts `appStoreWorkspace`): only what the App Store listing describes
 * (shopify-app/listing/listing-copy.md). WhatsApp and advertising (Meta Ads, Google Ads, AdSense)
 * need the merchant's own Meta or Google accounts and approvals Shopify's reviewer can't
 * complete, and Staff (timesheets and payroll) is no part of a Shopify analytics listing, so they
 * are left out there: the menus, the pages, Team & Access's permissions for them and the
 * dashboard's Advertising section. Every other workspace keeps all of them, and the API routes and
 * data stay in place. Flip one to `true` to offer it to App Store merchants too (and describe it in
 * the listing).
 */
//
// Inventory (stock per location, stock changes) asks Shopify for scopes the App Store app's
// listing doesn't describe yet: on there once its toml declares them (shopify app deploy
// --config appstore) and the listing says so (docs/inventory.md, "Turning it on").
//
// Zapier isn't offered to App Store workspaces: it needs the merchant's own Zapier account.
export const APP_STORE_MODULES: Record<AppModule, boolean> = { whatsapp: false, staff: false, ads: false, inventory: false, zapier: false };

/** Whether a workspace offers `part` of the app (`appStore`: it came in through the App Store app). */
export const offersModule = (appStore: boolean | undefined, part: AppModule): boolean => !appStore || APP_STORE_MODULES[part];
