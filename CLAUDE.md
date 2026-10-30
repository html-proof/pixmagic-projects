# bizinsights: notes for coding sessions

Conventions and layout: [docs/architecture.md](docs/architecture.md). AWS runbook:
[docs/aws-deployment.md](docs/aws-deployment.md).

## Every finished change goes live on AWS

The owner wants every change made to this project live on AWS
(https://bizinsights.io, CloudFront `d2mr8m2p1qkh58.cloudfront.net`). The one road there is GitHub `main`:

1. Commit the change on your branch, push it and open a pull request to `main`.
2. Once CI is green, merge it. **Deploy to AWS** (`.github/workflows/aws-deploy.yml`) then runs by
   itself on the merge commit: unit tests, `cdk deploy --all`, database migrations, smoke tests, and
   a rollback to the previous Lambda versions if any of that fails.
3. The change is live only when that Deploy run succeeded. Check it before saying so.

- Work left on a local branch or uncommitted in a worktree never reaches AWS.
- A change of only Markdown files or `docs/` starts no CI run and no Deploy: there is nothing to
  ship, and its merge is done once it is on `main`.
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
- Don't `cdk deploy` the App stack by hand from a branch: the next `main` deploy replaces it.
- A schema change ships with its migration (CI checks they match); the deploy applies it.
- Not ready for merchants yet? Merge it behind a flag in `apps/web/src/lib/features.ts` rather
  than keeping it off `main`.
