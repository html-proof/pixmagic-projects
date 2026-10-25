import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dlm from "aws-cdk-lib/aws-dlm";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import type { EnvConfig } from "./config.js";
import { NatInstancePerAz, SWAP_FILE_COMMANDS } from "./nat-instances.js";
import { accessLogBucket, loggedBucket } from "./s3-access-logs.js";

/** PostgreSQL 17, as on the PC (minor upgrades are automatic in the maintenance window). */
const PG_VERSION = "17.11";

/** Tag on the snapshot taken when an instance is created (value "launch"); the only ones its custom resource may delete. */
export const LAUNCH_SNAPSHOT_TAG = "insights-snapshot";

/**
 * What holds state, and the network around it. Changes rarely; termination protection is on.
 *
 * Network: a VPC over two Availability Zones with
 *   - public subnets: only the NAT instances live here (nat-instances.ts; cfg.natGateways of them,
 *     one per AZ in production)
 *   - private subnets (with egress): the Lambda functions and the admin host; out to the internet
 *     (Cognito, Shopify, Meta, Google, merchants' SMTP servers) through the NAT instance in their AZ
 *   - isolated subnets: the database (primary in one AZ, standby in the other with cfg.dbMultiAz),
 *     with no route out at all
 * plus free gateway endpoints for S3 and DynamoDB. Nothing in the VPC accepts connections from the
 * internet; the database accepts 5432 only from the functions' and the admin host's security groups.
 */
export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  /** The NAT instances (cfg.natGateways of them): every function's way out to the internet. */
  readonly natInstances: ec2.Instance[];
  readonly appSg: ec2.SecurityGroup;
  /** The database's: other stacks add who else may reach PostgreSQL (the WhatsApp service, whatsapp-stack.ts). */
  readonly dbSg: ec2.SecurityGroup;
  readonly db: rds.DatabaseInstance;
  readonly dbSecret: secretsmanager.ISecret;
  readonly appSecret: secretsmanager.Secret;
  /** WhatsApp's Evolution API service: its global key (EVOLUTION_API_KEY), shared by the functions and its container. */
  readonly evolutionSecret: secretsmanager.Secret;
  /** Its database role (EVOLUTION_DB_USER, EVOLUTION_DB_PASSWORD): its container and the cron, which makes the role. */
  readonly evolutionDbSecret: secretsmanager.Secret;
  readonly coordTable: dynamodb.Table;
  readonly payloads: s3.Bucket;
  readonly artifacts: s3.Bucket;
  /** Where every bucket in the Region writes its server access logs (s3-access-logs.ts). */
  readonly accessLogs: s3.Bucket;
  readonly adminHost: ec2.Instance;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, { ...props, terminationProtection: cfg.name === "production" });
    const prefix = `insights-${cfg.name}`;

    const nat = new NatInstancePerAz({ instanceType: new ec2.InstanceType(cfg.natInstanceType), namePrefix: prefix });
    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: prefix,
      ipAddresses: ec2.IpAddresses.cidr("10.40.0.0/16"),
      maxAzs: 2,
      natGateways: cfg.natGateways,
      natGatewayProvider: nat,
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
    this.natInstances = nat.instances;

    // Keep each NAT instance running: the host failing → recover it onto healthy hardware; the
    // instance itself failing (kernel, network) → reboot it. Either way the instance id and its
    // addresses stay, so the routes need no change. The alarms live here, beside the instances (an
    // instance id exported to the app stack would block replacing the instance), and tell the app
    // stack's topic by name.
    const topic = sns.Topic.fromTopicArn(this, "AlarmTopic", `arn:aws:sns:${cfg.region}:${cfg.account}:${prefix}-alarms`);
    for (const instance of this.natInstances) {
      const az = instance.instance.availabilityZone ?? "";
      const name = `${prefix}-nat-${az.slice(-1)}`;
      const check = (metricName: string) =>
        new cloudwatch.Metric({ namespace: "AWS/EC2", metricName, dimensionsMap: { InstanceId: instance.instanceId }, period: Duration.minutes(1), statistic: "Maximum" });
      const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, periods: number, description: string, action?: cwActions.Ec2InstanceAction) => {
        const a = new cloudwatch.Alarm(instance, id, {
          alarmName: `${name}-${id}`,
          alarmDescription: description,
          metric,
          threshold,
          evaluationPeriods: periods,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.MISSING,
        });
        if (action) a.addAlarmAction(new cwActions.Ec2Action(action));
        a.addAlarmAction(new cwActions.SnsAction(topic));
        a.addOkAction(new cwActions.SnsAction(topic));
      };
      alarm("system-check", check("StatusCheckFailed_System"), 1, 2, `NAT instance in ${az}: AWS's host failed; recovering it onto new hardware`, cwActions.Ec2InstanceAction.RECOVER);
      alarm("instance-check", check("StatusCheckFailed_Instance"), 1, 3, `NAT instance in ${az} not responding; rebooting it`, cwActions.Ec2InstanceAction.REBOOT);
      alarm(
        "cpu",
        new cloudwatch.Metric({ namespace: "AWS/EC2", metricName: "CPUUtilization", dimensionsMap: { InstanceId: instance.instanceId }, period: Duration.minutes(5), statistic: "Average" }),
        80,
        3,
        `NAT instance in ${az} busy for 15 minutes: outbound calls may slow down; a bigger natInstanceType (infra/cdk/lib/config.ts) fixes it`,
      );
    }

    // Functions: outbound only.
    this.appSg = new ec2.SecurityGroup(this, "AppSg", { vpc: this.vpc, securityGroupName: `${prefix}-app`, description: "Insights Lambda functions (outbound only)", allowAllOutbound: true });
    const adminSg = new ec2.SecurityGroup(this, "AdminSg", { vpc: this.vpc, securityGroupName: `${prefix}-admin`, description: "Insights admin host (SSM only, outbound only)", allowAllOutbound: true });
    const dbSg = (this.dbSg = new ec2.SecurityGroup(this, "DbSg", { vpc: this.vpc, securityGroupName: `${prefix}-db`, description: "Insights PostgreSQL", allowAllOutbound: false }));
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
      // The automated backups (point-in-time restore) outlive the instance: deleting it, by
      // mistake or by a replacement, would otherwise delete them with it.
      deleteAutomatedBackups: false,
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

    // WhatsApp Automation's Evolution API service (whatsapp-stack.ts, docs/whatsapp.md): its global API
    // key and its own database role's password, both generated here once and never seen by anyone.
    // Letters and digits only: they go into a URL and a header as they are. Never edit
    // generateSecretString (CloudFormation would generate new values; the instances' keys are their own).
    this.evolutionSecret = new secretsmanager.Secret(this, "EvolutionSecret", {
      secretName: `insights/${cfg.name}/evolution-api`,
      description: "Insights WhatsApp: the Evolution API service's global API key (EVOLUTION_API_KEY)",
      generateSecretString: { secretStringTemplate: "{}", generateStringKey: "EVOLUTION_API_KEY", passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.evolutionDbSecret = new secretsmanager.Secret(this, "EvolutionDbSecret", {
      secretName: `insights/${cfg.name}/evolution-db`,
      description: "Insights WhatsApp: the Evolution API service's own database role (EVOLUTION_DB_USER, EVOLUTION_DB_PASSWORD)",
      generateSecretString: { secretStringTemplate: JSON.stringify({ EVOLUTION_DB_USER: "evolution" }), generateStringKey: "EVOLUTION_DB_PASSWORD", passwordLength: 40, excludePunctuation: true },
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

    // Every bucket in the Region logs its requests here (s3-access-logs.ts): this stack's two, the
    // App stack's build files, and in production the audit stack's trail bucket and the one `cdk
    // bootstrap` made. Its own policy comes first: a logging configuration that names it must find
    // the grant in place.
    this.accessLogs = accessLogBucket(this, "AccessLogs", `${prefix}-s3-logs-${cfg.account}`);
    const accessLogs = s3.Bucket.fromBucketName(this, "AccessLogsTarget", this.accessLogs.bucketName);

    const privateBucket = { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED };
    // Webhook bodies too large for a queue message; processed ones are deleted at once. Versioned
    // (Trusted Advisor "S3 Bucket Versioning"), so a body deleted or overwritten by mistake can be
    // got back for a day; then the old version and its delete marker go, so customer data in
    // processed bodies isn't kept longer than that.
    this.payloads = new s3.Bucket(this, "Payloads", {
      ...privateBucket,
      ...loggedBucket(`${prefix}-payloads-${cfg.account}`, accessLogs),
      versioned: true,
      lifecycleRules: [
        { expiration: Duration.days(7), noncurrentVersionExpiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { expiredObjectDeleteMarker: true },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Database dumps for moves and restores (kept 30 days), and anything else the deploy hands over.
    this.artifacts = new s3.Bucket(this, "Artifacts", {
      ...privateBucket,
      ...loggedBucket(`${prefix}-artifacts-${cfg.account}`, accessLogs),
      versioned: true,
      lifecycleRules: [{ expiration: Duration.days(30), noncurrentVersionExpiration: Duration.days(7), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const bucket of [this.payloads, this.artifacts]) bucket.node.addDependency(this.accessLogs.policy!);

    // A small host for database administration (restores, psql) reached only through Systems
    // Manager: no SSH, no inbound rule, no public address. Stopped when not in use: a new Amazon
    // Linux image replaces it on the next deploy, and the new one stops itself once psql is in
    // (user data runs on the first boot only, so starting it later leaves it running).
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
      userData: ec2.UserData.custom(["#!/bin/bash", ...SWAP_FILE_COMMANDS, "dnf install -y postgresql17 jq || dnf install -y postgresql16 jq", "shutdown -h now", ""].join("\n")),
    });

    // A snapshot of each instance's disk as soon as the instance exists. The daily policy below
    // leaves a disk alone for its first 24 hours, then picks a time in a 4-hour window, and a new
    // Amazon Linux image replaces all three instances: every such deploy left Trusted Advisor's
    // "Amazon EBS Snapshots" red for a day or two. One per instance: once a replacement has its
    // own, CloudFormation deletes the previous instance's (the custom resource's delete call).
    const launchSnapshotLogs = new logs.LogGroup(this, "LaunchSnapshotLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const snapshotOnLaunch = (instance: ec2.Instance, name: string) => {
      const snapshots = `arn:aws:ec2:${cfg.region}::snapshot/*`;
      const create: cr.AwsSdkCall = {
        service: "EC2",
        action: "createSnapshots",
        parameters: {
          InstanceSpecification: { InstanceId: instance.instanceId },
          Description: `${name} disk when the instance was created`,
          TagSpecifications: [{ ResourceType: "snapshot", Tags: [{ Key: "Name", Value: `${name}-launch` }, { Key: LAUNCH_SNAPSHOT_TAG, Value: "launch" }] }],
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse("Snapshots.0.SnapshotId"),
        outputPaths: ["Snapshots.0.SnapshotId"],
      };
      new cr.AwsCustomResource(instance, "LaunchSnapshot", {
        onCreate: create,
        // A replaced instance (new id) gets its own snapshot; the old one goes with the old id.
        onUpdate: create,
        onDelete: { service: "EC2", action: "deleteSnapshot", parameters: { SnapshotId: new cr.PhysicalResourceIdReference() }, ignoreErrorCodesMatching: "InvalidSnapshot\\.NotFound" },
        installLatestAwsSdk: false,
        logGroup: launchSnapshotLogs,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["ec2:CreateSnapshots"],
            resources: [`arn:aws:ec2:${cfg.region}:${cfg.account}:instance/${instance.instanceId}`, `arn:aws:ec2:${cfg.region}:${cfg.account}:volume/*`, snapshots],
          }),
          new iam.PolicyStatement({ actions: ["ec2:CreateTags"], resources: [snapshots], conditions: { StringEquals: { "ec2:CreateAction": "CreateSnapshots" } } }),
          // Only its own kind: never the daily policy's snapshots or anyone else's.
          new iam.PolicyStatement({ actions: ["ec2:DeleteSnapshot"], resources: [snapshots], conditions: { StringEquals: { [`ec2:ResourceTag/${LAUNCH_SNAPSHOT_TAG}`]: "launch" } } }),
        ]),
      });
    };
    for (const instance of this.natInstances) snapshotOnLaunch(instance, `${prefix}-nat-${(instance.instance.availabilityZone ?? "").slice(-1)}`);
    snapshotOnLaunch(this.adminHost, `${prefix}-admin`);

    // A daily snapshot of every EBS disk (the NAT instances' and the admin host's), kept 7 days
    // (Trusted Advisor "Amazon EBS Snapshots": red with none, yellow once the newest is 7 days old).
    // A deploy can rebuild those disks, so this is the quicker way back, at ~US$0.50-1.50/month
    // (US$0.055/GB-month of used blocks, then only the changes). Data Lifecycle Manager's default
    // policy covers every volume in the Region without a recent snapshot, so the disk of a replaced
    // instance is covered without tags. One is allowed per Region: production's covers staging's
    // disks too. ExtendDeletion: a replaced disk's snapshots expire as well, the last one included
    // (without it each new Amazon Linux image would leave one snapshot per instance for good).
    if (cfg.name === "production") {
      const snapshotRole = new iam.Role(this, "SnapshotRole", {
        roleName: `${prefix}-ebs-snapshots`,
        assumedBy: new iam.ServicePrincipal("dlm.amazonaws.com"),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSDataLifecycleManagerServiceRole")],
      });
      new dlm.CfnLifecyclePolicy(this, "EbsSnapshots", {
        // DLM accepts only letters, digits, spaces, _ and - here.
        description: "Daily snapshot of every EBS volume without a recent one kept 7 days",
        defaultPolicy: "VOLUME",
        state: "ENABLED",
        executionRoleArn: snapshotRole.roleArn,
        createInterval: 1,
        retainInterval: 7,
        copyTags: true,
        extendDeletion: true,
      });
    }
  }
}
