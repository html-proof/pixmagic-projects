# Rollback plan: iKorex migration

The rule that makes rollback possible: **AWS keeps running, untouched, until stage F**, and stage F
waits for the owner's separate approval after a 14-day rollback period. Stages:
[AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md).

| Stage | If it goes wrong | How to undo | Data at risk |
| --- | --- | --- | --- |
| A (code) | A change breaks the AWS deploy | Revert the pull request; Deploy to AWS rolls itself back on failed checks | None |
| B (staging on iKorex) | The other workloads slow down or misbehave | `docker compose -p bizinsights-staging down` stops everything bizinsights runs; nothing else on the server was changed | None (a copy) |
| C (backups, monitoring) | Same as B | Same as B | None |
| D, before step 5 (DNS not moved) | A check fails | Stop: schedules back on at AWS, webhooks answered again; iKorex discarded | None: AWS still has every write |
| D, after step 5, before any new write on iKorex | Smoke tests fail | Cloudflare: `bizinsights.io` back to CloudFront (seconds); `SCHEDULES=off` on iKorex (it also stops reading SMS events); schedules and the `jobs` function's `smsEvents` trigger on at AWS | None |
| D/E, after writes on iKorex | A problem found hours or days later | A second short window, in reverse: freeze, `pg_dump` from iKorex, restore into RDS, compare counts, DNS back to CloudFront, `SCHEDULES=off` on iKorex, schedules and the `smsEvents` trigger on at AWS | None if done in a window; the reverse copy carries every write made on iKorex |
| F (decommission) | Something still needed AWS | Each resource goes one at a time, in the order below, with a final snapshot of the database kept; recreating a stack is `cdk deploy` from the last AWS commit | None: final RDS snapshot kept until the owner says otherwise |

## Order of decommissioning (stage F)

1. Schedules (already off), then the `api`/`jobs`/`cron` functions and SQS, except the `smsEvents`
   queue, the dead-letter queue it uses and its topic: SMS stays on AWS, and its delivery events
   reach the server through them.
2. CloudFront distributions and the WAF.
3. The WhatsApp service, Cloud Map and the private DNS zone.
4. RDS: a final manual snapshot first, kept; the three manual snapshots the owner kept on 2026-10-29
   stay until the owner decides.
5. NAT instances, admin host, their snapshots; DynamoDB; S3 buckets (after their contents are
   copied off).
6. The Secrets Manager secrets not used by Cognito's email function.
7. GuardDuty.

What stays (Cognito and its email function, SMS if kept, CloudTrail, the budget) is listed in
[AWS_COST_COMPARISON.md](AWS_COST_COMPARISON.md). The AWS account and its billing history are never
deleted.

## Rehearsed before cutover

- Restore of the latest off-server backup into a fresh container (stage C, weekly after that).
- The DNS switch and its reverse, on `staging.bizinsights.io`.
- The reverse database copy (iKorex → a throwaway RDS-like PostgreSQL), timed. `copy-db.sh` dumps
  and restores in either direction; its driver for this direction is still to write
  ([DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md), "Open before stage D").
