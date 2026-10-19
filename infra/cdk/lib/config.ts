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
  /**
   * RDS instance class, e.g. "t4g.micro" (1 GB memory, ~80 connections) or "t4g.small" (2 GB,
   * ~200; with Multi-AZ ~US$37/month more). Production is on t4g.micro to keep the bill within
   * US$50-80 (2026-10-18); its alarms (db-free-memory, db-connections, db-cpu) say when it's
   * time for t4g.small. With Multi-AZ, a change costs one failover (about a minute).
   * Production's instance is paid by a 1-year reserved instance (db.t4g.micro PostgreSQL Multi-AZ,
   * No Upfront, until 2027-10-18): it is size-flexible, so on t4g.small it still pays half.
   */
  dbInstanceType: string;
  /**
   * A standby in the second Availability Zone with automatic failover (about a minute), which
   * doubles the instance and storage price. On in production since 2026-10-17 (docs/aws-deployment.md,
   * Fault tolerance).
   */
  dbMultiAz: boolean;
  dbAllocatedStorageGb: number;
  dbMaxStorageGb: number;
  dbBackupDays: number;
  /**
   * How many NAT instances (nat-instances.ts): 2 = one per AZ, each AZ's functions going out
   * through their own; 1 = both through the first AZ's, so an outage there cuts every function off
   * from Shopify, Cognito, Google, Meta and SMTP (Trusted Advisor's "Single AZ Application Check").
   */
  natGateways: number;
  /** EC2 type of each NAT instance, e.g. "t4g.nano" (~US$8/month with its public IPv4 and disk). */
  natInstanceType: string;
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
  /**
   * Optional: the pool's own OAuth domain under the app's (e.g. auth.bizinsights.io), so Google's
   * sign-in pages show it instead of amazoncognito.com, a domain nobody can verify with Google for
   * an OAuth consent screen. Added beside the prefix domain, which keeps working; once set, the app
   * (COGNITO_DOMAIN) and the Google redirect URI use it. Needs a public ACM certificate for `name`
   * in us-east-1, and a DNS-only CNAME at Cloudflare to the stack output CustomDomainTarget
   * (docs/cognito-setup.md, "Own sign-in domain"). Unset: the prefix domain only.
   */
  cognitoCustomDomain?: { name: string; certificateArn: string };
  /**
   * Cognito's own emails (sign-up and email-change codes, password resets, sign-in codes, temporary
   * passwords) sent by the app's mail provider (Resend) from EMAIL_FROM, through the user pool's
   * Custom Email Sender trigger (auth-stack.ts; its KMS key is ~US$1/month). Off: Cognito sends
   * them itself (COGNITO_DEFAULT: from no-reply@verificationemail.com, 50 a day for the account).
   * `-c cognitoEmail=off` (or `on`) overrides it for one deploy, e.g. while the provider is down.
   */
  cognitoCustomEmail: boolean;
  /** Where alarm emails go (empty: the topic exists without subscribers). */
  alertEmail: string;
  /**
   * Where the budget's emails go (spend at 50/75/90/100% of monthlyBudgetUsd, and a forecast above
   * it); costs only, none of the alarms. Empty: alertEmail, or no subscribers without one.
   * `-c budgetEmail=...` overrides it for one deploy.
   */
  budgetEmail: string;
  /** The monthly ceiling in US$, tax included (AWS Budgets' default; AWS Australia adds 10% GST). */
  monthlyBudgetUsd: number;
  /**
   * A daily email to budgetEmail of the last day's AWS cost by service and the month so far
   * (apps/aws/src/costReport.ts), from one Cost Explorer call a day at US$0.01 (~US$0.30/month).
   * Its own schedule, on even while `schedules` is off. `-c costReport=off` (or `on`) overrides it.
   */
  costReport: boolean;
  /** GitHub repository allowed to deploy through OIDC. */
  githubRepo: string;
  /**
   * How GitHub names that repository in its OIDC token's `sub` claim. The repository sends the
   * immutable form, owner@ownerId/repo@repoId (Settings → Actions → OIDC subject, or
   * GET /repos/{repo}/actions/oidc/customization/sub), so a renamed or re-created repository
   * with the same name can't deploy.
   */
  githubOidcSubject: string;
  /**
   * The one workflow file, and the branch it must run from, whose jobs may assume the deploy role
   * (the token's `job_workflow_ref` and `ref` claims; githubDeployClaims below). `sub` names only
   * the repository and the environment, and on GitHub Free a private repository's environment
   * can't be limited to a branch: without these, any branch's workflow naming the environment
   * would get the role.
   */
  githubDeployWorkflow: string;
  githubDeployBranch: string;
}

const ACCOUNT = "605411278365";
const REGION = "ap-southeast-2";

const ENVIRONMENTS: Record<EnvConfig["name"], Omit<EnvConfig, "schedulesEnabled" | "alertEmail">> = {
  production: {
    name: "production",
    account: ACCOUNT,
    region: REGION,
    dbInstanceType: "t4g.micro",
    dbMultiAz: true,
    dbAllocatedStorageGb: 20,
    dbMaxStorageGb: 100,
    dbBackupDays: 14,
    natGateways: 2,
    natInstanceType: "t4g.nano",
    logRetentionDays: 90,
    domain: {
      name: "bizinsights.io",
      redirects: ["www.bizinsights.io"],
      certificateArn: "arn:aws:acm:us-east-1:605411278365:certificate/776966d7-d73c-4896-bd30-1568c9f7b3f7",
    },
    cognitoDomainPrefix: "insights-605411278365",
    cognitoCustomEmail: true,
    // The owner's address at AWS (it also gets Cost Anomaly Detection's daily alerts).
    budgetEmail: "aby@zodiix.com",
    // The owner's ceiling, US$50-80 a month (2026-10-18; docs/aws-deployment.md, Cost).
    monthlyBudgetUsd: 80,
    costReport: true,
    githubRepo: "html-proof/pixmagic-projects",
    githubOidcSubject: "repo:html-proof@68529971/pixmagic-projects@1413246051",
    githubDeployWorkflow: ".github/workflows/aws-deploy.yml",
    githubDeployBranch: "main",
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
    natInstanceType: "t4g.nano",
    logRetentionDays: 30,
    cognitoDomainPrefix: "insights-staging-605411278365",
    // A few test emails a day fit Cognito's own sender, without a second KMS key.
    cognitoCustomEmail: false,
    budgetEmail: "",
    monthlyBudgetUsd: 40,
    // The account's bill is the same in both environments: production's email covers it.
    costReport: false,
    githubRepo: "html-proof/pixmagic-projects",
    githubOidcSubject: "repo:html-proof@68529971/pixmagic-projects@1413246051",
    githubDeployWorkflow: ".github/workflows/aws-deploy.yml",
    githubDeployBranch: "main",
  },
};

export function envConfig(context: (key: string) => unknown): EnvConfig {
  const name = String(context("env") ?? "production") as EnvConfig["name"];
  const base = ENVIRONMENTS[name];
  if (!base) throw new Error(`Unknown environment "${name}" (production or staging)`);
  const cognitoEmail = context("cognitoEmail");
  const budgetEmail = context("budgetEmail");
  const costReport = context("costReport");
  return {
    ...base,
    schedulesEnabled: String(context("schedules") ?? "off") === "on",
    alertEmail: String(context("alertEmail") ?? ""),
    cognitoCustomEmail: cognitoEmail === undefined || cognitoEmail === "" ? base.cognitoCustomEmail : String(cognitoEmail) === "on",
    budgetEmail: budgetEmail === undefined || budgetEmail === "" ? base.budgetEmail : String(budgetEmail),
    costReport: costReport === undefined || costReport === "" ? base.costReport : String(costReport) === "on",
  };
}

/**
 * The GitHub OIDC token claims the deploy workflow's token carries, which the deploy workflow
 * checks before it signs in (scripts/oidc-trust.ts). The deploy role requires every one of them
 * (ci-stack.ts).
 */
export function githubDeployClaims(cfg: EnvConfig): { aud: string; sub: string; job_workflow_ref: string; ref: string } {
  const ref = `refs/heads/${cfg.githubDeployBranch}`;
  return {
    aud: "sts.amazonaws.com",
    sub: `${cfg.githubOidcSubject}:environment:${cfg.name}`,
    job_workflow_ref: `${cfg.githubRepo}/${cfg.githubDeployWorkflow}@${ref}`,
    ref,
  };
}

export type GithubDeployClaims = ReturnType<typeof githubDeployClaims>;

/**
 * Roles that grant nothing, which prove the deploy role's next trust before it gets it
 * (ci-stack.ts; checked after every deploy by scripts/oidc-trust.ts). The first trusts exactly
 * githubDeployClaims, so the deploy workflow must get it. The others each swap one claim for a ref
 * git can't name (".." is not allowed in one, so no token ever carries it), so the workflow must be
 * refused: proof that IAM checks that claim rather than skipping it.
 */
export function githubTrustChecks(cfg: EnvConfig): Array<{ id: string; roleName: string; claims: GithubDeployClaims; admits: boolean }> {
  const claims = githubDeployClaims(cfg);
  const never = "refs/heads/never..matches";
  const roleName = `insights-${cfg.name}-github-trust-check`;
  return [
    { id: "TrustCheck", roleName, claims, admits: true },
    {
      id: "TrustCheckWrongWorkflow",
      roleName: `${roleName}-wrong-workflow`,
      claims: { ...claims, job_workflow_ref: `${cfg.githubRepo}/${cfg.githubDeployWorkflow}@${never}` },
      admits: false,
    },
    { id: "TrustCheckWrongRef", roleName: `${roleName}-wrong-ref`, claims: { ...claims, ref: never }, admits: false },
  ];
}

/** IAM trust conditions requiring each of these claims of GitHub's OIDC token, exactly. */
export function githubClaimConditions(claims: Partial<GithubDeployClaims>): Record<string, string> {
  return Object.fromEntries(Object.entries(claims).map(([claim, value]) => [`token.actions.githubusercontent.com:${claim}`, value]));
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
