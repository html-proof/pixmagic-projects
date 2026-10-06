// Shared env for integration tests (imported by vitest configs).
// TEST_DB picks the database (must end in _test), so separate checkouts or
// parallel runs can each use their own; default app_test.
const db = process.env.TEST_DB ?? "app_test";
if (!/_test$/.test(db)) throw new Error(`TEST_DB must end in _test (got ${db})`);

export const testEnv = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3001",
  API_URL: "http://localhost:4000",
  DATABASE_URL: `postgresql://app:app@localhost:5434/${db}`,
  APP_DATABASE_URL: `postgresql://app_rls:app_rls@localhost:5434/${db}`,
  SESSION_SECRET: "test-session-secret-0123456789",
  TOKEN_ENCRYPTION_KEYS: "1:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
  OTP_PEPPER: "test-pepper-123",
  SHOPIFY_API_KEY: "test_key",
  SHOPIFY_API_SECRET: "test_secret",
  SHOPIFY_SCOPES: "read_orders,read_products",
  SHOPIFY_OPTIONAL_SCOPES: "",
  SHOPIFY_API_VERSION: "2025-10",
  // A second app, custom-distributed to one client store (multi-app support).
  SHOPIFY_EXTRA_APPS: JSON.stringify([{ key: "client", clientId: "client_key", shops: ["client-shop.myshopify.com"] }]),
  SHOPIFY_APP_SECRET_CLIENT: "client_secret",
  LOG_LEVEL: "silent",
};
