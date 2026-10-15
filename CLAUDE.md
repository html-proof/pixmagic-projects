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
- Don't `cdk deploy` the App stack by hand from a branch: the next `main` deploy replaces it.
- A schema change ships with its migration (CI checks they match); the deploy applies it.
- Not ready for merchants yet? Merge it behind a flag in `apps/web/src/lib/features.ts` rather
  than keeping it off `main`.
