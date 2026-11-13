# bizinsights: notes for coding sessions

Conventions and layout: [docs/architecture.md](docs/architecture.md). The server's runbook:
[docs/ikorex-migration/PRODUCTION_DEPLOYMENT_GUIDE.md](docs/ikorex-migration/PRODUCTION_DEPLOYMENT_GUIDE.md).
What is left in AWS and why: [docs/ikorex-migration/LEAVING_AWS.md](docs/ikorex-migration/LEAVING_AWS.md).
[docs/aws-deployment.md](docs/aws-deployment.md) describes the AWS setup as it was; most of it is deleted.

## Production runs on the iKorex server (since 2026-11-13)

The owner moved production off AWS on 2026-11-13 at 06:03 UTC. https://bizinsights.io now goes
Cloudflare → the tunnel `bizinsights` → the iKorex server (`deployer@103.146.112.176`, folder
`~/bizinsights`, Docker Compose with the low-memory limits of `infra/ikorex/docker-compose.lean.yml`).
The owner wants every finished change live there. The road:

1. Commit the change on your branch, push it and open a pull request to `main`.
2. Once CI is green, merge it.
3. Deploy to iKorex (`.github/workflows/ikorex-deploy.yml`) ships it by itself: when CI's run on
   `main` passes for the merged commit, it sends the release to the server with a deploy-only key
   and runs `deploy.sh` there, about two minutes in all. `deploy.sh` runs the migrations first,
   switches, checks health, and puts the previous release back if a check fails. It is on while
   the repository variable `IKOREX_PRODUCTION` is `on` (the owner, 2026-11-13); a grey, skipped
   run means it is off, and switching it is the owner's to ask for.
4. The change is live only when `https://bizinsights.io/api/version` names the merged commit. Check
   it before saying so.

- **A merge is live only once the server names it.** A merge of only Markdown or `docs/` starts
  no CI run on `main`, so nothing deploys and `/api/version` keeps naming the last commit that
  did. The workflow never touches the server's `env/` files: a change that needs a setting there
  still needs that step by hand. And it never puts an older commit over a newer one, so going
  back is a ship by hand.
- **By hand, when GitHub can't**: `infra/ikorex/scripts/ship.sh deployer@103.146.112.176` from the
  owner's PC, on a clean checkout of the commit. The guide's "From a Windows PC" says how the SSH
  key is unlocked; the owner types its passphrase, never a session. `deploy.sh` holds a lock, so
  a ship and a workflow run that meet go one after the other, but look first:
  `gh run list --workflow ikorex-deploy.yml --limit 1`.
- Deploy to AWS (`.github/workflows/aws-deploy.yml`) is switched
  off in GitHub (the owner, 2026-11-13) and has nothing left to deploy to. Leave it off.
- **There is no way back to AWS.** The owner had AWS's side deleted the same day (from 07:14 UTC:
  the App stack with the functions, queues and CloudFront, then the rest), after a last dump of
  its database was put on the server (`~/bizinsights-archive/rds-final-20261113/`). Production
  uses nothing in that account any more. **Sign-in** is the app's own (`AUTH_MODE=local` on the
  server since 2026-11-13, Google through the app's own Google client); what is left of Cognito
  there is the owner's to have deleted. **The backups** left the account's bucket the same day
  (below); the bucket, the IAM user `bizinsights-backups` and the parameter
  `/bizinsights/ikorex/backup-cipher-pass` are no longer read or written by the server.
- **The backups are on the server's own disk, and nowhere else** (the owner's choice,
  2026-11-13, over Cloudflare R2 and over keeping the bucket, told that losing the server then
  loses the database and every backup together). pgBackRest writes the nightly backups and the
  continuous log, encrypted, to the Docker volume `pgbackups`; a restore test runs after
  Sunday's full backup. So **never `docker compose down -v`, never prune volumes, never delete
  `pgbackups` or `pgdata` on that server**: either one takes the data or its only backups.
  Don't offer a copy off the server again unless the owner raises it; if they do, the guide's
  "Backups" says how a second repository is added.
- The server is shared and small (about 2.5 GB was free for bizinsights), with no monitoring
  stack: say so before a change that leans on one. What watches it: the Uptime check workflow
  (`.github/workflows/uptime.yml`, every 10 minutes from GitHub; a failed run emails the owner),
  so a ship that keeps the site down for more than about 30 seconds turns a run red. Nothing
  watches the nightly backup: a failure shows only in `docker compose logs backup`.
- Work left on a local branch or uncommitted in a worktree never reaches the server.
- A change of only Markdown files or `docs/` has nothing to ship: its merge is done once it is on
  `main`. Its pull request still runs CI for about a minute (the first job finds nothing to test
  and the other two skip), so its checks report.
- GitHub-hosted minutes are scarce (Free plan). A pull request runs the browser tests only when it
  touches what they drive (`.github/workflows/ci.yml` says what); add the label `e2e` and push
  again to run them anyway. Merge a pull request whose last run is green on top of the current
  `main` and the push to `main` skips the jobs that already passed on that code (Markdown and
  `docs/` don't count).
- A push to a pull request doesn't cancel its run in progress. If the next run would test the same
  code (the push changed only Markdown or `docs/`, or merged in the `main` the run tests), the run
  finishes and the next run skips what it passed: such a push is free mid-run. A push that changes
  the code stops the old run within a minute, and that run's Annotations name a file.
- The integration tests run only when one of the paths they read changed (list in `ci.yml`, step
  "What the integration tests read"). A test of `apps/api`/`apps/worker` that starts reading a file
  outside that list needs it added there, or a change to that file won't re-run them.
- Holding an open pull request (another one needs the runner first, or it has to land after
  another)? Make it a draft: `gh pr ready <n> --undo`. Its CI stops and its checks show as skipped;
  `gh pr ready <n>` runs them again. Never `gh run cancel` it: a cancelled run shows as failing
  checks, and the owner reads those as broken work.
- Don't `cdk deploy` anything: the stacks are deleted, and a deploy would build them again.
- A schema change ships with its migration (CI checks they match); `deploy.sh` applies it on the
  server before the new release starts.
- Not ready for merchants yet? Merge it behind a flag in `apps/web/src/lib/features.ts` rather
  than keeping it off `main`.
