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
- **Three roles.** `app` owns the tables and runs migrations (the cron's `migrate` action only).
  `app_system` is `systemDb`'s login (auth bootstrap, webhooks, jobs): no owner, so RLS applies, in
  the row scope its entry point names; every workspace table also has a `system_all` policy that
  opens it inside `crossTenant` ([system-database-role.md](../system-database-role.md)). `app_rls` is what tenant reads use
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
| Advertising | `ad_connections` (the encrypted tokens of bizinsights' own sign-in), `ad_logins` (a sign-in connected with no ad account yet: its encrypted token in `access_token_enc`, key version `token_key_version`; migration `20261028100000_ad_logins_own_tokens`), `ad_campaign_daily`, `ad_campaigns` (each campaign's latest name and status, and Google's type, primary status and budget, Meta's budget: [advertising.md](../advertising.md#stored-campaign-facts)), `adsense_daily`, `ad_sync_runs`. Of the columns that named Nango connections, which brokered the sign-ins from 2026-10-22 to 2026-10-28 ([ads-setup.md](../ads-setup.md#leaving-nango)), `ad_connections.source` is still used: `direct` on every row, written by every connect and recorded by every sync (`ad_sync_runs.source`); a row with anything else is never read and waits for a reconnect (`holdsOwnSignIn`). `ad_connections.source_login_id`, `ad_logins.source_login_id` and `ad_logins.nango_integration_key` are read by nothing (a connect writes null to the first), but they are still in the Prisma client, so every read of those rows selects them. Dropping them takes two releases ([migrations.md](migrations.md#rules-for-a-migration-production-can-take)): `@ignore` first, with the null write in `saveAdConnections` taken out, then the DROP migration in a later release, since a deploy migrates before the new code goes live | API (connect: bizinsights' own sign-in), worker (sync) |
| WhatsApp Automation | `wa_connections`, `wa_settings`, `wa_templates`, `wa_contacts`, `wa_consent_events`, `wa_messages`, `wa_message_events`, `wa_webhook_events`, `wa_workflows`, `wa_workflow_runs`, `wa_campaigns` | API, worker ([../whatsapp.md](../whatsapp.md)) |
| WhatsApp (old, read by nothing; to be dropped) | `whatsapp_connections`, `whatsapp_settings`, `whatsapp_templates`, `whatsapp_contacts`, `whatsapp_messages`, `whatsapp_message_events`, `whatsapp_campaigns`, `whatsapp_automation_rules`, `whatsapp_automation_runs`, `order_trackings`, `order_tracking_events`, `abandoned_checkouts`, `customer_reviews` | erased on shop/redact and customers/redact only ([../whatsapp.md](../whatsapp.md#the-old-whatsapp-tables)) |
| Zapier | `zapier_grants` (a store connected to a merchant's Zapier, and who allowed it), `zapier_tokens` (SHA-256 hashes only; no tenant access), `zapier_hooks` (Zaps' triggers), `zapier_events` (the outbox, 30 days), `zapier_deliveries` | API (OAuth, hooks), worker (deliveries) ([../zapier.md](../zapier.md)) |
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
