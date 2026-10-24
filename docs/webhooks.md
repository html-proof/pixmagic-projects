# Webhooks

Webhooks drive all updates after the initial backfill. Endpoint: `POST <APP_URL>/api/webhooks/shopify`, in production `https://bizinsights.io/api/webhooks/shopify` (`apps/api/src/routes/webhooks.ts`, served by the `api` Lambda function built from `apps/aws`). The endpoint is exempt from the global per-IP rate limit: Shopify sends every store's webhooks from a small pool of addresses, and each delivery is HMAC-verified instead.

## Intake contract

1. **Verify first.** HMAC-SHA256 of the *raw* body with the app secret, compared in constant time to `X-Shopify-Hmac-Sha256`. Failure → `401`, nothing stored.
2. **Deduplicate.** `X-Shopify-Webhook-Id` is inserted into `webhook_events` under a unique constraint. The row is written before the queue send, so it alone does not prove the delivery was queued: the database connection can drop after the insert committed, or Shopify can give up at 5 s and the request be cancelled before the send. A `200` ends Shopify's retries, so a repeated delivery is answered by the state of its row:
   - a consumer has picked it up (`running`, `succeeded`, `failed`, or `attempts > 0`) → `200 {duplicate:true}`, not re-queued;
   - still `queued` with `attempts=0` more than 30 s after it was recorded → nothing can still be sending it, so the retry takes a lease on it (re-stamps `received_at`) and queues it again with the retry's payload. Rarely this queues a second copy of a message that was only waiting out a DB outage; processing is idempotent (below) and each copy has its own payload blob, which a copy that finds the event already processed deletes, so that is harmless;
   - still `queued` with `attempts=0` and younger than that (Shopify's first retry can come about a second after it gave up), or a lease another request holds → `503 {error:"in_progress"}`, so Shopify retries again later.

   If the queue send fails, a row this request inserted is removed again (when the DB allows) so the retry starts afresh; a re-armed row is kept for any earlier message still behind it. Either way the API answers `500` so Shopify retries.
3. **Queue, then ack.** The payload goes to the `webhooks` SQS queue (the message carries the event id); the API replies `200` in milliseconds. Payloads over 100 KB are kept in the S3 payloads bucket (deleted after 7 days) and the message carries their key. Payloads are never written to Postgres.

## Processing (worker, `apps/worker/src/handlers/webhooks.ts`)

| Topic | Effect |
| --- | --- |
| `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`, `orders/fulfilled`, `orders/partially_fulfilled` | Upsert order + line items + embedded refunds; enqueue re-aggregation of affected days. With a WhatsApp connection: the workflows on New order, Order paid, Order shipped and Order cancelled (docs/whatsapp.md). With an SMS sender: contacts and consent, SMS rules, attribution (docs/sms.md) |
| `checkouts/create`, `checkouts/update` | WhatsApp and Customer Messaging only: checkout reminders (only with a phone number); `completed_at`, or the order for the checkout, cancels them (docs/whatsapp.md, docs/sms.md) |
| `customers/create` | WhatsApp's "New customer" workflows; Customer Messaging. Subscribed per store (with `read_customers`) when such a workflow is switched on (`ensureCustomerWebhook`) |
| `customers_marketing_consent/update` | Customer Messaging: a customer's SMS marketing consent changed. Subscribed per store once it grants `read_customers` (`ensureSmsWebhooks`) |
| `orders/delete` | Remove the order, its line items and sales records, and recompute its days: Shopify's reports stop counting a deleted order. The daily check against Shopify (docs/kpis.md, "Checked against Shopify") finds deletions whose webhook was missed |
| `refunds/create` | Read the order's sales records again (the refund is one of them) and recompute the days they fall on |
| `products/create`, `products/update`, `products/delete` | Upsert / delete product (with the product information the Inventory pages show); a deleted product's stock levels go with it |
| `inventory_levels/update`, `inventory_levels/connect` | Inventory: read the level again from Shopify (every quantity state) and store it unless a newer one is stored; the variant's alerts are re-evaluated. Shop-specific subscriptions, made once the store grants `read_inventory` (docs/inventory.md) |
| `inventory_levels/disconnect` | Inventory: the item is no longer stocked at the location; its level goes |
| `inventory_items/update` | Inventory: cost per item, tracking on or off, SKU, shipping, on the variant that owns the item |
| `locations/create`, `update`, `delete`, `activate`, `deactivate` | Inventory: the location read again; a deleted one is kept as deleted (history names it) and its stock goes. Needs `read_locations` |
| `app/uninstalled` | Store → `uninstalled`, tokens wiped; a plan billed on the store ends (Free). Data kept until `shop/redact`. Shopify revokes an app's tokens on uninstall, so the store's token is checked live first: one Shopify still accepts belongs to a later installation (whatever `installedAt` says) and the delivery is set aside, only re-reading the store's charges. One older than `installedAt` is set aside unless Shopify refuses the token (401/403): a frozen or locked shop (402/423), or a row whose reinstall hasn't written its token yet, proves nothing |
| `app/scopes_update` | Replace granted scopes → dashboard modules update immediately |
| `app_subscriptions/update` | The pending charge active → it becomes the plan; the charge in force cancelled, declined or expired → Free (`packages/core/src/billing.ts`) |
| `customers/data_request` | Recorded for the owner's export (Settings → Privacy requests): with WhatsApp, the contact, consent history and messages (analytics hold no PII) |
| `customers/redact` | Null the hashed customer key on that customer's orders; delete the customer's WhatsApp contact, consent records, messages and workflow runs (and their records in the old WhatsApp tables), and their SMS contacts, consent history and texts |
| `shop/redact` | Delete all synced data for the store, WhatsApp included (its token at Nango too), and the store row. Comes 48 h after an uninstall, and also when a shop closes, with no `app/uninstalled` first (App Review's test stores). Skipped only for a store still installed: installed after Shopify made the request, or holding a token Shopify accepts (asked live). A status other than `uninstalled` alone proves nothing. If Shopify can't be asked, the last retry erases anyway (nothing redelivers it), and a plan billed on the store ends as on an uninstall. The erase is recorded in its own transaction (`gdpr.shop_redacted`, naming the shop): in the workspace's audit log, or, when the workspace nobody claimed went with the store, as a system row with no workspace (`audit_logs.workspace_id` null, which RLS shows to no tenant) |

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
npx shopify app webhook trigger --topic orders/create --api-version 2026-10 --delivery-method http --address http://localhost:8787/api/webhooks/shopify
```
