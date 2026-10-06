# Webhooks

Webhooks drive all updates after the initial backfill. Endpoint: `POST https://APP_DOMAIN/api/webhooks/shopify` (`apps/api/src/routes/webhooks.ts`, served by the Worker in `apps/cloudflare`). The endpoint is exempt from the global per-IP rate limit: Shopify sends every store's webhooks from a small pool of addresses, and each delivery is HMAC-verified instead.

## Intake contract

1. **Verify first.** HMAC-SHA256 of the *raw* body with the app secret, compared in constant time to `X-Shopify-Hmac-Sha256`. Failure → `401`, nothing stored.
2. **Deduplicate.** `X-Shopify-Webhook-Id` is inserted into `webhook_events` under a unique constraint. The row is written before the queue send, so it alone does not prove the delivery was queued: the DB tunnel can drop after the insert committed, or Shopify can give up at 5 s and the request be cancelled before the send. A `200` ends Shopify's retries, so a repeated delivery is answered by the state of its row:
   - a consumer has picked it up (`running`, `succeeded`, `failed`, or `attempts > 0`) → `200 {duplicate:true}`, not re-queued;
   - still `queued` with `attempts=0` more than 30 s after it was recorded → nothing can still be sending it, so the retry takes a lease on it (re-stamps `received_at`) and queues it again with the retry's payload. Rarely this queues a second copy of a message that was only waiting out a DB outage; processing is idempotent (below) and each copy has its own payload blob, which a copy that finds the event already processed deletes, so that is harmless;
   - still `queued` with `attempts=0` and younger than that (Shopify's first retry can come about a second after it gave up), or a lease another request holds → `503 {error:"in_progress"}`, so Shopify retries again later.

   If the queue send fails, a row this request inserted is removed again (when the DB allows) so the retry starts afresh; a re-armed row is kept for any earlier message still behind it. Either way the API answers `500` so Shopify retries.
3. **Queue, then ack.** The payload goes to the `webhooks` Cloudflare Queue (the message carries the event id); the API replies `200` in milliseconds. Payloads over 100 KB are kept in R2, or, while R2 is not bound, in Durable Object storage split into chunks (a stored value is capped at 2 MB, a webhook body at 5 MB). Payloads are never written to Postgres.

## Processing (worker, `apps/worker/src/handlers.ts`)

| Topic | Effect |
| --- | --- |
| `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled` | Upsert order + line items + embedded refunds; enqueue re-aggregation of affected days |
| `refunds/create` | Upsert refund (booked on refund date). If the order isn't known yet the job throws and retries with backoff |
| `products/create`, `products/update`, `products/delete` | Upsert / delete product |
| `app/uninstalled` | Store → `uninstalled`, tokens wiped. Data kept until `shop/redact` |
| `app/scopes_update` | Replace granted scopes → dashboard modules update immediately |
| `app_subscriptions/update` | Update billing status |
| `customers/data_request` | Audit entry. We hold no customer PII to export |
| `customers/redact` | Null the hashed customer key on that customer's orders |
| `shop/redact` | Delete all synced data for the store |

### Idempotency guarantees

- A processed event (`status=succeeded`) is skipped on re-run.
- Order/product upserts are keyed by `(store_id, shopify_id)` and **ignore payloads older than the stored `updated_at`**, so out-of-order delivery can't regress data.
- Line items are replaced wholesale per order; refunds upsert by id.
- Aggregates are recomputed from source rows for each affected day (`recomputeDays`), never incremented, so replays converge to the same numbers.

### Retries & failure

Jobs get 6 attempts with exponential backoff (5 s base). After the final attempt the event is marked `failed` and an alert is raised (stored, emailed to owners/admins who opted in, and posted to Slack if `ALERT_SLACK_WEBHOOK_URL` is set; each channel is tried independently). The alert is resolved automatically by the store's next successfully processed webhook, so a later failure is announced again rather than de-duplicated into the old one. Alerts are not shown in the web UI yet; `GET /api/workspaces/:ws/alerts` lists the open ones. Failures while the database is unreachable don't count against those attempts: the job is re-sent every few minutes until the database is back (up to 24 h). The daily **reconcile** job (03:15 UTC) re-pulls orders updated in the last 3 days for every active store, which repairs anything a missed or failed webhook left behind.

## Testing webhooks

- Automated: `apps/api/test/shopify.test.ts` (forged/missing/tampered HMAC, duplicates) and `apps/worker/test/worker.test.ts` (idempotency, ordering, GDPR).
- Manual against a running API:

```bash
npx shopify app webhook trigger --topic orders/create --api-version 2025-10 --delivery-method http --address http://localhost:8787/api/webhooks/shopify
```
