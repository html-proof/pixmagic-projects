# bizinsights on Zapier

The "bizinsights" app on Zapier's Developer Platform (Zapier CLI, `zapier-platform-core` 19.2.1). A
merchant connects their bizinsights store inside their own Zapier account (OAuth: bizinsights is the
provider, no keys or addresses to copy) and uses these in their Zaps:

| Kind | Key | What |
| --- | --- | --- |
| Trigger | `alert_raised` | New Alert: a sync or sign-in that stopped working (Shopify, ad accounts, WhatsApp, email) |
| Trigger | `ad_spend_threshold` | Ad Spend Passed an Amount (Meta, Google or both; per day or month) |
| Trigger | `adsense_earnings_threshold` | AdSense Earnings Passed an Amount (Google's estimates) |
| Trigger | `ads_daily_summary` | Daily Advertising Summary (yesterday per platform, Shopify's sales beside it) |
| Trigger | `whatsapp_message_failed` | WhatsApp Message Failed (number masked) |
| Trigger | `integration_connected` | Integration Connected (Meta Ads, Google Ads, AdSense, WhatsApp, Zapier) |
| Trigger | `integration_disconnected` | Integration Disconnected |
| Trigger | `sync_completed` | Ad Account Synced (at most once an hour per account) |
| Trigger | `order_paid` | Order Paid (number, amounts, items; never the customer) |
| Search | `find_ad_performance` | Find Ad Performance (stored Meta and Google Ads figures for dates) |
| Search | `find_adsense_earnings` | Find AdSense Earnings (stored estimates for dates) |
| Action | `send_whatsapp_template` | Send WhatsApp Template Message (since 1.2.0): one of the store's WhatsApp templates to one customer, e.g. a new Facebook Lead Ads or Google Ads lead |
| Trigger (hidden) | `whatsapp_templates` | The action's template dropdown |

Every listed trigger is a REST hook (instant), and every event carries `schema_version` (1). The
AdSense threshold's "When" is reaching the amount, or a finished day or month ending below it. The one
action sends only for a connection an owner or admin allowed to send ("Send WhatsApp template messages
to your customers", ticked on bizinsights' page when connecting), through the store's WhatsApp rules;
nothing else in bizinsights changes from Zapier. How it works on bizinsights' side, the payloads and
the security model: [docs/zapier.md](../../docs/zapier.md).

| Version | What it added |
| --- | --- |
| 1.0.0 | The first five triggers and two searches |
| 1.1.0 | AdSense "falls below", `schema_version`, Integration Connected / Disconnected, Ad Account Synced, Order Paid |
| 1.2.0 | The action Send WhatsApp Template Message (and its hidden template list) |

This folder is **not** part of the pnpm workspace: it has its own `npm install`, its own
`package-lock.json`, and CI neither installs nor type-checks it (`pnpm lint` does lint it).

## Run the tests

```powershell
cd integrations\zapier
npm install
npm test
```

The tests fake bizinsights with nock and check the definition against Zapier's schema (what
`zapier validate` runs first).

## Owner setup: register and push the app

You need a Zapier account (the owner's) and Node 18.20 or later. PowerShell, one line at a time.

1. Install and sign in to Zapier's CLI:

   ```powershell
   cd integrations\zapier
   npm install
   npx zapier-platform-cli login
   ```

2. Register the app (once). It writes `.zapierapprc` with the app's id: commit that file, so every
   later push goes to the same app.

   ```powershell
   npx zapier-platform-cli register "bizinsights"
   ```

3. Push the first version:

   ```powershell
   npx zapier-platform-cli push
   ```

4. Make the OAuth client's id and secret. The id can be any name, e.g. `bizinsights-zapier`. The
   secret must be long and random:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

5. Give them to the Zapier app (the version you pushed, `1.0.0` the first time), with bizinsights'
   address:

   ```powershell
   npx zapier-platform-cli env:set 1.0.0 BASE_URL=https://bizinsights.io CLIENT_ID=bizinsights-zapier CLIENT_SECRET=<the secret>
   ```

6. Read the app's OAuth redirect URI (like `https://zapier.com/dashboard/auth/oauth/return/App123456CLIAPI/`)
   and its invite link:

   ```powershell
   npx zapier-platform-cli describe
   npx zapier-platform-cli users:links
   ```

   (The redirect URI is also under the app's Authentication page on developer.zapier.com, and the
   invite link under Manage → Sharing.)

7. Give bizinsights the same values:
   - `apps/aws/src/settings.ts`: `ZAPIER_CLIENT_ID` (step 4's id), `ZAPIER_REDIRECT_URI` (step 6,
     exactly as Zapier shows it, trailing slash included), `ZAPIER_INVITE_URL` (step 6's invite link).
   - The secret into Secrets Manager: copy it, then
     `node infra/cdk/scripts/put-secrets.mjs --set ZAPIER_CLIENT_SECRET` (it reads the clipboard).
   - Commit, open a pull request, merge it on green; Deploy to AWS puts it live. The deploy's config
     check then says `zapier: { configured: true }`.

8. Try it: in Zapier, make a Zap with a bizinsights trigger, connect bizinsights (bizinsights' page
   opens: sign in, choose the store, Allow), test the trigger, turn the Zap on.

9. Show the card to merchants: set `ZAPIER_ENABLED = true` in `apps/web/src/lib/features.ts` (a pull
   request of its own). Settings → Integrations then shows Zapier with Connect (the invite link).

Listing the app publicly in Zapier's directory (and Zapier's embedding, the Workflow API) needs
Zapier's review: until then merchants join through the invite link.

## A new version: staging, then promote

A pushed version is private to the app until it is promoted, and existing Zaps stay on the version
they use until they are migrated. So a new version is tried by the owner first (staging), then
promoted. PowerShell, from `integrations\zapier`, one line at a time.

1. **Only once bizinsights is live with what the version calls.** Its pull request merged, the
   **Deploy to AWS** run on that merge green, and `https://bizinsights.io/api/version` showing the
   merge commit. Before that, a Zap turning on a new trigger is refused (400) by the bizinsights
   still running.
2. Bump `version` in `package.json` (`npm version minor --no-git-tag-version` also updates
   `package-lock.json`), then `npm test`.
3. Push it. It isn't promoted: nobody's Zaps move.

   ```powershell
   npx zapier-platform-cli push
   ```

4. Give it the environment of the version in use, without showing a value: `env:get --format raw`
   prints only JSON, read into a variable here; `env:set` prints what it sets, so its output is
   thrown away. Then list the new version's keys (names only).

   ```powershell
   $from = "1.0.0"; $to = "1.1.0"
   $vars = (npx zapier-platform-cli env:get $from --format raw | Out-String) | ConvertFrom-Json
   $pairs = @($vars | Where-Object { $_.key -in "BASE_URL", "CLIENT_ID", "CLIENT_SECRET" } | ForEach-Object { "$($_.key)=$($_.value)" })
   npx zapier-platform-cli env:set $to @pairs | Out-Null
   Remove-Variable vars, pairs
   ((npx zapier-platform-cli env:get $to --format raw | Out-String) | ConvertFrom-Json).key
   ```

   The last line must list `BASE_URL`, `CLIENT_ID` and `CLIENT_SECRET`.

5. Stage it: move only your own Zaps onto it, and try what changed.

   ```powershell
   npx zapier-platform-cli migrate 1.0.0 1.1.0 --user=<your Zapier email>
   ```

   In Zapier, open a Zap with each new or changed trigger, **Test trigger** (the samples are the
   store's own events: none yet means bizinsights has none of that kind for the store), turn it on,
   and check bizinsights' Settings → Integrations lists the trigger. Something wrong: move back with
   `migrate 1.1.0 1.0.0 --user=<your Zapier email>`, fix it, bump again and push.

6. Promote it, so new Zaps use it, then move everyone's existing Zaps onto it:

   ```powershell
   npx zapier-platform-cli promote 1.1.0
   npx zapier-platform-cli migrate 1.0.0 1.1.0
   ```

   A version that only adds triggers or fields is safe to migrate. One that renames or removes a
   field a Zap may map raises `schema_version` on bizinsights' side and needs Zapier's breaking-change
   path instead (a new major version, no automatic migration).

Don't push while someone is setting up or testing a Zap on the current version: Zapier's editor can
switch to the newest version under them.

