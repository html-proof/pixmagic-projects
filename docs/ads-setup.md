# Advertising integrations: "Continue with Google Ads", "Continue with Meta Ads" and "Continue with Google AdSense"

**How a merchant uses it.**
1. The dashboard's **Advertising** section offers **Connect advertising accounts** while nothing is connected.
2. That opens **Settings → Advertising**, the integrations page.
3. They press **Continue with Google Ads**, **Continue with Meta Ads** or **Continue with Google AdSense**, and approve on the platform's own screen.
4. When the login can see several accounts and some are new, they tick the ones that belong to this store.
   - The sign-in waits on the server, encrypted, for 15 minutes.
   - One account, or a reconnect that sees nothing new, skips this step.
5. They land back on the **dashboard**. The Advertising section shows its numbers as the first sync arrives, usually within a minute or two:
   - KPI tiles, kept separate for spend and earnings;
   - money per day;
   - impressions and clicks per platform;
   - a by-platform comparison.

**Google Ads is offered again** (2026-10-11): its card comes first on Settings → Advertising, on
Settings → Connect your business, and on the dashboard's "Connect more". Until `GOOGLE_ADS_ENABLED` is "1" (with the
Google OAuth client id and secret set), the card says "Coming soon" and has no button; merchants are never asked for keys.

**Google retired developer tokens on 2026-09-09.** Google Ads API access now follows the **Google Cloud project** that
owns the OAuth client (insights-511119): there is no token and no manager account to set up
(<https://developers.google.com/google-ads/api/docs/api-policy/developer-token>). Access levels
(<https://developers.google.com/google-ads/api/docs/api-policy/access-levels>), set on Cloud console → Google Ads API →
Overview ("Access levels → Manage"):
- **Test**: test accounts only. Real accounts answer `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`, which Insights shows as
  "Google is still approving Insights for live Google Ads accounts" (`not_approved`), never as "no accounts".
- **Explorer**: real accounts, 2,880 operations a day (roughly 60 connected accounts at the hourly sync). Applied for with
  one button; Google may grant it within minutes.
- **Basic**: 15,000 a day; needs Explorer plus **brand verification** of the Cloud project.

**State on 2026-10-11:** Explorer **granted** to project insights-511119 within minutes of applying, and
`GOOGLE_ADS_ENABLED` is "1" in production. Remaining, for a clean consent screen:
1. ~~Explorer granted~~ (done).
2. The `adwords` scope added under Google Auth Platform → Data Access (it lists only `adsense.readonly` now). It's
   sensitive: until Google verifies the app, people signing in for Google Ads see the "Google hasn't verified this app"
   screen and new users are capped at 100. Verification needs the privacy policy, a short video of the connect flow
   (YouTube link) and a scope justification. AdSense sign-ins don't ask for `adwords`, so they stay unaffected.
3. ~~`"GOOGLE_ADS_ENABLED": "1"`~~ (done).

Verified 2026-10-11 against the real Google: the "Insights web" client accepted the production callback of the
time (the old deployment's address) and `http://localhost:8789/...` with the `adwords` scope and a PKCE challenge:
Google's own "Sign in to continue to Insights" page opens, with no error. The AWS callbacks below must be on the
client too before Google sign-in works there.

**The integrations page** is for management only:
- each platform's status (Connected, Syncing, Needs reconnecting, Sync problem, Not connected, Coming soon);
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

Until the keys below are set, each card says its platform's sign-in is "being switched on" (Coming soon),
without a button. Nothing else changes. AdSense needs only the Google OAuth client (id and secret), so it works
without Google Ads API access.

| Setting | Where it goes | Secret? |
| --- | --- | --- |
| `META_APP_ID` | `apps/aws/src/settings.ts` (`APP_SETTINGS`) | no |
| `META_APP_SECRET` | `node infra/cdk/scripts/put-secrets.mjs --set META_APP_SECRET` | **yes** |
| `META_CONFIG_ID` | `settings.ts` (optional: Facebook Login for Business configuration) | no |
| `META_ADS_ADVANCED_ACCESS` | `settings.ts`: `"1"` once Meta grants Advanced Access to `ads_read` (empty: Settings says only the app's testers can connect) | no |
| `GOOGLE_ADS_CLIENT_ID` | `settings.ts` (Google Ads **and** AdSense) | no |
| `GOOGLE_ADS_CLIENT_SECRET` | `node infra/cdk/scripts/put-secrets.mjs --set GOOGLE_ADS_CLIENT_SECRET` (Google Ads **and** AdSense) | **yes** |
| `GOOGLE_ADS_ENABLED` | `settings.ts`: `"1"` once the Cloud project has Explorer access or above | no |
| `META_API_VERSION`, `GOOGLE_ADS_API_VERSION` | `settings.ts` (`v25.0`, `v25`) | no |

Settings ship by merging to `main` (Deploy to AWS). Secrets go to Secrets Manager with `put-secrets.mjs`; the
functions read them when an instance starts.

The redirect (callback) addresses, which both platforms must have registered **exactly**:

- Meta: `https://d2mr8m2p1qkh58.cloudfront.net/api/ads/meta/callback`
- Google Ads: `https://d2mr8m2p1qkh58.cloudfront.net/api/ads/google/callback`
- Google AdSense: `https://d2mr8m2p1qkh58.cloudfront.net/api/ads/adsense/callback` (on the same Google OAuth client)

(Local development: since 2026-10-11 the production client "Insights web" no longer lists `localhost` redirect URIs, because
Google's OAuth policies want separate clients/projects per deployment tier for verification. To test Google sign-in locally,
create a separate OAuth client in a separate Cloud project with `http://localhost:8787/api/ads/<provider>/callback` and put
its id/secret in `apps/aws/.env`. Paste-ready review material for both platforms: `docs/ads-review-packs.md`.)

## 1. Meta (Facebook and Instagram ads)

**Insights' Meta Ads app (set up 2026-10-11):** "Insights", App ID `971575545351940`, owned by the Facebook account
sebanceo@gmail.com, Development mode, no business portfolio yet. Use case "Measure ad performance data with Marketing
API" (ads_read ready for testing). Facebook Login for Business: redirect URI
registered for the old deployment's address (strict mode, HTTPS; add the AWS Meta callback above); configuration "Insights ads reporting"
`1521935306664882` (General, user access token, ads_read only) = `META_CONFIG_ID`. Basic settings: app domain, privacy policy
`/privacy`, data deletion instructions `/data-deletion`, category Business and pages, Website platform. Still to do: the
app secret (`META_APP_SECRET`, pasted by the owner), an app icon, then a business portfolio + verification and App Review
for Advanced Access to ads_read before merchants outside the app's roles can connect. WhatsApp stays on "pixmagic"
(`1799660384680551`, `WHATSAPP_APP_ID`).

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
   - Fill in the privacy policy URL (`https://d2mr8m2p1qkh58.cloudfront.net/privacy`) and an app icon. Both are needed before the app can go live.
5. **Who can connect.** While the app is in **Development** mode, only people with a role on the app (and their ad accounts) can connect. Add yourself and your test users under **App roles**.

   To let any merchant connect their own ad accounts, the app needs **Advanced Access to `ads_read`** through **App Review**, and Meta **Business Verification**. Meta asks for:
   - a screen recording of the connect flow and the Ads card;
   - an explanation that the data is shown read-only to the advertiser who connected it.

   Expect a few days to a few weeks. Once Meta grants it, set `META_ADS_ADVANCED_ACCESS` to `"1"` and deploy: the
   "only testers can connect" note on the Meta Ads cards goes away.
6. Switch the app to **Live**.

**Token lifetime:** Meta user tokens last about **60 days** and can't be renewed silently. Settings shows "Meta access ends in N days" from 14 days before. When it ends, the account shows **Needs reconnecting** and pressing **Continue with Meta** again renews it. History is kept.

**When a Facebook login has nothing to connect:** Insights asks Meta's token inspector (`debug_token`, with the app token) which ad accounts the grant names, and Settings → Advertising says which case it is, with **Connect again**, **Open Ads Manager** and **Open Business settings**:
- `error=none_shared`: the person picked accounts on Facebook's screen but shared none. They connect again and edit what Insights can access.
- `error=no_accounts`: the login reaches no ad account. Business-portfolio ad accounts need the person assigned to them in Business settings → Ad accounts (admins too); a different Facebook login means logging out of Facebook in that browser first, since Facebook has no account chooser.

The callback logs `ads: nothing to connect for this login` with the reason and the account ids the grant names.

### Facebook says "Feature Unavailable"

"Facebook Login is currently unavailable for this app, since we are updating additional details for this app. Please try
again later." is Facebook's own page, shown instead of its login. Facebook never sends the person back to Insights, so
nothing reaches our logs. Two causes, both fixed in Meta, not in code:

1. **The Facebook account has no role on the app** (the usual one, for anyone other than the app's admin). While
   `ads_read` has only Standard Access ("Ready for testing"), Meta lets only the app's administrators, developers and
   testers grant it.
   - Now: add the person under App roles → Roles → **Testers** (by name, Facebook ID or username). They accept at
     <https://developers.facebook.com/requests/>, then press Continue with Meta Ads again.
   - For everyone: Advanced Access to `ads_read` (step 5 above), which needs Business Verification of a registered business.
2. **Meta has paused the app's login for everyone, admin included.** Open <https://developers.facebook.com/apps> with the
   admin's Facebook account. If it shows "Account confirmation needed: We've noticed unusual activity on this developer
   account", press **Confirm Account** and finish Meta's steps. Also look for required actions on the app dashboard.
   Seen on 2026-10-14 and again on 2026-10-15. A second administrator (another Facebook account of the owner's) keeps the
   app manageable while one account is blocked. Keep browser automation off developers.facebook.com: it is the likely
   trigger.

What Insights does about it:
- While `META_ADS_ADVANCED_ACCESS` isn't `"1"`, the Meta Ads card on Settings → Advertising and on Connect your business
  says, before the button sends anyone to Facebook, that only testers can connect and how to ask to be added. The link
  goes to the support email from `apps/web/src/lib/contact.ts`, or to `/support` while that's blank.
- Someone who presses Back from Facebook's page sees what it meant. The button doesn't stay on "Opening…" either.

## 2. Google Ads

Google needs an **OAuth client** for the "Continue with Google Ads" sign-in, in a Cloud project with **Google Ads API
access for real accounts** (Explorer or above). Developer tokens are gone (2026-09-09).

### OAuth client (Google Cloud)

1. At <https://console.cloud.google.com/>, create or pick a project and enable the **Google Ads API** (APIs & Services → Library).
2. **OAuth consent screen**:
   - User type: **External**. App name: Insights.
   - Support email; app domain and privacy policy `https://d2mr8m2p1qkh58.cloudfront.net/privacy`.
   - Authorized domain: `d2mr8m2p1qkh58.cloudfront.net`.
   - Add the scope `https://www.googleapis.com/auth/adwords`.
3. **Credentials → Create credentials → OAuth client ID**, application type **Web application**:
   - add the Google callback address above under **Authorized redirect URIs**;
   - copy the **Client ID** into `GOOGLE_ADS_CLIENT_ID`;
   - copy the **Client secret** into `GOOGLE_ADS_CLIENT_SECRET`.
4. While the consent screen is in **Testing**, only the test users you list can connect, and their access expires after 7 days. To open it to everyone, **Publish** the app. Because the Ads scope is a sensitive scope, Google runs a verification. It needs:
   - the privacy policy;
   - a short video of the flow;
   - a domain you have verified.

### API access level (Google Cloud)

1. Cloud console → **APIs & Services → Google Ads API → Access levels → Manage** (the Google Ads API Overview page).
2. Under **Upgrade access level**, with **Explorer** as the next level, press **Apply for access**. Google reviews it,
   often within minutes.
3. For more than about 60 connected accounts, complete **brand verification** (Google Auth Platform → Verification
   Center), then apply for **Basic** the same way.
4. Set `"GOOGLE_ADS_ENABLED": "1"` and deploy.

**Manager accounts:** a merchant who signs in with a Google account that reaches ad accounts through a manager account (an agency, say) gets each client account listed. Insights reaches them through the manager automatically (`login-customer-id`).

## 3. Google AdSense

AdSense uses the **same Google Cloud project and OAuth client** as Google Ads. In that project:

1. **APIs & Services → Library**: enable the **AdSense Management API**.
2. **Clients → your web client → Authorized redirect URIs**: add the AdSense callback address above.
3. **Data Access**: add the scope `https://www.googleapis.com/auth/adsense.readonly`. Google lists it as
   **non-sensitive** (only the Ads scope `adwords` is sensitive), so AdSense alone needs no sensitive-scope
   verification to publish the app.
4. While the app is in **Testing**, only its test users can connect, and their access lasts 7 days.

There is no Google Ads API access level to request for AdSense. A Google login with no AdSense account gets
"That Google login has no AdSense account". An account that can't be split by site in reports is
read as daily totals for the whole account, shown as "All sites".

## 4. Turn it on

Copy each secret to the clipboard and run its line (one at a time: it reads the clipboard):

```bash
node infra/cdk/scripts/put-secrets.mjs --set META_APP_SECRET
```

```bash
node infra/cdk/scripts/put-secrets.mjs --set GOOGLE_ADS_CLIENT_SECRET
```

1. Put the public ids (and `GOOGLE_ADS_ENABLED` once Google has granted Explorer) in `apps/aws/src/settings.ts` and merge to `main` (see `docs/aws-deployment.md`).
2. The database needs migrations `20261009185831_ad_accounts`, `20261010080000_adsense_daily` and `20261011130000_ad_connection_identity` (the **Deploy to AWS** workflow applies them, like every migration; the last one only adds two columns and an index).
3. Open **Settings → Advertising** (or press **Connect advertising accounts** on the dashboard).
   - Press **Continue with Meta Ads**, **Continue with Google AdSense** or **Continue with Google Ads**, and approve.
   - If the login sees several accounts, tick the ones for this store.
   - You land on the dashboard. Each new account's last 90 days are fetched in the background.
   - Untick **Show on dashboard** later for any account that isn't this store's.

## Security and the connection lifecycle

- **The sign-in.** One-time `state` in the coordinator (10 minutes), bound to the browser by an HttpOnly cookie, and the
  callback is only accepted for the signed-in person who started it. Codes are exchanged on the server only.
- **PKCE (Google Ads and AdSense).** The S256 challenge goes in Google's URL; the verifier stays in the coordinator with the
  state and goes only with the code exchange, so an intercepted code is useless. Meta documents PKCE only for its OIDC
  flow (which needs `openid` and doesn't cover Login for Business), so Meta relies on state + cookie + the app secret.
- **Tokens** are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEYS`, bound to their store and platform (AAD
  `ads:<provider>:<storeId>:<kind>`), never sent to the browser or logged.
- **Who signed in** is kept per connection (`external_user_id`: Google's `sub` from tokeninfo, checked to be a token issued to
  Insights' own client; Meta's app-scoped user id), with the permissions granted (`granted_scopes`). Migration
  `20261011130000_ad_connection_identity`.
- **Google refresh tokens.** Google sends one on consent (`prompt=consent`); if a sign-in comes back without one, the same
  person's existing refresh token is reused. If Google replaces a refresh token during a refresh, the new one is stored for
  every account that shares it.
- **Meta tokens.** A user token is swapped for a long-lived one (about 60 days; Settings warns from 14 days before). A Login
  for Business **system-user** token comes back without an expiry and is kept as it is.
- **Disconnect** deletes the token and every number fetched for that account, then gives the access back to the platform
  **only when no other connection relies on the same person's grant** (another store, or AdSense next to Google Ads, since
  Google revokes the person's whole grant to the client). Connections whose person isn't known yet (made before
  identities were kept, or whose lookup failed) count as possibly the same person, so nothing is revoked while any
  exist; a Google connection learns its person at its next token refresh. Google: `POST oauth2.googleapis.com/revoke`. Meta:
  `DELETE /me/permissions/ads_read` (only ads_read: WhatsApp keeps working). The outcome (`revoked`, `still_used`,
  `unknown_person`, `failed`) is in the response and the audit log.
- **Sync.** Ad syncs ride the sync queue; each tick's syncs are spread over 5 minutes and retries back off exponentially with
  jitter. Access that ended marks the account "reconnect"; history is kept.
- **Meta report jobs.** When Meta answers a big account's long range with "reduce the amount of data", the daily sync runs it
  as an asynchronous Insights report job (`POST /act_x/insights` → `report_run_id`, polled for about a minute).

## The Google Ads report (dashboard → Ads → "Google Ads report")

`GET /workspaces/:ws/stores/:storeId/ads/google/report?connection=&level=campaign|ad_group|device|country&from=&to=`:
spent, impressions, clicks, click-through rate, cost per click, cost per 1,000 impressions, conversions, cost per
conversion, conversion value and return on ad spend, with the account's own totals on top.

- Campaigns show their status (Active, Paused, Removed), type (Search, Shopping, Performance Max, YouTube...) and daily budget.
- Ad groups name their campaign; Performance Max has no ad groups, which the panel says.
- Countries are where the people who saw the ads were (`user_location_view`), named from Google's geo targets.
- Asked of Google for exactly those dates (GAQL, dates validated before they reach the query), in the account's time zone and currency.
- Cached 10 minutes (ranges including today) or an hour, inside the same 30-per-10-minutes limit as the Meta report.
- Access Google took back marks the account "reconnect" and the panel says so instead of showing old numbers.

The Meta Ads report also splits the whole account by **placement** (Facebook Feed, Instagram Stories...), **device**
and **country** (`breakdowns=publisher_platform,platform_position` / `impression_device` / `country`).

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

Merchants manage Shopify, WhatsApp, Google Ads and Meta Ads from **Settings → Connect your business** (`/settings/integrations`): one button each, a status (Not connected, Connecting, Connected, Action required, Permission expired, Connection failed, Coming soon), the account and identifier, the last sync, and Reconnect / Disconnect.
