# Security model

Audits: [2026-10-10](security-audit-2026-10-10.md) and [2026-10-14](security/SECURITY_AUDIT.md)
([implementation](security/SECURITY_IMPLEMENTATION.md), [tests](security/SECURITY_TEST_RESULTS.md),
[deployment checklist](security/SECURITY_DEPLOYMENT_CHECKLIST.md)).

| Concern | Control | Where |
| --- | --- | --- |
| SaaS identity | Amazon Cognito user pool, spoken to only by the Worker (backend-for-frontend): no Cognito token ever reaches page JavaScript. Its ID token is verified server-side (RS256 pinned, the pool's JWKS, issuer, audience = our confidential app client, `token_use`, expiry, and a nonce for Google) before anything else happens. Our own session: HMAC-signed, httpOnly, SameSite=Lax, Secure cookie (5 days) + the Cognito refresh token AES-256-GCM encrypted (bound to the identity) in an httpOnly cookie sent to `/api` only; re-checked with Cognito every 10 minutes (disabled, deleted or signed-out-everywhere users lose the session; Cognito unreachable does not sign anyone out). Signing out retires that session id until it would have expired and revokes that device's refresh token; "sign out everywhere" and password changes/resets move `users.sessions_valid_after` and end every Cognito refresh token | `apps/api/src/cognito.ts`, `session.ts`, `context.ts` (`loadUser`) |
| CSRF | SameSite=Lax + Origin check on every cookie-authenticated non-GET; sign-in/sign-up endpoints check Origin even without a cookie (login CSRF) | `apps/api/src/app.ts`, `context.ts` (`requireAppOrigin`) |
| CORS | No CORS headers anywhere except the public web pixel (`*`, no credentials), so browsers never let another origin read the API | `routes/pixel.ts` |
| Emailed codes | Sign-up confirmation, password reset, email change/verification and (when switched on) passwordless sign-in codes are Cognito's own (generated, stored, expired and limited by Cognito); on top, per-IP and per-address limits on sending and per-IP limits on guessing; answers never say whether an account exists (Cognito `PreventUserExistenceErrors` plus identical responses) | `routes/auth.ts`, `rateLimit.ts`, `infra/aws/cognito.yaml` |
| Google | Cognito managed login, authorization code + PKCE (S256) + nonce, `identity_provider` sent so no Cognito page shows; state single use (Durable Object) and bound to the browser that started it (`__oauth` cookie: no login CSRF); the code is exchanged server-side with the client secret; a federated account is linked to an existing one only on a provider-verified email | `routes/auth.ts`, `identity.ts` |
| HTTPS | Cloudflare: the Worker redirects plain-http GETs to https and refuses other plain-http requests (workers.dev answers http too). AWS: CloudFront redirects to https. HSTS on pages and API responses. Local hosts are exempt | `apps/api/src/https.ts`, `apps/cloudflare/src/index.ts`, `infra/cdk/lib/app-stack.ts` |
| Passwords | Never stored by us: Cognito holds them (salted hash). They pass through the Worker on sign-in (USER_PASSWORD_AUTH) and are never logged. During the migration window a password Cognito doesn't know yet is checked once against Firebase (`accounts:signInWithPassword`) and used to create the Cognito user; no password hash is ever exported. API keys and invitation tokens are 240/256-bit random and stored as SHA-256 only | `routes/auth.ts`, `legacyFirebase.ts`, `routes/workspaces.ts` |
| Shopify OAuth | Domain normalisation, query HMAC, timestamp window, single-use state in a Durable Object + browser cookie, same-user check | `routes/shopify.ts` |
| Shopify tokens | Permanent offline tokens; AES-256-GCM with per-store AAD; versioned keys for rotation; never returned by the API or logged | `packages/core/src/tokens.ts` |
| Secrets | Worker secrets only (`wrangler secret put`), never in `vars` or the UI bundle (the UI has no settings at all). The Cognito app client secret and the admin access key (an IAM user allowed five admin calls on this one pool) come from Secrets Manager without being printed (`infra/aws/worker-secrets.mjs`). In production the app refuses to start if `SESSION_SECRET`, `OTP_PEPPER` or `TOKEN_ENCRYPTION_KEYS` still holds a placeholder or test value from this repo, or with a Cognito emulator configured | `packages/core/src/env.ts` |
| Webhooks | Raw-body HMAC (constant-time compare), unique delivery id (duplicates acknowledged once processed), queued processing; a body that names its shop must match the unsigned shop header, and the destructive topics (`app/uninstalled`, `shop/redact`, `customers/*`) must name one; a client's custom-distribution app only vouches for that client's store | `routes/webhooks.ts` |
| Tenant isolation | (1) membership check → 404 for non-members; (2) every query filters by workspace; (3) Postgres RLS on all tenant tables via `app.workspace_id` for the `app_rls` role, with a test that fails any new tenant table without it | `context.ts`, `packages/db`, `migrations/*_rls`, `apps/api/test/security.test.ts` |
| Authorization | Role matrix owner/admin/analyst/viewer, enforced server-side per route. OAuth callbacks (Shopify, ads) re-check the role when the platform sends the person back. Removing or demoting a member below `apikeys:manage` revokes the API keys they made; pending invitations can be cancelled; owner changes are serialized (no ownerless workspace) | `packages/shared/src/roles.ts`, `routes/workspaces.ts` |
| Staff Management | Supervisors see only their assigned employees (scope ANDed with every filter); pay settings (rates, overtime/break policies, currency) need `pay:manage`; nobody but the owner edits/approves their own hours or pay, and whoever submits a payroll can't approve it; database triggers freeze approved shifts, their breaks and finalized payroll items | `packages/core/src/staff/*`, migrations `*_staff_management`, `*_security_hardening` |
| API keys | `sk_live_` + 240 bits, SHA-256 hash stored, shown once, read-only, workspace-scoped, revocable | `routes/workspaces.ts` |
| PII | No customer names/emails/addresses stored; customer id → keyed HMAC only with `read_customers`; contact details fetched live and sent `no-store`; GDPR webhooks handled | `persist.ts`, `routes/contacts.ts`, worker |
| WhatsApp PII | Only when a store connects WhatsApp: customer WhatsApp number + first name AES-256-GCM encrypted (AAD `wa:<storeId>:<kind>`), keyed HMAC for lookup, masked in the UI; send details encrypted and cleared once sent; retention purge; customers/redact + shop/redact delete it | `packages/core/src/whatsapp/*`, docs/whatsapp.md |
| WhatsApp webhooks | `X-Hub-Signature-256` HMAC of the raw body with the app secret, verified before anything is applied; a manual connection's own secret vouches only for that connection (not others on the same WABA); preference changes reach only the store whose number they name; a START older than the last consent change is ignored; unsigned deliveries are rate limited before parsing; GET handshake needs the verify token | `routes/whatsappPublic.ts`, `webhook.ts` |
| Email integrations | OAuth (Google `gmail.send`, Microsoft delegated `Mail.Send`) with PKCE, single-use state bound to the browser and the person, exact redirect URIs, membership re-checked in the callback; tokens and SMTP passwords envelope-encrypted (per-secret data key wrapped by `EMAIL_CREDENTIAL_KEYS`, AAD per row and purpose), never returned or logged; refresh under a Coordinator lock with compare-and-set; SMTP TLS/STARTTLS only, host and every resolved address checked against private/loopback/link-local/metadata ranges before each connection; templates sanitized (allowlist) on save and after rendering, placeholders only (no code); previews in a sandboxed iframe; rules a bounded declarative tree; composite `(id, workspace_id)` foreign keys between email tables; recipients encrypted + keyed hash + masked; append-only delivery events; event API keys (`ek_live_`, SHA-256 stored) can only post events to their own workspace | `packages/core/src/email/*`, `packages/shared/src/email/*`, `apps/api/src/routes/email*.ts`, docs/email.md |
| Tracking/review links | 24-byte random tokens, only their SHA-256 is looked up; expire after 120 days; `noindex`, `no-referrer`; per-IP rate limits | `routes/whatsappPublic.ts` |
| SSRF | Outbound requests go only to fixed AWS Cognito/Google/Microsoft hosts (and, during the migration window, Firebase's sign-in endpoint), `*.myshopify.com` (validated), Shopify's bulk-result link (HTTPS only) and Meta's `paging.next` (pinned to graph.facebook.com: it carries the token). The one user-chosen destination, an SMTP server, is limited to ports 465/587/2525 with TLS, and its name and every address it resolves to (DNS over HTTPS) must be public unicast; checked again before each connection. Workers cannot reach private networks | `authProvider.ts`, `packages/core/src/shopify.ts`, `apps/worker/src/bulkOrders.ts` |
| Ad platform tokens | AES-256-GCM, never returned; PKCE for Google; state single-use and bound to user, workspace and store; syncs pause while the store is uninstalled; the platform grant is revoked when the store's data is purged (unless another store relies on it) | `packages/core/src/adConnections.ts`, `persist.ts` |
| Pixel | Public ingest key; events older than 48 h (production) or in the future are dropped; paths ≤ 512 chars; dedupe ids pruned after 3 days | `routes/pixel.ts`, `apps/worker/src/index.ts` |
| Abuse | Workers Rate Limiting binding (300/min/IP on the API) plus per-key limits for sign-in, codes, invitations (per workspace and per sender), workspace/API-key creation, contacts, refresh, store connections, staff analytics and exports, WhatsApp estimates and the pixel, all in one table. 429s carry `Retry-After`. Only `cf-connecting-ip` counts as the client IP in production | `apps/cloudflare/wrangler.jsonc`, `apps/api/src/rateLimit.ts` (`LIMITS`) |
| Logs | JSON logger redacting credential fields (case-insensitive, any depth) and scrubbing tokens and email addresses out of messages and errors | `packages/core/src/logger.ts` |
| Errors | Unhandled errors return a generic 500 (a 503 "try again" when the database is unreachable); stack traces stay in logs | `apps/api/src/app.ts` |
| Audit | Security-relevant actions recorded per workspace, with the request's IP, and before/after values for pay changes; append-only (a trigger refuses edits; the tenant role can't delete); sign-ins are logged with the user id. Account-level events (account created, sign-in identity linked, account moved from Firebase, password reset or changed, email changed or verified, signed out everywhere, account deleted) in `auth_events` | `audit_logs`, `auth_events` (`apps/api/src/identity.ts`), migration `*_security_hardening` |
| Headers | UI: HSTS, `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'` (enforced) plus a full allowlist CSP in Report-Only, COOP `same-origin-allow-popups`, nosniff, referrer and permissions policies. API: nosniff, `Cache-Control: no-store`, CSP `default-src 'none'`, `X-Frame-Options: DENY`, HSTS over https | `apps/web/public/_headers` (served on AWS too, `apps/aws/src/staticSite.ts`), `apps/api/src/app.ts` |
| Source maps | Not produced for the browser (Next.js default) and not uploaded with the Worker | `apps/web/next.config.ts`, `wrangler.jsonc` |
| Dependencies | `pnpm audit` clean and enforced in CI (`--audit-level high`); vulnerable transitive build tools pinned up through `pnpm.overrides` | `package.json`, `.github/workflows/ci.yml` |
| Database roles | `app_rls` (every tenant request) has RLS on every tenant table, no write access to `users`, and append-only `audit_logs` | `infra/postgres/init.sql`, migrations |

## Database credentials and network exposure

`docker-compose.yml` publishes every port on the loopback addresses only. A bare `"5434:5432"`
listens on all interfaces, and Docker Desktop's Windows firewall rule admits it on every network
profile, so anyone on the same Wi-Fi (or on this PC's Mobile Hotspot) could log in to Postgres.

`POSTGRES_PASSWORD` and the `app_rls` password in `infra/postgres/init.sql` are development
defaults. Any database reachable from somewhere else (including through the Cloudflare Tunnel that
Hyperdrive uses) needs real ones. To rotate them on a running database:

```sql
ALTER ROLE app PASSWORD '<new owner password>';
ALTER ROLE app_rls PASSWORD '<new tenant password>';
```

then point both Hyperdrive configs at them (each command tests the connection first):

```bash
npx wrangler hyperdrive update <insights-db id> --origin-user app --origin-password '<new owner password>' --database app
```

```bash
npx wrangler hyperdrive update <insights-db-rls id> --origin-user app_rls --origin-password '<new tenant password>' --database app
```

Local tools that connect directly (`DATABASE_URL`, `APP_DATABASE_URL`, the tests' `TEST_PG_PORT`
database) need the new passwords too.

The owner role `app` is the Postgres superuser that `POSTGRES_USER` creates. The Worker's system
paths use it, so it can do anything on the database server. Moving those paths to a non-superuser
owner is tracked in [the 2026-10-10 audit](security-audit-2026-10-10.md).
