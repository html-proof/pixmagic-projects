import { existsSync } from "node:fs";
import { join } from "node:path";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cfninc from "aws-cdk-lib/cloudformation-include";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { appVars, COGNITO_TEMPLATE, FUNCTION_DIR, type EnvConfig } from "./config.js";

export interface AuthStackProps extends StackProps {
  /** The app's origin: https://<domain>, or https://<distribution>.cloudfront.net without one. */
  appUrl: string;
  /** The API function's role: it makes the pool's admin calls (no access keys anywhere). */
  apiRole: iam.IRole;
  runtimeParam: string;
  /** Google sign-in, once its OAuth client lists this pool's redirect URI (empty: not yet). */
  googleClientId?: string;
}

/**
 * Sign-in: the Cognito user pool from infra/aws/cognito.yaml (Phase 1, the single source of truth
 * for the pool, its domain and app client), included as is, and the
 * runtime parameter that tells the functions where they live and which pool to use. Deployed
 * after the App stack because the app client's callback URL is CloudFront's address.
 *
 * With `cognitoCustomEmail` (config.ts), the pool's emails go out through the app's mail provider:
 * its Custom Email Sender trigger is the `cognito-email` function, which decrypts each code with
 * this stack's KMS key and sends it from EMAIL_FROM (apps/aws/src/cognitoEmail.ts).
 */
export class AuthStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, props: AuthStackProps) {
    super(scope, id, props);
    const prefix = `insights-${cfg.name}`;

    const parameters: Record<string, string> = {
      Environment: cfg.name,
      AppUrl: props.appUrl,
      DomainPrefix: cfg.cognitoDomainPrefix,
    };
    if (props.googleClientId) {
      parameters.GoogleClientId = props.googleClientId;
      // Resolved by CloudFormation from Secrets Manager at deploy time; never in the template.
      parameters.GoogleClientSecret = `{{resolve:secretsmanager:insights/${cfg.name}/app:SecretString:GOOGLE_SIGNIN_CLIENT_SECRET}}`;
    }
    const emailSender = cfg.cognitoCustomEmail ? this.customEmailSender(cfg, prefix, props.appUrl) : undefined;
    if (emailSender) {
      parameters.CustomEmailSenderState = "ENABLED";
      parameters.CustomEmailSenderArn = emailSender.fn.functionArn;
      parameters.CustomEmailKmsKeyArn = emailSender.key.keyArn;
    }
    const template = new cfninc.CfnInclude(this, "Cognito", { templateFile: COGNITO_TEMPLATE, parameters });
    const pool = template.getResource("UserPool") as cognito.CfnUserPool;
    const client = template.getResource("WebClient") as cognito.CfnUserPoolClient;
    // Only this pool may invoke the email sender.
    emailSender?.fn.addPermission("CognitoInvoke", { principal: new iam.ServicePrincipal("cognito-idp.amazonaws.com"), sourceArn: pool.attrArn, sourceAccount: cfg.account });

    // The admin calls the app makes (accounts from before Cognito, staff invitations, account
    // deletion, sign-out everywhere), on this pool only.
    new iam.Policy(this, "ApiCognitoAdmin", {
      policyName: `insights-${cfg.name}-cognito-admin`,
      roles: [props.apiRole],
      statements: [
        new iam.PolicyStatement({
          actions: ["cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminDeleteUser", "cognito-idp:AdminUserGlobalSignOut"],
          resources: [pool.attrArn],
        }),
      ],
    });

    const domain = `https://${cfg.cognitoDomainPrefix}.auth.${cfg.region}.amazoncognito.com`;
    new ssm.StringParameter(this, "Runtime", {
      parameterName: props.runtimeParam,
      description: "Insights runtime settings (not secret): the app's address and its Cognito pool",
      stringValue: Stack.of(this).toJsonString({
        APP_URL: props.appUrl,
        API_URL: `${props.appUrl}/api`,
        COGNITO_REGION: cfg.region,
        COGNITO_USER_POOL_ID: pool.ref,
        COGNITO_CLIENT_ID: client.ref,
        COGNITO_DOMAIN: domain,
        COGNITO_IDENTITY_PROVIDERS: props.googleClientId ? "Google" : "",
      }),
    });
    // Outputs: cognito.yaml's own (UserPoolId, ClientId, Domain, ProviderRedirectUri for Google).
  }

  /**
   * The Custom Email Sender: a KMS key Cognito encrypts the codes with (the principal that updates
   * the pool, CloudFormation's role, creates Cognito's grant on it, which the default key policy
   * allows), and the function that decrypts and sends them. The function is the app's package with
   * its own entry (cognito-email.mjs), outside the VPC: it needs only Secrets Manager, KMS and the
   * mail provider, all public endpoints, so it doesn't depend on the NAT gateway.
   *
   * Cost: the key is US$1/month (no rotation: it protects codes only for the moment between Cognito
   * and the function, nothing at rest, and each rotation would add another US$1/month); its
   * requests and the invocations fit the free tiers at this volume; the alarm is US$0.10/month.
   */
  private customEmailSender(cfg: EnvConfig, prefix: string, appUrl: string) {
    if (!existsSync(join(FUNCTION_DIR, "cognito-email.mjs"))) {
      throw new Error(`No cognito-email.mjs in ${FUNCTION_DIR}: build the package (pnpm --filter @app/aws build) first, or every Cognito email would fail`);
    }
    const key = new kms.Key(this, "CognitoEmailKey", {
      alias: `alias/${prefix}-cognito-email`,
      description: `Cognito encrypts the codes it hands to ${prefix}-cognito-email with this key`,
      enableKeyRotation: false,
      // Nothing stays encrypted under it, so deleting it (the feature turned off) loses nothing.
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
    });
    const logGroup = new logs.LogGroup(this, "Logs-cognito-email", { logGroupName: `/aws/lambda/${prefix}-cognito-email`, retention: cfg.logRetentionDays as logs.RetentionDays, removalPolicy: RemovalPolicy.RETAIN });
    const fn = new lambda.Function(this, "CognitoEmail", {
      functionName: `${prefix}-cognito-email`,
      description: "Sends Cognito's emails (codes, temporary passwords) through the app's mail provider",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "cognito-email.handler",
      code: lambda.Code.fromAsset(FUNCTION_DIR),
      memorySize: 512,
      timeout: Duration.seconds(30),
      environment: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        APP_ENVIRONMENT: cfg.name,
        APP_URL: appUrl,
        API_URL: `${appUrl}/api`,
        EMAIL_FROM: appVars().EMAIL_FROM!,
        // RESEND_API_KEY, and the app's other secrets env() checks, come from here at cold start.
        APP_SECRET_ARN: `insights/${cfg.name}/app`,
        COGNITO_EMAIL_KEY_ARN: key.keyArn,
      },
      logGroup,
      // Cognito invokes it asynchronously: Lambda retries a failure twice. A code an hour late is no use.
      retryAttempts: 2,
      maxEventAge: Duration.hours(1),
    });
    key.grantDecrypt(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [`arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:insights/${cfg.name}/app-*`] }));

    // The App stack's alarm topic, by name, so this stack adds no export to that one.
    const topic = sns.Topic.fromTopicArn(this, "AlarmTopic", `arn:aws:sns:${cfg.region}:${cfg.account}:${prefix}-alarms`);
    const alarm = new cloudwatch.Alarm(this, "CognitoEmailErrors", {
      alarmName: `${prefix}-cognito-email-errors`,
      alarmDescription: "Cognito's emails (sign-up codes, password resets, sign-in codes) failing to send: see the cognito-email function's log",
      metric: fn.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cwActions.SnsAction(topic));
    alarm.addOkAction(new cwActions.SnsAction(topic));
    return { key, fn };
  }
}
