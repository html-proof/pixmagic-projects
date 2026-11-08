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
| SMS on Twilio (`SMS_PROVIDER=twilio`, before the cutover) | Texts fail | `SMS_PROVIDER` back to `aws` in `apps/aws/src/settings.ts` (a pull request); AWS's sender, configuration set and events queue are still there | None: each text's outcome is in the app |
| B (staging on iKorex) | The other workloads slow down or misbehave | `docker compose -p bizinsights-staging down` stops everything bizinsights runs; nothing else on the server was changed | None (a copy) |
| C (backups, monitoring) | Same as B | Same as B | None |
| D, before step 5 (DNS not moved) | A check fails | Stop: schedules back on at AWS, webhooks answered again; iKorex discarded | None: AWS still has every write |
| D, after step 5, before any new write on iKorex | Smoke tests fail | Cloudflare: `bizinsights.io` back to CloudFront (seconds); `SCHEDULES=off` on iKorex; schedules on at AWS (and, if SMS is still on AWS, the `jobs` function's `smsEvents` trigger) | None |
| D/E, after writes on iKorex | A problem found hours or days later | A second short window, in reverse: freeze, `pg_dump` from iKorex, restore into RDS, compare counts, DNS back to CloudFront, `SCHEDULES=off` on iKorex, schedules on at AWS. The copy carries the app's own sign-in accounts, so whoever moved over signs in on AWS as before | None if done in a window; the reverse copy carries every write made on iKorex |
| F (decommission and closure) | Something still needed AWS | Before the account closes: each resource goes one at a time, in the order below, and a stack can be recreated with `cdk deploy` from the last AWS commit. After it closes: AWS keeps a closed account 90 days and the owner can reopen it in that time, but nothing left in it is counted on; the server and its R2 backups are the only copy | The final dump in R2 is the last copy of AWS's database: checked (restored and counted) before anything is deleted |

## Before stage F starts

Checked and written down in [MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md):

1. The 14-day rollback period has passed with no rollback, and the owner approves stage F.
2. Nothing calls AWS any more: `SMS_PROVIDER=twilio` on the server (texts, delivery reports and STOP
   replies through Twilio), and the cost email gone with the AWS bill.
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
   dead-letter queue, and the SNS topics (alarms, SMS events).
2. CloudFront distributions and the WAF.
3. The WhatsApp service, Cloud Map and the private DNS zone.
4. RDS, after the final dump above; then its snapshots, including the three the owner kept on
   2026-10-29 (they can't leave AWS: the owner says yes to each one).
5. NAT instances, admin host, their snapshots; DynamoDB; S3 buckets (after their contents are
   copied off).
6. Cognito: the user pool, its `auth.bizinsights.io` domain (and the record in Cloudflare), the
   `cognito-email` function and its KMS key; End User Messaging's sender, configuration set and
   event destination.
7. Secrets Manager secrets and the runtime parameter, the `bizinsights-ikorex` IAM user and the
   GitHub deploy role; CloudTrail and its bucket, the budget, GuardDuty.
8. The owner closes the account in the AWS console (Account → Close account): theirs to do. The last
   bill arrives the month after.

## Rehearsed before cutover

- Restore of the latest off-server backup into a fresh container (stage C, weekly after that).
- The DNS switch and its reverse, on `staging.bizinsights.io`.
- The reverse database copy (iKorex → a throwaway RDS-like PostgreSQL), timed. `copy-db.sh` dumps
  and restores in either direction; its driver for this direction is still to write
  ([DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md), "Open before stage D").
