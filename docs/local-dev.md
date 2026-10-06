# Local development

The app runs locally exactly as in production: one Cloudflare Worker (`apps/cloudflare`) under `wrangler dev`, which simulates Queues, Durable Objects, R2, Cron and the rate limiter, and reaches your local Postgres through Hyperdrive's `localConnectionString`.

## Prerequisites

Node 24 (`.nvmrc`), pnpm 9 (`corepack enable`), Docker.

## 1. Start dependencies

```bash
docker compose up -d postgres mailpit firebase-emulator
```

| Service | Host port | Notes |
| --- | --- | --- |
| Postgres 17 | 5434 | owner `app/app`; tenant role `app_rls/app_rls` created by `infra/postgres/init.sql` |
| Mailpit | 8025 UI | every email (OTP codes, invites, alerts) lands at http://localhost:8025 (the Worker posts to Mailpit's HTTP API when `MAILPIT_URL` is set) |
| Firebase Auth emulator | 9099 | optional if you use a real Firebase project; first start takes 1–2 min |

Redis is no longer used (the `redis` compose service can be removed).

## 2. Configure

```bash
cp apps/cloudflare/.dev.vars.example apps/cloudflare/.dev.vars
```

Generate an encryption key and paste it into `TOKEN_ENCRYPTION_KEYS=1:<key>`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put the `NEXT_PUBLIC_FIREBASE_*` values in `apps/web/.env.local` (baked into the UI at build time). To use the emulator, also set `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR=http://127.0.0.1:9099` there and keep `FIREBASE_SERVICE_ACCOUNT_B64` empty in `.dev.vars`. To use a real project, set the service account and remove `FIREBASE_AUTH_EMULATOR_HOST`.

`DATABASE_URL` in the repo-root `.env` is only used by the Prisma CLI (migrations).

## 3. Database

```bash
pnpm db:migrate
```

## 4. Run

Build the UI once, then start the Worker:

```bash
pnpm --filter @app/web build
```

```bash
pnpm --filter @app/cloudflare dev
```

- App: http://localhost:8787 (UI, with the API at `/api/*`)
- Health: http://localhost:8787/api/readyz
- Trigger a cron locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"` (start `wrangler dev` with `--test-scheduled`)

For UI work with hot reload, run `pnpm --filter @app/web dev` as well and open http://localhost:3001: `next dev` proxies `/api/*` to the Worker on 8787 (`API_INTERNAL_URL` overrides the target).

## Connecting a real dev store locally

Shopify must reach your callback and webhook URLs over HTTPS. Use a tunnel (e.g. `cloudflared tunnel --url http://localhost:8787`), set `APP_URL` (and `API_URL` = `APP_URL/api`) in `.dev.vars` to the tunnel URL, and put `<tunnel>/api/shopify/callback` in the app's redirect URLs. See [shopify-setup.md](shopify-setup.md).

## Tests

| Command | What runs | Needs Docker |
| --- | --- | --- |
| `pnpm test` | unit tests (shared, core) | no |
| `pnpm test:integration` | API + worker against real Postgres (`app_test` DB) with in-memory queues and coordination | yes |
| `pnpm e2e` | Playwright against `wrangler dev` (port 8789), Firebase emulator, Mailpit (`app_e2e` DB) | yes |
| `pnpm typecheck` | all packages, including the Worker against generated binding types | no |

Integration tests fake Firebase and Shopify HTTP; they never call the internet.

They also truncate every table between tests, so one run needs the database to itself. The global
setup takes a Postgres advisory lock for the whole run (`lockTestDatabase`), so a second run waits
rather than quietly wiping the first one's rows — a collision surfaces as unrelated tests failing
in a different place every run, which reads as a flaky suite. Postgres drops the lock when the
connection goes, so a killed run leaves nothing to clear up. To run two suites at once — a second
checkout, or a watch alongside a one-shot run — give each its own database with
`TEST_DB=<name>_test`; it is created and migrated on first use.
