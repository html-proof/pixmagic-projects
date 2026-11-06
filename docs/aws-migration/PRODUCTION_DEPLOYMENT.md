# AWS cost reduction: getting each change into production

Production is deployed one way only: a pull request to `main`, green CI, merge, and the **Deploy
to AWS** workflow (`.github/workflows/aws-deploy.yml`), which runs the unit tests, `cdk deploy
--all`, the database migrations and the smoke tests, and rolls back if any fail. The full runbook is
[../aws-deployment.md](../aws-deployment.md); this page only says which changes from
[AWS_MIGRATION_PLAN.md](AWS_MIGRATION_PLAN.md) go that way and which are the owner's clicks.

| # | Change | Path to production | Live when |
| --- | --- | --- | --- |
| 1 | Support plan → Basic | Owner, AWS console (root) | The console shows Basic |
| 2 | Reserved instance | Owner, AWS console or `aws rds purchase-reserved-db-instances-offering` | `describe-reserved-db-instances` says `active` (not `payment-failed`) |
| 3 | X-Ray off | Pull request (`infra/cdk/lib/app-stack.ts`) | Its Deploy succeeded |
| 4 | GuardDuty Advanced RDS off | Owner, GuardDuty console (not in CDK: GuardDuty was turned on by hand) | `get-detector` shows `RDS_DATA_RISK` `DISABLED` |
| 5 | WhatsApp on Spot | Pull request (`infra/cdk/lib/config.ts`) | Its Deploy succeeded and the ECS service runs on `FARGATE_SPOT` |
| 6 | WAF → Cloudflare | Owner in Cloudflare (rules), then three pull requests | Each Deploy succeeded; the third removes the web ACL |
| 7 | Secrets → SSM | Pull request(s) | Its Deploy succeeded |
| 8 | Database single-AZ | Pull request (`config.ts`), merged alone | Its Deploy succeeded and RDS shows `MultiAZ: false` |
| 9 | One NAT instance | Pull request (`config.ts`), merged alone | Its Deploy succeeded |

## After each change

1. The Deploy run is green (for code changes), and `https://bizinsights.io/api/readyz` answers 200.
2. The feature the change touches still works: for 5, the WhatsApp page shows connected numbers;
   for 6, sign-in, a Shopify webhook delivery and the pixel; for 8 and 9, a manual Shopify sync.
3. Two or three days later, the daily cost email (07:00 Melbourne) shows the line gone or lower.
   Cost Explorer runs a day behind.
4. [MIGRATION_STATUS.md](MIGRATION_STATUS.md) gets the date and the measured before and after.

## Order

Change 4 has a deadline (~2026-11-15) and change 1 a start date (~2026-11-14). The rest can go in
any order, one pull request at a time; 8 and 9 never in the same Deploy as anything else.
