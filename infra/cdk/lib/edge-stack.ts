import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import { CLOUDFLARE_CLIENT_IP_HEADER, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from "./cloudflare.js";
import type { EnvConfig } from "./config.js";
import { accessLogBucket, bootstrapAssetsBucket, logBucketAccess } from "./s3-access-logs.js";

/**
 * API requests a minute from one client address before WAF answers 429. One address is often many
 * people (an office, a campus, a mobile carrier's NAT), so this is sized for a shared address
 * (about a hundred dashboard loads a minute), not one person's pace; floods are still cut off
 * before they cost an invocation. The app applies the same figure itself (apps/aws/src/app.ts,
 * GLOBAL_LIMIT_PER_MIN) and finer limits per endpoint (apps/api/src/rateLimit.ts).
 */
const API_REQUESTS_PER_MINUTE_PER_IP = 1500;

/**
 * AWS WAF in front of CloudFront. A CloudFront web ACL must live in us-east-1, so this is its own
 * stack there; the App stack in Sydney references it (crossRegionReferences). Being the account's
 * only stack in us-east-1, production's also holds the Region's S3 access log bucket, for the
 * bucket `cdk bootstrap` made there (s3-access-logs.ts).
 *
 * Rules, in order:
 *  1. Per-IP rate limit on the API: 300 requests a minute, as the app's own globalLimit. Webhooks,
 *     the storefront pixel and health checks are exempt, as in the app (GLOBAL_LIMIT_EXEMPT).
 *  2. The same limit per client for requests that come through Cloudflare's proxy (the domain's DNS
 *     is there, proxied): those all come from Cloudflare's addresses, so they are counted by the
 *     client's address in `CF-Connecting-IP` instead (cloudflare.ts).
 *  3. Amazon's IP reputation list: known bad sources, blocked. Not applied to Cloudflare's own
 *     addresses, which would block everyone behind one edge; Cloudflare screens those clients.
 *  4. Known bad inputs (Log4Shell, bad Host headers, ...): blocked.
 *  5. Amazon's common rule set, in COUNT mode: it blocks request bodies over 8 KB and anything that
 *     looks like HTML or a URL in a body or query string, which Shopify webhooks, OAuth callbacks
 *     and merchants' email templates all are. Counted, so its matches can be reviewed in the WAF
 *     console before any of it is switched to blocking.
 */
export class EdgeStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, props);

    // The path as the app will route it (it parses the URL, which decodes %2e and resolves dot
    // segments): matched raw, /api/webhooks/../auth/login would count as a webhook and skip the
    // per-IP limit while the app serves it as /api/auth/login.
    const routedPath = [
      { priority: 0, type: "URL_DECODE" },
      { priority: 1, type: "NORMALIZE_PATH" },
    ];
    const exempt = ["/api/webhooks/", "/api/pixel/", "/webhooks/", "/pixel/"].map((path) => ({
      byteMatchStatement: {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: "STARTS_WITH",
        searchString: path,
        textTransformations: routedPath,
      },
    }));
    const isApi = {
      byteMatchStatement: {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: "STARTS_WITH",
        searchString: "/api/",
        textTransformations: routedPath,
      },
    };
    const cloudflare = (version: "IPV4" | "IPV6", addresses: string[]) =>
      new wafv2.CfnIPSet(this, `Cloudflare${version}`, {
        name: `insights-${cfg.name}-cloudflare-${version.toLowerCase()}`,
        description: "Cloudflare proxy addresses, infra/cdk/lib/cloudflare.ts",
        scope: "CLOUDFRONT",
        ipAddressVersion: version,
        addresses,
      });
    const fromCloudflare = {
      orStatement: { statements: [cloudflare("IPV4", CLOUDFLARE_IPV4), cloudflare("IPV6", CLOUDFLARE_IPV6)].map((set) => ({ ipSetReferenceStatement: { arn: set.attrArn } })) },
    };
    const notFromCloudflare = { notStatement: { statement: fromCloudflare } };
    const limitedApi = [isApi, { notStatement: { statement: { orStatement: { statements: exempt } } } }];
    const visibility = (name: string) => ({ cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: `insights-${cfg.name}-${name}` });

    const acl = new wafv2.CfnWebACL(this, "WebAcl", {
      name: `insights-${cfg.name}`,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: visibility("all"),
      rules: [
        {
          name: "api-rate-per-ip",
          priority: 1,
          action: { block: { customResponse: { responseCode: 429 } } },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: "IP",
              evaluationWindowSec: 60,
              limit: API_REQUESTS_PER_MINUTE_PER_IP,
              scopeDownStatement: { andStatement: { statements: [...limitedApi, notFromCloudflare] } },
            },
          },
          visibilityConfig: visibility("api-rate"),
        },
        {
          name: "api-rate-per-client-via-cloudflare",
          priority: 2,
          action: { block: { customResponse: { responseCode: 429 } } },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: "FORWARDED_IP",
              forwardedIpConfig: { headerName: CLOUDFLARE_CLIENT_IP_HEADER, fallbackBehavior: "NO_MATCH" },
              evaluationWindowSec: 60,
              limit: API_REQUESTS_PER_MINUTE_PER_IP,
              scopeDownStatement: { andStatement: { statements: [...limitedApi, fromCloudflare] } },
            },
          },
          visibilityConfig: visibility("api-rate-cloudflare"),
        },
        {
          name: "aws-ip-reputation",
          priority: 3,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList", scopeDownStatement: notFromCloudflare } },
          visibilityConfig: visibility("ip-reputation"),
        },
        {
          name: "aws-known-bad-inputs",
          priority: 4,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesKnownBadInputsRuleSet" } },
          visibilityConfig: visibility("known-bad-inputs"),
        },
        {
          name: "aws-common-count-only",
          priority: 5,
          overrideAction: { count: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" } },
          visibilityConfig: visibility("common"),
        },
      ],
    });
    this.webAclArn = acl.attrArn;

    // S3 delivers access logs within a Region only, so CDK's bucket here needs a log bucket here.
    // Production's, since that bucket is the account's (staging deploys through it too).
    if (cfg.name === "production") {
      const accessLogs = accessLogBucket(this, "AccessLogs", `insights-${cfg.name}-s3-logs-${this.region}-${cfg.account}`);
      const setup = logBucketAccess(this, "BootstrapBucketLogging", {
        bucketName: bootstrapAssetsBucket(cfg.account, this.region),
        target: accessLogs,
        logGroup: new logs.LogGroup(this, "BootstrapBucketLoggingLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      });
      setup.node.addDependency(accessLogs.policy!);
    }
  }
}
