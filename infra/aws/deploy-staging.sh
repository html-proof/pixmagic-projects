#!/usr/bin/env bash
# Deploy the isolated Phase 1 environment (sign-in on Cognito) to AWS. Run it in AWS CloudShell in
# the target region, from a folder holding: function.zip (pnpm --filter @app/aws build), staging.yaml,
# cognito.yaml and this script. Safe to run again: every step creates or updates in place.
#
#   COMMIT=<git sha> bash deploy-staging.sh
#
# Creates: an S3 bucket for packages, two Secrets Manager secrets (app, Cognito client), the
# insights-auth-staging stack (Cognito user pool, domain, app client) and the insights-staging stack
# (Lambda function URL, RDS PostgreSQL db.t4g.micro, DynamoDB table, logs, alarms). Prints no secret.
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-2}}"
ENVIRONMENT="${ENVIRONMENT:-staging}"
COMMIT="${COMMIT:-$( [ -f COMMIT ] && cat COMMIT || echo unknown )}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
APP_STACK="insights-${ENVIRONMENT}"
AUTH_STACK="insights-auth-${ENVIRONMENT}"
BUCKET="insights-${ENVIRONMENT}-artifacts-${ACCOUNT}-${REGION}"
# The OAuth domain prefix must be unique within the region.
DOMAIN_PREFIX="${DOMAIN_PREFIX:-insights-${ENVIRONMENT}-${ACCOUNT}}"
export AWS_DEFAULT_REGION="$REGION"

for f in function.zip staging.yaml cognito.yaml; do [ -f "$f" ] || { echo "missing $f in $(pwd)" >&2; exit 1; }; done
echo "account ${ACCOUNT}, region ${REGION}, environment ${ENVIRONMENT}, commit ${COMMIT}"

out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
stack_exists() { aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1; }

# 1. Package bucket (private, encrypted) and the package.
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{Key=app,Value=insights},{Key=environment,Value=${ENVIRONMENT}}]"
fi
KEY="function-${COMMIT}-$(date -u +%Y%m%dT%H%M%SZ).zip"
aws s3 cp function.zip "s3://${BUCKET}/${KEY}" --only-show-errors
echo "package: s3://${BUCKET}/${KEY}"

# 2. The app's secrets, generated here once and never shown.
APP_SECRET="insights/${ENVIRONMENT}/app"
if ! aws secretsmanager describe-secret --secret-id "$APP_SECRET" >/dev/null 2>&1; then
  umask 077
  tmp="$(mktemp)"
  python3 - "$tmp" <<'PY'
import base64, json, secrets, sys
json.dump({
    "SESSION_SECRET": secrets.token_urlsafe(48),
    "TOKEN_ENCRYPTION_KEYS": "1:" + base64.b64encode(secrets.token_bytes(32)).decode(),
    "OTP_PEPPER": secrets.token_urlsafe(32),
    "APP_RLS_PASSWORD": secrets.token_urlsafe(32),
}, open(sys.argv[1], "w"))
PY
  aws secretsmanager create-secret --name "$APP_SECRET" --description "Insights ${ENVIRONMENT}: session, encryption and database role secrets" \
    --secret-string "file://${tmp}" --tags "Key=app,Value=insights" "Key=environment,Value=${ENVIRONMENT}" >/dev/null
  rm -f "$tmp"
  echo "created secret ${APP_SECRET}"
fi
APP_SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$APP_SECRET" --query ARN --output text)"

# 3. The default VPC for the database.
VPC="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
[ "$VPC" != "None" ] || { echo "no default VPC in ${REGION}: create one (aws ec2 create-default-vpc) or edit this script" >&2; exit 1; }
SUBNETS="$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC}" --query 'Subnets[].SubnetId' --output text | tr '\t' ',')"

deploy_app() {
  aws cloudformation deploy --stack-name "$APP_STACK" --template-file staging.yaml --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset --tags app=insights "environment=${ENVIRONMENT}" \
    --parameter-overrides "Environment=${ENVIRONMENT}" "CodeBucket=${BUCKET}" "CodeKey=${KEY}" "Commit=${COMMIT}" \
    "VpcId=${VPC}" "SubnetIds=${SUBNETS}" "AppSecretArn=${APP_SECRET_ARN}" "$@"
}

# 4. The app (first time: without Cognito, to learn its URL). The database takes ~10 minutes.
if ! stack_exists "$APP_STACK"; then
  echo "creating ${APP_STACK} (RDS takes about 10 minutes)..."
  deploy_app
fi
APP_URL="$(out "$APP_STACK" FunctionUrl)"
APP_URL="${APP_URL%/}"
echo "app URL: ${APP_URL}"

# 5. Cognito, with the app's callback and logout URLs. No IAM user: the function's role makes the admin calls.
echo "deploying ${AUTH_STACK}..."
aws cloudformation deploy --stack-name "$AUTH_STACK" --template-file cognito.yaml --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset --tags app=insights "environment=${ENVIRONMENT}" \
  --parameter-overrides "Environment=${ENVIRONMENT}" "AppUrl=${APP_URL}" "DomainPrefix=${DOMAIN_PREFIX}" CreateWorkerUser=false
POOL="$(out "$AUTH_STACK" UserPoolId)"
CLIENT="$(out "$AUTH_STACK" ClientId)"
DOMAIN="$(out "$AUTH_STACK" Domain)"
IDPS="$(out "$AUTH_STACK" IdentityProviders)"
COGNITO_SECRET_ARN="$(out "$AUTH_STACK" WorkerSecretsArn)"

# 6. The app again, now wired to Cognito, with this package.
echo "updating ${APP_STACK}..."
deploy_app "AppUrl=${APP_URL}" "CognitoUserPoolId=${POOL}" "CognitoClientId=${CLIENT}" "CognitoDomain=${DOMAIN}" \
  "CognitoIdentityProviders=${IDPS}" "CognitoSecretArn=${COGNITO_SECRET_ARN}"
FUNCTION="$(out "$APP_STACK" FunctionName)"
aws lambda wait function-updated --function-name "$FUNCTION"

# 7. Database migrations, run by the function itself (the master password never leaves AWS).
echo "migrating..."
aws lambda invoke --function-name "$FUNCTION" --cli-binary-format raw-in-base64-out --payload '{"action":"migrate"}' /tmp/migrate.json >/dev/null
cat /tmp/migrate.json; echo

# 8. Smoke checks.
check() { code="$(curl -s -o /dev/null -w '%{http_code}' "$1")"; echo "$code $1"; [ "$code" = "$2" ] || FAILED=1; }
FAILED=0
check "${APP_URL}/" 200
check "${APP_URL}/login" 200
check "${APP_URL}/api/healthz" 200
check "${APP_URL}/api/readyz" 200
check "${APP_URL}/api/auth/config" 200
check "${APP_URL}/api/me" 401
echo "readyz: $(curl -s "${APP_URL}/api/readyz")"

cat <<EOF

Phase 1 environment (${ENVIRONMENT})
  region            ${REGION}
  app URL           ${APP_URL}
  commit            ${COMMIT}
  user pool         ${POOL}
  app client        ${CLIENT}
  Cognito domain    ${DOMAIN}
  identity providers ${IDPS:-none (email and password only)}
  callback URL      ${APP_URL}/auth/callback
  logout URL        ${APP_URL}/login?signedOut=1
  function          ${FUNCTION} (logs: /aws/lambda/${FUNCTION})
  Google redirect URI for later: ${DOMAIN}/oauth2/idpresponse
EOF
exit "$FAILED"
