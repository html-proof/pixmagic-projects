# Security test results, 2026-10-14

> Historical record (2026-10-14): written when bizinsights ran on Cloudflare Workers. It now runs on
> AWS: see [aws-architecture.md](../aws-architecture.md).

> **Ported 2026-10-16.** Written on the Firebase tree; the fixes reached `main` (and AWS) in
> branch `claude/security-hardening-aws`, ported onto the Cognito/AWS tree. Differences: the optional
> Turnstile check on "Email me a code" was left out (it needs redoing for Cognito's
> `/auth/otp/start` with the site key served by `/auth/config`); the migration is now
> `20261016100000_security_hardening`; Firebase token checks are now Cognito's
> (`apps/api/test/cognito.test.ts`). Deployment: [checklist](SECURITY_DEPLOYMENT_CHECKLIST.md).

Every result below comes from a run in this session on branch
`claude/production-security-implementation-74a7a0` (Windows 11, Node 24.19, pnpm 9.15). The test
database was a throwaway Postgres 17 container on `127.0.0.1:5449` (`TEST_DB=secimpl_test`). Nothing
ran against production; production was only read with GET requests (headers, http behaviour).

## Suites

| Command | Result |
| --- | --- |
| `pnpm typecheck` (all packages, incl. web and the Worker) | Pass (exit 0) |
| `pnpm test`: `@app/shared` | 144 passed (7 files) |
| `pnpm test`: `@app/core` | 114 passed (12 files) |
| `pnpm test:integration`: `@app/api` (real Postgres, faked Firebase/Shopify/Meta) | 292 passed (19 files) |
| `pnpm test:integration`: `@app/worker` | 136 passed (7 files) |
| `prisma migrate diff --from-config-datasource --to-schema` (migrations == schema) | No difference detected |
| `pnpm audit --audit-level high` | No known vulnerabilities found |
| `pnpm --filter @app/web build` (static export, with a Turnstile test site key) | Built; `_headers` in the output |

Baseline before any change in this session: shared 144, core 113, api 261, worker 130, all passing.

New tests:
- `apps/api/test/hardening.test.ts`: 31 tests;
- `apps/worker/test/hardening.test.ts`: 3 tests;
- `apps/worker/test/whatsapp.test.ts`: 3 new tests, 1 updated;
- `packages/core/test/staffFiles.test.ts`: 1 new, 1 updated;
- `packages/core/test/security.test.ts`: Turnstile guard assertions;
- `apps/api/test/multiapp.test.ts`: 1 updated.

Two tests were updated because they encoded the old, unsafe behaviour:
- a "resume" preference with no number used to create an opted-in contact;
- an `app/uninstalled` body without its shop used to be accepted.

## The brief's 19 scenarios

| # | Scenario | Expected | Test (file › name) | Result |
| --- | --- | --- | --- | --- |
| 1 | Unauthenticated request to a protected API | Denied | hardening › "refuses protected routes without a session…" (4 routes → 401) | Pass |
| 2 | Merchant A requests Merchant B's data | Denied | hardening › "a merchant can't read or change another merchant's workspace…" (5 requests → 404) | Pass |
| 3 | Regular user calls admin endpoints | Denied | hardening › same test as 1 (audit log, API keys, invitations, staff → 403) | Pass |
| 4 | Invalid token | Rejected | hardening › forged cookie → 401; "rejects … an unsigned token" | Pass |
| 5 | Expired token | Rejected | hardening › "rejects an expired, a wrong-project and an unsigned token" | Pass |
| 6 | Malicious SQL input | No injection | hardening › "SQL-looking input is data…" (3 payloads, row count unchanged) | Pass |
| 7 | Malicious HTML/JS | Safe handling | hardening › "HTML and script are stored as text…" (JSON, nosniff, `default-src 'none'`); staffFiles CSV quoting | Pass |
| 8 | Invalid webhook signature | Rejected | hardening › "rejects a bad signature…"; destructive topic without shop → 401; custom app for another shop → 401 | Pass |
| 9 | Duplicate webhook | One business action | hardening › same test (second delivery `duplicate: true`, queued once); worker suite (redelivery) | Pass |
| 10 | Unauthorized file download | Denied | hardening › "a download link works only for the person it was made for…" (no session 401, other member 404, single use) | Pass |
| 11 | Malicious upload | Rejected | No upload endpoint exists; hardening › "refuses oversized and malformed bodies" (413, 400) | Pass (N/A) |
| 12 | Rate limit exceeded | 429 | hardening › "answers 429 with Retry-After" (per-key and global) | Pass |
| 13 | Unauthorized cross-origin request | CORS enforced | hardening › "never lets another origin read the API or write with the visitor's cookie" | Pass |
| 14 | Production debug mode | Off | hardening › "an unexpected failure answers a generic 500 without the internals"; core › "refuses development settings in production" | Pass |
| 15 | Missing authorization | Rejected | hardening › scenario 1 test | Pass |
| 16 | Manipulated merchant id | No cross-tenant access | hardening › scenario 2 test (workspace and store ids swapped) | Pass |
| 17 | Invalid OAuth state | Rejected | hardening › "a Shopify or ad-platform callback with a state this browser didn't start is refused"; shopify.test, ads.test | Pass |
| 18 | Security headers | Present | hardening › "API responses carry HSTS over https", "plain http is redirected…"; security.test headers; served headers checked on a local Worker | Pass |
| 19 | Public storage access | Private | No bucket exists; export links need the session of the user they were made for (scenario 10) | Pass (N/A) |

## Regression tests for this audit's fixes

All pass. Each name is in `apps/api/test/hardening.test.ts` unless another file is given:

- **Supervisor scope** (#1): "a supervisor sees only their own team, whatever manager filter they pass".
- **HR pay fields** (#2): "an HR manager edits people but not what they're paid".
- **Separation of duties** (#3): "nobody but the owner sets their own pay or approves their own hours".
- **API keys and invitations** (#5): "removing or demoting an admin retires the API keys they made"
  and "an invitation can be cancelled…".
- **WhatsApp** (#6, #7, START/STOP), in `apps/worker/test/whatsapp.test.ts`:
  - "a manual connection's own secret vouches for that connection only…";
  - "a marketing preference reaches only the store whose number it names…";
  - "a START older than the customer's STOP…".
- **Pixel** (#9): "in production takes only events a real storefront could be sending now",
  "refuses over-long page paths", and `apps/worker/test/hardening.test.ts` › "pixel dedupe pruning".
- **HTTPS** (#10): "plain http is redirected (GET) or refused…".
- **Shopify OAuth re-check** (#14): "re-checks that the person may still connect stores…".
- **Ad tokens** (#17), in `apps/worker/test/hardening.test.ts`: "stop syncing while the store is
  uninstalled…" and "have their Google grant revoked when the store's data is purged…".
- **Email change** (#20): "correcting an employee's email withdraws the invitation…".
- **Audit log and triggers** (#25, #26): "the audit trail can't be edited…" and "a paid shift's
  breaks and a finalized payroll's items can't be deleted".
- **Turnstile**: 4 tests, covering missing, wrong action, wrong host, replayed/failed, Siteverify
  down (503 + Retry-After), not spending the address's budget, and off without a secret.
- **Config guard**: `packages/core/test/security.test.ts` refuses Turnstile test secrets and local
  hostnames in production.

## Do the tests catch the bugs? (mutation check)

The supervisor-scope fix and the own-record guard were temporarily reverted, and the matching
tests run again:

```
× a supervisor sees only their own team, whatever manager filter they pass
× nobody but the owner sets their own pay or approves their own hours
Tests  2 failed | 27 skipped (29)
```

Both fixes were then restored, verified with `grep`, and the whole suite passed again (above).

## Browser verification (local Worker, Cloudflare's test keys)

Setup:
- `wrangler dev` on `localhost:8797`;
- the database `secimpl_preview` on the throwaway server;
- a local mail sink;
- the UI built with Cloudflare's always-pass site key `1x00000000000000000000AA`;
- `TURNSTILE_SECRET` set to the always-pass test secret.

Steps and results:
1. /login → "Email me a code": the Turnstile widget rendered and issued its token, which enabled
   the button.
2. Submitting `jane@example.com`: the API called the real Siteverify endpoint and answered
   `200 {"ok":true,"method":"code"}` (4.9 s). The page showed the "code is on its way" step, and
   the mail sink received "Your sign-in code: …".
3. The same request without a token, sent with curl: `403 {"error":"captcha_required"}`.
4. Served headers:
   - pages had the enforced CSP, CSP-Report-Only, COOP, HSTS, the new Permissions-Policy and
     `X-Frame-Options: DENY`;
   - the API had `default-src 'none'`, `no-store`, `x-request-id`.
5. Console on /, /signup and /login: no CSP Report-Only violations (only pre-existing
   preload-timing warnings).

Not verified in a browser:
- A real Turnstile site key, and replay rejection with it. Test keys always pass; replay
  rejection is covered by the unit test with a faked `timeout-or-duplicate`.
- Google, Apple and Meta popups under the Report-Only CSP. They need production Firebase and Meta.
- The members "Cancel" button and the disabled HR pay fields. They need a signed-in session; the
  API behind them is tested.

## Live production checks (read-only)

| Check | Result |
| --- | --- |
| `GET http://…/login` (the old Cloudflare Worker, production then) | `200 OK` over plain HTTP (finding #10, fixed in code, not deployed) |
| `GET http://…/api/healthz` | `200 OK` over plain HTTP |
| `GET https://…/login` headers | HSTS, CSP (frame-ancestors etc.), nosniff, DENY: as configured before this audit |
| `GET https://…/api/healthz` headers | `no-store`, `default-src 'none'`, DENY, nosniff; no HSTS (added in code) |

## Other scans

- **`pnpm audit`**: no known vulnerabilities (before and after).
- **Git history secret scan** (all branches, `git log --all -p`): patterns for Shopify tokens,
  `sk_live_`, Google client secrets, Meta tokens, private keys, AWS/Slack/GitHub tokens and
  credentialed database URLs.
  - No live credentials.
  - The only hits are test fixtures in `packages/core/test/security.test.ts`, which are "strong
    secret" examples used to test the production guard.
- **Not run:** Semgrep, gitleaks, OWASP ZAP (not installed), and the Playwright e2e suite (needs
  the Docker Auth emulator and Mailpit stack).

## Performance

No load or latency benchmark was run. The per-request cost of each control is listed in
[SECURITY_IMPLEMENTATION.md](SECURITY_IMPLEMENTATION.md#performance).
