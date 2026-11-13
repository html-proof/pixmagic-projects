# The AWS account, audited after the deletion (2026-11-13)

The owner's brief of 2026-11-13 ("complete AWS decommissioning: stop all AWS services and eliminate
monthly billing") asks for an audit of the whole account before anything is deleted, and a final
audit after. By the time it arrived the move and most of the deletion were already done the same
day ([LEAVING_AWS.md](LEAVING_AWS.md)), so this page is both: an independent read of what is in the
account now, what it still costs, and what stands between here and a closed account.

Read-only, with the AWS CLI, between 07:53 and 08:10 UTC on 2026-11-13: about 70 kinds of resource
in each of the account's 18 enabled regions, the global services, the bill, and the server over
SSH. Nothing was changed. Other sessions were deleting during the read; where a count moved, the
later reading is the one given.

## The short answer

- **No application workload runs on AWS.** No instance, database, function of the app, queue,
  schedule, load balancer, NAT, CloudFront distribution or WAF exists in any region.
- **16 regions are empty.** Everything left is in Sydney, plus the CDK bootstrap and one
  certificate in us-east-1.
- **The bill is not zero.** About US$32 a month before GST as the account stands, and US$29 of
  that is the support plan, which only the owner can change. Without it: US$2 to 3 a month.
- **The server still needs AWS for two things**, the same two as in LEAVING_AWS.md: sign-in
  (Cognito) and the backups (an S3 bucket). The account can't close before both are cut.
- **No copy of the database is left inside AWS.** The database, its automated backups and both
  snapshots are gone. See [The data](#the-data).

## What is in the account

| Service | Resource | Region | State | US$ a month | Needed | Action |
| --- | --- | --- | --- | --- | --- | --- |
| Support | Business Support+ plan | account | active | 29.00 | no | The owner sets it to Basic in the root console; AWS refuses before 2026-11-14 about 04:43 UTC (30-day minimum) |
| Cognito | User pool `insights-production` (Essentials tier, deletion protection on), its client, the Google provider, two domains (`auth.bizinsights.io` and AWS's own) | Sydney | in use | 0 (free under 10,000 users a month) | **yes, until `AUTH_MODE=local`** | Part 2 |
| Lambda | `insights-production-cognito-email` (sends Cognito's codes) | Sydney | in use | 0 | with Cognito | Part 2 |
| KMS | One key of ours (Cognito encrypts the codes with it) | Sydney | enabled | 1.00 | with Cognito | Part 2; AWS keeps a deleted key 7 to 30 days |
| Secrets Manager | `insights/production/app`, `insights/production/worker-cognito` | Sydney | active | 0.80 | with Cognito | Part 2 |
| Secrets Manager | `db-owner`, `db-system`, `evolution-api`, `evolution-db`, `origin-lock` | Sydney | scheduled for deletion | 0 | no | Nothing: gone for good by themselves |
| Parameter Store | `/insights/production/app`, `/runtime`, `/worker-cognito` | Sydney | present | 0 | with Cognito | Part 2 |
| Parameter Store | `/bizinsights/ikorex/backup-cipher-pass` | Sydney | present | 0 | **yes** | Part 3, after the owner has the passphrase in a password manager |
| CloudWatch | One alarm and one log group (26 KB), both of the email function | Sydney | present | 0 | with Cognito | Part 2 |
| Certificate Manager | `auth.bizinsights.io` | us-east-1 | issued, in use | 0 | with Cognito | Part 2 |
| IAM | User `bizinsights-ikorex`, one access key (on the server) | global | active | 0 | with Cognito | Part 2 |
| S3 | `bizinsights-backups-605411278365`: 2,663 objects, 53 MB | Sydney | written every few minutes | 0.01 | **yes, the only backup off the server** | Part 3 |
| IAM | User `bizinsights-backups`, one access key (on the server), last used 07:54 UTC | global | active | 0 | yes | Part 3 |
| CloudFormation | `InsightsAuth-production` (no termination protection) | Sydney | complete | 0 | with Cognito | Part 2 |
| CloudFormation | `CDKToolkit` twice: 5 roles, an empty image repository, an assets bucket and a parameter each | Sydney, us-east-1 | complete | 0 | to delete the Auth stack | After part 2 |
| S3 | The two CDK assets buckets: 1.4 GB in Sydney (877 objects), 0.4 MB in us-east-1 | Sydney, us-east-1 | idle | 0.04 | no | After part 2, emptied first (they are versioned) |
| GuardDuty | One detector, 8 features on, free trial ending about 2026-11-14 12:37 UTC | Sydney | enabled | cents (nothing left to watch) | no | Last |
| SES | The domain `bizinsights.io` and one email address, production access on, nothing sent in 24 hours | Sydney | verified | 0 | no (Resend sends every email) | Any time; its DNS records at Cloudflare with it |
| End User Messaging | The test sender ID `BIZTEST` (AU), one verified destination number | Sydney | present | 0 | no (SMS was removed) | Any time |
| EC2 | Key pair `Aby` | Sydney | present | 0 | no | Any time; whoever holds the private file should delete it too |
| EC2 | The default VPC | Sydney (and every region) | AWS's own | 0 | no | Leave |
| RDS | Two reserved-instance orders, both `payment-failed` | Sydney | never started | 0 | no | Nothing: AWS drops them |
| Cost Explorer | The default anomaly monitor | account | present | 0 | no | Leave; each Cost Explorer API call costs US$0.01 |
| Billing | The payment card | account | on file | 0 | until the last invoice | The owner |

Found and already gone when read again: two terminated instances (the NAT instance and the admin
host; AWS lists them for an hour), an orphan email subscription to the deleted alarms topic. The
tagging API still listed the WhatsApp cluster, the VPC endpoints and 13 disk snapshots; the
services themselves answer that none exist.

Looked for and not found, in all 18 regions: EC2 instances, volumes, disk snapshots, machine
images, Elastic IPs, NAT gateways, VPC endpoints, network interfaces, VPCs of ours, security
groups of ours, VPN and transit gateways, load balancers, Auto Scaling groups, ECS and EKS
clusters, API Gateway, RDS instances, clusters, snapshots, retained backups and proxies, DynamoDB
tables, ElastiCache, SNS topics, SQS queues, Step Functions, EventBridge rules, schedules and
buses, AWS Backup plans and vaults, CloudTrail trails, Config recorders, Access Analyzer, Cloud
Map, regional WAF, EFS, Kinesis, Firehose, OpenSearch, Lightsail, Amplify, canaries, dashboards.
Globally: no CloudFront distribution or function, no CloudFront WAF, no Route 53 zone or
registered domain (DNS and the domain are at Cloudflare), no Savings Plan, no Marketplace
agreement, no budget, no organization, no customer-managed IAM policy, no OIDC provider. Lightsail
and Amplify have no endpoint in three of the regions; that is AWS not offering them there.

## The bill

Cost Explorer, before the deletion shows in it (it lags a day):

| | US$ |
| --- | --- |
| October 2026, whole month | 69.83 (invoiced as A$100.88 on 2026-11-02) |
| November 1 to 12 | 66.52: support 29.00, RDS 14.54, tax 6.05, Fargate 4.24, WAF 4.04, EC2 and its network 5.83, secrets 1.03, the rest 1.79 |
| A day before the move (11-11) | 1.89, without support and tax |

All of it billed by AWS itself: nothing from the Marketplace.

What the account costs from here, a month, before 10% GST:

| State | US$ |
| --- | --- |
| As it stands | about 32: support 29, the key 1, two secrets 0.80, storage and GuardDuty cents |
| Support on Basic | 2 to 3 |
| After part 2 (Cognito gone) | under 0.50 |
| After part 3 and the last step | 0 |

November's invoice will still be about US$70: the support charge for the month was taken on the
1st and the first 12 days ran the whole stack. Whether October's invoice was paid is not in the
API. The card failed twice on 2026-10-18 (the two reserved-instance orders above), so the owner
should look at Billing → Payments before closing anything: AWS doesn't close an account cleanly
over an unpaid invoice.

No commitment outlasts the account: no reserved instance is active, no Savings Plan, no domain
renewal, no Marketplace subscription. The support plan is monthly.

## The server

Read at 07:59 UTC over SSH, and from outside.

| Check | Result |
| --- | --- |
| `https://bizinsights.io/api/version` | 200, production, the commit `21d1dd6c` (`main` was one code change ahead: #401) |
| `/api/readyz` | 200: database, coordinator and tenant database all true |
| `/`, `/login` | 200, served through Cloudflare; `www` answers 301 to the apex |
| Containers | `web`, `worker`, `postgres`, `evolution`, `backup`, `cloudflared`: all running, healthy, 0 restarts |
| Timed jobs | `SCHEDULES=on`; `every15min` and `nightly` ran with no error |
| Job queue | 0 waiting, 0 dead |
| Data | 8 users, 4 stores, 70 migrations |
| Backups | pgBackRest status ok, a full backup of 06:47 UTC and the log since, in the S3 bucket |
| After a restart | Every container restarts by itself (`unless-stopped`) and Docker starts at boot. **Not proven by a reboot**: the server is shared and a restart is its administrator's to do |
| Memory, disk | 2.2 GB of 3.9 GB available, 41 GB of 72 GB free |

Not checked here, because only a person can: signing in with a password and with Google, a Shopify
install, an email arriving, a WhatsApp number paired again. `admin sign-in-move` counts 1 of 5
password users and 0 of 4 Google users as having signed in on the server's own sign-in so far.

## The data

After the deletion the data exists in these places only:

1. The server's database.
2. pgBackRest's backups in `bizinsights-backups-605411278365`: the one copy off the server, and
   it is in the account being closed.
3. The last dump of RDS, on the server's own disk (`~/bizinsights-archive/rds-final-20261113/`,
   8.7 MB and 96 KB): the same machine as 1.

LEAVING_AWS.md says CloudFormation's final snapshot of the database is kept until the account
closes. It no longer is: CloudTrail shows it deleted at 08:02 UTC, after the manual snapshot at
07:29 UTC. Nothing is lost by that (the dump in 3 was compared with RDS before the database went),
but it makes the backups bucket the only thing between a failed server disk and the loss of every
merchant's data. So part 3 must not run before a backup is restorable from somewhere outside both
the server and AWS, and the owner has the passphrase.

## What is left to do, and whose it is

In this order. Each deletion below needs the owner's yes at that moment; none is undoable.

1. **The owner, any time from 2026-11-14 04:43 UTC:** the support plan to Basic (root console →
   Support plans). Ends US$29 of the US$32.
2. **The owner:** Billing → Payments: is October's invoice paid, does the card work.
3. **Sign-in off Cognito** ([LEAVING_AWS.md](LEAVING_AWS.md#sign-in-off-cognito)): Google goes
   straight to Google already; left are the notice to the 3 people whose password only Cognito
   knows, then `AUTH_MODE=local`, then a person signing in each way. After it, part 2: the Auth
   stack, `bizinsights-ikorex`, the certificate, the `auth.bizinsights.io` record at Cloudflare.
4. **Backups off S3** ([LEAVING_AWS.md](LEAVING_AWS.md#backups-off-s3)): the owner opens R2 (it
   asks for a card) or names another place outside AWS; a full backup and a passing restore test
   there; the passphrase in the owner's password manager. After it, part 3: the bucket,
   `bizinsights-backups`, the passphrase's parameter.
5. **The small leftovers**, free but in the way of an empty account: the SES identities and their
   DNS records, the `BIZTEST` sender ID and its test number, the key pair `Aby`.
6. **Last:** both `CDKToolkit` stacks and their buckets, GuardDuty, then this sweep once more with
   nothing found, and the owner closes the account (Account → Close account). AWS keeps a closed
   account 90 days and sends the final invoice the month after.

Still open on the server's side, none of it AWS's: no alarm reaches anyone when the server is down
until the uptime check (#400) is merged; one server, shared, with 2.2 GB to spare; a reboot never
tried.
