# Security audit, 2026-10-10

> Historical record (2026-10-10): written when bizinsights ran on Cloudflare Workers. It now runs on
> AWS: see [aws-architecture.md](aws-architecture.md) and, for the current model, [security.md](security.md).

**Scope:** this repository at `1e77f3a` (main): the Worker (`apps/cloudflare`), API (`apps/api`),
queue consumers (`apps/worker`), `packages/*`, the static UI (`apps/web`), Postgres schema/RLS,
`docker-compose.yml`, CI, and the local host that runs the production database.

**Not in scope:** production currently runs a combined build that also contains uncommitted work
from other worktrees (Meta/Google Ads connect, AdSense, the landing page). That code is not on this
branch and was not reviewed. The Ads connect flows handle third-party OAuth tokens and should get
the same review before they are merged.

The current model is summarised in [security.md](security.md).

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | Critical | The production Postgres container publishes 5434 on all interfaces (`0.0.0.0` and `::`), and Docker Desktop's Windows firewall rule allows inbound TCP on any port on the **Public** profile. Anyone on the same Wi-Fi, or on this PC's Mobile Hotspot (192.168.137.x), can log in as the superuser `app` with the default password `app`. That means reading every user, workspace and order, adding themselves to any workspace, and running commands in the container (`COPY ... TO PROGRAM`). Redis, Mailpit (dev sign-in codes) and the Auth emulator were exposed the same way. | Fixed in `docker-compose.yml` (loopback-only ports). **Manual steps A1–A3 are required:** the running container and its passwords are unchanged. |
| 2 | Medium | Email sign-in codes could be guessed from many IPs. Each code allows 5 tries and a new one can be requested every 5 minutes, so a distributed guesser got about 1,400 tries a day at a 1-in-a-million code (around 4% a month to take over a targeted account). | Fixed: at most 30 guesses per address per day, counted from the codes' own attempt counters. Nobody can use up a victim's allowance without codes being emailed to the victim. Trade-off: someone who keeps requesting and failing codes for an address can block code sign-in for that address for up to a day. Before this change they could already disrupt it by requesting a new code every few minutes. Google, password and Shopify sign-in are unaffected. |
| 3 | Medium | Invitations had no limit. Each one sends an email from our domain, so a workspace admin could use it as a spam relay and damage the sender reputation. | Fixed: 20 per workspace per hour. |
| 4 | Medium | The app accepted the placeholder and test secrets published in this repo (`change-me-…`, the test `TOKEN_ENCRYPTION_KEYS` key) in production. A known encryption key decrypts every stored Shopify token. | Fixed: in production the app refuses to start and names the variable, never its value. **Check before deploying (A4).** |
| 5 | Medium | The Worker's system paths connect as `app`, which is the Postgres superuser. No SQL injection was found, but any future one would be server-wide. | Fixed 2026-10-30 (B1, done differently: see there). The system paths log in as `app_system`, which owns nothing and has no BYPASSRLS, so row-level security applies to them too, each in a named scope ([system-database-role.md](system-database-role.md)). Only the cron's maintenance actions log in as the owner. |
| 6 | Low | API responses had no `nosniff`, `Cache-Control` or CSP headers, so account and customer data could stay in browser and proxy caches. `public/_headers` only covers static files. | Fixed: API middleware sets nosniff, `no-store`, `default-src 'none'`, `frame-ancestors 'none'` and `X-Frame-Options` on every response, including errors and 429/413. |
| 7 | Low | The static UI had no HSTS and no CSP. | Fixed: HSTS plus a CSP limited to `frame-ancestors`, `base-uri`, `object-src` and `form-action`, which cannot affect script loading or Firebase popups. A full `script-src` policy is follow-up B3. |
| 8 | Low | The webhook HMAC covers only the body, so the `X-Shopify-Shop-Domain` header is unauthenticated. A captured, signed `app/uninstalled` or `shop/redact` body could be replayed against another store. | Fixed: a body that names its shop (`shop_domain` or `myshopify_domain`) must match the header. Otherwise the request gets a 401 and nothing is recorded. |
| 9 | Low | The open-redirect guard used after sign-in (`returnTo`, `/start` `next`) accepted `"/\t/evil.com"` and `"/\evil.com"`, which browsers resolve to `https://evil.com/`. Both callers pass only paths the app builds itself, so this was not exploitable today. | Fixed: backslashes and control characters are rejected. |
| 10 | Low | Log redaction was case-sensitive and missed `password`, secrets, `set-cookie`, `x-shopify-access-token`, `oobCode` and others. Tokens and email addresses inside error messages were logged verbatim. No current call site leaked a secret. | Fixed: key matching is case-insensitive with a wider list. Shopify tokens, bearer credentials, `sk_live_` keys and email addresses (masked as `j***@domain`) are scrubbed from messages, strings and error stacks. |
| 11 | Low | Workspace and API-key creation had no limit. | Fixed: 10 per user per hour, and 10 per workspace per hour. |
| 12 | Low | The worker fetched whatever result URL the Shopify API returned. | Fixed: HTTPS only. Workers cannot reach private networks anyway. |
| 13 | Low | CI ran with the default `GITHUB_TOKEN` permissions. | Fixed: `contents: read`. |
| 14 | Low (dev/build only) | `pnpm audit` reported 2 critical, 4 high, 3 moderate and 1 low advisories: tinypool and @vitest/mocker (Vitest 3), mysql2 and deepmerge-ts (Prisma CLI), sharp (Miniflare), @grpc/grpc-js (Firestore, which the app never imports). None of them ship in the Worker or browser bundle. | Fixed: Vitest 4.1.11, plus `pnpm.overrides` for the rest. `pnpm audit` is clean. |

### Checked, no change needed

- **SQL injection:** every raw query is a Prisma tagged template (parameterised). The only
  `$executeRawUnsafe` is test-only and uses catalog table names.
- **XSS:** React escaping throughout. There is no `dangerouslySetInnerHTML`, `innerHTML` or `eval`.
  Links are built from validated `*.myshopify.com` domains and `mailto:` bodies are URI-encoded.
- **CSRF:** SameSite=Lax cookie plus an Origin check on cookie-authenticated writes, and on
  sign-in/sign-up even without a cookie.
- **BOLA/IDOR:** every workspace route goes through `requireWorkspace` (non-members get 404), and
  object lookups filter by workspace inside an RLS transaction. New tests cover cross-tenant writes.
- **JWT:** Firebase ID tokens and session cookies are verified with RS256 pinned, issuer, audience
  and expiry. Revocation is checked on every request, and logout revokes refresh tokens.
  Emulator mode (unsigned tokens) fails closed on any non-local `APP_URL`.
- **Session handling:** cookies are httpOnly, Secure in production, and SameSite=Lax. Sessions are
  minted only from sign-ins under 5 minutes old and last 5 days.
- **CORS:** only the public pixel sends CORS headers, with `*` and no credentials.
- **Passwords:** Firebase Auth stores and hashes them. API keys and invitation tokens are
  high-entropy and stored as SHA-256.
- **RLS:** enabled with a policy on every table holding workspace rows, and the tenant role has no
  bypass. A new test fails any future tenant table that lacks it.
- **Webhooks:** raw-body HMAC with a constant-time compare, delivery-id dedupe, and safe redelivery.
  Shopify signs no timestamp, so a freshness check would add nothing.
- **Source maps:** none in the static export (`find out -name '*.map'` is empty), and none
  uploaded with the Worker.
- **Secrets in git:** a scan of the full history found only the committed test/e2e values. The
  public Firebase web API key and Shopify client ids in `wrangler.jsonc` are public by design.
- **Error handling:** generic 500 responses, with stacks kept in logs only.

## Manual steps

### A. Do now

**A1. Close the exposed ports on the running machine.** `docker-compose.yml` is fixed, but the
running `saas-project20-postgres-1` (and Mailpit, the Auth emulator) keep their old bindings until
they are recreated. Either:

- From an **elevated** PowerShell, add a block rule. Block beats allow, loopback is unaffected, and
  the tunnel reaches Postgres inside Docker's network, so production keeps working:

  ```powershell
  New-NetFirewallRule -DisplayName "Block LAN access to dev containers" -Direction Inbound -Protocol TCP -LocalPort 5434,6380,8025,1025,9099 -Action Block
  ```

- Or, once this branch is merged, recreate the containers **from the main checkout**. The compose
  project must stay `saas-project20`, because a worktree would create a new, empty database.
  Recreating loses the `docker update --restart unless-stopped` set on the container, so set it
  again. Expect a short production outage while Postgres restarts:

  ```powershell
  docker compose up -d postgres mailpit firebase-emulator; docker update --restart unless-stopped saas-project20-postgres-1
  ```

Verify from another device on the Wi-Fi, or with
`Test-NetConnection 192.168.1.4 -Port 5434` on the PC, which should fail.

**A2. Rotate the database passwords.** They were the defaults and were reachable from the network.
Run the `ALTER ROLE` statements and the two `wrangler hyperdrive update` commands in
[security.md](security.md#database-credentials-and-network-exposure), then check `/api/readyz`.

**A3. Look for tampering.** Nothing records who connected, so check for rows nobody created
through the app:

```sql
SELECT m.created_at, u.email, m.workspace_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY m.created_at DESC LIMIT 50;
SELECT created_at, workspace_id, name, prefix, revoked_at FROM api_keys ORDER BY created_at DESC LIMIT 50;
SELECT created_at, workspace_id, email, role, accepted_at FROM invitations ORDER BY created_at DESC LIMIT 50;
SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\_%';
```

Expect only `app` and `app_rls` (plus `postgres` if present). Stored Shopify tokens are encrypted
with `TOKEN_ENCRYPTION_KEYS`, which is not in the database, so a database read alone does not
expose them.

**A4. Before the next deploy,** confirm that `SESSION_SECRET`, `OTP_PEPPER` and
`TOKEN_ENCRYPTION_KEYS` were generated randomly. In production the app now refuses to start (every
API request fails; static pages still load) if any of them is a value from `.env.example`,
`.dev.vars.example` or the test setup. `npx wrangler secret list` shows the names only. If in
doubt, set new values. For the key, follow "Rotate the token encryption key" in
[RUNBOOK.md](RUNBOOK.md): add a new key first and keep the old one as the second entry.

### B. Follow-ups that need a production change

**B1. Stop using the superuser at runtime (finding 5). Done 2026-10-30, differently:** the plan
below would still have had the runtime log in as a table owner, and an owner skips row-level
security. Instead the system paths log in as `app_system`, a role that owns nothing, and name
their row scope (one workspace, or a reason on a reviewed list). The tables stay with `app`, whose
login only the cron's maintenance actions and the admin host have. Design, rollout and tests:
[system-database-role.md](system-database-role.md). The original plan, kept for the record: create a non-superuser owner, move table
ownership to it, point the `insights-db` Hyperdrive config and `DATABASE_URL` at it, and change
`ALTER DEFAULT PRIVILEGES FOR ROLE app` in `infra/postgres/init.sql` to the new role. `app` is
the bootstrap superuser, so `REASSIGN OWNED` will not work; use per-object `ALTER ... OWNER TO`:

```sql
CREATE ROLE insights_owner LOGIN PASSWORD '<strong>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE app TO insights_owner;
GRANT USAGE, CREATE ON SCHEMA public TO insights_owner;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO insights_owner', r.tablename); END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND t.typtype = 'e' LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO insights_owner', r.typname); END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE insights_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls;
```

Rehearse on a copy (`pg_dump` / `pg_restore`) and run the full test suite against it first.

**B2. Firebase console.**

- Enable email enumeration protection.
- Limit Authorized domains to the production host and `localhost`.
- In Google Cloud → Credentials, give the web API key API restrictions (Identity Toolkit and Token
  Service). It cannot take an HTTP-referrer restriction, because the Worker calls it server-side.
- Password sign-up and password reset go straight from the browser to Firebase, so our rate limits
  do not cover them. Turn on Firebase's abuse protection (App Check / reCAPTCHA Enterprise) for
  those.

**B3. Full Content-Security-Policy.** Ship `script-src` / `connect-src` / `frame-src` as
`Content-Security-Policy-Report-Only` first. The static export needs inline scripts, and Google and
Apple sign-in load `apis.google.com` and the `<authDomain>/__/auth/iframe`. Test both popups before
enforcing it.

### C. Accepted or minor

- The Firebase JS SDK keeps its refresh token in IndexedDB (`browserLocalPersistence`). The verify-
  email flow needs it to survive a new tab. Our own session is the httpOnly cookie, and the UI has
  no known XSS sink.
- The session cookie is `__session`, not `__Host-` prefixed. Renaming it signs everyone out.
- `SESSION_SECRET` is required by `env.ts` but unused.
- `cloudflare/cloudflared:latest`, `axllent/mailpit:latest` and `npx firebase-tools@14` are not
  pinned, and the GitHub Actions are pinned by tag rather than commit SHA.
- `/readyz` is public and reports whether the database is reachable.

## Verification

- `pnpm audit`: no known vulnerabilities (was 10).
- `pnpm typecheck`: clean.
- Tests: shared 58, core 74 (+5), api 183 (+13), worker 87 (+1). All pass on Vitest 4 against
  a throwaway Postgres.
- `pnpm --filter @app/web build`: static export builds, `_headers` is in the output, and there are
  no `.map` files.
- `pnpm --filter @app/cloudflare build` (wrangler dry run): bundles.
- Docker loopback binding: verified on this PC. `[::1]` and `127.0.0.1` connect; `192.168.1.4`
  is refused.
