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
| Search | `find_ad_performance` | Find Ad Performance (stored Meta and Google Ads figures for dates) |
| Search | `find_adsense_earnings` | Find AdSense Earnings (stored estimates for dates) |

Every trigger is a REST hook (instant). There is no action: nothing in bizinsights changes from
Zapier and nothing is sent to customers. How it works on bizinsights' side, the payloads and the
security model: [docs/zapier.md](../../docs/zapier.md).

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

Later versions: bump `version` in `package.json`, `npx zapier-platform-cli push`, check the new
version has the three values (`npx zapier-platform-cli env:get <version>`; set them with `env:set`
if not), then `npx zapier-platform-cli promote <version>` to move users onto it.

Listing the app publicly in Zapier's directory (and Zapier's embedding, the Workflow API) needs
Zapier's review: until then merchants join through the invite link.
