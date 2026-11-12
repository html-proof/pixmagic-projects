import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as smsvoice from "aws-cdk-lib/aws-smsvoice";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { API_PATH_PATTERNS } from "../../../apps/aws/src/paths.js";
import { FUNCTION_DIR, REPO_ROOT, type EnvConfig } from "./config.js";
import { migrateBeforeLive } from "./migrate-before-live.js";

/** Per RDS class: its connection limit (approximate) and the free memory that means "too small". */
const DB_SIZES: Record<string, { connections: number; lowMemoryMb: number }> = {
  "t4g.micro": { connections: 80, lowMemoryMb: 100 },
  "t4g.small": { connections: 200, lowMemoryMb: 150 },
  "t4g.medium": { connections: 400, lowMemoryMb: 300 },
};
import type { DataStack } from "./data-stack.js";
import { loggedBucket } from "./s3-access-logs.js";
import { DATABASE_CHANGES, IAM_CHANGES, ROOT_SIGN_IN, TRAIL_CHANGES, databaseNetworkChanges, securityEventMessage } from "./security-events.js";
import { evolutionUrl } from "./whatsapp-stack.js";
import { viewerRequestCode } from "./viewer-request.js";

type QueueName = "sync" | "webhooks" | "aggregate" | "email" | "smsEvents" | "whatsapp";

/**
 * The application: queues, the three functions (one package), CloudFront, schedules, alarms,
 * the dashboard and the budget. Redeployed on every release.
 *
 * Traffic: viewer → CloudFront (+ WAF) → the `api` function URL, which serves the pages and the API
 * on one origin (first-party session cookie, the same routing as the local server). Next's hashed build
 * files, `/_next/static/*`, come from an S3 bucket instead and are cached at the edge for a year.
 * A page the function can't answer is the site's "temporarily unavailable" page, from that bucket
 * through a second distribution; the API's paths always get the function's own answer.
 * CloudFront adds a secret header the function checks, so the function URL can't be used to go
 * around WAF, and a viewer-request function passes on the viewer's real address and host. With a
 * domain of its own (config.ts `domain`), CloudFront answers on it with the ACM certificate and the
 * viewer-request function sends page requests on its other names there.
 */
export class AppStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  /** The app's origin (APP_URL): https://<domain>, or https://<distribution>.cloudfront.net. */
  readonly appUrl: string;
  readonly apiRole: iam.IRole;
  readonly runtimeParam: string;

  constructor(scope: Construct, id: string, cfg: EnvConfig, data: DataStack, webAclArn: string, props: StackProps) {
    super(scope, id, props);
    const prefix = `insights-${cfg.name}`;
    /** WhatsApp's Evolution API service has a task (whatsapp-stack.ts); false with `-c whatsapp=off`. */
    const whatsappRuns = cfg.whatsapp.tasks > 0;
    this.runtimeParam = `/insights/${cfg.name}/runtime`;

    if (!existsSync(FUNCTION_DIR)) throw new Error(`No Lambda package at ${FUNCTION_DIR}: run \`pnpm --filter @app/aws build\` first`);
    // The commit the package was built from and when (apps/aws/scripts/build.mjs writes build.json);
    // git's HEAD for a package without one. GET /api/version shows both.
    const build = (() => {
      try {
        return JSON.parse(readFileSync(join(FUNCTION_DIR, "build.json"), "utf8")) as { commit: string; builtAt: string };
      } catch {
        return undefined;
      }
    })();
    const commit =
      build?.commit ??
      (() => {
        try {
          return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
        } catch {
          return "unknown";
        }
      })();
    const shortCommit = commit.replace(/^([0-9a-f]{7})[0-9a-f]+/, "$1");

    // --- Queues (sync, webhooks, aggregate, email, smsEvents, whatsapp + a dead-letter queue).
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
    const queues: Record<QueueName, sqs.Queue> = { sync: queue("sync"), webhooks: queue("webhooks"), aggregate: queue("aggregate"), email: queue("email"), smsEvents: queue("smsEvents"), whatsapp: queue("whatsapp") };

    // --- Customer Messaging: AWS End User Messaging SMS (docs/sms.md). The configuration set sends
    // every SMS event (accepted, delivered, failed, opted out...) to a topic only this account's SMS
    // service may publish to, which hands each one, raw, to the smsEvents queue the jobs function
    // reads (core/sms/delivery.ts). Texts are sent with this configuration set, so each one's
    // outcome and price come back; origination identities (sender IDs, numbers) are registered by
    // the owner in the console and tagged for the workspace that may use them (docs/sms.md).
    const smsConfigurationSet = `${prefix}-sms`;
    const smsTopic = new sns.Topic(this, "SmsEvents", { topicName: `${prefix}-sms-events`, displayName: `Insights ${cfg.name} SMS delivery events` });
    smsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("sms-voice.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [smsTopic.topicArn],
        conditions: { StringEquals: { "aws:SourceAccount": cfg.account } },
      }),
    );
    smsTopic.addSubscription(new subs.SqsSubscription(queues.smsEvents, { rawMessageDelivery: true }));
    const smsConfig = new smsvoice.CfnConfigurationSet(this, "SmsConfigurationSet", {
      configurationSetName: smsConfigurationSet,
      eventDestinations: [{ eventDestinationName: "to-jobs", enabled: true, matchingEventTypes: ["TEXT_ALL"], snsDestination: { topicArn: smsTopic.topicArn } }],
    });
    // AWS checks it may publish to the topic when the destination is created: the policy first.
    smsConfig.node.addDependency(smsTopic);

    // --- Functions.
    const code = lambda.Code.fromAsset(FUNCTION_DIR);
    // What only this deployment knows. The app's settings (apps/aws/src/settings.ts) are not here:
    // they ship in the package (index.ts), since together they would fill most of the 4 KB.
    const environment: Record<string, string> = {
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      APP_COMMIT: commit,
      ...(build ? { APP_BUILT_AT: build.builtAt } : {}),
      APP_ENVIRONMENT: cfg.name,
      // Database TLS is verified against Amazon's RDS CA (bundled with the package).
      NODE_EXTRA_CA_CERTS: "/var/task/rds-ca.pem",
      APP_SECRET_ARN: data.appSecret.secretArn,
      RUNTIME_PARAM: this.runtimeParam,
      // The database login of every function: the system role (docs/system-database-role.md), by name
      // like the Evolution secrets below. Only the cron is given the owner's (DB_SECRET_ARN, below).
      SYSTEM_DB_SECRET_ARN: `insights/${cfg.name}/db-system`,
      DB_HOST: data.db.dbInstanceEndpointAddress,
      DB_PORT: data.db.dbInstanceEndpointPort,
      DB_NAME: "app",
      COORD_TABLE: data.coordTable.tableName,
      PAYLOADS_BUCKET: data.payloads.bucketName,
      QUEUE_URLS: Stack.of(this).toJsonString(Object.fromEntries(Object.entries(queues).map(([k, q]) => [k, q.queueUrl]))),
      SES_REGION: cfg.region,
      SMS_CONFIGURATION_SET: smsConfigurationSet,
      // WhatsApp Automation's Evolution API service (whatsapp-stack.ts): its private address, and its
      // global key's secret (read at cold start like the others), by name: an ARN would cost the
      // 4 KB environment ~90 bytes more (Secrets Manager reads a secret by either). With no task
      // running (`-c whatsapp=off`) there is no address to give: the app then says WhatsApp isn't
      // set up, instead of trying a service that can't answer on every sweep and every page.
      ...(whatsappRuns ? { EVOLUTION_API_URL: evolutionUrl(cfg) } : {}),
      EVOLUTION_SECRET_ARN: `insights/${cfg.name}/evolution-api`,
      // A domain is known before the deploy, so the functions get it with the release (no window in
      // which a fresh instance reads the previous address from the runtime parameter). Without one,
      // the address is CloudFront's, which the runtime parameter carries.
      ...(cfg.domain ? { APP_URL: `https://${cfg.domain.name}`, API_URL: `https://${cfg.domain.name}/api` } : {}),
    };
    // Lambda caps a function's environment at 4 KB; leave room for what AWS adds.
    const envBytes = Object.entries(environment).reduce((n, [k, v]) => n + k.length + (v.startsWith("${Token") ? 200 : v.length), 0);
    if (envBytes > 3600) throw new Error(`The functions' environment is ~${envBytes} bytes; Lambda allows 4 KB`);
    // Only the API signs people in: the Cognito app client secret is read by that function alone.
    const cognitoSecret = `insights/${cfg.name}/worker-cognito`;
    // The owner's daily cost email (config.ts costReport) goes where the budget's emails go, from cron alone.
    const costReportTo = cfg.costReport ? cfg.budgetEmail || cfg.alertEmail : "";
    const fn = (name: "api" | "jobs" | "cron", memory: number, timeout: Duration, description: string) => {
      const logGroup = new logs.LogGroup(this, `Logs-${name}`, { logGroupName: `/aws/lambda/${prefix}-${name}`, retention: cfg.logRetentionDays as logs.RetentionDays, removalPolicy: RemovalPolicy.RETAIN });
      const f = new lambda.Function(this, `Fn-${name}`, {
        functionName: `${prefix}-${name}`,
        description: `${description} (${shortCommit})`,
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        handler: "index.handler",
        code,
        memorySize: memory,
        timeout,
        environment: {
          ...environment,
          ...(name === "api" ? { COGNITO_WORKER_SECRET_ARN: cognitoSecret } : {}),
          ...(name === "cron" && costReportTo ? { COST_REPORT_TO: costReportTo } : {}),
          // Only the cron makes the WhatsApp service's database role (its "evolution-db" action) and prunes its data.
          ...(name === "cron" ? { EVOLUTION_DB_SECRET_ARN: `insights/${cfg.name}/evolution-db` } : {}),
          // The owner's login: the cron's maintenance actions (migrate, counts, evolution-db) change tables.
          ...(name === "cron" ? { DB_SECRET_ARN: data.dbSecret.secretArn } : {}),
        },
        vpc: data.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [data.appSg],
        logGroup,
        // No X-Ray: nothing in the code reads traces, and storing them was ~US$0.46 a month
        // (docs/aws-migration/AWS_COST_AUDIT.md). Logs, metrics and alarms stay in CloudWatch.
        tracing: lambda.Tracing.DISABLED,
        // Each release publishes a version; keeping the old ones is what scripts/rollback.mjs moves
        // the `live` alias back to (CloudFormation would otherwise delete them on the next deploy).
        currentVersionOptions: { removalPolicy: RemovalPolicy.RETAIN },
      });
      data.appSecret.grantRead(f);
      data.systemDbSecret.grantRead(f);
      if (name === "cron") data.dbSecret.grantRead(f);
      data.evolutionSecret.grantRead(f);
      if (name === "cron") data.evolutionDbSecret.grantRead(f);
      data.coordTable.grantReadWriteData(f);
      data.payloads.grantReadWrite(f);
      for (const q of Object.values(queues)) q.grantSendMessages(f);
      if (name === "api") {
        f.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [`arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:${cognitoSecret}-*`] }));
      }
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [`arn:aws:ssm:${cfg.region}:${cfg.account}:parameter${this.runtimeParam}`] }));
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: [`arn:aws:ses:${cfg.region}:${cfg.account}:identity/*`, `arn:aws:ses:${cfg.region}:${cfg.account}:configuration-set/*`] }));
      // Releases move the `live` alias once the new cron version has run the release's migrations
      // (MigrateBeforeLive below); rolling back moves it to the previous version (scripts/rollback.mjs).
      const alias = new lambda.Alias(this, `Live-${name}`, { aliasName: "live", version: f.currentVersion });
      return { fn: f, alias };
    };
    const api = fn("api", 1024, Duration.seconds(55), "Insights web UI + API");
    const jobs = fn("jobs", 1024, Duration.seconds(900), "Insights background jobs (SQS)");
    const cron = fn("cron", 1024, Duration.seconds(900), "Insights scheduled sweeps + maintenance actions");
    this.apiRole = api.fn.role!;
    // A release's migrations ship in its package, so only its new code can run them. Run after the
    // deploy, they left new code reading a column that wasn't there yet (stores.customers_from,
    // release 141, ~67 s). So the new cron version migrates first and the three `live` aliases wait
    // for it: a failed migration fails the stack before any of them moves (migrate-before-live.ts).
    // The S3 uploads go on alongside; Live-api also waits for them (below).
    const migrated = cfg.migrateBeforeLive ? migrateBeforeLive(this, cfg, cron.fn.currentVersion, this.runtimeParam) : undefined;
    if (migrated) for (const f of [api, jobs, cron]) f.alias.node.addDependency(migrated);
    // Customer Messaging's calls to AWS End User Messaging SMS, each function only what it does.
    // Sending is scoped to this account's configuration sets and origination identities, in any
    // region (Indian local routes are in ap-south-1); the Describe calls have no resource-level
    // permissions. The API sends test texts and verifies test numbers and senders; the jobs send;
    // the cron reads the opt-out lists and re-checks senders daily.
    const smsArns = (...types: string[]) => types.map((t) => `arn:aws:sms-voice:*:${cfg.account}:${t}/*`);
    const smsSend = new iam.PolicyStatement({ actions: ["sms-voice:SendTextMessage"], resources: smsArns("configuration-set", "phone-number", "sender-id", "pool", "protect-configuration") });
    const smsDescribe = new iam.PolicyStatement({
      actions: ["sms-voice:DescribeAccountAttributes", "sms-voice:DescribeSpendLimits", "sms-voice:DescribePhoneNumbers", "sms-voice:DescribeSenderIds", "sms-voice:DescribePools", "sms-voice:DescribeRegistrations", "sms-voice:ListTagsForResource"],
      resources: ["*"],
    });
    jobs.fn.addToRolePolicy(smsSend);
    api.fn.addToRolePolicy(smsSend);
    api.fn.addToRolePolicy(smsDescribe);
    api.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sms-voice:CreateVerifiedDestinationNumber", "sms-voice:SendDestinationNumberVerificationCode", "sms-voice:VerifyDestinationNumber", "sms-voice:DeleteVerifiedDestinationNumber", "sms-voice:TagResource"],
        resources: ["*"],
      }),
    );
    cron.fn.addToRolePolicy(smsDescribe);
    cron.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["sms-voice:DescribeOptedOutNumbers"], resources: smsArns("opt-out-list") }));

    // The cost email's one Cost Explorer call a day (it has no resource-level permissions).
    if (costReportTo) cron.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["ce:GetCostAndUsage"], resources: ["*"] }));

    // The jobs function's queues. Concurrency per queue at least 2 (SQS's minimum) and small
    // (sized when the account's Lambda concurrency was 10; it is 1,000 now, so these can rise
    // with the database's connection limit: each running job holds a connection).
    const sources: Array<[QueueName, number, number, number]> = [
      ["sync", 1, 0, 2],
      ["webhooks", 10, 2, 2],
      ["aggregate", 5, 1, 2],
      ["email", 10, 2, 2],
      ["smsEvents", 10, 2, 2],
      // WhatsApp sends, Evolution API's events and campaign batches: quick jobs, each store paced by its own lock.
      ["whatsapp", 10, 1, 3],
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
    // again after a rollback of the `live` alias, still finds its chunks. Versioned (Trusted Advisor
    // "S3 Bucket Versioning"): a file deleted or overwritten by mistake comes back from its earlier
    // version for 30 days (a deploy re-uploading the same file leaves one too).
    const buildFiles = join(FUNCTION_DIR, "public/_next/static");
    if (!existsSync(buildFiles)) throw new Error(`No UI build files at ${buildFiles}: build the package without --skip-web`);
    const site = new s3.Bucket(this, "Site", {
      // Logs its requests to the Data stack's log bucket (s3-access-logs.ts).
      ...loggedBucket(`${prefix}-site-${cfg.account}`, s3.Bucket.fromBucketName(this, "AccessLogs", data.accessLogs.bucketName)),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30), expiredObjectDeleteMarker: true, abortIncompleteMultipartUploadAfter: Duration.days(1) }],
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
      comment: cfg.domain
        ? `Pass the viewer's address and host to the origin; page requests on other names go to ${cfg.domain.name}`
        : "Pass the viewer's address and host to the origin (overwriting anything the client sent)",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(viewerRequestCode(cfg.domain?.name)),
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

    // --- While the function can't answer a page (down, timing out, out of Lambda capacity), the
    // site's own "temporarily unavailable" page as a 503, at the address asked for, not CloudFront's
    // bare error page or Lambda's JSON. Pages only: the API's paths (paths.ts) keep their own
    // answers, the app's 502s and 503s ("Google is still approving bizinsights…") included. A custom
    // error page can't be scoped like that (it is the whole distribution's), so pages go to an origin
    // group whose fallback is a second, tiny distribution: every address there is missing from the
    // bucket's _fallback/, and its error page is the page (apps/web's /unavailable, which the build
    // moves out of the function's files). Its styles and scripts are /_next/static/*, the bucket.
    const fallbackFiles = join(FUNCTION_DIR, "fallback");
    if (!existsSync(join(fallbackFiles, "unavailable.html"))) throw new Error(`No unavailable page at ${fallbackFiles}: build the package without --skip-web`);
    const fallbackPage = new s3deploy.BucketDeployment(this, "FallbackPage", {
      sources: [s3deploy.Source.asset(fallbackFiles)],
      destinationBucket: site,
      destinationKeyPrefix: "_fallback/",
      // A browser asks again next time instead of keeping the outage as that address's page.
      cacheControl: [s3deploy.CacheControl.fromString("no-store")],
      memoryLimit: 512,
    });
    const fallback = new cloudfront.Distribution(this, "FallbackCdn", {
      comment: `Insights ${cfg.name}: the page shown while the app can't answer`,
      defaultBehavior: {
        // Read only, no list: a missing file is S3's 403.
        origin: origins.S3BucketOrigin.withOriginAccessControl(site, { originPath: "/_fallback", originAccessLevels: [cloudfront.AccessLevel.READ] }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 503, responsePagePath: "/unavailable.html", ttl: Duration.seconds(0) })),
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });
    fallback.node.addDependency(fallbackPage);
    const pages = new origins.OriginGroup({
      primaryOrigin: origin,
      fallbackOrigin: new origins.HttpOrigin(fallback.distributionDomainName, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY, originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2] }),
      // 503 also covers CloudFront failing to connect, 504 the function taking too long, 429 Lambda's
      // concurrency running out. The static UI never answers any of them itself.
      fallbackStatusCodes: [429, 500, 502, 503, 504],
    });

    const toFunction: cloudfront.BehaviorOptions = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: securityHeaders,
      functionAssociations: [{ function: viewer, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
    };
    this.distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: `Insights ${cfg.name}`,
      // The pages (everything but the API's paths), GET and HEAD as the static UI answers: CloudFront
      // fails over for those methods only.
      defaultBehavior: { ...toFunction, origin: pages, allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD },
      additionalBehaviors: {
        "/_next/static/*": {
          origin: siteOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
        ...Object.fromEntries(API_PATH_PATTERNS.map((pattern) => [pattern, toFunction])),
      },
      ...(cfg.domain
        ? {
            domainNames: [cfg.domain.name, ...cfg.domain.redirects],
            certificate: acm.Certificate.fromCertificateArn(this, "Certificate", cfg.domain.certificateArn),
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      webAclId: webAclArn,
    });
    // A release's chunks are in the bucket before CloudFront reads from it, and before the API
    // serves pages that name them.
    this.distribution.node.addDependency(...siteFiles);
    api.alias.node.addDependency(...siteFiles);
    this.appUrl = cfg.domain ? `https://${cfg.domain.name}` : `https://${this.distribution.distributionDomainName}`;

    // --- Schedules (Cron Triggers "*/15 * * * *" and "15 3 * * *", UTC). Off until cutover (config.ts).
    // A tick that never ran lands in a queue instead of vanishing: one Scheduler couldn't hand to
    // Lambda (retried for 10 minutes), or one Lambda gave up on (failed three times, or couldn't
    // start before the next tick was due). The sweeps take over on the next tick either way.
    const missedTicks = new sqs.Queue(this, "MissedTicks", { queueName: `${prefix}-cron-missed`, retentionPeriod: Duration.days(14), encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true });
    cron.alias.configureAsyncInvoke({ onFailure: new destinations.SqsDestination(missedTicks), retryAttempts: 2, maxEventAge: Duration.minutes(15) });
    const schedulerRole = new iam.Role(this, "SchedulerRole", { roleName: `${prefix}-scheduler`, assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com") });
    cron.alias.grantInvoke(schedulerRole);
    missedTicks.grantSendMessages(schedulerRole);
    // Scheduler retries only a hand-over Lambda refused (throttled, unavailable), never a run that
    // failed, so a retry can't run a tick twice.
    const target = (input: Record<string, string>): scheduler.CfnSchedule.TargetProperty => ({
      arn: cron.alias.functionArn,
      roleArn: schedulerRole.roleArn,
      input: JSON.stringify(input),
      retryPolicy: { maximumRetryAttempts: 5, maximumEventAgeInSeconds: 600 },
      deadLetterConfig: { arn: missedTicks.queueArn },
    });
    const schedule = (id: string, expression: string, workerCron: string) =>
      new scheduler.CfnSchedule(this, id, {
        name: `${prefix}-${id.toLowerCase()}`,
        description: `Insights cron "${workerCron}" (apps/worker CRON)`,
        scheduleExpression: expression,
        scheduleExpressionTimezone: "UTC",
        flexibleTimeWindow: { mode: "OFF" },
        state: cfg.schedulesEnabled ? "ENABLED" : "DISABLED",
        target: target({ cron: workerCron }),
      });
    schedule("Every15Min", "cron(0/15 * * * ? *)", "*/15 * * * *");
    schedule("Nightly", "cron(15 3 * * ? *)", "15 3 * * *");
    // The owner's daily AWS cost email (apps/aws costReport.ts): 07:00 in Victoria, ~20 hours after
    // the UTC day it reports ended, so Cost Explorer has it. On whatever `schedules` says: it reads
    // the bill and touches no store.
    if (costReportTo) {
      new scheduler.CfnSchedule(this, "CostReport", {
        name: `${prefix}-costreport`,
        description: "The owner's daily AWS cost email (apps/aws costReport.ts)",
        scheduleExpression: "cron(0 7 * * ? *)",
        scheduleExpressionTimezone: "Australia/Melbourne",
        flexibleTimeWindow: { mode: "OFF" },
        state: "ENABLED",
        target: target({ action: "cost-report" }),
      });
    }

    // --- Alarms → SNS → email.
    const topic = new sns.Topic(this, "Alarms", { topicName: `${prefix}-alarms`, displayName: `Insights ${cfg.name} alarms` });
    // An email subscription counts only once its address clicks "Confirm subscription" in AWS's
    // first email; unconfirmed, SNS drops it after a few days while CloudFormation still lists it,
    // and no later deploy brings it back. That happened to the first one (found 2026-11-12: the
    // topic had no subscriber at all). The id is its own, not the address's, and was renamed then so
    // CloudFormation made the subscription again; if it is ever lost the same way, rename it again.
    if (cfg.alertEmail) new sns.Subscription(this, "AlarmEmail2", { topic, protocol: sns.SubscriptionProtocol.EMAIL, endpoint: cfg.alertEmail });
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
    // PostgreSQL's default max_connections is about the instance's memory / 9.5 MB.
    const dbSize = DB_SIZES[cfg.dbInstanceType] ?? DB_SIZES["t4g.small"]!;
    alarm("db-free-memory", dbMetric("FreeableMemory", "Minimum"), dbSize.lowMemoryMb * 1024 ** 2, `Database freeable memory below ${dbSize.lowMemoryMb} MB: time for a bigger dbInstanceType`, 3, cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD);
    alarm("db-connections", dbMetric("DatabaseConnections", "Maximum"), Math.round(dbSize.connections * 0.75), `Database connections above 75% of the ~${dbSize.connections} limit on ${cfg.dbInstanceType}`, 2);
    alarm("cron-missed-ticks", missedTicks.metricApproximateNumberOfMessagesVisible({ period: five, statistic: "Maximum" }), 1, "A scheduled run never ran (Scheduler couldn't invoke the cron function, or Lambda gave up on it): the message says which");
    // The NAT instances' alarms (recover, reboot, busy) are in the data stack, beside them.

    // RDS's own word about the database (stopped, failed, failed over, out of storage, back again):
    // the one thing every request needs, so it goes to the same topic. A
    // topic policy replaces SNS's default one, so it names CloudWatch (the alarms above) as well.
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com"), new iam.ServicePrincipal("events.rds.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
        conditions: { StringEquals: { "aws:SourceAccount": cfg.account } },
      }),
    );
    new rds.CfnEventSubscription(this, "DbEvents", {
      subscriptionName: `${prefix}-db-events`,
      snsTopicArn: topic.topicArn,
      sourceType: "db-instance",
      sourceIds: [data.db.instanceIdentifier],
      eventCategories: ["availability", "failure", "failover", "low storage", "maintenance", "recovery", "restoration"],
      enabled: true,
    });
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
    // Customer Messaging on hold: AWS failing repeatedly (circuit open), the account's SMS spending
    // limit reached, or bizinsights' own monthly ceiling (SMS_ACCOUNT_MONTHLY_LIMIT_USD) reached.
    for (const [name, f] of [["jobs", jobs.fn], ["api", api.fn]] as const) {
      const smsHold = new logs.MetricFilter(this, `SmsHold-${name}`, {
        logGroup: f.logGroup,
        filterPattern: logs.FilterPattern.anyTerm("sms circuit opened", "sms held", "sms platform monthly limit reached"),
        metricNamespace: "Insights",
        metricName: `${cfg.name}-${name}-sms-hold`,
        metricValue: "1",
        defaultValue: 0,
      });
      alarm(`sms-hold-${name}`, smsHold.metric({ period: five, statistic: "Sum" }), 1, `Texts are on hold (${name}): AWS failing, the SMS spending limit, or the platform's monthly SMS ceiling; see docs/sms.md`);
    }
    // Automated messages the providers refuse (each SMS refusal, retried or not, and each failed
    // email send): a burst means a provider, an account or a sender has a problem the Automations
    // hub's history shows message by message (docs/automations.md, "Alarms").
    const sendFailures = new logs.MetricFilter(this, "MessagingSendFailures", {
      logGroup: jobs.fn.logGroup,
      filterPattern: logs.FilterPattern.anyTerm("sms send refused", "email send failed", "whatsapp send refused by the provider"),
      metricNamespace: "Insights",
      metricName: `${cfg.name}-messaging-send-failures`,
      metricValue: "1",
      defaultValue: 0,
    });
    alarm("messaging-send-failures", sendFailures.metric({ period: five, statistic: "Sum" }), 25, "Many automated SMS, emails or WhatsApp messages refused by their providers: see the message histories, docs/automations.md and docs/whatsapp.md", 2);
    // WhatsApp's Evolution API service not answering the cron's check (every 15 minutes): no store can
    // connect or send until it is back (whatsapp-stack.ts has the service's own alarms). Like those,
    // not while the service is switched off on purpose: nothing asks it then.
    if (whatsappRuns) {
      const evolutionDown = new logs.MetricFilter(this, "EvolutionUnreachable", {
        logGroup: cron.fn.logGroup,
        filterPattern: logs.FilterPattern.anyTerm("evolution unreachable"),
        metricNamespace: "Insights",
        metricName: `${cfg.name}-evolution-unreachable`,
        metricValue: "1",
        defaultValue: 0,
      });
      alarm("whatsapp-service-unreachable", evolutionDown.metric({ period: Duration.minutes(15), statistic: "Sum" }), 1, "WhatsApp's Evolution API service didn't answer the sweep: no store can connect or send (docs/whatsapp.md, Runbook)", 2);
    }
    const hour = Duration.hours(1);
    // Sync-queue jobs that failed for good with every attempt spent (consume's "sync job failed" with
    // final: true, from the sixth delivery: core's MAX_ATTEMPTS): a store's orders, catalog or stock, an
    // ad account's sync, a check against Shopify, failing with something a retry should have got past
    // (a platform's 5xx or 429, a network error, our own code). A failure no retry helps (final on its
    // first attempt: UnrecoverableError) is left out: a shop that is paused, frozen or closed (Shopify
    // 402/404/423), access Shopify refuses, protected customer data not approved, an ad connection
    // marked for its merchant. Each of those is told to its merchant (an alert, the ad account's card;
    // ad connections have their own alarm below) and comes back with every daily reconcile, which
    // starts all stores in the same tick: three such stores would make ten lines in that hour every
    // day. One store's jobs that run out of attempts are a handful at most (orders, products, variants,
    // its check, its ad accounts); ten in an hour is more than one store makes, and points at a cause
    // every store meets: ours, or a platform's outage that outlasted the retries.
    const syncFailures = new logs.MetricFilter(this, "SyncJobsFailedForGood", {
      logGroup: jobs.fn.logGroup,
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue("$.msg", "=", "sync job failed"),
        logs.FilterPattern.booleanValue("$.final", true),
        logs.FilterPattern.numberValue("$.attempts", ">=", 6),
      ),
      metricNamespace: "Insights",
      metricName: `${cfg.name}-sync-jobs-failed-for-good`,
      metricValue: "1",
      defaultValue: 0,
    });
    alarm("sync-jobs-failed-for-good", syncFailures.metric({ period: hour, statistic: "Sum" }), 10, "Ten or more sync jobs ran out of attempts in an hour, more than one store makes: see docs/RUNBOOK.md");
    // Ad connections turning to "reconnect" or "permission" (core's recordAdFailure logs each once, when
    // it turns), from a sync (jobs), a live report (api) or the cron's own reads. One merchant's sign-in
    // ending turns the accounts connected with it, one to a few for a store, and each sign-in ends at a
    // time of its own (Meta's last about 60 days); ten in an hour, across stores, is a break at the
    // platform or in bizinsights' app (access cut for the app, its secret changed, a code misread).
    const needMerchants = `${cfg.name}-ad-connections-need-merchants`;
    for (const [name, f] of [["api", api.fn], ["jobs", jobs.fn], ["cron", cron.fn]] as const) {
      new logs.MetricFilter(this, `AdsNeedMerchant-${name}`, {
        logGroup: f.logGroup,
        filterPattern: logs.FilterPattern.anyTerm("ad connection needs the merchant"),
        metricNamespace: "Insights",
        metricName: needMerchants,
        metricValue: "1",
        defaultValue: 0,
      });
    }
    alarm("ad-connections-need-merchants", new cloudwatch.Metric({ namespace: "Insights", metricName: needMerchants, period: hour, statistic: "Sum" }), 10, "Ten or more ad connections turned to Reconnect or permission in an hour: a platform-wide break, not one merchant's sign-in (docs/RUNBOOK.md)");
    // The cron's daily check of each Meta and AdSense account's settled week against the platform (core's
    // adConnections/verify.ts) found a figure outside its tolerance. Once a day per account and on finished
    // days, so any one is a fault to look at; the alarm clears the hour after and fires again on the
    // next day's check while the difference stays.
    const figuresDiffer = new logs.MetricFilter(this, "AdFiguresDiffer", {
      logGroup: cron.fn.logGroup,
      filterPattern: logs.FilterPattern.anyTerm("ad figures differ from the platform"),
      metricNamespace: "Insights",
      metricName: `${cfg.name}-ad-figures-differ`,
      metricValue: "1",
      defaultValue: 0,
    });
    alarm("ad-figures-differ", figuresDiffer.metric({ period: hour, statistic: "Sum" }), 1, "Stored ad figures differ from what the platform reports for the same week: see docs/RUNBOOK.md");
    // Logins PostgreSQL refused: a wrong password, or a connection its rules don't admit (no TLS, an
    // unknown role or database). Only the functions, the WhatsApp service and the admin host can
    // reach the port, each with a generated password, so in normal running there are none: five in
    // five minutes is a secret out of step after a change, or someone inside the network guessing.
    // In place of GuardDuty's RDS login protection (docs/aws-deployment.md, "Security events").
    const dbLoginFailures = new logs.MetricFilter(this, "DbLoginFailures", {
      logGroup: logs.LogGroup.fromLogGroupName(this, "DbLog", data.dbLogGroupName),
      filterPattern: logs.FilterPattern.anyTerm("password authentication failed", "no pg_hba.conf entry"),
      metricNamespace: "Insights",
      metricName: `${cfg.name}-db-login-failures`,
      metricValue: "1",
      defaultValue: 0,
    });
    alarm("db-login-failures", dbLoginFailures.metric({ period: five, statistic: "Sum" }), 5, "PostgreSQL refused five or more logins in five minutes: a secret out of step, or someone guessing (docs/aws-deployment.md, Security events)");

    // Changes to the account that are worth an email as they happen (security-events.ts). The
    // account's, not an environment's: production's topic gets them.
    if (cfg.name === "production") {
      const patterns: Record<string, [string, events.EventPattern]> = {
        Database: ["a database, snapshot or backup deleted or changed", DATABASE_CHANGES],
        DatabaseNetwork: ["a rule added to the database's security group", databaseNetworkChanges(data.dbSg.securityGroupId)],
        Trail: ["the audit trail stopped, deleted or redirected", TRAIL_CHANGES],
        Iam: ["a new IAM user or access key, or a policy attached", IAM_CHANGES],
        RootSignIn: ["the root user signing in to the console", ROOT_SIGN_IN],
      };
      for (const [id, [what, eventPattern]] of Object.entries(patterns)) {
        new events.Rule(this, `Security${id}`, {
          ruleName: `${prefix}-security-${id.replace(/(?<=.)[A-Z]/g, (c) => `-${c}`).toLowerCase()}`,
          description: `Emails the alarm topic: ${what}`,
          eventPattern,
          targets: [new eventTargets.SnsTopic(topic, { message: securityEventMessage() })],
        });
      }
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

    // --- Budget: the owner's ceiling (US$50-80/month, 2026-10-18), tax included. Emails when the
    // month's spend passes 50, 75, 90 and 100% of it, and when AWS forecasts the month above it
    // (five: the most a budget takes). Nothing is stopped at any threshold.
    const budgetEmail = cfg.budgetEmail || cfg.alertEmail;
    const budgetAlerts: budgets.CfnBudget.NotificationWithSubscribersProperty[] | undefined = budgetEmail
      ? [
          ...[50, 75, 90, 100].map((threshold) => ({ notificationType: "ACTUAL", threshold })),
          { notificationType: "FORECASTED", threshold: 100 },
        ].map((n) => ({ notification: { ...n, comparisonOperator: "GREATER_THAN", thresholdType: "PERCENTAGE" }, subscribers: [{ subscriptionType: "EMAIL", address: budgetEmail }] }))
      : undefined;
    // CloudFormation replaces a budget whose alerts change (they can't be updated in place), and the
    // replacement can't take the old one's name; a digest of the alerts in the name lets it.
    const alertsDigest = budgetAlerts ? `-${createHash("sha256").update(JSON.stringify(budgetAlerts)).digest("hex").slice(0, 8)}` : "";
    new budgets.CfnBudget(this, "Budget", {
      budget: { budgetName: `${prefix}-monthly${alertsDigest}`, budgetType: "COST", timeUnit: "MONTHLY", budgetLimit: { amount: cfg.monthlyBudgetUsd, unit: "USD" } },
      notificationsWithSubscribers: budgetAlerts,
    });

    new CfnOutput(this, "AppUrl", { value: this.appUrl, description: "The app" });
    new CfnOutput(this, "CloudFrontDomain", { value: this.distribution.distributionDomainName, description: "CloudFront's own name: the DNS target of the app's domain" });
    new CfnOutput(this, "FallbackDomain", { value: fallback.distributionDomainName, description: "Where CloudFront gets the page it shows while the app can't answer (any path; a 503)" });
    new CfnOutput(this, "ApiFunctionUrl", { value: url.url, description: "Direct function URL (answers 403 to anything not from CloudFront)" });
    new CfnOutput(this, "CronFunction", { value: cron.alias.functionArn, description: "Invoke with {\"action\":\"migrate\"} or {\"action\":\"counts\"}" });
    if (migrated) new CfnOutput(this, "MigratedBeforeLive", { value: migrated.getAttString("Applied"), description: "What the migrate gate did with the newest cron version before moving live (applied, or why it skipped)" });
    // The versions this stack points `live` at. rollback.mjs moves the aliases behind CloudFormation's
    // back, so a Deploy run again for the same commit ("no changes") would leave them on the release
    // before: the workflow then moves them to these (rollback.mjs --to stack).
    new CfnOutput(this, "LiveVersions", {
      value: `api=${api.alias.version.version},jobs=${jobs.alias.version.version},cron=${cron.alias.version.version}`,
      description: "The function versions this stack deployed as live (rollback.mjs --to stack moves the aliases back to them)",
    });
    new CfnOutput(this, "AlarmTopic", { value: topic.topicArn });
  }
}
