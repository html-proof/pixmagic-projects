# Secrets Manager → Parameter Store (change 7)

Last updated **2026-11-12**. Status of every cost change: [MIGRATION_STATUS.md](MIGRATION_STATUS.md).

Secrets Manager charges US$0.40 a month for each secret, used or not, plus US$0.05 per 10,000
reads: **US$2.97 a month** for bizinsights' seven, ~3.27 with GST. Parameter Store keeps the same
text encrypted (a `SecureString`, under AWS's own key for Parameter Store) for nothing in its
standard tier. Nothing here uses what Secrets Manager adds for the money (automatic rotation,
replication, versions by stage).

No secret's value changes at any step, and the app is never without its secrets: the move is three
releases, each of which can be undone by reverting its pull request.

## What moves

All seven, in Sydney. Each parameter is named like its secret after a slash and holds the same
text, so nothing that reads one has to learn a new shape.

| Secret | Parameter | Read by | How it is read today |
| --- | --- | --- | --- |
| `insights/production/app` (18 keys, 1,201 characters) | `/insights/production/app` | api, jobs, cron, cognito-email; the admin host | Cold start (`apps/aws/src/secrets.ts`). Two keys also at deploy time: `ORIGIN_VERIFY` (CloudFront's origin header) and `GOOGLE_SIGNIN_CLIENT_SECRET` (Cognito's Google provider) |
| `insights/production/db-owner` | `/insights/production/db-owner` | cron; the admin host | Cold start. RDS made it with the database; CloudFormation gives the instance its password from it |
| `insights/production/db-system` | `/insights/production/db-system` | api, jobs, cron; the admin host | Cold start |
| `insights/production/worker-cognito` | `/insights/production/worker-cognito` | api | Cold start. Made by `infra/aws/cognito.yaml` from the app client's secret |
| `insights/production/evolution-api` | `/insights/production/evolution-api` | api, jobs, cron; the WhatsApp task | Cold start; the task as an ECS secret |
| `insights/production/evolution-db` | `/insights/production/evolution-db` | cron; the WhatsApp task | Cold start; the task as an ECS secret |
| `insights/production/origin-lock` (plain text, no JSON) | `/insights/production/origin-lock` | No function | Deploy time only: inlined in CloudFront's viewer-request function |

A standard parameter holds 4,096 characters. The largest secret, `app`, is 1,201 with 18 keys of at
most 64 characters each, so it has room for about 40 more. `put-secrets.mjs` refuses a change that
would pass the limit, and the copier fails the release rather than write an advanced parameter
(US$0.05 a month).

## What stood in the way

1. **CloudFormation can't create a SecureString parameter.** A custom resource does it:
   `infra/cdk/lib/secret-parameters.ts`, a small function the App stack calls on every release.
2. **`{{resolve:ssm-secure:…}}` works in a short list of properties only**: an RDS instance's
   password is on it; a CloudFront origin header, a CloudFront function's source and a Cognito
   identity provider's client secret are not. The three values read at deploy time (`ORIGIN_VERIFY`,
   the origin lock, `GOOGLE_SIGNIN_CLIENT_SECRET`) therefore need a second custom resource in step 2:
   it reads the parameter and hands the value to CloudFormation with `NoEcho`. None of the seven has
   to stay in Secrets Manager for this, so the saving is the whole US$2.97.
3. **The database passwords must not change.** Nothing is generated again: the copier writes the
   secret's text, character for character, and writes nothing when the parameter already equals it.
4. **The EC2 instances could have read every parameter.** The NAT instance and the admin host carry
   AWS's `AmazonSSMManagedInstanceCore` policy (how Systems Manager reaches them), which allows
   `ssm:GetParameter` on every parameter in the account. In Secrets Manager the NAT instance could
   read no secret and the admin host three. Both roles now carry an explicit Deny on the secrets'
   parameters (all seven for the NAT instance; all but `app`, `db-owner`, `db-system` for the admin
   host), which wins over the managed policy's Allow.
5. **Two secrets would have been deleted outright with their resource.** CloudFormation deletes a
   secret with no recovery window. Five were already kept on removal (`RemovalPolicy.RETAIN`);
   `db-owner` and `worker-cognito` are now too. The policy in force is the last deployed one, so
   this had to ship a release before the one that removes them.
6. **The App and WhatsApp stacks import the secrets' ARNs from the Data stack.** CloudFormation
   refuses to drop an export another stack still imports, and `cdk deploy --all` deploys Data
   first. So the release that stops importing them (step 2) can't also remove them (step 3).

## The three steps

### Step 1: copies, read first (live 2026-11-12, release 186, #384)

- **Copier.** `Custom::SecretParameters` in the App stack runs on every release, before the `live`
  aliases move. For each secret: no parameter → created; the same text → nothing written; different
  and the secret is the newer → updated; different and the parameter is the newer → kept. The App
  stack's output `SecretCopies` says which, by name ("app: same, db-owner: same, …"). It never
  logs or returns a value, and reports an AWS error by its name only. A failure fails the release
  before anything goes live; on a CloudFormation rollback it is reported and passed over.
- **Functions.** `loadSecrets` reads `/insights/<env>/<name>` (decrypted) first and the secret
  itself when the parameter is missing, refused or not the secret's JSON. Each cold start logs one
  line, `secrets loaded`, with which store answered for each secret (`"parameter"` or `"secret"`),
  and a warning per fallback with AWS's error name.
- **`put-secrets.mjs`** writes a change to both: the secret, then its parameter. Its commands are
  unchanged.
- **Still on Secrets Manager**: the three deploy-time reads, the WhatsApp task's ECS secrets, the
  database instance's password reference, the scripts that read `db-owner` on the admin host
  (`migrate-data.mjs`, `infra/ikorex/scripts/copy-db*.mjs`, `export-env.mjs`), and the runbook's
  origin-lock commands. The secret is the source of truth until step 2.

Nothing is saved yet: all seven secrets still exist and are still billed.

**As deployed** (checked 2026-11-12 after release 186): `SecretCopies` read `created` for all
seven; each parameter is a `SecureString` in the standard tier under `alias/aws/ssm` and equal to
its secret; the api and the cron read every one of theirs from the parameters (the cron first in
the migrate gate's run, before the release went live), with no fallback warning and no error. The
NAT role is refused all seven and the admin host all but its three (IAM's policy simulator). The
jobs and cognito-email functions had not started a new instance by then: look for their
`secrets loaded` line before step 2.

**Check after the Deploy** (values are never printed):

```powershell
aws cloudformation describe-stacks --stack-name InsightsApp-production --region ap-southeast-2 --query "Stacks[0].Outputs[?OutputKey=='SecretCopies'].OutputValue" --output text
```

```powershell
aws logs filter-log-events --log-group-name /aws/lambda/insights-production-api --region ap-southeast-2 --filter-pattern '\"secrets loaded\"' --max-items 5 --query "events[].message" --output text
```

Every secret in the second answer should read `parameter`. `node infra/cdk/scripts/compare-secret-copies.mjs`
compares each secret with its parameter and prints `equal` or `NOT EQUAL` per name, nothing else.

### Step 2: nothing reads Secrets Manager (next pull request)

Not before step 1 has run a week (to about 2026-11-19) with every `secrets loaded` line on
`parameter`, in all four functions, and no fallback warning ([ROLLBACK_PLAN.md](ROLLBACK_PLAN.md),
change 7).

1. `loadSecrets` reads the parameters only; the functions lose `secretsmanager:GetSecretValue`.
2. A reader custom resource (answering with `NoEcho`, run on every release so a changed value
   reaches CloudFront and Cognito with the next deploy) gives CloudFormation `ORIGIN_VERIFY`, the
   origin lock and `GOOGLE_SIGNIN_CLIENT_SECRET` from the parameters. CloudFront's distribution and
   function and Cognito's Google provider are updated in place with the same values; check that the
   provider framework's log shows the answer redacted before merging.
3. The WhatsApp task takes its three values from Parameter Store. An ECS secret from Parameter
   Store is the whole parameter (the `:KEY::` form is Secrets Manager's), so either its start
   command picks the keys out of the JSON, or three single-value parameters are written for it.
4. The database instance's password becomes `{{resolve:ssm-secure:/insights/production/db-owner…}}`
   (a property where CloudFormation allows it) of a single-value parameter. CloudFormation then sets
   the owner's password to the value it already has: no restart, no new password. The least
   reversible part of the move, so last within this step, and it can be left out for US$0.40 a month.
5. `put-secrets.mjs`, the admin host's scripts and the runbook's commands
   ([aws-deployment.md](../aws-deployment.md): "Giving Cloudflare the secret", "A new value") read
   and write the parameters. New values for a new environment come from a custom resource that
   writes a random one only where the parameter is missing (what `generateSecretString` does today).
6. The copier goes. The secrets stay in their stacks, unread, and the Data stack keeps exporting
   their ARNs (`exportValue`) so the stacks can be untangled in step 3.

### Step 3: the secrets go (third pull request)

1. The seven `AWS::SecretsManager::Secret` resources (and `db-owner`'s attachment) leave the
   templates. All are kept on removal, so CloudFormation deletes none of them.
2. A custom resource schedules each for deletion with a **30-day recovery window**
   (`DeleteSecret`, `RecoveryWindowInDays: 30`). Billing for a secret stops the day it is
   scheduled; `aws secretsmanager restore-secret --secret-id <name>` brings one back within the 30
   days, with its value.
3. The saving, US$2.97 a month before GST, shows on the Bills page under Secrets Manager from the
   next day; record the measured figure here and in [MIGRATION_STATUS.md](MIGRATION_STATUS.md).

## Undoing a step

| Step | Undo | What is left behind |
| --- | --- | --- |
| 1 | Revert the pull request: the functions read Secrets Manager only again | The seven parameters (free; delete them by hand or leave them) |
| 2 | Revert the pull request. The secrets are still there with the same values, unless a value was changed in the parameter since: copy that one back first | — |
| 3 | `restore-secret` for each secret within 30 days, then revert the pull request | After 30 days the secrets are gone; the parameters hold the values |
