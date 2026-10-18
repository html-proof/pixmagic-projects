import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { type EnvConfig, githubClaimConditions, githubDeployClaims, githubTrustChecks } from "./config.js";

/**
 * Deploys from GitHub Actions (.github/workflows/aws-deploy.yml) with short-lived credentials:
 * GitHub's OIDC token is exchanged for this role, no AWS access keys are stored in GitHub. Only
 * the deploy workflow file, run from main in the `production` environment of the one repository,
 * may assume it (githubDeployClaims), and it can do little itself: hand off to the CDK bootstrap
 * roles (which deploy the stacks), run the migrate action, read what the smoke tests check, and
 * move the `live` aliases back for a rollback.
 */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, props);
    const provider = new iam.OidcProviderNative(this, "GitHub", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });
    // Every claim of githubDeployClaims: aud, sub, and the workflow file and branch
    // (job_workflow_ref, ref), which sub doesn't name. The deploy workflow gives the role this
    // trust only after the trust-check roles below prove IAM checks those two and this workflow
    // meets them ("The trust this commit deploys is proven", before cdk deploy). A wrong trust here
    // locks every later deploy out, and only the account's root can put it back
    // (docs/aws-deployment.md).
    const role = new iam.Role(this, "DeployRole", {
      roleName: `insights-${cfg.name}-github-deploy`,
      description: `GitHub Actions deploys of ${cfg.githubRepo} (environment ${cfg.name})`,
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, { StringEquals: githubClaimConditions(githubDeployClaims(cfg)) }),
    });
    // Roles with no policy at all, so their sessions can do nothing, each trusting one variant of
    // the claims (githubTrustChecks). After every deploy the workflow checks IAM admits it to the
    // first and refuses it the others (scripts/oidc-trust.ts assume).
    // The deploy role reads their trust (read-only): STS also refuses a role that doesn't exist.
    const checks = githubTrustChecks(cfg).map(
      (check) =>
        new iam.Role(this, check.id, {
          roleName: check.roleName,
          description: `Grants nothing: proves the deploy role's GitHub trust (${check.admits ? "must admit" : "must refuse"} ${cfg.githubDeployWorkflow})`,
          assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, { StringEquals: githubClaimConditions(check.claims) }),
        }),
    );
    role.addToPolicy(new iam.PolicyStatement({ actions: ["iam:GetRole"], resources: checks.map((c) => c.roleArn) }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ["sts:AssumeRole"], resources: [`arn:aws:iam::${cfg.account}:role/cdk-hnb659fds-*`] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction", "lambda:GetAlias", "lambda:UpdateAlias", "lambda:ListVersionsByFunction", "lambda:GetFunctionConfiguration"],
        resources: [`arn:aws:lambda:${cfg.region}:${cfg.account}:function:insights-${cfg.name}-*`],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ actions: ["cloudformation:DescribeStacks"], resources: [`arn:aws:cloudformation:*:${cfg.account}:stack/Insights*-${cfg.name}/*`] }));
    // Read-only facts the workflow's smoke tests check (scripts/smoke.mjs, "AWS side"). Without them
    // those checks fail and the workflow rolls every release back.
    const prefix = `insights-${cfg.name}`;
    role.addToPolicy(new iam.PolicyStatement({ actions: ["rds:DescribeDBInstances"], resources: [`arn:aws:rds:${cfg.region}:${cfg.account}:db:${prefix}`] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetBucketPublicAccessBlock"],
        resources: ["payloads", "artifacts", "site"].map((kind) => `arn:aws:s3:::${prefix}-${kind}-${cfg.account}`),
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ actions: ["sqs:GetQueueUrl", "sqs:GetQueueAttributes"], resources: [`arn:aws:sqs:${cfg.region}:${cfg.account}:${prefix}-dlq`] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ["logs:DescribeLogStreams"], resources: [`arn:aws:logs:${cfg.region}:${cfg.account}:log-group:/aws/lambda/${prefix}-api:*`] }));
    // CloudWatch metric reads have no resource-level permissions.
    role.addToPolicy(new iam.PolicyStatement({ actions: ["cloudwatch:GetMetricStatistics"], resources: ["*"] }));
    new CfnOutput(this, "DeployRoleArn", { value: role.roleArn, description: "GitHub variable AWS_DEPLOY_ROLE_ARN (environment production)" });
  }
}
