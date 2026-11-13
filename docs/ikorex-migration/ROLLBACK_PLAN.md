# Rollback plan: iKorex migration

The rule that makes rollback possible: **AWS keeps running, untouched, until stage F**, and stage F
waits for the owner's separate approval after a 14-day rollback period. Stage F ends with the AWS
account closed (decision 4b, owner 2026-11-07), so it is the one stage with no way back: everything
it needs is checked before it starts. Stages:
[AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md).

| Stage | If it goes wrong | How to undo | Data at risk |
| --- | --- | --- | --- |
| A (code) | A change breaks the AWS deploy | Revert the pull request; Deploy to AWS rolls itself back on failed checks | None |
| Own sign-in (`AUTH_MODE=migrating`, before the cutover) | Sign-in misbehaves | Fix forward. Going back to `cognito` locks out everyone who signed up since (their account exists only in the app) and anyone who changed their password since, so it is a last resort | None: Cognito keeps everyone who hasn't moved |
| B (staging on iKorex) | The other workloads slow down or misbehave | `docker compose -p bizinsights-staging down` stops everything bizinsights runs; nothing else on the server was changed | None (a copy) |
| C (backups, monitoring) | Same as B | Same as B | None |
| D, before step 5 (DNS not moved) | A check fails | Stop: schedules back on at AWS, webhooks answered again; iKorex discarded | None: AWS still has every write |
| D, after step 5, before any new write on iKorex | Smoke tests fail | Cloudflare: `bizinsights.io` back to CloudFront (seconds); `SCHEDULES=off` on iKorex; schedules on at AWS | None |
| D/E, after writes on iKorex | A problem found hours or days later | A second short window, in reverse ([the copy back](#the-copy-back-de-after-writes-on-ikorex), below): `SCHEDULES=off` on iKorex, then `copy-db-back.mjs --rollback --replace` (freeze, dump on iKorex, restore into RDS, compare table by table), DNS back to CloudFront, schedules and WhatsApp on at AWS. The copy carries the app's own sign-in accounts, so whoever moved over signs in on AWS as before | None if done in a window; the copy back carries every write made on iKorex |
| F (decommission and closure) | Something still needed AWS | Before the account closes: each resource goes one at a time, in the order below, and a stack can be recreated with `cdk deploy` from the last AWS commit. After it closes: AWS keeps a closed account 90 days and the owner can reopen it in that time, but nothing left in it is counted on; the server and its R2 backups are the only copy | The final dump in R2 is the last copy of AWS's database: checked (restored and counted) before anything is deleted |

## The copy back (D/E, after writes on iKorex)

Through the 14-day rollback period AWS stays deployed and idle: its schedules off (GitHub variable
`AWS_SCHEDULES=off`) and its WhatsApp service with no task (`AWS_WHATSAPP=off`, cutover step 2), so
nothing on AWS writes to RDS or holds a WhatsApp session. Going back, in a window announced like the
cutover's:

1. On the server: schedules off, so nothing new is queued
   (`cd ~/bizinsights && sed -i 's/^SCHEDULES=.*/SCHEDULES=off/' .env && docker compose -p bizinsights up -d worker`).
2. On the owner's PC, signed in to AWS: `node infra/ikorex/scripts/copy-db-back.mjs --rollback --replace`.
   It snapshots RDS first, stops the server's web, lets the worker drain the queue, stops worker and
   evolution, dumps both databases straight into the bucket, restores them over RDS's from the admin
   host, runs the cron function's `migrate`, and compares table by table before and after it
   ([DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md#the-way-back-copy-db-backmjs)). If
   anything fails after the server stopped, it starts the server again: DNS still points at it, so
   the site is back as it was and nothing was lost.
3. Cloudflare: `bizinsights.io` and `www` back to CloudFront (proxied, seconds).
4. AWS: `AWS_SCHEDULES` and `AWS_WHATSAPP` back to `on` (or unset) and Deploy to AWS run again;
   for WhatsApp at once, `aws ecs update-service --cluster insights-production-whatsapp --service
   insights-production-evolution-a --desired-count 1`.
5. Smoke tests (`node infra/cdk/scripts/smoke.mjs --env production`), a sign-in, a test webhook,
   the WhatsApp numbers connected.

Webhooks sent while the server was stopped are retried by their senders and reach AWS once DNS is
back (Shopify for hours). The coordinator's short-lived items (rate limits, one-time
sign-in states) are not copied back: someone mid-way through connecting an account starts again.
RDS as it was before the copy stays as the snapshot `insights-production-before-rollback-<time>`
until stage F.

## Before stage F starts

Checked and written down in [MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md):

1. The 14-day rollback period has passed with no rollback, and the owner approves stage F.
2. Nothing calls AWS any more apart from sign-in (step 3), and the cost email is gone with the AWS
   bill. (Customer Messaging (SMS) was removed on 2026-11-13, so there is no SMS provider to switch.)
3. Sign-in: everyone who has a Cognito password but no account in the app yet is emailed a password
   reset by the app (their `auth_identities` row stays, so the reset or Google brings them in under
   the same sub); then `AUTH_MODE=local` on the server and a sign-in by password, emailed code and
   Google. Google must already be on the app's own client (`GOOGLE_SIGNIN_CLIENT_ID`), or Google
   users lose their way in with Cognito.
4. A final `pg_dump` of both RDS databases (`app`, `evolution`), encrypted, in R2, restored once into
   a scratch PostgreSQL and its row counts compared. Snapshots can't leave AWS, so this dump is what
   remains of RDS.

## Order of decommissioning (stage F)

1. Schedules (already off), then the `api`/`jobs`/`cron` functions, every SQS queue and the
   dead-letter queue, and the SNS alarm topic.
2. CloudFront distributions and the WAF.
3. The WhatsApp service, Cloud Map and the private DNS zone.
4. RDS, after the final dump above; then its snapshots, including the three the owner kept on
   2026-10-29 and any `-before-rollback-` one a copy back made (they can't leave AWS: the owner
   says yes to each one).
5. NAT instances, admin host, their snapshots; DynamoDB; S3 buckets (after their contents are
   copied off).
6. Cognito: the user pool, its `auth.bizinsights.io` domain (and the record in Cloudflare), the
   `cognito-email` function and its KMS key; anything registered by hand in End User Messaging SMS
   (its configuration set and event destination went with Customer Messaging (SMS), removed
   2026-11-13).
7. Secrets Manager secrets and the runtime parameter, the `bizinsights-ikorex` IAM user and the
   GitHub deploy role; CloudTrail and its bucket, the budget, GuardDuty.
8. The owner closes the account in the AWS console (Account → Close account): theirs to do. The last
   bill arrives the month after.

## Rehearsed before cutover

- Restore of the latest off-server backup into a fresh container (stage C, weekly after that).
- The DNS switch and its reverse, on `staging.bizinsights.io`.
- The copy back, timed, as a full-size round trip: `copy-db.mjs --rehearsal --keep` (production's
  copy kept in the staging project), then `copy-db-back.mjs --rehearsal` (that copy into throwaway
  databases on RDS, compared, dropped). Built and tested against PostgreSQL on the owner's PC
  (2026-11-08, [DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md#the-way-back-copy-db-backmjs));
  its first run against RDS and the server is stage B's.
