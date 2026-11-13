# Leaving AWS: what is left

The owner's instruction of 2026-11-13, an hour after production moved to the server: finish the
move and delete everything in AWS, without waiting out the 14-day rollback period of
[ROLLBACK_PLAN.md](ROLLBACK_PLAN.md). This page is where that stands: what the server still borrows
from AWS, what cuts each tie, and the order the account is emptied in. It is stage F of
[AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md), brought forward.

## What replaced what

Every AWS service bizinsights used, and what does its job on the server. Nothing in the last column
is an AWS service; the two rows marked **still AWS** are the ties below.

| AWS service | Its job | On the server |
| --- | --- | --- |
| Lambda (`api`, `jobs`, `cron`) | The app, the background jobs, the timed jobs | Two containers of the same code: `web` and `worker` (Node.js, Hono) |
| SQS (5 queues, a dead-letter queue) | Job queue | A queue in PostgreSQL (`pgQueues.ts`) |
| EventBridge Scheduler | Timed jobs | Schedules in the worker (`schedules.ts`) |
| DynamoDB | Rate limits, sign-in state, locks | A PostgreSQL table (`pgCoord.ts`) |
| RDS PostgreSQL | All the data | PostgreSQL 17 in a container |
| RDS snapshots, AWS's backups | Backups | pgBackRest, encrypted, with a restore test. **Still AWS:** the bucket it writes to |
| S3 | Webhook bodies waiting for their job, the built pages | A folder on the server; pages served by `web` |
| Cognito | Sign-in: passwords, emailed codes, Google, two-step verification | The app's own sign-in (`localAuth.ts`: argon2id passwords, six-digit emailed codes, authenticator-app codes in `totp.ts`). **Still AWS:** until `AUTH_MODE=local` |
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

Counted on the server on 2026-11-13 (`admin sign-in-move`, below).

| Tie | What breaks if AWS goes first | What cuts it |
| --- | --- | --- |
| **Sign-in**: `AUTH_MODE=migrating`. Cognito checks the password of 4 of the 5 people who have one (the fifth has signed in since 2026-11-08, so the app has theirs), and carries Google sign-in for the 4 who use it | Those 4 can't sign in with their password until they reset it; the 4 Google users can't sign in at all | [Sign-in off Cognito](#sign-in-off-cognito) |
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
4. `env/app.env`: `AUTH_MODE=local`, the `COGNITO_*` lines and the two `AWS_*` keys emptied, then
   `docker compose up -d web worker`. Sign in with a password, an emailed code and Google, and
   reset a password. Anyone whose browser still held a session from Cognito (signed in before
   2026-11-08 and not since) is asked to sign in again.
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

## What is in the account (2026-11-13)

Sydney unless said: the stacks `InsightsApp`, `InsightsData`, `InsightsAuth`, `InsightsWhatsapp`,
`InsightsAudit`, `InsightsCi` and `CDKToolkit`, and in us-east-1 `InsightsEdge` and `CDKToolkit`;
the database `insights-production` (deletion protection on) and one manual snapshot,
`insights-production-pre-table-drop-20261112`; 16 functions; 9 buckets; the user pool
`insights-production`; two EC2 instances (a NAT instance running, the admin host stopped); the IAM
users `bizinsights-ikorex` (the server's Cognito calls) and `bizinsights-backups`.

## The order

Deleting is the one step of the move with no way back: after part 1 a rollback to AWS is no longer
possible, and the server and its backups are the only copy of the data.

**Part 1, needs nothing above** (this is nearly all of the bill): the WhatsApp stack; the App stack
(functions, queues, schedules, the coordinator table, the payload and site buckets); the Edge stack
(CloudFront, the WAF); the Data stack after a last dump of both RDS databases is kept off AWS (the
database, its snapshots, the NAT instance, the admin host); the CI stack and the GitHub deploy role;
CloudWatch log groups and alarms; Secrets Manager and the runtime parameters; GuardDuty, the budget,
CloudTrail and its bucket. With it, in the repository: `.github/workflows/aws-deploy.yml`,
`infra/cdk`, the Lambda entry point and the adapters only it loads.

**Part 2, after `AUTH_MODE=local`:** the Auth stack (the user pool, `auth.bizinsights.io` and its
record at Cloudflare, the `cognito-email` function and its KMS key) and the IAM user
`bizinsights-ikorex`; in the repository, `cognito.ts`, `migratingAuth.ts` and the Cognito stand-in
of the tests.

**Part 3, after the backups are in R2:** the bucket `bizinsights-backups-605411278365`, its IAM
user and the passphrase's parameter.

**Last:** `node scripts/aws-dependency-scan.mjs --none-left` passes, and the owner closes the
account in the AWS console (Account → Close account).
