/**
 * Ad accounts connected to a store: which Nango connection each reads through (or, for one made before
 * Nango until migrate.ts moves it, its encrypted tokens), getting a working token, and storing what the
 * platforms report (ad_campaign_daily, and adsense_daily for AdSense). The platform calls themselves are
 * in ads/; the HTTP routes are apps/api/src/routes/ads.ts and adsNango.ts; the sync job is apps/worker.
 * One module per job in adConnections/; this file is the one place the rest of core imports them from.
 */
export * from "./adConnections/config.js";
// aad (the tokens' encryption context) and sameSignIn stay inside adConnections/.
export { adAccessToken, encryptAdTokens, forgetNangoToken, isNangoConnection, learnAdPerson, nangoCredential, reencryptAdTokens } from "./adConnections/credentials.js";
export * from "./adConnections/connect.js";
export * from "./adConnections/sync.js";
export * from "./adConnections/reports.js";
export * from "./adConnections/status.js";
export * from "./adConnections/alerts.js";
export * from "./adConnections/budget.js";
export * from "./adConnections/metaCallbacks.js";
export * from "./adConnections/demo.js";
export * from "./adConnections/nango.js";
export * from "./adConnections/migrate.js";
