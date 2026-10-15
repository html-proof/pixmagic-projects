# Security implementation, 2026-10-14

> Historical record (2026-10-14): written when Insights ran on Cloudflare Workers. It now runs on
> AWS: see [aws-architecture.md](../aws-architecture.md) and, for the current model, [security.md](../security.md).

> **Ported 2026-10-16.** Written on the Firebase tree; the fixes reached `main` (and AWS) in
> branch `claude/security-hardening-aws`, ported onto the Cognito/AWS tree. Differences: the optional
> Turnstile check on "Email me a code" was left out (it needs redoing for Cognito's
> `/auth/otp/start` with the site key served by `/auth/config`); the migration is now
> `20261016100000_security_hardening`; Firebase token checks are now Cognito's
> (`apps/api/test/cognito.test.ts`). Deployment: [checklist](SECURITY_DEPLOYMENT_CHECKLIST.md).

What changed for each of the 19 requirements in the brief, and what is still open. Finding numbers
(#) refer to [SECURITY_AUDIT.md](SECURITY_AUDIT.md). Test names refer to
`apps/api/test/hardening.test.ts`, `apps/worker/test/hardening.test.ts` and the files named; results
are in [SECURITY_TEST_RESULTS.md](SECURITY_TEST_RESULTS.md).

Three commits were cherry-picked from the unmerged `claude/project-audit-restructure-ed93a6`, because
they implement parts of requirements 4, 10 and 12, and re-implementing them would have guaranteed
merge conflicts:

| Commit | What it does |
| --- | --- |
| `b0feb18` | Request ids (`x-request-id`) on every response and in every log line |
| `044b545` | Outbound-call timeouts, `audit()` that never fails a change, per-IP limit on unsigned WhatsApp webhooks |
| `f1c5fc5` | Production refuses the Auth emulator, Mailpit or a local `APP_URL`/`API_URL`; `CUSTOMER_HASH_KEY` |

Everything else is uncommitted in the working tree.

## Checklist

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Row-level security | PASS |
| 2 | Authentication on every protected API | PASS |
| 3 | Backend input validation (never trust the frontend) | PASS |
| 4 | API rate limiting | PASS |
| 5 | Input sanitization and safe output | PASS |
| 6 | Parameterized database queries | PASS |
| 7 | Restricted CORS | PASS |
| 8 | HTTPS enforcement | PASS (code) / PARTIAL (host) |
| 9 | IDOR prevention | PASS |
| 10 | Production debug restrictions | PASS |
| 11 | CAPTCHA on appropriate public forms | PARTIAL (implemented, off until keys exist) |
| 12 | Admin activity audit logs | PASS |
| 13 | Private storage | NOT APPLICABLE |
| 14 | Admin authorization | PASS |
| 15 | Dependency vulnerability remediation | PASS |
| 16 | Secure file uploads | NOT APPLICABLE |
| 17 | Independent security review | PARTIAL |
| 18 | Security headers | PARTIAL |
| 19 | Webhook signature verification | PASS |

---

### 1. Row-level security: PASS

**Implementation.**
- RLS was already on every tenant table; I verified all 58 tables, including the 19 Staff tables
  added today. Tenant reads run as `app_rls` through `withTenant`, which sets `app.workspace_id`
  per transaction.
- New migration `20261014200000_security_hardening`:
  - `app_rls` loses write access to `users`;
  - `audit_logs` becomes append-only (an update trigger, plus no UPDATE/DELETE for `app_rls`).
- `init.sql` repeats the same revokes, so re-running it can't hand the rights back.

**Files modified.** `packages/db/prisma/migrations/20261014200000_security_hardening/migration.sql`,
`infra/postgres/init.sql`.

**Tests.**
- "database guarantees › the audit trail can't be edited…";
- `apps/api/test/security.test.ts` (an RLS policy on every workspace table);
- `tenancy.test.ts`.

**Remaining risk.**
- System paths (webhooks, jobs, auth bootstrap) still use the owner role, which bypasses RLS, and
  that role is the Postgres superuser (finding 5 of the 2026-10-10 audit, still open).
- `app_rls` can still SELECT encrypted token columns in its own workspace. Column-level grants are
  not done.

### 2. Authentication on every protected API: PASS

**Implementation.**
- Every route was classified (audit, "Route classification"); none were missing auth.
- Shopify and ads OAuth callbacks now re-check the role when the person comes back (#14).
- `clientIp` trusts only `cf-connecting-ip` in production (#28).
- A structured `session_created` log line records each sign-in (user id and IP).

**Files modified.** `apps/api/src/routes/shopify.ts`, `routes/ads.ts`, `context.ts`, `routes/auth.ts`.

**Tests.**
- "authentication and authorization (scenarios 1, 3, 4, 15)";
- "token verification (scenarios 4, 5)": expired, wrong audience, wrong issuer, unsigned;
- "Shopify OAuth callback › re-checks…";
- `auth.test.ts`, `session.test.ts`.

**Remaining risk.** The session cookie isn't `__Host-` prefixed (renaming it signs everyone out).
Firebase-side sign-up and password reset aren't covered by our limits; turn on App Check in the
Firebase console.

### 3. Never trust the frontend: PASS

**Implementation.**
- Already: every body and query goes through a strict Zod schema. Role, user, workspace, prices,
  plan and payment status are never taken from the client.
- New:
  - pay-affecting employee fields need `pay:manage` (#2);
  - nobody but the owner edits or approves their own hours and pay (#3);
  - the supervisor scope can't be overridden by a filter (#1).

**Files modified.** `packages/core/src/staff/{common,employees,attendance,payroll,analytics}.ts`,
`apps/api/src/staffAccess.ts`, `apps/web/src/components/staff/EmployeeForm.tsx` (fields disabled for
HR; the server is the guard).

**Tests.** "Staff Management access" (3 tests), `staff.test.ts`.

**Remaining risk.** None known.

### 4. API rate limiting: PASS

**Implementation.**
- Already: a Cloudflare per-IP limit on the whole API, plus per-key Durable Object limits.
- New limits:
  - staff analytics and reports, per user;
  - invitations per sender per day;
  - store connections, per user;
  - WhatsApp audience estimates, per store.
- Unsigned WhatsApp webhooks are limited before parsing.
- Every 429 carries `Retry-After`.

**Files modified.** `apps/api/src/rateLimit.ts`, `app.ts`, `context.ts`, `routes/{staffReports,workspaces,staff,shopify,whatsappOps,whatsappPublic}.ts`.

**Tests.** "rate limits (scenario 12)", `security.test.ts` rate-limit cases.

**Remaining risk.**
- The limiter is fixed-window, so a burst at the window edge can reach 2× the limit.
- The pixel has no per-store quota (#9 residual).
- Outbound Shopify, Meta and Google calls already back off and retry boundedly (`MAX_ATTEMPTS`).

### 5. Sanitize and validate input: PASS

**Implementation.**
- Already: React escaping everywhere, no HTML sinks, `https:`-only links, and newlines stripped
  from WhatsApp template values.
- New:
  - CSV cells are always quoted (#21);
  - pixel paths are capped at 512 characters;
  - `?choose=` is validated (#19);
  - Meta paging is pinned to graph.facebook.com (SSRF, #18).

**Files modified.** `packages/core/src/staff/files.ts`, `apps/api/src/routes/pixel.ts`,
`apps/web/src/app/(app)/settings/ads/page.tsx`, `packages/core/src/ads.ts`.

**Tests.** "injection and unsafe content (scenarios 6, 7)", `staffFiles.test.ts`, "the public pixel".

**Remaining risk.** None known.

### 6. Parameterized queries: PASS

**Implementation.** Audit only, no change needed: all raw SQL is tagged templates or
`Prisma.join`, and no dynamic identifiers come from input. The new queries follow the same
pattern.

**Files modified.** —

**Tests.** "SQL-looking input is data…".

**Remaining risk.** The runtime superuser (see 1).

### 7. Lock down CORS: PASS

**Implementation.** Audit only, no change needed: no CORS headers anywhere except the public pixel
(`*`, no credentials), and an Origin check on every cookie-authenticated write.

**Files modified.** —

**Tests.** "CORS and CSRF (scenario 13)", `security.test.ts`.

**Remaining risk.** Other `*.workers.dev` hosts count as same-site; the Origin check covers this.

### 8. HTTPS everywhere: PASS (code) / PARTIAL (host)

**Implementation.**
- `requireHttps` in the Worker redirects plain-http GETs to https and refuses anything else, except
  on local hosts. Production answered `http://` with 200 before this (#10).
- HSTS is now on API responses too, not only on pages.
- TLS terminates at Cloudflare's edge (workers.dev). There is no origin server, so the "Full
  (strict)" mode doesn't apply.
- The database hop is Hyperdrive → Tunnel → Postgres with TLS (`ssl=on`).

**Files modified.** `apps/api/src/https.ts` (new), `apps/cloudflare/src/index.ts`, `apps/api/src/app.ts`.

**Tests.** "security headers and HTTPS (scenario 18)".

**Remaining risk.** Host services on the owner's PC listen on all interfaces (#11, manual). For a
custom domain later: enable "Always Use HTTPS" and HSTS on the zone too.

### 9. IDOR prevention: PASS

**Implementation.**
- Audit: every id from a path or body is checked against the workspace (and store), and non-members
  get 404.
- New:
  - the supervisor scope fix (#1);
  - the invitation delete route is workspace-scoped;
  - the export download link is bound to its user (already).

**Files modified.** see 3 and 14.

**Tests.** "tenant isolation (scenarios 2, 16)", "downloads and storage", `tenancy.test.ts`.

**Remaining risk.** None known.

### 10. Production debug restrictions: PASS

**Implementation.**
- Already: a generic 500 with stacks in logs only, no source maps, log redaction, and refusal to
  start on placeholder secrets.
- Cherry-picked (`f1c5fc5`): production refuses the Auth emulator, Mailpit and local URLs.
- New: production also refuses Turnstile test secrets and local Turnstile hostnames.

**Files modified.** `packages/core/src/env.ts`.

**Tests.** "errors and debug output (scenario 14)", `packages/core/test/security.test.ts`.

**Remaining risk.** None known.

### 11. CAPTCHA on public forms: PARTIAL

**Implementation.**
- Cloudflare Turnstile on "Email me a code" (`POST /auth/otp/request`), the public endpoint that
  sends email.
- The browser widget is rendered explicitly and reset after every attempt.
- The server calls Siteverify through `deps.fetchImpl`, with a 10 s timeout, and requires:
  - `success`;
  - action `otp_request`;
  - a hostname from `TURNSTILE_HOSTNAMES`, or APP_URL's host.
- It fails closed: 403, or 503 when Siteverify is unreachable.
- It runs before the per-address limit, so failed bots can't use up a person's code requests.
- It's on when `TURNSTILE_SECRET` is set. Authenticated users are never challenged.

**Files modified.** `apps/api/src/turnstile.ts` (new), `routes/auth.ts`, `packages/core/src/env.ts`,
`apps/web/src/components/Turnstile.tsx` (new), `apps/web/src/app/login/page.tsx`,
`apps/web/public/_headers`, `.env.example` files.

**Tests.** "Turnstile on 'email me a code'" (4 tests); a browser run against a local Worker with
Cloudflare's test keys.

**Remaining risk.**
- Off until the owner creates a widget and sets the keys (checklist).
- Sign-up, password and reset forms go straight to Firebase, so they need Firebase App Check.
- Review forms and invitations are protected by unguessable tokens instead.

### 12. Log admin actions: PASS

**Implementation.**
- Already: audit entries per workspace, with actor, target, metadata and IP.
- New entries:
  - pay rates, with values (set and deleted);
  - departments, break-policy and holiday deletions;
  - schedules;
  - re-opened shifts;
  - employee phone changes;
  - invitation cancellations;
  - key revocations on member removal;
  - staff settings, with values.
- Requests now carry an `x-request-id` correlation id (cherry-picked `b0feb18`).
- The log is append-only (see 1).
- Owner/admin can already view it (`GET /workspaces/:ws/audit-logs`).

**Files modified.** `packages/core/src/staff/{admin,employees,attendance}.ts`, `routes/staffPortal.ts`, `routes/workspaces.ts`.

**Tests.** "the audit trail can't be edited…", `observability.test.ts` (request ids).

**Remaining risk.** No retention policy: entries are kept for the workspace's life.

### 13. Private storage buckets: NOT APPLICABLE

**Implementation.** No bucket exists (R2 is commented out in `wrangler.jsonc`). Large webhook
bodies sit in the Durable Object, unreadable from outside, and are deleted once processed. Staff
exports are generated per request and handed out through a one-time, user-bound, 5-minute link
with `no-store`.

**Files modified.** —

**Tests.** "downloads and storage (scenarios 10, 11, 19)".

**Remaining risk.** If R2 is enabled later, keep the bucket private (no public r2.dev URL).

### 14. Secure admin pages: PASS

**Implementation.**
- Already: every admin action is checked server-side by role, with 401/403/404.
- New:
  - an admin's API keys are revoked on demotion or removal (#5);
  - invitations can be cancelled;
  - owner changes are serialized (#24);
  - OAuth callbacks re-check the role (#14).

**Files modified.** `apps/api/src/routes/workspaces.ts`, `apps/web/src/app/(app)/settings/members/page.tsx`.

**Tests.** "members and API keys" (2 tests), scenario 3.

**Remaining risk.** No MFA for owners (needs Firebase Identity Platform).

### 15. Update vulnerable dependencies: PASS

**Implementation.**
- `pnpm audit`: no known vulnerabilities (all severities).
- CI now fails on high or critical advisories.

**Files modified.** `.github/workflows/ci.yml`.

**Tests.** `pnpm audit` output in the test results.

**Remaining risk.** GitHub Actions are pinned by tag, not SHA. The `cloudflared:latest` and
`mailpit:latest` images are unpinned.

### 16. Secure file uploads: NOT APPLICABLE

**Implementation.** No upload endpoint exists (no multipart or file parsing anywhere). Request
bodies are capped: 1 MB, or 5 MB for Shopify webhooks; Meta webhooks were lowered to 1 MB.

**Files modified.** `apps/api/src/app.ts` (body limits).

**Tests.** "refuses oversized and malformed bodies".

**Remaining risk.** Receipt uploads are planned in `docs/staff.md`. They will need this whole list.

### 17. Independent security review: PARTIAL

**Implementation.**
- Four independent reviewers, plus manual OWASP-guided review: broken access control, auth,
  injection, configuration, dependencies, crypto, logging, SSRF, OAuth, multi-tenancy.
- A secret scan of the full history and `pnpm audit`.
- Each confirmed finding fixed and tested.

**Files modified.** —

**Tests.** Mutation checks: two fixes temporarily reverted made their tests fail.

**Remaining risk.** Semgrep, gitleaks and OWASP ZAP were not run (not installed). A human
penetration test is still recommended.

### 18. Security headers: PARTIAL

**Implementation.**
- Pages:
  - HSTS, `X-Frame-Options: DENY`, nosniff, Referrer-Policy;
  - a wider Permissions-Policy;
  - new COOP `same-origin-allow-popups` (Firebase/Meta popups keep working);
  - an enforced CSP (`frame-ancestors 'none'`, `base-uri`, `object-src`, `form-action`), plus a new
    full allowlist CSP as Report-Only.
- API: nosniff, `no-store`, `default-src 'none'`, DENY, and HSTS (new).
- The app isn't embedded in Shopify (`embedded = false`), so `frame-ancestors 'none'` is correct.

**Files modified.** `apps/web/public/_headers`, `apps/api/src/app.ts`.

**Tests.** Scenario 18 tests, `security.test.ts`, plus served headers checked against a local Worker.

**Remaining risk.**
- `script-src` isn't enforced yet: watch for Report-Only violations with the real Google, Apple and
  Meta popups, then promote it.
- `'unsafe-inline'` is needed by the static export's inline bootstrap scripts.

### 19. Verify webhook signatures: PASS

**Implementation.**
- Already: raw-body HMAC with a timing-safe compare, delivery-id dedupe with safe redelivery, and
  the body's shop must match the header.
- New:
  - destructive Shopify topics must name their shop (#12);
  - a custom app vouches only for its own store (#13);
  - a WhatsApp manual secret vouches only for its own connection (#6);
  - a late START can't undo a STOP;
  - unsigned WhatsApp bodies are limited before parsing.
- Shopify signs no timestamp, so replay is handled by dedupe.

**Files modified.** `apps/api/src/routes/webhooks.ts`, `routes/whatsappPublic.ts`, `packages/core/src/whatsapp/webhook.ts`.

**Tests.**
- "webhooks (scenarios 8, 9)" (3 tests);
- `apps/worker/test/whatsapp.test.ts` (3 new tests);
- `security.test.ts`, `multiapp.test.ts`.

**Remaining risk.** WhatsApp inbound messages aren't deduped by message id (status events are).

## Additional areas from the brief

- **Shopify OAuth.**
  - Uses Shopify's managed install plus the authorization-code grant.
  - Checks the query HMAC, a state that is single-use and bound to the cookie and user, the shop
    regex and the timestamp.
  - Required scopes are checked after the token exchange. Tokens are encrypted at rest and never
    reach the frontend.
  - On uninstall, tokens are wiped (and now ad syncs pause too).
  - The GDPR topics are handled.
  - The app is not embedded, so session-token requirements don't apply.
  - New: the callback re-checks the role, and launch has a freshness check.
- **Meta, TikTok.**
  - Meta Ads and WhatsApp are reviewed above. TikTok doesn't exist in this codebase.
  - Ad tokens are encrypted, PKCE is used for Google, and the minimum scopes are requested
    (`ads_read`, `adwords`, AdSense read-only).
  - Disconnect revokes the platform grant, and purge now does too.
- **Secrets.**
  - Worker secrets only; `.env*` and `.dev.vars*` are ignored by git; nothing secret goes to the
    browser.
  - Production refuses known placeholder and test values.
  - No live secrets found in history.
  - The DB password rotation from the 2026-10-10 audit is still open (manual).
- **Sessions and cookies.** httpOnly, Secure (production) and SameSite=Lax. The Origin check is
  the CSRF guard. The session lasts 5 days. Logout retires the cookie, and a password reset revokes
  all sessions.
- **Deployment.** See the [deployment checklist](SECURITY_DEPLOYMENT_CHECKLIST.md). It covers:
  - the database host;
  - the superuser runtime role;
  - Hyperdrive caching;
  - the Workers plan.

## Performance

No benchmark was run. Per-request cost of the new controls:

| Control | Cost |
| --- | --- |
| HTTPS check, headers | A URL parse |
| Webhook checks | In-memory |
| Member changes | One advisory lock each |
| Staff analytics/reports, invitations, store connect, WhatsApp estimate | One Durable Object call (the rate limit) each |
| OAuth callbacks | Two primary-key reads |
| Ad sync tick | One store query |
| Purge | One revoke call per ad connection, after the purge commits |
| "Email me a code" (only when Turnstile is on) | One Siteverify call: 4.9 s total locally over this PC's network; normally well under a second |
| Pixel dedupe prune | Every 15 min, bounded to 20k rows per tick, indexed on `seen_at` |

The supervisor fix changes `{...scope, ...filters}` to `AND: [scope, filters]`, which uses the
same indexes. Nothing caches responses across tenants: API responses are `no-store`, and the ad
report cache is keyed by connection id.
