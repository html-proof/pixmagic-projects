# AWS cost: before and after the move to iKorex

US dollars a month. "Before GST" figures are from Cost Explorer (see
[../aws-migration/AWS_COST_AUDIT.md](../aws-migration/AWS_COST_AUDIT.md) for the method); AWS
Australia adds 10 % GST. **These are estimates until the move is done**; the real "after" figure is
read from the bill a month after the cutover.

## Before

| | Before GST | With GST |
| --- | --- | --- |
| Run rate measured 2026-11-06 | 126.37 | 139.01 |
| After GuardDuty's trial ends (~15 Nov) | ~135.76 | ~149.34 |

#343 (merged 2026-11-06, Deploy to confirm) switches X-Ray off (−0.46) and moves the WhatsApp
service to Fargate Spot (up to −12.10); neither changes the conclusion below.

## After: what stays on AWS

If Cognito and SMS stay on AWS (the recommendation for Cognito, the owner's choice for SMS):

| Service | Before GST | Why it stays |
| --- | --- | --- |
| Cognito | 0.00 | Free up to 10,000 monthly active users (72 users) |
| KMS key for Cognito's emailed codes | ~1.15 | Cognito encrypts the codes it hands to the email function |
| Lambda `cognito-email` | 0.00 | Free tier |
| Secrets Manager: the one secret that function reads | 0.40 | Resend's key for the code emails |
| End User Messaging SMS | per message | Sandbox now: nothing sent, nothing billed |
| SNS (SMS delivery events) | 0.00 | Free tier |
| CloudTrail + its bucket | ~0.05 | Audit of what remains |
| Cost Explorer (daily cost email) | 0.30 | Optional once the bill is this small |
| Support plan | 0.00 | Basic |
| **Total** | **~1.90** | **~2.09 with GST** |

Everything else is deleted at stage F: RDS (44.54), the WhatsApp service and its DNS zone (17.79),
the WAF (10.08), the NAT instances, their disks and addresses (18.34), the other secrets, CloudWatch,
DynamoDB, S3 buckets, SQS, Lambda `api`/`jobs`/`cron`, CloudFront, GuardDuty.

If Cognito is replaced too (option 2 or 3 in the matrix) and SMS moves elsewhere, the AWS account
can be closed: **0.00**. Not before then.

## After: what is new outside AWS

| Item | Monthly | Note |
| --- | --- | --- |
| iKorex server | No new charge **if it passes the capacity test** | Its own cost (already paid for the other workloads) isn't known here |
| Cloudflare Tunnel, managed rules, one rate-limit rule | 0.00 | Free plan |
| Cloudflare R2, backups | 0.00 up to 10 GB, then 0.015 per GB | ~2 GB database, 14 days of WAL and dumps: expected under 10 GB |
| External uptime check | 0.00 | Free tier |
| SMS provider, if SMS leaves AWS | per message | Owner's choice |
| A server of its own, **only if the capacity test says no go** | to be quoted | 4 vCPU / 8 GB / 80 GB SSD |

## The saving

| | Before GST | With GST |
| --- | --- | --- |
| AWS after GuardDuty's trial | ~135.76 | ~149.34 |
| AWS after the move (Cognito kept) | ~1.90 | ~2.09 |
| **Saving a month** | **~133.86** | **~147.25** |

Of that, **29.00 (the support plan) is saved anyway** by the downgrade to Basic allowed from
~2026-11-14, move or not. Against the cheapest AWS setup that keeps a managed database (the cost
plan's step 2, ~69.38–81.48 before GST), the move saves a further **~67–80 a month**.

## What the saving costs

Not money on the bill, but real:

- **High availability.** RDS Multi-AZ fails over by itself; one server does not. A hardware or data
  centre failure stops the app until it is restored elsewhere from the off-server backups (an hour
  or two, rehearsed in stage C). Data loss at most ~5 minutes.
- **Operations.** Patching the OS, Docker and PostgreSQL, watching backups and disk, renewing what
  AWS renewed. Alerts make it visible; someone still has to act on them.
- **The rollback period.** AWS keeps running (schedules off) for 14 days after the cutover: about
  half a month of today's bill once more.
- **Shared server.** The websites, n8n and the CCTV tunnel share its CPU, memory, disk and
  network. Limits protect them from bizinsights, not bizinsights from them.
