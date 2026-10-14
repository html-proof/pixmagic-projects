# Runbook

For on-call. Each entry: **symptom → check → fix**.

Production is one Cloudflare Worker (`insights`, see [deployment-cloudflare.md](deployment-cloudflare.md)) in front of Postgres. Postgres is the `postgres` compose service on the host machine, reached by Hyperdrive through the `cloudflared` tunnel container. `wrangler` commands run from `apps/cloudflare`. SQL runs as the owner role:

```bash
docker compose exec postgres psql -U app -d app
```

## Health at a glance

| Check | Healthy |
| --- | --- |
| `GET <APP_URL>/api/readyz` | `200 {"ok":true,"checks":{"db":true,"coord":true}}` |
| Live logs: `npx wrangler tail` (or the dashboard: Workers → insights → Logs) | no `"level":"error"` bursts |
| Queue backlog: dashboard → Queues → `insights-sync`, `insights-webhooks`, `insights-aggregate` | draining; `insights-dlq` empty |
| Failed webhooks: `SELECT count(*) FROM webhook_events WHERE status='failed' AND received_at > now() - interval '1 day';` | ~0 |
| Stores in error: `SELECT shop_domain FROM stores WHERE status='error';` | none |
| Open alerts: `SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC;` | none critical |

## Alerts and what to do

### `sync_*_failed` (critical) – a store's sync failed after all retries
1. Read `sync_jobs.error` for the store.
2. `401`/`403` "merchant must reconnect": the merchant uninstalled or revoked the app, or - for a store still on a pre-2026-10-04 expiring token - its refresh token is no longer active. The store reaches `status = "error"`, which is terminal: nothing retries it. The dashboard says so and offers a Reconnect button; ask the merchant to use it, or Settings → Stores. Nothing else to do.
3. `429`/`5xx`: Shopify degraded. Check https://www.shopifystatus.com. Once healthy, trigger **Re-sync** (Settings → Stores, or `POST /workspaces/:ws/stores/:id/resync`).
4. "Sync stopped without reporting": the stale-job watchdog reaped it. The consumer was killed
   rather than failing - on the Workers Free plan that is usually Cloudflare error 1102 (CPU
   limit), which kills the invocation without throwing, so the job would otherwise have sat
   `running` forever and held the store in `syncing`. Check the Workers logs around
   `sync_jobs.started_at` for 1102; if that is the cause, the plan is the fix (see the
   `limits.cpu_ms` TODO in `apps/cloudflare/wrangler.jsonc`), not a re-sync. `failStaleJobs`
   in `apps/worker/src/handlers.ts` runs on the `*/15` cron and reaps anything `running` for
   over 30 minutes.
5. Data/normalisation error: capture the error, file a bug, then re-sync after the fix ships.
6. Resolve: `UPDATE alerts SET resolved_at=now() WHERE id='…';` and set `stores.status='active'` once a sync succeeds (it does this itself on a successful orders sync).

### `webhook_failed` (warning)
1. `SELECT topic, error, attempts FROM webhook_events WHERE status='failed' ORDER BY received_at DESC LIMIT 50;`
2. `Order … not found for refund …`: refund arrived before its order and the order never came. The daily reconcile fixes it; to fix now, re-sync the store.
3. To replay a single event you need the payload, which isn't stored. Re-sync (orders are re-pulled from Shopify) instead.

### Webhooks returning 401 en masse
`SHOPIFY_API_SECRET` doesn't match the app (secret rotated in the Partner dashboard but not in the Worker, or vice versa). `npx wrangler secret put SHOPIFY_API_SECRET` (takes effect immediately; it deploys a new version). Shopify retries failed deliveries for 48 h, so nothing is lost if fixed promptly.

### `/readyz` says `"db":false`, or every API call fails
Postgres is unreachable from Cloudflare. Queue consumers notice the same thing and park their jobs (see "Failed jobs" in [deployment-cloudflare.md](deployment-cloudflare.md#operations)), so nothing is lost while it is down; the UI is.
1. Is the host machine awake and online, and is Docker Desktop running? Stopping Docker Desktop stops production.
2. `docker compose ps`: `postgres` must be `healthy` and `cloudflared` `running`. Start them with `docker compose up -d postgres` and `docker compose --profile tunnel up -d cloudflared`.
3. `docker compose logs --tail 50 cloudflared`: registered connections should say `protocol=quic`. The tunnel must run `--protocol quic` (see the comment in `docker-compose.yml`): over http2 it reports healthy while Hyperdrive gets `connection_refused`. QUIC needs outbound UDP 7844.
4. Re-check `/readyz`. Parked jobs resume by themselves.

### Queue backlog growing
1. Dashboard → Queues → the queue → consumer errors, and `npx wrangler tail` for the failures.
2. If the errors are database timeouts, see the `"db":false` entry above.
3. Concurrency is `max_concurrency` under `queues.consumers` in `apps/cloudflare/wrangler.jsonc`; raising it only helps when the consumers are healthy and Shopify is not the bottleneck.
4. `insights-dlq` has no consumer: messages there were given up on (after a long outage, or a crash). Re-sync the affected stores.

### API 5xx spike
1. `npx wrangler tail --status error`, or Workers → insights → Logs filtered to errors. Every unhandled error is logged as `"unhandled error"` with the path.
2. Cloudflare's own error page (1102) instead of ours: CPU limit, see "Cloudflare error 1102" in [deployment-cloudflare.md](deployment-cloudflare.md#troubleshooting).
3. A bad release: `npx wrangler rollback` (pick the previous version). Do not roll back migrations; ship a forward fix.

### Users can't sign in
1. Firebase status page; Authentication → Usage for quota.
2. `stale_sign_in` errors: client clock skew or a cached old ID token. They should sign in again.
3. Sign-in codes not arriving: Workers logs for the email send, and that the `EMAIL_FROM` domain is still onboarded to Email Sending. Rate limits are 3 codes / 15 min per email.

### Dashboard numbers look wrong
1. Compare with Shopify Analytics for the **same time zone and definitions** (see [kpis.md](kpis.md)). Common causes: Shopify "Total sales" includes tax and shipping; ours excludes them. Refunds are on refund date.
2. Recompute the store's daily aggregates from its orders and refunds (idempotent; see [Maintenance tasks](#maintenance-tasks)):

```bash
OPS_SHOP=shop.myshopify.com pnpm --filter @app/worker ops:recompute
```

3. Still off: re-sync the store (re-pulls 60 days).

## Maintenance tasks

`pnpm --filter @app/worker ops:<task>` from the repo root runs a task in `apps/worker/ops/` against the database in the repo-root `.env` (or the file named by `OPS_ENV_FILE`). That file needs the **owner-role** `DATABASE_URL` and the **same** `TOKEN_ENCRYPTION_KEYS` as the deployed Worker. `.env.example` points `DATABASE_URL` at the development database (`app_dev`); for production, point it at `app` explicitly (a separate `OPS_ENV_FILE` for production keeps the two apart). In Windows PowerShell set variables first: `$env:OPS_SHOP = "shop.myshopify.com"`, then run the `pnpm` line on its own.

| Task | What it does |
| --- | --- |
| `ops:recompute` | Rebuilds `daily_store_metrics` for `OPS_SHOP` from its orders and refunds. |
| `ops:reencrypt` | Re-encrypts everything stored under `TOKEN_ENCRYPTION_KEYS` with the active key: Shopify and ad-platform tokens, WhatsApp connection secrets, contacts, message parameters and links, tracking and review tokens, abandoned checkouts. Also re-wraps the email module's data keys (OAuth tokens, SMTP passwords, domain challenges, event data, recipients) under the active `EMAIL_CREDENTIAL_KEYS` key (or `TOKEN_ENCRYPTION_KEYS` when that is unset). |

## Routine operations

### Rotate the token encryption key
1. Generate a key (`openssl rand -base64 32`) and prepend it: `TOKEN_ENCRYPTION_KEYS=2:<new>,1:<old>`. Set it on the Worker (`npx wrangler secret put TOKEN_ENCRYPTION_KEYS`) and in the `.env` the maintenance tasks use. New writes use v2; v1 still decrypts.
2. Re-encrypt existing data: `pnpm --filter @app/worker ops:reencrypt` (prints how many rows it rewrote).
3. Run it again: it must print `re-encrypted 0 rows` (rows written by the Worker between deploy and step 2 are already on v2). Only then remove `1:<old>` from both places. Someone in the middle of choosing which ad accounts to connect at that moment has to sign in to the platform again; nothing else is lost.

### Rotate the email credential key
Same steps as above with `EMAIL_CREDENTIAL_KEYS` (when it is set; otherwise the email module uses `TOKEN_ENCRYPTION_KEYS` and the steps above cover it). Each email secret has its own data key; `ops:reencrypt` only re-wraps those data keys, so it is quick. Set the same value in the maintenance `.env`.

### Email: an account needs reconnecting (`email_account_reauth:*` alert)
Google or Microsoft rejected the stored authorization (revoked in the user's account, password change, consent withdrawn, an organization policy). The account shows "Reconnect needed"; its emails wait up to 24 hours, then fail with `account_reauthorization_required`. A workspace admin presses **Reconnect** (Settings → Email integrations → Accounts) and signs in as the same mailbox; held mail goes out at once. Nothing to do on our side unless every account fails at once: then suspect our OAuth client (`EMAIL_GOOGLE_CLIENT_SECRET` / `EMAIL_MICROSOFT_CLIENT_SECRET` expired or rotated). Those failures are deliberately not treated as the merchant's fault (accounts go `degraded`, not "reconnect").

### Email: messages with an unknown outcome
`unknown` means the provider may have received the message but never answered (or the Worker died mid-send). Insights never resends these on its own. The merchant can review them in Activity and press **Send again**.

### Email: suspend a workspace's sending (abuse, complaints)
Not available in the app on purpose. With the owner-role connection:
```sql
INSERT INTO email_settings (workspace_id, suspended_at, suspended_reason, updated_at)
VALUES ('<workspace id>', now(), '<reason shown to the workspace>', now())
ON CONFLICT (workspace_id) DO UPDATE SET suspended_at = now(), suspended_reason = EXCLUDED.suspended_reason, updated_at = now();
```
Queued mail is held (cancelled after 72 hours); the dashboard shows the reason. Lift it with `UPDATE email_settings SET suspended_at = NULL, suspended_reason = NULL WHERE workspace_id = '<id>'`.

### Rotate the Shopify client secret
Partners → app → Client credentials → rotate. Shopify accepts both for a grace period. `npx wrangler secret put SHOPIFY_API_SECRET` within that window.

### Rotate the OTP pepper
`OTP_PEPPER` keys the sign-in codes. Unless `CUSTOMER_HASH_KEY` is set, it also keys the stored customer hashes: orders' `customer_key` (returning-customer history) and WhatsApp contacts' phone hash, which is how a customer's STOP opt-out is found again. Rotating it then would reset that history and **let opted-out customers be messaged again**. So, in this order:
1. If `CUSTOMER_HASH_KEY` is not set yet, set it to the **current** `OTP_PEPPER` value (`npx wrangler secret put CUSTOMER_HASH_KEY`, from `apps/cloudflare`). Nothing changes: it is the key the hashes already use.
2. Then set a new `OTP_PEPPER`. Outstanding codes stop working (they expire in 10 minutes anyway); stored hashes are untouched.

Rotating `CUSTOMER_HASH_KEY` itself has the consequences above; don't, unless it leaked.

### Merchant asks for data deletion
Disconnecting in Settings → Stores deletes synced data immediately. Shopify's `shop/redact` (48 h after uninstall) does the same automatically.

### Back up and restore the database
The data lives in the `pgdata` Docker volume on the host machine, its only copy. Take a backup with the script (it dumps inside the container, checks the dump is readable, saves it as `app-auto-<UTC time>.dump`, and deletes its own dumps older than `--keep-days`; hand-made backups are never touched):

```bash
node infra/postgres/backup.mjs --out C:\Users\Seban\insights-backups --keep-days 30
```

Don't use `pg_dump ... > file.dump` from Windows PowerShell 5.1: `>` re-encodes the binary dump as text and the file can't be restored. For a backup that survives the PC, point `--out` at a folder that is synced elsewhere (OneDrive, Google Drive).

To run it every night at 02:30 (Windows Task Scheduler; the PC must be on, as it must for production anyway), from PowerShell in the repository folder:

```powershell
schtasks /Create /SC DAILY /ST 02:30 /TN "Insights database backup" /TR "node `"$PWD\infra\postgres\backup.mjs`" --out C:\Users\Seban\insights-backups"
```

Restore into a **new** database first (`createdb -U app app_restore`, then `pg_restore -U app -d app_restore` from the dump inside the container), verify it, and only then point the Hyperdrive configs at it. After a restore, re-sync stores to catch up on data since the backup (webhooks during the gap were acked by the old database).

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
| Emulator not reachable | First boot downloads firebase-tools (~1–2 min): `docker compose logs -f firebase-emulator` |
| Fresh start (**local only**: on the production host this deletes production data) | `docker compose down -v && docker compose up -d && pnpm db:migrate` |
