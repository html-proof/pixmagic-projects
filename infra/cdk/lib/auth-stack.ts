import { Stack, type StackProps } from "aws-cdk-lib";
import * as cfninc from "aws-cdk-lib/cloudformation-include";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { COGNITO_TEMPLATE, type EnvConfig } from "./config.js";

export interface AuthStackProps extends StackProps {
  /** https://<distribution>.cloudfront.net (or the custom domain later). */
  appUrl: string;
  /** The API function's role: it makes the pool's admin calls (no access keys anywhere). */
  apiRole: iam.IRole;
  runtimeParam: string;
  /** Google sign-in, once its OAuth client lists this pool's redirect URI (empty: not yet). */
  googleClientId?: string;
}

/**
 * Sign-in: the Cognito user pool from infra/aws/cognito.yaml (Phase 1, the single source of truth
 * for the pool, its domain and app client), included as is with CreateWorkerUser=false, and the
 * runtime parameter that tells the functions where they live and which pool to use. Deployed
 * after the App stack because the app client's callback URL is CloudFront's address.
 */
export class AuthStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, props: AuthStackProps) {
    super(scope, id, props);

    const parameters: Record<string, string> = {
      Environment: cfg.name,
      AppUrl: props.appUrl,
      DomainPrefix: cfg.cognitoDomainPrefix,
      CreateWorkerUser: "false",
    };
    if (props.googleClientId) {
      parameters.GoogleClientId = props.googleClientId;
      // Resolved by CloudFormation from Secrets Manager at deploy time; never in the template.
      parameters.GoogleClientSecret = `{{resolve:secretsmanager:insights/${cfg.name}/app:SecretString:GOOGLE_SIGNIN_CLIENT_SECRET}}`;
    }
    const template = new cfninc.CfnInclude(this, "Cognito", { templateFile: COGNITO_TEMPLATE, parameters });
    const pool = template.getResource("UserPool") as cognito.CfnUserPool;
    const client = template.getResource("WebClient") as cognito.CfnUserPoolClient;

    // The admin calls the app makes (moving Firebase users, staff invitations, account deletion,
    // sign-out everywhere), on this pool only.
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
    // Outputs: cognito.yaml's own (UserPoolId, ClientId, Domain, ProviderRedirectUri for Google/Apple).
  }
}
