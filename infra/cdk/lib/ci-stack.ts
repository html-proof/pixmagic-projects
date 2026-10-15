import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/**
 * Deploys from GitHub Actions (.github/workflows/aws-deploy.yml) with short-lived credentials:
 * GitHub's OIDC token is exchanged for this role, no AWS access keys are stored in GitHub. Only
 * the `production` environment of the one repository may assume it, and it can do little itself:
 * hand off to the CDK bootstrap roles (which deploy the stacks), run the migrate action, and move
 * the `live` aliases back for a rollback.
 */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, props);
    const provider = new iam.OidcProviderNative(this, "GitHub", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });
    const role = new iam.Role(this, "DeployRole", {
      roleName: `insights-${cfg.name}-github-deploy`,
      description: `GitHub Actions deploys of ${cfg.githubRepo} (environment ${cfg.name})`,
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${cfg.githubRepo}:environment:${cfg.name}`,
        },
      }),
    });
    role.addToPolicy(new iam.PolicyStatement({ actions: ["sts:AssumeRole"], resources: [`arn:aws:iam::${cfg.account}:role/cdk-hnb659fds-*`] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction", "lambda:GetAlias", "lambda:UpdateAlias", "lambda:ListVersionsByFunction", "lambda:GetFunctionConfiguration"],
        resources: [`arn:aws:lambda:${cfg.region}:${cfg.account}:function:insights-${cfg.name}-*`],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ actions: ["cloudformation:DescribeStacks"], resources: [`arn:aws:cloudformation:*:${cfg.account}:stack/Insights*-${cfg.name}/*`] }));
    new CfnOutput(this, "DeployRoleArn", { value: role.roleArn, description: "GitHub secret AWS_DEPLOY_ROLE_ARN (environment production)" });
  }
}
