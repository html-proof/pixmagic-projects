# Database schema

PostgreSQL 17, defined in `packages/db/prisma/schema.prisma` (Prisma 7) and changed only by
migrations in `packages/db/prisma/migrations/` ([migrations.md](migrations.md)). This page is the
map; the schema file's comments are the detail.

## Tenancy

```
Workspace ──< Membership >── User           (role: owner | admin | analyst | viewer)
    │
    ├──< Store ──< store-scoped data (orders, products, metrics, ads, WhatsApp, ...)
    ├──< ApiKey, Invitation, AuditLog, Alert, NotificationPreference
    └──── Subscription
```

- **Every tenant table carries `workspace_id`** (store-scoped ones also `store_id`), so row-level
  security can check it without joins.
- **Two roles.** `app` owns the tables and runs migrations and system paths (`systemDb`: auth
  bootstrap, webhooks, jobs; RLS does not apply to it). `app_rls` is what tenant reads use
  (`withTenant(workspaceId, tx => ...)`): every tenant table has a `tenant_isolation` policy on
  `current_setting('app.workspace_id')`, set per transaction. `apps/api/test/security.test.ts`
  fails any new tenant table without a policy.
- **Queries still filter by workspace** (and store). RLS is the second guard, not the filter.

## Areas and tables

| Area | Tables | Written by |
| --- | --- | --- |
| Identity and access | `users`, `workspaces`, `memberships`, `invitations`, `api_keys`, `notification_preferences`, `email_otps` | API (auth, workspaces) |
| Billing | `subscriptions` | API (subscribe), worker (`app_subscriptions/update`) |
| Store connection | `stores` (encrypted tokens, granted scopes, pixel key), `sync_jobs`, `webhook_events` | API (OAuth), worker |
| Commerce data | `orders`, `order_line_items`, `refunds`, `products`, `product_variants` | worker (imports, webhooks) through `core/persist.ts` |
| Aggregates | `daily_store_metrics` (one row per store and store-local day) | worker (`recomputeDays`) |
| Storefront funnel | `funnel_visits`, `funnel_product_visits`, `funnel_daily`, `pixel_events_seen` | API (`/pixel`) |
| Shopping Funnel checklist | `funnel_action_checks` | API (`PUT …/funnel/actions/:id`) |
| Advertising | `ad_connections` (the encrypted tokens of bizinsights' own sign-in), `ad_logins` (a sign-in connected with no ad account yet: its encrypted token in `access_token_enc`, key version `token_key_version`; migration `20261028100000_ad_logins_own_tokens`), `ad_campaign_daily`, `ad_campaigns` (each campaign's latest name and status), `adsense_daily`, `ad_sync_runs`. The columns that named Nango connections, which brokered the sign-ins from 2026-10-22 to 2026-10-28, are no longer used and wait for a migration of their own to drop them, after the release that stopped using them (deploys swap the code before migrating, and a rollback still reads them): `ad_connections.source` (`direct` on every row; a row with anything else is never read and waits for a reconnect) and `source_login_id`, `ad_logins.source_login_id` and `nango_integration_key` ([ads-setup.md](../ads-setup.md#leaving-nango)) | API (connect: bizinsights' own sign-in), worker (sync) |
| WhatsApp Automation | `wa_connections`, `wa_settings`, `wa_templates`, `wa_contacts`, `wa_consent_events`, `wa_messages`, `wa_message_events`, `wa_webhook_events`, `wa_workflows`, `wa_workflow_runs`, `wa_campaigns` | API, worker ([../whatsapp.md](../whatsapp.md)) |
| WhatsApp (old, read by nothing; to be dropped) | `whatsapp_connections`, `whatsapp_settings`, `whatsapp_templates`, `whatsapp_contacts`, `whatsapp_messages`, `whatsapp_message_events`, `whatsapp_campaigns`, `whatsapp_automation_rules`, `whatsapp_automation_runs`, `order_trackings`, `order_tracking_events`, `abandoned_checkouts`, `customer_reviews` | erased on shop/redact and customers/redact only ([../whatsapp.md](../whatsapp.md#the-old-whatsapp-tables)) |
| Operations | `alerts`, `audit_logs` | API, worker |

## Conventions

- **Ids**: `cuid()` text primary keys; Shopify / Meta ids are kept as text (`shopify_id`) with a
  unique `(store_id, shopify_id)`.
- **Names**: models in PascalCase, tables and columns in snake_case (`@@map` / `@map`).
- **Time**: `TIMESTAMP(3)` without time zone, always holding UTC. A store-local calendar day is
  stored as text (`local_day`, `YYYY-MM-DD`) computed once with the store's time zone, so daily
  reports never convert at query time. Raw SQL binds timestamps as ISO strings cast through
  `timestamptz` (see `core/persist.ts`, `ts()`), never as `Date`, so the session time zone can't
  shift them.
- **Money**: `DECIMAL(18,2)` in the store's currency (`orders.currency`, `stores.currency`), summed
  in SQL and converted to `number` only for the response. Known limit: currencies with three
  decimals (KWD, BHD, OMR, JOD, TND) are rounded to two
  ([current-state.md](../architecture/current-state.md), M20). Ad spend is kept in each ad
  account's currency and never added across currencies.
- **Personal data**: no customer names, emails or addresses. A customer is a keyed hash
  (`customer_key`, key `CUSTOMER_HASH_KEY`), and only with `read_customers`. WhatsApp numbers and
  first names are AES-256-GCM encrypted with a store-bound AAD, looked up by keyed hash.
- **Secrets at rest**: provider tokens are encrypted with `TOKEN_ENCRYPTION_KEYS` (versioned; see
  RUNBOOK "Rotate the token encryption key").
- **Deletes**: a store's data cascades from `stores`; GDPR webhooks delete or redact per customer
  and per shop.

## Indexes worth knowing

Every tenant table has `(workspace_id)`; store data has `(store_id, ...)` first. Report queries
lean on `orders (store_id, local_day)`, `daily_store_metrics (store_id, day)` (unique),
`orders (store_id, customer_key, shopify_created_at)` (returning customers, redaction) and
`sync_jobs (status)` (the stale-job sweep).
