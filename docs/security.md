# Security model

| Concern | Control | Where |
| --- | --- | --- |
| SaaS identity | Firebase ID token verified server-side; httpOnly, SameSite=Lax, Secure session cookie; revocation checked per request | `apps/api/src/routes/auth.ts`, `context.ts` |
| CSRF | SameSite=Lax + Origin check on every cookie-authenticated non-GET | `apps/api/src/app.ts` |
| OTP | CSPRNG, peppered HMAC at rest, 10 min TTL, 5 attempts, single use, per-email & per-IP rate limits, no enumeration | `routes/auth.ts`, `packages/shared/src/otp.ts` |
| Email sign-in links (fallback) | When the code email can't be sent, Firebase emails a one-click EMAIL_SIGNIN link back to `/login` or `/start` only; the code is redeemed server-side for that exact email (single use), then the same custom-token sign-in as OTP; an unverified account loses its password/sessions | `routes/auth.ts`, `authProvider.ts`, `apps/web/src/lib/emailLink.ts` |
| Shopify OAuth | Domain normalisation, query HMAC, timestamp window, state in Redis + browser cookie, single-use state, same-user check | `routes/shopify.ts` |
| Continue with Shopify sign-up | Origin-checked start/finish/cancel; signup record bound to an httpOnly cookie, 30 min, single use at claim; tokens held AES-GCM encrypted; Shopify email trusted only when `email_verified`; sign-in token issued once (2-minute retry window); claim requires a session whose verified email matches; never connects into a shared workspace; proving an email strips any password/sessions an unverified account had | `routes/shopifySignup.ts`, `connectStore.ts`, `authProvider.ts` |
| Shopify tokens | Expiring offline tokens; AES-256-GCM with per-store AAD; versioned keys for rotation; never returned by the API or logged | `packages/core/src/tokens.ts` |
| Client secret | Server-only env / Secret Manager; never sent to the browser | |
| Webhooks | Raw-body HMAC, unique delivery id, queued processing | `routes/webhooks.ts` |
| Tenant isolation | (1) membership check → 404 for non-members; (2) every query filters by workspace; (3) Postgres RLS on all tenant tables via `app.workspace_id` for the `app_rls` role | `context.ts`, `packages/db`, `migrations/*_rls` |
| Authorization | Role matrix owner/admin/analyst/viewer | `packages/shared/src/roles.ts` |
| API keys | `sk_live_` + 240 bits, SHA-256 hash stored, shown once, read-only, workspace-scoped, revocable | `routes/workspaces.ts` |
| PII | No customer names/emails/addresses stored; customer id → keyed HMAC only with `read_customers`; GDPR webhooks handled | `persist.ts`, worker |
| Abuse | Global Redis rate limit (300/min/IP), stricter auth/OTP/pixel limits | `app.ts`, `rateLimit.ts` |
| Logs | pino with redaction of tokens, cookies, auth headers, codes | `packages/core/src/logger.ts` |
| Audit | Security-relevant actions recorded per workspace | `audit_logs` |
| Headers | `X-Frame-Options: DENY`, nosniff, referrer policy, permissions policy | `apps/web/next.config.ts` |
