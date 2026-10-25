# Local development

The app runs locally as the same code that runs on AWS: the local server (`apps/aws/src/local.ts`) serves the UI, the API and the background jobs from one Node process. In place of the AWS services, jobs run in-process (`localQueues.ts`), coordination (rate limits, OAuth state, locks) and large webhook bodies stay in memory, email goes to Mailpit, and Postgres is your local database.

## Prerequisites

Node 24 (`.nvmrc`), pnpm 9 (`corepack enable`), Docker.

## 1. Start dependencies

```bash
docker compose up -d postgres mailpit cognito
```

| Service | Host port | Notes |
| --- | --- | --- |
| Postgres 17 | 5434 | owner `app/app`; tenant role `app_rls/app_rls` created by `infra/postgres/init.sql` |
| Mailpit | 8025 UI | every email (invites, alerts) lands at http://localhost:8025 (the server posts to Mailpit's HTTP API when `MAILPIT_URL` is set) |
| Cognito emulator | 9229 | the app's user pool, ready to use ([infra/cognito-local](../infra/cognito-local/README.md)); codes it would email are in `docker compose logs cognito`. Without Docker: `node infra/cognito-local/start.mjs` |
| Evolution API (WhatsApp; optional) | 8081 | only with `docker compose --profile whatsapp up -d evolution`: the release production runs, with a database of its own ([whatsapp.md](whatsapp.md)) |

## 2. Configure

```bash
cp apps/aws/.env.example apps/aws/.env
```

Generate an encryption key and paste it into `TOKEN_ENCRYPTION_KEYS=1:<key>`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`.env.example` already points sign-in at the Cognito emulator and the database at `app_dev`. To use a real user pool instead (Google needs one), drop `COGNITO_ENDPOINT` and fill in that pool's settings ([cognito-setup.md](cognito-setup.md)). The settings every environment shares (Shopify app, ad platforms, WhatsApp's Cloud API) come from `apps/aws/src/settings.ts`; anything in `.env` overrides them, and the shell's environment overrides both. The UI needs no settings of its own. WhatsApp's own service is set in `.env` only: `EVOLUTION_API_URL=http://127.0.0.1:8081`, `EVOLUTION_API_KEY` (the compose file's) and `EVOLUTION_WEBHOOK_URL=http://host.docker.internal:8787/api`, so the container can reach this server; without the URL and key, connecting WhatsApp is off.

The repo-root `.env` (from `.env.example`) is only for tools on this machine: docker compose, the Prisma CLI (`DATABASE_URL`, migrations) and the maintenance tasks in [RUNBOOK.md](RUNBOOK.md#maintenance-tasks). Which file configures what: [architecture.md](architecture.md#configuration).

## 3. Database

Local development uses its own database, `app_dev` (the default `DATABASE_URL` in both `.env.example` files). Create and migrate it, then give the tenant role its grants:

```bash
pnpm db:migrate
```

```bash
pnpm --filter @app/db test:grants
```

Never point local tools at `app`: on the owner's PC the compose Postgres (port 5434) still holds the old Cloudflare deployment's production data ([aws-deployment.md](aws-deployment.md#retiring-the-old-cloudflare-deployment)). `prisma migrate dev` and `migrate reset` refuse to run on a database named `app`.

## 4. Run

Build the UI once, then start the server:

```bash
pnpm --filter @app/web build
```

```bash
pnpm --filter @app/aws dev
```

- App: http://localhost:8787 (UI, with the API at `/api/*`)
- Health: http://localhost:8787/api/readyz
- Schedules don't run by themselves. Run one: `curl -X POST "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"` (the expressions are `CRON` in `apps/worker/src/index.ts`)
- Options: `--port`, `--assets <UI build>` (default `apps/web/out`), `--settings <file>` (default `apps/aws/.env`), e.g. `pnpm --filter @app/aws dev --port 8790`
- `dev` restarts on code changes; a rebuilt UI is picked up without a restart

For UI work with hot reload, run `pnpm --filter @app/web dev` as well and open http://localhost:3001: `next dev` proxies `/api/*` to the server on 8787 (`API_INTERNAL_URL` overrides the target).

## Connecting a real dev store locally

Shopify must reach your callback and webhook URLs over HTTPS. Use a tunnel (e.g. `ngrok http 8787`), set `APP_URL` (and `API_URL` = `APP_URL/api`) in `apps/aws/.env` to the tunnel URL, and put `<tunnel>/api/shopify/callback` in the app's redirect URLs. See [shopify-setup.md](shopify-setup.md).

## Tests

| Command | What runs | Needs Docker |
| --- | --- | --- |
| `pnpm test` | unit tests (shared, core, the AWS adapters and local server) | no |
| `pnpm test:integration` | API + worker against real Postgres (`app_test` DB) with in-memory queues and coordination | yes |
| `pnpm e2e` | Playwright against the local server (port 8789), its own Cognito emulator and managed-login stand-in, Mailpit (`app_e2e` DB) | yes (Postgres, Mailpit) |
| `pnpm typecheck` | all packages | no |

Integration tests fake Cognito and Shopify HTTP; they never call the internet.

They also truncate every table between tests, so one run needs the database to itself. The global
setup takes a Postgres advisory lock for the whole run (`lockTestDatabase`), so a second run waits
rather than quietly wiping the first one's rows — a collision surfaces as unrelated tests failing
in a different place every run, which reads as a flaky suite. Postgres drops the lock when the
connection goes, so a killed run leaves nothing to clear up. To run two suites at once — a second
checkout, or a watch alongside a one-shot run — give each its own database with
`TEST_DB=<name>_test`; it is created and migrated on first use.

The suites default to the compose Postgres on port 5434. To keep test load and migrations off that
server (on the owner's PC it also holds the old deployment's production data), run them against a
throwaway container and point `TEST_PG_PORT` at it (integration and e2e both read it):

```bash
docker run -d --name insights-test-pg -p 127.0.0.1:5440:5432 -p "[::1]:5440:5432" -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app --tmpfs /var/lib/postgresql/data postgres:17-alpine -c fsync=off
TEST_PG_PORT=5440 pnpm test:integration
```

Publish it on both loopbacks as above. The connection strings say `localhost`, which Node may try
over IPv6 first; with only `127.0.0.1` published, every new database connection waits for that
attempt to fail.

E2E can run beside a local demo the same way. Give it its own server port, Cognito emulator, login
stand-in and Mailpit, because its global setup deletes every Mailpit message:

```bash
TEST_PG_PORT=5440 E2E_PORT=8790 E2E_COGNITO_PORT=9250 E2E_LOGIN_PORT=9260 E2E_MAILPIT_URL=http://localhost:8125 pnpm e2e
```
