import { Stack, type StackProps } from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/**
 * AWS WAF in front of CloudFront. A CloudFront web ACL must live in us-east-1, so this is its own
 * stack there; the App stack in Sydney references it (crossRegionReferences).
 *
 * Rules, in order:
 *  1. Per-IP rate limit on the API: 300 requests a minute, the Worker's GLOBAL_LIMITER. Webhooks,
 *     the storefront pixel and health checks are exempt, as in the app (GLOBAL_LIMIT_EXEMPT).
 *  2. Amazon's IP reputation list: known bad sources, blocked.
 *  3. Known bad inputs (Log4Shell, bad Host headers, ...): blocked.
 *  4. Amazon's common rule set, in COUNT mode: it blocks request bodies over 8 KB and anything that
 *     looks like HTML or a URL in a body or query string, which Shopify webhooks, OAuth callbacks
 *     and merchants' email templates all are. Counted, so its matches can be reviewed in the WAF
 *     console before any of it is switched to blocking.
 */
export class EdgeStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, props);

    const exempt = ["/api/webhooks/", "/api/pixel/", "/webhooks/", "/pixel/"].map((path) => ({
      byteMatchStatement: {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: "STARTS_WITH",
        searchString: path,
        textTransformations: [{ priority: 0, type: "NONE" }],
      },
    }));
    const isApi = {
      byteMatchStatement: {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: "STARTS_WITH",
        searchString: "/api/",
        textTransformations: [{ priority: 0, type: "NONE" }],
      },
    };
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
              limit: 300,
              scopeDownStatement: { andStatement: { statements: [isApi, { notStatement: { statement: { orStatement: { statements: exempt } } } }] } },
            },
          },
          visibilityConfig: visibility("api-rate"),
        },
        {
          name: "aws-ip-reputation",
          priority: 2,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList" } },
          visibilityConfig: visibility("ip-reputation"),
        },
        {
          name: "aws-known-bad-inputs",
          priority: 3,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesKnownBadInputsRuleSet" } },
          visibilityConfig: visibility("known-bad-inputs"),
        },
        {
          name: "aws-common-count-only",
          priority: 4,
          overrideAction: { count: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" } },
          visibilityConfig: visibility("common"),
        },
      ],
    });
    this.webAclArn = acl.attrArn;
  }
}
