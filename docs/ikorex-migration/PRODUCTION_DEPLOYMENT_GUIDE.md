# Running bizinsights on the iKorex server

How to set up, deploy, operate and roll back the self-hosted runtime
([IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md)). **Nothing here has
been run on the server yet** (no SSH access on 2026-11-06); the steps are stage B's checklist, and
each gets its evidence in [MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md) when it runs.

The files: `infra/ikorex/` (Compose files, images, scripts, monitoring) and the runtime in
`apps/aws/src/` (`selfhost.ts`, `server.ts`, `admin.ts`, `pgQueues.ts`, `schedules.ts`, `pgCoord.ts`,
`fsBlobs.ts`, `metrics.ts`, `sqsBridge.ts`).

## Before anything: the owner and the server's administrator

1. **SSH key for this PC** (the guide's steps 2-4): `ssh-keygen -t ed25519`, send the `.pub` line to
   the administrator, read them the fingerprint by phone. The server's host key must be
   `SHA256:5whPPmUOtct7uImi8hLLqyVU5vv1j470FAfLI5Or+TA` (checked 2026-11-06).
2. **The administrator's agreement** to host bizinsights, after the capacity test
   ([SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md): `inspect-server.sh`, go / tight / no go).
3. Docker Engine 24+ with Compose v2 on the server (the inspection says whether it's there).

## One-time setup

Accounts and keys (owner, in each provider's console):

| What | Where | Goes into |
| --- | --- | --- |
| A tunnel named `bizinsights` | Cloudflare → Zero Trust → Networks → Tunnels → Docker | `env/cloudflared.env` `TUNNEL_TOKEN` |
| Public hostname `staging.bizinsights.io` → `http://web:8080` (staging project), behind a Cloudflare Access policy (owner's email) | the tunnel's Public Hostnames; Zero Trust → Access → Applications | — |
| Public hostname `grafana.bizinsights.io` → `http://grafana:3000`, behind Access | same | — |
| An R2 bucket `bizinsights-backups` and an API token (Object Read & Write, this bucket only) | Cloudflare → R2 | `env/postgres.env` `PGBACKREST_REPO1_*` |
| A backup passphrase (`openssl rand -base64 48`), also in the owner's password manager | — | `env/postgres.env` `PGBACKREST_REPO1_CIPHER_PASS` |
| Two checks: the nightly backup ping, and `https://bizinsights.io/api/readyz` every 5 minutes | healthchecks.io / UptimeRobot (free tiers) | `env/postgres.env` `BACKUP_PING_URL` |
| An IAM user `bizinsights-ikorex` with only: Cognito admin actions on the pool, `sms-voice:SendTextMessage` (and what `smsProvider.ts` reads), `sqs:ReceiveMessage` + `sqs:DeleteMessage` on the `insights-production-smsEvents` queue, `ce:GetCostAndUsage` | AWS IAM | `env/app.env` `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| The `smsEvents` queue's URL, `https://sqs.ap-southeast-2.amazonaws.com/<account>/insights-production-smsEvents` (also the `smsEvents` entry of the functions' `QUEUE_URLS`) | AWS | `env/app.env` `SMS_EVENTS_QUEUE_URL`, production only, read only once `SCHEDULES=on` |

On the server, as `deployer`, the project folder (nothing outside it is touched):

```bash
mkdir -p ~/bizinsights/env && chmod 750 ~/bizinsights && chmod 700 ~/bizinsights/env
```

The first `ship.sh` (below) brings `docker-compose.yml`, the scripts and `env/*.example`. Then fill
the env files from the examples (each line is explained there):

```bash
cd ~/bizinsights/env
for f in app owner postgres evolution cloudflared monitoring postgres-exporter alerting; do cp -n $f.env.example $f.env; done
chmod 600 *.env
```

- Passwords for the new database (`owner.env`, and the same values in `app.env`'s URLs,
  `evolution.env`, `postgres-exporter.env`): generate each once with `openssl rand -base64 32 | tr -d '/+='`.
- The app's secrets from AWS, straight into files on the server (never on screen), from the PC with
  `aws login` done:

  ```bash
  node infra/ikorex/scripts/export-env.mjs app | ssh deployer@103.146.112.176 "umask 077; cat > ~/bizinsights/env/app.env.from-aws"
  ```

  ```bash
  node infra/ikorex/scripts/export-env.mjs evolution | ssh deployer@103.146.112.176 "umask 077; cat > ~/bizinsights/env/evolution.env.from-aws"
  ```

  Merge them into `app.env` / `evolution.env` on the server, then delete the `.from-aws` files.

## Deploying a commit

From the repository, on a clean checkout of the commit (main in production):

```bash
infra/ikorex/scripts/ship.sh deployer@103.146.112.176
```

`ship.sh` connects only to the server's pinned host key (`infra/ikorex/known_hosts`, the fingerprint
in the administrator's guide), with Windows' own OpenSSH where there is one (it uses the Windows
ssh-agent; without the agent, the key's passphrase is asked for at each connection). It builds the
bundle, sends it and `infra/ikorex` (never `env/`, `.env` or the rendered alert files), builds the
image on the server and runs `scripts/deploy.sh <commit>` there. `deploy.sh` refuses to start while any
`env/*.env` still holds a `CHANGE_ME` placeholder; then PostgreSQL up, migrations (`admin migrate`) and
the WhatsApp database role (`admin evolution-db`) first, then `web` and `worker` on the new image,
health, `/api/readyz`, `/api/version`. A failure puts the previous image back and the run fails.

Staging is the same with the project name: `ship.sh deployer@103.146.112.176 bizinsights-staging`
(its own folder `~/bizinsights-staging`, its own env files and volumes; `SCHEDULES=off` always).

Monitoring, once:

```bash
cd ~/bizinsights && scripts/render-monitoring.sh && docker compose -f docker-compose.monitoring.yml up -d
```

## Everyday commands (on the server, in ~/bizinsights)

| Task | Command |
| --- | --- |
| What runs | `docker compose ps` |
| Logs | `docker compose logs --tail 200 web worker` |
| Queues | `docker compose --profile admin run --rm admin queues` |
| Dead jobs | `docker compose --profile admin run --rm admin dlq [queue]` |
| Retry them (after fixing the cause) | `docker compose --profile admin run --rm admin redrive <queue>` |
| Check a store against Shopify | `docker compose --profile admin run --rm admin shopify-check --shop <x>.myshopify.com` |
| Row counts | `docker compose --profile admin run --rm admin counts` |
| What is configured (names only) | `docker compose --profile admin run --rm admin config` |
| Backups in the bucket | `docker compose exec backup pgbackrest --stanza=bizinsights info` |
| Restore test now | `docker compose exec backup restore-test.sh` |
| Turn schedules on (production, at the cutover; also starts reading AWS's SMS events) | `sed -i 's/^SCHEDULES=.*/SCHEDULES=on/' .env && docker compose up -d worker` |

## Rolling back a release

`deploy.sh` does it by itself when a deploy fails its checks. By hand, to the previous commit:

```bash
cd ~/bizinsights && ls -1t releases | head -3
```

```bash
cd ~/bizinsights && scripts/deploy.sh <previous commit>
```

A release whose migration changed tables can only go back if the migration was expand-only (the
repository's rule for migrations: docs/architecture.md).

## Restoring the database

From the bucket into an empty volume (a lost server, or a bad write to undo), on any host with the
project's files and `env/postgres.env`:

```bash
docker compose stop web worker backup && docker compose stop postgres
```

```bash
docker compose run --rm --no-deps --user postgres --entrypoint pgbackrest postgres --stanza=bizinsights --delta restore
```

To a moment in time, add `--type=time "--target=2026-11-20 03:00:00+00" --target-action=promote`.
Then `docker compose up -d`, and check with `admin counts` and `/api/readyz`.

## Copying the database from RDS

From the owner's PC, signed in to AWS (`aws login`), with the SSH key ([DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md)
says what each step does and checks):

```powershell
node infra/ikorex/scripts/copy-db.mjs --rehearsal
```

The rehearsal (stage B) restores both databases into throwaway ones on the staging project's
PostgreSQL, compares them table by table with the snapshot it dumped, and drops them; AWS is only
read. In the cutover window, after cutover step 2 (schedules off, webhooks answered 503, queues
drained), the real copy replaces the server's `app` and `evolution`:

```powershell
node infra/ikorex/scripts/copy-db.mjs --cutover --replace
```

It refuses while any AWS queue but the SMS events holds a message, stops `web`, `worker` and
`evolution` on the server, and ends with `admin migrate` and the comparison again. Exit 1 means a
difference: the cutover stops there (ROLLBACK_PLAN.md). The report (counts only) is saved in
`C:\Users\Seban\insights-backups`; the dumps are deleted from the bucket.

## The cutover and the rollback period

Stages D-F, with their steps and the way back from each: [AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md)
("Cutover") and [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md). At the cutover CLAUDE.md's rule "every change
goes live on AWS" is rewritten for the server, and the GitHub workflow runs `ship.sh` from `main`.
