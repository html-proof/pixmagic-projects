// Shared env for integration tests (imported by vitest configs).
// TEST_DB picks the database (must end in _test), so separate checkouts or
// parallel runs can each use their own; default app_test.
// TEST_PG_PORT picks the Postgres server; default 5434 (docker compose / CI). Point it at a
// throwaway container to keep test load and migrations off the server that also hosts `app`.
const db = process.env.TEST_DB ?? "app_test";
if (!/_test$/.test(db)) throw new Error(`TEST_DB must end in _test (got ${db})`);
const port = process.env.TEST_PG_PORT ?? "5434";
if (!/^\d+$/.test(port)) throw new Error(`TEST_PG_PORT must be a port number (got ${port})`);
// The superuser's password: "app" (docker compose), or the one a CI job on the PC gave its server.
const password = encodeURIComponent(process.env.TEST_PG_PASSWORD ?? "app");

export const testEnv = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3001",
  API_URL: "http://localhost:4000",
  DATABASE_URL: `postgresql://app:${password}@127.0.0.1:${port}/${db}`,
  APP_DATABASE_URL: `postgresql://app_rls:app_rls@127.0.0.1:${port}/${db}`,
  SESSION_SECRET: "test-session-secret-0123456789",
  TOKEN_ENCRYPTION_KEYS: "1:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
  OTP_PEPPER: "test-pepper-123",
  SHOPIFY_API_KEY: "test_key",
  SHOPIFY_API_SECRET: "test_secret",
  SHOPIFY_SCOPES: "read_orders,read_products",
  SHOPIFY_OPTIONAL_SCOPES: "",
  SHOPIFY_API_VERSION: "2026-10",
  // A second app, custom-distributed to one client store (multi-app support).
  SHOPIFY_EXTRA_APPS: JSON.stringify([
    { key: "client", clientId: "client_key", shops: ["client-shop.myshopify.com"] },
    // The first App Store app (production's "public"), kept for the stores connected through it.
    { key: "public", clientId: "public_key", shops: [] },
    // The App Store app (production's "appstore"): any store, not where new stores are sent.
    { key: "appstore", clientId: "appstore_key", shops: [] },
  ]),
  SHOPIFY_APP_SECRET_CLIENT: "client_secret",
  SHOPIFY_APP_SECRET_PUBLIC: "public_secret",
  SHOPIFY_APP_SECRET_APPSTORE: "appstore_secret",
  // The senders production has (apps/aws/src/settings.ts; core/mail/senders.ts).
  OTP_FROM_EMAIL: "support@bizinsights.io",
  OTP_FROM_NAME: "BizInsights Support",
  LINK_FROM_EMAIL: "link@bizinsights.io",
  LINK_FROM_NAME: "BizInsights",
  STAFF_FROM_EMAIL: "staff@bizinsights.io",
  STAFF_FROM_NAME: "BizInsights",
  SUPPORT_EMAIL: "support@bizinsights.io",
  LOG_LEVEL: "silent",
};
