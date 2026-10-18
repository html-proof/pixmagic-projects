/**
 * The app's non-secret settings, the same in every environment: the CDK app puts them in the
 * functions' environment (infra/cdk/lib/app-stack.ts), and the local server (local.ts) starts from
 * them too, under whatever its env file sets. Left out on purpose: NODE_ENV, the addresses (APP_URL,
 * API_URL) and the Cognito ids, which each environment gets from its own stacks (the runtime
 * parameter, secrets.ts). Secrets are in Secrets Manager (infra/cdk/scripts/put-secrets.mjs).
 *
 * Keys stay quoted: packages/core/test/appConfig.test.ts reads the Shopify scopes from this file.
 */
export const APP_SETTINGS = {
  // The move from Firebase: the old project's public web API key (saas-89329). A first sign-in with a
  // password Cognito doesn't know yet is checked against Firebase once and moved over. Clear it to end
  // the migration window (docs/cognito-setup.md, "Ending the migration").
  "LEGACY_FIREBASE_API_KEY": "AIzaSyDsrFIOe52bv3ZD0PM_h_l6_Tm9q7Uzq4s",
  "SHOPIFY_API_KEY": "57e9ef75435db908617fdd46099afe0e",
  "SHOPIFY_SCOPES": "read_orders,read_products",
  // NOTE: under Shopify managed installation (use_legacy_install_flow = false) these two settings do
  // NOT decide what merchants are asked to grant - shopify-app/shopify.app.toml does, and only
  // `shopify app deploy` changes it. Clearing this one does not stop Shopify requesting a scope;
  // removing it from the toml and redeploying does. Keep both in step: the build fails otherwise
  // (packages/core/test/appConfig.test.ts). See docs/shopify-setup.md section 3e.
  "SHOPIFY_OPTIONAL_SCOPES": "read_customers,write_pixels,read_customer_events",
  "SHOPIFY_API_VERSION": "2026-10",
  // Stores the main app may be installed on. Empty means any store, which only holds once
  // Shopify has approved it for public distribution: until then it installs only on stores in
  // our developer organization, and anyone else gets "This installation link can't be used".
  // List those stores here and a merchant we can't serve is told so, instead of being sent to
  // a Shopify page that cannot work. Client stores get their own app below.
  "SHOPIFY_DEFAULT_APP_SHOPS": "",
  // Client stores with their own custom-distribution app (docs/shopify-setup.md, "A client's
  // store with its own app"). Fill in the client id from the Dev Dashboard and set the secret
  // with `node infra/cdk/scripts/put-secrets.mjs --set SHOPIFY_APP_SECRET_PIXMAGIC`, then deploy.
  //
  // "public" is the App Store app (shopify-app/shopify.app.public.toml), in the Pixmagic Partner
  // organization: the only one of our apps that can be submitted for review (the main app's
  // organization has no Partner account, and PixMagic's is custom-distributed for good). Its
  // secret: SHOPIFY_APP_SECRET_PUBLIC. Installs from its listing work through it already; new
  // stores are sent to it once SHOPIFY_INSTALL_APP below says "public".
  "SHOPIFY_EXTRA_APPS": "[{\"key\":\"pixmagic\",\"clientId\":\"bb0ea9e4ad8939a6a1513e4dbf8cbbf1\",\"shops\":[\"pixmagic.myshopify.com\"]},{\"key\":\"public\",\"clientId\":\"658431ae6a22c880e0ab2a0e2040a28a\",\"shops\":[]}]",
  // The app stores without one of their own are sent to (packages/core/src/apps.ts installTarget).
  // "default" until Shopify approves "public": an unapproved app installs only on development
  // stores of its own organization, and ours are in the main app's. Approved: set "public".
  "SHOPIFY_INSTALL_APP": "default",
  // Stores whose workspace is shown as an App Store install sees it (packages/core/src/apps.ts
  // appStoreWorkspace: only what the listing describes, connects through "public") though they are
  // connected through another app: "Insights Test", the store in the App Store reviewer's test
  // account. It is a development store of the main app's organization, which the unapproved
  // "public" app can't read, so it stays on the main app. Clear it once review is over.
  "SHOPIFY_APP_STORE_PREVIEW_SHOPS": "insights-test-gpjkykfc.myshopify.com",
  // Paid plans (packages/core/src/billing.ts): "1" lets merchants start one and applies each plan's
  // store limit. Off until they launch; turn it on together with BILLING_ENABLED in
  // apps/web/src/lib/features.ts (docs/shopify-app-store-compliance.md, "Billing").
  "BILLING_ENABLED": "",
  // App email (invitations, alerts) and Cognito's sign-in emails (codes, through the pool's custom
  // email sender, infra/cdk auth-stack.ts), sent by the mail provider (Resend, else SES): an
  // address on a domain verified there (bizinsights.io, records in Cloudflare DNS). The domain has
  // no mailbox, so replies go where a message names (an invitation: its sender).
  "EMAIL_FROM": "bizinsights <no-reply@bizinsights.io>",
  // Ad accounts ("Continue with Meta" / "Continue with Google Ads" / "Continue with Google AdSense"
  // on Settings → Ad accounts). Empty until the apps exist: the buttons then say the platform isn't
  // set up. GOOGLE_ADS_CLIENT_ID is the Google Cloud OAuth client "Insights web" (project
  // insights-511119), shared by Google Ads and AdSense. Set the secrets, then deploy.
  // docs/ads-setup.md walks through all three.
  // Meta Ads: the Meta app "Insights" (971575545351940, Facebook account sebanceo@gmail.com, created 2026-10-11; use case
  // "Measure ad performance data with Marketing API"). Meta Ads stays "Coming soon" until META_APP_SECRET is set.
  // WhatsApp runs on its own app (WHATSAPP_APP_ID below) and never borrows this app's secret.
  "META_APP_ID": "971575545351940",
  "META_API_VERSION": "v25.0",
  // Facebook Login for Business configuration "Insights ads reporting": user access token, ads_read only.
  "META_CONFIG_ID": "1521935306664882",
  // "1" once Meta grants the app Advanced Access to ads_read (App Review, after Business Verification).
  // Until then only people with a role on the app (admins, developers, testers: App roles → Roles) can
  // connect; Facebook shows everyone else "Feature Unavailable", so Settings warns before sending them.
  "META_ADS_ADVANCED_ACCESS": "",
  "GOOGLE_ADS_CLIENT_ID": "534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com",
  "GOOGLE_ADS_API_VERSION": "v25",
  // "1" once project insights-511119 has Google Ads API access for real accounts (Explorer or above,
  // Cloud console → Google Ads API → Overview) and the adwords scope is on its consent screen. Google
  // retired developer tokens on 2026-09-09, so there is no token to set. Empty: "Coming soon".
  // Explorer granted 2026-10-11 (2,880 operations a day on real accounts).
  "GOOGLE_ADS_ENABLED": "1",
  // WhatsApp Business Platform (Cloud API), docs/whatsapp.md. "Connect WhatsApp Business" (Meta's
  // Embedded Signup) needs the Meta app id (empty: META_APP_ID is used), the Facebook Login for
  // Business configuration id of its WhatsApp Embedded Signup variation, and the secrets
  // WHATSAPP_APP_SECRET (or META_APP_SECRET) and WHATSAPP_WEBHOOK_VERIFY_TOKEN. Until then the
  // dashboard says it isn't set up, and merchants can still connect with their own Meta app.
  // WhatsApp's Meta app: "pixmagic" (1799660384680551, portfolio "Testbusiness", the imeseban@gmail.com Facebook account).
  "WHATSAPP_APP_ID": "1799660384680551",
  "WHATSAPP_CONFIG_ID": "",
  "WHATSAPP_API_VERSION": "v25.0",
  // Email integrations (docs/email.md): "Connect Gmail / Google Workspace" and "Connect Outlook /
  // Microsoft 365". Empty until the OAuth clients exist (the buttons say so; SMTP works regardless).
  // Their secrets are in Secrets Manager. "common" accepts work, school and personal Microsoft accounts.
  "EMAIL_GOOGLE_CLIENT_ID": "",
  "EMAIL_MICROSOFT_CLIENT_ID": "",
  "EMAIL_MICROSOFT_AUTHORITY": "common",
} as const satisfies Record<string, string>;
