# Nango: one-click Meta Ads and Google AdSense through Nango's Connect UI

With a Nango key set, "Continue with Meta Ads" and "Continue with Google AdSense" no longer leave the
page for a full-page sign-in. Nango's **Connect UI** opens over the page, the merchant authorizes on
the platform's own consent screen (a popup), and the card finishes the connection. **Nango only brokers
the OAuth and keeps the tokens.** The grant is to bizinsights' own Meta app (971575545351940) and
Google OAuth client ("Insights web"). bizinsights then reads the platforms with its own code, exactly
as for a direct connection: the stored days, the Marketing view, AdSense earnings, ad spend against
Shopify sales, alerts and sync history.

What Nango does **not** change: Meta's App Review / Advanced Access for `ads_read` and Google's
verification are about bizinsights' app, which Nango signs in with. Until Meta grants Advanced Access,
only people with a role on the Meta app can connect Meta, through Nango or not (integrations-readiness.md).
AdSense has no such limit (`adsense.readonly` is non-sensitive, and the consent screen is published).

**State on 2026-10-22: built and tested against fakes shaped like Nango's documented API. It is off until
bizinsights' Nango environment exists and its key is stored. Nobody has queried a live Nango environment
yet.** See "What the owner has to do".

## How it works

```
Settings → Integrations / Advertising card — "Continue with Meta Ads" (or Google AdSense)
  POST /workspaces/:ws/stores/:store/ads/:provider/nango/session              (apps/api routes/adsNango.ts)
    → Nango: POST /connect/sessions {allowed_integrations: [bizinsights-meta-ads],
              tags: {end_user_id, organization_id, bi_store, bi_provider, bi_session: <nonce>},
              integrations_config_defaults: {authorization_params: {config_id: META_CONFIG_ID}}}
    ← {token (30 min), nonce}. Session state kept in the coordinator, bound to the person, workspace, store, platform.
  Browser: @nangohq/frontend openConnectUI (iframe connect.nango.dev) → platform consent popup
    → platform redirects to https://bizinsights.io/api/ads/nango/oauth-callback → 308 → api.nango.dev/oauth/callback
      (uses up this person's newest open session for that platform here; receipt cookie ads_nango_consent)
  Connect UI says {type: "connect", connectionId}
  POST .../ads/:provider/nango/finish {nonce, connectionId}
    → state used up; the session's consent came back through this browser (receipt + coordinator), else refused, untouched
    → Nango: GET /connections?connectionId= must carry the session's tags (else refused, untouched)
    → Nango: GET /connections/{id}?provider_config_key= → access token
    → Meta: /me/permissions has ads_read, /me (person), /me/adaccounts — every call signed with bizinsights' app secret
      Google: tokeninfo (person; refuses a token issued to another client), scope adsense.readonly, AdSense accounts
    → one account (or nothing new): connected, synced → /dashboard
      several: held 15 min for the choice → /settings/ads?choose=…
    → anything else: the grant is revoked and the Nango connection deleted
```

- A Nango connection is an ordinary `ad_connections` row with `source = 'nango'` and `source_login_id` = the
  Nango connection id. Its `access_token_enc` holds a **sealed reference** `{connection id, integration}` (same
  AAD as a token, re-encrypted on key rotation), never a token: only bizinsights' Nango secret key turns it into
  one. Every account of one sign-in shares the one ciphertext, as a direct sign-in's accounts do.
- Right before each Meta/AdSense call (sync, health read, live report) `accessTokenAndPerson` asks Nango for a
  working token (Nango renews one that expires within 15 minutes) and keeps it at most 4 minutes in memory.
  A grant the platform refused or Nango gave up renewing (424 / `invalid_credentials`, `refresh_exhausted`,
  `invalid_grant`), or a connection Nango no longer has, means **Reconnect** (`auth_expired`), as an expired
  direct token does. A passing failure (Nango backing off after a failed renewal, the platform's token endpoint
  down) is retried, never Reconnect. Meta's long-lived token still ends after about 60 days (renewing it doesn't
  move that): its end, as Nango reports it, is kept on the rows, so the "access ending" warning and Settings'
  countdown work as for a direct connection.
- No migration: `source` is a plain column, and the rest are existing columns.
- Same account connected directly and through Nango is **one** row: connecting it the other way moves it
  and gives back the access it held before (unless someone else's connection relies on it).
- **Giving access back.** Disconnecting the last account that reads through a Nango connection revokes the
  person's grant at the platform (Meta: `ads_read` only; Google: the grant) unless another connection of that
  person still relies on it (direct or Nango: both are grants to bizinsights' own app), or an account choice of
  theirs is still waiting, then deletes the connection at Nango with its tokens. Moving an account between a
  direct sign-in and Nango for the same person never revokes the grant the account now reads with. The same happens when the person who connected it leaves the workspace,
  when the store's data is erased, when an account choice is cancelled, when a sign-in ends without a connection,
  and on Meta's deauthorize / data deletion callbacks.
- **Leftovers.** A connection Nango made whose person closed the window before bizinsights finished it is let go
  by the */15 tick, 20 minutes after Nango's creation webhook, unless an account or a pending choice uses it.
  Without the creation webhook switched on, such a leftover stays at Nango (it counts toward the plan's connections).
- **Webhooks** (`POST /api/webhooks/nango`): `X-Nango-Hmac-Sha256` (hex HMAC-SHA256 of the raw body, the
  environment's webhook signing key; two keys comma-separated while rotating) is checked before anything is read;
  refusals are limited per IP. Each body is acted on once (24 h). `deletion` puts every account reading through
  the connection on Reconnect. `refresh` with `success: false` makes bizinsights ask Nango for a token itself:
  only a refused grant puts the accounts on Reconnect; a passing failure is left to the next sync. `refresh` with
  `success: true` (Nango's recovery) puts accounts back to active once the token works again. `creation` is
  noted for the leftover sweep (a delete Nango doesn't answer is tried again next tick). Other types are
  acknowledged and ignored.
- **The OAuth callback is bizinsights'.** Nango's environment uses `https://bizinsights.io/api/ads/nango/oauth-callback`
  as its callback URL. That route 308-redirects to `https://api.nango.dev/oauth/callback` with the query intact.
  So the consent screens and the redirect URIs registered with Meta and Google name bizinsights.io, the domain
  Google has verified, never nango.dev. **It forwards only for a person signed in to bizinsights who started an
  open Nango session in that browser** (cookie `ads_nango_state`). Signed out, someone else signed in, or no
  open session of theirs: refused, back to `/settings/ads?error=state_mismatch`. So a session token handed to
  someone else's page can't bring that person's consent back to the starter's store, because their consent
  never reaches Nango.
- **Each consent uses up one session, and a finish needs its own.** bizinsights can't tell which session a
  consent is for (the callback's `state` is Nango's own, made when Nango's popup opens, and Nango's API has no
  lookup for it), so the callback attributes it to the platform it is for: Google names the scopes granted
  (`scope`: AdSense's or Google Ads' read-only scope), Meta sends none. A consent uses up the newest of the
  signed-in person's open sessions *for that platform* in that browser that hasn't had one (coordinator
  `oauth:ads-nango-consent:<nonce>`, once per session), and leaves a receipt for it (httpOnly cookie
  `ads_nango_consent`, 30 minutes). A consent for a platform with no such session is refused. A callback
  without a code (declined, an error) goes on to Nango and uses nothing up. `/nango/finish` refuses
  (`state_mismatch`) a session whose consent didn't come back through this browser: both the receipt and the
  coordinator's note are needed, so a cookie made up by hand doesn't do. This closes the case of a person with
  an open session of their own who authorizes on another person's link: their consent is noted against their
  own session, and the starter's finish, never having had a consent come back in the starter's browser, is
  refused (the connection is left to the leftover sweep, which deletes it and gives the grant back).
  What is left: if the starter *also* completes a consent of their own in the same Nango session (from its
  Connect UI, in their own browser), their finish holds a receipt and could name the other person's
  connection, which carries the same session's tags. That needs the other person to authorize on the starter's
  link within the same 30 minutes while holding an open session of their own for the same platform. Closing it
  fully would mean sending Nango's whole API and its WebSocket through bizinsights.io (the Connect UI's
  `apiURL`), so the callback could see which Nango session a consent belongs to.
- Configuration (`packages/core/src/env.ts`): `NANGO_SECRET_KEY` and `NANGO_WEBHOOK_SECRET` (secrets),
  `NANGO_PROVIDERS` (default `meta,adsense`; add `google` once Google Ads connections are open), `NANGO_API_URL`.
  A platform goes through Nango only when it is listed **and** its own app's keys are set here
  (`META_APP_ID/SECRET`, `GOOGLE_ADS_CLIENT_ID/SECRET`). Its tokens are checked against them.
- The integration keys are fixed: `bizinsights-meta-ads` (Nango provider `facebook`, not `meta-marketing-api`:
  only `facebook` gets Nango's long-lived-token renewal), `bizinsights-google-adsense` (provider `google`, scopes
  `https://www.googleapis.com/auth/adsense.readonly,openid`), `bizinsights-google-ads` (provider `google`, scopes
  `adwords,openid`). `openid` is who the Google account is: Google's tokeninfo didn't name the person for an
  adsense.readonly-only token (first real connect, 2026-10-22), so its disconnect couldn't revoke the grant.
- The browser never sees a token: the session token is Nango's, single-integration and 30 minutes; the API's
  answers carry `source: "nango"` and nothing else of the credential.

## What the owner has to do

Nothing shows until step 3. Claude can't create the Nango account, see its keys, or change Meta's dashboard
for you (integrations-readiness.md, Meta rows).

1. **Nango account.** Sign up at https://app.nango.dev (free plan: **10 connections**, then Pay-as-you-go,
   US$50/month minimum including US$50 of usage, about US$0.29 per connection per month; Nango's pricing page
   on 2026-10-22). Use the **prod** environment for bizinsights.io.
2. **Environment Settings** (prod), in Nango's dashboard (no API for these):
   - Callback URL: `https://bizinsights.io/api/ads/nango/oauth-callback`
   - Webhook URL: `https://bizinsights.io/api/webhooks/nango`. Switch on the webhooks for new connections,
     refresh errors and deletions.
   - Copy the **secret API key** and the **webhook signing key**.
3. **Store both keys**, from a PowerShell on the PC with `aws login` done (copy each first; only `*` is shown):
   ```
   node infra/cdk/scripts/put-secrets.mjs --set NANGO_SECRET_KEY
   node infra/cdk/scripts/put-secrets.mjs --set NANGO_WEBHOOK_SECRET
   ```
4. **Create the integrations** from bizinsights' own keys, which never leave AWS except to Nango:
   ```
   node infra/cdk/scripts/nango-setup.mjs --check
   node infra/cdk/scripts/nango-setup.mjs --apply
   ```
5. **Register the callback with the platforms:**
   - Meta app 971575545351940 → Facebook Login for Business → Settings → Valid OAuth Redirect URIs: add
     `https://bizinsights.io/api/ads/nango/oauth-callback` (type it, click the suggestion under the field, then
     **Save Changes**; check after a reload), beside the existing `/api/ads/meta/callback`. Client OAuth login and
     Web OAuth login must be on.
   - Google Cloud project insights-511119 → client "Insights web" → Authorized redirect URIs: add the same URL,
     Save.
6. **Restart the functions** so they read the new secrets (a deploy, or the restart loop in aws-deployment.md).
7. **Then, with Claude:** connect one real Meta ad account and one AdSense account through the card, compare a
   week of figures with Ads Manager and AdSense for the same dates, time zone and currency, and record it below.

To switch Nango off again: empty `NANGO_PROVIDERS` in `apps/aws/src/settings.ts` (or remove the key). The
buttons go back to the direct sign-in, and connections made through Nango keep working while the key is there.

**"This platform isn't set up correctly on bizinsights' side" after Facebook's screen** (log: `nango connection's
token refused`, Meta's `Invalid appsecret_proof provided in the API argument`, code 100): Nango's
`bizinsights-meta-ads` holds another app id or secret than `META_APP_ID`/`META_APP_SECRET`, so Meta refuses
the proof bizinsights signs each call with. First seen 2026-10-23 20:41Z (it showed as "The platform didn't
accept the sign-in" then). `node infra/cdk/scripts/nango-setup.mjs --check` says which side is wrong: "Meta
accepts META_APP_SECRET" plus "client secret isn't the one in the app secret" means Nango's copy is stale, and
`--apply` copies AWS's to Nango. "Meta REFUSES META_APP_SECRET" means AWS's copy is wrong: store the App secret
from developers.facebook.com → App settings → Basic with `put-secrets.mjs --set META_APP_SECRET`, restart the
functions, then run `--apply`.

## A merchant connecting an account

1. Settings → Integrations (or Settings → Advertising), on the store's card: **Continue with Meta Ads** or
   **Continue with Google AdSense** (owners, admins, or members given "Manage integrations").
2. A window opens over the page. It shows Facebook's or Google's own screen for **bizinsights**, which asks for
   read-only access (`ads_read` / view AdSense data). Choose the login and, on Facebook, the ad accounts to share.
3. Back on the page: one account lands on the dashboard straight away. Several accounts lead to a list to tick
   the ones for this store.
4. The card says **Synchronizing** while the first 90 days are read, then **Connected**, with the last
   successful sync, data through, freshness and recent syncs. History is then walked back to 25 months. Recent
   days are refreshed about every hour, and recent conversions and AdSense's month-end figures are re-checked daily.
5. **Refresh**, **Reconnect**, **Change accounts** and **Disconnect** are on the card (on Settings → Advertising:
   **Sync data now**, **View data details**, **Reconnect account** and **Disconnect**). Disconnecting deletes the
   account's figures from bizinsights and hands bizinsights' access back to the platform once nothing else
   relies on it.

## Testing

- `packages/core/test/adsNango.test.ts`: the client against answers shaped like Nango's documented ones
  (sessions, connections and tags, tokens, deletes, error mapping, webhook HMAC and parsing).
- `apps/api/test/adsNango.test.ts`: the round trip on a database (session tags and Meta's config_id, finish
  checks against Nango's tags, one account vs the choice, sync with Nango's token, cancel, permission missing,
  a Google token issued to another client, a Meta token Meta won't take bizinsights' appsecret_proof for,
  disconnect with the grant still used or not, another workspace kept out,
  signed and replayed webhooks, the leftover sweep, the callback forward).
- Not done: anything against a live Nango environment (no account yet), and the comparison with Ads Manager
  and AdSense (step 7 above).
