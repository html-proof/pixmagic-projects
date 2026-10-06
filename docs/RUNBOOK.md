# Runbook

For on-call. Each entry: **symptom → check → fix**. Commands assume `gcloud` is pointed at the project; locally, replace with `docker compose` equivalents.

## Health at a glance

| Check | Healthy |
| --- | --- |
| `GET https://api.example.com/readyz` | `200 {"ok":true,"checks":{"db":true,"redis":true}}` |
| Worker `/readyz` (Cloud Run console → insights-worker) | `200` |
| Queue depth: `redis-cli -h <host> LLEN bull:webhooks:wait` | < 1000 and draining |
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
The `SHOPIFY_API_SECRET` doesn't match the app (secret rotated in Partners but not in Secret Manager, or vice-versa). Update the secret, redeploy the API. Shopify retries failed deliveries for 48 h, so nothing is lost if fixed promptly.

### Webhook queue growing
1. Worker instances running? Check Cloud Run → insights-worker → revisions / logs.
2. Redis memory: `INFO memory`. If near the limit, scale Memorystore.
3. Scale the worker: raise `max_instance_count` / `min_instance_count` in Terraform.

### API 5xx spike
1. Logs: `gcloud logging read 'resource.labels.service_name="insights-api" severity>=ERROR' --limit 50`.
2. `/readyz` failing on `db` → Cloud SQL (connections, CPU, maintenance). On `redis` → Memorystore.
3. Roll back: `terraform apply -var image_tag=<previous sha>`.

### Users can't sign in
1. Firebase status page; Authentication → Usage for quota.
2. `stale_sign_in` errors: client clock skew or a cached old ID token. They should sign in again.
3. OTP emails not arriving: check SMTP provider dashboard and `SMTP_URL` secret. Rate limits are 3 codes / 15 min per email.

### Dashboard numbers look wrong
1. Compare with Shopify Analytics for the **same time zone and definitions** (see [kpis.md](kpis.md)). Common causes: Shopify "Total sales" includes tax and shipping; ours excludes them. Refunds are on refund date.
2. Recompute aggregates for a store and range (idempotent):

```bash
pnpm --filter @app/worker exec tsx -e "import('@app/core').then(async c=>{const {systemDb}=await import('@app/db');const s=await systemDb.store.findUniqueOrThrow({where:{shopDomain:process.argv[1]}});const days=(await systemDb.order.findMany({where:{storeId:s.id},select:{localDay:true},distinct:['localDay']})).map(d=>d.localDay);await c.recomputeDays(s,days);console.log('recomputed',days.length);process.exit(0)})" shop.myshopify.com
```

3. Still off: re-sync the store (re-pulls 60 days).

## Routine operations

### Rotate the token encryption key
1. Generate a key; prepend it: `TOKEN_ENCRYPTION_KEYS=2:<new>,1:<old>`. Deploy API and worker. New writes use v2; v1 still decrypts.
2. Re-encrypt existing tokens:

```bash
pnpm --filter @app/worker exec tsx -e "import('@app/core').then(async c=>{console.log('re-encrypted', await c.reencryptAllTokens());process.exit(0)})"
```

3. Verify: `SELECT token_key_version, count(*) FROM stores GROUP BY 1;` shows only `2`. Remove `1:<old>` and deploy.

### Rotate the Shopify client secret
Partners → app → Client credentials → rotate. Shopify accepts both for a grace period. Update `SHOPIFY_API_SECRET` in Secret Manager, redeploy API + worker within that window.

### Rotate the OTP pepper
Changing `OTP_PEPPER` invalidates outstanding codes (fine, they expire in 10 min) **and changes customer hashes** (`customer_key`), which resets returning-customer history. Avoid unless compromised; if you must, re-sync all stores afterwards.

### Merchant asks for data deletion
Disconnecting in Settings → Stores deletes synced data immediately. Shopify's `shop/redact` (48 h after uninstall) does the same automatically.

### Restore the database
Cloud SQL → Backups → point-in-time restore to a **new** instance, verify, then switch `DATABASE_URL`/`APP_DATABASE_URL`. After restore, re-sync stores to catch up on data since the restore point (webhooks during the gap were acked by the old DB).

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
| Port 5432/6379 in use | Compose uses 5434/6380 by default; override with `PG_PORT`/`REDIS_PORT` |
| `app_rls` role missing (volume pre-dated init script) | `docker compose exec -T postgres psql -U app -d app < infra/postgres/init.sql` |
| Emulator not reachable | First boot installs Java (~1–2 min): `docker compose logs -f firebase-emulator` |
| Fresh start | `docker compose down -v && docker compose up -d && pnpm db:migrate` |
