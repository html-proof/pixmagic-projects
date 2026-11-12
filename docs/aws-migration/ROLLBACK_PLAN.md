# AWS cost reduction: rollback

How to undo each change in [AWS_MIGRATION_PLAN.md](AWS_MIGRATION_PLAN.md). The general mechanisms
are the runbook's ([../aws-deployment.md](../aws-deployment.md), "Roll back"):

- A Deploy whose CDK step, migrations or smoke test fail rolls itself back to the previous Lambda
  versions (`infra/cdk/scripts/rollback.mjs`). Nothing to do by hand.
- A change that deployed fine but turns out wrong: revert its pull request on `main`; the next
  Deploy puts the old configuration back. Re-running an old Deploy run is not a rollback (it can
  report "no changes" and leave the new state live).

| # | Change | How to undo | How long | Data at risk |
| --- | --- | --- | --- | --- |
| 1 | Support plan → Basic | Support Center → Support plans → choose the paid plan again | Minutes | None |
| 2 | Reserved instance | Can't be cancelled: it is a one-year commitment. It is size-flexible, so it still pays for half of a db.t4g.small Multi-AZ if the database grows | — | None |
| 3 | X-Ray off | Revert the pull request (`tracing: lambda.Tracing.ACTIVE`) | One Deploy | None (old traces expire anyway) |
| 4 | GuardDuty Advanced RDS off | GuardDuty console → Protection plans → RDS Protection → Advanced RDS on | Minutes | None; it re-learns the database's normal access |
| 5 | WhatsApp on Spot | `whatsapp.spot: false` in `config.ts`, pull request: the service moves to the `FARGATE` capacity provider (on demand) in place, and the forced deployment stops the Spot task and starts an on-demand one. Never put the `FARGATE` launch type back: CloudFormation would replace the service and fail on its name (tried 2026-11-06) | One Deploy; linked phones drop for a minute or two | None: sessions live in the `evolution` database |
| 6 | WAF → Cloudflare | Each of its three pull requests reverts on its own. Reverting the third brings the web ACL back; reverting the second opens the CloudFront name again. In an attack before the revert lands, Cloudflare's "Under Attack" mode works on the Free plan | One Deploy each | None |
| 7 | Secrets → SSM | Revert the step's pull request ([SECRETS_TO_PARAMETER_STORE.md](SECRETS_TO_PARAMETER_STORE.md), "Undoing a step"); keep the Secrets Manager secrets until step 1 has run a week, so the revert finds them. After step 3, `aws secretsmanager restore-secret` within its 30 days first | One Deploy | None while the secrets exist or can be restored; the parameters hold the same values |
| 8 | Database single-AZ | `dbMultiAz: true`, pull request. RDS adds a standby in the other zone without downtime | One Deploy, then ~30–60 min while RDS builds the standby | None |
| 9 | One NAT instance | `natGateways: 2`, pull request | One Deploy | None |

## Before each change

- The daily cost email gives the before figure; note it in [MIGRATION_STATUS.md](MIGRATION_STATUS.md).
- For changes 8 and 9: the Deploy replaces network routes and modifies the database. Merge them on
  their own, not with other changes, and not while another Deploy is running.
- Never delete the database, its automated backups or the three manual snapshots as part of any of
  these changes.
