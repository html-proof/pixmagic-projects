import { CfnStackSet, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/**
 * The account's enabled Regions (`aws account list-regions --region-opt-status-contains ENABLED
 * ENABLED_BY_DEFAULT`, 2026-10-18). Trusted Advisor's "IAM Access Analyzer - external access" wants
 * an analyzer in each; a Region enabled later needs adding here. ap-southeast-4 (Melbourne) is
 * opt-in, so StackSets reach it through its own CloudFormation principal (OPT_IN_REGIONS).
 */
export const ACCOUNT_REGIONS = [
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-4",
  "ca-central-1",
  "eu-central-1",
  "eu-north-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
];
const OPT_IN_REGIONS = ["ap-southeast-4"];

/** Name of the account-level analyzer in every Region (one is allowed per Region). */
export const ANALYZER_NAME = "insights-account";

/**
 * Account-wide audit (Trusted Advisor's security checks), so only production deploys it:
 *   - CloudTrail: one trail for every Region, management events (reads and writes, global services
 *     included) into a private bucket, with digest files to prove nothing was changed. The first
 *     copy of management events is free; the bucket costs cents.
 *   - IAM Access Analyzer (external access, free) in every enabled Region, through a self-managed
 *     StackSet: a stack is bound to one Region, and CDK stacks elsewhere would need bootstrapping.
 * GuardDuty was turned on by hand (docs/aws-deployment.md, Cost).
 */
export class AuditStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, { ...props, terminationProtection: true });
    const account = cfg.account;

    // StackSets assumes the administration role, which may only assume the execution role, which
    // may only manage stacks and analyzers.
    const execRoleName = "insights-account-stackset-exec";
    const adminRole = new iam.Role(this, "StackSetAdminRole", {
      roleName: "insights-account-stackset-admin",
      description: "CloudFormation StackSets: the account's Access Analyzers in every Region",
      assumedBy: new iam.CompositePrincipal(
        ...["cloudformation.amazonaws.com", ...OPT_IN_REGIONS.map((r) => `cloudformation.${r}.amazonaws.com`)].map((service) => new iam.ServicePrincipal(service)),
      ).withConditions({ StringEquals: { "aws:SourceAccount": account }, ArnLike: { "aws:SourceArn": `arn:aws:cloudformation:*:${account}:stackset/*` } }),
      inlinePolicies: {
        assume: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({ actions: ["sts:AssumeRole"], resources: [`arn:aws:iam::${account}:role/${execRoleName}`] })] }),
      },
    });
    const execRole = new iam.Role(this, "StackSetExecRole", {
      roleName: execRoleName,
      description: "CloudFormation StackSets: creates the account's Access Analyzers",
      assumedBy: new iam.ArnPrincipal(adminRole.roleArn),
      inlinePolicies: {
        analyzers: new iam.PolicyDocument({
          statements: [
            // StackSets' documented minimum.
            new iam.PolicyStatement({ actions: ["cloudformation:*"], resources: ["*"] }),
            // What CloudFormation's AWS::AccessAnalyzer::Analyzer handlers call (`aws cloudformation describe-type`).
            new iam.PolicyStatement({
              actions: [
                "access-analyzer:CreateAnalyzer",
                "access-analyzer:DeleteAnalyzer",
                "access-analyzer:GetAnalyzer",
                "access-analyzer:ListAnalyzers",
                "access-analyzer:UpdateAnalyzer",
                "access-analyzer:ListArchiveRules",
                "access-analyzer:CreateArchiveRule",
                "access-analyzer:UpdateArchiveRule",
                "access-analyzer:DeleteArchiveRule",
                "access-analyzer:TagResource",
                "access-analyzer:UntagResource",
                "organizations:ListAWSServiceAccessForOrganization",
                "organizations:ListDelegatedAdministrators",
              ],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              actions: ["iam:CreateServiceLinkedRole"],
              resources: [`arn:aws:iam::${account}:role/aws-service-role/access-analyzer.amazonaws.com/*`],
              conditions: { StringEquals: { "iam:AWSServiceName": "access-analyzer.amazonaws.com" } },
            }),
          ],
        }),
      },
    });

    // Versioned (Trusted Advisor "S3 Bucket Versioning"): a log file deleted by mistake or on purpose
    // stays recoverable for 30 days. Kept a year.
    const trailBucket = new s3.Bucket(this, "TrailLogs", {
      bucketName: `insights-account-trail-${account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      lifecycleRules: [
        { expiration: Duration.days(365), noncurrentVersionExpiration: Duration.days(30), abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { expiredObjectDeleteMarker: true },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // A new role can take a few seconds to be usable, and a StackSet whose role StackSets can't yet
    // assume fails (and rolls the stack back): the bucket and trail go between them.
    trailBucket.node.addDependency(adminRole, execRole);
    const trail = new cloudtrail.Trail(this, "Trail", {
      trailName: "insights-account",
      bucket: trailBucket,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      enableFileValidation: true,
      sendToCloudWatchLogs: false,
    });

    const analyzers = new CfnStackSet(this, "AccessAnalyzers", {
      stackSetName: "insights-account-access-analyzer",
      description: "IAM Access Analyzer (external access, account) in every enabled Region; infra/cdk/lib/audit-stack.ts",
      permissionModel: "SELF_MANAGED",
      administrationRoleArn: adminRole.roleArn,
      executionRoleName: execRole.roleName,
      managedExecution: { Active: true },
      // Every Region at once; one that fails fails the deploy instead of leaving a gap.
      operationPreferences: { regionConcurrencyType: "PARALLEL", maxConcurrentCount: 1, failureToleranceCount: 0 },
      stackInstancesGroup: [{ deploymentTargets: { accounts: [account] }, regions: ACCOUNT_REGIONS }],
      templateBody: JSON.stringify({
        AWSTemplateFormatVersion: "2010-09-09",
        Description: "IAM Access Analyzer for this account's external access (insights audit stack)",
        Resources: { Analyzer: { Type: "AWS::AccessAnalyzer::Analyzer", Properties: { AnalyzerName: ANALYZER_NAME, Type: "ACCOUNT" } } },
      }),
    });
    analyzers.node.addDependency(trail);
  }
}
