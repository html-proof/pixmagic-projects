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

## After: nothing stays on AWS

The owner's revised decisions (2026-11-07, [IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md#decisions-2026-11-07)):
Cognito is replaced by the app's own sign-in (users move over gradually, `AUTH_MODE`), SMS by
Twilio (`SMS_PROVIDER`), and the AWS account is **closed** after the 14-day rollback period. So the
AWS bill after stage F is **0.00**.

What the earlier plan kept, and where it went:

| Service | Before GST | Now |
| --- | --- | --- |
| Cognito | 0.00 | The app's own sign-in (`apps/api/src/localAuth.ts`); deleted at stage F |
| KMS key for Cognito's emailed codes | ~1.15 | The app emails its own codes through Resend; deleted with Cognito |
| Lambda `cognito-email` + its secret | 0.40 | Deleted with Cognito |
| End User Messaging SMS + SNS + the `smsEvents` queue | per message | Twilio (per message, billed by Twilio); deleted at stage F |
| CloudTrail + its bucket | ~0.05 | Nothing left to audit; deleted at stage F |
| Cost Explorer (daily cost email) | 0.30 | No AWS bill to report: the server never sends it; AWS's own schedule sends it until the account closes |

Everything else is deleted at stage F as planned: RDS (44.54), the WhatsApp service and its DNS
zone (17.79), the WAF (10.08), the NAT instances, their disks and addresses (18.34), the secrets,
CloudWatch, DynamoDB, S3 buckets, the SQS queues, Lambda `api`/`jobs`/`cron`, CloudFront, GuardDuty.

## After: what is new outside AWS

| Item | Monthly | Note |
| --- | --- | --- |
| iKorex server | No new charge **if it passes the capacity test** | Its own cost (already paid for the other workloads) isn't known here |
| Cloudflare Tunnel, managed rules, one rate-limit rule | 0.00 | Free plan |
| Cloudflare R2, backups | 0.00 up to 10 GB, then 0.015 per GB | ~2 GB database, 14 days of WAL and dumps: expected under 10 GB |
| External uptime check | 0.00 | Free tier |
| Twilio (SMS) | per message, in US dollars | Twilio's price for each country texted (Australia only, by Geo Permissions); nothing until the owner switches (`docs/sms.md`, "Twilio"). Merchants' monthly SMS limits cap it, as they did on AWS |
| A server of its own, **only if the capacity test says no go** | to be quoted | 4 vCPU / 8 GB / 80 GB SSD |

## The saving

| | Before GST | With GST |
| --- | --- | --- |
| AWS after GuardDuty's trial | ~135.76 | ~149.34 |
| AWS after stage F (account closed) | 0.00 | 0.00 |
| **Saving a month** | **~135.76** | **~149.34** |

Twilio's texts are the one new bill that grows with use, as AWS's did; the saving above is before them.

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
