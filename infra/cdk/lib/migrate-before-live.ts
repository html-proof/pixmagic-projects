import { CustomResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/** How the gate's errors begin: aws-deploy.yml's "Deploy (CDK)" never runs cdk deploy again on one. */
export const MIGRATE_BEFORE_LIVE_FAILED = "migrate-before-live failed";

/**
 * The gate's handler, inline (CloudFormation's ZipFile, at most 4096 characters, so the reasons
 * live here and not in the code). It answers each event with one JSON log line and, except on
 * Delete, `Data.Applied` (the stack output MigratedBeforeLive), deciding in this order:
 *
 * 1. Delete: nothing to do. `-c migrate=off`, or a commit from before the gate, deletes it.
 * 2. "skipped: rollback or nothing newer (A to B)": the new cron version is not higher than the
 *    one it last ran, on the same function. That is what a CloudFormation rollback sends (the old
 *    properties back), so a rollback never fails here, and never calls anything. It is also a
 *    security property: an older version's init.sql, through its blanket GRANT, gives app_rls back
 *    tables a newer one revokes (zapier_tokens, auth_identities, user_sessions). It refuses an older
 *    version NUMBER only: `cdk deploy` of an older commit publishes that code as a new, higher
 *    version, which it runs (init.sql and all) unless that deploy passes `-c migrate=off`.
 * 3. "skipped: stack <status>": anything but UPDATE_IN_PROGRESS. A new environment's first
 *    creation: nothing is live yet to protect.
 * 4. "skipped: no <param> yet": the runtime parameter is missing. The Auth stack writes it, after
 *    App, and the new cron can't load its settings without it: a half-built environment (App
 *    without Auth) would otherwise never get past the gate.
 * 5. Invokes the new cron version's migrate, with the constant payload {"action":"migrate"}.
 *    Answers "applied <names> (<n> in all)". A FunctionError, or any error except one that means
 *    the cron never ran, throws MIGRATE_BEFORE_LIVE_FAILED: the App stack fails before any `live`
 *    alias moves.
 *
 * Retries, 24 tries 5 s apart, only errors that mean the cron never ran: IAM still taking a fresh
 * role (CloudFormation calls it "AccessDenied", Lambda and SSM "AccessDeniedException"), throttling,
 * a version still Pending, no network interface for it in the VPC yet. The Lambda client doesn't
 * retry on its own (maxAttempts 1): after a timeout or a 5xx the cron may have run. The two reads
 * keep the SDK's own retries for a passing 5xx or reset. A migrate can still arrive twice (CDK's
 * provider framework calls a handler again when its call to Lambda fails): migrate.ts's advisory
 * lock queues the second.
 *
 * Never write a backslash or a backtick in it, and a dollar-brace only for MIGRATE_BEFORE_LIVE_FAILED:
 * this is an untagged template literal, which drops backslashes.
 */
export const MIGRATE_BEFORE_LIVE_CODE = `const L = require("@aws-sdk/client-lambda");
const C = require("@aws-sdk/client-cloudformation");
const S = require("@aws-sdk/client-ssm");
const lambda = new L.LambdaClient({ maxAttempts: 1 });
const cfn = new C.CloudFormationClient({});
const ssm = new S.SSMClient({});
const NOT_RUN = ["AccessDenied", "AccessDeniedException", "TooManyRequestsException", "ResourceNotReadyException", "ResourceConflictException", "Throttling", "ThrottlingException", "EC2ThrottledException", "ENILimitReachedException", "SubnetIPAddressLimitReachedException"];
const again = async (call) => {
  for (let i = 1; ; i++) {
    try { return await call(); } catch (e) {
      if (i >= 24 || !NOT_RUN.includes(e.name)) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
};
const version = (arn) => { const m = /^(.+):([0-9]+)$/.exec(arn || ""); return m ? { fn: m[1], n: Number(m[2]) } : undefined; };
const answer = (target, decision) => {
  console.log(JSON.stringify({ target, decision }));
  return { PhysicalResourceId: "migrate-before-live", Data: { Applied: ("version " + String(target).split(":").pop() + ": " + decision).slice(0, 900) } };
};
exports.onEvent = async (event) => {
  if (event.RequestType === "Delete") {
    console.log(JSON.stringify({ decision: "delete: nothing to do" }));
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  const p = event.ResourceProperties;
  const now = version(p.Target), before = version((event.OldResourceProperties || {}).Target);
  if (now && before && now.fn === before.fn && now.n <= before.n) return answer(p.Target, "skipped: rollback or nothing newer (" + before.n + " to " + now.n + ")");
  try {
    const stack = await again(() => cfn.send(new C.DescribeStacksCommand({ StackName: event.StackId })));
    const status = stack.Stacks[0].StackStatus;
    if (status !== "UPDATE_IN_PROGRESS") return answer(p.Target, "skipped: stack " + status);
    try {
      await again(() => ssm.send(new S.GetParameterCommand({ Name: p.RuntimeParam })));
    } catch (e) {
      if (e.name === "ParameterNotFound") return answer(p.Target, "skipped: no " + p.RuntimeParam + " yet");
      throw e;
    }
    const r = await again(() => lambda.send(new L.InvokeCommand({ FunctionName: p.Target, Payload: Buffer.from('{"action":"migrate"}') })));
    const body = r.Payload ? Buffer.from(r.Payload).toString("utf8") : "";
    if (r.FunctionError) throw new Error(body.slice(0, 500));
    let out = {};
    try { out = JSON.parse(body); } catch {}
    return answer(p.Target, "applied " + ((out.applied || []).join(", ") || "none") + " (" + out.total + " in all)");
  } catch (e) {
    throw new Error("${MIGRATE_BEFORE_LIVE_FAILED} (nothing moved to the new release): " + (e.name && e.name !== "Error" ? e.name + ": " : "") + e.message);
  }
};
`;

/**
 * The App stack's gate between a release's new code and `live`: a custom resource that runs the
 * release's migrations on its new cron version (MIGRATE_BEFORE_LIVE_CODE above says how it
 * decides). The caller makes the three `live` aliases depend on it. Its only property that changes
 * is the new cron version, so CloudFormation calls it once per new package, never on a re-run of
 * the same one.
 */
export function migrateBeforeLive(scope: Construct, cfg: EnvConfig, cronVersion: lambda.IVersion, runtimeParam: string): CustomResource {
  const name = `insights-${cfg.name}-migrate-before-live`;
  // Named, so the provider framework's "Logs: /aws/lambda/..." in a failure points at it; DESTROY,
  // because `-c migrate=off` removes the gate and a kept group of that name would fail its return.
  const logGroup = new logs.LogGroup(scope, "MigrateBeforeLiveLogs", { logGroupName: `/aws/lambda/${name}`, retention: cfg.logRetentionDays as logs.RetentionDays, removalPolicy: RemovalPolicy.DESTROY });
  const handler = new lambda.Function(scope, "MigrateBeforeLiveHandler", {
    functionName: name,
    description: "Insights: runs a release's migrations on its new cron version before the live aliases move (deploys only)",
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    // Not index.handler: that names the app's own three functions.
    handler: "index.onEvent",
    code: lambda.Code.fromInline(MIGRATE_BEFORE_LIVE_CODE),
    // Under the provider framework's fixed 15 minutes; the cron's own limit is 15.
    timeout: Duration.minutes(14),
    // No VPC and no environment: it calls only the Lambda, CloudFormation and SSM APIs.
    logGroup,
  });
  // Cron versions only (never the unqualified function), on a pattern that doesn't change with each
  // release: a policy rewritten per deploy would race IAM's propagation against its own invoke.
  handler.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [`arn:aws:lambda:${cfg.region}:${cfg.account}:function:insights-${cfg.name}-cron:*`] }));
  handler.addToRolePolicy(new iam.PolicyStatement({ actions: ["cloudformation:DescribeStacks"], resources: [Stack.of(scope).stackId] }));
  // Whether it exists, only: the value is never logged or returned (and isn't secret: secrets.ts).
  handler.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [`arn:aws:ssm:${cfg.region}:${cfg.account}:parameter${runtimeParam}`] }));
  const provider = new cr.Provider(scope, "MigrateBeforeLiveProvider", {
    onEventHandler: handler,
    logGroup: new logs.LogGroup(scope, "MigrateBeforeLiveProviderLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
  });
  return new CustomResource(scope, "MigrateBeforeLive", {
    serviceToken: provider.serviceToken,
    resourceType: "Custom::MigrateBeforeLive",
    // Past the framework's 15 minutes, so its own answer comes first; far inside the deploy step's 45.
    serviceTimeout: Duration.minutes(16),
    properties: { Target: cronVersion.functionArn, RuntimeParam: runtimeParam },
  });
}
