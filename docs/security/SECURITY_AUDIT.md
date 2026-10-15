# Security audit, 2026-10-14

> **Ported 2026-10-16.** Written on the Firebase tree; the fixes reached `main` (and AWS) in
> branch `claude/security-hardening-aws`, ported onto the Cognito/AWS tree. Differences: the optional
> Turnstile check on "Email me a code" was left out (it needs redoing for Cognito's
> `/auth/otp/start` with the site key served by `/auth/config`); the migration is now
> `20261016100000_security_hardening`; Firebase token checks are now Cognito's
> (`apps/api/test/cognito.test.ts`). Deployment: [checklist](SECURITY_DEPLOYMENT_CHECKLIST.md).

Branch `claude/production-security-implementation-74a7a0`, based on GitHub `main` `1935427`. Nothing
here is deployed. Companion documents: [implementation](SECURITY_IMPLEMENTATION.md),
[test results](SECURITY_TEST_RESULTS.md), [deployment checklist](SECURITY_DEPLOYMENT_CHECKLIST.md).
The running security model is [docs/security.md](../security.md); the previous audit is
[2026-10-10](../security-audit-2026-10-10.md).

This audit makes no claim that the application is secure. It is a code review plus targeted
fixes and tests; an independent penetration test is still advisable before onboarding paying
merchants.

## Scope and method

**Stack, as found in the repository** (not assumed):

| Layer | Technology |
| --- | --- |
| Hosting | One Cloudflare Worker (`apps/cloudflare`) on `insights.imeseban.workers.dev`: static UI from Workers Static Assets, API, Queue consumers, Cron |
| Frontend | Next.js 16 App Router, static export, React 19 (`apps/web`) |
| Backend | Hono (`apps/api`), queue/cron handlers (`apps/worker`), shared logic (`packages/core`, `packages/shared`) |
| Database | PostgreSQL 17 via Prisma 7 and Hyperdrive; two roles: `app` (owner, bypasses RLS) and `app_rls` (row-level security). The production database is a Docker container on the owner's PC, reached through Workers VPC + Cloudflare Tunnel |
| Auth | Firebase Auth (Google, Apple, password, email code/link); httpOnly session cookie; workspace roles owner/admin/analyst/viewer, staff roles hr/payroll/supervisor; read-only API keys |
| State | A Durable Object (rate limits, one-time OAuth state, leases) |
| Integrations | Shopify (OAuth, Admin GraphQL, webhooks, Billing API, web pixel), Meta Ads, Google Ads, Google AdSense, WhatsApp Business Cloud API |
| Not present | TikTok, file uploads, storage buckets (R2 is commented out; large webhook bodies use the Durable Object), Supabase, Redis, an admin panel separate from workspace roles, Shopify embedded app (`embedded = false`) |

**Method.**

1. Repository inspection: every route, middleware, migration, config file and the CI workflow.
2. Four independent read-only code reviews in parallel, each traced end to end:
   - Staff Management (new today);
   - Ads and Shopify OAuth;
   - WhatsApp;
   - tenancy, RLS and the core routes (with a route classification).
3. Manual review of headers, CORS, HTTPS, error handling, configuration and deployment.
4. Live, read-only checks of production's response headers and HTTP behaviour (GET requests only).
5. `pnpm audit`, and a regex secret scan over the full git history (all branches).
6. Not run, because the tools aren't installed and I didn't install new tooling without asking:
   Semgrep, gitleaks/trufflehog, OWASP ZAP.

## Route classification (summary)

| Class | Routes | Guard |
| --- | --- | --- |
| PUBLIC | `/healthz`, `/readyz`, `/auth/session`, `/auth/otp/*`, `/auth/email-link/verify`, `/auth/logout`, `/auth/whoami`, `/staff/invitations/lookup`, `/staff/invitations/accept`, `/public/track/:token`, `/public/review/:token`, `/r/:code`, `/shopify/launch`, `/shopify/callback`, `/ads/:provider/callback` | Origin check on sign-in writes, per-IP limits, high-entropy tokens looked up by hash, HMAC/state on OAuth returns, optional Turnstile on code requests |
| AUTHENTICATED | `/me`, `/workspaces` (create), `/invitations/accept`, everything under `/workspaces/:ws/*` | `requireUser` / `requireWorkspace(ws, permission)`; non-members get 404 |
| ADMIN (owner/admin) | members, invitations, API keys, audit log, store connect/disconnect, ads connect, WhatsApp, Staff settings | `requireWorkspace(…, "members:manage" / "stores:manage" / …)`, `requireStaff(…, permission)` |
| OWNER | billing subscribe, ownership changes | `billing:manage`, explicit owner checks |
| EMPLOYEE | `/employee/:ws/*` | `requireEmployee` (own record only) |
| WEBHOOK | `/webhooks/shopify`, `/webhooks/whatsapp` (+ GET handshake), `/pixel/:key` | HMAC of the raw body (Shopify, Meta); public ingest key + per-IP limit (pixel) |
| INTERNAL | queue consumers, cron | not reachable over HTTP |

## Findings

Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO.
Status: **Fixed** means the code changed and a test covers it. Every fix is on this branch and not deployed.

| # | Sev | Vulnerability | Where | Exploitation conditions | Impact | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | HIGH | Supervisor scope bypass | `packages/core/src/staff/employees.ts` `listEmployees`, `analytics.ts` `liveBoard` | A member with staff role *supervisor* adds `?managerUserId=<another manager>` (ids are listed in `/staff/config`) | Reads every employee's name, email, phone, HR notes and live attendance, not just their own team | Scope ANDed with the filters | Fixed, tested |
| 2 | MED | HR managers could change pay | `employees.ts` `createEmployee`/`updateEmployee` | *hr_manager* sets overtime/break policy or currency | Raises gross pay without `pay:manage` | `assertPayFieldsAllowed`; UI disables the fields | Fixed, tested |
| 3 | MED | No separation of duties | `attendance.ts`, `employees.ts`, `payroll.ts` | A payroll/HR manager or supervisor who is also an employee | Approves/edits own shifts, sets own pay rate and adjustments, approves the payroll they submitted | `assertNotOwnRecord` (owner exempt); submitter can't approve; employee can't be own manager | Fixed, tested |
| 4 | MED | Unbounded staff analytics | `routes/staffReports.ts` | Any staff viewer loops `GET …/analytics` with a 3-year custom range | CPU/memory on the Worker; load on the shared Postgres | Per-user limit `staffAnalytics` (180 / 10 min) | Fixed (window size unchanged: residual) |
| 5 | MED | Removed admin kept access | `routes/workspaces.ts`, `context.ts` | Admin creates an API key (or invites an alt address) before being removed | Keys never expire: continued read access to revenue, orders, ads, members | Keys revoked on removal or demotion below `apikeys:manage`; `DELETE /workspaces/:ws/invitations/:id` + Cancel button; key list shows creator | Fixed, tested |
| 6 | MED | WhatsApp: manual secret trusted account-wide | `routes/whatsappPublic.ts`, `core/whatsapp/webhook.ts` | Two stores (two workspaces) share one WhatsApp Business Account; one has a manual connection with its own app secret | Forged START/STOP, template statuses, "account disabled" for the other store's number | Trust per connection id | Fixed, tested |
| 7 | MED | WhatsApp: preferences crossed stores | `webhook.ts` `applyPreference` | Customer resumes marketing on store A's number when B shares the account | Becomes an opted-in contact of B (consent violation) | Only the named number's store; "resume" never creates | Fixed, tested |
| 8 | MED | WhatsApp: disconnect cut off others | `core/whatsapp/connect.ts` | Disconnecting one store on a shared account | Other stores silently stop receiving STOPs and statuses | Unsubscribe only when no other connection remains | Fixed |
| 9 | MED | Pixel: unlimited backdated writes | `routes/pixel.ts` | Anyone with a store's public ingest key | Fills the production disk; slows one tenant's dashboard | 48 h window (production), path ≤ 512, dedupe ids pruned every 15 min (+ index) | Fixed, tested (per-store quota: residual) |
| 10 | MED | Production served plain HTTP | Worker entry | A visitor following an `http://` link (workers.dev has no "Always Use HTTPS") | Pages and the sign-in POST (ID token) unencrypted; verified live: `http://…/login` and `/api/healthz` answer 200 | `requireHttps`: redirect GET, refuse others; HSTS on API responses | Fixed, tested |
| 11 | MED (host) | Other services on the production DB host listen on all interfaces | The owner's PC: native PostgreSQL `0.0.0.0:5432`, `shopping-cart-postgres-1` `0.0.0.0:5433`, `shopping-cart-redis-1` `0.0.0.0:6379` | Someone on the same Wi-Fi, if the Windows firewall admits them (not tested from another device) | A foothold on the machine that holds production's database | Owner: bind to 127.0.0.1 or firewall (system setting; not changed by me) | Open: manual |
| 12 | LOW | Unsigned topic header on destructive webhooks | `routes/webhooks.ts` | A captured signed body without a shop field, replayed as `shop/redact` | Purge of a victim store | Destructive topics must name the shop in the body | Fixed, tested |
| 13 | LOW | Custom app's signature accepted for any shop | `routes/webhooks.ts` | Holder of one client app's secret | Forged orders/deletions/redactions for other stores | Custom app vouches only for its `shops` | Fixed, tested |
| 14 | LOW | OAuth callbacks didn't re-check membership | `routes/shopify.ts`, `routes/ads.ts` | Member removed or demoted during the ≤10-min flow | Attaches a store or ad account anyway | Re-check `stores:manage` (and store) on return | Fixed, tested (Shopify) |
| 15 | LOW | Store enumeration via install | `routes/shopify.ts` | Any verified user | Learns which shops use bizinsights (409 `store_taken`) | Per-user limit (`shopifyInstall`) | Mitigated |
| 16 | LOW | `/shopify/launch` replayable | `routes/shopify.ts` | An old signed launch link | Starts an authorize Shopify still gates | Same 10-min freshness as the callback | Fixed |
| 17 | LOW | Ad tokens outlived uninstall | `apps/worker/src/handlers.ts`, `core/persist.ts` | Store uninstalls | Ad data kept being pulled; grants stayed live at Google/Meta after purge | Syncs pause while uninstalled; grant revoked on purge unless another store relies on it | Fixed, tested |
| 18 | LOW | Meta `paging.next` followed to any host | `core/ads.ts` `metaGet` | Only if Meta's response were compromised | Access token sent elsewhere | Host pinned to graph.facebook.com | Fixed |
| 19 | LOW | `?choose=` unvalidated into an API path | `settings/ads/page.tsx` | A crafted link | Same-origin GET to another API path | Validated + encoded | Fixed |
| 20 | LOW | Email change left the old invitation valid | `employees.ts`, `invitations.ts` | Admin corrects a typo'd address without resending | Old inbox claims the employee record | Old invitations revoked; mismatched address refused | Fixed, tested |
| 21 | LOW | CSV formula injection via `;` | `core/staff/files.ts` | Excel in a `;`-separator locale | Live formula in an exported report | Every text cell quoted | Fixed, tested |
| 22 | LOW | Audit gaps | staff admin/pay functions, portal | — | Pay-rate deletions unrecoverable; policy/holiday/department changes untraceable | Audits added, with before/after values | Fixed |
| 23 | LOW | Invitation spam across workspaces | `routes/workspaces.ts`, `routes/staff.ts` | One user with many workspaces | Branded spam from our domain | Per-sender daily cap (`invitationsPerUser`) | Fixed |
| 24 | LOW | Last-owner race | `routes/workspaces.ts` | Two owners demote each other at once | Ownerless workspace | Advisory lock | Fixed |
| 25 | LOW | Tenant role could rewrite audit log / users | `infra/postgres/init.sql` | Needs a separate injection or logic bug | Audit trail tampering | Migration: append-only audit log (trigger + revoke), no tenant writes to `users` | Fixed, tested |
| 26 | LOW | Staff freeze-trigger gaps | migration `*_staff_management` | Race between a correction and payroll approval | Paid shift's breaks deleted | DELETE triggers + unlock-and-change refused | Fixed, tested |
| 27 | LOW | WhatsApp: late START undid STOP; tests ignored STOP; reviews before delivery; unsigned bodies parsed before limit | `webhook.ts`, `routes/whatsapp*.ts` | Redeliveries; staff; anyone | Consent and integrity issues | Each fixed | Fixed, tested (START/STOP) |
| 28 | LOW | `x-real-ip` trusted | `context.ts` `clientIp` | Not exploitable on Workers (Cloudflare sets `cf-connecting-ip`) | Per-IP limit evasion off-platform | Only outside production | Fixed |
| 29 | INFO | No `Retry-After` on 429 | `rateLimit.ts`, `app.ts` | — | Clients can't back off correctly | Added | Fixed, tested |
| 30 | INFO | UI CSP doesn't restrict scripts | `public/_headers` | Requires an XSS sink (none found) | Defence in depth | Full allowlist CSP shipped as Report-Only; COOP; wider Permissions-Policy | Partial |
| 31 | INFO | No CAPTCHA on public forms | `/auth/otp/request` | Bots requesting codes (rate limited already) | Email abuse | Turnstile, on when `TURNSTILE_SECRET` is set | Implemented, off until configured |
| 32 | INFO | Test fixtures look like real secrets | `packages/core/test/security.test.ts` | — | None (test-only values) | — | No change |

### Checked and found sound (with evidence)

- **SQL injection.** Every raw query is a Prisma tagged template or `Prisma.join`. The only
  `$executeRawUnsafe` is test-only and uses catalog names. No sort column or filter operator
  comes from input.
- **Tenant isolation.** RLS is enabled on all 58 tables, with policies on `app.workspace_id`
  (`users` via membership). `withTenant` uses `set_config(…, true)` inside a transaction, so it
  can't leak through Hyperdrive's pool. Every route checks membership, and object lookups filter
  by workspace. I found no cross-tenant IDOR in the Staff, Ads or WhatsApp code.
- **Auth.** Firebase tokens are verified with RS256 pinned, issuer, audience, expiry and
  revocation. Sessions are httpOnly, Secure and SameSite=Lax, minted only from sign-ins less than
  5 minutes old. Logout retires the cookie. Emulator mode fails closed outside localhost.
- **CSRF and CORS.** An Origin/Referer check runs on every cookie-authenticated write and on
  sign-in. The only CORS answer is the pixel's (`*`, no credentials).
- **OAuth.** Shopify checks the query HMAC (timing-safe), the shop regex, the timestamp, and a
  single-use state that is cookie- and user-bound. Ads uses PKCE (Google), a single-use state
  bound to user, workspace and store, and account ids restricted to what the platform listed.
- **Tokens at rest.** AES-256-GCM with per-store AAD and versioned keys. No token is ever returned
  by the API, and logs redact them.
- **Billing.** The plan changes only on an HMAC-verified webhook whose charge id matches.
  `charge_id` and `returnUrl` are never trusted.
- **XSS.** No `dangerouslySetInnerHTML`, `innerHTML` or `eval` anywhere in the UI. React escapes
  output. API responses are JSON with `nosniff` and CSP `default-src 'none'`.
- **Dependencies.** `pnpm audit`: no known vulnerabilities.
- **Secrets in git.** History contains only the published test/e2e values and public ids.
- **Debug output.** Unhandled errors answer a generic 500, with stacks in logs only. No source
  maps are shipped. Production refuses placeholder secrets and development settings at startup.

## Not verified

- **CSP enforcement.** The Report-Only policy was checked locally (no violations on the
  landing, sign-up and login pages, Turnstile included). It was not checked with real Google,
  Apple or Meta popups, which need production Firebase and Meta.
- **Turnstile with a real widget.** Only Cloudflare's test keys were exercised (end to end in a
  local Worker). With test keys, replay rejection can only be simulated.
- **LAN reachability of the host services in #11.** Not tested from another device.
- **End-to-end Playwright suite and OWASP ZAP.** Neither was run.
