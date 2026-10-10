# Ad accounts: setting up "Continue with Meta" and "Continue with Google"

Merchants connect their ad accounts on **Settings → Ad accounts**. Insights then reads, every hour,
what each campaign spent and what it brought (views, clicks, purchases, leads, sales value) and
shows it on the dashboard's **Ads** card next to the store's own sales.

Access is **read-only**: Meta's `ads_read` permission and Google's Ads reporting scope. Insights never
creates, changes or pauses an ad. Tokens are stored encrypted with the same keyring as Shopify's
(`TOKEN_ENCRYPTION_KEYS`) and deleted when an account is disconnected or the store is removed.

Until the keys below are set, both buttons say the platform "isn't set up on this server yet".
Nothing else changes.

| Setting | Where it goes | Secret? |
| --- | --- | --- |
| `META_APP_ID` | `apps/cloudflare/wrangler.jsonc` → `vars` | no |
| `META_APP_SECRET` | `npx wrangler secret put META_APP_SECRET` | **yes** |
| `GOOGLE_ADS_CLIENT_ID` | `wrangler.jsonc` → `vars` | no |
| `GOOGLE_ADS_CLIENT_SECRET` | `npx wrangler secret put GOOGLE_ADS_CLIENT_SECRET` | **yes** |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | `npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN` | **yes** |
| `META_API_VERSION`, `GOOGLE_ADS_API_VERSION` | `wrangler.jsonc` (`v25.0`, `v25`) | no |

Run the `wrangler secret put` commands from `apps/cloudflare`, then deploy.

The redirect (callback) addresses, which both platforms must have registered **exactly**:

- Meta: `https://insights.imeseban.workers.dev/api/ads/meta/callback`
- Google: `https://insights.imeseban.workers.dev/api/ads/google/callback`

(For local development: `http://localhost:8787/api/ads/<provider>/callback`, with the keys in `apps/cloudflare/.dev.vars`.)

## 1. Meta (Facebook and Instagram ads)

1. Go to <https://developers.facebook.com/apps> with the Facebook account that manages the business, and **Create app**.
   - Use case: **Other**. App type: **Business**.
   - Connect it to your Meta Business portfolio.
2. In the app, add the **Facebook Login for Business** product.
   - Under its settings, add the Meta callback address above to **Valid OAuth Redirect URIs**.
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

## 3. Turn it on

From `apps/cloudflare`:

```bash
npx wrangler secret put META_APP_SECRET
npx wrangler secret put GOOGLE_ADS_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
```

1. Put the two public ids in `wrangler.jsonc` and deploy (see `docs/deployment-cloudflare.md`).
2. The database needs migration `20261009185831_ad_accounts` (run `pnpm db:migrate` against the owner role **before** deploying).
3. Open **Settings → Ad accounts**, press **Continue with Meta** or **Continue with Google**, and approve.
   - Every ad account the login can see is connected and shown on the dashboard.
   - Its last 90 days are fetched in the background.
   - Untick **Show on dashboard** for any account that isn't this store's.

## How numbers are counted

See `docs/kpis.md`, "Ads". In short:

- **Spend, views and clicks** are exactly what the platforms bill and count.
- **Purchases and their value** are each platform's **own attribution**: Meta and Google can both claim the same sale, so they are never added into the store's sales.
- Only accounts in one currency are added together: the store's currency, when any account uses it. Others are listed as left out.
- Recent days are refreshed hourly. The last 30 days are fetched again daily, because the platforms keep crediting purchases for days after a click.
