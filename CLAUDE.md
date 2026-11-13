# bizinsights: notes for coding sessions

Conventions and layout: [docs/architecture.md](docs/architecture.md). The server's runbook:
[docs/ikorex-migration/PRODUCTION_DEPLOYMENT_GUIDE.md](docs/ikorex-migration/PRODUCTION_DEPLOYMENT_GUIDE.md).
AWS's (the frozen fallback): [docs/aws-deployment.md](docs/aws-deployment.md).

## Production runs on the iKorex server (since 2026-11-13)

The owner moved production off AWS on 2026-11-13 at 06:03 UTC. https://bizinsights.io now goes
Cloudflare → the tunnel `bizinsights` → the iKorex server (`deployer@103.146.112.176`, folder
`~/bizinsights`, Docker Compose with the low-memory limits of `infra/ikorex/docker-compose.lean.yml`).
The owner wants every finished change live there. The road:

1. Commit the change on your branch, push it and open a pull request to `main`.
2. Once CI is green, merge it.
3. Ship `main` to the server from the owner's PC, on a clean checkout of the merged commit:
   `infra/ikorex/scripts/ship.sh deployer@103.146.112.176`. The guide's "From a Windows PC" says how
   the SSH key is unlocked; the owner types its passphrase, never a session. `deploy.sh` on the
   server runs the migrations first, switches, checks health, and puts the previous release back if
   a check fails. Deploy to iKorex (`.github/workflows/ikorex-deploy.yml`) will do this step by
   itself once its deploy key is set up; until then nothing ships by itself.
4. The change is live only when `https://bizinsights.io/api/version` names the merged commit. Check
   it before saying so.

- **A merge alone is live nowhere.** Deploy to AWS (`.github/workflows/aws-deploy.yml`) is switched
  off in GitHub (the owner, 2026-11-13): after the move it reached no merchant and could only fail,
  its smoke test asking the public address for the Lambda release. Leave it off: a run that got to
  its migrate step would change the frozen database under AWS's old code. Turning it on again
  (`gh workflow enable aws-deploy.yml`) is a step of going back to AWS, and the owner's to ask for.
- **AWS is frozen, as the way back** ([ROLLBACK_PLAN.md](docs/ikorex-migration/ROLLBACK_PLAN.md))
  until the owner says otherwise: reserved concurrency 0 on `insights-production-api`, `-cron` and
  `-jobs`, the three EventBridge schedules disabled, the WhatsApp service at 0 tasks, GitHub
  variables `AWS_SCHEDULES=off` and `AWS_WHATSAPP=off`. Its database holds the data as of the
  switch. Don't undo any of it and don't write to RDS: two live copies would refresh the same
  Shopify tokens and fight over the WhatsApp sessions.
- The server is shared and small (about 2.5 GB was free for bizinsights), with no monitoring
  stack and no uptime check yet: say so before a change that leans on either. Its database is
  backed up to an S3 bucket (nightly, the log continuously; the guide says where the passphrase is).
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
- Don't `cdk deploy` anything by hand: AWS is frozen (above).
- A schema change ships with its migration (CI checks they match); `deploy.sh` applies it on the
  server before the new release starts.
- Not ready for merchants yet? Merge it behind a flag in `apps/web/src/lib/features.ts` rather
  than keeping it off `main`.
