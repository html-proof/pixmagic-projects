import { CustomResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/**
 * The move from Secrets Manager (US$0.40 a secret a month) to Parameter Store's free SecureString
 * parameters, change 7 of docs/aws-migration/MIGRATION_STATUS.md. Its steps and where it stands:
 * docs/aws-migration/SECRETS_TO_PARAMETER_STORE.md.
 *
 * Step 1 (here): every secret has a copy in a parameter of the same name after a slash
 * (insights/production/app → /insights/production/app), the same text, so nothing about a value
 * changes. CloudFormation can't create a SecureString parameter, so a custom resource copies them
 * on every release, and the functions read the parameter first, the secret when they can't
 * (apps/aws/src/secrets.ts). The secret stays the source of truth until step 2.
 */

/** The secrets under insights/<env>/, by their last name. */
export const SECRET_NAMES = ["app", "db-owner", "db-system", "worker-cognito", "origin-lock", "evolution-api", "evolution-db"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** A secret's name in Secrets Manager. */
export const secretName = (cfg: Pick<EnvConfig, "name">, name: SecretName) => `insights/${cfg.name}/${name}`;
/** The parameter that holds its copy. */
export const secretParameter = (cfg: Pick<EnvConfig, "name">, name: SecretName) => `/${secretName(cfg, name)}`;
export const secretParameterArn = (cfg: Pick<EnvConfig, "name" | "region" | "account">, name: SecretName) => `arn:aws:ssm:${cfg.region}:${cfg.account}:parameter${secretParameter(cfg, name)}`;

/** May read these secrets' parameters (decrypting needs no grant: the key is AWS's own for Parameter Store, open to whoever may read the parameter). */
export const readSecretParameters = (cfg: Pick<EnvConfig, "name" | "region" | "account">, names: readonly SecretName[]) =>
  new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: names.map((n) => secretParameterArn(cfg, n)) });

/**
 * May not read them, whatever else the role is given. For the EC2 instances: the managed policy
 * that lets Systems Manager reach them (AmazonSSMManagedInstanceCore) allows ssm:GetParameter(s) on
 * every parameter, which would hand them each secret the day it has a copy there.
 */
export const denySecretParameters = (cfg: Pick<EnvConfig, "name" | "region" | "account">, names: readonly SecretName[]) =>
  new iam.PolicyStatement({
    effect: iam.Effect.DENY,
    actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:GetParametersByPath"],
    resources: names.map((n) => secretParameterArn(cfg, n)),
  });

/** How the copier's errors begin. */
export const SECRET_PARAMETERS_FAILED = "secret-parameters failed";

/**
 * The copier's handler, inline (CloudFormation's ZipFile, at most 4096 characters). For each
 * secret name it is given, in order:
 *
 * - "no secret": Secrets Manager has none of that name (an environment without the origin lock, or
 *   a new one whose Auth stack hasn't made worker-cognito yet). Nothing is written.
 * - "same": the parameter already holds the secret's text.
 * - "created" / "updated": the parameter is written, as a SecureString in the standard (free) tier,
 *   with the secret's text exactly.
 * - "differs, parameter newer: kept": the texts differ and the parameter was written after the
 *   secret's current version. The newer one wins, so nothing put there on purpose is undone.
 *
 * It answers with `Data.Copied` (the stack output SecretCopies): names and those words, never a
 * value. No value is logged, and an AWS error is reported by its name alone: a validation message
 * can quote the text it refused.
 *
 * For its first 90 seconds it tries again, 5 s apart, a call refused for lack of permission or
 * throttled: on the release that creates it, IAM may still be taking its role in (as for
 * migrate-before-live.ts). After that an error stands.
 *
 * A failure fails the release (before any `live` alias moves) only while the stack is going
 * forward. On a CloudFormation rollback the old properties come back as another update: a failure
 * there would leave the stack unable to finish rolling back, so it is reported and passed over.
 *
 * Never write a backslash or a backtick in it, and a dollar-brace only for SECRET_PARAMETERS_FAILED:
 * this is an untagged template literal, which drops backslashes.
 */
export const SECRET_PARAMETERS_CODE = `const M = require("@aws-sdk/client-secrets-manager");
const S = require("@aws-sdk/client-ssm");
const C = require("@aws-sdk/client-cloudformation");
const sm = new M.SecretsManagerClient({});
const ssm = new S.SSMClient({});
const cfn = new C.CloudFormationClient({});
const WAIT = ["AccessDenied", "AccessDeniedException", "Throttling", "ThrottlingException"];
let until = 0;
const step = async (what, call) => {
  for (;;) {
    try { return await call(); } catch (e) {
      if (WAIT.includes(e.name) && Date.now() < until) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      throw Object.assign(new Error(what + ": " + (e.name || "Error")), { name: e.name });
    }
  }
};
const copy = async (name) => {
  let secret, param;
  try {
    secret = await step("reading the secret", () => sm.send(new M.GetSecretValueCommand({ SecretId: name })));
  } catch (e) {
    if (e.name === "ResourceNotFoundException") return "no secret";
    throw e;
  }
  const text = secret.SecretString;
  if (!text) return "no text";
  if (text.length > 4096) throw new Error("longer than a standard parameter's 4096 characters");
  try {
    param = (await step("reading the parameter", () => ssm.send(new S.GetParameterCommand({ Name: "/" + name, WithDecryption: true })))).Parameter;
  } catch (e) {
    if (e.name !== "ParameterNotFound") throw e;
  }
  if (param && param.Value === text) return "same";
  if (param && param.LastModifiedDate > secret.CreatedDate) return "differs, parameter newer: kept";
  await step("writing the parameter", () => ssm.send(new S.PutParameterCommand({ Name: "/" + name, Value: text, Type: "SecureString", Tier: "Standard", Overwrite: true, Description: "Copy of the Secrets Manager secret " + name })));
  return param ? "updated" : "created";
};
exports.onEvent = async (event) => {
  if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId };
  until = Date.now() + 90000;
  const out = [];
  let failed = "";
  for (const name of event.ResourceProperties.Secrets) {
    const short = name.split("/").pop();
    try {
      out.push(short + ": " + await copy(name));
    } catch (e) {
      failed = failed || short + " (" + e.message + ")";
      out.push(short + ": FAILED " + e.message);
    }
  }
  console.log(JSON.stringify({ copied: out }));
  if (failed) {
    let status = "unknown";
    try { status = (await cfn.send(new C.DescribeStacksCommand({ StackName: event.StackId }))).Stacks[0].StackStatus; } catch (e) {}
    console.log(JSON.stringify({ failed, stack: status }));
    if (status === "UPDATE_IN_PROGRESS" || status === "CREATE_IN_PROGRESS") throw new Error("${SECRET_PARAMETERS_FAILED} (nothing moved to the new release): " + failed);
  }
  return { PhysicalResourceId: "secret-parameters", Data: { Copied: out.join(", ").slice(0, 900) } };
};
`;

/**
 * The App stack's copier: a custom resource that copies each of the environment's secrets into its
 * parameter (SECRET_PARAMETERS_CODE above says how it decides). It runs on every release (its
 * `Release` property is the commit), so a secret changed since the last one is copied again; the
 * caller makes the three `live` aliases wait for it.
 */
export function secretParameters(scope: Construct, cfg: EnvConfig, release: string): CustomResource {
  const name = `insights-${cfg.name}-secret-parameters`;
  const names = SECRET_NAMES.filter((n) => n !== "origin-lock" || Boolean(cfg.domain?.originLock));
  const logGroup = new logs.LogGroup(scope, "SecretParametersLogs", { logGroupName: `/aws/lambda/${name}`, retention: cfg.logRetentionDays as logs.RetentionDays, removalPolicy: RemovalPolicy.DESTROY });
  const handler = new lambda.Function(scope, "SecretParametersHandler", {
    functionName: name,
    description: "Insights: copies each Secrets Manager secret into its Parameter Store parameter, unchanged (deploys only)",
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    // Not index.handler: that names the app's own three functions.
    handler: "index.onEvent",
    code: lambda.Code.fromInline(SECRET_PARAMETERS_CODE),
    // Its own waiting (90 s at most) and seven secrets' three calls each.
    timeout: Duration.minutes(5),
    // No VPC and no environment: it calls only the Secrets Manager, SSM and CloudFormation APIs.
    logGroup,
  });
  // Every secret of this environment, whichever stack made it, and only their parameters.
  handler.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: names.map((n) => `arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:${secretName(cfg, n)}-*`) }));
  handler.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter", "ssm:PutParameter"], resources: names.map((n) => secretParameterArn(cfg, n)) }));
  handler.addToRolePolicy(new iam.PolicyStatement({ actions: ["cloudformation:DescribeStacks"], resources: [Stack.of(scope).stackId] }));
  const provider = new cr.Provider(scope, "SecretParametersProvider", {
    onEventHandler: handler,
    logGroup: new logs.LogGroup(scope, "SecretParametersProviderLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
  });
  return new CustomResource(scope, "SecretParameters", {
    serviceToken: provider.serviceToken,
    resourceType: "Custom::SecretParameters",
    properties: { Release: release, Secrets: names.map((n) => secretName(cfg, n)) },
  });
}
