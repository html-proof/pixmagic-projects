# What in the repository still uses AWS

The owner's brief of 2026-11-08 asks for a scan of the whole repository for AWS left behind, keeping
"harmless historical documentation" apart from code that runs, calls or configures AWS. Its
acceptance criterion: *no executable AWS dependency remains*. This page is that scan, and
[`scripts/aws-dependency-scan.mjs`](../../scripts/aws-dependency-scan.mjs) runs it again whenever
needed:

```bash
node scripts/aws-dependency-scan.mjs
```

That prints the full list, file by file. `--check` (part of `pnpm lint`, so CI runs it) fails when a
file outside the list below starts using AWS: while the move is under way, new code goes through the
provider's interface (`Queues`, `Coord`, `BlobStore`, `Mailer`, `SmsProvider`, `CognitoAuth`), not
to AWS. `--none-left` fails while any file still uses AWS: it is stage F's check, and replaces
`--check` in `pnpm lint` once the last group below is gone.

What counts: AWS's libraries (`aws4fetch`, `@aws-crypto/*`, `aws-cdk-lib`), its endpoints
(`*.amazonaws.com`, `cognito-idp`), request signing (`X-Amz-*`), resource names (`arn:aws:`) and
settings (`AWS_*`, `COGNITO_*`, `SES_REGION`, `SMS_EVENTS_QUEUE_URL`, `*_SECRET_ARN`). A line that is
only a comment doesn't count. Markdown and `docs/` don't count: they describe AWS, they run nothing.

## Result, 2026-11-08 (`main` at e3f7811b)

**90 files, 474 lines.** Documentation that names AWS's settings or endpoints, not counted: 30 files.
No file of the app uses the AWS SDK: the AWS code signs its own requests with `aws4fetch`, and every
AWS service sits behind one of the interfaces above. The SDK appears only in infrastructure code
that runs inside AWS, the inline functions of `infra/cdk/lib/migrate-before-live.ts` and
`whatsapp-stack.ts`, which go at stage F.

| Group | Files | Lines | Goes |
| --- | --- | --- | --- |
| AWS's infrastructure and its deploy (`infra/cdk`, `infra/aws`, `aws-deploy.yml`) | 24 | 240 | Stage F, with the resources it describes |
| The Lambda functions and the AWS adapters only they load (`index.ts`, `cognitoEmail.ts`, `dynamoCoord.ts`, `s3Blobs.ts`, `secrets.ts`, their tests) | 15 | 70 | Stage F, with the functions |
| AWS code the server loads, used only when a switch says so | 10 | 29 | Each when its switch is on the AWS-free side, then deleted at stage F |
| Cognito in the app, its settings and its test stand-in (`cognito-local` in the e2e suite) | 23 | 109 | After `AUTH_MODE=local` |
| SMS records shaped by AWS (sender ARNs, AWS's registration states, the SMS region) | 12 | 15 | After `SMS_PROVIDER=twilio` |
| Lambda's version number in `/api/version` | 2 | 3 | Stage F |
| The migration's own tools (`infra/ikorex/scripts`: the copies, the secrets export) | 4 | 8 | Stage F, after the final dump of RDS |

## What the server would call on AWS

The server's bundle (`apps/aws/src/server.ts` and `admin.ts`, built by `build-server.mjs`) loads
`awsClient.ts`, `sesMailer.ts`, `smsProvider.ts`, `sqsBridge.ts` and `sqsQueues.ts`, and reaches
Cognito through `apps/api/src/cognito.ts`. None of them is called unless a setting asks for it:

| Setting on the server | Calls AWS | AWS-free value | When |
| --- | --- | --- | --- |
| `AUTH_MODE` | `migrating`: Cognito checks a user's password once, the first time they sign in after the switch | `local` | Before stage F ([ROLLBACK_PLAN.md](ROLLBACK_PLAN.md), "Before stage F starts", step 3) |
| `SMS_PROVIDER` | `aws` (the default): End User Messaging SMS | `twilio` | When the owner's Twilio account is ready ([docs/sms.md](../sms.md), "Switching to Twilio") |
| `SMS_EVENTS_QUEUE_URL` | Set: reads SMS delivery events from AWS's queue | Unset | With `SMS_PROVIDER=twilio` |
| `SES_REGION` | Set and no Resend key: sends email through SES | Unset (Resend sends everything) | Already: the server's env file doesn't set it |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The IAM user's keys the four above use | Empty | With the last of the four |

So the server **starts and runs without AWS credentials** once `AUTH_MODE=local` and
`SMS_PROVIDER=twilio`: the AWS code is still in the bundle, but never called. It is deleted at stage F
(below), and `--none-left` is the proof.

Two smaller findings:

- **`/api/version`'s `release`** is Lambda's version number (`AWS_LAMBDA_FUNCTION_VERSION`), so it is
  empty on the server. The commit identifies the build there: the server's `deploy.sh` checks
  `/api/version` names the commit it deployed, and only AWS's smoke test (`smoke.mjs`) reads
  `release`.
- **SMS records are shaped by AWS**: a sender is an `arn:aws:sms-voice:…` ARN, its registration
  states are AWS's (`AWS_REVIEWING`), and `smsRegion` falls back to `AWS_REGION`. Twilio's provider
  (#354) fits into those shapes. The rows already stored keep their ARNs, as a record of what was
  set up on AWS. They describe; they call nothing.

## Stage F: removing the code

After the AWS side of each step in [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md) ("Order of
decommissioning"), one pull request each, so each can be undone alone:

1. **SMS**, once `SMS_PROVIDER=twilio` has run through the rollback period: delete `smsProvider.ts`,
   `sqsBridge.ts` and its `SmsEventsUnread` alert, `SMS_EVENTS_QUEUE_URL`; Twilio becomes the
   default, and the SMS screens stop offering AWS's sender ARNs.
2. **Sign-in**, once `AUTH_MODE=local`: delete `apps/api/src/cognito.ts`, `migratingAuth.ts`, the
   `COGNITO_*` settings (`packages/core/src/env.ts`, `configReport.ts`), `infra/cognito-local` and the
   e2e suite's Cognito stand-in, and `aws4fetch` from `apps/api`; `AUTH_MODE` keeps only `local`.
3. **The rest, with the resources**: `infra/cdk`, `infra/aws`, `.github/workflows/aws-deploy.yml`
   and the deploy role's trust, the Lambda entry point and the adapters only it loads, `awsClient.ts`,
   `sesMailer.ts`, `aws4fetch` and `@aws-crypto/client-node` from `apps/aws`, the `AWS_*` keys in
   `infra/ikorex/env/app.env.example`, Lambda's version in `/api/version`, and the migration's own
   tools once the final dump of RDS is in R2.
4. **Last**: `pnpm lint` runs `--none-left` instead of `--check`. What still mentions AWS is history
   in `docs/`.
