import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { appVars, FUNCTION_DIR, REPO_ROOT, type EnvConfig } from "./config.js";
import type { DataStack } from "./data-stack.js";

type QueueName = "sync" | "webhooks" | "aggregate" | "email";

/**
 * The application: queues, the three functions (one package), CloudFront, schedules, alarms,
 * the dashboard and the budget. Redeployed on every release.
 *
 * Traffic: viewer → CloudFront (+ WAF) → the `api` function URL, which serves the pages and the API
 * on one origin (first-party session cookie, the same routing as the Worker). Next's hashed build
 * files, `/_next/static/*`, come from an S3 bucket instead and are cached at the edge for a year.
 * CloudFront adds a secret header the function checks, so the function URL can't be used to go
 * around WAF, and a viewer-request function passes on the viewer's real address and host.
 */
export class AppStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  readonly apiRole: iam.IRole;
  readonly runtimeParam: string;

  constructor(scope: Construct, id: string, cfg: EnvConfig, data: DataStack, webAclArn: string, props: StackProps) {
    super(scope, id, props);
    const prefix = `insights-${cfg.name}`;
    this.runtimeParam = `/insights/${cfg.name}/runtime`;

    if (!existsSync(FUNCTION_DIR)) throw new Error(`No Lambda package at ${FUNCTION_DIR}: run \`pnpm --filter @app/aws build\` first`);
    const commit = (() => {
      try {
        return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      } catch {
        return "unknown";
      }
    })();

    // --- Queues (Cloudflare Queues insights-sync, -webhooks, -aggregate, -email + insights-dlq).
    // Visibility timeout covers the jobs function's 15 minutes. consume() settles every message
    // within MAX_ATTEMPTS (6); maxReceiveCount 10 only catches what it never settles (crashes).
    const dlq = new sqs.Queue(this, "Dlq", { queueName: `${prefix}-dlq`, retentionPeriod: Duration.days(14), encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true });
    const queue = (name: QueueName) =>
      new sqs.Queue(this, `Queue-${name}`, {
        queueName: `${prefix}-${name}`,
        visibilityTimeout: Duration.seconds(960),
        retentionPeriod: Duration.days(4),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        deadLetterQueue: { queue: dlq, maxReceiveCount: 10 },
      });
    const queues: Record<QueueName, sqs.Queue> = { sync: queue("sync"), webhooks: queue("webhooks"), aggregate: queue("aggregate"), email: queue("email") };

    // --- Functions.
    const code = lambda.Code.fromAsset(FUNCTION_DIR);
    const environment: Record<string, string> = {
      ...appVars(),
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      APP_COMMIT: commit,
      APP_ENVIRONMENT: cfg.name,
      // Database TLS is verified against Amazon's RDS CA (bundled with the package).
      NODE_EXTRA_CA_CERTS: "/var/task/rds-ca.pem",
      APP_SECRET_ARN: data.appSecret.secretArn,
      RUNTIME_PARAM: this.runtimeParam,
      DB_SECRET_ARN: data.dbSecret.secretArn,
      DB_HOST: data.db.dbInstanceEndpointAddress,
      DB_PORT: data.db.dbInstanceEndpointPort,
      DB_NAME: "app",
      COORD_TABLE: data.coordTable.tableName,
      PAYLOADS_BUCKET: data.payloads.bucketName,
      QUEUE_URLS: Stack.of(this).toJsonString(Object.fromEntries(Object.entries(queues).map(([k, q]) => [k, q.queueUrl]))),
      SES_REGION: cfg.region,
    };
    // Lambda caps a function's environment at 4 KB; leave room for what AWS adds.
    const envBytes = Object.entries(environment).reduce((n, [k, v]) => n + k.length + (v.startsWith("${Token") ? 200 : v.length), 0);
    if (envBytes > 3600) throw new Error(`The functions' environment is ~${envBytes} bytes; Lambda allows 4 KB`);
    // Only the API signs people in: the Cognito app client secret is read by that function alone.
    const cognitoSecret = `insights/${cfg.name}/worker-cognito`;
    const fn = (name: "api" | "jobs" | "cron", memory: number, timeout: Duration, description: string) => {
      const logGroup = new logs.LogGroup(this, `Logs-${name}`, { logGroupName: `/aws/lambda/${prefix}-${name}`, retention: cfg.logRetentionDays as logs.RetentionDays, removalPolicy: RemovalPolicy.RETAIN });
      const f = new lambda.Function(this, `Fn-${name}`, {
        functionName: `${prefix}-${name}`,
        description: `${description} (${commit})`,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: "index.handler",
        code,
        memorySize: memory,
        timeout,
        environment: name === "api" ? { ...environment, COGNITO_WORKER_SECRET_ARN: cognitoSecret } : environment,
        vpc: data.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [data.appSg],
        logGroup,
        tracing: lambda.Tracing.ACTIVE,
        // Each release publishes a version; keeping the old ones is what scripts/rollback.mjs moves
        // the `live` alias back to (CloudFormation would otherwise delete them on the next deploy).
        currentVersionOptions: { removalPolicy: RemovalPolicy.RETAIN },
      });
      data.appSecret.grantRead(f);
      data.dbSecret.grantRead(f);
      data.coordTable.grantReadWriteData(f);
      data.payloads.grantReadWrite(f);
      for (const q of Object.values(queues)) q.grantSendMessages(f);
      if (name === "api") {
        f.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [`arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:${cognitoSecret}-*`] }));
      }
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [`arn:aws:ssm:${cfg.region}:${cfg.account}:parameter${this.runtimeParam}`] }));
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: [`arn:aws:ses:${cfg.region}:${cfg.account}:identity/*`, `arn:aws:ses:${cfg.region}:${cfg.account}:configuration-set/*`] }));
      // Releases move the `live` alias; rolling back moves it to the previous version (scripts/rollback.mjs).
      const alias = new lambda.Alias(this, `Live-${name}`, { aliasName: "live", version: f.currentVersion });
      return { fn: f, alias };
    };
    const api = fn("api", 1024, Duration.seconds(55), "Insights web UI + API");
    const jobs = fn("jobs", 1024, Duration.seconds(900), "Insights background jobs (SQS)");
    const cron = fn("cron", 1024, Duration.seconds(900), "Insights scheduled sweeps + maintenance actions");
    this.apiRole = api.fn.role!;

    // The jobs function's queues. Concurrency per queue as on Cloudflare, but at least 2 (SQS's
    // minimum) and small while the account's Lambda concurrency is 10.
    const sources: Array<[QueueName, number, number, number]> = [
      ["sync", 1, 0, 2],
      ["webhooks", 10, 2, 2],
      ["aggregate", 5, 1, 2],
      ["email", 10, 2, 2],
    ];
    for (const [name, batchSize, windowS, maxConcurrency] of sources) {
      jobs.alias.addEventSource(
        new SqsEventSource(queues[name], {
          batchSize,
          maxBatchingWindow: windowS ? Duration.seconds(windowS) : undefined,
          maxConcurrency,
          reportBatchItemFailures: true,
        }),
      );
      queues[name].grant(jobs.fn, "sqs:ChangeMessageVisibility");
    }

    // --- Public entry: function URL behind CloudFront.
    const url = api.alias.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, invokeMode: lambda.InvokeMode.BUFFERED });
    const originVerify = SecretValue.secretsManager(data.appSecret.secretArn, { jsonField: "ORIGIN_VERIFY" }).unsafeUnwrap();
    const origin = new origins.FunctionUrlOrigin(url, {
      customHeaders: { "x-origin-verify": originVerify },
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(60),
      connectionAttempts: 3,
    });

    // --- Next's hashed build files from S3, not the function. A first page load asks for dozens
    // of chunks at once; through the function each one took a Lambda slot, and past the account's
    // concurrency Lambda answered 429 with a JSON body, which the browser refused to run as a script.
    // Files of earlier builds stay (prune: false), so a page opened before a release, or served
    // again after a rollback of the `live` alias, still finds its chunks.
    const buildFiles = join(FUNCTION_DIR, "public/_next/static");
    if (!existsSync(buildFiles)) throw new Error(`No UI build files at ${buildFiles}: build the package without --skip-web`);
    const site = new s3.Bucket(this, "Site", {
      bucketName: `${prefix}-site-${cfg.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const upload = (id: string, files: Pick<s3deploy.BucketDeploymentProps, "include" | "exclude" | "contentType">) =>
      new s3deploy.BucketDeployment(this, id, {
        sources: [s3deploy.Source.asset(buildFiles)],
        destinationBucket: site,
        destinationKeyPrefix: "_next/static/",
        prune: false,
        cacheControl: [s3deploy.CacheControl.fromString("public, max-age=31536000, immutable")],
        memoryLimit: 512,
        ...files,
      });
    // The upload's CLI types files by name and doesn't know .woff2 (binary/octet-stream otherwise).
    const siteFiles = [upload("SiteFiles", { exclude: ["*.woff2"] }), upload("SiteFonts", { exclude: ["*"], include: ["*.woff2"], contentType: "font/woff2" })];
    // LIST as well as READ: a missing file is then a 404, not S3's 403.
    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(site, { originAccessLevels: [cloudfront.AccessLevel.READ, cloudfront.AccessLevel.LIST] });

    const viewer = new cloudfront.Function(this, "ViewerRequest", {
      functionName: `${prefix}-viewer-request`,
      comment: "Pass the viewer's address and host to the origin (overwriting anything the client sent)",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var r = event.request;",
          "  r.headers['x-insights-viewer-ip'] = { value: event.viewer.ip };",
          "  r.headers['x-insights-viewer-host'] = { value: r.headers.host ? r.headers.host.value : '' };",
          "  return r;",
          "}",
        ].join("\n"),
      ),
    });
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      responseHeadersPolicyName: `${prefix}-security`,
      comment: "Defaults for responses that don't set their own (the app sets most of these itself)",
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: false },
        contentTypeOptions: { override: false },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: false },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: false },
      },
      removeHeaders: ["x-powered-by"],
    });
    this.distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: `Insights ${cfg.name}`,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [{ function: viewer, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        "/_next/static/*": {
          origin: siteOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      webAclId: webAclArn,
    });
    // A release's chunks are in the bucket before CloudFront reads from it, and before the API
    // serves pages that name them.
    this.distribution.node.addDependency(...siteFiles);
    api.alias.node.addDependency(...siteFiles);

    // --- Schedules (Cron Triggers "*/15 * * * *" and "15 3 * * *", UTC). Off until cutover (config.ts).
    const schedulerRole = new iam.Role(this, "SchedulerRole", { roleName: `${prefix}-scheduler`, assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com") });
    cron.alias.grantInvoke(schedulerRole);
    const schedule = (id: string, expression: string, workerCron: string) =>
      new scheduler.CfnSchedule(this, id, {
        name: `${prefix}-${id.toLowerCase()}`,
        description: `Insights cron "${workerCron}" (apps/worker CRON)`,
        scheduleExpression: expression,
        scheduleExpressionTimezone: "UTC",
        flexibleTimeWindow: { mode: "OFF" },
        state: cfg.schedulesEnabled ? "ENABLED" : "DISABLED",
        target: { arn: cron.alias.functionArn, roleArn: schedulerRole.roleArn, input: JSON.stringify({ cron: workerCron }), retryPolicy: { maximumRetryAttempts: 0 } },
      });
    schedule("Every15Min", "cron(0/15 * * * ? *)", "*/15 * * * *");
    schedule("Nightly", "cron(15 3 * * ? *)", "15 3 * * *");

    // --- Alarms → SNS → email.
    const topic = new sns.Topic(this, "Alarms", { topicName: `${prefix}-alarms`, displayName: `Insights ${cfg.name} alarms` });
    if (cfg.alertEmail) topic.addSubscription(new subs.EmailSubscription(cfg.alertEmail));
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string, periods = 1, op = cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD) => {
      const a = new cloudwatch.Alarm(this, id, {
        alarmName: `${prefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: periods,
        comparisonOperator: op,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(new cwActions.SnsAction(topic));
      a.addOkAction(new cwActions.SnsAction(topic));
      return a;
    };
    const five = Duration.minutes(5);
    alarm("api-errors", api.fn.metricErrors({ period: five }), 5, "API function errors (uncaught exceptions, timeouts)");
    alarm("api-throttles", api.fn.metricThrottles({ period: five }), 1, "API requests throttled: the account's Lambda concurrency is exhausted");
    alarm("api-p95-latency", api.fn.metricDuration({ period: five, statistic: "p95" }), 10_000, "API p95 duration above 10 s", 3);
    alarm("jobs-errors", jobs.fn.metricErrors({ period: five }), 5, "Background job function errors");
    alarm("cron-errors", cron.fn.metricErrors({ period: Duration.minutes(15) }), 2, "Scheduled sweeps failing", 2);
    alarm("dlq-not-empty", dlq.metricApproximateNumberOfMessagesVisible({ period: five, statistic: "Maximum" }), 1, "Jobs parked in the dead-letter queue: inspect, then redrive");
    for (const [name, q] of Object.entries(queues)) {
      alarm(`queue-${name}-age`, q.metricApproximateAgeOfOldestMessage({ period: five, statistic: "Maximum" }), 1800, `Oldest ${name} job waiting over 30 minutes`, 2);
    }
    const dbMetric = (metricName: string, statistic = "Average") =>
      new cloudwatch.Metric({ namespace: "AWS/RDS", metricName, dimensionsMap: { DBInstanceIdentifier: data.db.instanceIdentifier }, period: five, statistic });
    alarm("db-cpu", dbMetric("CPUUtilization"), 80, "Database CPU above 80% for 15 minutes", 3);
    alarm("db-free-storage", dbMetric("FreeStorageSpace", "Minimum"), 2 * 1024 ** 3, "Database free storage below 2 GB (storage autoscaling should add more)", 1, cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD);
    alarm("db-free-memory", dbMetric("FreeableMemory", "Minimum"), 150 * 1024 ** 2, "Database freeable memory below 150 MB", 3, cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD);
    alarm("db-connections", dbMetric("DatabaseConnections", "Maximum"), 150, "Database connections above 150 (limit ~200 on t4g.small)", 2);
    // Error lines from the app's logger (console.error → Lambda's ERROR level).
    for (const [name, f] of [["api", api.fn], ["jobs", jobs.fn], ["cron", cron.fn]] as const) {
      const filter = new logs.MetricFilter(this, `ErrorLines-${name}`, {
        logGroup: f.logGroup,
        filterPattern: logs.FilterPattern.anyTerm("ERROR"),
        metricNamespace: "Insights",
        metricName: `${cfg.name}-${name}-error-lines`,
        metricValue: "1",
        defaultValue: 0,
      });
      alarm(`${name}-error-lines`, filter.metric({ period: five, statistic: "Sum" }), name === "api" ? 20 : 50, `Many error log lines from ${name}`, 2);
    }

    new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: prefix,
      widgets: [
        [
          new cloudwatch.GraphWidget({ title: "API requests / errors", left: [api.fn.metricInvocations({ period: five })], right: [api.fn.metricErrors({ period: five }), api.fn.metricThrottles({ period: five })], width: 8 }),
          new cloudwatch.GraphWidget({ title: "API duration (p50 / p95)", left: [api.fn.metricDuration({ period: five, statistic: "p50" }), api.fn.metricDuration({ period: five, statistic: "p95" })], width: 8 }),
          new cloudwatch.GraphWidget({ title: "Jobs / cron", left: [jobs.fn.metricInvocations({ period: five }), cron.fn.metricInvocations({ period: five })], right: [jobs.fn.metricErrors({ period: five }), cron.fn.metricErrors({ period: five })], width: 8 }),
        ],
        [
          new cloudwatch.GraphWidget({ title: "Queue depth", left: [...Object.values(queues), dlq].map((q) => q.metricApproximateNumberOfMessagesVisible({ period: five, statistic: "Maximum" })), width: 8 }),
          new cloudwatch.GraphWidget({ title: "Database CPU / connections", left: [dbMetric("CPUUtilization")], right: [dbMetric("DatabaseConnections", "Maximum")], width: 8 }),
          new cloudwatch.GraphWidget({ title: "Database latency (s)", left: [dbMetric("ReadLatency"), dbMetric("WriteLatency")], width: 8 }),
        ],
      ],
    });

    // --- Budget: the approved lean tier (~US$120-145) plus headroom; alerts at 80% actual, 100% forecast.
    new budgets.CfnBudget(this, "Budget", {
      budget: { budgetName: `${prefix}-monthly`, budgetType: "COST", timeUnit: "MONTHLY", budgetLimit: { amount: cfg.monthlyBudgetUsd, unit: "USD" } },
      notificationsWithSubscribers: cfg.alertEmail
        ? [
            { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" }, subscribers: [{ subscriptionType: "EMAIL", address: cfg.alertEmail }] },
            { notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" }, subscribers: [{ subscriptionType: "EMAIL", address: cfg.alertEmail }] },
          ]
        : undefined,
    });

    new CfnOutput(this, "AppUrl", { value: `https://${this.distribution.distributionDomainName}`, description: "The app (CloudFront)" });
    new CfnOutput(this, "ApiFunctionUrl", { value: url.url, description: "Direct function URL (answers 403 to anything not from CloudFront)" });
    new CfnOutput(this, "CronFunction", { value: cron.alias.functionArn, description: "Invoke with {\"action\":\"migrate\"} or {\"action\":\"counts\"}" });
    new CfnOutput(this, "AlarmTopic", { value: topic.topicArn });
  }
}
