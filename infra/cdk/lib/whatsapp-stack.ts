import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArnFormat, CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import { APP_SETTINGS } from "../../../apps/aws/src/settings.js";
import { FUNCTION_DIR, type EnvConfig } from "./config.js";
import type { DataStack } from "./data-stack.js";

/**
 * Evolution API (https://github.com/evolution-foundation/evolution-api), release 2.3.7 of 2025-12-05,
 * the latest release (2.4.0 is still a release candidate), pinned by the digest Docker Hub lists for
 * the tag (amd64 and arm64). A new release is tested locally (docker-compose.yml's evolution service)
 * and changed here on purpose: a restart never pulls anything else.
 */
export const EVOLUTION_IMAGE = "evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339";
/** The one shard today: its server's name, and the instances' DATABASE_CONNECTION_CLIENT_NAME. */
export const EVOLUTION_SHARD = "a";
export const evolutionNamespace = (cfg: Pick<EnvConfig, "name">) => `whatsapp.${cfg.name}.insights.internal`;
/** The service's private address, the functions' EVOLUTION_API_URL (app-stack.ts). */
export const evolutionUrl = (cfg: Pick<EnvConfig, "name">, shard = EVOLUTION_SHARD) => `http://evolution-${shard}.${evolutionNamespace(cfg)}:8080`;

/**
 * Amazon RDS's root certificates for the database's Region, from the bundle the Lambda package
 * carries (apps/aws/scripts/build.mjs): Evolution's Prisma then checks the database's certificate
 * and host name. The whole global bundle is too big for an environment variable. Null without a
 * package (the CDK tests): the container then encrypts without checking.
 */
function regionRdsCa(region: string): string | null {
  const file = join(FUNCTION_DIR, "rds-ca.pem");
  if (!existsSync(file)) return null;
  const pems = readFileSync(file, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const mine = pems.filter((pem) => {
    try {
      const c = new X509Certificate(pem);
      return c.ca && c.subject.includes(region);
    } catch {
      return false;
    }
  });
  return mine.length ? mine.join("\n") : null;
}

/**
 * The container's start: Evolution's image runs its database migrations and then the server; its
 * database address is put together here, so the password (from Secrets Manager) never sits in the
 * task definition, and only DATABASE_CONNECTION_URI is set: the image's start script prints
 * DATABASE_URL to the log, which is left unset.
 */
const START = [
  "set -eo pipefail",
  'if [ -n "${RDS_CA_PEM:-}" ]; then printf "%s\\n" "$RDS_CA_PEM" > /tmp/rds-ca.pem; TLS="sslmode=require&sslcert=/tmp/rds-ca.pem"; else TLS="sslmode=require&sslaccept=accept_invalid_certs"; fi',
  'export DATABASE_CONNECTION_URI="postgresql://${EVO_DB_USER}:${EVO_DB_PASSWORD}@${EVO_DB_HOST}:${EVO_DB_PORT}/evolution?schema=public&connection_limit=5&${TLS}"',
  "unset EVO_DB_PASSWORD",
  ". ./Docker/scripts/deploy_database.sh",
  "exec node dist/main",
].join("\n");

/** The container's health: its HTTP server answers (a missing asset is a quick 404, nothing outside is asked). */
const HEALTH = "node -e \"require('http').get('http://127.0.0.1:8080/assets/health',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))\"";

/** Invokes the cron function's "evolution-db" action, and fails the deployment if it failed. */
const DB_INIT_CODE = `
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
exports.handler = async (event) => {
  if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId };
  const r = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: process.env.TARGET, Payload: Buffer.from(JSON.stringify({ action: "evolution-db" })) }));
  const body = r.Payload ? Buffer.from(r.Payload).toString("utf8") : "";
  if (r.FunctionError) throw new Error("evolution-db failed: " + body.slice(0, 500));
  return { PhysicalResourceId: "evolution-db", Data: { Result: body.slice(0, 200) } };
};
`;

/**
 * WhatsApp Automation's Evolution API service (docs/whatsapp.md, "Where it runs"): one ECS Fargate
 * task on Graviton in the private subnets, with no public address and no load balancer. Only the
 * Lambda functions reach it (port 8080, through a private DNS name in Cloud Map); it reaches
 * WhatsApp, Meta and bizinsights' own webhooks through the NAT instances. Its data (instances and
 * their WhatsApp sessions) is in a database of its own on the app's RDS instance, made by the cron's
 * "evolution-db" action before the first task starts.
 *
 * One task holds every session of its shard in memory: a deployment stops the old task before it
 * starts the new one (a WhatsApp session can't be open twice), so a change to the task means a
 * minute or two without WhatsApp; sessions resume from the database. More stores than one task can
 * hold → a second shard: another service like this one with its own client name (docs/whatsapp.md,
 * "Scaling").
 */
export class WhatsappStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, data: DataStack, props: StackProps) {
    super(scope, id, props);
    const prefix = `insights-${cfg.name}`;
    const shard = EVOLUTION_SHARD;

    const sg = new ec2.SecurityGroup(this, "EvolutionSg", { vpc: data.vpc, securityGroupName: `${prefix}-evolution`, description: "Insights WhatsApp: Evolution API (in from the functions only)", allowAllOutbound: true });
    sg.addIngressRule(data.appSg, ec2.Port.tcp(8080), "Lambda functions call Evolution API");
    // PostgreSQL, for its own database on the app's RDS instance.
    new ec2.CfnSecurityGroupIngress(this, "DbFromEvolution", {
      groupId: data.dbSg.securityGroupId,
      sourceSecurityGroupId: sg.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "WhatsApp's Evolution API service (its own database)",
    });

    const namespace = new servicediscovery.PrivateDnsNamespace(this, "Namespace", { name: evolutionNamespace(cfg), vpc: data.vpc, description: "Insights WhatsApp: Evolution API's private address" });
    const cluster = new ecs.Cluster(this, "Cluster", { clusterName: `${prefix}-whatsapp`, vpc: data.vpc, containerInsightsV2: ecs.ContainerInsights.DISABLED });

    const logGroup = new logs.LogGroup(this, "EvolutionLogs", { logGroupName: `/ecs/${prefix}-evolution`, retention: cfg.logRetentionDays as logs.RetentionDays, removalPolicy: RemovalPolicy.RETAIN });
    const task = new ecs.FargateTaskDefinition(this, "EvolutionTask", {
      family: `${prefix}-evolution-${shard}`,
      cpu: cfg.whatsapp.cpu,
      memoryLimitMiB: cfg.whatsapp.memoryMiB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const ca = regionRdsCa(cfg.region);
    task.addContainer("evolution", {
      containerName: "evolution",
      image: ecs.ContainerImage.fromRegistry(EVOLUTION_IMAGE),
      essential: true,
      entryPoint: ["/bin/bash", "-c"],
      command: [START],
      portMappings: [{ containerPort: 8080 }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "evolution" }),
      stopTimeout: Duration.seconds(30),
      healthCheck: { command: ["CMD-SHELL", HEALTH], interval: Duration.seconds(30), timeout: Duration.seconds(5), retries: 3, startPeriod: Duration.seconds(180) },
      secrets: {
        AUTHENTICATION_API_KEY: ecs.Secret.fromSecretsManager(data.evolutionSecret, "EVOLUTION_API_KEY"),
        EVO_DB_USER: ecs.Secret.fromSecretsManager(data.evolutionDbSecret, "EVOLUTION_DB_USER"),
        EVO_DB_PASSWORD: ecs.Secret.fromSecretsManager(data.evolutionDbSecret, "EVOLUTION_DB_PASSWORD"),
      },
      environment: {
        // Evolution stamps its webhooks with the container's local time and a "Z": UTC makes that true.
        TZ: "UTC",
        LANGUAGE: "en",
        SERVER_TYPE: "http",
        SERVER_PORT: "8080",
        SERVER_URL: evolutionUrl(cfg, shard),
        SERVER_DISABLE_DOCS: "true",
        // No web console: nothing but the functions talks to it.
        SERVER_DISABLE_MANAGER: "true",
        CORS_ORIGIN: cfg.domain ? `https://${cfg.domain.name}` : "https://invalid.example",
        EVO_DB_HOST: data.db.dbInstanceEndpointAddress,
        EVO_DB_PORT: data.db.dbInstanceEndpointPort,
        ...(ca ? { RDS_CA_PEM: ca } : {}),
        DATABASE_PROVIDER: "postgresql",
        DATABASE_CONNECTION_CLIENT_NAME: `insights_${shard}`,
        // Sessions only: no chats, contacts, messages or number lookups of customers are kept here.
        DATABASE_SAVE_DATA_INSTANCE: "true",
        DATABASE_SAVE_DATA_NEW_MESSAGE: "false",
        DATABASE_SAVE_MESSAGE_UPDATE: "false",
        DATABASE_SAVE_DATA_CONTACTS: "false",
        DATABASE_SAVE_DATA_CHATS: "false",
        DATABASE_SAVE_DATA_LABELS: "false",
        DATABASE_SAVE_DATA_HISTORIC: "false",
        DATABASE_SAVE_IS_ON_WHATSAPP: "false",
        DATABASE_DELETE_MESSAGE: "false",
        // One task: its own memory is the cache (bizinsights' coordination is DynamoDB's).
        CACHE_REDIS_ENABLED: "false",
        CACHE_LOCAL_ENABLED: "true",
        // Instance keys never come back in answers or webhooks.
        AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: "false",
        // Errors and warnings only: at LOG level Evolution prints each QR code, at INFO the linked number.
        LOG_LEVEL: "ERROR,WARN",
        LOG_COLOR: "false",
        LOG_BAILEYS: "error",
        DEL_INSTANCE: "false",
        DEL_TEMP_INSTANCES: "false",
        WEBHOOK_GLOBAL_ENABLED: "false",
        WEBHOOK_REQUEST_TIMEOUT_MS: "10000",
        WEBHOOK_RETRY_MAX_ATTEMPTS: "10",
        WEBHOOK_RETRY_INITIAL_DELAY_SECONDS: "5",
        WEBHOOK_RETRY_USE_EXPONENTIAL_BACKOFF: "true",
        WEBHOOK_RETRY_MAX_DELAY_SECONDS: "300",
        // What the phone lists under Linked devices.
        CONFIG_SESSION_PHONE_CLIENT: "bizinsights",
        CONFIG_SESSION_PHONE_NAME: "Chrome",
        // About two minutes of codes per pairing; the page then offers a new one.
        QRCODE_LIMIT: "6",
        QRCODE_COLOR: "#000000",
        // Nothing is reported to Evolution's own servers.
        TELEMETRY_ENABLED: "false",
        PROMETHEUS_METRICS: "false",
        // Its Cloud API integration calls Meta's Graph API at bizinsights' version.
        WA_BUSINESS_URL: "https://graph.facebook.com",
        WA_BUSINESS_VERSION: APP_SETTINGS.WHATSAPP_API_VERSION || "v26.0",
        WA_BUSINESS_LANGUAGE: "en",
      },
    });

    // The database and its role, before the first task starts (and again when the secret changes).
    const cronArn = this.formatArn({ service: "lambda", resource: "function", resourceName: `${prefix}-cron:live`, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    const initFn = new lambda.Function(this, "EvolutionDbInit", {
      functionName: `${prefix}-evolution-db-init`,
      description: "Insights WhatsApp: makes Evolution API's database (the cron's evolution-db action) during deploys",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(DB_INIT_CODE),
      timeout: Duration.minutes(2),
      environment: { TARGET: cronArn },
      logGroup: new logs.LogGroup(this, "EvolutionDbInitLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
    });
    initFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [cronArn] }));
    const provider = new cr.Provider(this, "EvolutionDbInitProvider", { onEventHandler: initFn, logGroup: new logs.LogGroup(this, "EvolutionDbInitProviderLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }) });
    const dbInit = new CustomResource(this, "EvolutionDb", { serviceToken: provider.serviceToken, properties: { Version: "1", Secret: data.evolutionDbSecret.secretArn } });

    const service = new ecs.FargateService(this, "Evolution", {
      serviceName: `${prefix}-evolution-${shard}`,
      cluster,
      taskDefinition: task,
      desiredCount: cfg.whatsapp.tasks,
      // Never two at once: stop the old task, then start the new one.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sg],
      assignPublicIp: false,
      cloudMapOptions: { cloudMapNamespace: namespace, name: `evolution-${shard}`, dnsRecordType: servicediscovery.DnsRecordType.A, dnsTtl: Duration.seconds(10) },
      ...(cfg.whatsapp.spot ? { capacityProviderStrategies: [{ capacityProvider: "FARGATE_SPOT", weight: 1 }] } : {}),
    });
    if (cfg.whatsapp.spot) cluster.enableFargateCapacityProviders();
    service.node.addDependency(dbInit);

    // Alarms → the app stack's topic.
    const topic = sns.Topic.fromTopicArn(this, "AlarmTopic", `arn:aws:sns:${cfg.region}:${cfg.account}:${prefix}-alarms`);
    const alarm = (name: string, metric: cloudwatch.IMetric, threshold: number, op: cloudwatch.ComparisonOperator, periods: number, missing: cloudwatch.TreatMissingData, description: string) => {
      const a = new cloudwatch.Alarm(this, name, { alarmName: `${prefix}-${name}`, alarmDescription: description, metric, threshold, comparisonOperator: op, evaluationPeriods: periods, treatMissingData: missing });
      a.addAlarmAction(new cwActions.SnsAction(topic));
      a.addOkAction(new cwActions.SnsAction(topic));
    };
    if (cfg.whatsapp.tasks > 0) {
      // ECS reports a service's CPU only while a task runs: no samples for 10 minutes = nothing running.
      alarm(
        "whatsapp-service-down",
        service.metricCpuUtilization({ period: Duration.minutes(5), statistic: "SampleCount" }),
        1,
        cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        2,
        cloudwatch.TreatMissingData.BREACHING,
        "WhatsApp's Evolution API service has no running task: no store can connect or send (docs/whatsapp.md, Runbook)",
      );
      alarm(
        "whatsapp-service-memory",
        service.metricMemoryUtilization({ period: Duration.minutes(5), statistic: "Maximum" }),
        85,
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        3,
        cloudwatch.TreatMissingData.NOT_BREACHING,
        "WhatsApp's Evolution API task above 85% of its memory for 15 minutes: give it more (config.ts whatsapp.memoryMiB) or add a shard",
      );
    }

    new CfnOutput(this, "EvolutionUrl", { value: evolutionUrl(cfg, shard), description: "Evolution API's private address (the functions' EVOLUTION_API_URL)" });
    new CfnOutput(this, "EvolutionLogGroup", { value: logGroup.logGroupName });
  }
}

