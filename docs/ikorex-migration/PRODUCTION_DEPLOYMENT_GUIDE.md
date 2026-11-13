# Running bizinsights on the iKorex server

How to set up, deploy, operate and roll back the self-hosted runtime
([IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md)). **Nothing here has
been run on the server yet** (no SSH access on 2026-11-06); the steps are stage B's checklist, and
each gets its evidence in [MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md) when it runs.

The files: `infra/ikorex/` (Compose files, images, scripts, monitoring) and the runtime in
`apps/aws/src/` (`selfhost.ts`, `server.ts`, `admin.ts`, `pgQueues.ts`, `schedules.ts`, `pgCoord.ts`,
`fsBlobs.ts`, `metrics.ts`).

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
| An IAM user `bizinsights-ikorex`, until stage F, with only: Cognito's password check and admin actions on the pool (`AUTH_MODE=migrating`) | AWS IAM | `env/app.env` `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |

**Backups as they run since 2026-11-13** (the owner's choice that day, instead of R2 for now): an S3
bucket in the AWS account, `bizinsights-backups-<account>` in ap-southeast-2 (private, encrypted,
TLS only, versioned: what the server's key deletes or overwrites stays 14 more days), and an IAM
user `bizinsights-backups` that can only list that bucket and read, write and delete its objects.
`env/postgres.env` holds the endpoint `s3.ap-southeast-2.amazonaws.com`,
`PGBACKREST_REPO1_S3_REGION=ap-southeast-2`, `PGBACKREST_REPO1_S3_URI_STYLE=host`, the key and the
passphrase. The owner's copy of the passphrase is the encrypted parameter
`/bizinsights/ikorex/backup-cipher-pass` in AWS Systems Manager Parameter Store: **copy it into a
password manager before the AWS account closes**, and move the backups to R2 (a new stanza there)
at stage F, since the bucket goes with the account. No backup ping is set (`BACKUP_PING_URL`): a
night's failure shows only in `docker compose logs backup` until a check exists.

**The uptime check as it runs since 2026-11-13:** the workflow Uptime check
(`.github/workflows/uptime.yml`) runs `infra/uptime/check.mjs` every 10 minutes on GitHub's own
machines, outside the server and outside AWS. It asks `https://bizinsights.io/api/readyz` and
`/login`, looks again after 30 seconds when either is wrong, and fails the run if it still is.
GitHub emails a failed scheduled run to whoever last changed the workflow's schedule (the owner's
account; GitHub → Settings → Notifications → Actions decides whether by email). No account, key or
address is stored anywhere for it. It is free while the repository is public. By hand, also to see
a failure: Actions → Uptime check → Run workflow, with an address that doesn't answer 200. It
stands in for the table's UptimeRobot row; the backup ping is still missing.

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

`infra/ikorex/scripts/setup-env.sh` does the copying, the passwords and the merge in one go, and
prints names and counts only (how the staging copy was set up on 2026-11-13). After the two
`export-env.mjs` commands above:

```bash
ssh deployer@103.146.112.176 'bash -s -- bizinsights-staging https://staging.bizinsights.io' < infra/ikorex/scripts/setup-env.sh
```

**A server short of memory.** The limits in `docker-compose.yml` add up to about 6 GB, for a server
with 8 GB or more. The iKorex server has 3.9 GB with about 2.5 GB free
([SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md)), and the owner decided on 2026-11-13 to run
bizinsights there as it is. `docker-compose.lean.yml` puts smaller limits on the same containers:
2,432 MB for everything that stays running, so bizinsights at its worst takes what was free and
the server's other tenants keep theirs. The server's `.env` chooses it (`setup-env.sh` writes
these):

```
COMPOSE_FILE=docker-compose.yml:docker-compose.lean.yml
ARCHIVE_MODE=off
```

`ARCHIVE_MODE=off` is only for a copy with no backup bucket in `env/postgres.env`: without it
PostgreSQL keeps every write-ahead log file for a bucket that isn't there, until the disk is full.
Remove that line when the bucket is set, and restart `postgres`. With these limits two full copies
don't fit side by side: stop staging (`docker compose -p bizinsights-staging stop`) before
production starts. Monitoring (`docker-compose.monitoring.yml`, another 1.5 GB of limits) doesn't
fit either; the external checks in the table above stand in for it.

**From a Windows PC.** `ship.sh` sends the working copy, so `infra/ikorex/**` is pinned to Unix line
endings (`.gitattributes`). `ssh` asks for the key's passphrase at every connection unless an agent
holds the key; Git Bash's own agent works without changing Windows' services:
`ssh-agent -a ~/.ssh/bizinsights-agent.sock -t 6h`, then `ssh-add` with
`SSH_ASKPASS=/mingw64/bin/git-askpass.exe SSH_ASKPASS_REQUIRE=force` (Git's passphrase window; the
desktop app's terminal doesn't pass typing to `ssh-add`), and `ship.sh` with `SHIP_SSH=/usr/bin/ssh`
and a `SHIP_SSH_CONFIG` file naming that agent (`IdentityAgent`).

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

## Deploy to iKorex (GitHub Actions)

`.github/workflows/ikorex-deploy.yml` deploys `main`'s commits by itself once CI has passed on them,
like Deploy to AWS: to staging while the repository variable `IKOREX_STAGING` is `on`, then to
production while `IKOREX_PRODUCTION` is `on` (from the cutover). **Both are off until the setup below
is done**, and until then every run skips (grey, not red). By hand: Actions → Deploy to iKorex → Run
workflow, from `main`, target staging or production (its variable must be on too).

It runs `ship.sh` in two halves. The `build` job installs every dependency and runs
`ship.sh pack` (the bundle with the UI, and `infra/ikorex` as committed); it never sees the key. The
`deploy` job installs nothing, gets the key, and runs `ship.sh send` to staging and then, only if
staging passed, to production. On the server `deploy.sh` does what it does by hand: migrations
first, then the switch, the health checks, and the previous release back if any check fails.

The key is not the owner's. It is a key of its own, kept only in GitHub's secret, so the owner's key
(with its passphrase) never leaves the PC ([SECURITY_AUDIT.md](SECURITY_AUDIT.md), D13). On the
server its line in `authorized_keys` runs nothing but `scripts/ssh-gate.sh`: `receive` a release,
`deploy` it, for `bizinsights` or `bizinsights-staging`. No shell, terminal, port forwarding or agent
(`restrict`), and every other request refused and logged. That is not a sandbox: a release is code
that runs under Docker, and Docker is root on the host (the audit's O1). The gate stops a stolen key
from quietly opening a shell or a tunnel, not from deploying. So the key lives in one place, only the
`deploy` job gets it, and deleting its line on the server revokes it.

Setup, once, after the first deploy by hand above has worked (stage B). In Git Bash on the PC:

1. The key. No passphrase: the runner uses it unattended.

   ```bash
   ssh-keygen -t ed25519 -N "" -C bizinsights-deploy -f ~/ikorex-deploy-key
   ```

2. **The administrator's OK** for a second key on `deployer`, limited to the gate. Send them the line
   step 3 adds and its fingerprint (`ssh-keygen -lf ~/ikorex-deploy-key.pub`).
3. The gate, then the key's line, with the owner's own key (the passphrase is asked for):

   ```bash
   ssh deployer@103.146.112.176 'mkdir -p ~/bin && cat > ~/bin/bizinsights-ssh-gate && chmod 755 ~/bin/bizinsights-ssh-gate' < infra/ikorex/scripts/ssh-gate.sh
   ```

   ```bash
   (printf 'restrict,command="$HOME/bin/bizinsights-ssh-gate" '; cat ~/ikorex-deploy-key.pub) | ssh deployer@103.146.112.176 'umask 077; cat >> ~/.ssh/authorized_keys'
   ```

   The installed gate doesn't update itself: run the first command again whenever `ssh-gate.sh`
   changes.
4. GitHub: the environment `ikorex`, its secret, and the private key gone from the PC:

   ```bash
   gh api -X PUT repos/html-proof/pixmagic-projects/environments/ikorex
   ```

   ```bash
   gh secret set IKOREX_SSH_KEY --env ikorex < ~/ikorex-deploy-key
   ```

   ```bash
   rm ~/ikorex-deploy-key
   ```

5. Staging on, and a first run by hand. The run's "Deploy to staging" step shows `deploy.sh`'s log:

   ```bash
   gh variable set IKOREX_STAGING --body on
   ```

   ```bash
   gh workflow run ikorex-deploy.yml --ref main -f target=staging
   ```

6. At the cutover (stage D, step 6): `gh variable set IKOREX_PRODUCTION --body on`.

The host and user are the guide's (`deployer@103.146.112.176`); the variable `IKOREX_SSH_TARGET`
(`user@host`) changes them. The host key is always the pinned one in `infra/ikorex/known_hosts`.
The workflow runs on the runner Deploy to AWS uses: the runner for main if there is one
(`SELF_HOSTED_MAIN_RUNNER`), otherwise the PC's shared one. The runner for main's hook
(`infra/runner/main-only-hook.js`) lets this workflow through too. No runner for main was
installed on 2026-11-07. One installed later from this commit gets the new hook; one installed
before it needs the file copied again into `C:\ProgramData\bizinsights-runner` (elevated PowerShell).

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
| Who still signs in through Cognito (counts) | `docker compose --profile admin run --rm admin sign-in-move` ([LEAVING_AWS.md](LEAVING_AWS.md#sign-in-off-cognito)) |
| Backups in the bucket | `docker compose exec backup pgbackrest --stanza=bizinsights info` |
| Restore test now | `docker compose exec backup restore-test.sh` |
| Turn schedules on (production, at the cutover) | `sed -i 's/^SCHEDULES=.*/SCHEDULES=on/' .env && docker compose up -d worker` |
| Turn schedules off (first step of a copy back to AWS, [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md#the-copy-back-de-after-writes-on-ikorex)) | `sed -i 's/^SCHEDULES=.*/SCHEDULES=off/' .env && docker compose up -d worker` |

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

It refuses while any AWS queue but the dead-letter queue holds a message, stops `web`, `worker` and
`evolution` on the server, and ends with `admin migrate` and the comparison again. Exit 1 means a
difference: the cutover stops there (ROLLBACK_PLAN.md). The report (counts only) is saved in
`C:\Users\Seban\insights-backups`; the dumps are deleted from the bucket.

## The cutover and the rollback period

Stages D-F, with their steps and the way back from each: [AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md)
("Cutover") and [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md). At the cutover CLAUDE.md's rule "every change
goes live on AWS" is rewritten for the server, and Deploy to iKorex's production target is switched
on (`IKOREX_PRODUCTION=on`, above).
