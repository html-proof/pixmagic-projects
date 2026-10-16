import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/** PostgreSQL 17, as on the PC (minor upgrades are automatic in the maintenance window). */
const PG_VERSION = "17.11";

/**
 * What holds state, and the network around it. Changes rarely; termination protection is on.
 *
 * Network: a VPC over two Availability Zones with
 *   - public subnets: only the NAT gateway lives here
 *   - private subnets (with egress): the Lambda functions and the admin host; out to the internet
 *     (Cognito, Shopify, Meta, Google, merchants' SMTP servers) through the NAT gateway
 *   - isolated subnets: the database, with no route out at all
 * plus free gateway endpoints for S3 and DynamoDB. Nothing in the VPC accepts connections from the
 * internet; the database accepts 5432 only from the functions' and the admin host's security groups.
 */
export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly appSg: ec2.SecurityGroup;
  readonly db: rds.DatabaseInstance;
  readonly dbSecret: secretsmanager.ISecret;
  readonly appSecret: secretsmanager.Secret;
  readonly coordTable: dynamodb.Table;
  readonly payloads: s3.Bucket;
  readonly artifacts: s3.Bucket;
  readonly adminHost: ec2.Instance;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, { ...props, terminationProtection: cfg.name === "production" });
    const prefix = `insights-${cfg.name}`;

    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: prefix,
      ipAddresses: ec2.IpAddresses.cidr("10.40.0.0/16"),
      maxAzs: 2,
      natGateways: cfg.natGateways,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: "db", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        s3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        dynamodb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    });

    // Functions: outbound only.
    this.appSg = new ec2.SecurityGroup(this, "AppSg", { vpc: this.vpc, securityGroupName: `${prefix}-app`, description: "Insights Lambda functions (outbound only)", allowAllOutbound: true });
    const adminSg = new ec2.SecurityGroup(this, "AdminSg", { vpc: this.vpc, securityGroupName: `${prefix}-admin`, description: "Insights admin host (SSM only, outbound only)", allowAllOutbound: true });
    const dbSg = new ec2.SecurityGroup(this, "DbSg", { vpc: this.vpc, securityGroupName: `${prefix}-db`, description: "Insights PostgreSQL", allowAllOutbound: false });
    dbSg.addIngressRule(this.appSg, ec2.Port.tcp(5432), "Lambda functions");
    dbSg.addIngressRule(adminSg, ec2.Port.tcp(5432), "Admin host (restores, psql via SSM)");

    // TLS required for every connection; the app verifies the server against Amazon's CA.
    const params = new rds.ParameterGroup(this, "DbParams", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.of(PG_VERSION, "17") }),
      description: "Insights: TLS only, slow-query log",
      // Slow statements are logged without their bind parameters (customers' emails, names).
      parameters: { "rds.force_ssl": "1", log_min_duration_statement: "1000", log_parameter_max_length: "0", log_lock_waits: "1" },
    });

    // The owner role is "app", as on the PC: migrations and the RLS grants (infra/postgres/init.sql)
    // are written for it, and the tenant role app_rls is created by the migrate action.
    const credentials = rds.Credentials.fromGeneratedSecret("app", { secretName: `insights/${cfg.name}/db-owner`, excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\=," });
    this.db = new rds.DatabaseInstance(this, "Db", {
      instanceIdentifier: prefix,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.of(PG_VERSION, "17") }),
      instanceType: new ec2.InstanceType(cfg.dbInstanceType),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      publiclyAccessible: false,
      multiAz: cfg.dbMultiAz,
      credentials,
      databaseName: "app",
      parameterGroup: params,
      storageType: rds.StorageType.GP3,
      allocatedStorage: cfg.dbAllocatedStorageGb,
      maxAllocatedStorage: cfg.dbMaxStorageGb,
      storageEncrypted: true,
      backupRetention: Duration.days(cfg.dbBackupDays),
      preferredBackupWindow: "16:00-16:30", // 02:00-02:30 Sydney
      preferredMaintenanceWindow: "sun:17:00-sun:17:30",
      copyTagsToSnapshot: true,
      deletionProtection: cfg.name === "production",
      removalPolicy: cfg.name === "production" ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      autoMinorVersionUpgrade: true,
      enablePerformanceInsights: true,
      // Enhanced Monitoring: the host's CPU, memory, disk and per-process figures every minute
      // (CloudWatch Logs, RDSOSMetrics). Turning it on or off doesn't restart the database.
      monitoringInterval: Duration.seconds(60),
      cloudwatchLogsExports: ["postgresql"],
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
    });
    this.dbSecret = this.db.secret!;

    // The app's own secrets. Created with ORIGIN_VERIFY only (CloudFront needs it at deploy time);
    // infra/cdk/scripts/put-secrets.mjs fills in the rest without printing any value. Never edit
    // generateSecretString here: CloudFormation would generate a new value and replace the others.
    this.appSecret = new secretsmanager.Secret(this, "AppSecret", {
      secretName: `insights/${cfg.name}/app`,
      description: "Insights app secrets: SESSION_SECRET, TOKEN_ENCRYPTION_KEYS, OTP_PEPPER, APP_RLS_PASSWORD, ORIGIN_VERIFY, provider secrets",
      generateSecretString: { secretStringTemplate: "{}", generateStringKey: "ORIGIN_VERIFY", passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The coordinator (apps/aws/src/dynamoCoord.ts): rate limits, one-time OAuth state, locks.
    this.coordTable = new dynamodb.Table(this, "Coord", {
      tableName: `${prefix}-coord`,
      partitionKey: { name: "k", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "exp",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const privateBucket = { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED };
    // Webhook bodies too large for a queue message; processed ones are deleted at once.
    this.payloads = new s3.Bucket(this, "Payloads", {
      ...privateBucket,
      bucketName: `${prefix}-payloads-${cfg.account}`,
      lifecycleRules: [{ expiration: Duration.days(7), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Database dumps for moves and restores (kept 30 days), and anything else the deploy hands over.
    this.artifacts = new s3.Bucket(this, "Artifacts", {
      ...privateBucket,
      bucketName: `${prefix}-artifacts-${cfg.account}`,
      versioned: true,
      lifecycleRules: [{ expiration: Duration.days(30), noncurrentVersionExpiration: Duration.days(7), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // A small host for database administration (restores, psql) reached only through Systems
    // Manager: no SSH, no inbound rule, no public address. Stopped when not in use.
    const adminRole = new iam.Role(this, "AdminRole", {
      roleName: `${prefix}-admin-host`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    this.artifacts.grantRead(adminRole);
    this.dbSecret.grantRead(adminRole);
    this.appSecret.grantRead(adminRole);
    this.adminHost = new ec2.Instance(this, "AdminHost", {
      instanceName: `${prefix}-admin`,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: adminSg,
      role: adminRole,
      instanceType: new ec2.InstanceType("t4g.nano"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      requireImdsv2: true,
      blockDevices: [{ deviceName: "/dev/xvda", volume: ec2.BlockDeviceVolume.ebs(8, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
      userData: ec2.UserData.custom("#!/bin/bash\ndnf install -y postgresql17 jq || dnf install -y postgresql16 jq\n"),
    });
  }
}
