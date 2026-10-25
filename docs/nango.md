# Nango: how every ad platform is connected

Meta Ads, Google Ads and Google AdSense are all connected through **Nango** (https://app.nango.dev,
bizinsights' **prod** environment). "Continue with Meta Ads / Google Ads / Google AdSense" opens Nango's
Connect UI over the page, the merchant authorizes on the platform's own consent screen (a popup), and the
card finishes the connection. **Nango brokers the OAuth and keeps and renews the tokens; it doesn't read
the platforms.** The grant is to bizinsights' own Meta app (971575545351940) and Google OAuth client
("Insights web"). bizinsights then reads each platform with its own code and API clients
(`packages/core/src/ads/`): the stored days, syncs and backfills, the Advertising area, AdSense earnings,
ad spend against Shopify sales, alerts and sync history ([ads-setup.md](ads-setup.md),
[advertising.md](advertising.md)).

There is no other way in any more: bizinsights' own OAuth (consent URLs, code exchange, PKCE, its callback
routes) was removed on 2026-10-24. Connections made by it before then are moved to Nango by themselves
(below, "Connections made before Nango").

WhatsApp doesn't use Nango. It runs on bizinsights' own Evolution API service, and a Cloud API
number's token, from Meta's Embedded Signup, is kept encrypted by bizinsights
([whatsapp.md](whatsapp.md)). The design of 2026-10-25 kept that token at Nango; it was replaced
before any store connected through it.

What Nango does **not** change: Meta's App Review / Advanced Access for `ads_read` and Google's
verification are about bizinsights' app, which Nango signs in with. Until Meta grants Advanced Access, only
people with a role on the Meta app can connect Meta. Until Google verifies the `adwords` scope, Google Ads
shows "Google hasn't verified this app" first and lets at most 100 people in (integrations-readiness.md).
AdSense has neither limit (`adsense.readonly` is non-sensitive and the consent screen is published).

## The platforms

| Platform | Nango integration | Made from Nango provider | Scopes | Read with |
| --- | --- | --- | --- | --- |
| Meta Ads | `bizinsights-meta-ads` | `facebook` (not `meta-marketing-api`: only `facebook` gets Nango's long-lived-token renewal) | none: Facebook Login for Business configuration `META_CONFIG_ID` sent as `config_id` (else `ads_read`, re-asked) | Marketing API `v26.0`, every call signed with `appsecret_proof` |
| Google Ads | `bizinsights-google-ads` | `google` | `https://www.googleapis.com/auth/adwords,openid` | Google Ads API `v25` (access level Explorer: 2,880 operations a day, counted by bizinsights) |
| Google AdSense | `bizinsights-google-adsense` | `google` | `https://www.googleapis.com/auth/adsense.readonly,openid` | AdSense Management API v2 |

The same environment also holds **`whatsapp-business`** (provider `whatsapp-business`, an API-key integration made in
Nango's dashboard on 2026-10-24, not by nango-setup.mjs), where the retired 2026-10-25 WhatsApp design kept each
store's token as the connection `wa-<storeId>`. Nothing writes to it any more; erasing a store still deletes that
store's retired token there (`whatsapp/purge.ts`), so keep it until the old WhatsApp tables are dropped
([whatsapp.md](whatsapp.md), "The old tables").

`openid` is who the Google account is: Google's tokeninfo didn't name the person for an
adsense.readonly-only token (first real connect, 2026-10-22), so its disconnect couldn't revoke the grant.
The integrations are made by `infra/cdk/scripts/nango-setup.mjs` from bizinsights' own keys
(`packages/core/src/ads/nango.ts` `NANGO_INTEGRATION`, `NANGO_PROVIDER_TEMPLATE`; Nango's API reference:
https://nango.dev/docs/reference/backend/http-api).

**A card offers Connect only when the sign-in can work** (`connectableAdProviders`,
`packages/core/src/adConnections/nango.ts`): the platform is in `NANGO_PROVIDERS` (all three by default),
`NANGO_SECRET_KEY` is set, the platform's own app is set up here (`META_APP_ID/SECRET`,
`GOOGLE_ADS_CLIENT_ID/SECRET`; Google Ads also `GOOGLE_ADS_ENABLED`), and Nango holds its integration, made
from the right provider and lacking no credential (`GET /integrations`, asked again every 5 minutes). Any
of those missing: the card says the platform isn't set up yet, with no button, and the log says which
integration is missing. Every deploy also warns when an ad app's id is set but `NANGO_SECRET_KEY` isn't
("Ad platforms through Nango isn't set up").

## How it works

```
Settings → Integrations / Advertising card — "Continue with Google Ads" (or Meta Ads, AdSense)
  POST /workspaces/:ws/stores/:store/ads/:provider/nango/session               (apps/api routes/adsNango.ts)
    → only for "Manage integrations", a verified email, a store of this workspace, 10 starts / 10 min / person;
      Google Ads not while bizinsights' daily operations are used up
    → Nango: POST /connect/sessions {allowed_integrations: [bizinsights-google-ads],
              tags: {end_user_id, organization_id, bi_store, bi_provider, bi_session: <nonce>},
              integrations_config_defaults (Meta: authorization_params.config_id)}
    ← {token (30 min), nonce}. Session state kept in the coordinator, bound to the person, workspace, store, platform.
  Browser: @nangohq/frontend openConnectUI (iframe connect.nango.dev) → platform consent popup
    → platform redirects to https://bizinsights.io/api/ads/nango/oauth-callback → 308 → api.nango.dev/oauth/callback
      (only for the signed-in person who started a session here; receipt cookie ads_nango_consent)
  Connect UI says {type: "connect", connectionId}
  POST .../ads/:provider/nango/finish {nonce, connectionId}
    → state used up; the session's consent came back through this browser (receipt + coordinator), else refused, untouched
    → Nango: GET /connections?connectionId= must carry the session's tags (else refused, untouched)
    → Nango: GET /connections/{id}?provider_config_key= → access token
    → Meta: /me/permissions has ads_read, /me (person), /me/adaccounts, every call signed with bizinsights' app secret
      Google: tokeninfo (person; refuses a token issued to another client), the scope granted, then the
      Google Ads customers it reaches (counted against the daily operations) or the AdSense accounts
    → one account (or nothing new): connected, its first 90 days queued → /dashboard
      several: held 15 min for the choice → /settings/ads?choose=…
    → anything else (no account, permission unticked, the platform refusing): the grant is revoked and the
      Nango connection deleted; the card words why
```

- **A connection** is an `ad_connections` row: `id`, `workspace_id` / `store_id` (ownership; RLS),
  `connected_by_user_id`, `provider`, `source = 'nango'`, `source_login_id` = the Nango connection id,
  `account_id` (the platform's stable id; unique per store and platform), `account_name`, `currency`,
  `timezone`, `status` / `error_code` / `last_error`, `account_status`, `granted_scopes`,
  `external_user_id` (who granted it), `last_synced_at`, `last_sync_attempt_at`, `synced_through`,
  `history_from`, `created_at` / `updated_at`. `access_token_enc` holds a **sealed reference**
  `{connection id, integration}` (same AAD as a token, re-encrypted on key rotation), never a token: only
  bizinsights' Nango secret key turns it into one. Every account of one sign-in shares the one
  ciphertext. Each sync is an `ad_sync_runs` row (trigger, dates, outcome, rows, reason); the figures are
  upserted into `ad_campaign_daily` / `adsense_daily` by account, campaign (site) and day, so a re-read or a
  reconnect never duplicates them.
- Right before each call (sync, health read, live report) `accessTokenAndPerson` asks Nango for a working
  token (Nango renews one that expires within 15 minutes) and keeps it at most 4 minutes in memory.
  A grant the platform refused or Nango gave up renewing (424 / `invalid_credentials`, `refresh_exhausted`,
  `invalid_grant`), or a connection Nango no longer has, means **Reconnect** (`auth_expired`). A passing
  failure (Nango backing off after a failed renewal, the platform's token endpoint down) is retried, never
  Reconnect. Meta's long-lived token still ends after about 60 days (renewing it doesn't move that): its end,
  as Nango reports it, is kept on the rows, so the "access ending" warning and Settings' countdown work.
- **Reconnecting** an account (or connecting one another way) keeps its row, its id and its stored days,
  and hands back the access the row held before unless something else relies on it: never a duplicate.
- **Giving access back.** Disconnecting the last account that reads through a Nango connection revokes the
  person's grant at the platform (Meta: `ads_read` only, with bizinsights' app token when the person's
  token has ended; Google: the grant) unless another connection of that person still relies on it (Google
  Ads and AdSense share one grant), or an account choice of theirs is still waiting, then deletes the
  connection at Nango with its tokens. The same happens when the person who connected it leaves the
  workspace, when the store's data is erased, when an account choice is cancelled, when a sign-in ends
  without a connection, and on Meta's deauthorize / data deletion callbacks. Disconnecting in bizinsights is
  not the same as removing bizinsights at Google or Facebook; Settings says how to do the latter.
- **Leftovers.** A connection Nango made whose person closed the window before bizinsights finished it is let
  go by the */15 tick, 20 minutes after Nango's creation webhook, unless an account or a pending choice uses it.
- **Webhooks** (`POST /api/webhooks/nango`): `X-Nango-Hmac-Sha256` (hex HMAC-SHA256 of the raw body, the
  environment's webhook signing key; two keys comma-separated while rotating) is checked before anything is
  read; refusals are limited per IP. Each body is acted on once (24 h). `deletion` puts every account reading
  through the connection on Reconnect. `refresh` with `success: false` makes bizinsights ask Nango for a token
  itself: only a refused grant puts the accounts on Reconnect. `refresh` with `success: true` (Nango's
  recovery) puts them back to active. `creation` is noted for the leftover sweep. Other types are
  acknowledged and ignored.
- **The OAuth callback is bizinsights'.** Nango's environment uses `https://bizinsights.io/api/ads/nango/oauth-callback`
  as its callback URL, which 308-redirects to `https://api.nango.dev/oauth/callback` with the query intact,
  so the consent screens and the redirect URIs registered with Meta and Google name bizinsights.io, never
  nango.dev. **It forwards only for a person signed in to bizinsights who started an open Nango session in
  that browser** (cookie `ads_nango_state`); otherwise it goes back to `/settings/ads?error=state_mismatch`.
- **Each consent uses up one session, and a finish needs its own.** bizinsights can't tell which session a
  consent is for (the callback's `state` is Nango's own, and Nango's API has no lookup for it), so the
  callback attributes it to the platform it is for: Google names the scopes granted (AdSense's or Google
  Ads' read-only scope), Meta sends none. A consent uses up the newest of the signed-in person's open
  sessions *for that platform* in that browser that hasn't had one (coordinator
  `oauth:ads-nango-consent:<nonce>`), and leaves a receipt (httpOnly cookie `ads_nango_consent`, 30
  minutes). `/nango/finish` refuses (`state_mismatch`) a session whose consent didn't come back through this
  browser: both the receipt and the coordinator's note are needed. What is left: if the starter *also*
  completes a consent of their own in the same Nango session, their finish holds a receipt and could name
  another person's connection made from the same session's link, within the same 30 minutes, while that
  person held an open session of their own for the same platform. Closing it fully would mean sending
  Nango's whole API and its WebSocket through bizinsights.io (the Connect UI's `apiURL`).
- The browser never sees a token: the session token is Nango's, single-integration and 30 minutes; the API's
  answers carry `source: "nango"` and nothing else of the credential (not the Nango connection id).
- The old addresses `/api/ads/{meta,google,adsense}/callback` sign nothing in: a browser still on its way
  back from a sign-in started before 2026-10-24 lands on Settings → Advertising, asked to press the button
  again (`state_expired`).

## Connections made before Nango

Until 2026-10-24 Google Ads (and Meta and AdSense where Nango wasn't on) were connected with bizinsights'
own OAuth: `source = 'direct'`, the platform's tokens sealed on the rows. They are moved to Nango without
the merchant doing anything (`packages/core/src/adConnections/migrate.ts`, run first in every */15 cron
tick, before the syncs are scheduled; at most 25 sign-ins a tick, one run at a time):

1. Each sign-in (the accounts connected in one go, sharing their tokens) is handed to Nango as one
   connection (`POST /connections`, Nango's import: OAuth2 access token, refresh token for Google, expiry),
   tagged with ids only (`end_user_id`, `organization_id`, `bi_store`, `bi_provider`, `bi_imported: direct`).
2. Nango is asked for a working token. For Google with `force_refresh=true`: Nango renews it at once with
   its integration's client, which proves the integration holds bizinsights' client and secret.
3. Only then are the rows rewritten (only over the ciphertexts read: a renewal the old way meanwhile leaves
   them for the next tick) to hold the sealed Nango reference, `source = 'nango'`, `source_login_id`, and no
   refresh token. Ids, settings (shown/hidden, AdSense sites), stored days and who granted it are kept. Each
   workspace's audit log gets `ads.moved_to_nango`.

Nothing is revoked and nothing is deleted. A sign-in Nango can't take (its integration missing, Nango's
plan full, Nango or the platform not answering, a renewal refused) stays exactly as it was: the Nango
connection is deleted again, the sign-in keeps working the old way (its own refresh token, still renewed by
`credentials.ts` with `GOOGLE_ADS_CLIENT_SECRET`), and it is tried again 6 hours later. A Meta token that
already ran out, or a row waiting for a reconnect, isn't moved: Reconnect goes through Nango.

**Watching it:** the log line `direct ad connections moved to Nango` says `moved`, `failed`, `waiting` and
`left` each tick that has something to say. When `left` has been 0 for a few days, the old way can be
removed (a pull request of its own: the direct branch of `accessTokenAndPerson`, `googleRefresh`,
`reencryptAdTokens`' refresh-token handling, this module, and then, as a separate migration, the
`refresh_token_enc` column).

**Rollback.** No schema change came with this. Rolling the functions back (the Deploy's automatic rollback,
or aws-deployment.md's by hand) leaves the moved rows working: every release since 2026-10-22 reads a row
with `source = 'nango'` for any platform. What a rollback brings back is the old Connect for Google Ads,
which bizinsights' own OAuth client still allows (its redirect URIs are kept until the old way is removed).

## What the owner has to do

Claude can't see Nango's keys, create Nango's integrations or change Meta's or Google's consoles for you.

1. **The integrations** (done 2026-10-24: `nango-setup.mjs --apply` created `bizinsights-google-ads` and gave
   `bizinsights-meta-ads` the app secret Meta accepts; `--check` then said all three "ok"). To check again, from a
   PowerShell on the PC with `aws login` done:
   ```
   node infra/cdk/scripts/nango-setup.mjs --check
   ```
   `--apply` fixes whatever it reports. bizinsights asks Nango again within 5 minutes.
2. **Meta's secret in Nango** must stay the app's: after a new App secret, store it with `put-secrets.mjs` and run
   `--apply` again (see "This platform isn't set up correctly" below).
3. **Nango's plan.** The free plan holds **10 connections**; each sign-in is one (an account choice of five
   accounts is one). Moving the older connections needs as many as there are direct sign-ins. Past the
   limit Nango refuses new ones: upgrade (Pay-as-you-go, US$50/month minimum including US$50 of usage, about
   US$0.29 per connection a month; Nango's pricing page on 2026-10-22) before merchants arrive.
4. **Environment Settings** (prod, Nango's dashboard; set 2026-10-22): Callback URL
   `https://bizinsights.io/api/ads/nango/oauth-callback`; Webhook URL `https://bizinsights.io/api/webhooks/nango`
   with the webhooks for new connections, refresh errors and deletions switched on. A local server uses a
   Nango **dev** environment of its own, never prod.
5. **Redirect URIs.** `https://bizinsights.io/api/ads/nango/oauth-callback` is registered with the Meta app's
   Facebook Login for Business and the Google client "Insights web" (2026-10-22). Once the log says `left: 0`,
   remove the old `https://bizinsights.io/api/ads/{meta,google,adsense}/callback` there.
6. **Then, with Claude:** connect one real account of each platform, compare a week of figures with Ads
   Manager, Google Ads and AdSense for the same dates, time zone and currency, and record it below.

Keys: `NANGO_SECRET_KEY` and `NANGO_WEBHOOK_SECRET` live in Secrets Manager (`insights/production/app`,
`put-secrets.mjs --set`); `NANGO_PROVIDERS` and `NANGO_API_URL` are settings (`apps/aws/src/settings.ts`,
defaults in `packages/core/src/env.ts`). `META_APP_SECRET` stays in the app (it signs every Meta call and
Meta's callbacks); `GOOGLE_ADS_CLIENT_SECRET` stays for `nango-setup.mjs` and the connections not moved yet.
To stop offering a platform, leave it out of `NANGO_PROVIDERS`: its card says it isn't set up, and its
connections keep working.

**"This platform isn't set up correctly on bizinsights' side" after Facebook's screen** (log: `nango connection's
token refused`, Meta's `Invalid appsecret_proof provided in the API argument`, code 100): Nango's
`bizinsights-meta-ads` holds another app id or secret than `META_APP_ID`/`META_APP_SECRET`, so Meta refuses
the proof bizinsights signs each call with. First seen 2026-10-23 20:41Z (it showed as "The platform didn't
accept the sign-in" then). `node infra/cdk/scripts/nango-setup.mjs --check` says which side is wrong: "Meta
accepts META_APP_SECRET" plus "client secret isn't the one in the app secret" means Nango's copy is stale, and
`--apply` copies AWS's to Nango. "Meta REFUSES META_APP_SECRET" means AWS's copy is wrong: store the App secret
from developers.facebook.com → App settings → Basic with `put-secrets.mjs --set META_APP_SECRET` (it asks Meta
first and refuses a secret that isn't the app's), restart the functions, then run `--apply`. On 2026-10-24 the
check said "Meta REFUSES META_APP_SECRET ... Error validating client secret." with Nango holding the same value.

## A merchant connecting an account

1. Settings → Integrations (or Settings → Advertising), on the store's card: **Connect Google Ads**,
   **Connect Meta Ads** or **Connect Google AdSense** (owners, admins, or members given "Manage
   integrations"). Google Ads and Meta Ads first say what their screen shows while the platform still
   reviews bizinsights.
2. A window opens over the page. It shows Google's or Facebook's own screen for **bizinsights**, asking for
   read-only access (Google Ads reports, AdSense data, `ads_read`). Choose the login and, on Facebook, the
   ad accounts to share.
3. Back on the page: one account lands on the dashboard straight away. Several accounts lead to a list to
   tick the ones for this store.
4. The card says **Synchronizing** while the first 90 days are read, then **Connected**, with the last
   successful sync, the last attempt, data through, freshness and recent syncs. History is then walked back to
   25 months. Recent days are refreshed about every hour (Google Ads every 3 hours), and recent conversions
   and AdSense's month-end figures are re-checked daily.
5. **Sync now**, **Reconnect**, **Change accounts** and **Disconnect** (with a confirmation) are on the card.
   Disconnecting deletes the account's figures from bizinsights and hands bizinsights' access back to the
   platform once nothing else relies on it.

## Testing

- `packages/core/test/adsNango.test.ts`: the client against answers shaped like Nango's documented ones
  (integrations, sessions, connections and tags, tokens and `force_refresh`, imports, deletes, error
  mapping, webhook HMAC and parsing).
- `apps/api/test/adsNango.test.ts`: the round trip on a database (which platforms can be connected, session
  tags and Meta's config_id, finish checks against Nango's tags, one account vs the choice, sync with Nango's
  token, cancel, permission missing, a Google token issued to another client, a Meta token Meta won't take
  bizinsights' appsecret_proof for, disconnect with the grant still used or not, another workspace kept out,
  signed and replayed webhooks, the leftover sweep, the callback forward).
- `apps/api/test/ads.test.ts`, `adsLifecycle.test.ts`: every platform connected through Nango
  (`test/nangoFake.ts`, a fake Nango in front of each platform's fake): the account choice, reconnect without
  duplicates, Google Ads through Nango, giving access back (Meta's app-token revoke included), the reports,
  the old callback's answer.
- `apps/worker/test/adsMigrate.test.ts`: moving direct connections (one Nango connection per sign-in, ids
  and days kept, Google renewed at once, Nango refusing, an integration missing, rows renewed meanwhile, no
  Nango at all).
- `apps/web/e2e/adsNango.spec.ts`, `integrations.spec.ts`: the card with the real `@nangohq/frontend` SDK and
  a stand-in Connect UI page.
- **Not done:** anything against the live Nango environment beyond the first AdSense connect of 2026-10-22,
  Google Ads through Nango with a real account (its integration exists since 2026-10-24), the move of the
  production connections (it runs after the deploy), and the comparison with Ads Manager, Google Ads and
  AdSense (step 6 above).
