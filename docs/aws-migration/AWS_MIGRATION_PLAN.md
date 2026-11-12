# AWS cost reduction: the plan (2026-11-06)

**In short.** The bill is about US$136 a month before GST (US$149 with it) once GuardDuty's trial
ends, against a budget of US$80. The AWS services a migration to in-app replacements would remove
(SNS, SQS, EventBridge, Lambda, Step Functions, CloudWatch, SES, S3) cost US$2.73 a month between
them, and replacing them needs an always-on host that costs more than that. So this plan does not
rebuild them. It saves where the money is: the support plan, the database's pricing, the WhatsApp
service, the WAF and GuardDuty. Nine changes, in three steps, each with its own check and rollback.
Step 2 reaches the budget.

The figures: [AWS_COST_AUDIT.md](AWS_COST_AUDIT.md). The inventory:
[AWS_CURRENT_INFRASTRUCTURE.md](AWS_CURRENT_INFRASTRUCTURE.md). Why the internal services wait:
[INTERNAL_SERVICES_ARCHITECTURE.md](INTERNAL_SERVICES_ARCHITECTURE.md). Progress:
[MIGRATION_STATUS.md](MIGRATION_STATUS.md). Undoing each change: [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md).
How changes reach production: [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md).

## Rules

- Nothing is switched off before what replaces it is running and checked.
- Code and infrastructure changes go through a pull request to `main`, and the Deploy workflow
  rolls itself back if its checks fail (CLAUDE.md). Nobody deploys by hand.
- Each change is its own pull request or console action, so each can be undone on its own.
- Changes that trade away a function or high availability are the owner's call, not this plan's.
- No production data is deleted. The three manual database snapshots stay (owner, 2026-10-29).

## The brief's stages, applied

| Brief's stage | Here |
| --- | --- |
| 1. Build replacements without disturbing production | Only where a replacement is cheaper: Cloudflare's rules for the WAF (change 6), SSM for Secrets Manager (change 7) |
| 2. Compatibility adapters | Already the design: interfaces in `packages/core`, AWS adapters in `apps/aws` |
| 3–4. Run both, compare | Change 6 runs Cloudflare's rules beside the WAF before the WAF goes |
| 5–6. Switch, verify | Each change's "Check" below |
| 7. Disable unused AWS integrations | After each check passes |
| 8. Remove SDKs, credentials, config | There is no AWS SDK in the app; the removed pieces leave with their pull request |

## Step 1: nothing is lost (saves 37.42 a month)

**1. Support plan → Basic** (29.00). Business Support+ is the account's paid support plan; the app
does not use it. AWS refuses a downgrade before the 30-day minimum, so from about
**2026-11-14 04:43 UTC**. *Who:* the owner, signed in as root: AWS console → Support Center →
Support plans → Basic. *Check:* the daily cost email stops showing "AWS Business Support+"; the
December invoice has no support line. Basic still allows billing and service-limit cases.

**2. Reserved instance for the database** (7.96). One year, No Upfront, db.t4g.micro PostgreSQL
Multi-AZ, offering `0487c451-607c-446a-86af-f5d23305e90d`. Two orders on 2026-10-18 ended
`payment-failed`: AWS could not charge the card. *Who:* the owner, once a payment method AWS can
charge is on the account. *Check:* `aws rds describe-reserved-db-instances` shows the new one
`active`, and the database instance's cost in the daily email drops from ~1.21 to ~0.96 a day.

**3. X-Ray tracing off** (0.46). `tracing: lambda.Tracing.ACTIVE` on `api`, `jobs` and `cron`
(`infra/cdk/lib/app-stack.ts`); no code reads the traces. *Who:* a pull request. *Check:* the Deploy
passes; the X-Ray line leaves the cost email after a few days.

## Step 2: small trade-offs (saves 16.86, or ~28.96 with Spot)

**4. GuardDuty Advanced RDS off** (6.78 from ~2026-11-15). Keeps GuardDuty and its RDS login
monitoring; drops the analysis of unusual data access. The owner chose to keep it on 2026-10-18.
*Who:* the owner, **before the trial ends on ~2026-11-15**: GuardDuty console → Protection plans →
RDS Protection → turn off Advanced RDS. *Check:* `aws guardduty get-detector` shows `RDS_DATA_RISK`
`DISABLED`.

**5. WhatsApp service on Fargate Spot** (up to ~12.10). `whatsapp.spot: true` for production in
`infra/cdk/lib/config.ts`; the stack already supports it and staging is set that way. When AWS
reclaims a Spot task, ECS starts another, and every linked phone drops for a minute or two while
the WhatsApp sessions reload from the `evolution` database. *Who:* a pull request, on the owner's
yes (given 2026-11-06). *Check:* the service runs on `FARGATE_SPOT`, the WhatsApp page shows
connected numbers, the smoke test passes; a week of billing gives the real Spot rate. Tried first on
a throwaway stack (2026-11-06): an ARM64 task on the `FARGATE` launch type moves to `FARGATE_SPOT` in
place, but only with a forced new deployment, and the way back must be the `FARGATE` capacity
provider, because returning to the launch type makes CloudFormation replace the service, which its
fixed name refuses. The stack is built that way (docs/whatsapp.md, "Cost").

**6. AWS WAF → Cloudflare's rules** (10.08, less 0.40 for one new secret). Cloudflare already
proxies `bizinsights.io`, so its free-plan security can stand in for the WAF. The owner's "just do
it" of 2026-11-12 set the order below (the side door first, so the origin is never without both);
each step is its own pull request, checked live before the next.

1. *Close the side door.* `d2mr8m2p1qkh58.cloudfront.net` lets anyone skip Cloudflare; with the
   WAF gone nothing would stand there. Cloudflare adds a secret header to every request and
   CloudFront's viewer-request function answers 403 without it
   ([aws-deployment.md](../aws-deployment.md#origin-lock-only-cloudflare-reaches-cloudfront)). Two
   deploys: `originLock: "report"` (the function knows the secret, refuses nothing), the owner
   adds the header in Cloudflare, `/edge-lock` answers 204, then `"enforce"`. Checked first: what
   calls the CloudFront name directly. The WAF's sampled requests of 2026-11-12 (three hours, all
   258 requests): nothing but the smoke tests; every webhook arrives on `bizinsights.io`.
2. *Cloudflare's rules* (the owner's dashboard). The Free managed ruleset stays on; one
   rate-limiting rule, all the Free plan allows, on `/api/` except `/api/webhooks/` and
   `/api/pixel/`: **250 requests per 10 seconds per address**, blocked for 10 seconds. That is the
   WAF's 1,500 a minute as a steady rate; a burst is cut sooner (the WAF counted a whole minute).
   Bot Fight Mode stays off.
3. *Remove the WAF*, in two pull requests: the distribution drops `webAclId` (and the Edge stack
   stops exporting the ACL's ARN, after the App stack stopped reading it), then the Edge stack
   drops the web ACL and its two IP sets. The Edge stack itself stays: the us-east-1 log bucket and
   the two rules that pass IAM and root sign-in events on.

What is lost: AWS's IP-reputation and known-bad-input rule groups, and the per-IP limit at the edge
counted over 60 seconds (Cloudflare Free counts over 10). What stays: the app's own per-IP limits
(1,500 a minute, `apps/aws/src/app.ts`, counted in DynamoDB) and every per-route limit. Back:
re-add the web ACL ([aws-deployment.md](../aws-deployment.md), "Domain").

**7. Secrets Manager → SSM Parameter Store SecureString** (2.97 since the origin lock's secret made
seven; 2.43 when this was written, with six). 0.40 a secret; SecureString parameters in the
standard tier are free. `loadSecrets` (`apps/aws/src/secrets.ts`) reads both kinds. Careful work for
the database logins that CloudFormation generated and the ECS task reads, so it goes in three
releases, the first shipped 2026-11-12: [SECRETS_TO_PARAMETER_STORE.md](SECRETS_TO_PARAMETER_STORE.md).

## Step 3: give up high availability (saves ~29.98)

Both reverse decisions the owner made on 2026-10-17 to clear Trusted Advisor's fault-tolerance
checks. Listed because they are the remaining large items, not recommended. **The owner said yes to
both on 2026-11-08**, until the move to iKorex ([MIGRATION_STATUS.md](MIGRATION_STATUS.md)).

**8. Database single-AZ** (21.74). `dbMultiAz: false` in `config.ts`. The standby goes away; RDS
converts in place without downtime. After that, a zone outage or AWS maintenance stops the app until
the instance recovers (minutes to hours), and Trusted Advisor's RDS check turns red again.

**9. One NAT instance** (~8.24). `natGateways: 1`. Both zones' functions then go out through one
instance; if its zone fails, calls to Shopify, Meta, Google and Cognito stop until it is replaced.
The one kept is in the database's zone (`natAz`), so a single zone's outage, not either, stops the app.

## Not migrated, and why

| Service | Decision | Reason |
| --- | --- | --- |
| SQS, EventBridge Scheduler, Lambda | Keep | US$0.02 a month together; replacing them needs an always-on host costing ~8.24 (INTERNAL_SERVICES_ARCHITECTURE.md) |
| SNS | Keep | US$0; CloudWatch alarms can only publish to SNS |
| Step Functions | — | None exist |
| CloudWatch | Keep | US$1.68; the alarms watch metrics only CloudWatch has |
| SES | Already replaced | Resend sends every email; SES is the unused fallback |
| S3 | Keep | US$0.43; serves the UI build files and the outage page |
| DynamoDB | Keep | US$0.14; a PostgreSQL version would load the micro database on every request |
| Cognito | Keep | US$0; passwords can't be exported, so leaving means 72 resets |
| RDS → self-hosted PostgreSQL | Keep | Managed backups, point-in-time restore and failover are what the owner pays for; the database is the one thing that must not be lost |
| CloudFront | Keep | US$0; origin failover to the outage page, the origin secret |
| ElastiCache, API Gateway, load balancer, NAT gateway | — | None exist |

## Decisions waiting for the owner

1. GuardDuty Advanced RDS, **before ~2026-11-15** (change 4).
2. Whether to take change 5 (Spot) and change 6 (WAF → Cloudflare).
3. A payment method AWS can charge, then the reservation (change 2).
4. The support downgrade, on or after 2026-11-14 (change 1).
5. Whether step 3 is on the table at all.
