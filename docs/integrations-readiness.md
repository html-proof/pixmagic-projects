# Integrations readiness: Google, Meta and AWS checklist

The owner's checklist for opening Google Ads, Google AdSense, Meta Ads and "Continue with Google" sign-in to every
merchant. Each line says where it stands, why, and what happens next and who does it.

Last updated 2026-10-19. Status words:

- **Completed**: done and confirmed.
- **Pending**: can be done now, or is waiting on a step that is under way.
- **Blocked**: can't start until another item is finished (named in the line).
- **Not applicable**: nothing to do.

"This branch" means `claude/google-meta-oauth-integrations-dec503` (the Google/Meta integrations work). Anything that
says "after this branch's deploy" can be done once that branch is merged to `main` and its **Deploy to AWS** run has
succeeded.

Steps marked **Owner** need your own Google, Meta, Cloudflare or AWS login. Claude must not sign in to those consoles,
submit forms there or upload business documents for you, and never automates developers.facebook.com.

The detail behind each line: [ads-setup.md](ads-setup.md) (how the integrations work and every setting),
[ads-review-packs.md](ads-review-packs.md) (paste-ready answers, video scripts, step lists),
[cognito-setup.md](cognito-setup.md) (sign-in), [aws-deployment.md](aws-deployment.md) (secrets and deploys).

## Google (Cloud project insights-511119, OAuth client "Insights web")

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Search Console **Domain** property for bizinsights.io | Completed | Verified 2026-10-19 with a DNS TXT record in Cloudflare. Google only accepts a Domain property as proof you own the domain. | Never delete that TXT record: Google keeps re-checking it. (Owner) |
| Authorized domain `bizinsights.io` on the consent screen | Completed (2026-10-19) | Saved on Branding next to the old `imeseban.workers.dev`, which stays while "Insights web" still lists the workers.dev redirect URIs. | Once the old Worker is retired: remove the workers.dev redirect URIs on the client, then the workers.dev domain on Branding, save. (Owner or Claude on your word) |
| Branding (app name, logo, homepage, privacy, terms, contacts) | Completed (2026-10-19) | Saved with a 120x120 logo, re-verified ("I have fixed the issues") and published the same day: "Your branding has been verified and is being shown to users." Name **bizinsights**, homepage https://bizinsights.io/, privacy /privacy, terms /terms. | None. Changing the name, logo or links later sends it back for verification. |
| Redirect URIs on "Insights web" | Completed (2026-10-19) | Both bizinsights.io callbacks added and saved (they were missing, so Connect from bizinsights.io failed with a redirect error). The two `insights.imeseban.workers.dev` callbacks are still listed; no JavaScript origins. | Remove the workers.dev pair when the old Worker is retired. (Owner or Claude on your word) |
| Scope list and justification | Completed | Checked 2026-10-19: Data Access lists exactly `adsense.readonly` (non-sensitive) and `adwords` (sensitive), with the justification. Audience: External, In production, 1 of 100 unverified-scope users used. | None until the demo video (next row). |
| `adwords` data-access verification | Pending | Branding is published (row above); still needs a demo video on YouTube (unlisted) and the justification in the Verification Center. Until it passes, Google Ads sign-ins show "Google hasn't verified this app" and new users count toward a lifetime cap of 100. | After branding is published: dry run, record the video (script in ads-review-packs.md), submit in Verification Center. (Owner, Claude can help with the dry run) |
| Google Ads API access level | Completed (Explorer) | Explorer granted to insights-511119 on 2026-10-11: real accounts, 2,880 operations a day, which the syncs budget for. Developer tokens were retired by Google on 2026-09-09, so there is no token to get. | None now. (Owner) |
| Google Ads API **Basic** access | Pending | Needs brand verification of the project (branding row above). Only needed past roughly 60 busy accounts. | After branding is verified: Google Ads API → Access levels → apply for Basic; then Claude sets `GOOGLE_ADS_DAILY_OPERATIONS` to the new figure. (Owner, then Claude) |
| AdSense Management API enabled | Completed | In use since 2026-10-10: AdSense connections sync in production. | None. |
| Publishing status "In production" | Completed | The consent screen is published (External), so anyone can sign in, not only test users. Re-check it shows "In production" before submitting. | Glance at Audience before submitting. (Owner) |
| Turn off the "unverified app" warning in bizinsights | Blocked | The Google Ads card warns merchants about Google's unverified-app screen while `GOOGLE_ADS_OAUTH_VERIFIED` is empty. | After Google approves `adwords`: Claude sets `GOOGLE_ADS_OAUTH_VERIFIED` to `"1"` in `apps/aws/src/settings.ts` and ships it through `main`. (Claude, on your word) |
| Homepage section on Google data (https://bizinsights.io/#google-data) | Pending | Written on this branch (`AdPlatforms.tsx`); it is live once this branch deploys. Documentation link 3 in the Google form points at it. | Approve the wording, merge, confirm the deploy; check the link opens the section. (Owner approves, Claude ships) |

### "Continue with Google" sign-in to bizinsights (separate from Google Ads)

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Sign in with Google in production | Pending | Off: the GitHub variable `GOOGLE_SIGNIN_CLIENT_ID` isn't set, so the deploy doesn't add Google to Cognito. This branch adds account linking, two-step verification and an optional own sign-in domain; none needs Google sign-in on. | Steps below, in order. cognito-setup.md section 2. |
| A separate Cloud project for sign-in | Pending | Must not be insights-511119: a project asking only `openid`, `email`, `profile` needs no verification. | Create the project, its consent screen (External, In production, those three scopes only). (Owner) |
| Its OAuth client and redirect URI | Pending | Redirect URI `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse` (or `https://auth.bizinsights.io/oauth2/idpresponse` with the own domain). | Create a Web client with that URI. (Owner) |
| Its secret in AWS | Pending | Read by the deploy; without it the sign-in stack's update fails and rolls back. | `node infra/cdk/scripts/put-secrets.mjs --env production --set GOOGLE_SIGNIN_CLIENT_SECRET` (reads the clipboard, must start with `GOCSPX-`). (Owner) |
| GitHub variable | Pending | `GOOGLE_SIGNIN_CLIENT_ID` in the repository's `production` environment. | Set it, then run **Deploy to AWS** on `main` and check the run succeeded. (Owner) |
| Own sign-in domain `auth.bizinsights.io` | Not applicable (optional) | Lets Google's screen show bizinsights.io instead of amazoncognito.com. Not required. | If wanted: cognito-setup.md section 7. (Owner, with Claude) |

## Meta (developer app "Insights", App ID 971575545351940)

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Developer app | Completed (Development mode) | Set up 2026-10-11: use case "Measure ad performance data with Marketing API", `ads_read` at Standard Access ("ready for testing"), Facebook Login for Business configuration 1521935306664882. In this state only people with a role on the app (admins, developers, testers) can connect; others see "Feature Unavailable". | Add anyone who must test under App roles → Testers. (Owner) |
| Business portfolio | Pending | Not created yet. Needed for Business Verification. You have the registered business name "bizinsights" and its documents. | Create a portfolio in Meta Business Settings with the registered name, address, phone and website https://bizinsights.io, make your Facebook account an Admin, then connect the app to it (App settings → Basic → Verification). (Owner) |
| Business Verification | Blocked | Needs the portfolio (row above). Meta checks the business against its registration documents. | Business Settings → Security Center → Start verification, upload the documents. bizinsights.io has no mailbox, so confirm by phone or by domain (DNS record in Cloudflare). Claude must not do this step. (Owner) |
| App settings on bizinsights.io | Pending | Domain, privacy, terms and data deletion fields still point at the old workers.dev address. | App settings → Basic: app domain `bizinsights.io`, privacy https://bizinsights.io/privacy, terms https://bizinsights.io/terms, data deletion (row below), site URL https://bizinsights.io/, a 1024x1024 icon. Save. (Owner) |
| Facebook Login for Business redirect URI | Pending | Must include `https://bizinsights.io/api/ads/meta/callback`; whether it does isn't recorded. Without it Connect fails. | Facebook Login for Business → Settings → Valid OAuth Redirect URIs: add it, press **Save Changes** at the bottom, reload to confirm. (Owner) |
| Deauthorize and data deletion callbacks | Blocked | Built on this branch; they exist only after its deploy. Deauthorize: `https://bizinsights.io/api/webhooks/meta/deauthorize`. Data deletion: `https://bizinsights.io/api/webhooks/meta/data-deletion`. Both need `META_APP_SECRET` in AWS. | After the deploy: Facebook Login for Business → Settings → Deauthorize callback URL; App settings → Basic → User data deletion → callback URL. Save. (Owner) |
| Require App Secret | Blocked | Every ads call sends `appsecret_proof` from this branch on, so Meta can then refuse calls without it. Turning it on before the deploy would break Meta syncs. | After the deploy: App settings → Advanced → Security → Require App Secret → on. (Owner) |
| App Review: Advanced Access to `ads_read` (and `public_profile`) | Blocked | Needs Business Verification first. Texts, video script and reviewer instructions are in ads-review-packs.md (Meta pack). | After verification: record the screencast, request Advanced Access for `ads_read` and `public_profile` only, submit. Then Access Verification (Tech Provider). (Owner) |
| Let every merchant connect in bizinsights | Blocked | The Meta card says only testers can connect while `META_ADS_ADVANCED_ACCESS` is empty. | After Meta grants Advanced Access: Claude sets `META_ADS_ADVANCED_ACCESS` to `"1"` and ships it through `main`; then switch the app to Live after the Data Use Checkup. (Claude on your word, then Owner) |

## AWS

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Provider secrets in production (`META_APP_SECRET`, `GOOGLE_ADS_CLIENT_SECRET`) | Pending (check) | Not checked from this branch. Without a secret, that platform's card says "Coming soon", its connections stop syncing, and Meta's callbacks answer 503. Every deploy now warns on the Deploy run for each provider whose id is set but secret missing. | Run `node infra/cdk/scripts/put-secrets.mjs --dry-run` and look for both names under `keys now:`; add a missing one with `--set <NAME>` (it checks the shape: Meta 32 hex characters, Google `GOCSPX-...`). Also read the warnings on this branch's Deploy run. (Owner) |
| This branch deployed | Pending | Needed before the Meta callbacks, Require App Secret and the #google-data link. Includes migration `20261019120000_ad_connection_health`. | Merge the pull request when CI is green and confirm **Deploy to AWS** succeeded. (Claude, with your go-ahead) |
| Meta API version | Completed | v26.0 since this branch. The build fails 90 days before a version's end, so a red build is the reminder. | Re-read Meta's changelog by 2027-04-17 (ads-setup.md, "Keeping the API versions current"). (Claude) |

## Order that saves time

1. Google: save branding → Verify Branding → publish → record the video → submit `adwords` verification.
2. Meta: create the business portfolio → Business Verification (with your documents).
3. Meanwhile: merge and deploy this branch, check the secrets, then in Meta register the callbacks, move the app
   settings to bizinsights.io and turn on Require App Secret.
4. After Meta verifies the business: App Review for `ads_read`.
5. After each approval: Claude flips `GOOGLE_ADS_OAUTH_VERIFIED` or `META_ADS_ADVANCED_ACCESS`.
