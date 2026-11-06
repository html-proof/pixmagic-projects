# infra/ikorex: bizinsights on the iKorex server

The self-hosted deployment, built for the move off AWS (docs/ikorex-migration). Not live yet: AWS
(`infra/cdk`) still runs production.

| Path | What |
| --- | --- |
| `docker-compose.yml` | The app: `web`, `worker`, `admin`, `postgres`, `backup`, `evolution`, `cloudflared`. No published port. |
| `docker-compose.monitoring.yml` | Prometheus, Alertmanager, Grafana, exporters; Loki + Alloy in the `logs` profile |
| `Dockerfile` | The app image, from the bundle `apps/aws/scripts/build-server.mjs` makes |
| `postgres/` | PostgreSQL 17.11 + pgBackRest, its settings, the nightly backup and the weekly restore test |
| `evolution/start.sh` | The WhatsApp service's start (as `infra/cdk/lib/whatsapp-stack.ts`'s) |
| `monitoring/` | Scrape targets, alert rules, Alertmanager template, Grafana provisioning and dashboard, Loki, Alloy |
| `env/*.example` | Every setting and secret, by file; the real `env/*.env` live only on the server (git-ignored) |
| `scripts/ship.sh` | Build a commit here, send it, build the image on the server, deploy |
| `scripts/deploy.sh` | On the server: migrations, switch, health checks, automatic rollback |
| `scripts/render-monitoring.sh` | On the server: Alertmanager's file from its template |
| `scripts/export-env.mjs` | AWS's secrets straight into a file on the server, never on screen |

How to use them: docs/ikorex-migration/PRODUCTION_DEPLOYMENT_GUIDE.md.
