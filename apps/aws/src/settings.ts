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
  "SHOPIFY_API_KEY": "57e9ef75435db908617fdd46099afe0e",
  "SHOPIFY_SCOPES": "read_orders,read_products",
  // NOTE: under Shopify managed installation (use_legacy_install_flow = false) these two settings do
  // NOT decide what merchants are asked to grant - shopify-app/shopify.app.toml does, and only
  // `shopify app deploy` changes it. Clearing this one does not stop Shopify requesting a scope;
  // removing it from the toml and redeploying does. Keep both in step: the build fails otherwise
  // (packages/core/test/appConfig.test.ts). See docs/shopify-setup.md section 3e.
  "SHOPIFY_OPTIONAL_SCOPES": "read_customers,write_pixels,read_customer_events,read_inventory,read_locations,write_inventory",
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
  // "appstore" is the App Store app (shopify-app/shopify.app.appstore.toml, registered 2026-10-18),
  // in the Pixmagic Partner organization: the only kind of app of ours that can be submitted for
  // review (the main app's organization has no Partner account, and PixMagic's is
  // custom-distributed for good). Its secret: SHOPIFY_APP_SECRET_APPSTORE. Installs from its
  // listing work through it already; new stores are sent to it once SHOPIFY_INSTALL_APP below
  // says "appstore".
  // "public" (shopify.app.public.toml, 658431ae) is the first App Store app, whose submission the
  // owner chose to start over with "appstore". Keep it, and SHOPIFY_APP_SECRET_PUBLIC, while any
  // store is connected through it: that store's tokens, webhooks and reconnects use its credentials.
  "SHOPIFY_EXTRA_APPS": "[{\"key\":\"pixmagic\",\"clientId\":\"bb0ea9e4ad8939a6a1513e4dbf8cbbf1\",\"shops\":[\"pixmagic.myshopify.com\"]},{\"key\":\"public\",\"clientId\":\"658431ae6a22c880e0ab2a0e2040a28a\",\"shops\":[]},{\"key\":\"appstore\",\"clientId\":\"cf5c717dba9317707e0cd5f5d3408fd0\",\"shops\":[]}]",
  // The app stores without one of their own are sent to (packages/core/src/apps.ts installTarget).
  // "default" until Shopify approves "appstore": an unapproved app installs only on development
  // stores of its own organization, and ours are in the main app's. Approved: set "appstore".
  "SHOPIFY_INSTALL_APP": "default",
  // Stores whose workspace is shown as an App Store install sees it (packages/core/src/apps.ts
  // appStoreWorkspace: only what the listing describes, connects through "appstore") though they
  // are connected through another app: "Insights Test", the store in the App Store reviewer's test
  // account. It is a development store of the main app's organization, which the unapproved
  // App Store app can't read, so it stays on the main app. Clear it once review is over.
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
  // Who the codes, the shared links and Staff Management's emails come from (core/mail/senders.ts):
  // sign-up, sign-in, verification and password-reset codes from support@, dashboard invitations
  // from link@, employee portal invitations from staff@; everything else from EMAIL_FROM. All on
  // bizinsights.io, so Resend sends them as it does EMAIL_FROM. The emails tell people to write to
  // SUPPORT_EMAIL: bizinsights.io receives mail only once Cloudflare Email Routing forwards these
  // addresses (docs/aws-deployment.md, "App email").
  "OTP_FROM_EMAIL": "support@bizinsights.io",
  "OTP_FROM_NAME": "BizInsights Support",
  "LINK_FROM_EMAIL": "link@bizinsights.io",
  "LINK_FROM_NAME": "BizInsights",
  "STAFF_FROM_EMAIL": "staff@bizinsights.io",
  "STAFF_FROM_NAME": "BizInsights",
  "SUPPORT_EMAIL": "support@bizinsights.io",
  // Sign-in asks for a 6-digit code emailed by the app after the password (accounts with an
  // authenticator app keep that code instead). "" turns the step off; the password alone then
  // signs in. The codes last 60 seconds and one address gets at most these many an hour and a
  // day (apps/api/src/emailCode.ts; docs/cognito-setup.md, "Emailed codes").
  "AUTH_LOGIN_EMAIL_CODE": "1",
  "AUTH_CODE_LIMIT_HOURLY": "6",
  "AUTH_CODE_LIMIT_DAILY": "20",
  // Addresses whose password alone signs in (comma-separated): the bizinsights account given to
  // Meta's App Review reviewers, who can't read its inbox (docs/ads-review-packs.md). Empty it
  // again once Meta has decided.
  "AUTH_LOGIN_CODE_EXEMPT": "",
  // Ad accounts ("Continue with Meta" / "Continue with Google Ads" / "Continue with Google AdSense"
  // on Settings → Ad accounts). Empty until the apps exist: the buttons then say the platform isn't
  // set up. GOOGLE_ADS_CLIENT_ID is the Google Cloud OAuth client "Insights web" (project
  // insights-511119), shared by Google Ads and AdSense. Set the secrets, then deploy.
  // docs/ads-setup.md walks through all three.
  // Meta Ads: the Meta app "Insights" (971575545351940, Facebook account sebanceo@gmail.com, created 2026-10-11; use case
  // "Measure ad performance data with Marketing API"). Meta Ads stays "Coming soon" until META_APP_SECRET is set.
  // WhatsApp's Cloud API option runs on this app too (WHATSAPP_APP_ID below is empty), with this app's secret.
  "META_APP_ID": "971575545351940",
  // Marketing API v26.0 (2026-07-29). Every call and field the ads code uses was checked against its
  // changelog on 2026-10-19: none changed, except the multiple-id lookup (GET /?ids=), which v26.0
  // refuses and every version does from 2026-10-27, so delivery statuses come from the account's
  // campaign, ad set and ad lists instead (packages/core/src/ads/meta.ts metaStatuses).
  "META_API_VERSION": "v26.0",
  // Facebook Login for Business configuration "Insights ads reporting": user access token, ads_read only.
  "META_CONFIG_ID": "1521935306664882",
  // "1" once Meta grants the app Advanced Access to ads_read (App Review, after Business Verification).
  // Until then only people with a role on the app (admins, developers, testers: App roles → Roles) can
  // connect; Facebook shows everyone else "Feature Unavailable" (Settings shows no note about it).
  "META_ADS_ADVANCED_ACCESS": "",
  "GOOGLE_ADS_CLIENT_ID": "534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com",
  "GOOGLE_ADS_API_VERSION": "v25",
  // "1" once project insights-511119 has Google Ads API access for real accounts (Explorer or above,
  // Cloud console → Google Ads API → Overview) and the adwords scope is on its consent screen. Google
  // retired developer tokens on 2026-09-09, so there is no token to set. Empty: "Coming soon".
  // Explorer granted 2026-10-11 (2,880 operations a day on real accounts).
  "GOOGLE_ADS_ENABLED": "1",
  // The project's Google Ads API operations a day, shared by every merchant: the syncs' budget (scheduled
  // ones stop at 80%, history at 60%). Empty: Explorer's 2,880. Set it when Google grants Basic or
  // Standard access (the figure shown in Cloud console → Google Ads API → Overview).
  "GOOGLE_ADS_DAILY_OPERATIONS": "",
  // "1" once Google verifies the app's use of the adwords scope (Google Auth Platform → Verification
  // Center: branding first, then data access with the demo video). Until then Google shows "Google
  // hasn't verified this app" before its consent screen (Settings shows no note about it). AdSense is unaffected.
  "GOOGLE_ADS_OAUTH_VERIFIED": "",
  // "1": the Google Ads card offers "Try demo", a simulated account whose figures bizinsights generates
  // itself (docs/ads-demo.md): nothing is read from Google, and the demo is marked as one wherever it
  // shows. Offered to members who may manage integrations; empty hides the button.
  "GOOGLE_ADS_DEMO_ENABLED": "1",
  // WhatsApp Automation (docs/whatsapp.md) runs on Meta's WhatsApp Business Platform only, connected
  // through Meta's Embedded Signup: the Meta app id (empty: META_APP_ID is used), the Facebook Login
  // for Business configuration id of its WhatsApp Embedded Signup v4 variation (WHATSAPP_CONFIG_ID),
  // and the secrets WHATSAPP_APP_SECRET (or META_APP_SECRET) and WHATSAPP_WEBHOOK_VERIFY_TOKEN. Meta
  // onboards a business only once it has approved bizinsights as a Tech Provider.
  // Empty since 2026-10-25 (the owner's choice): WhatsApp runs on the Meta Ads app "Insights"
  // (META_APP_ID, portfolio Zodiix Pty Ltd), so META_APP_SECRET serves and WHATSAPP_APP_SECRET stays
  // unset. It ran on "pixmagic" (1799660384680551, portfolio "Testbusiness") before; nothing was ever
  // connected through it. WHATSAPP_CONFIG_ID: the Insights app's Embedded Signup configuration
  // "bizinsights WhatsApp Signup" (made 2026-10-25 from Meta's template: Cloud API, WhatsApp
  // accounts, both whatsapp_* permissions, a 60-day system user token the health check refreshes;
  // docs/whatsapp.md, "Setting it up", step 4).
  "WHATSAPP_APP_ID": "",
  "WHATSAPP_CONFIG_ID": "2228218088074576",
  "WHATSAPP_API_VERSION": "v26.0",
  // Customer Messaging: SMS through AWS End User Messaging (docs/sms.md). "live" since 2026-10-25:
  // automations, campaigns and Send SMS hand texts to AWS, each after every check (sender verified
  // and tagged for the store, sending on, consent, opt-outs, quiet hours, the monthly limit). AWS
  // itself still decides who can receive: while the account is in its SMS sandbox (ACCOUNT_TIER
  // SANDBOX, US$1 a month, checked 2026-10-25) only verified numbers get texts, and the dashboard
  // says so ("Your SMS account is still being verified"). "sandbox" records automations' texts as
  // dry runs instead; "off" stops everything (docs/sms.md, "Rollback"). Marketing texts need this
  // switch and each store's own. The configuration set comes from the App stack.
  "SMS_MODE": "live",
  "SMS_MARKETING_ENABLED": "1",
  "SMS_ACCOUNT_MONTHLY_LIMIT_USD": "20",
  // A merchant asking for a sender name in Set up SMS emails this address: the platform owner
  // requests it from AWS, registers it where the country requires that, and tags it for the
  // workspace (docs/sms.md, "Sender names from Set up SMS").
  "SMS_SENDER_REQUESTS_TO": "bizinsightsaus@yahoo.com",
  // Email integrations (docs/email.md): "Connect Gmail / Google Workspace" and "Connect Outlook /
  // Microsoft 365". Empty until the OAuth clients exist (the buttons say so; SMTP works regardless).
  // Their secrets are in Secrets Manager. "common" accepts work, school and personal Microsoft accounts.
  "EMAIL_GOOGLE_CLIENT_ID": "",
  "EMAIL_MICROSOFT_CLIENT_ID": "",
  "EMAIL_MICROSOFT_AUTHORITY": "common",
} as const satisfies Record<string, string>;
