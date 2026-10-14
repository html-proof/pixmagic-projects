# Email integrations and automation

Each workspace (organization) connects its own mailboxes — Gmail, Google Workspace, Outlook.com,
Microsoft 365, or any provider over SMTP — verifies its sending domains, writes templates, and
creates automations that send personalized email when business events happen (Shopify orders and
abandoned checkouts, or custom events from its own systems). Everything lives under
**Settings → Email integrations**.

API reference: [email-api.yaml](email-api.yaml) (OpenAPI 3.1). Conventions this follows:
[architecture.md](architecture.md). Security summary: [security.md](security.md).

## Contents

1. [Architecture](#1-architecture)
2. [Where the code is](#2-where-the-code-is)
3. [Data model and migration](#3-data-model-and-migration)
4. [API](#4-api)
5. [Google setup](#5-google-gmail--google-workspace-setup)
6. [Microsoft setup](#6-microsoft-outlook--microsoft-365-setup)
7. [SMTP](#7-custom-smtp)
8. [Domain verification](#8-domain-verification)
9. [Configuration](#9-configuration)
10. [Queues, cron and deployment](#10-queues-cron-and-deployment)
11. [Security controls](#11-security-controls)
12. [Delivery statuses and what they mean](#12-delivery-statuses-and-what-they-mean)
13. [Tests](#13-tests)
14. [Known limitations](#14-known-limitations)
15. [Production checklist](#15-production-checklist)
16. [Status: what is done, what needs an administrator](#16-status)

## 1. Architecture

The module follows the app's existing shape instead of adding new infrastructure. Mapping from the
original specification:

| Specification | This repository |
| --- | --- |
| Organization / tenant / `tenant_id` | `workspaces`, `memberships`, `workspace_id` on every row |
| NestJS API | Hono routes in `apps/api/src/routes/email*.ts` |
| Next.js dashboard | `apps/web/src/app/(app)/settings/email/*` (static export) |
| PostgreSQL + Prisma | Same database; 15 new tables, Postgres RLS on each |
| Redis + BullMQ | Cloudflare Queues (`insights-email`) + the Coordinator Durable Object (locks, counters, one-time OAuth state) + the 15-minute cron sweep |
| Worker processes | The same Worker's queue consumer (`apps/worker`) |
| KMS envelope encryption | Per-secret data keys wrapped by Worker-secret key-encryption keys (`EMAIL_CREDENTIAL_KEYS`), rotatable; one function to swap for a managed KMS |
| Nodemailer | A small SMTP client over Workers TCP sockets (`cloudflare:sockets`): Nodemailer needs Node's `net`/`tls` |
| `/api/v1/email/...` routes | `/api/workspaces/{ws}/email/...` (the app's existing convention: the path selects the workspace, membership is checked on every request); the public event API is `/api/v1/events` |

```
 Browser (Settings → Email integrations)
     │  session cookie, CSRF Origin check
     ▼
 Worker fetch ──► Hono API (apps/api/src/routes/email*.ts)
     │              requireEmail(): signed-in member + role permission → 404 for non-members
     │              withTenant(): RLS-scoped reads
     ▼
 packages/core/src/email ─────────────────────────────────────────────────────────────┐
   accounts / senders / domains / templates / rules        vault (envelope encryption)│
   oauth (Google, Microsoft) ── tokens (TokenManager, Coordinator lock, CAS)           │
   events (Shopify normalization, checkout abandonment, custom ingest)                 │
   engine (event → rules → executions → messages)                                      │
   delivery (claim → checks → limits → render → MIME → adapter → status)               │
   providers: Gmail API │ Microsoft Graph │ SMTP (smtp.ts over sockets, vetted host)   │
   activity / analytics / suppressions / sweep                                         │
     │                                                                                 │
     ├─► Postgres (Hyperdrive): email_* tables, RLS, composite tenant FKs ◄────────────┘
     ├─► Queue insights-email: {email_event, eventId} │ {email_send, messageId}
     └─► Coordinator DO: token-refresh locks, rate-limit windows, OAuth state, leases

 Shopify webhooks ─► webhook queue ─► processWebhook ─► emailOnShopifyEvent ─► email_business_events
 POST /api/v1/events (ek_live_ key) ─► ingestCustomEvent ─────────────────────► email_business_events
 Cron */15 ─► sweepEmail: lost/due sends, stuck sends → unknown, abandoned checkouts,
              domain rechecks, OAuth upkeep, retention
```

**The flow of one automation:** a business event is stored once per source id (encrypted), and a
queue job runs every enabled rule for its type. Each rule gets one execution row (unique key
`rule:<id>:event:<id>`): conditions → recipient → verified sender → active template → marketing
consent → suppression → frequency limit → a message row (queued, delayed) → a send job. The send
job claims the message (`queued → processing`, one attempt counted), re-checks the account,
workspace pause, rule, sender and suppression, applies sending limits, renders the template from
the event, builds one MIME message, hands it to the provider, and records exactly what the provider
said.

## 2. Where the code is

```
packages/shared/src/email/      pure, browser-safe (@app/shared/email)
  constants.ts   providers, statuses and labels, provider limits, error codes in words
  events.ts      event catalog (fields, types, examples), custom events, readPath (own props only)
  conditions.ts  condition tree schema, validation (depth, size, field/operator/value), evaluator
  template.ts    {{ path | default: "x" }} parser, renderer (HTML-escaped), variable checks
  sanitize.ts    allowlist HTML sanitizer (no DOM), URL and style filters
  address.ts     address and domain validation, masking
  dns.ts         ownership challenge, SPF/DKIM/DMARC parsing and judging
  network.ts     SMTP outbound policy: IPv4/IPv6 special ranges, host names, ports
  schemas.ts     request schemas shared by API and UI
packages/core/src/email/
  vault.ts       envelope encryption, AADs, rewrap
  dns.ts         DNS over HTTPS (Cloudflare, Google fallback), SPF include walk
  mime.ts        RFC 5322/MIME builder (header-injection safe)
  smtp.ts        SMTP client (EHLO, STARTTLS/TLS, AUTH PLAIN/LOGIN, DATA), error classes
  oauth.ts       Google and Microsoft OAuth (PKCE), identity, error mapping
  tokens.ts      TokenManager: getValidAccessToken, refreshEmailAccessToken, markReauthorizationRequired,
                 revokeConnection, getConnectionHealth, reencryptEmailCredentials
  providers.ts   EmailProviderAdapter: gmailAdapter, graphAdapter, smtpAdapter; vetSmtpHost
  accounts.ts    connect (OAuth/SMTP), test, update, disable, disconnect
  senders.ts     sender identities: provider, code confirmation, domain ownership
  domains.ts     add, check (DNS), regenerate, remove
  templates.ts   CRUD, versions, duplicate, restore, preview
  rules.ts       CRUD, validation, enable/disable, executions
  engine.ts      processBusinessEvent, dryRunRule
  events.ts      Shopify normalization, checkout abandonment, custom ingest, GDPR redaction
  delivery.ts    createMessage, enqueueEmailSend, sendEmailMessage, sendNow, cancelPending
  render.ts      template + event → subject/HTML/text, marketing footer
  suppressions.ts suppression list, signed unsubscribe tokens
  activity.ts    activity log, message detail, analytics, overview
  settings.ts    workspace settings, event API keys
  sweep.ts       the cron sweep and retention
apps/api/src/emailAccess.ts             requireEmail (no API keys), date ranges
apps/api/src/routes/emailAccounts.ts    accounts, OAuth start/callback, SMTP, senders, test sends
apps/api/src/routes/emailContent.ts     catalog, domains, templates, automations
apps/api/src/routes/emailActivity.ts    overview, analytics, messages, settings, suppressions, keys, audit
apps/api/src/routes/emailPublic.ts      POST /v1/events, unsubscribe
apps/worker/src/handlers.ts             runEmailJob; Shopify webhook and GDPR hooks
apps/worker/src/index.ts                queue "email"; sweepEmail on the */15 cron
apps/cloudflare/src/smtpSocket.ts       SmtpConnect over cloudflare:sockets
apps/web/src/app/(app)/settings/email/  Overview, Accounts, Domains, Templates (+editor),
                                        Automations (+7-step builder), Activity, Settings
apps/web/src/app/unsubscribe/           public unsubscribe page
apps/web/src/components/email/          badges, copy button, sandboxed preview, condition builder
```

## 3. Data model and migration

Migration `packages/db/prisma/migrations/20261015090000_email_integrations` (additive only). Table
names map to the specification as follows.

| Table | Spec name | Holds |
| --- | --- | --- |
| `email_settings` | (organization settings) | business name/address, daily limit, pause, operator suspension |
| `email_accounts` | email_accounts | provider, method, address, status, scopes, limits, health; soft-deleted on disconnect |
| `email_oauth_credentials` | oauth_credentials | sealed refresh/access tokens, expiry, key version, `credential_version` (compare-and-set) |
| `email_smtp_credentials` | smtp_credentials | host, port, TLS mode (CHECK: 465=tls, 587/2525=starttls), user, sealed password |
| `email_domains` | verified_domains | domain, challenge (hash + sealed), status, SPF/DKIM/DMARC results |
| `email_sender_identities` | sender_identities | From addresses per account, authorization status and method, default (one per workspace) |
| `email_templates`, `email_template_versions` | email_templates | content (sanitized), category, event, variables, version history |
| `email_automation_rules` | automation_rules | event, store filter, condition tree, recipient, sender, template, delay, frequency, retries |
| `email_business_events` | (events) | normalized, encrypted event data; dedupe on (workspace, source, external id) |
| `email_automation_executions` | automation_executions | one per rule per event (unique idempotency key) |
| `email_messages` | email_messages | queue + history; recipient encrypted, hashed and masked; never the body |
| `email_message_events` | email_events | append-only lifecycle (a trigger refuses updates) |
| `email_suppressions` | suppression_entries | keyed hash + masked address, reason, scope |
| `email_ingest_keys` | (event API keys) | `ek_live_` keys, SHA-256 only |
| `audit_logs` (existing) | audit_logs | `email.*` actions, sanitized metadata |

Integrity: every table has `workspace_id` and the `tenant_isolation` RLS policy; references between
email tables are composite `(id, workspace_id)` foreign keys, so a rule can't reference another
workspace's sender or template even through a code bug; partial unique indexes keep one live
account per address and method, one default sender, and unique template names. Status columns have
CHECK constraints.

Retention (sweep, daily): event data cleared after 35 days (the longest delay is 30), events and
executions deleted after 90 days, messages and their events after 180 days. Suppressions are kept
(they are what stops future email). GDPR `customers/redact` deletes the customer's events and
messages for that store; `shop/redact` deletes the store's.

## 4. API

All workspace routes are under `/api/workspaces/{ws}/email`, need a signed-in member (workspace API
keys are refused), and answer `{ "error": code, "message": text }` on failure. Permissions:

| Permission | Owner | Admin | Analyst | Viewer |
| --- | --- | --- | --- | --- |
| `email:read` (overview, accounts, domains, templates, rules) | ✓ | ✓ | ✓ | ✓ |
| `email:activity` (recipients, messages, executions, suppressions list) | ✓ | ✓ | ✓ | |
| `email:automate` (templates, automations, dry runs, test sends to self, retry/cancel) | ✓ | ✓ | | |
| `email:manage` (accounts and credentials, domains, senders, suppressions, keys, settings) | ✓ | ✓ | | |

Summary (full schemas in [email-api.yaml](email-api.yaml)):

| Area | Routes |
| --- | --- |
| Accounts | `GET /accounts`, `GET /accounts/{id}`, `POST /oauth/{google\|microsoft}/start`, `GET /api/email/oauth/{provider}/callback`, `POST /smtp/connections`, `PATCH /smtp/connections/{id}`, `POST /accounts/{id}/test`, `POST /accounts/{id}/test-send`, `POST /accounts/{id}/reauthorize`, `PATCH /accounts/{id}`, `DELETE /accounts/{id}` |
| Senders | `GET /senders`, `POST /accounts/{id}/senders`, `POST /senders/{id}/send-code`, `POST /senders/{id}/confirm`, `POST /senders/{id}/default`, `DELETE /senders/{id}` |
| Domains | `GET /domains`, `POST /domains`, `GET /domains/{id}`, `GET /domains/{id}/dns-status`, `POST /domains/{id}/verify`, `PATCH /domains/{id}`, `POST /domains/{id}/regenerate`, `DELETE /domains/{id}` |
| Templates | `GET /templates`, `POST /templates`, `GET /templates/{id}`, `PATCH /templates/{id}`, `POST /templates/{id}/duplicate`, `POST /templates/{id}/preview`, `POST /templates/preview`, `POST /templates/{id}/test`, `POST /templates/{id}/versions/{v}/restore`, `DELETE /templates/{id}` |
| Automations | `GET /catalog`, `GET /automations`, `POST /automations`, `GET /automations/{id}`, `PATCH /automations/{id}`, `POST /automations/{id}/enable`, `POST /automations/{id}/disable`, `POST /automations/{id}/dry-run`, `POST /automations/dry-run`, `GET /automations/{id}/executions`, `DELETE /automations/{id}` |
| Activity | `GET /overview`, `GET /analytics`, `GET /messages`, `GET /messages/{id}`, `POST /messages/{id}/retry`, `POST /messages/{id}/cancel`, `GET /audit-logs` |
| Settings | `GET/PATCH /settings`, `GET/POST /suppressions`, `DELETE /suppressions/{id}`, `GET/POST /ingest-keys`, `DELETE /ingest-keys/{id}` |
| Public | `POST /api/v1/events` (and `/api/v1/events/ingest`), `GET/POST /api/email/unsubscribe/{token}` |

Lists page with `?limit=` (≤100) and `?cursor=`; `GET /messages` filters by `from`, `to` (dates or
timestamps), `status` (comma separated), `accountId`, `provider`, `ruleId`, `kind`, `recipient`
(exact address, matched by hash). Rate limits are in `apps/api/src/rateLimit.ts` (`email*` entries).

**Custom events** (`Authorization: Bearer ek_live_…`):

```bash
curl -X POST https://<app>/api/v1/events -H "Authorization: Bearer ek_live_…" -H "Content-Type: application/json" \
  -d '{"id":"booking-1042","type":"appointment.booked","customer":{"email":"pat@example.com","first_name":"Pat","accepts_marketing":false},"data":{"starts_at":"2026-11-03 10:00"}}'
```

`202` when accepted, `200` with `"duplicate": true` for an id already received. Types are two to
four lowercase dotted parts; `order.*`, `checkout.*`, `refund.*`, `email.*` and `insights.*` are
reserved. `data` holds up to 50 fields, three levels deep; templates and conditions use them as
`data.<field>`. Nothing is stored beyond the id when no enabled automation listens to the type.

## 5. Google (Gmail / Google Workspace) setup

1. Google Cloud console → the project behind the app (or a new one) → **APIs & Services → Library**:
   enable the **Gmail API**.
2. **OAuth consent screen**: add the scope `https://www.googleapis.com/auth/gmail.send` (plus
   `openid`, `email`). `gmail.send` is a *sensitive* scope: until the app passes Google's OAuth
   verification, only test users listed on the consent screen can connect, and refresh tokens of an
   app in "Testing" status expire after 7 days. Verification needs the privacy policy (updated: see
   `/privacy`, "Email sending"), a demo video of the connect flow, and the scope justification
   ("send the emails the merchant's automations and tests produce, from their own mailbox; nothing is
   read").
3. **Credentials → OAuth client (Web application)**: authorized redirect URI exactly
   `https://<APP_URL host>/api/email/oauth/google/callback`. The existing "Insights web" client can
   be reused (add the URI) or a separate one created.
4. Set `EMAIL_GOOGLE_CLIENT_ID` in `wrangler.jsonc` `vars` and
   `npx wrangler secret put EMAIL_GOOGLE_CLIENT_SECRET` (from `apps/cloudflare`), then deploy.
5. Workspace admins of a Google Workspace domain that restricts third-party apps must allow the
   client ID in Admin console → Security → API controls.

What the flow does: PKCE (S256), `access_type=offline` + `prompt=consent` (a refresh token on
reconnects too), `include_granted_scopes=false`. The callback checks the granted scopes (granular
consent can untick sending), takes the mailbox from the ID token (audience, issuer, expiry,
`email_verified`; `hd` marks Workspace), and stores the tokens sealed. A reconnect without a new
refresh token keeps the stored one; a new account without one is refused with instructions.

## 6. Microsoft (Outlook / Microsoft 365) setup

1. Microsoft Entra admin center → **App registrations → New registration**. Supported account
   types: "Accounts in any organizational directory and personal Microsoft accounts" for `common`
   (or organizations only, with `EMAIL_MICROSOFT_AUTHORITY=organizations`). Redirect URI (Web):
   `https://<APP_URL host>/api/email/oauth/microsoft/callback`.
2. **API permissions → Microsoft Graph → Delegated**: `Mail.Send`, `User.Read`, `offline_access`,
   `openid`, `email`, `profile`. No application permissions (the code only ever acts as the signed-in
   user, `/me`).
3. **Certificates & secrets → New client secret**; note its expiry (renew before it lapses; an
   expired client secret makes refreshes fail, which the code treats as our problem: accounts go
   `degraded`, not "reconnect").
4. Set `EMAIL_MICROSOFT_CLIENT_ID` (vars), `EMAIL_MICROSOFT_AUTHORITY` (`common` default) and
   `npx wrangler secret put EMAIL_MICROSOFT_CLIENT_SECRET`, then deploy.
5. Organizations that block user consent need an admin to grant consent once (Enterprise
   applications → the app → Permissions → Grant admin consent). Merchants see "An administrator of
   your Microsoft organization must approve Insights" until then.
6. Publisher verification (Microsoft Partner Network) is recommended for multi-tenant apps; without
   it many tenants show an "unverified" warning or block consent.

Handled: consent required (AADSTS65001/90094), Conditional Access / MFA (53003, 50076…), disabled
accounts (50057), expired or revoked grants (700082, 70008…), refresh-token rotation on every
refresh (stored in the same compare-and-set write), throttling (429 + `Retry-After`), mailboxes not
enabled for REST, `ErrorSendAsDenied`.

## 7. Custom SMTP

Form fields: address, display name, host, port (465 TLS, 587 STARTTLS, 2525 STARTTLS — port 25 is
blocked on Cloudflare Workers), username, password or app password, reply-to. The password is
sealed and never returned.

Before every connection the host must be a public DNS name or public IP, and every address it
resolves to (DNS over HTTPS, A and AAAA) must be public unicast: loopback, private (RFC 1918),
carrier-grade NAT, link-local and cloud metadata (169.254.0.0/16, fd00::/8…), multicast,
documentation and other special ranges are refused, as are `localhost`, `*.local`, `*.internal` and
similar names. Cloudflare's network is a second boundary: Workers can't reach private networks.

The connection is encrypted before any credential is sent: implicit TLS on 465, or STARTTLS that the
server must offer and that must succeed (no fallback). Certificate validation is done by the Workers
runtime and can't be turned off. AUTH PLAIN or LOGIN. Diagnostics map to plain messages: wrong
password (535), password sign-in not offered, app-specific password required (534), TLS failure,
STARTTLS unavailable, connection refused, timeout, invalid host, blocked destination, sender
refused (553/550 on MAIL FROM), recipient refused (550 5.1.1 → bounced + suppressed), rate limited
(421/452).

Providers that are turning SMTP password sign-in off (Gmail, Microsoft 365) are pointed to their
OAuth option instead of being worked around. Zoho, Fastmail and most hosting providers work with an
app password.

**Sender authorization for SMTP:** the account's address is not verified by signing in alone. It
becomes verified by either (a) a 6-digit code sent through the account to that address being
entered back (proves the server relays for it and someone reads it), or (b) a successful connection
test while the address's domain is verified in this workspace. Additional From addresses on an
SMTP account follow the same rules. Google and Microsoft accounts send only as the address that
signed in.

## 8. Domain verification

Settings → Email integrations → Domains → add `example.com` and choose who sends its mail (Google,
Microsoft, other). Insights shows:

| Record | Host (relative / full) | Value |
| --- | --- | --- |
| Ownership TXT | `_insights-verify` / `_insights-verify.example.com` | `insights-verification=<random token>` |
| SPF TXT | `@` | `v=spf1 include:_spf.google.com ~all` (Google), `include:spf.protection.outlook.com` (Microsoft), or the provider's own |
| DKIM | `<selector>._domainkey` | issued by the email service (Google: `google`; Microsoft: `selector1`/`selector2` CNAMEs; others: enter the selector) |
| DMARC TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@example.com` to start |

Checks read public DNS through DNS over HTTPS (Cloudflare, Google fallback). Ownership states:
`unverified → pending` (record not found) / `failed` (a different value) → `verified`; `expired`
after 7 days without verification (a new challenge can be generated); a verified domain whose
record disappears goes to `recheck_required` and, after 3 consecutive failed daily rechecks, to
`failed` (senders authorized by it go back to pending). A DNS outage changes nothing but the error
shown. SPF follows nested includes within SPF's 10-lookup limit; more than one SPF record or `+all`
fails. DKIM passes only when a real public key is published at a known selector (Insights never
invents DKIM records or claims signing happened). DMARC `p=none` is reported as "needs attention".
Insights never writes DNS records. Pending domains are rechecked every 15 minutes, verified ones
daily, and on demand ("Check now", rate-limited).

## 9. Configuration

| Setting | Where | Default | Notes |
| --- | --- | --- | --- |
| `EMAIL_GOOGLE_CLIENT_ID` | `wrangler.jsonc` vars | empty | empty: Google button says "not set up" |
| `EMAIL_GOOGLE_CLIENT_SECRET` | Worker secret | empty | |
| `EMAIL_MICROSOFT_CLIENT_ID` | vars | empty | |
| `EMAIL_MICROSOFT_CLIENT_SECRET` | Worker secret | empty | |
| `EMAIL_MICROSOFT_AUTHORITY` | vars | `common` | `organizations`, `consumers` or a tenant id |
| `EMAIL_CREDENTIAL_KEYS` | Worker secret | empty → `TOKEN_ENCRYPTION_KEYS` | same format as `TOKEN_ENCRYPTION_KEYS`; refused in production if set to a public test value |
| `EMAIL_DEFAULT_DAILY_LIMIT` | vars | 500 | per workspace unless the workspace sets lower |
| `EMAIL_MAX_DAILY_LIMIT` | vars | 10000 | the most a workspace may set |
| `EMAIL_WORKSPACE_PER_MINUTE` | vars | 60 | per workspace across its accounts |
| `EMAIL_DOH_URL` | vars | Cloudflare DNS JSON | Google's is the fallback |
| `CUSTOMER_HASH_KEY` | secret (existing) | `OTP_PEPPER` | also keys recipient hashes (suppressions); see RUNBOOK before rotating |
| `EMAIL_QUEUE` binding | `wrangler.jsonc` queues | `insights-email` | must exist before deploy |

Redirect URIs are derived from `APP_URL` (never from the request). Per-account limits default to
under each provider's own published limits (`PROVIDER_LIMITS` in `constants.ts`): Gmail 400/day and
20/min, Google Workspace 1,800/day and 30/min, Outlook.com 250/day, Microsoft 365 9,000/day and
30/min, SMTP 1,000/day and 30/min (lower per account in the UI). Staging should use its own OAuth
clients and redirect URIs.

## 10. Queues, cron and deployment

- **Queue** `insights-email` (consumer: batch 10, timeout 2s, concurrency 5, 5 retries, DLQ
  `insights-dlq`). Jobs: `{kind:"email_event", eventId}` (run automations) and
  `{kind:"email_send", messageId}` (send one). Delays up to 12 hours ride the queue's
  `delaySeconds`; anything later is picked up by the sweep. Message rows are the source of truth, so
  a lost job only delays a send by one sweep.
- **Retries:** the message row counts attempts (`max_attempts` per rule, 1–8, default 5); temporary
  failures back off from about a minute to an hour with ±20% jitter, honouring `Retry-After`; rate
  limits and holds don't spend attempts. Exhaustion → `failed` (`retries_exhausted`). Uncertain sends
  → `unknown`, never retried automatically. Queue-level retries only cover infrastructure failures
  (the database being unreachable defers the job, as for every other queue).
- **Cron** (existing `*/15`): `sweepEmail` re-queues due/lost sends and events, marks sends stuck in
  `processing` over 10 minutes `unknown`, promotes abandoned checkouts, checks due domains, refreshes
  OAuth tokens unused for a week (keeps Microsoft's 90-day sliding refresh tokens alive and finds
  revoked grants early), and applies retention once a day.
- **Deploy order:** (1) `npx wrangler queues create insights-email`; (2) apply migration
  `20261015090000_email_integrations` to production (additive); (3) set the OAuth vars/secrets
  (optional — SMTP works without them); (4) the usual staged deploy.

## 11. Security controls

- Tenant isolation: membership check on every request (404 for non-members, no API keys), RLS on all
  15 tables, workspace filters in every query, composite tenant foreign keys, jobs re-load rows by
  `(id, workspace_id)`, tenant isolation tests.
- OAuth: PKCE S256, single-use state in the Coordinator bound to a browser cookie and to the user,
  membership and permission re-checked in the callback, fixed redirect URIs and fixed post-callback
  destination, granted scopes verified, ID token audience/issuer/expiry checked, reconnect bound to
  the same mailbox, concurrent callbacks for one mailbox resolved by a unique index + retry.
- Credentials: envelope encryption with per-row/per-purpose AAD; never returned, logged or stored
  in the browser; key rotation by re-wrapping (`ops:reencrypt`); revocation at Google on disconnect.
- Token lifecycle: refresh under a Coordinator lock with compare-and-set on `credential_version`;
  empty refresh tokens never overwrite stored ones; permanent errors mark the account once, audit and
  alert; our own client misconfiguration is treated as transient.
- SMTP: TLS only, SSRF policy with DNS re-check before each connection, timeouts on every step.
- Content: templates are a placeholder language (no helpers, no code, no prototype access); values
  HTML-escaped; HTML sanitized with an allowlist on save and after rendering (scripts, handlers,
  `javascript:`/`data:` URLs, dangerous CSS removed); subjects stripped of line breaks; MIME builder
  refuses CR/LF in any header value; previews in a sandboxed iframe with its own CSP.
- Rules: declarative JSON, schema-validated, depth ≤ 4, ≤ 40 conditions, list and string limits,
  fields restricted to the event's catalog, bounded evaluation.
- Sending: verified sender identities only (never an arbitrary From), suppression checks at
  scheduling and at send, marketing needs consent + unsubscribe link (RFC 8058 one-click
  `List-Unsubscribe`) + postal address footer, per-workspace and per-account limits, workspace pause,
  operator suspension.
- Privacy: recipients encrypted + keyed hash + masked; bodies never stored; event data encrypted and
  cleared after 35 days; logs redact tokens, codes and addresses; GDPR redaction hooks.
- Audit: `email.*` actions (connect, reconnect, disconnect, test, settings, domains, senders,
  templates, automations, retries, suppressions, keys, unsubscribes) with sanitized metadata;
  delivery events append-only (database trigger).

## 12. Delivery statuses and what they mean

| Status | Meaning |
| --- | --- |
| `queued` | waiting for its time or its turn |
| `processing` | being handed to the provider |
| `accepted_by_provider` | Gmail / Microsoft / the SMTP server took it — **not proof of delivery** |
| `delivered` | only with recipient-side evidence; none of the three send-only connections provides it today |
| `bounced` | the SMTP server refused the recipient as nonexistent during the conversation (also suppressed) |
| `deferred` | temporary failure or limit; retry scheduled |
| `failed` | not sent; reason shown |
| `suppressed` | not sent: unsubscribed or on the suppression list |
| `cancelled` | rule turned off, account disconnected, or cancelled by a person |
| `unknown` | sending interrupted after the provider may have received it; not retried automatically |

Open and click rates are not tracked and are shown as unavailable, never estimated.

## 13. Tests

| Suite | File | What it covers |
| --- | --- | --- |
| Unit (shared) | `packages/shared/test/email.test.ts` (30) | conditions (operators, missing values, depth/size limits, validation), templates (escaping, fallbacks, prototype access, variables), sanitizer (scripts, handlers, entity-encoded schemes, CSS, malformed markup), addresses/domains, SPF/DKIM/DMARC judging, SMTP policy (IPv4/IPv6 special ranges, mapped/NAT64), schemas |
| Unit (core) | `packages/core/test/email.test.ts` (14) | envelope encryption (AAD binding, rotation by rewrap), MIME (encoding, header injection), SMTP client against a fake server (STARTTLS, implicit TLS, no-TLS refusal, TLS failure, wrong password, refused connection, sender/recipient refusal, hard bounce, uncertain after DATA), Google ID token checks, Microsoft error mapping |
| Integration (API, real Postgres) | `apps/api/test/email.test.ts` (31) | tenant isolation (non-member 404s, cross-tenant sender/template refused), roles (analyst/viewer), removed membership, API keys refused; Google OAuth (scopes/PKCE, connect, encryption at rest, forged/replayed/foreign state, missing permission, missing refresh token, decline, reconnect keeps refresh token, different mailbox refused, not configured); Microsoft OAuth (connect via Graph /me, admin consent, missing Mail.Send); SMTP (connect, write-only password, SSRF incl. DNS rebinding to private IP, ports, wrong password, no STARTTLS, code verification, test send, disconnect revokes and disables rules); domains (correct/incorrect/missing record, SPF/DKIM/DMARC accuracy, DNS outage, expiry/regenerate, domain-authorized sender, private domains); templates (sanitize, versions, restore, invalid variables, preview with footer); automations (ready-to-enable checks, dry run, validation); event API (auth, duplicates, reserved types, data limits, workspace scoping, no data stored when nothing listens); unsubscribe (one-click, idempotent, suppresses queued marketing, invalid token) |
| Integration (worker, real Postgres) | `apps/worker/test/email.test.ts` (19) | matching rule sends exactly once through Gmail with rendered content; non-matching and disabled rules send nothing; duplicate events and re-processing; missing recipient; suppressed recipient; marketing consent; frequency limit; delay on the queue; rate-limit hold without spending attempts; retry backoff then visible failure; uncertain send → unknown, never resent; concurrent token refresh refreshes once; revoked grant → reauthorization required, admins alerted, later mail held; Microsoft refresh-token rotation and keep-on-empty; disconnect cancels pending; queue consumer; Shopify order events normalized, deduped, encrypted; abandoned-checkout detection and cancellation by an order; sweep (interrupted sends, lost jobs, OAuth upkeep) |

Run: `pnpm test` (unit) and `TEST_PG_PORT=<throwaway port> pnpm test:integration`. Results at
completion (2026-10-14): unit 230 shared + 127 core passing; integration 294 API + 154 worker
passing (all suites, not only email); `pnpm lint` clean; typecheck clean. The UI was exercised in a
local Worker (`.claude/email-demo-server.mjs`, seed `apps/worker/demo/email-demo.seed.ts`):
overview, accounts (connect dialog, SMTP form refusing 169.254.169.254), domains, template editor
with live sandboxed preview, automation builder and dry run, activity filters and message detail,
settings, unsubscribe page, phone width.

Not run: load tests (thousands of concurrent jobs), live Google/Microsoft/SMTP providers, Redis
outage (no Redis), real Workers TCP sockets against a real SMTP server.

## 14. Known limitations

- **Delivery evidence:** send-only access can't read bounce notices, so `delivered` never appears
  and late bounces aren't seen; only synchronous SMTP refusals become `bounced`. A provider with
  delivery webhooks (Postmark, SES…) would be a new adapter with its own verified webhook endpoint.
- **No provider reconciliation:** with `gmail.send` / `Mail.Send` Insights can't list sent mail, so
  `unknown` messages can't be checked automatically; a person decides whether to resend.
- **Gmail send-as aliases and Microsoft shared mailboxes** aren't supported (they need broader
  scopes); each mailbox connects as itself.
- **Microsoft revocation:** there is no API to revoke one app's delegated grant; disconnecting deletes
  the tokens and the merchant removes the app from their account.
- **Google verification:** until the OAuth app is verified for `gmail.send`, only listed test users
  can connect and their refresh tokens expire after 7 days.
- **SMTP DNS rebinding:** the host is resolved and checked, then the runtime resolves it again to
  connect; a rebinding attacker could race that window. Workers can't reach private networks, which
  closes the practical impact; there's no way to pin the checked address while keeping TLS name
  validation.
- **No SMTP connection pooling** (each send is its own connection: Workers invocations don't share
  sockets).
- **Events:** Shopify customer-created/updated events aren't offered (those webhook topics aren't
  subscribed); refunds aren't an email event yet. Abandoned checkouts need the checkout to carry an
  email and are detected 60–75 minutes after the last change.
- **Conditions UI** edits one level of all/any; deeper trees are edited as JSON.
- **Timezones:** delays are absolute; "send at 9am the customer's time" isn't supported.
- **Per-tenant concurrency** is enforced as per-minute throughput (Coordinator counters), not a
  hard concurrent-connection cap.

## 15. Production checklist

1. `npx wrangler queues create insights-email` (from `apps/cloudflare`).
2. Apply migration `20261015090000_email_integrations` to production before deploying.
3. (Gmail) Enable Gmail API, add `gmail.send` to the consent screen, add the redirect URI, set
   `EMAIL_GOOGLE_CLIENT_ID` + `EMAIL_GOOGLE_CLIENT_SECRET`; start Google's verification for the
   sensitive scope.
4. (Microsoft) Register the Entra app with delegated `Mail.Send`, `User.Read`, `offline_access`, set
   `EMAIL_MICROSOFT_CLIENT_ID` + `EMAIL_MICROSOFT_CLIENT_SECRET`; calendar the secret's expiry;
   consider publisher verification.
5. Optional: `EMAIL_CREDENTIAL_KEYS` (separate key-encryption keys for email credentials); put the
   same value in the maintenance `.env`.
6. Review limits (`EMAIL_DEFAULT_DAILY_LIMIT`, `EMAIL_MAX_DAILY_LIMIT`, `EMAIL_WORKSPACE_PER_MINUTE`).
7. Deploy (UI and Worker together: the UI calls the new routes).
8. Smoke test: connect an SMTP or Google test account, send a test to yourself, create a rule on a
   test event via the event API, watch Activity.
9. Watch logs for `email send failed` and alerts `email_account_reauth:*` in the first days.

## 16. Status

**Implemented and tested (automated tests passing):** multi-tenant data model with RLS and
composite FKs; envelope encryption and rotation; Google and Microsoft OAuth flows (against faked
provider endpoints); TokenManager (refresh, rotation, locking, reauthorization, alerts); SMTP client
and SSRF policy (against a fake server); domain verification and SPF/DKIM/DMARC judging (against
faked DNS); sender verification; templates (sanitizer, renderer, versions, preview); rule engine and
dry run; Shopify event normalization and abandoned-checkout detection; custom event API; delivery
(limits, retries, holds, suppression, unknown outcomes); unsubscribe; activity, analytics; sweep and
retention; RBAC and tenant isolation; all API routes; the dashboard (verified in a local Worker).

**Implemented but not live-provider tested:** real Gmail API sends, real Microsoft Graph sends and
token refreshes, real SMTP over Workers TCP sockets (TLS/STARTTLS handshakes by the runtime), real
DNS over HTTPS answers, Google/Microsoft consent screens.

**Requires administrator configuration:** the `insights-email` queue, the production migration,
Google OAuth client + Gmail API + consent screen + verification, Microsoft Entra app registration +
secret (+ admin consent per customer tenant where required), optional `EMAIL_CREDENTIAL_KEYS`.

**Not implemented:** provider delivery webhooks / bounce processing beyond synchronous SMTP
refusals, open/click tracking (deliberately), Gmail aliases and Microsoft shared mailboxes,
customer-created events from Shopify, load testing, per-recipient timezone scheduling, attachments.
