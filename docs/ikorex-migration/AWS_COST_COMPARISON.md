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
service to Fargate Spot (up to −12.10), and #357 (merged 2026-11-08, live once its Deploy succeeds)
makes the database single-AZ (−21.74) and keeps one NAT instance (about −8.24). None of them changes
the conclusion below.

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

## At scale: 1,000 to 1,000,000 users

The 2026-11-08 brief asks what the infrastructure costs at 1,000, 10,000, 100,000 and 1,000,000
users, kept apart from the third-party costs that grow with use. **Nothing here is measured above
today's 72 users**: these are sizing estimates from today's load and the assumptions below, to show
the shape of the costs, not quotes. Each tier's claim needs a load test against staging first.

**Assumptions.** A user is one person who signs in; a workspace has two users and one Shopify store,
so stores are half the users. A store takes ~1,000 orders a month, with 12 months of history
imported when it connects, ~50 MB of database a year (orders, line items, daily sales, indexes).
Per user, from the 7 days to 2026-11-06 (72 users, much of it the owner's own testing, so
generous): ~640 API requests and ~480 background jobs a week. Peaks are ~10 times the average.

| Users | Stores | API requests a second, average (peak) | Jobs a second | Database after a year |
| --- | --- | --- | --- | --- |
| 1,000 | 500 | ~1 (10) | ~0.8 | ~25 GB |
| 10,000 | 5,000 | ~10 (100) | ~8 | ~250 GB |
| 100,000 | 50,000 | ~100 (1,000) | ~80 | ~2.5 TB |
| 1,000,000 | 500,000 | ~1,000 (10,000) | ~800 | ~25 TB |

### Infrastructure, US dollars a month before tax

Server prices from DigitalOcean's list (the same in its Sydney region), checked 2026-11-08; Hetzner raised its prices in
2026 and has no Australian location. Check at order time.

| Users | What runs | Infrastructure |
| --- | --- | --- |
| 1,000 | **One server.** The iKorex server if it passes the capacity test; otherwise one of our own in Sydney (8 vCPU, 16 GB, its backups), same Compose files. R2 for backups | **0** on iKorex, or **~60–130** on our own |
| 10,000 | **Three servers.** Two for the app and workers; PostgreSQL on its own with a standby (here one server stops being acceptable: paying merchants need a failover). A secrets manager and a registry once several servers deploy | **~500–1,100** |
| 100,000 | **A small fleet.** PostgreSQL on large dedicated servers (32+ cores, 256 GB, NVMe) with a standby and a read replica, order tables partitioned by month, a connection pooler; 6–10 app and worker servers behind Cloudflare's load balancing; a Redis for rate limits; a queue of its own; Cloudflare Business for its WAF; paid monitoring | **~4,000–8,000** |
| 1,000,000 | **Sharded.** PostgreSQL split by workspace across several primary-and-standby pairs, 40–80 app and worker servers, a second region for disaster recovery, Cloudflare Enterprise | **~40,000–80,000**, plus a team on call |

R2 backups are inside those figures: free to 10 GB, then US$0.015 per GB a month (about US$1 at
1,000 users, ~US$400–600 at 1,000,000 with 25–40 TB of backups). Above ~1,000 users the biggest
cost isn't on the bill: someone has to run the servers, patch them and answer the alerts.

### Third-party costs that grow with use

Not infrastructure: they follow what merchants do, whatever hosts the app.

| Service | Price | At 1,000 / 10,000 / 100,000 / 1,000,000 users |
| --- | --- | --- |
| Resend (email: codes, invitations, alerts; ~10 a user a month) | Free to 3,000 a month; Pro US$20 for 50,000; Scale from US$90 for 100,000 to US$1,150 for 2.5 million | ~US$20 / ~US$35–90 / ~US$500–650 / a negotiated plan (10 million a month) |
| Twilio (SMS) | US$0.0515 per message part to Australia (list price, US dollars) | Per text merchants send: US$51.50 per 1,000, capped by each merchant's monthly SMS limit. Charged on to merchants, not carried by the app |
| WhatsApp | Sent through the merchant's own linked number (the WhatsApp service) | No per-message fee to bizinsights |
| Shopify, Meta, Google Ads, Zapier APIs | No fee | Their rate limits are what grows, not a bill |
| Cloudflare | Free today; Pro ~US$20–25, Business ~US$200–250 a month a domain | Free / Free or Pro / Business / Enterprise (quoted) |
