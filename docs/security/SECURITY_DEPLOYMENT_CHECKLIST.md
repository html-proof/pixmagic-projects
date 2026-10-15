# Security deployment checklist, 2026-10-14

The 2026-10-14 hardening, as ported to the Cognito/AWS tree (`claude/security-hardening-aws`).

## AWS

Nothing to do by hand: merging to `main` runs Deploy to AWS, which applies
`20261016100000_security_hardening` and then `infra/postgres/init.sql` (the same revokes) through
the cron Lambda's `migrate` action before the smoke tests, and rolls the Lambdas back if those
fail. The migration changes no tables or columns, and the code before it runs fine against the
migrated database. It:

- revokes the tenant role's UPDATE/DELETE on `audit_logs` and writes on `users`;
- adds an audit-log immutability trigger and three Staff freeze triggers;
- creates one index on `pixel_events_seen(seen_at)` (pixel writes wait while it builds: seconds).

CloudFront already redirects http to https and sends HSTS; the API adds HSTS itself too.

## Not ported: Turnstile

The Firebase-era branch had an optional Cloudflare Turnstile check on "Email me a code". `main`
signs in through Cognito (`/auth/otp/start`) and has no build-time UI settings, so it was left out.
Redoing it: serve the site key from `/auth/config`, render the widget on the code form, check the
token in `/auth/otp/start` before the per-address limit, and set the secret only after that UI is
live (the reverse order refuses every code request).

## Right after deploying (Deploy to AWS runs `infra/cdk/scripts/smoke.mjs` itself: HTTPS redirect, HSTS, CSRF, `/api/readyz`)

- [ ] Sign in with Google in a real browser, open DevTools → Console, and look for
      `[Report Only]` CSP messages while signing in with Google and connecting Meta Ads /
      WhatsApp. If there are none after a few days of real use, promote the Report-Only policy in
      `apps/web/public/_headers` to `Content-Security-Policy` (merge it with the enforced one).
- [ ] Settings → Members: the pending invitations show a Cancel button.

## Owner actions outside the code (not done by me)

| Priority | Action | Why |
| --- | --- | --- |
| High | Until the old deployment is retired, its database on the owner's PC keeps the passwords it was created with: rotate them there, or retire it ([aws-deployment.md](../aws-deployment.md#retiring-the-old-cloudflare-deployment)) | Defaults that were LAN-reachable before 2026-10-11 (audit 2026-10-10, A2). On AWS both passwords are generated (Secrets Manager) |
| High | On the owner's PC: bind or firewall the native PostgreSQL on `0.0.0.0:5432` and the `shopping-cart` containers on `0.0.0.0:5433`/`:6379` | They listen on every interface on the machine that holds the old deployment's data (finding #11; reachability from another device not tested) |
| Medium | Run the system paths as a narrower owner than the master user `app` (an `insights_owner` role) | Audit 2026-10-10, B1 |
| Medium | Bot check on sign-up, password reset and "Email me a code" (Turnstile, see above, or AWS WAF Bot Control on those paths) | Only rate limits stand in front of the emails these send |
| Medium | Cut over to AWS, then retire the old deployment and the database on the home PC ([aws-deployment.md](../aws-deployment.md)) | Availability, plus physical and network exposure (see `insights-production-db-on-local-tunnel` notes) |
| Low | Pin GitHub Actions by commit SHA; pin the `mailpit` image tag | Supply chain |
| Low | Custom domain later: an ACM certificate in us-east-1, and a minimum of TLS 1.2 on the CloudFront distribution | Defence in depth |

## Rollback

All code changes are backward-compatible with the migrated database, and the migration is
compatible with the code before it. Rolling the functions back (`node infra/cdk/scripts/rollback.mjs`,
which moves the `live` aliases of api, jobs and cron to the previous versions; Deploy to AWS does it
by itself when the migration or the smoke tests fail) is safe without touching the database. That
command switches production immediately.
