# Leaving AWS: what is left

The owner's instruction of 2026-11-13, an hour after production moved to the server: finish the
move and delete everything in AWS, without waiting out the 14-day rollback period of
[ROLLBACK_PLAN.md](ROLLBACK_PLAN.md). This page is where that stands: what the server still borrows
from AWS, what cuts each tie, and the order the account is emptied in. It is stage F of
[AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md), brought forward.

**Part 1 is done (2026-11-13, 07:13 to 07:55 UTC), on the owner's "Yes, delete now": there is no
way back to AWS.** The database, the functions, the queues, CloudFront, the WAF, the WhatsApp
service and the deploy pipeline are deleted ([what was deleted](#what-was-deleted-2026-11-13)).
What is left in the account is what the two ties below need, and little else.

**Parts 2 and 3 followed the same day, and the account is empty since 08:45 UTC.** On the owner's
"delete cognito too" and "Yes, delete it" (the backups bucket), Cognito, the bucket, both IAM users
and everything else went ([what is left](#what-is-left-in-the-account): nothing that runs or
costs). Nothing in production uses AWS. What remains is the owner closing the account, and the
last AWS code leaving the repository.

## What replaced what

Every AWS service bizinsights used, and what does its job on the server. Nothing in the last column
is an AWS service; the two rows that were ties (backups, sign-in) say how each was cut.

| AWS service | Its job | On the server |
| --- | --- | --- |
| Lambda (`api`, `jobs`, `cron`) | The app, the background jobs, the timed jobs | Two containers of the same code: `web` and `worker` (Node.js, Hono) |
| SQS (5 queues, a dead-letter queue) | Job queue | A queue in PostgreSQL (`pgQueues.ts`) |
| EventBridge Scheduler | Timed jobs | Schedules in the worker (`schedules.ts`) |
| DynamoDB | Rate limits, sign-in state, locks | A PostgreSQL table (`pgCoord.ts`) |
| RDS PostgreSQL | All the data | PostgreSQL 17 in a container |
| RDS snapshots, AWS's backups | Backups | pgBackRest, encrypted, with a restore test, in a folder on the server's own disk (the owner chose "only on the server" on 2026-11-13; the S3 bucket it first wrote to is deleted) |
| S3 | Webhook bodies waiting for their job, the built pages | A folder on the server; pages served by `web` |
| Cognito | Sign-in: passwords, emailed codes, Google, two-step verification | The app's own sign-in (`localAuth.ts`: argon2id passwords, six-digit emailed codes, authenticator-app codes in `totp.ts`), alone since `AUTH_MODE=local` on 2026-11-13; the user pool is deleted |
| Cognito's email function + KMS | Sending the sign-in codes | The app writes and sends them itself, through Resend |
| SES | Email (an unused fallback) | Resend, which always sent every email. Not AWS, not on the server: a mail server of our own on a shared address would land in spam ([OPEN_SOURCE_STACK.md](OPEN_SOURCE_STACK.md)) |
| End User Messaging SMS, SNS `sms-events` | Texts | Nothing: the owner removed Customer Messaging (SMS) on 2026-11-13 |
| Secrets Manager, Parameter Store | Secrets and settings | `env/*.env` files on the server, mode 600 |
| CloudFront, WAF | Edge, caching, rate limits | Cloudflare (already in front) and its tunnel `bizinsights` |
| EC2 (NAT instance, admin host) | The functions' way out to the internet | Not needed |
| ECS Fargate, Cloud Map, Route 53 private zone | The WhatsApp service (Evolution API) | The `evolution` container |
| CloudWatch, SNS alarms | Alarms, logs | `docker compose logs`. **Not replaced yet:** no alarm reaches anyone when the server is down |
| CloudFormation/CDK, the GitHub deploy role | Deploys | `ship.sh` and `deploy.sh` over SSH |
| GuardDuty, CloudTrail, Budgets, Cost Explorer | Watching the AWS account itself | Nothing to watch once it is closed |

## The two ties

Counted on the server on 2026-11-13 (`admin sign-in-move`, below). Where each stands that evening:

- **Sign-in no longer uses Cognito.** Google sign-in runs on the app's own client since 07:31 UTC
  (steps 1 and 2 below, done from the cutover's session). On the owner's "Email them, then switch",
  the notice went to the 3 people whose password only Cognito knew (3 sent, none failed) and the
  server runs `AUTH_MODE=local` since about 08:13 UTC (steps 3 and 4). Checked after it: the site
  healthy, a wrong sign-in answered 401 and a reset request 200 without Cognito, Google's start
  still handed to Google, no error and no call to Cognito in the server's log. Not yet seen: a
  person signing in with Google on the app's own client, or one of the 3 setting a password.
  **The user pool is deleted** (the owner, later that hour: "delete cognito too"), so there is no
  switching back: sign-in problems are fixed in the app. What could be proven about Google without
  a person, before it went: Google's token endpoint accepts the server's client id and secret (a
  made-up code is refused as `invalid_grant`, not `invalid_client`), and all 4 Google users are
  recorded under the name the app's own sign-in finds them by (`google_<Google's id>`).
- **The backups are on the server only.** The owner chose that over R2 (it asks for a payment
  card), told plainly that the database and every backup then share one disk. pgBackRest writes to
  a folder there since 08:18 UTC (restore test passed; the sessions that own the backups record
  it in [PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md)), and the S3 bucket, its
  IAM user and the passphrase's parameter are deleted (08:32 UTC). The app's secrets likewise
  exist only in `~/bizinsights/env` on the server: the encrypted copy made before part 1 was in
  that bucket.

The table is the two ties as they were:

| Tie | What breaks if AWS goes first | What cuts it |
| --- | --- | --- |
| **Sign-in**, as it was until the switch to `AUTH_MODE=local` (above): `AUTH_MODE=migrating`. Cognito checks the password of 4 of the 5 people who have one (the fifth has signed in since 2026-11-08, so the app has theirs), and carries Google sign-in for the 4 who use it | Those 4 can't sign in with their password until they reset it; the 4 Google users can't sign in at all | [Sign-in off Cognito](#sign-in-off-cognito) |
| **Backups**: pgBackRest writes to the S3 bucket `bizinsights-backups-605411278365`, with a copy of its passphrase in Parameter Store | The server's only backup off the server is deleted with the account | [Backups off S3](#backups-off-s3) |

Nothing else on the server calls AWS ([AWS_DEPENDENCY_SCAN.md](AWS_DEPENDENCY_SCAN.md), "What the
server would call on AWS").

## Sign-in off Cognito

1. **Google (the owner, in Google Cloud Console).** APIs & Services → Credentials → the OAuth client
   `567753266621-ltq5…` → Authorised redirect URIs → add `https://bizinsights.io/auth/callback` →
   Save. Until then Google answers `redirect_uri_mismatch` for the app's own sign-in (checked
   2026-11-13).
2. On the server, `env/app.env`: uncomment `GOOGLE_SIGNIN_CLIENT_ID` (its secret is already there),
   `docker compose up -d web`, and sign in with Google. It now goes straight to Google, and the
   account comes over under the name Cognito gave it.
3. Who is left:

   ```bash
   docker compose --profile admin run --rm admin sign-in-move
   ```

   Counts only, no addresses: `password.left` is how many people have a password only Cognito
   knows. Then the notice, first counted and then sent:

   ```bash
   docker compose --profile admin run --rm admin sign-in-move --notify --dry-run
   ```

   ```bash
   docker compose --profile admin run --rm admin sign-in-move --notify
   ```

   Each of them gets one email ("Set your bizinsights password again") saying to choose "Forgot
   password?" at their next sign-in. It can be run again: whoever has set a password since is no
   longer on the list.
4. `env/app.env`: `AUTH_MODE=local`, then `docker compose up -d web worker`. Sign in with a
   password, an emailed code and Google, and reset a password. Anyone whose browser still held a
   session from Cognito (signed in before 2026-11-08 and not since) is asked to sign in again.
   The `COGNITO_*` lines and the two `AWS_*` keys are emptied when Cognito is deleted, not before:
   until then they are what a switch back needs.
5. Cognito can go (below), and the code that spoke to it
   ([AWS_DEPENDENCY_SCAN.md](AWS_DEPENDENCY_SCAN.md#stage-f-removing-the-code), step 1).

"Forgot password?" works for these people without Cognito because every Cognito user who ever
signed in has an `auth_identities` row: the app's own sign-in finds them there and sets the new
password under the same id, so their workspaces and stores are theirs as before.

## Backups off S3

The plan since 2026-11-07 is Cloudflare R2 (free up to 10 GB; the backups are megabytes). The owner
opens it, because R2 asks for a payment card even on its free tier:

1. Cloudflare dashboard → R2 → enable it → create the bucket `bizinsights-backups` → Manage API
   tokens → a token with Object Read & Write on that bucket only.
2. On the server, `env/postgres.env`: the endpoint `<account id>.r2.cloudflarestorage.com`, the
   bucket, the token's key and secret; the three S3-only lines (`…_S3_REGION`, `…_S3_URI_STYLE`, and
   the AWS endpoint) removed, so `pgbackrest.conf`'s R2 values apply. The passphrase stays the same.
3. `docker compose up -d postgres backup`, a full backup, and `restore-test.sh` passing against R2.
4. The passphrase into the owner's password manager: without it no backup can be read. Then its
   Parameter Store copy, the S3 bucket and the IAM user `bizinsights-backups` can go.

## What was deleted (2026-11-13)

Before anything went: a last dump of both RDS databases, taken on AWS's admin host with
`copy-db.sh` (app: 130 tables, 121,458 rows; evolution: 37 tables), kept on the server in
`~/bizinsights-archive/rds-final-20261113/` with its checksums compared; and a copy of the server's
`.env` and `env/`, encrypted with the backups' passphrase, in the backups bucket under
`server-env/` (`~/bin/bizinsights-env-archive.sh` on the server makes it again). Until then the
only other copy of the app's secrets was Secrets Manager.

Deleted, in this order:

1. One IAM policy of the Auth stack (the `api` function's Cognito rights): it read an export of the
   App stack, and CloudFormation deletes no stack whose exports are in use. Nothing else of the Auth
   stack changed.
2. The stacks `InsightsWhatsapp`, `InsightsApp`, `InsightsCi` (the GitHub deploy role and its OIDC
   provider), `InsightsAudit` (CloudTrail: the Data stack could not go while it read the access-log
   bucket's name), `InsightsEdge` (us-east-1) and `InsightsData` (the database, the VPC, the NAT
   instance, the admin host).
3. What those stacks keep by design: the buckets `site`, `payloads`, `artifacts`, both access-log
   buckets and CloudTrail's; the coordinator table; their log groups; the retained automated RDS
   backups and the manual snapshot `insights-production-pre-table-drop-20261112`; 13 disk snapshots;
   the certificate for `bizinsights.io` in us-east-1 (CloudFront's); the secrets `db-owner`,
   `db-system`, `evolution-api`, `evolution-db` and `origin-lock` (Secrets Manager keeps each 30
   days before it is gone for good) and their Parameter Store copies.

4. At 08:02 UTC, on the owner's "delete the leftovers in aws too" and their choice of "Delete all of
   it" over "Keep the database snapshots": CloudFormation's final snapshot of the database
   (`insightsdata-production-snapshot-db5d02a0a9-…`, taken 07:45 UTC), which had been kept as a
   second copy of the last dump, and the two SES identities (`bizinsights.io` and one address;
   the Auth stack's `SesIdentityArn` is empty and SES had sent nothing). AWS now holds no copy of
   the old database: the last dump on the server, next to the live database, and the server's
   backups are the only ones.

The server was never touched by it: `/api/readyz` answered 200 throughout, and Cognito's sign-in
page still answers.

## What is left in the account

Nothing that runs, stores data or costs (read 2026-11-13, 08:45 UTC, Sydney and us-east-1): no
stack, bucket, function, database or snapshot, user pool, IAM user, certificate, log group,
parameter, trail or GuardDuty detector. AWS itself still holds, until their waiting periods end
and at no charge:

| Left | Until |
| --- | --- |
| Seven secrets `insights/production/*`, deleted with Secrets Manager's recovery window | 2026-12-13, then gone for good |
| The KMS key of Cognito's email function, scheduled for deletion | 2026-11-20 |

Outside AWS, two loose ends of it:

- **The DNS record `auth.bizinsights.io`** at Cloudflare points at Cognito's deleted domain. It is
  removed in the Cloudflare dashboard, with the owner.
- **The last bill** arrives the month after: about US$66.52 had run up by 2026-11-13, before GST.

## What parts 2 and 3 deleted (2026-11-13)

- **Cognito (08:20 to 08:42 UTC).** First the server: the `COGNITO_*` lines and the IAM user's keys
  emptied in `env/app.env`, `web` and `worker` restarted healthy, sign-in checked again. Then the
  IAM user `bizinsights-ikorex`; the stack `InsightsAuth` (the client, both pool domains, the
  `cognito-email` function, its KMS key); the user pool itself, which the stack keeps by design;
  the secrets `insights/production/app` and `worker-cognito` with their Parameter Store copies;
  the log group; the certificate for `auth.bizinsights.io`.
- **The backups' place in AWS (08:32 UTC),** after reading on the server that nothing there named
  S3 any more and archiving had 0 failures: the IAM user `bizinsights-backups`, the bucket
  `bizinsights-backups-605411278365` with all 2,683 object versions, the parameter
  `/bizinsights/ikorex/backup-cipher-pass`. `pgbackrest check` passed on the server after it.
- **Last (08:45 UTC):** both `CDKToolkit` stacks with their asset buckets and image repositories,
  and GuardDuty.

## The order

Deleting is the one step of the move with no way back: after part 1 a rollback to AWS is no longer
possible, and the server and its backups are the only copy of the data.

**Part 1, done 2026-11-13** (nearly all of the bill): everything listed under "What was deleted"
above. The repository followed the same day: `.github/workflows/aws-deploy.yml`, all of `infra/cdk`,
the Lambda entry point (`apps/aws/src/index.ts`) and what only it loaded (the SQS, DynamoDB, S3 and
Secrets Manager adapters, the cost email, Cognito's email function, the Lambda build) are removed;
the last commit that holds them is `a5177a93`. `infra/aws/cognito.yaml` stays as the description of
the pool until part 2. What still names AWS in the code is in
[AWS_DEPENDENCY_SCAN.md](AWS_DEPENDENCY_SCAN.md).

**Part 2, done 2026-11-13 in AWS:** the Auth stack (the user pool, `auth.bizinsights.io` and its
record at Cloudflare, the `cognito-email` function and its KMS key) and the IAM user
`bizinsights-ikorex`. Still to follow in the repository, as its own pull request: `cognito.ts`,
`migratingAuth.ts`, `infra/aws/cognito.yaml`, the Cognito stand-in of the tests, the SES mailer
and the copy tools ([AWS_DEPENDENCY_SCAN.md](AWS_DEPENDENCY_SCAN.md#stage-f-removing-the-code)).

**Part 3, done 2026-11-13** (the backups went to the server's own disk, not to R2): the bucket
`bizinsights-backups-605411278365`, its IAM user and the passphrase's parameter.

**Last:** both `CDKToolkit` stacks and GuardDuty are deleted (2026-11-13). Open: `node
scripts/aws-dependency-scan.mjs --none-left` passes once the code above is gone; and the owner
closes the account in the AWS console as its root user (Account → Close account), which nothing
in the account now stands in the way of.
