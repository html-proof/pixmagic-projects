# Migration test report

What has been tested, how, and with what result. Only runs that happened are recorded here; a
criterion with no run says so. Newest first.

## 2026-11-06: stage A (the self-hosted runtime), on the owner's PC

Branch `claude/ikorex-selfhost-runtime`. PostgreSQL 18 (a throwaway local cluster; production will
run 17.11), Node 24, Windows 11. Docker's engine was not running on the PC (starting it would also
start the old deployment's database container), so the images and the Compose stack were validated,
not run.

| Test | What it shows | Result |
| --- | --- | --- |
| `apps/aws` test suite (`vitest run`), with the PostgreSQL suite enabled | The whole package, including the refactored Lambda entry (`index.ts` → `actions.ts`) and local server | **12 files, 105 tests passed** |
| `test/selfhostPg.test.ts` (13 tests, own throwaway database) | Queue: delay, receive count, ack, retry, hold lapses and is taken over (old holder can't ack), 10 parallel claimers never share a job, runner outcomes (ack, retry, unsettled), dead-letter after 10 receives, listing without bodies, redrive, a job that throws, a job past its time limit, holds given back at stop, dead-job pruning. Coordinator: fixed window, take-once, expiry, one lock holder among 8 racing, prune, DynamoDB import. Schedules: one claim per tick, lease and attempt cap, two workers run a tick once, failed run recorded | **13 passed** |
| `test/selfhost.test.ts` (16 tests) | Cron reading incl. 07:00 Melbourne on both sides of daylight saving; blob folder incl. 7 keys that try to leave it; request router: client IP only from a valid `CF-Connecting-IP`, spoofed `x-insights-*` and `x-origin-verify` dropped, geo format, body limit, health; settings (missing names listed without values, `/api` address, commit, Cognito keys); admin arguments; queue concurrency; Prometheus text format | **16 passed** |
| All 65 migrations on an empty database, then `prisma migrate diff --exit-code` (CI's check) | The new migration applies after the others and matches `schema.prisma` | **Applied; diff exit 0** |
| Grants after `init.sql` | The tenant role can't read the four new tables; the system role can write them | **app_rls SELECT: false ×4; app_system INSERT: true ×4** |
| Bundle smoke test: `build-server.mjs`, then `node server.mjs web` and `node server.mjs worker` against the migrated database, production mode, random throwaway secrets | `/__health` 200; the UI served; `/api/version` names the commit; `/api/readyz` 200 with database, coordinator and tenant database ok; `/api/me` 401 without a session; web metrics count requests; the worker ran the every-15-minutes tick once against the database and recorded its result; a queued email job claimed and acked; worker metrics show queue depth and job outcomes | **11 of 11 passed** |
| The same, before fixes | Production's guards refused test secrets and a local `APP_URL` (as they should); with code splitting the bundle looked for the UI in the wrong folder (fixed: no splitting) | Found and fixed |
| `admin.mjs` against the same database | `queues`, `dlq`, `counts`, `migrate` (idempotent: 0 applied of 65) answer; `redrive` without a queue and an unknown command exit 1 with a message | **6 of 6 as expected** |
| `docker compose config` on both Compose files (with the example env files) | Valid Compose; services: postgres, backup, web, cloudflared, evolution, worker, admin; monitoring: prometheus, alertmanager, grafana, node-exporter, postgres-exporter (+ loki, alloy in the logs profile) | **Valid** |
| YAML parse of every config; `bash -n` on every script | Syntax | **All ok** |
| `eslint` (apps/aws, packages/db), `tsc --noEmit` (apps/aws, packages/db), import-cycle check | Lint, types | **Clean; no cycles in 826 modules** |

**Not run yet**, and where it will be: the images built and the stack started (stage B, on the
server); pgBackRest archiving, backup and the restore test (stage C, needs the bucket); the browser
e2e suite against the self-hosted server (stage B); graceful stop on SIGTERM inside Docker (Windows
can't deliver SIGTERM; the unit tests cover the runner's stop); a load test (stage B, before any
capacity claim); everything that touches production (stages D-F).

## Acceptance criteria (the brief's 22)

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Every AWS dependency migrated or justified | Justified in [AWS_INVENTORY.md](AWS_INVENTORY.md); migration not done |
| 2 | bizinsights runs on iKorex | Not yet (stage B) |
| 3 | Customer accounts accessible | Not yet (stage D) |
| 4 | Shopify OAuth works | Not yet (stage B/D) |
| 5 | Shopify sync works | Code path: the queue runs the same handlers (tested above); on the server: not yet |
| 6 | Meta Ads works | Not yet |
| 7 | Google Ads works | Not yet |
| 8 | WhatsApp automation works | Not yet (the `evolution` service is configured, not run) |
| 9 | Email delivery works | Not yet on the server (Resend, unchanged) |
| 10 | Internal notifications work | Not yet on the server |
| 11 | Background queues work | **Code tested against PostgreSQL** (above); on the server: not yet |
| 12 | Scheduled jobs work | **Code tested** (a real tick ran in the smoke test); on the server: not yet |
| 13 | File uploads and downloads work | Blob store tested (above); there are no customer file uploads in the app |
| 14 | Customer permissions work | Unchanged code and database roles; not yet tested on the server |
| 15 | Historical analytics intact | Not yet (stage D: row counts table by table) |
| 16 | Backups and restore tested | Scripts written; not yet run (stage C) |
| 17 | Monitoring and alerting work | Configured; not yet run (stage C) |
| 18 | No cross-tenant leakage | The new tables carry no tenant data and the tenant role has no rights on them (checked); row-level security unchanged; on the server: not yet |
| 19 | Existing iKorex websites keep working | Not yet (nothing has run on the server) |
| 20 | n8n and the CCTV tunnel keep working | Not yet |
| 21 | Rollback documented and tested | Documented ([ROLLBACK_PLAN.md](ROLLBACK_PLAN.md)); `deploy.sh`'s automatic rollback not yet run |
| 22 | Unused AWS resources decommissioned | Not yet (stage F, owner's approval) |
