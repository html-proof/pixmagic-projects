# Security model

| Concern | Control | Where |
| --- | --- | --- |
| SaaS identity | Firebase ID token verified server-side (RS256 pinned, issuer, audience, expiry); httpOnly, SameSite=Lax, Secure session cookie (5 days); revocation checked per request; signing keys re-fetched when a cookie names a newer one. Signing out retires that browser's cookie (kept on a denylist until it would have expired) instead of revoking the whole account, so other devices stay signed in; a password reset still ends every session | `apps/api/src/routes/auth.ts`, `authProvider.ts`, `context.ts` |
| CSRF | SameSite=Lax + Origin check on every cookie-authenticated non-GET; sign-in/sign-up endpoints check Origin even without a cookie (login CSRF) | `apps/api/src/app.ts`, `context.ts` (`requireAppOrigin`) |
| CORS | No CORS headers anywhere except the public web pixel (`*`, no credentials), so browsers never let another origin read the API | `routes/pixel.ts` |
| OTP | CSPRNG, peppered HMAC at rest, 10 min TTL, 5 attempts per code, single use, per-email & per-IP request limits, a per-address cap on guesses per day across all IPs and codes, no enumeration | `routes/auth.ts`, `packages/shared/src/otp.ts`, `rateLimit.ts` |
| Email sign-in links (fallback) | When the code email can't be sent, Firebase emails a one-click EMAIL_SIGNIN link back to `/login` only; the code is redeemed server-side for that exact email (single use), then the same custom-token sign-in as OTP; an unverified account loses its password/sessions | `routes/auth.ts`, `authProvider.ts`, `apps/web/src/lib/emailLink.ts` |
| Passwords | Never stored or seen by us: Firebase Auth holds them (scrypt). API keys and invitation tokens are 240/256-bit random and stored as SHA-256 only | Firebase, `routes/workspaces.ts` |
| Shopify OAuth | Domain normalisation, query HMAC, timestamp window, single-use state in a Durable Object + browser cookie, same-user check | `routes/shopify.ts` |
| Shopify tokens | Permanent offline tokens; AES-256-GCM with per-store AAD; versioned keys for rotation; never returned by the API or logged | `packages/core/src/tokens.ts` |
| Secrets | Worker secrets only (`wrangler secret put`), never in `vars` or the UI bundle (only `NEXT_PUBLIC_FIREBASE_*`, which are public by design). In production the app refuses to start if `SESSION_SECRET`, `OTP_PEPPER` or `TOKEN_ENCRYPTION_KEYS` still holds a placeholder or test value from this repo | `packages/core/src/env.ts` |
| Webhooks | Raw-body HMAC (constant-time compare), unique delivery id (duplicates acknowledged once processed), queued processing; a body that names its shop (GDPR topics, `app/uninstalled`) must match the unsigned shop header | `routes/webhooks.ts` |
| Tenant isolation | (1) membership check → 404 for non-members; (2) every query filters by workspace; (3) Postgres RLS on all tenant tables via `app.workspace_id` for the `app_rls` role, with a test that fails any new tenant table without it | `context.ts`, `packages/db`, `migrations/*_rls`, `apps/api/test/security.test.ts` |
| Authorization | Role matrix owner/admin/analyst/viewer, enforced server-side per route | `packages/shared/src/roles.ts` |
| API keys | `sk_live_` + 240 bits, SHA-256 hash stored, shown once, read-only, workspace-scoped, revocable | `routes/workspaces.ts` |
| PII | No customer names/emails/addresses stored; customer id → keyed HMAC only with `read_customers`; contact details fetched live and sent `no-store`; GDPR webhooks handled | `persist.ts`, `routes/contacts.ts`, worker |
| WhatsApp PII | Only when a store connects WhatsApp: customer WhatsApp number + first name AES-256-GCM encrypted (AAD `wa:<storeId>:<kind>`), keyed HMAC for lookup, masked in the UI; send details encrypted and cleared once sent; retention purge; customers/redact + shop/redact delete it | `packages/core/src/whatsapp/*`, docs/whatsapp.md |
| WhatsApp webhooks | `X-Hub-Signature-256` HMAC of the raw body with the app secret, verified before anything is applied; a manual connection's own secret vouches only for its own WABA; GET handshake needs the verify token | `routes/whatsappPublic.ts`, `webhook.ts` |
| Tracking/review links | 24-byte random tokens, only their SHA-256 is looked up; expire after 120 days; `noindex`, `no-referrer`; per-IP rate limits | `routes/whatsappPublic.ts` |
| SSRF | Outbound requests go only to fixed Google/Firebase hosts, `*.myshopify.com` (validated), and Shopify's bulk-result link (HTTPS only); Workers cannot reach private networks | `authProvider.ts`, `packages/core/src/shopify.ts`, `apps/worker/src/bulkOrders.ts` |
| Abuse | Workers Rate Limiting binding (300/min/IP on the API) plus per-key limits for sign-in, codes, invitations, workspace/API-key creation, contacts, refresh and the pixel, all in one table | `apps/cloudflare/wrangler.jsonc`, `apps/api/src/rateLimit.ts` (`LIMITS`) |
| Logs | JSON logger redacting credential fields (case-insensitive, any depth) and scrubbing tokens and email addresses out of messages and errors | `packages/core/src/logger.ts` |
| Errors | Unhandled errors return a generic 500; stack traces stay in logs | `apps/api/src/app.ts` |
| Audit | Security-relevant actions recorded per workspace | `audit_logs` |
| Headers | UI: HSTS, `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`, nosniff, referrer and permissions policies. API: nosniff, `Cache-Control: no-store`, CSP `default-src 'none'`, `X-Frame-Options: DENY` | `apps/web/public/_headers`, `apps/api/src/app.ts` |
| Source maps | Not produced for the browser (Next.js default) and not uploaded with the Worker | `apps/web/next.config.ts`, `wrangler.jsonc` |
| Dependencies | `pnpm audit` clean; vulnerable transitive build tools pinned up through `pnpm.overrides` | `package.json` |

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
