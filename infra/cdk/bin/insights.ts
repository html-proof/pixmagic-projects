#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { CiStack } from "../lib/ci-stack.js";
import { envConfig } from "../lib/config.js";
import { DataStack } from "../lib/data-stack.js";
import { EdgeStack } from "../lib/edge-stack.js";

/**
 * Insights on AWS. Stacks, deployed in this order (cdk works it out from the references):
 *   InsightsEdge-<env>  us-east-1        WAF web ACL for CloudFront
 *   InsightsData-<env>  ap-southeast-2   VPC, NAT, RDS PostgreSQL, DynamoDB, S3, secrets, admin host
 *   InsightsApp-<env>   ap-southeast-2   SQS, Lambda (api, jobs, cron), CloudFront, schedules, alarms, budget
 *   InsightsAuth-<env>  ap-southeast-2   Cognito (infra/aws/cognito.yaml) + the runtime parameter
 *   InsightsCi-<env>    ap-southeast-2   GitHub OIDC deploy role
 * Context: -c env=production|staging, -c schedules=on (at cutover), -c alertEmail=..., -c googleClientId=...
 * docs/aws-deployment.md is the runbook.
 */
const app = new App();
const cfg = envConfig((k) => app.node.tryGetContext(k));
const env = { account: cfg.account, region: cfg.region };
const name = (part: string) => `Insights${part}-${cfg.name}`;

const edge = new EdgeStack(app, name("Edge"), cfg, { env: { account: cfg.account, region: "us-east-1" }, crossRegionReferences: true, description: "Insights: WAF for CloudFront" });
const data = new DataStack(app, name("Data"), cfg, { env, description: "Insights: network, database, storage, secrets" });
const appStack = new AppStack(app, name("App"), cfg, data, edge.webAclArn, { env, crossRegionReferences: true, description: "Insights: functions, queues, CloudFront, schedules, alarms" });
new AuthStack(app, name("Auth"), cfg, {
  env,
  description: "Insights: Cognito sign-in and runtime settings",
  appUrl: `https://${appStack.distribution.distributionDomainName}`,
  apiRole: appStack.apiRole,
  runtimeParam: appStack.runtimeParam,
  googleClientId: String(app.node.tryGetContext("googleClientId") ?? "") || undefined,
});
new CiStack(app, name("Ci"), cfg, { env, description: "Insights: GitHub Actions deploy role (OIDC)" });

Tags.of(app).add("app", "insights");
Tags.of(app).add("environment", cfg.name);
Tags.of(app).add("managed-by", "cdk");
