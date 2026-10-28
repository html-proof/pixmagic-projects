#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack.js";
import { AuditStack } from "../lib/audit-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { CiStack } from "../lib/ci-stack.js";
import { envConfig } from "../lib/config.js";
import { DataStack } from "../lib/data-stack.js";
import { EdgeStack } from "../lib/edge-stack.js";
import { WhatsappStack } from "../lib/whatsapp-stack.js";

/**
 * Insights on AWS. Stacks, deployed in this order (cdk works it out from the references):
 *   InsightsEdge-<env>  us-east-1        WAF web ACL for CloudFront; production: the Region's S3 access log bucket
 *   InsightsData-<env>  ap-southeast-2   VPC, NAT, RDS PostgreSQL, DynamoDB, S3 (and the Region's access log bucket), secrets, admin host
 *   InsightsApp-<env>   ap-southeast-2   SQS, Lambda (api, jobs, cron), CloudFront, schedules, alarms, budget
 *   InsightsAuth-<env>  ap-southeast-2   Cognito (infra/aws/cognito.yaml) + the runtime parameter
 *   InsightsWhatsapp-<env> ap-southeast-2 What is left of WhatsApp's retired Evolution API service: drops its database once, after App (docs/whatsapp.md, "Removing Evolution")
 *   InsightsCi-<env>    ap-southeast-2   GitHub OIDC deploy role
 *   InsightsAudit-production  ap-southeast-2   CloudTrail (all Regions), IAM Access Analyzer in every Region, access logs of CDK's bucket (account-wide, production only)
 * Context: -c env=production|staging, -c schedules=on (at cutover), -c alertEmail=..., -c budgetEmail=..., -c googleClientId=...
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
  appUrl: appStack.appUrl,
  apiRole: appStack.apiRole,
  runtimeParam: appStack.runtimeParam,
  googleClientId: String(app.node.tryGetContext("googleClientId") ?? "") || undefined,
});
const whatsapp = new WhatsappStack(app, name("Whatsapp"), cfg, { env, description: "Insights: what is left of WhatsApp's retired Evolution API service" });
// Its one resource runs the App stack's cron function (invoked by name, so no export ties them).
whatsapp.addDependency(appStack);
new CiStack(app, name("Ci"), cfg, { env, description: "Insights: GitHub Actions deploy role (OIDC)" });
// Account-wide (one trail and one analyzer per Region is enough), so staging doesn't get a copy.
if (cfg.name === "production") {
  new AuditStack(app, name("Audit"), cfg, { env, description: "Insights: CloudTrail and IAM Access Analyzer for the whole account", accessLogsBucketName: data.accessLogs.bucketName });
}

Tags.of(app).add("app", "insights");
Tags.of(app).add("environment", cfg.name);
Tags.of(app).add("managed-by", "cdk");
