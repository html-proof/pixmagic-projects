# Settings and secrets: from AWS to the server

Where every setting lives on AWS today, where it lives on the server, and how it gets there without
a value ever being shown. Names only: no value of a secret is in this page, in Git, or in a log.
The files themselves are described in
[IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md#secrets-replaces-secrets-manager--ssm);
the commands are in [PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md).

**Status (2026-11-11): nothing has been exported.** The server has no `~/bizinsights` folder yet.

## Four sources on AWS, eight files on the server

| On AWS | Holds | On the server |
| --- | --- | --- |
| `apps/aws/src/settings.ts`, shipped inside the Lambda package | The app's own settings that aren't secret: Shopify client ids and scopes, feature switches, `AUTH_MODE`, `SMS_PROVIDER`, public ids of the providers | **Unchanged**: the same file ships inside the server's image. A line in `env/app.env` wins over it |
| Secrets Manager, six secrets under `insights/production/` | `app` (the app's own secrets and every provider's), `worker-cognito` (Cognito's client secret), `evolution-api` (the WhatsApp service's key), `db-owner`, `db-system`, `evolution-db` (database logins) | `env/app.env`, `env/evolution.env` for the first three. The three database logins are **not copied**: the server's database gets new passwords (`env/owner.env`, `env/postgres.env`) |
| SSM parameter `/insights/production/runtime` | `APP_URL`, `API_URL`, and Cognito's region, pool, client and domain | `env/app.env` |
| Each Lambda function's environment (set by CDK) | Where this deployment's AWS resources are: ARNs, the database host, queue addresses, the bucket, the table | Mostly gone with the resources (below) |

The server's files, all in `~/bizinsights/env/`, mode 600, git-ignored, each read by the containers
that need it and no other. `env/*.example` in `infra/ikorex/` lists every name.

| File | Read by | Holds |
| --- | --- | --- |
| `app.env` | `web`, `worker`, `admin` | Addresses, the app's database logins, the app's own secrets, every provider's secret |
| `owner.env` | `admin` only | The database owner's login and the passwords `admin migrate` gives the app's roles |
| `postgres.env` | `postgres`, `backup` | The database's first password, the backup bucket's keys, the backup passphrase |
| `evolution.env` | `evolution` | The WhatsApp service's key and database login |
| `cloudflared.env` | `cloudflared` | The tunnel's token |
| `monitoring.env` | `grafana` | Grafana's admin login |
| `alerting.env` | no container (`render-monitoring.sh` reads it) | Where alerts go, and Resend's SMTP password |
| `postgres-exporter.env` | `postgres-exporter` | A statistics-only database login |

`.env` beside the Compose file holds two names and no secret: `APP_TAG` (set by `deploy.sh`) and
`SCHEDULES` (`off` until the cutover).

## Copied from AWS, never regenerated

`infra/ikorex/scripts/export-env.mjs app` reads the secrets `app`, `worker-cognito` and
`evolution-api` and the runtime parameter, and writes env-file lines. It refuses to write to a
terminal: its output goes straight into a file on the server over SSH, and it prints only the names
it wrote and the names it left out.

| Names | Why they must be the same values |
| --- | --- |
| `SESSION_SECRET` | Or every signed-in session ends at the cutover |
| `TOKEN_ENCRYPTION_KEYS`, `EMAIL_CREDENTIAL_KEYS` | They decrypt the Shopify, Meta, Google and mailbox tokens stored in the database: a new key leaves every store disconnected |
| `OTP_PEPPER` | Or codes and hashed customer identifiers stop matching |
| `SHOPIFY_API_SECRET`, `SHOPIFY_APP_SECRET_<KEY>` | Shopify signs webhooks and OAuth with them |
| `META_APP_SECRET`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_SIGNIN_CLIENT_SECRET`, `EMAIL_GOOGLE_CLIENT_SECRET`, `EMAIL_MICROSOFT_CLIENT_SECRET` | The providers' own; nothing changes at the providers, since every callback address stays on `bizinsights.io` |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `EVOLUTION_API_KEY` (also `AUTHENTICATION_API_KEY` in `evolution.env`) | The WhatsApp service's sessions come over with its database and expect the same key |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Resend keeps sending |
| `TWILIO_AUTH_TOKEN` | Once the owner's Twilio account exists |
| `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `COGNITO_DOMAIN`, `COGNITO_IDENTITY_PROVIDERS` | Only while `AUTH_MODE=migrating`; removed with `AUTH_MODE=local` before stage F |

## The Lambda environment, name by name

| On AWS | On the server |
| --- | --- |
| `NODE_ENV`, `LOG_LEVEL`, `APP_ENVIRONMENT` | The same, in the Compose file and `app.env` |
| `APP_COMMIT`, `APP_BUILT_AT` | From `build.json` inside the image |
| `APP_URL`, `API_URL` | `APP_URL` in `app.env`; the API's address follows from it |
| `APP_SECRET_ARN`, `RUNTIME_PARAM`, `SYSTEM_DB_SECRET_ARN`, `DB_SECRET_ARN`, `COGNITO_WORKER_SECRET_ARN`, `EVOLUTION_SECRET_ARN`, `EVOLUTION_DB_SECRET_ARN` | **Gone**: they said where to fetch values at start-up. On the server the values are in the env files, and nothing is fetched |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `NODE_EXTRA_CA_CERTS` (Amazon's RDS certificate) | `DATABASE_URL` (the system role) and `APP_DATABASE_URL` (the tenant role, under row-level security) in `app.env`; `OWNER_DATABASE_URL` in `owner.env`; `EVOLUTION_DATABASE_URL` for the nightly prune. The database is on the project's own Docker network, never on a host port |
| `QUEUE_URLS` | **Gone**: the queue is PostgreSQL tables. Optional `QUEUE_CONCURRENCY` |
| `COORD_TABLE` | **Gone**: the table `coord_entries` |
| `PAYLOADS_BUCKET` | `BLOB_DIR=/data/blobs`, a Docker volume |
| `SES_REGION` | **Gone**: left unset, so the unused SES fallback can't be reached |
| `SMS_CONFIGURATION_SET` | Only while `SMS_PROVIDER` is `aws`; gone with Twilio |
| `EVOLUTION_API_URL` | `http://evolution:8080`, with `EVOLUTION_WEBHOOK_URL=http://web:8080/api` |
| `COST_REPORT_TO` | **Gone**: the server never sends the AWS cost email |
| The functions' IAM role | Until stage F only: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` of one IAM user limited to Cognito's calls on this pool and, while SMS is on AWS, sending texts and reading the SMS events queue (`SMS_EVENTS_QUEUE_URL`). Empty after it |

## New on the server

| Name | File | What |
| --- | --- | --- |
| `POSTGRES_PASSWORD`, `SYSTEM_DB_PASSWORD`, `APP_RLS_PASSWORD`, `EVOLUTION_DB_PASSWORD`, `MONITOR_DB_PASSWORD` | `postgres.env`, `owner.env`, `postgres-exporter.env` | Generated on the server, once; copies in the owner's password manager |
| `PGBACKREST_REPO1_S3_ENDPOINT`, `_BUCKET`, `_KEY`, `_KEY_SECRET` | `postgres.env` | The R2 bucket for backups, a token limited to that bucket |
| `PGBACKREST_REPO1_CIPHER_PASS` | `postgres.env` | Encrypts every backup before it leaves the server. Lost, the backups can't be read: a copy in the owner's password manager |
| `BACKUP_PING_URL`, `BACKUP_HOUR_UTC` | `postgres.env` | The outside check the nightly backup reports to |
| `TUNNEL_TOKEN` | `cloudflared.env` | The Cloudflare Tunnel |
| `TRUSTED_IP_HEADER` | `app.env` | `cf-connecting-ip`: the only header the client's address is read from |
| `SCHEDULES` | `.env` | `on` only on the live copy, from the cutover |
| `GF_SECURITY_ADMIN_PASSWORD`, `ALERT_EMAIL_TO`, `RESEND_SMTP_PASSWORD` | `monitoring.env`, `alerting.env` | Grafana's login; where alerts go |

`deploy.sh` and `render-monitoring.sh` refuse to run while any file still holds a `CHANGE_ME`
placeholder, and the app refuses to start in production with a test secret or a local `APP_URL`.

## Checks

- Before the cutover: `admin config` on the server lists every provider as configured, values hidden.
- After stage F: the AWS key lines are empty, and `node scripts/aws-dependency-scan.mjs --none-left`
  (PR #358) finds no AWS code left in the repository.
