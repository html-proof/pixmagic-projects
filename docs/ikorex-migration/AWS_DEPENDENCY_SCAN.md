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
provider's interface (`Queues`, `Coord`, `BlobStore`, `Mailer`, `CognitoAuth`), not to AWS.
`--none-left` fails while any file still uses AWS: it is stage F's check, and replaces `--check` in
`pnpm lint` once the last group below is gone.

What counts: AWS's libraries (`aws4fetch`, `@aws-crypto/*`, `aws-cdk-lib`), its endpoints
(`*.amazonaws.com`, `cognito-idp`), request signing (`X-Amz-*`), resource names (`arn:aws:`) and
settings (`AWS_*`, `COGNITO_*`, `SES_REGION`, `SES_CONFIGURATION_SET`, `*_SECRET_ARN`). A line that is
only a comment doesn't count. Markdown and `docs/` don't count: they describe AWS, they run nothing.

## Result after AWS's deploy code was removed (2026-11-13, evening)

**43 files, 196 lines.** Gone with AWS's side ([LEAVING_AWS.md](LEAVING_AWS.md)): the first two
groups of the table below, that is `infra/cdk`, `.github/workflows/aws-deploy.yml`, the Lambda entry
point and the adapters only it loaded, with their tests and the Lambda build. No file uses the AWS
SDK any more. What is left:

| Group | Files | Lines | Goes |
| --- | --- | --- | --- |
| The user pool's template (`infra/aws/cognito.yaml`, the Auth stack) | 1 | 9 | With Cognito, after `AUTH_MODE=local` |
| The server package's AWS dependency, example settings and tests | 6 | 22 | With the next group |
| AWS code the server loads, used only when a switch says so | 7 | 23 | Each when its switch is on the AWS-free side, then deleted |
| Cognito in the app, its settings and its test stand-in | 22 | 108 | After `AUTH_MODE=local` |
| Lambda's version number in `/api/version` | 2 | 3 | With the last of the above |
| The migration's own tools (`infra/ikorex/scripts`) | 5 | 31 | With the last of the above: RDS is gone, so the copies have nothing to copy |

## Result, 2026-11-13, before that (`main` at 2cc436eb with Customer Messaging (SMS) and the email module removed)

**79 files, 502 lines.** Documentation that names AWS's settings or endpoints, not counted: 34 files.
No file of the app uses the AWS SDK: the AWS code signs its own requests with `aws4fetch`, and every
AWS service sits behind one of the interfaces above. The SDK appears only in infrastructure code
that runs inside AWS, the inline functions of `infra/cdk/lib/migrate-before-live.ts`,
`secret-parameters.ts` and `whatsapp-stack.ts`, which go at stage F.

| Group | Files | Lines | Goes |
| --- | --- | --- | --- |
| AWS's infrastructure and its deploy (`infra/cdk`, `infra/aws`, `aws-deploy.yml`) | 27 | 266 | Stage F, with the resources it describes |
| The Lambda functions and the AWS adapters only they load (`index.ts`, `cognitoEmail.ts`, `dynamoCoord.ts`, `s3Blobs.ts`, `secrets.ts`, their tests) | 16 | 71 | Stage F, with the functions |
| AWS code the server loads, used only when a switch says so | 7 | 23 | Each when its switch is on the AWS-free side, then deleted at stage F |
| Cognito in the app, its settings and its test stand-in (`cognito-local` in the e2e suite) | 22 | 108 | After `AUTH_MODE=local` |
| Lambda's version number in `/api/version` | 2 | 3 | Stage F |
| The migration's own tools (`infra/ikorex/scripts`: the copies, the secrets export) | 5 | 31 | Stage F, after the final dump of RDS |

The first scan (2026-11-08, `main` at e3f7811b) found 90 files and 474 lines. It had one more group,
"SMS records shaped by AWS" (12 files), and the server's bundle held `smsProvider.ts` and
`sqsBridge.ts`. Those went on 2026-11-13, when Customer Messaging (SMS) was removed from the app:
no SMS code is left to move or to delete at stage F.

## What the server would call on AWS

The server's bundle (`apps/aws/src/server.ts` and `admin.ts`, built by `build-server.mjs`) loads
`awsClient.ts` and `sesMailer.ts`, and reaches Cognito through `apps/api/src/cognito.ts`. None of
them is called unless a setting asks for it:

| Setting on the server | Calls AWS | AWS-free value | When |
| --- | --- | --- | --- |
| `AUTH_MODE` | `migrating`: Cognito checks a user's password once, the first time they sign in after the switch | `local` | Before stage F ([ROLLBACK_PLAN.md](ROLLBACK_PLAN.md), "Before stage F starts", step 3) |
| `SES_REGION` | Set and no Resend key: sends email through SES | Unset (Resend sends everything) | Already: the server's env file doesn't set it |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The IAM user's keys the two above use | Empty | With the last of the two |

So the server **starts and runs without AWS credentials** once `AUTH_MODE=local`: the AWS code is
still in the bundle, but never called. It is deleted at stage F (below), and `--none-left` is the
proof.

One smaller finding:

- **`/api/version`'s `release`** is Lambda's version number (`AWS_LAMBDA_FUNCTION_VERSION`), so it is
  empty on the server. The commit identifies the build there: the server's `deploy.sh` checks
  `/api/version` names the commit it deployed, and only AWS's smoke test (`smoke.mjs`) reads
  `release`.

## Stage F: removing the code

After the AWS side of each step in [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md) ("Order of
decommissioning"), one pull request each, so each can be undone alone:

1. **Sign-in**, once `AUTH_MODE=local`: delete `apps/api/src/cognito.ts`, `migratingAuth.ts`, the
   `COGNITO_*` settings (`packages/core/src/env.ts`, `configReport.ts`), `infra/cognito-local` and the
   e2e suite's Cognito stand-in, and `aws4fetch` from `apps/api`; `AUTH_MODE` keeps only `local`.
2. **The rest, with the resources.** Done on 2026-11-13: `infra/cdk`,
   `.github/workflows/aws-deploy.yml`, the Lambda entry point and the adapters only it loaded,
   `@aws-crypto/client-node`. Still to go, with step 1 or after it: `infra/aws`, `awsClient.ts`,
   `sesMailer.ts` (SES has no sending identity left) and `aws4fetch` from `apps/aws`, the `AWS_*`
   keys in `infra/ikorex/env/app.env.example`, Lambda's version in `/api/version`, and the
   migration's own tools.
3. **Last**: `pnpm lint` runs `--none-left` instead of `--check`. What still mentions AWS is history
   in `docs/`.
