# Runbook

For on-call. Each entry: **symptom → check → fix**.

Production runs on AWS, see [aws-deployment.md](aws-deployment.md): the Lambda functions `insights-production-api` (UI + API, behind CloudFront and WAF), `-jobs` (the SQS queues) and `-cron` (the schedules and maintenance actions), RDS PostgreSQL, SQS with a dead-letter queue, a DynamoDB coordinator table, and WhatsApp's Evolution API service on ECS Fargate ([whatsapp.md](whatsapp.md)). `aws` commands assume `aws login --region ap-southeast-2`. Logs are in CloudWatch Logs, one group per function: `/aws/lambda/insights-production-api`, `-jobs`, `-cron`; the WhatsApp service's in `/ecs/insights-production-evolution-a`. The schedules are off until cutover (aws-deployment.md), so the `*/15` and nightly sweeps mentioned below don't run on AWS yet.

Secrets are in Secrets Manager (`insights/production/app`), set with `node infra/cdk/scripts/put-secrets.mjs --set NAME`; the functions read them when an instance starts (aws-deployment.md says how to get fresh instances). SQL runs as the owner role through the admin host (the database is private): start it, `aws ssm start-session --target <instance id>`, credentials from the `insights/production/db-owner` secret; stop it afterwards (aws-deployment.md, "Database").

## Health at a glance

| Check | Healthy |
| --- | --- |
| `GET <APP_URL>/api/readyz` | `200 {"ok":true,"checks":{"db":true,"coord":true,"tenantDb":true}}` |
| Alarms and the CloudWatch dashboard `insights-production` | no alarm in `ALARM` |
| Live logs: `aws logs tail /aws/lambda/insights-production-api --follow` (and `-jobs`, `-cron`) | no `"level":"error"` bursts |
| Queue backlog: dashboard → Queue depth (`insights-production-sync`, `-webhooks`, `-aggregate`, `-email`, `-whatsapp`) | draining; `insights-production-dlq` empty |
| Failed webhooks: `SELECT count(*) FROM webhook_events WHERE status='failed' AND received_at > now() - interval '1 day';` | ~0 |
| Stores in error: `SELECT shop_domain FROM stores WHERE status='error';` | none |
| Open alerts: `SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC;` | none critical |

## Alerts and what to do

### `sync_*_failed` (critical) – a store's sync failed after all retries
1. Read `sync_jobs.error` for the store.
2. `401`/`403` "merchant must reconnect": the merchant uninstalled or revoked the app, or - for a store still on a pre-2026-10-04 expiring token - its refresh token is no longer active. The store reaches `status = "error"`, which is terminal: nothing retries it. The dashboard says so and offers a Reconnect button; ask the merchant to use it, or Settings → Stores. Nothing else to do.
3. `429`/`5xx`: Shopify degraded. Check https://www.shopifystatus.com. Once healthy, trigger **Re-sync** (Settings → Stores, or `POST /workspaces/:ws/stores/:id/resync`).
4. "Sync stopped without reporting": the stale-job watchdog reaped it. The consumer was killed
   rather than failing - on Lambda usually the jobs function's 15-minute timeout or running out
   of memory, which end the invocation without our code throwing - so the job would otherwise
   have sat `running` forever and held the store in `syncing`. Check `/aws/lambda/insights-production-jobs`
   around `sync_jobs.started_at` for `Task timed out` or an out-of-memory exit; if that is the
   cause, a re-sync repeats it: the fix is in the job or the function's size (`fn("jobs", ...)`
   in `infra/cdk/lib/app-stack.ts`). `failStaleJobs` in `apps/worker/src/handlers/sweeps.ts` runs on
   the `*/15` cron and reaps anything `running` for over 30 minutes.
5. Data/normalisation error: capture the error, file a bug, then re-sync after the fix ships.
6. Resolve: `UPDATE alerts SET resolved_at=now() WHERE id='…';` and set `stores.status='active'` once a sync succeeds (it does this itself on a successful orders sync).

### `reconciliation_mismatch` (warning) – figures still differ from Shopify after the daily check
The check found figures it couldn't match or repair. Read its row (`reconciliations.findings`: the causes with order ids, and `days` with both sides per day), then see [Dashboard numbers look wrong](#dashboard-numbers-look-wrong). The next check that matches resolves it.

### `webhook_failed` (warning)
1. `SELECT topic, error, attempts FROM webhook_events WHERE status='failed' ORDER BY received_at DESC LIMIT 50;`
2. `Order … not found for refund …`: refund arrived before its order and the order never came. The daily reconcile fixes it; to fix now, re-sync the store.
3. To replay a single event you need the payload, which isn't stored. Re-sync (orders are re-pulled from Shopify) instead.

### `whatsapp-service-down`, `whatsapp-service-unreachable`, `whatsapp-service-memory` (alarms)
WhatsApp's Evolution API service: no task running, the sweep couldn't reach it, or its memory is
nearly full. Messages wait meanwhile. Steps in [whatsapp.md](whatsapp.md), "Runbook" (and
"Scaling" for memory).

### `sync-jobs-failed-for-good` (alarm) – ten or more sync jobs ran out of attempts in an hour
Counted: a sync-queue job's `"sync job failed"` line with `"final":true` on its sixth attempt (core's `MAX_ATTEMPTS`), so failures a retry should have got past. Not counted: a failure no retry helps, final on its first attempt (`UnrecoverableError`): a paused, frozen or closed shop (Shopify `402`/`404`/`423`), access Shopify refuses, protected customer data not approved, an ad connection marked for its merchant. Those come back with every store's daily reconcile and their merchants are told already. Each counted failure has reached its merchant too (a `sync_*_failed` alert, or the ad account's card); the alarm is for a cause they share.
1. Logs Insights on `/aws/lambda/insights-production-jobs`, the hour of the alarm: `filter @message like /"msg":"sync job failed"/ and @message like /"final":true/ and attempts >= 6 | stats count() by err.name, err.message`.
2. `429`/`5xx` from Shopify, Meta or Google after every attempt: an outage there (https://www.shopifystatus.com); the daily reconcile and the ad re-check fetch the days again once it is over.
3. The same error from our own code everywhere (a `TypeError`, a Prisma error) right after a release: a bug. `node infra/cdk/scripts/rollback.mjs`, or a forward fix, then re-sync the stores it stopped.
4. Not this alarm's to see: Shopify refusing every store's token at once (`401`/`403`, `"Shopify refused the store's token"` in the same log) is final at once. The stores turn to Reconnect with critical alerts; see [Webhooks returning 401 en masse](#webhooks-returning-401-en-masse) for the app's credentials.

### `ad-connections-need-merchants` (alarm) – ten or more ad connections turned to Reconnect or permission in an hour
Each connection logs `"ad connection needs the merchant"` once, when it turns (core's `recordAdFailure`), and its merchant gets an `ads_reconnect` alert. Many in an hour, across stores, means something changed for everyone.
1. Logs Insights on `/aws/lambda/insights-production-jobs`, `-api` and `-cron`: `filter @message like /ad connection needs the merchant/ | stats count() by provider, errorCode, storeId`.
2. All one `storeId`: one merchant's sign-in with many ad accounts ended. Nothing to do: their cards say Reconnect.
3. One `provider` across stores:
   - Meta, `auth_expired`: Meta stopped taking bizinsights' tokens. Check the app at developers.facebook.com (restricted, a review that took `ads_read` away, the app's mode), and whether `META_APP_SECRET` was changed recently (`put-secrets.mjs`). `scope_missing`: people's `ads_read` was taken back.
   - AdSense or Google Ads, `auth_expired`: Google stopped refreshing the tokens. Check the OAuth client in the Google Cloud project (deleted or its secret rotated without `put-secrets.mjs`, the consent screen back in Testing, where refresh tokens last 7 days).
   - `no_access` (permission) across stores: the platform answers its permission error differently now. Compare a real answer with `metaClassifyPermissionError` / `adsenseGet` and fix the classification.
4. Once the cause is fixed: a connection whose access really ended needs its merchant's Reconnect; one marked by our mistake goes back to working with the next sync that works (Refresh on its card).

### `ad-figures-differ` (alarm) – stored ad figures differ from the platform
The cron's daily check ([ads-setup.md](ads-setup.md), "Checked against the platform") found a figure of a settled week outside its tolerance. Merchants aren't told, and the connection isn't changed.
1. The line, in `/aws/lambda/insights-production-cron`: `filter @message like /ad figures differ from the platform/`. It names the `provider`, `connectionId`, the week (`since`, `until`, the account's own days), `currency`, the `field`, both sides (`stored`, `platform`) and `relative` ((stored − platform) ÷ platform).
2. What is stored, per day: `SELECT day, sum(spend), sum(impressions), sum(clicks), sum(link_clicks), sum(purchases), sum(purchase_value), string_agg(DISTINCT currency, ',') FROM ad_campaign_daily WHERE connection_id = '…' AND day BETWEEN '…' AND '…' GROUP BY day ORDER BY day;` (AdSense: `sum(earnings), sum(page_views), sum(impressions), sum(clicks)` from `adsense_daily`, every site). Set it beside Ads Manager for the same days in the ad account's time zone, attribution "each ad set's own setting" (AdSense: a report of the same dates).
3. What it usually means:
   - `currency`: rows stored in another currency than the account's (the account changed, or rows from another account): a re-sync of the days stores them again.
   - One day short or missing: a window that wasn't stored whole. The daily re-check stores the last 30 days again; if the next day's check still differs, the sync reads or stores something wrong.
   - Only `purchases` / `purchaseValue`: attribution or which actions count as purchases (`META_PURCHASE` in `packages/shared/src/ads.ts`).
   - AdSense `earnings` in the first days of a month: AdSense finalizing the month before; the re-check reads the whole month again until the 10th.
4. A difference that stays after the re-check has stored the week again is a bug in reading or storing: a forward fix with a test, then a re-sync of the account's days.

### Webhooks returning 401 en masse
`SHOPIFY_API_SECRET` doesn't match the app (secret rotated in the Partner dashboard but not in the app secret, or vice versa). `node infra/cdk/scripts/put-secrets.mjs --set SHOPIFY_API_SECRET`, then get fresh function instances (it takes effect only there). Shopify retries failed deliveries for 48 h, so nothing is lost if fixed promptly.

### `/readyz` says `"db":false`, or every API call fails
The database is unreachable from the functions. Queue consumers notice the same thing and re-send their jobs without spending an attempt, for up to 24 hours ([aws-architecture.md](aws-architecture.md#background-work)), so nothing is lost while it is down; the UI is.
1. The `/api/readyz` failure is logged as `"not ready"` with each probe's reason in `/aws/lambda/insights-production-api`.
2. RDS console → `insights-production`: status `Available`? Maintenance, a reboot or full storage show there. Dashboard → Database CPU / connections; alarms `insights-production-db-*`. Connections near the limit (about 200 on db.t4g.small) mean too many function instances at once.
3. Only `"tenantDb":false`: the `app_rls` login fails, for example because its password no longer matches `APP_RLS_PASSWORD` in the app secret. The migrate action sets it again: `aws lambda invoke --function-name insights-production-cron:live --cli-binary-format raw-in-base64-out --payload '{"action":"migrate"}' out.json`.
4. Re-check `/readyz`. Deferred jobs resume by themselves.

### Queue backlog growing
1. Dashboard → Queue depth and Jobs / cron errors; alarms `insights-production-queue-*-age`. The failures are in `/aws/lambda/insights-production-jobs`.
2. If the errors are database timeouts, see the `"db":false` entry above.
3. Concurrency is `maxConcurrency` per queue (`sources` in `infra/cdk/lib/app-stack.ts`, kept small while the account's Lambda concurrency is 10); raising it only helps when the consumers are healthy and Shopify is not the bottleneck. It ships by merging to `main`.
4. `insights-production-dlq` has no consumer (alarm `insights-production-dlq-not-empty`): messages there were given up on (after a long outage, or a crash). Re-sync the affected stores, or, once the cause is fixed, redrive them: `node infra/cdk/scripts/dlq.mjs` lists what is parked (kind and ids only), `--redrive --yes` sends it back to the queues it came from, `--status` follows the redrive (or the SQS console → the DLQ → Start DLQ redrive). Every job is safe to run twice ([automations.md](automations.md#runbook)).

### API 5xx spike
1. `/aws/lambda/insights-production-api`: every unhandled error is logged as `"unhandled error"` with the path (Logs Insights: `filter @message like /unhandled error/`).
2. CloudFront's error page or Lambda's own JSON instead of ours: the function never answered. Look for `Task timed out` in the log (55 s limit), the alarm `insights-production-api-throttles` (the account's concurrency is used up), or an out-of-memory exit.
3. A bad release: `node infra/cdk/scripts/rollback.mjs` (moves the `live` aliases back to the previous version, UI included). Do not roll back migrations; ship a forward fix.

### Users can't sign in
1. AWS Health Dashboard (Cognito in the pool's region); CloudWatch → Cognito metrics for throttling. Codes not arriving: they go through the `cognito-email` function and Resend (aws-deployment.md, "Sign-in emails"; cognito-setup.md, "Codes don't arrive").
2. `stale_sign_in` errors: client clock skew or a cached old ID token. They should sign in again.
3. Sign-in codes are Cognito's emails (item 1), not ours: `EMAIL_FROM` and SES only carry invitations and alerts. Our rate limit is 3 codes / 15 min per email.

### Dashboard numbers look wrong
1. Look at the store's last check against Shopify's records ("About this data" on the dashboard, or `GET /workspaces/:ws/stores/:id/check`), or run one now. It reads the store's orders back from Shopify, repairs any that differ and records what it found ([kpis.md](kpis.md#checked-against-shopify)); `dryRun` only records, `days` reaches further back (60 at most without `read_all_orders`):

```bash
aws lambda invoke --region ap-southeast-2 --function-name insights-production-cron:live --cli-binary-format raw-in-base64-out --payload '{"action":"verify","shop":"shop.myshopify.com","days":7}' verify.json
```

   It runs as a job (a minute or two for a small store): its row in `reconciliations` (status, `findings`, `actions`) and `reconciliation_results` (per figure: Shopify's, ours before and after) say how it came out. `differences` left after a repair raise the `reconciliation_mismatch` alert: a bug to chase, with the order ids in `findings`.
2. Run the check against Shopify's own reports (a store that has granted `read_reports`; read-only, up to 21 ShopifyQL calls):

```bash
aws lambda invoke --region ap-southeast-2 --function-name insights-production-cron:live --cli-binary-format raw-in-base64-out --payload '{"action":"shopify-check","shop":"shop.myshopify.com"}' check.json
```

   Every figure of today, yesterday, the last 7/30/90 days, this month and last month, ours next to Shopify's, each `match`, `difference`, `sync_delay` (changes still being counted here), `definition_mismatch` (the pixel's tracked visits against Shopify's sessions) or `not_verifiable` (Shopify refused, or the period starts before the imported history). Owners and admins get the same from `GET /workspaces/:ws/stores/:id/shopify-check` (`?format=csv` downloads it). A `difference` on a sales figure is a bug to chase: both sides add up Shopify's sales records.
   Without `read_reports`, compare with Shopify Analytics by hand for the **same time zone, dates and comparison** (see [kpis.md](kpis.md)). Refunds count on the day they were made.
3. Recompute the store's daily aggregates from its orders and refunds (idempotent; see [Maintenance tasks](#maintenance-tasks)):

```bash
OPS_SHOP=shop.myshopify.com pnpm --filter @app/worker ops:recompute
```

4. Still off: re-sync the store (re-pulls 60 days).

### Older dates show "not imported" (no history before ~60 days)

That is Shopify's limit, not a fault: without `read_all_orders` it shares the last 60 days of orders.
The line under the dashboard's dates says which case the store is in (`data.history.access` in the
overview): `awaiting_shopify` means the app doesn't ask for the scope yet. The fix is Shopify's
approval, then declaring the scope (docs/shopify-setup.md, "To import more than 60 days of
history"). Once a store holds it, its full import reads a year at a time; the same line shows the
years in and the one being read. To see a stopped import's years:

```sql
SELECT year, status, orders, attempts, error, finished_at FROM order_history_windows WHERE store_id = '<id>' ORDER BY year DESC;
```

A `failed` year resumes on the next full import (the dashboard retries an `error` store about every
half hour, or Settings → Shopify → Reconnect).

## Maintenance tasks

`pnpm --filter @app/worker ops:<task>` from the repo root runs a task in `apps/worker/ops/` against the database in the repo-root `.env` (or the file named by `OPS_ENV_FILE`). That file needs the **owner-role** `DATABASE_URL` and the **same** `TOKEN_ENCRYPTION_KEYS` as the deployed app (the `insights/production/app` secret). `.env.example` points `DATABASE_URL` at the development database (`app_dev`); for production, use a separate `OPS_ENV_FILE` to keep the two apart. Production's database is private: reach it through the admin host (a Systems Manager port forward to the database's port 5432; aws-deployment.md, "Database") with the credentials from the `insights/production/db-owner` secret. In Windows PowerShell set variables first: `$env:OPS_SHOP = "shop.myshopify.com"`, then run the `pnpm` line on its own.

| Task | What it does |
| --- | --- |
| `ops:recompute` | Rebuilds `daily_store_metrics` for `OPS_SHOP` from its orders and refunds. |
| `ops:reencrypt` | Re-encrypts everything stored under `TOKEN_ENCRYPTION_KEYS` with the active key: Shopify and ad-platform tokens, WhatsApp Automation's connections (instance token, webhook key, linked number), test number, contacts (number, first name), messages (number, send details, text) and webhook bodies waiting to be applied (the older `whatsapp_*` and `wa_*` tables, read by nothing, are left as they are; docs/whatsapp.md), and the inventory alerts' WhatsApp numbers. Also re-wraps the email module's data keys (OAuth tokens, SMTP passwords, domain challenges, event data, recipients) under the active `EMAIL_CREDENTIAL_KEYS` key (or `TOKEN_ENCRYPTION_KEYS` when that is unset). Ad connections are picked by both ciphertexts (access and refresh token), not by `token_key_version`, and each sign-in's rows are rewritten together, only over what was read. |
| `ops:ad-persons` | Fills in who granted access (`ad_connections.external_user_id`: Google's account id, Meta's app-scoped user id) for ad connections that don't know it, one look-up per sign-in (Google: a token refresh first). Until a connection knows, a Disconnect looks the unknown ones up itself (10 sign-ins at most) and keeps the grant at Google or Meta for any it can't place, so run this once after this version is deployed, and again while it prints connections still without a person. A token that no longer works marks its connections "reconnect"; ones the platform wouldn't place stay unknown (their next sync tries again). Safe to repeat (`OPS_LIMIT` caps the sign-ins per run, default 200). |
| `ops:ad-health` | Reads only: how the ad connections stand (packages/core/src/adConnections/health.ts). Connections per platform and status; error codes; how many wait for a reconnect; the shown, active ones without a successful sync for a day (or never, an hour after connecting) and the ones failing 3+ syncs in a row, by connection id, platform account id, workspace and store; the last 24 hours of syncs by outcome and platform with the commonest failure codes; and which platforms this server offers Connect for. Ids and counts only: no token, ciphertext, email or account name, so its output can go into a ticket. Uses the same env file as the other tasks; it decrypts nothing. |

## Routine operations

### Rotate the token encryption key
1. Generate a key (`openssl rand -base64 32`) and prepend it: `TOKEN_ENCRYPTION_KEYS=2:<new>,1:<old>`. Set it in the app secret (`node infra/cdk/scripts/put-secrets.mjs --set TOKEN_ENCRYPTION_KEYS`, then fresh function instances) and in the `.env` the maintenance tasks use. New writes use v2; v1 still decrypts.
2. Re-encrypt existing data: `pnpm --filter @app/worker ops:reencrypt` (prints how many rows it rewrote).
3. Run it again: it must print `re-encrypted 0 rows` (rows written by the app between step 1 and step 2 are already on v2: a Google or AdSense token refresh re-seals the refresh token too, for every account of the sign-in). A run that meets a token it can't decrypt still re-encrypts everything else, then fails instead of printing 0, naming the part (the error log has the rows); deal with those rows and run it again. One case it settles itself: an ad sign-in still sealed with a key removed in an earlier rotation (an older version left Google refresh tokens behind) can't be read by anyone, so its tokens are deleted and its accounts wait for a reconnect (the merchant gets the "needs reconnecting" alert); the connection ids are logged as `ad tokens sealed with a removed key`. Before removing the old key, check both ad token columns with the owner-role connection; both counts must be 0:
   ```sql
   SELECT count(*) FROM ad_connections WHERE access_token_enc <> '' AND access_token_enc NOT LIKE 'v<new>.%';
   SELECT count(*) FROM ad_connections WHERE refresh_token_enc IS NOT NULL AND refresh_token_enc NOT LIKE 'v<new>.%';
   ```
   Only then remove `1:<old>` from both places. Someone in the middle of choosing which ad accounts to connect at that moment has to sign in to the platform again; nothing else is lost.

### Rotate the email credential key
Same steps as above with `EMAIL_CREDENTIAL_KEYS` (when it is set; otherwise the email module uses `TOKEN_ENCRYPTION_KEYS` and the steps above cover it). Each email secret has its own data key; `ops:reencrypt` only re-wraps those data keys, so it is quick. Set the same value in the maintenance `.env`.

### Email: an account needs reconnecting (`email_account_reauth:*` alert)
Google or Microsoft rejected the stored authorization (revoked in the user's account, password change, consent withdrawn, an organization policy). The account shows "Reconnect needed"; its emails wait up to 24 hours, then fail with `account_reauthorization_required`. A workspace admin presses **Reconnect** (Settings → Email integrations → Accounts) and signs in as the same mailbox; held mail goes out at once. Nothing to do on our side unless every account fails at once: then suspect our OAuth client (`EMAIL_GOOGLE_CLIENT_SECRET` / `EMAIL_MICROSOFT_CLIENT_SECRET` expired or rotated). Those failures are deliberately not treated as the merchant's fault (accounts go `degraded`, not "reconnect").

### Email: messages with an unknown outcome
`unknown` means the provider may have received the message but never answered (or the jobs function died mid-send). bizinsights never resends these on its own. The merchant can review them in Activity and press **Send again**.

### Email: suspend a workspace's sending (abuse, complaints)
Not available in the app on purpose. With the owner-role connection:
```sql
INSERT INTO email_settings (workspace_id, suspended_at, suspended_reason, updated_at)
VALUES ('<workspace id>', now(), '<reason shown to the workspace>', now())
ON CONFLICT (workspace_id) DO UPDATE SET suspended_at = now(), suspended_reason = EXCLUDED.suspended_reason, updated_at = now();
```
Queued mail is held (cancelled after 72 hours); the dashboard shows the reason. Lift it with `UPDATE email_settings SET suspended_at = NULL, suspended_reason = NULL WHERE workspace_id = '<id>'`.

### Rotate the Shopify client secret
Partners → app → Client credentials → rotate. Shopify accepts both for a grace period. `node infra/cdk/scripts/put-secrets.mjs --set SHOPIFY_API_SECRET` and fresh function instances within that window.

### Rotate the Zapier client secret
The secret is on both sides: bizinsights' `ZAPIER_CLIENT_SECRET` (Secrets Manager) and the Zapier app's
`CLIENT_SECRET` (each version's environment). During the change bizinsights accepts the old one too
(`ZAPIER_CLIENT_SECRET_PREVIOUS`), so no connection breaks. PowerShell, from the repository root:
1. Make the new secret and copy it (never paste it into a chat):
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | Set-Clipboard`
2. `node infra/cdk/scripts/put-secrets.mjs --set ZAPIER_CLIENT_SECRET` (reads the clipboard). It keeps the
   replaced secret as `ZAPIER_CLIENT_SECRET_PREVIOUS` and says so. Then fresh function instances: from
   then on both secrets are accepted.
3. Give every version of the Zapier app that has users the new secret (`npx zapier-platform-cli versions`
   lists them). `env:set` prints what it sets, so its output is thrown away; a promoted version needs `--force`:
   ```powershell
   cd integrations\zapier
   $secret = Get-Clipboard
   npx zapier-platform-cli env:set 1.1.0 "CLIENT_SECRET=$secret" | Out-Null
   Remove-Variable secret
   Set-Clipboard -Value " "
   ```
4. Wait a day, then check the API's logs for `zapier client used the previous secret` since step 3
   (CloudWatch Logs Insights on the API function's log group: `filter msg like /previous secret/`). None:
   `node infra/cdk/scripts/put-secrets.mjs --unset ZAPIER_CLIENT_SECRET_PREVIOUS`, then fresh function
   instances. Some: a version still has the old secret; repeat step 3 for it first.

Connections keep working throughout: tokens bizinsights issued don't depend on the client secret, only
Zapier's calls to the token endpoint do.

### Rotate the OTP pepper
`OTP_PEPPER` keys the sign-in codes. Unless `CUSTOMER_HASH_KEY` is set, it also keys the stored customer hashes: orders' `customer_key` (returning-customer history) and WhatsApp contacts' phone hash, which is how a customer's STOP opt-out is found again. Rotating it then would reset that history and **let opted-out customers be messaged again**. So, in this order:
1. If `CUSTOMER_HASH_KEY` is not set yet, set it to the **current** `OTP_PEPPER` value (`node infra/cdk/scripts/put-secrets.mjs --set CUSTOMER_HASH_KEY`). Nothing changes: it is the key the hashes already use.
2. Then set a new `OTP_PEPPER`. Outstanding codes stop working (they expire in 10 minutes anyway); stored hashes are untouched.

Rotating `CUSTOMER_HASH_KEY` itself has the consequences above; don't, unless it leaked.

### Merchant asks for data deletion
Disconnecting in Settings → Stores deletes synced data immediately. Shopify's `shop/redact` (48 h after uninstall) does the same automatically.

### Back up and restore the database
RDS backs up `insights-production` by itself: automated backups kept 14 days, restorable to any second in that window, and a final snapshot if the instance is ever deleted. Nothing to schedule.

Restore into a **new** instance (RDS console → the instance → Actions → Restore to point in time, or a dump from the artifacts bucket through the admin host; aws-deployment.md, "Database"), verify it, and only then make it the app's database (the functions get `DB_HOST` from the Data stack, `infra/cdk/lib/data-stack.ts`). After a restore, re-sync stores to catch up on data since the restore point (webhooks during the gap were acked by the old database).

### Cleanup jobs (monthly)
```sql
DELETE FROM webhook_events WHERE received_at < now() - interval '30 days' AND status = 'succeeded';
DELETE FROM pixel_events_seen WHERE seen_at < now() - interval '14 days';
-- Storefront visits behind the funnel: keep 13 months so a 12-month comparison still works.
DELETE FROM funnel_visits WHERE day < to_char(now() - interval '13 months', 'YYYY-MM-DD');
DELETE FROM email_otps WHERE created_at < now() - interval '1 day';
```

## Local stack recovery

| Problem | Fix |
| --- | --- |
| Port 5434 in use | Override with `PG_PORT` |
| `app_rls` role missing (volume pre-dated init script) | `docker compose exec -T postgres psql -U app -d app < infra/postgres/init.sql` |
| Cognito emulator not reachable | First boot downloads cognito-local (~1 min): `docker compose logs -f cognito` |
| Fresh start (**local only**: on the owner's PC `-v` also deletes the old deployment's database, see [aws-deployment.md](aws-deployment.md#retiring-the-old-cloudflare-deployment)) | `docker compose down -v && docker compose up -d && pnpm db:migrate` |
