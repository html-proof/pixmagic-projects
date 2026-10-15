import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  /** One NAT gateway (lean) or one per AZ (high availability). */
  natGateways: number;
  logRetentionDays: number;
  /**
   * The EventBridge schedules (token refresh, reconcile, ad syncs, email and WhatsApp sweeps).
   * OFF until this environment takes over from Cloudflare: with production's data copied in and
   * both sides running them, merchants' stores would be synced twice and their customers emailed
   * twice. Turn on at cutover: `-c schedules=on`.
   */
  schedulesEnabled: boolean;
  /**
   * The app's own address instead of CloudFront's. DNS for it is at Cloudflare (records DNS only,
   * pointing at the distribution); the certificate is in ACM in us-east-1 (CloudFront's region),
   * validated by a CNAME there (docs/aws-deployment.md, "Custom domain"). Page requests on any
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
    dbMultiAz: false,
    dbAllocatedStorageGb: 20,
    dbMaxStorageGb: 100,
    dbBackupDays: 14,
    natGateways: 1,
    logRetentionDays: 90,
    domain: {
      name: "bizinsights.io",
      redirects: ["www.bizinsights.io"],
      certificateArn: "arn:aws:acm:us-east-1:605411278365:certificate/776966d7-d73c-4896-bd30-1568c9f7b3f7",
    },
    cognitoDomainPrefix: "insights-605411278365",
    monthlyBudgetUsd: 150,
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

/** JSONC → JSON: drops // and /* *\/ comments outside strings, and trailing commas. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The app's non-secret settings: the same `vars` the Cloudflare Worker runs with
 * (apps/cloudflare/wrangler.jsonc), so both hosts behave alike while they run side by side.
 * Left out: the addresses (this environment has its own, from the runtime parameter) and the
 * Cognito ids (from the Auth stack). Once Cloudflare is retired, move these here.
 */
export function appVars(): Record<string, string> {
  const raw = readFileSync(resolve(REPO_ROOT, "apps/cloudflare/wrangler.jsonc"), "utf8");
  const vars = (JSON.parse(stripJsonComments(raw)) as { vars: Record<string, string> }).vars;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (/^(APP_URL|API_URL)$/.test(k) || k.startsWith("COGNITO_")) continue;
    out[k] = String(v);
  }
  return out;
}

/** The Lambda package built by apps/aws/scripts/build.mjs. */
export const FUNCTION_DIR = process.env.INSIGHTS_FUNCTION_DIR ?? resolve(REPO_ROOT, "apps/aws/dist/function");
export const COGNITO_TEMPLATE = resolve(REPO_ROOT, "infra/aws/cognito.yaml");
