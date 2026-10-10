# Advertising integrations: "Continue with Meta Ads", "Continue with Google AdSense" and "Continue with Google Ads"

**How a merchant uses it.**
1. The dashboard's **Advertising** section offers **Connect advertising accounts** while nothing is connected.
2. That opens **Settings → Advertising**, the integrations page.
3. They press **Continue with Meta Ads**, **Continue with Google AdSense** or **Continue with Google Ads**, and approve on the platform's own screen.
4. When the login can see several accounts and some are new, they tick the ones that belong to this store.
   - The sign-in waits on the server, encrypted, for 15 minutes.
   - One account, or a reconnect that sees nothing new, skips this step.
5. They land back on the **dashboard**. The Advertising section shows its numbers as the first sync arrives, usually within a minute or two:
   - KPI tiles, kept separate for spend and earnings;
   - money per day;
   - impressions and clicks per platform;
   - a by-platform comparison.

**Google Ads is not offered** (owner's choice, 2026-10-10): the integration stays in the code, and its card
appears only for a store that already has Google Ads accounts connected. To offer it again, add `"google"` to
`OFFERED` in `apps/web/src/app/(app)/settings/ads/page.tsx` and to `offered` in
`apps/web/src/components/dashboard/advertising.tsx`.

**Current Google Cloud state (project insights-511119, 2026-10-10):**
- The app is published (**In production**).
- Data Access lists only `adsense.readonly`, which is non-sensitive, so no verification is needed and merchants see no "unverified app" screen.
- The Google Ads scope `adwords` was removed while Google Ads is hidden. To bring Google Ads back, re-add `adwords` under Data Access. It's sensitive, so Google will then require verification, and until it's approved users see the unverified-app warning (capped at 100 users).

**The integrations page** is for management only:
- each platform's status (Connected, Syncing, Needs reconnecting, Sync problem, Not connected, Not set up);
- account details and last sync;
- the permission granted;
- Refresh, Reconnect or add accounts, Show on dashboard, and Disconnect.

If the person unticks or declines the one permission on the platform's screen, they're told so (`permission_missing`) and nothing is connected.

Merchants connect their ad accounts on **Settings → Ad accounts**. Insights then reads, every hour,
what each campaign spent and what it brought (views, clicks, purchases, leads, sales value) and
shows it on the dashboard's **Ads** card next to the store's own sales.

**Google AdSense** runs the other way: it is what the store's *site* earns from Google ads shown on
it. Its estimated earnings, page views, ads shown and clicks, per site and day, go on a separate
**Ad earnings** card, and are never added to ad spend.

Access is **read-only**: Meta's `ads_read` permission, Google's Ads reporting scope, and
`adsense.readonly`. Insights never creates, changes or pauses an ad. Tokens are stored encrypted with the same keyring as Shopify's
(`TOKEN_ENCRYPTION_KEYS`) and deleted when an account is disconnected or the store is removed.

Until the keys below are set, each button says its platform "isn't set up on this server yet".
Nothing else changes. AdSense needs only the Google OAuth client (id and secret): it has no
developer token, so it can work before Google Ads does.

| Setting | Where it goes | Secret? |
| --- | --- | --- |
| `META_APP_ID` | `apps/cloudflare/wrangler.jsonc` → `vars` | no |
| `META_APP_SECRET` | `npx wrangler secret put META_APP_SECRET` | **yes** |
| `META_CONFIG_ID` | `wrangler.jsonc` → `vars` (optional: Facebook Login for Business configuration) | no |
| `GOOGLE_ADS_CLIENT_ID` | `wrangler.jsonc` → `vars` (Google Ads **and** AdSense) | no |
| `GOOGLE_ADS_CLIENT_SECRET` | `npx wrangler secret put GOOGLE_ADS_CLIENT_SECRET` (Google Ads **and** AdSense) | **yes** |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | `npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN` | **yes** |
| `META_API_VERSION`, `GOOGLE_ADS_API_VERSION` | `wrangler.jsonc` (`v25.0`, `v25`) | no |

Run the `wrangler secret put` commands from `apps/cloudflare`, then deploy.

The redirect (callback) addresses, which both platforms must have registered **exactly**:

- Meta: `https://insights.imeseban.workers.dev/api/ads/meta/callback`
- Google Ads: `https://insights.imeseban.workers.dev/api/ads/google/callback`
- Google AdSense: `https://insights.imeseban.workers.dev/api/ads/adsense/callback` (on the same Google OAuth client)

(For local development: `http://localhost:8787/api/ads/<provider>/callback`, with the keys in `apps/cloudflare/.dev.vars`.)

## 1. Meta (Facebook and Instagram ads)

1. Go to <https://developers.facebook.com/apps> with the Facebook account that manages the business, and **Create app**.
   - Use case: **Other**. App type: **Business**.
   - Connect it to your Meta Business portfolio.
2. In the app, add the **Facebook Login for Business** product.
   - Under its settings, add the Meta callback address above to **Valid OAuth Redirect URIs**.
   - Under **Configurations**, create one:
     - token type **User access token**;
     - assets: **Ad accounts**;
     - permission: **ads_read** only.
   - Copy its **Configuration ID** into `META_CONFIG_ID`. Meta recommends it over the `scope` parameter.
   - Leave `META_CONFIG_ID` empty if the app uses classic Facebook Login instead. Insights then asks for `scope=ads_read`, with `auth_type=rerequest` so a declined permission is asked again.
3. Add the **Marketing API** product.
4. In **App settings → Basic**:
   - copy the **App ID** into `META_APP_ID`;
   - copy the **App secret** into `META_APP_SECRET`.
   - Fill in the privacy policy URL (`https://insights.imeseban.workers.dev/privacy`) and an app icon. Both are needed before the app can go live.
5. **Who can connect.** While the app is in **Development** mode, only people with a role on the app (and their ad accounts) can connect. Add yourself and your test users under **App roles**.

   To let any merchant connect their own ad accounts, the app needs **Advanced Access to `ads_read`** through **App Review**, and Meta **Business Verification**. Meta asks for:
   - a screen recording of the connect flow and the Ads card;
   - an explanation that the data is shown read-only to the advertiser who connected it.

   Expect a few days to a few weeks.
6. Switch the app to **Live**.

**Token lifetime:** Meta user tokens last about **60 days** and can't be renewed silently. Settings shows "Meta access ends in N days" from 14 days before. When it ends, the account shows **Needs reconnecting** and pressing **Continue with Meta** again renews it. History is kept.

## 2. Google Ads

Google needs two things: an **OAuth client**, for the "Continue with Google" sign-in, and a **Google Ads API developer token**, which every reporting call carries.

### OAuth client (Google Cloud)

1. At <https://console.cloud.google.com/>, create or pick a project and enable the **Google Ads API** (APIs & Services → Library).
2. **OAuth consent screen**:
   - User type: **External**. App name: Insights.
   - Support email; app domain and privacy policy `https://insights.imeseban.workers.dev/privacy`.
   - Authorized domain: `insights.imeseban.workers.dev`.
   - Add the scope `https://www.googleapis.com/auth/adwords`.
3. **Credentials → Create credentials → OAuth client ID**, application type **Web application**:
   - add the Google callback address above under **Authorized redirect URIs**;
   - copy the **Client ID** into `GOOGLE_ADS_CLIENT_ID`;
   - copy the **Client secret** into `GOOGLE_ADS_CLIENT_SECRET`.
4. While the consent screen is in **Testing**, only the test users you list can connect, and their access expires after 7 days. To open it to everyone, **Publish** the app. Because the Ads scope is a sensitive scope, Google runs a verification. It needs:
   - the privacy policy;
   - a short video of the flow;
   - a domain you have verified.

### Developer token (Google Ads)

1. Sign in to a **Google Ads manager account** (create one at <https://ads.google.com/home/tools/manager-accounts/> if you don't have one; it's free).
2. Go to **Admin → API Center** and apply for a developer token.
3. A new token has **Test access**: it only works with test accounts. Apply for **Basic access**, filling in the form about the tool (read-only reporting for the store owners who connect). Approval usually takes a few business days.
4. Put the token in `GOOGLE_ADS_DEVELOPER_TOKEN`.

**Manager accounts:** a merchant who signs in with a Google account that reaches ad accounts through a manager account (an agency, say) gets each client account listed. Insights reaches them through the manager automatically (`login-customer-id`).

## 3. Google AdSense

AdSense uses the **same Google Cloud project and OAuth client** as Google Ads. In that project:

1. **APIs & Services → Library**: enable the **AdSense Management API**.
2. **Clients → your web client → Authorized redirect URIs**: add the AdSense callback address above.
3. **Data Access**: add the scope `https://www.googleapis.com/auth/adsense.readonly`. Google lists it as
   **non-sensitive** (only the Ads scope `adwords` is sensitive), so AdSense alone needs no sensitive-scope
   verification to publish the app.
4. While the app is in **Testing**, only its test users can connect, and their access lasts 7 days.

There is no developer token and no manager account. A Google login with no AdSense account gets
"That Google login has no AdSense account". An account that can't be split by site in reports is
read as daily totals for the whole account, shown as "All sites".

## 4. Turn it on

From `apps/cloudflare`:

```bash
npx wrangler secret put META_APP_SECRET
npx wrangler secret put GOOGLE_ADS_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
```

1. Put the two public ids in `wrangler.jsonc` and deploy (see `docs/deployment-cloudflare.md`).
2. The database needs migration `20261009185831_ad_accounts` (run `pnpm db:migrate` against the owner role **before** deploying).
3. Open **Settings → Advertising** (or press **Connect advertising accounts** on the dashboard).
   - Press **Continue with Meta Ads**, **Continue with Google AdSense** or **Continue with Google Ads**, and approve.
   - If the login sees several accounts, tick the ones for this store.
   - You land on the dashboard. Each new account's last 90 days are fetched in the background.
   - Untick **Show on dashboard** later for any account that isn't this store's.

## How numbers are counted

See `docs/kpis.md`, "Ads" and "Ad earnings (AdSense)". In short:

- **Spend, views and clicks** are exactly what the platforms bill and count.
- **Purchases and their value** are each platform's **own attribution**: Meta and Google can both claim the same sale, so they are never added into the store's sales.
- Only accounts in one currency are added together: the store's currency, when any account uses it. Others are listed as left out.
- Recent days are refreshed hourly. The last 30 days are fetched again daily, because the platforms keep crediting purchases for days after a click.
- Meta's purchases are counted with `use_unified_attribution_setting=true`: each ad set's own attribution setting, the way Ads Manager shows them.

## The Meta Ads report (dashboard → Ads → "Meta Ads report")

The Ads detail view has a table per connected Meta ad account, by **campaign, ad set or ad**:
spent, impressions, **reach**, **frequency**, **link clicks**, link click rate, cost per link
click, cost per 1,000 impressions, purchases, cost per purchase, purchase value and return on ad
spend, plus each row's delivery status (Active, Paused, In review, Rejected, Has issues...).

- It is asked of Meta for exactly the dates picked (`GET /workspaces/:ws/stores/:storeId/ads/meta/report?connection=&level=&from=&to=`), never added up from the stored days: reach counts each person once over the whole range, so daily reach can't be summed. The "Whole ad account" row is Meta's own account-level figure.
- Days follow the **ad account's** time zone. Ranges including today say the numbers are still coming in.
- Answers are cached in the coordinator for 10 minutes (ranges including today) or an hour (past ranges), and limited to 30 Meta reports per store and user per 10 minutes (`LIMITS.adsReport`), to stay inside Meta's rate limits.
- Expired or revoked access (Meta error 190, or `ads_read` taken back) turns the account to "reconnect" at once, and the report says so instead of showing old numbers as current.
- Read-only: there is no control that edits a campaign, budget or ad, and `ads_management` is never requested.

Merchants manage all three integrations (Shopify, WhatsApp, Meta Ads) from **Settings → Connect your business** (`/settings/integrations`): one button each, a status (Not connected, Connecting, Connected, Action required, Permission expired, Connection failed), the account and identifier, the last sync, and Reconnect / Disconnect.
