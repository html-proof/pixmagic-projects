# bizinsights security audit, 2026-10-23

Read-only audit of `main` at `c0f1613` (the API, worker and infrastructure code are identical to
production's build `a4360f4`, release 97: the 21 files that differ are all in `apps/web`). Nothing in
production was changed, no credential was revoked, no account was created on bizinsights.io, and no
secret value appears in this report (only the first characters and lengths). Earlier audits:
[2026-10-10](../security-audit-2026-10-10.md), [2026-10-14](SECURITY_AUDIT.md).

How it was done:

- Every route file in `apps/api/src/routes` (37), the session and identity code, the OAuth flows,
  webhooks, `packages/core`, `packages/db` (RLS), `infra/cdk`, the workflows and the runner scripts
  were read, split into five areas (auth, tenant isolation, module routes, OAuth/webhooks,
  infrastructure/CI). Each finding below was traced in the code; the MEDIUM and HIGH ones were
  re-read a second time before being listed.
- A secret scan of the working tree, all 808 commits on every branch, and the 61 JavaScript chunks
  and 11 pages the live site serves.
- `pnpm audit`, the GitHub repository settings (read through the API), a handful of GET requests
  and TLS handshakes against bizinsights.io, and the API's integration test suite run against a
  throwaway local Postgres with dummy workspaces.

## Status of the findings (fix branch `claude/bizinsights-security-audit-a81241`)

| Finding | Status | What changed |
| --- | --- | --- |
| H1 | Code fixed; owner step open | Deploy split into `build` (no `id-token`) and `deploy` (token; installs only infra/cdk's tools with `--ignore-scripts`; package passed through the Actions cache). Install scripts allowed only for esbuild, prisma, @prisma/engines (`pnpm.onlyBuiltDependencies`). Still needed: the main-only runner (`install-runner.ps1 -Main`, `SELF_HOSTED_MAIN_RUNNER`), without which both jobs share the pull-request runner's cached tools |
| M1 | Fixed | A link no longer joins an address that has an account (409 `sign_in_required`, the page signs in and accepts); onboarding connects only into a workspace the person owns unless `?ws=` names one |
| M2 | Fixed | Losing `members:manage` cancels the person's pending invitations and re-tokens every link they sent, copied, resent or replaced; removal also ends their own invitation |
| M3 | Fixed, one narrower case left | Callback matches the platform and uses up one session per consent; `/nango/finish` needs that browser's consent receipt. Left: an attacker who also completes their own consent in the same session holds a genuine receipt, and could finish a victim's connection made under that session if the victim, with an open session of their own for that platform, approves on the attacker's link within 30 minutes (docs/nango.md) |
| M4 | Fixed | Notices on email change (old address), password change and reset, two-step on/off; email change ends every other session |
| M5 | Fixed | Changing the email of an employee with pay records needs `pay:view`; nobody without it links their account through an invitation they made |
| M6 | Partly fixed | Production fails tenant queries without `APP_DATABASE_URL`; `/readyz` fails if the tenant role is a superuser or bypasses RLS. Open: a non-superuser runtime owner role |
| M7 | Fixed (inline scripts still allowed) | The allowlist CSP is enforced. Open: script hashes instead of `'unsafe-inline'`, a reporting endpoint |
| M8 | Owner step | Rotate/revoke and delete the local credentials |
| L1, L3 | Fixed | Reset finds the account by Cognito sub and answers 503 if sessions couldn't end; 5 reset attempts an hour per address |
| L6, L8 | Fixed | Shopify-check limit keyed by workspace and store; WhatsApp opt-out needs `stores:manage` (UI form hidden for others) |
| L15, L16, L17, L20 | Fixed | Origin check refuses in production without its secret; WAF matches decoded, normalized paths; more log keys and patterns scrubbed; Vitest 4.1.12 (`pnpm audit`: no known vulnerabilities) |
| INFO: AES-GCM tag | Fixed | `decrypt` accepts only a full 16-byte tag |
| Others | Open | L2, L4, L5, L7, L9–L14, L18, L19, L21 and the INFO items |

## A. Executive summary

No CRITICAL problem was found. There is no sign of a leaked secret in the repository, its history,
or what the website sends to browsers; customer OAuth tokens are encrypted and never reach the
browser; and no route was found that lets one customer read or change another customer's data
directly. That does not make the application secure: several checks could not be run (the live AWS
account, Cloudflare's settings), and the findings below are real.

The most serious confirmed problems:

1. **HIGH: the path from a poisoned dependency to full control of the AWS account is short.**
   Deploys run on the same PC runner as pull-request jobs, and the deploy job installs npm packages
   (running their install scripts) while it can obtain the deploy role, which reaches administrator
   rights through the CDK roles. One compromised package or GitHub Action would be enough.
2. **MEDIUM: invitation links act for the invitee without them.** An owner or admin can open the
   invitation they sent to anyone's address and make that person's account a member of their
   workspace; and an admin who is removed keeps working invitation links.
3. **MEDIUM: the Nango ad-account connection can be attached to the wrong store** when a signed-in
   merchant who just pressed Connect approves on a link an attacker sends (needs that victim to act).
4. **MEDIUM: changing the account's email sends nothing to the old address and keeps other
   sessions**, so someone with a session and the password can take the account over quietly.
5. **MEDIUM: the database is used through its master (superuser) login**, and the tenant connection
   silently falls back to it, losing row-level security, if one secret is missing.
6. **MEDIUM: the page CSP doesn't restrict scripts** (the full policy is report-only).

## B. Security assessment

| Security category | Status | Severity | Evidence | Recommended action |
| --- | --- | --- | --- | --- |
| API key security | WARNING | MEDIUM | No secret in tree, 808 commits, or live bundles; Secrets Manager only (`apps/aws/src/secrets.ts`). Old plaintext production credentials in gitignored files on the PC (M8). No automated secret scanning (GitHub's is unavailable on this plan) | Delete/rotate the local credentials; add Gitleaks in CI and pre-commit |
| OAuth security | WARNING | MEDIUM | State, PKCE, single use, server-side exchange, encrypted tokens PASS for Shopify, Google Ads, AdSense, Meta, Gmail/Microsoft. Nango callback can't bind consent to its session (M3) | Single-use, platform-matched callback forward + consent receipt for `/nango/finish` |
| Authentication | WARNING | MEDIUM | Cognito BFF, HMAC session cookie, revocation every request, MFA, rate limits PASS. No notice on email/password change (M4); reset ends sessions best-effort (L1) | Notices + session cut-off on email change; fail closed on reset |
| Authorization | FAIL | MEDIUM | Invitation link accepts for any account (M1); removed admin keeps links (M2); HR manager can read pay (M5); read-only sessions can write in a few places (L7, L8) | Fix M1, M2, M5; refuse writes from link sessions and API keys |
| Multi-tenant isolation | WARNING | MEDIUM | Every `:ws`/`:storeId`/`:id` in 37 route files traced to a workspace-scoped query; RLS on all tenant tables, `app_rls` without BYPASSRLS. One cross-tenant path needs the victim's action (M3); a rate-limit key lets one tenant lock another out of a check (L6) | Fix M3, L6; add read-side IDOR tests |
| Backend APIs | WARNING | LOW | Zod on all input, 1 MB/5 MB body limits, generic 500s, Origin check on cookie writes, no CORS except the pixel. Open redirect via campaign links (L12); pixel accepts forged events (L14) | L12 interstitial; pixel per-key limits |
| Frontend security | WARNING | MEDIUM | No secrets, tokens or source maps in the 61 live chunks; only UI state in browser storage. Enforced CSP has no `script-src` (M7); staff invite token in URL and localStorage (L5) | Enforce the allowlist CSP; move the token to the URL hash |
| Database security | WARNING | MEDIUM | Isolated subnets, not public, `rds.force_ssl`, `verify-full`, encrypted, Multi-AZ, 14-day backups, deletion protection (code). Runtime uses the master user and falls back to it (M6). Live state NOT TESTED | Non-superuser runtime role; fail closed without `APP_DATABASE_URL` |
| Third-party integrations | WARNING | MEDIUM | Shopify/Meta/WhatsApp/Nango/Resend webhooks signed and checked on the raw body; GDPR topics handled. M3; reinstall race gives a store back to its old workspace (L13) | Fix M3, L13 |
| Infrastructure | FAIL | HIGH | CI → AWS admin path (H1). OIDC trust pinned to repo, environment, `aws-deploy.yml@refs/heads/main`. HTTPS redirect, HSTS 1 year, TLS 1.0/1.1 refused (live). Origin check fails open if unset (L15); IAM over-broad grants (L19). Live AWS NOT TESTED (CLI session expired) | Main-only runner; split build and deploy; then the LOW items |
| Dependencies | PASS | LOW | `pnpm audit`: 0 critical/high, 2 moderate in dev-only Vitest (L20). Every action pinned by SHA. Install scripts run on pnpm 9 (part of H1) | Vitest 4.1.12; add npm to Dependabot |
| Logging and monitoring | WARNING | LOW | Key-based redaction at any depth, auth events, append-only audit log. Free-text scrub misses JWTs, Google tokens, query secrets (L17); no WAF/CloudFront/flow logs, CloudTrail not alarmed (L18) | Extend scrubbers; WAF logs; CloudTrail alarms |

## C. Vulnerability details

Status words: **CONFIRMED** = traced end to end in code or seen in configuration/live responses;
**SUSPECTED** = needs a runtime check that wasn't done. "Blocks release" answers whether it should
be fixed before real merchants connect accounts.

### HIGH

#### H1. A compromised dependency or Action could take over the AWS account through the deploy

- **Status:** CONFIRMED (configuration and GitHub settings). Exploiting it needs an upstream
  compromise (an npm package or a GitHub Action release), which has happened repeatedly in 2025.
- **Component:** `.github/workflows/aws-deploy.yml`, `ci.yml`, `infra/runner/setup-pnpm.mjs`,
  `infra/cdk/lib/ci-stack.ts`, the PC runner.
- **Evidence:**
  - `aws-deploy.yml:43` runs on `vars.SELF_HOSTED_MAIN_RUNNER || vars.SELF_HOSTED_RUNNER`. The
    repository has only `SELF_HOSTED_RUNNER` set and one runner, `bizinsights-pc` (GitHub API), so
    deploys run where pull-request jobs run (`ci.yml:17,62,98,321`), and only print a warning
    (`aws-deploy.yml:55-57`).
  - The pnpm store and cached `pnpm`/`node` live in the runner's tool cache and are reused without a
    hash check (`setup-pnpm.mjs:13-18`, `ci.yml:124`).
  - `aws-deploy.yml:19-21` gives the whole workflow `id-token: write`; `pnpm install` (line 83) and
    the unit tests run in the same job before `configure-aws-credentials` (line 96). pnpm 9.15 runs
    every dependency's install script (no `onlyBuiltDependencies`, no `.npmrc`).
  - The deploy role may assume `cdk-hnb659fds-*` (`ci-stack.ts:45`), and the CloudFormation
    execution role has AdministratorAccess (`docs/aws-deployment.md:331`).
- **Impact:** code from a malicious package (or a poisoned cache left by a pull-request job) can
  request the job's OIDC token, become the deploy role, and through CDK's roles read every secret
  (session key, `TOKEN_ENCRYPTION_KEYS`, client secrets) and the database: every customer's data and
  every connected Shopify/Meta/Google account.
- **Remediation:**
  1. Owner: run `infra/runner/install-runner.ps1 -Main` (and `harden-runner.ps1`), then set
     `SELF_HOSTED_MAIN_RUNNER` (docs/aws-deployment.md).
  2. Code: turn the warning into a failure when the main runner isn't set (after step 1); split
     the workflow into a build job without `id-token` that produces the function bundle and
     `cdk.out`, and a deploy job with `id-token` that only runs `cdk deploy --app cdk.out`; install
     with `--ignore-scripts` plus an explicit allowlist (`onlyBuiltDependencies`: esbuild, prisma,
     sharp) or move to pnpm 10.
  3. Later: bootstrap CDK with a scoped `--cloudformation-execution-policies` instead of admin.
- **Verify safely:** the next Deploy log says it ran on `bizinsights-pc-main`; a test commit adding
  a dependency whose install script prints `ACTIONS_ID_TOKEN_REQUEST_URL` shows it unset in the
  install step.
- **Complexity:** owner step 15 minutes; workflow split moderate (half a day with testing).
- **Blocks release:** yes, the runner step (cheap). The workflow split can follow.

### MEDIUM

#### M1. Opening a team invitation link accepts it for the address's account, without that person

- **Status:** CONFIRMED (code).
- **Component:** `apps/api/src/routes/team.ts:369-401, 417-427`, `packages/core/src/team/invitations.ts`.
- **Evidence:** `POST /invitations/open` needs no session. It finds the account for the invited
  address, or creates one (`userForInvitee`), and calls `acceptTeamInvitation(..., { viaLink: true })`,
  which creates the membership with the invitation's role. The only refusal is an *unverified*
  account that has a sign-in method (`team.ts:384`). Owners and admins can always fetch the link
  (`POST .../invitations/:id/link`, `team.ts:318`), and it is returned to them whenever the email
  isn't sent.
- **Impact:** the owner of workspace A invites `victim@corp.com` as admin, copies the link and
  opens it themselves: the victim's existing (verified) account is now an admin of A without having
  done anything, and the inviter holds a read-only session that `/me` answers with the victim's
  name and time zone. For an address with no account yet, the membership is waiting when the real
  person signs up; if A is their only workspace, the in-app "connect your store" flow picks it
  (`apps/web/src/app/onboarding/page.tsx:113-115`) and A's owner can then read that store. This
  contradicts `docs/security.md` ("no account pre-hijack through a copied invitation link").
  Shopify App Store installs aren't affected (they create their own workspace).
- **Remediation (needs a product decision):** a session-less open shows the shared view but writes
  no membership to an account that already exists; the membership is created only when the browser
  holds that account's own verified session (or the person confirms it on their next sign-in).
  For a new address, keep the link-only access but don't let it become the default workspace for
  connecting a store.
- **Verify:** integration test with workspaces A and B and user V (verified, owner of B): A's owner
  opens V's invitation with no cookie → expect no `membership(A, V)`.
- **Complexity:** moderate. **Blocks release:** before inviting at scale; low likelihood today.

#### M2. Removing or demoting an admin leaves their invitations and copied links working

- **Status:** CONFIRMED (code).
- **Component:** `packages/core/src/team/members.ts:268, 298-307, 333-349`, `invitations.ts:271-283, 485-492`.
- **Evidence:** removal, revocation and demotion call only `revokeKeysOf` (API keys). Pending
  invitations the admin created stay valid. Any owner or admin may copy an *accepted* invitation's
  link (`linkInvitation`), and it keeps reopening a read-only session as that member
  (`reopenableMember`) until the invitation ends (up to 60 days).
- **Impact:** an admin who expects to be removed copies a viewer's link and invites an alias address
  as admin. After removal: the viewer's link gives them read access (and exports, if that member
  is an owner or admin); opening the alias invitation, then signing up as the alias, makes them a
  full admin again. The pending invitation is visible in the team list, so an attentive owner may
  notice.
- **Remediation:** when someone loses `members:manage`, revoke the pending invitations they created
  and replace the token of every link they copied (`member.invitation_link_copied` is already in
  the audit log); when a member is removed, revoke the invitations they accepted.
- **Verify:** workspace A with owner O, admin M, viewer X; M copies X's link and invites `m2@` as
  admin; O removes M; both tokens must then fail to open.
- **Complexity:** low. **Blocks release:** recommended before teams use it.

#### M3. A Nango ad-account consent can be attached to another merchant's store

- **Status:** CONFIRMED in code; documented as a known gap (`docs/nango.md:82-86`). Not run against
  live Nango.
- **Component:** `apps/api/src/routes/adsNango.ts:244-254`, `packages/core/src/adConnections/nango.ts:105-117`.
- **Evidence:** the callback forwards to Nango whenever the signed-in person has *any* open Nango
  session in that browser (`states.some((s) => s.userId === user.id)`). It doesn't match the
  platform, doesn't use the session up (30 minutes, any number of consents), and can't tie Nango's
  `state` to a session.
- **Impact:** attacker A starts a Meta or AdSense connection for their own store and sends the
  platform's consent link to merchant V. If V pressed Connect in the last 30 minutes and approves
  on Google's or Meta's genuine screen, V's ad accounts or AdSense earnings are connected to A's
  store, and A reads them.
- **Remediation:** at the callback, match the platform (Google returns `scope`) and consume the
  matching session; have the forward set a short-lived httpOnly "consent receipt" bound to the
  person, and require `/ads/nango/finish` to present it (A's browser never passes the callback, so
  A's finish fails).
- **Verify:** extend `apps/api/test/adsNango.test.ts`: user B with an open session forwards a
  consent; the fake Nango returns a connection tagged for A; A's finish must be refused.
- **Complexity:** low to moderate. **Blocks release:** yes, before Meta/AdSense connections are
  offered widely.

#### M4. Email change sends no notice to the old address and keeps other sessions

- **Status:** CONFIRMED (code).
- **Component:** `apps/api/src/routes/account.ts:424-463` (also password change `:156-198`,
  MFA off `:368-399`, password reset `auth.ts:894-931`).
- **Evidence:** `/auth/account/email/confirm` writes the new address and records an auth event; no
  email is sent and `sessionsValidAfter` isn't moved. The change itself needs the current password
  (`reauthenticate`, `account.ts:84-92`). Only adding/removing a sign-in method sends a notice
  (`apps/api/src/identity.ts:81-116`).
- **Impact:** someone holding a session and the password (a phished password plus a stolen or
  unattended session) moves the account to their inbox; the owner gets no warning, their other
  devices stay signed in alongside the attacker's, and "Forgot password" then goes to the attacker
  (OWASP ASVS 5.0 notification requirements).
- **Remediation:** notify the old address on email change and the account's address on password
  change, reset and MFA off, with a "not you?" path; on email change move `sessionsValidAfter`
  and keep only the current session, as password change does.
- **Verify:** extend the email-change test in `apps/api/test/auth.test.ts`: the fake mailer gets a
  message to the old address; a second session gets 401.
- **Complexity:** low. **Blocks release:** recommended.

#### M5. An HR manager can read an unregistered employee's pay

- **Status:** CONFIRMED (code).
- **Component:** `apps/api/src/routes/staff.ts:227-231, 261-268`, `packages/core/src/staff/employees.ts:330`,
  `apps/api/src/routes/staffPortal.ts:126-145`, `packages/core/src/staff/invitations.ts:245-259`.
- **Evidence:** with `staff:manage` only, an HR manager may change the email of an employee who has
  no account yet, create a `delivery: "link"` invitation (the link comes back to them), and accept
  it with their own session (`accept-existing` checks only that the emails match). The employee
  portal then shows that employee's pay and payslips. `docs/staff.md` says HR managers don't get
  `pay:view`.
- **Impact:** an insider reads pay for every employee who hasn't signed up. It is audit-logged
  (`staff.employee_updated`, `staff.account_activated`).
- **Remediation:** require `pay:manage` (or owner/admin) to change the email of, or invite, an
  employee with pay data; refuse `linkEmployeeAccount` for a workspace member without `pay:view`.
- **Verify:** H (hr_manager) runs PATCH → invite (link) → accept-existing → `GET /employee/A/pay`:
  expect 403.
- **Complexity:** low. **Blocks release:** before Staff Management is sold.

#### M6. The functions use the database's master login, and RLS silently falls away without one secret

- **Status:** CONFIRMED (code); the live database was NOT TESTED.
- **Component:** `infra/cdk/lib/data-stack.ts:129`, `apps/aws/src/secrets.ts:61-68`,
  `packages/db/src/index.ts:77`, `packages/core/src/env.ts`.
- **Evidence:** `DATABASE_URL` is built from the RDS master secret (user `app`, a member of
  `rds_superuser`) and used by api, jobs and cron for the system paths. `APP_DATABASE_URL` (the
  `app_rls` role) is built only when `APP_RLS_PASSWORD` exists, and the tenant pool falls back to
  `DATABASE_URL` when it's missing (`tenant: APP_DATABASE_URL ?? DATABASE_URL`). Production doesn't
  require it. Already listed as open in the 2026-10-10 audit.
- **Impact:** any SQL injection or code execution in a function gets superuser rights; if the secret
  key is ever dropped, every tenant query runs without row-level security and nothing reports it.
- **Remediation:** fail closed in production when `APP_DATABASE_URL` is unset; make `/readyz`
  check `current_user = 'app_rls'` on the tenant pool; then add a non-superuser owner role for the
  runtime and keep the master secret for migrations only.
- **Verify:** unit test that `env()`/the pool refuses production without `APP_DATABASE_URL`;
  read-only on the live database: `select rolsuper, rolbypassrls from pg_roles where rolname in ('app','app_rls')`.
- **Complexity:** fail-closed low; separate runtime role moderate (migration + grants).
  **Blocks release:** the fail-closed part, yes.

#### M7. The page Content-Security-Policy doesn't restrict scripts

- **Status:** CONFIRMED (live response headers, 2026-10-23, and `apps/web/public/_headers:9-10`).
- **Evidence:** the enforced policy is `frame-ancestors 'none'; base-uri 'self'; object-src 'none';
  form-action 'self'`. The allowlist (`default-src 'self'; script-src 'self' 'unsafe-inline' ...`)
  is only `Content-Security-Policy-Report-Only`, with no `report-uri`/`report-to`, so violations go
  nowhere.
- **Impact:** no second line of defence against XSS: injected script can load code from anywhere
  and send session-visible data (dashboard figures, customer contact details shown live) to any
  host. No XSS was found; React escapes output and templates are sanitized.
- **Remediation:** enforce the existing allowlist (e2e `console.spec.ts` already checks it raises no
  reports), then replace `'unsafe-inline'` with build-time script hashes and add a reporting
  endpoint.
- **Verify:** `curl -sI https://bizinsights.io/login` shows `script-src` in the enforced header; the
  e2e suite passes.
- **Complexity:** low to enforce, moderate for hashes. **Blocks release:** recommended.

#### M8. Old production credentials sit in plaintext on the owner's PC

- **Status:** CONFIRMED (file presence and value lengths; the values weren't tested against the
  providers).
- **Component:** gitignored files in the main checkout `C:\Users\Seban\Videos\saas-project2.0`:
  `.env` and `apps/web/.env.local` (2026-10-02/03), `apps/cloudflare/.dev.vars`.
- **Evidence:** they hold a Shopify client secret (`shpss_…`, 38 characters) for the app whose
  client id (`57e9ef…`) production still uses (`apps/aws/src/settings.ts:11`), a Google/Firebase
  service-account key (3,160 characters of base64, Firebase is no longer used), and the old
  Cloudflare Tunnel token (240 characters). The runner's account (`ghrunner`, not an administrator)
  can't read them; the Windows account `Seban` reports `PasswordRequired=False`.
- **Impact:** if that Shopify secret is still current, anyone who copies it can forge Shopify
  webhooks (including `app/uninstalled` and `shop/redact`) and complete OAuth as the app. The
  service-account key may still be valid in Google Cloud.
- **Remediation (owner):** check whether that Shopify secret is the one in Secrets Manager and
  rotate it in the Partner Dashboard if so; delete the service-account key in Google Cloud (IAM →
  Service accounts → Keys) and the old tunnel in Cloudflare Zero Trust; then delete the three files.
  Make sure the Windows account has a password and the disk is encrypted (BitLocker).
- **Complexity:** low (owner only). **Blocks release:** the Shopify secret check, yes.

### LOW

| # | Finding | Status | Evidence | Fix |
| --- | --- | --- | --- | --- |
| L1 | Password reset ends sessions best-effort and finds the account by `users.email` | CONFIRMED | `auth.ts:921-926` (`.catch` on the update; lookup by email) | Find the account through the Cognito sub; answer 503 when the cut-off can't be written (as `/auth/logout-all` does) |
| L2 | Session cookies have no `__Host-` prefix: a cookie planted by any `*.bizinsights.io` host would win | SUSPECTED (needs a writable subdomain) | `session.ts:20,173`; Hono keeps the first cookie of a name | `__Host-` for session and `__share`, `__Secure-` for the refresh cookie, reading old names for 5 days |
| L3 | Reset-code guesses limited per IP only in the app | SUSPECTED (relies on Cognito's own lockout) | `auth.ts:897` | Per-address attempt counter before calling Cognito |
| L4 | Password rule is 8 characters, no breached-password check | CONFIRMED | `packages/shared/src/auth.ts:19-25`, `infra/aws/cognito.yaml:132-138` | Common/breached password list (k-anonymity) |
| L5 | Staff invitation token in the URL query and localStorage | CONFIRMED | `apps/web/src/app/join/page.tsx:44-46,175,210` | Same hash + request-body pattern as team invitations |
| L6 | One tenant can lock another out of "Check against Shopify" for 10 minutes | CONFIRMED | `exports.ts:96` limits on `storeId` before the ownership check at `:98` | Key the limit by `ws:storeId` or move it after the lookup |
| L7 | Read-only sessions and API keys can trigger writes/outbound calls (notification settings, inventory sync, live Google Ads reports) | CONFIRMED | `workspaces.ts:157-170`, `inventory.ts:287`, `adsGoogleDemo.ts:226-236` | Refuse link sessions on writes; manage permission for sync |
| L8 | A read-only shared link can opt WhatsApp customers out of all messages | CONFIRMED | `whatsappOps.ts:712-722` needs only view permissions | Require `stores:manage`, refuse link sessions (SMS already does) |
| L9 | SMTP host checked through DNS-over-HTTPS but connected through system DNS (rebinding) | CONFIRMED | `packages/core/src/email/providers.ts:233-246`, `apps/aws/src/nodeSmtp.ts:13` | Connect to the vetted IP with `servername: host` |
| L10 | Payroll "four eyes" compares only approver and submitter | CONFIRMED | `packages/core/src/staff/payroll.ts:448` | Refuse approval by anyone who changed an adjustment since the last decision |
| L11 | SMS test-number verification texts aren't counted toward spend caps | CONFIRMED | `packages/core/src/sms/senders.ts:193-217`, `sms/common.ts:202` | Country allowlist, daily caps, count them |
| L12 | Open redirect: `/r/:code` sends to any https campaign link | CONFIRMED (by design) | `whatsappPublic.ts:329-342`, `whatsappOps.ts:73` | Interstitial or store-domain allowlist |
| L13 | Reinstalling before `app/uninstalled` is processed gives the store back to its old workspace | CONFIRMED (race) | `apps/api/src/routes/shopify.ts:344-345, 610-612`, `connectStore.ts:116-120` | Run the manager check whenever the old token was refused |
| L14 | Anyone can post events with a store's public pixel key (funnel counts, not revenue) | CONFIRMED (by design) | `routes/pixel.ts:31-37,72`, `rateLimit.ts:185` | Per-key limits, Origin soft check |
| L15 | The function URL serves static paths before the origin-secret check; the check fails open if `ORIGIN_VERIFY` is unset; no reserved concurrency | CONFIRMED (code) | `apps/aws/src/index.ts:159-169`, `app-stack.ts:251` | Check on every path; require it in production; reserve concurrency |
| L16 | WAF rate-limit exemption matches the raw path (`/api/webhooks/../auth/login`) | SUSPECTED | `infra/cdk/lib/edge-stack.ts:44-59` (no `NORMALIZE_PATH`) | Add `URL_DECODE` + `NORMALIZE_PATH` text transformations |
| L17 | Log scrubbing misses JWTs, Google `ya29.`/`1//` tokens, `re_` keys, AWS keys, `code=`/`refresh_token=` query values, and keys like `pass`, `apiKey`, `code_verifier` | CONFIRMED | `packages/core/src/logger.ts:16-75` | Add the keys and patterns with tests on `redactForLog` |
| L18 | No WAF/CloudFront logs, no VPC flow logs, RDS log export without retention, CloudTrail not alarmed, GuardDuty not in code | CONFIRMED (code) | `app-stack.ts:314-345`, `edge-stack.ts`, `data-stack.ts:58-73,160`, `audit-stack.ts:53,138` | WAF logs, retention, REJECT flow logs, CloudTrail metric filters |
| L19 | Over-broad grants: api may `sms-voice:TagResource` on `*` (tags decide which workspace owns a sender); the Cognito email function reads the whole app secret incl. `TOKEN_ENCRYPTION_KEYS`; SES from `identity/*` | CONFIRMED (code) | `app-stack.ts:193,216-220`, `auth-stack.ts:161` | Condition the tag grant; give the Resend key its own secret |
| L20 | Vitest 4.1.11 (dev only): 2 moderate advisories in `@vitest/mocker` | CONFIRMED (`pnpm audit`) | `pnpm-lock.yaml` | Patch to 4.1.12 |
| L21 | `main` has no branch protection and GitHub secret scanning is off (Free private repo): a direct push to `main` deploys | CONFIRMED (GitHub API) | 403 "Upgrade to GitHub Pro" | Gitleaks in CI; consider Pro or a public-safe alternative |

### INFORMATIONAL

- A Firebase browser API key (`AIzaSy…`) is in git history (removed 2026-10-18/21). Such keys are
  public by design, but delete or restrict it in Google Cloud now that Firebase is gone.
- Google OAuth client ids in `apps/aws/src/settings.ts` and docs are public identifiers, not secrets.
- `adwords` is read-write by nature (Google has no read-only scope); the code only calls
  `searchStream`. A test that fails on any `:mutate` call would keep it that way.
- Meta's permissions come from the Login for Business `config_id`, outside the repo: confirm it holds
  only `ads_read`. Microsoft mail asks for `profile`/`email` it doesn't need.
- Shopify's HMAC covers the body only; a captured body could be replayed under another topic header.
  Nango webhooks have no timestamp (duplicates remembered 24 h). Both need a captured signed body.
- The Shopify bulk-result URL is checked for https only (no host allowlist); WhatsApp
  `phone_number_id` has no unique constraint; AES-GCM `decrypt` doesn't fix `authTagLength: 16`.
- Removing a device doesn't revoke its Cognito refresh token (not usable without the session).
- If emailed sign-in codes are ever switched on, Cognito may skip the authenticator step after them
  (`cognito.yaml:140` allows `EMAIL_OTP` as a first factor).
- The WAF's IP-reputation rule skips Cloudflare-proxied requests and the common rule set only counts,
  so in practice WAF gives rate limiting and known-bad-inputs. `d2mr8m2p1qkh58.cloudfront.net`
  answers directly (it redirects pages to bizinsights.io; CloudFront's WAF still applies).
- A missing `/_next/static/*` file returns S3's `NoSuchKey` XML (no bucket name in it).
- HSTS is one year with `includeSubDomains`, without `preload`.

## D. Immediate fixes (before real merchants connect accounts)

1. H1, owner step: install the main-only runner and set `SELF_HOSTED_MAIN_RUNNER`.
2. M8, owner step: check/rotate the Shopify client secret found on the PC; revoke the old
   service-account key and tunnel; delete the files.
3. M3: single-use, platform-matched Nango callback with a consent receipt.
4. M6 (fail-closed part): refuse production without `APP_DATABASE_URL`; `/readyz` checks the role.
5. M2 and M1: retire an admin's invitations and copied links when they leave; stop session-less
   link opens from creating memberships on existing accounts.
6. M4: notices and session cut-off on email/password change.
7. M5, M7.

## E. Long-term improvements

- Split build and deploy (H1 code part), scoped CDK execution policy, and a non-superuser runtime
  database role (M6).
- Script-hash CSP with a reporting endpoint.
- Read-side IDOR tests: for every `GET /workspaces/:ws/...` route, call it with workspace B's ids
  from workspace A and expect 404 (today `security.test.ts` covers writes in `workspaces.ts` only),
  and a test that every RLS policy's expression names `app.workspace_id` (today it checks only that
  a policy exists).
- Detection: WAF and CloudFront logs, CloudTrail alarms (root sign-in, IAM changes), GuardDuty and
  its retention in code, an alarm on spikes of 401/429 and on `invite_open_unverified_account`,
  `nango callback refused` and token-refresh failures.

## F. Production readiness

The evidence supports running the product for early customers once the two owner steps in D
(runner, Shopify secret) are done: there is no confirmed way for an outside attacker to read
another merchant's data or tokens without that merchant's action. Outstanding blockers before broad
production use: H1 (owner step), M3, M6 fail-closed, M8. The rest of the MEDIUM items should be
fixed before teams and Staff Management are used widely. Checks marked NOT TESTED below can change
this assessment, the live AWS configuration most of all.

## G. Security test coverage

**Completed and passed**

- Secret scan (pattern scanner written for this audit; Gitleaks isn't installed and wasn't
  downloaded): working tree, 808 commits on all branches, 61 live JS chunks and 11 live pages. Only
  test fixtures, placeholders and public identifiers found, plus the Firebase browser key in history.
- No source maps served (`.map` 404) and no `sourceMappingURL` in any chunk; no `NEXT_PUBLIC_*`
  values; browser storage holds one UI flag (`insights:awaiting-scope-grant`).
- `/.env` → 403, `/.git/config` → 404, `/api/me` without a session → 401 with `no-store`.
- HTTP → HTTPS 301 (apex and www); HSTS on pages and API; TLS 1.2 and 1.3 accepted, TLS 1.0 and 1.1
  refused (bizinsights.io, the CloudFront host, auth.bizinsights.io).
- `pnpm audit`: 0 critical, 0 high, 2 moderate (dev only).
- GitHub: all workflow actions pinned by SHA; default token read-only; no fork PRs (private).
- API integration test suite on `c0f1613` against a throwaway local Postgres 18 (dummy workspaces,
  tenant queries as `app_rls`): **39 files passed, 1 skipped (the live-Cognito file); 712 tests
  passed, 3 skipped, 0 failed** (26 minutes). It includes `security.test.ts` (headers, rate limits,
  code guessing, webhook shop binding, cross-workspace writes in `workspaces.ts`, RLS on every
  table), `tenancy.test.ts`, `team.test.ts` (a cross-workspace link test) and `hardening.test.ts`.
  Passing means the existing protections still hold. None of these tests cover M1–M5, which is
  why they pass.

**Failed**

- Enforced CSP lacks `script-src` (M7). Branch protection and secret scanning unavailable (L21).

**Not performed, and what they need**

- Live AWS configuration (IAM policies and trusts, S3 public access, RDS `PubliclyAccessible`,
  security groups, Lambda function URL auth, GuardDuty, WAF logging, secret key names): the AWS CLI
  session had expired. Needs `aws login`; read-only commands are listed in section H.
- The function URL called directly without the origin secret (needs its URL from AWS).
- Cross-account tests against production with two real test accounts: not done (creating accounts on
  production wasn't authorized). The same checks ran locally in the integration suite.
- Cloudflare zone settings (SSL mode, minimum TLS, URL normalization, WAF): needs dashboard access.
- Meta `config_id` permissions, Google consent-screen status: provider consoles.
- Dynamic scanning (DAST), fuzzing, load and rate-limit tests: deliberately not run against production.

## H. Remediation roadmap

1. **Credentials and customer data:** H1 owner step, M8 rotation, M6 fail-closed, then gitleaks in CI
   and pre-commit.
2. **Authentication and authorization:** M4, M2, M1, M5, L1, L7, L8, L6.
3. **OAuth and integrations:** M3, L13, then L9, L12, L14 and the webhook replay checks.
4. **Infrastructure and dependencies:** H1 workflow split, L15, L16, L19, L20, scoped CDK bootstrap,
   runtime database role (M6 second part).
5. **Hardening:** M7 (enforce, then hashes), L2, L3, L4, L5, L17, L18, L10, L11.

Read-only AWS checks to run once signed in (`aws login`), none of which change anything:

```
aws lambda get-function-url-config --function-name <api function>
aws rds describe-db-instances --query "DBInstances[].{id:DBInstanceIdentifier,public:PubliclyAccessible,enc:StorageEncrypted}"
aws s3api get-public-access-block --bucket <each bucket>
aws ec2 describe-security-groups --query "SecurityGroups[?IpPermissions[?IpRanges[?CidrIp=='0.0.0.0/0']]].GroupId"
aws iam get-role --role-name insights-production-github-deploy
aws guardduty list-detectors
aws wafv2 get-logging-configuration --region us-east-1 --resource-arn <web ACL arn>
```

## Continuous monitoring (free tools)

- **Secrets:** Gitleaks as a CI job on every pull request and as a pre-commit hook; keep `put-secrets.mjs`
  as the only way secrets enter AWS.
- **Dependencies:** add the npm ecosystem to `.github/dependabot.yml` (today only GitHub Actions);
  keep `pnpm audit --audit-level high` in CI; OSV-Scanner weekly if wanted.
- **Static analysis:** Semgrep (OSS rules for TypeScript/Node) as a non-blocking CI job.
- **Runtime:** CloudWatch metric filters on the JSON logs for `session_created` failures, 429s per
  route, `nango callback refused`, `invite_open_unverified_account`, webhook HMAC failures and
  token-refresh errors, each with an alarm to the existing SNS topic; CloudTrail alarms for root
  sign-in and IAM changes; GuardDuty findings to email.
- **Regression:** the IDOR and RLS tests in E run on every pull request (they are integration tests,
  already in CI's paths list when added under `apps/api/test`).
- **Reviews:** monthly Trusted Advisor and Access Analyzer check (already in place), quarterly
  re-run of this audit, and a restore test of an RDS snapshot each quarter.

## Incident response (short form)

- **A leaked secret:** rotate it at the provider, put the new value with `put-secrets.mjs`, redeploy
  (cold starts read it); for `TOKEN_ENCRYPTION_KEYS` add a new key id and run the rotation in
  `packages/core/src/keyRotation.ts`; for `SESSION_SECRET` every session ends (expected).
- **A suspected account takeover:** "sign out everywhere" for the user (moves `sessions_valid_after`
  and ends every Cognito refresh token), then check `auth_events` and `audit_logs` for the account.
- **Suspected cross-tenant access:** find the requests by `x-request-id` in CloudWatch, list the
  workspace's `audit_logs`, revoke the API keys and invitation links involved, and notify the
  affected merchants (and Shopify, under its partner terms) with what was exposed.
