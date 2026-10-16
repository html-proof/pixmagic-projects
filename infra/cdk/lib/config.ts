import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_SETTINGS } from "../../../apps/aws/src/settings.js";

/**
 * Per-environment settings for the CDK app. One AWS account (605411278365), Sydney; each
 * environment is its own set of stacks named Insights<Part>-<env>. `cdk deploy -c env=staging`
 * deploys a second copy with its own database, pool and queues.
 */
export interface EnvConfig {
  name: "production" | "staging";
  account: string;
  region: string;
  /** RDS instance class, e.g. "t4g.small". */
  dbInstanceType: string;
  /** Two Availability Zones with automatic failover (the "high availability" option). */
  dbMultiAz: boolean;
  dbAllocatedStorageGb: number;
  dbMaxStorageGb: number;
  dbBackupDays: number;
  /**
   * One NAT gateway (lean) or one per AZ (high availability). With one, both AZs' functions reach
   * the internet through the NAT in the first AZ, so an outage there cuts every function off from
   * Shopify, Cognito, Google, Meta and SMTP (Trusted Advisor's "Single AZ Application Check").
   */
  natGateways: number;
  logRetentionDays: number;
  /**
   * The EventBridge schedules (token refresh, reconcile, ad syncs, email and WhatsApp sweeps).
   * OFF until this environment takes over from the old deployment (docs/aws-deployment.md,
   * Cutover): with production's data copied in and both sides running them, merchants' stores
   * would be synced twice and their customers emailed twice. Turn on at cutover: `-c schedules=on`.
   */
  schedulesEnabled: boolean;
  /**
   * The app's own address instead of CloudFront's. DNS for it is at Cloudflare (records DNS only,
   * pointing at the distribution); the certificate is in ACM in us-east-1 (CloudFront's region),
   * validated by a CNAME there (docs/aws-deployment.md, "Domain: bizinsights.io"). Page requests on any
   * other name (`redirects`, the cloudfront.net address) are redirected to `name`.
   * Unset: the app lives on the cloudfront.net address.
   */
  domain?: { name: string; redirects: string[]; certificateArn: string };
  /** Prefix of the Cognito domain, <prefix>.auth.<region>.amazoncognito.com (unique in the region). */
  cognitoDomainPrefix: string;
  /** Where alarm and budget emails go (empty: the topic and budget exist without subscribers). */
  alertEmail: string;
  monthlyBudgetUsd: number;
  /** GitHub repository allowed to deploy through OIDC. */
  githubRepo: string;
  /**
   * How GitHub names that repository in its OIDC token's `sub` claim. The repository sends the
   * immutable form, owner@ownerId/repo@repoId (Settings → Actions → OIDC subject, or
   * GET /repos/{repo}/actions/oidc/customization/sub), so a renamed or re-created repository
   * with the same name can't deploy.
   */
  githubOidcSubject: string;
}

const ACCOUNT = "605411278365";
const REGION = "ap-southeast-2";

const ENVIRONMENTS: Record<EnvConfig["name"], Omit<EnvConfig, "schedulesEnabled" | "alertEmail">> = {
  production: {
    name: "production",
    account: ACCOUNT,
    region: REGION,
    dbInstanceType: "t4g.small",
    dbMultiAz: true,
    dbAllocatedStorageGb: 20,
    dbMaxStorageGb: 100,
    dbBackupDays: 14,
    natGateways: 2,
    logRetentionDays: 90,
    domain: {
      name: "bizinsights.io",
      redirects: ["www.bizinsights.io"],
      certificateArn: "arn:aws:acm:us-east-1:605411278365:certificate/776966d7-d73c-4896-bd30-1568c9f7b3f7",
    },
    cognitoDomainPrefix: "insights-605411278365",
    monthlyBudgetUsd: 235,
    githubRepo: "html-proof/pixmagic-projects",
    githubOidcSubject: "repo:html-proof@68529971/pixmagic-projects@1413246051",
  },
  staging: {
    name: "staging",
    account: ACCOUNT,
    region: REGION,
    dbInstanceType: "t4g.micro",
    dbMultiAz: false,
    dbAllocatedStorageGb: 20,
    dbMaxStorageGb: 30,
    dbBackupDays: 3,
    natGateways: 1,
    logRetentionDays: 30,
    cognitoDomainPrefix: "insights-staging-605411278365",
    monthlyBudgetUsd: 40,
    githubRepo: "html-proof/pixmagic-projects",
    githubOidcSubject: "repo:html-proof@68529971/pixmagic-projects@1413246051",
  },
};

export function envConfig(context: (key: string) => unknown): EnvConfig {
  const name = String(context("env") ?? "production") as EnvConfig["name"];
  const base = ENVIRONMENTS[name];
  if (!base) throw new Error(`Unknown environment "${name}" (production or staging)`);
  return {
    ...base,
    schedulesEnabled: String(context("schedules") ?? "off") === "on",
    alertEmail: String(context("alertEmail") ?? ""),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

/**
 * The app's non-secret settings (apps/aws/src/settings.ts). The addresses and Cognito ids are not
 * among them: this environment gets those from its own stacks (the runtime parameter).
 */
export function appVars(): Record<string, string> {
  return { ...APP_SETTINGS };
}

/** The Lambda package built by apps/aws/scripts/build.mjs. */
export const FUNCTION_DIR = process.env.INSIGHTS_FUNCTION_DIR ?? resolve(REPO_ROOT, "apps/aws/dist/function");
export const COGNITO_TEMPLATE = resolve(REPO_ROOT, "infra/aws/cognito.yaml");
