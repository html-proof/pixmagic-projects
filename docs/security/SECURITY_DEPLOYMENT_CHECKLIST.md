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

## Cloudflare (when it is next deployed from `main`)

- [ ] **Migration first**, after a `pg_dump` backup: `psql -1 -f` the migration on production
      `app`, then `prisma migrate resolve --applied 20261016100000_security_hardening`.
- [ ] **Worker secrets.** `npx wrangler secret list --config apps/cloudflare/wrangler.jsonc` must
      not show `COGNITO_ENDPOINT` or `MAILPIT_URL`: production refuses to start with either.
- [ ] **Re-run grants on any database rebuilt from scratch** (`infra/postgres/init.sql`).

## Not ported: Turnstile

The Firebase-era branch had an optional Cloudflare Turnstile check on "Email me a code". `main`
signs in through Cognito (`/auth/otp/start`) and has no build-time UI settings, so it was left out.
Redoing it: serve the site key from `/auth/config`, render the widget on the code form, check the
token in `/auth/otp/start` before the per-address limit, and set the secret only after that UI is
live (the reverse order refuses every code request).

## Right after deploying to Cloudflare (smoke tests; AWS runs infra/cdk/scripts/smoke.mjs itself)

- [ ] `curl -sI http://insights.imeseban.workers.dev/login` → `301` to `https://…/login`.
- [ ] `curl -s -o /dev/null -w "%{http_code}" -X POST http://insights.imeseban.workers.dev/api/auth/session` → `403`.
- [ ] `curl -sI https://insights.imeseban.workers.dev/api/healthz` shows `strict-transport-security`.
- [ ] `/api/readyz` → `{"ok":true,…}`.
- [ ] Sign in with Google in a real browser, open DevTools → Console, and look for
      `[Report Only]` CSP messages while signing in with Google, Apple, and connecting Meta Ads /
      WhatsApp. If there are none after a few days of real use, promote the Report-Only policy in
      `apps/web/public/_headers` to `Content-Security-Policy` (merge it with the enforced one).
- [ ] Settings → Members: the pending invitations show a Cancel button.

## Owner actions outside the code (not done by me)

| Priority | Action | Why |
| --- | --- | --- |
| High | Rotate the `app` and `app_rls` database passwords and update both Hyperdrive configs (`docs/security.md`) | Still the defaults; they were LAN-reachable before 2026-10-11 (audit 2026-10-10, A2) |
| High | On the PC that hosts production: bind or firewall the native PostgreSQL on `0.0.0.0:5432` and the `shopping-cart` containers on `0.0.0.0:5433`/`:6379` | They listen on every interface on the machine that holds production's data (finding #11; reachability from another device not tested) |
| Medium | Move runtime off the Postgres superuser (`insights_owner` role) | Audit 2026-10-10, B1 |
| Medium | Bot check on sign-up, password reset and "Email me a code" (Turnstile, see above, or AWS WAF Bot Control on those paths) | Only rate limits stand in front of the emails these send |
| Medium | Confirm both Hyperdrive configs have caching disabled (`wrangler hyperdrive get <id>`) | A cached tenant read must never be served to another session |
| Medium | Move production Postgres off the home PC | Availability, plus physical and network exposure (see `insights-production-db-on-local-tunnel` notes) |
| Low | Pin GitHub Actions by commit SHA; pin `cloudflared` and `mailpit` image tags | Supply chain |
| Low | Custom domain later: Cloudflare SSL/TLS "Full (strict)" is moot for a Worker, but turn on "Always Use HTTPS", HSTS and minimum TLS 1.2 on the zone | Defence in depth |

## Rollback

All code changes are backward-compatible with the migrated database, and the migration is
compatible with the current production code. Rolling the Worker back
(`wrangler versions deploy <previous>@100% -y --config apps/cloudflare/wrangler.jsonc`) is safe
without touching the database. That command switches production immediately.
