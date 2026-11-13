# infra/ikorex: bizinsights on the iKorex server

The self-hosted deployment, built for the move off AWS (docs/ikorex-migration). Not live yet: AWS
(`infra/cdk`) still runs production.

| Path | What |
| --- | --- |
| `docker-compose.yml` | The app: `web`, `worker`, `admin`, `postgres`, `backup`, `evolution`, `cloudflared`. No published port. |
| `docker-compose.lean.yml` | Smaller memory limits on the same containers, for a server short of memory (the iKorex server as it is: 2.5 GB free). Chosen in the server's `.env` with `COMPOSE_FILE` |
| `docker-compose.monitoring.yml` | Prometheus, Alertmanager, Grafana, exporters; Loki + Alloy in the `logs` profile |
| `Dockerfile` | The app image, from the bundle `apps/aws/scripts/build-server.mjs` makes |
| `postgres/` | PostgreSQL 17.11 + pgBackRest, its settings, the nightly backup and the weekly restore test. Where the backups go is `env/postgres.env`'s to say. Production since 2026-11-13: only the server's own disk (repo1 = the folder in the volume `pgbackups`, `PGBACKREST_REPO1_TYPE=posix`; the owner's choice, lost with the server). The files' default: a bucket off the server (repo1) and, when `PGBACKREST_REPO2_*` is set, a second copy in that folder (repo2): `backup-loop.sh` backs up into each, the write-ahead log goes to both, `RESTORE_TEST_REPO=2 restore-test.sh` tests the second |
| `evolution/start.sh` | The WhatsApp service's start (as `infra/cdk/lib/whatsapp-stack.ts`'s) |
| `monitoring/` | Scrape targets, alert rules, Alertmanager template, Grafana provisioning and dashboard, Loki, Alloy |
| `env/*.example` | Every setting and secret, by file; the real `env/*.env` live only on the server (git-ignored) |
| `scripts/ship.sh` | Build a commit here, send it, build the image on the server, deploy; or in two halves (`pack`, `send`), as Deploy to iKorex (`.github/workflows/ikorex-deploy.yml`) runs it |
| `scripts/ssh-gate.sh` | On the server: all the deploy key may run (`receive`, `deploy`); installed as `~/bin/bizinsights-ssh-gate` |
| `scripts/deploy.sh` | On the server: migrations, switch, health checks, automatic rollback |
| `scripts/render-monitoring.sh` | On the server: Alertmanager's file from its template |
| `scripts/export-env.mjs` | AWS's secrets straight into a file on the server, never on screen |
| `scripts/setup-env.sh` | On the server, once per project folder: the env files from their examples, a new password per database login, AWS's values merged in, `.env` with the low-memory limits |
| `scripts/copy-db.mjs`, `copy-db.sh`, `copy-db-lib.mjs`, `copy-db-run.mjs` | The database copy from RDS, checked table by table (`--rehearsal`, `--cutover`; docs/ikorex-migration/DATABASE_MIGRATION_REPORT.md) |
| `scripts/copy-db-back.mjs` | The copy back into RDS for a rollback, the same checks (`--rehearsal`, `--rollback --replace`; docs/ikorex-migration/ROLLBACK_PLAN.md) |
| `known_hosts` | The server's SSH host key, pinned: `ship.sh`, `copy-db.mjs` and `copy-db-back.mjs` connect only to it |

How to use them: docs/ikorex-migration/PRODUCTION_DEPLOYMENT_GUIDE.md.
