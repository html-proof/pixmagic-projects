# Migration test report

What has been tested, how, and with what result. Only runs that happened are recorded here; a
criterion with no run says so. Newest first.

## 2026-11-07: Deploy to iKorex (the GitHub workflow), on the owner's PC

Branch `claude/ssh-key-ikorex-server-663aff`, on top of the database copy's (below). Git Bash, Node 24,
Windows 11; no server (SSH still waits for the administrator), so ssh, Docker and `deploy.sh` are
stand-ins that record how they were called. What it is: [PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md#deploy-to-ikorex-github-actions).

| Test | What it shows | Result |
| --- | --- | --- |
| `apps/aws/test/ikorexShip.test.ts` (17 tests) | `ship.sh pack` puts the bundle under `releases/<tag>/server` and `infra/ikorex` as committed at the top, never `env/*.env`, `.env` or the two rendered alert files, and refuses a checkout with changes; `ship.sh send` with the deploy key sends `receive` then `deploy` through the gate, with the config file and the pinned host key, and the server's `env/app.env` is untouched; the same with the owner's key as shell commands; another commit's release and an unknown project refused; the gate refuses an interactive login, a shell, other commands, other projects, bad tags, a `;` or `$( )` or a fourth word or a second line (nothing runs, nothing is created), keeps the server's settings whatever the archive holds, and deploys only a release it has received | **17 passed** (the first run found the archive carried an empty `infra/ikorex/` folder entry, as `ship.sh` did before: now only committed files go) |
| Git Bash's ssh with the workflow's files | A key file and ssh_config in a temporary folder, the host key file by its Windows path: the key is loaded and offered and the host key checked (against github.com, so as not to spend one of the iKorex server's five failed logins) | **Works** |
| The secret as written to the key file | A private key pasted with CRLF and a trailing newline still loads (`ssh-keygen -y`) | **Works** |
| `infra/runner/main-only-hook.js` | `ikorex-deploy.yml` from main on `workflow_run` allowed, as `aws-deploy.yml`; another workflow, or a push event, refused | **As intended** |
| The workflow file | Parses (js-yaml); its jobs, conditions and steps are as written | **Parses** (no actionlint on the PC; GitHub's own check is the first push) |
| `apps/aws` suite, `tsc --noEmit`, `eslint` | Nothing else moved | **13 files passed** (121 tests); `copyDb.test.ts` can't load without a PostgreSQL URL on this PC (CI gives it one); clean |

Not run: the workflow itself (it is off until the setup is done) and anything on the server.

## 2026-11-07: the database copy and the security audit, on the owner's PC

Branch `claude/ikorex-db-copy-security`. PostgreSQL 18.6 (a throwaway local cluster), Node 24, Git
Bash, Windows 11; Docker's CLI only (its engine not running). Details:
[DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md), [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

| Test | What it shows | Result |
| --- | --- | --- |
| `apps/aws/test/copyDb.test.ts` (6 tests) | `copy-db.sh` on the real schema (65 migrations, 155 tables, 149 under row-level security, 293 policies) and a database owned by its own role: the dump's counts are its snapshot's while inserts keep arriving (3,037 rows in the snapshot, 14,467 live by the end); the restore equals the snapshot table by table, row-level security and policies included, the second database's tables owned by its role; refusals (wrong checksum before any change, a target with tables, another session connected); the rehearsal's databases dropped | **6 passed** |
| `infra/ikorex/scripts/copy-db-lib.test.mjs` (8 tests) | The pinned host key's fingerprint is the guide's; settings can't break out of their quotes; the comparison catches a missing, extra or different table, lost row-level security, a changed policy; the admin host's script carries no password | **8 passed** |
| `apps/aws/test/ikorexCompose.test.ts` (8 tests) | What `docker compose config` makes of both projects (14 services, every profile): no published port, host network or privileged container; every capability dropped, `postgres` given back its entrypoint's five; memory and CPU limits on all; the Docker socket only in the optional log collector, read-only; `deploy.sh` and `render-monitoring.sh` refuse `CHANGE_ME` placeholders | **8 passed** (the capability test fails on the files before this change) |
| `infra/cdk` tests | The admin host may write under `db-export/*` only; that prefix expires in a day | **184 passed** |
| `apps/aws` suite with PostgreSQL, `tsc --noEmit`, `eslint` | Nothing else moved | **14 files, 123 tests passed; clean** |

Not run: anything on AWS or the server (the AWS session had expired; SSH waits for the
administrator). The copy's first real run is the stage B rehearsal.

## 2026-11-07: stage A live on AWS; the SMS events bridge

Stage A (#348) merged as `b7e9ef3e`; its Deploy to AWS passed (unit tests, `cdk deploy`, the
migration `20261106120000_selfhost_runtime` on RDS, smoke tests): `/api/version` reports that commit
as release 167 and `/api/readyz` answers 200. On AWS it added four empty tables and moved the
maintenance actions into `actions.ts`; nothing else changed there.

Then, with SMS kept on AWS (decision 3), `apps/aws/src/sqsBridge.ts`: the worker long-polls the
`smsEvents` SQS queue into its own queue.

| Test | What it shows | Result |
| --- | --- | --- |
| `test/selfhost.test.ts`, 4 new tests | The queue URL's region read, and anything not an SQS URL refused (incl. a look-alike host); events moved into the local queue, then the batch deleted from SQS (unreadable bodies dropped and deleted); nothing deleted when the local queue refuses an event, so SQS hands it out again; polling continues after failed reads and stops when asked | **20 of 20 passed** |
| `apps/aws` suite without PostgreSQL | Nothing else moved | **96 passed** (the 13 PostgreSQL tests skipped: no local cluster this time; the bridge doesn't touch PostgreSQL beyond the existing `send`) |
| `tsc --noEmit`, `eslint` (apps/aws) | Types, lint | **Clean** |
| `build-server.mjs --skip-web` (stand-in UI page) | The bundle builds with the bridge in it | **Built** |
| Alert rules parsed | `SmsEventsUnread` added | **16 rules** |

Not run: a read of the real queue (the AWS session had expired; it runs at the cutover, when
`SCHEDULES=on` starts it).

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
| 15 | Historical analytics intact | The copy and its table-by-table check tested against PostgreSQL ([DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md)); against RDS: not yet (stage B rehearsal, stage D) |
| 16 | Backups and restore tested | Scripts written; not yet run (stage C) |
| 17 | Monitoring and alerting work | Configured; not yet run (stage C) |
| 18 | No cross-tenant leakage | The new tables carry no tenant data and the tenant role has no rights on them (checked); the copy carries every table's row-level security and policies unchanged (tested); on the server: not yet |
| 19 | Existing iKorex websites keep working | Not yet (nothing has run on the server) |
| 20 | n8n and the CCTV tunnel keep working | Not yet |
| 21 | Rollback documented and tested | Documented ([ROLLBACK_PLAN.md](ROLLBACK_PLAN.md)); `deploy.sh`'s automatic rollback not yet run |
| 22 | Unused AWS resources decommissioned | Not yet (stage F, owner's approval) |
