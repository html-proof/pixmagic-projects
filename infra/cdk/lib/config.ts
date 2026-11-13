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
   * the owner's ceiling (US$50 with tax since 2026-11-12); its alarms (db-free-memory, db-connections, db-cpu) say when it's
   * time for t4g.small. With Multi-AZ, a change costs one failover (about a minute); single-AZ, a
   * reboot of a few minutes. On demand: the two reserved-instance orders of 2026-10-18 ended
   * payment-failed, so none is active (docs/aws-deployment.md, Cost).
   */
  dbInstanceType: string;
  /**
   * A standby in the second Availability Zone with automatic failover (about a minute), which
   * doubles the instance and storage price. Production had it from 2026-10-17 to 2026-11-08, when
   * the owner gave it up to cut the bill until the move to iKorex (docs/aws-deployment.md, Fault
   * tolerance). Turning it off or on again happens in place, without downtime.
   */
  dbMultiAz: boolean;
  dbAllocatedStorageGb: number;
  dbMaxStorageGb: number;
  dbBackupDays: number;
  /**
   * How many NAT instances (nat-instances.ts): 2 = one per AZ, each AZ's functions going out
   * through their own; 1 = both through one (`natAz`'s, else the first AZ's), so an outage there
   * cuts every function off from Shopify, Cognito, Google, Meta and SMTP (Trusted Advisor's "Single
   * AZ Application Check").
   */
  natGateways: number;
  /**
   * With fewer NAT instances than AZs, the AZ they go in. Production's is the database's
   * (ap-southeast-2b since 2026-10-17), so with one of each, only an outage of that AZ stops the
   * app, instead of an outage of either. Unset: the first AZ.
   */
  natAz?: string;
  /** EC2 type of each NAT instance, e.g. "t4g.nano" (~US$8/month with its public IPv4 and disk). */
  natInstanceType: string;
  logRetentionDays: number;
  /**
   * WhatsApp Automation's Evolution API service (whatsapp-stack.ts): one ECS Fargate task on Graviton
   * per shard, its size (Fargate's CPU units and MiB), how many run (1; 0 keeps everything in place
   * with no task running), and Fargate Spot (about 70% cheaper; AWS may stop the task with two
   * minutes' notice, and WhatsApp reconnects from the saved sessions when it is back). One task holds
   * every store's WhatsApp session on its shard: never more than one at a time (a WhatsApp session
   * can't be open in two places). `-c whatsapp=off` makes it 0 (the deploy workflow: GitHub variable
   * AWS_WHATSAPP): from the move to the iKorex server until stage F, whose own Evolution then holds
   * the sessions (docs/ikorex-migration/AWS_TO_IKOREX_MIGRATION_MATRIX.md, cutover step 2).
   */
  whatsapp: { cpu: 256 | 512 | 1024 | 2048; memoryMiB: number; tasks: 0 | 1; spot: boolean };
  /**
   * The EventBridge schedules (token refresh, reconcile, ad syncs, WhatsApp sweeps). On in
   * production since 2026-10-16 (docs/aws-deployment.md, Cutover, step 3). Off in staging: on a copy
   * of production's data it would sync merchants' stores a second time and email their customers
   * twice. `-c schedules=off` (or `on`) overrides it for one deploy (the deploy workflow: GitHub
   * variable AWS_SCHEDULES).
   */
  schedulesEnabled: boolean;
  /**
   * The App stack runs a new release's migrations on its new cron version and moves the `live`
   * aliases only once they succeeded (migrate-before-live.ts). On in every environment, so a plain
   * `cdk deploy --all` from a PC gets it too. `-c migrate=off` (the deploy workflow: repository
   * variable AWS_MIGRATE_BEFORE_LIVE=off) moves `live` first and leaves migrating to the workflow's
   * migrate step or the hand command, as before: only to get past a broken gate.
   */
  migrateBeforeLive: boolean;
  /**
   * The app's own address instead of CloudFront's. DNS for it is at Cloudflare (proxied, pointing
   * at the distribution); the certificate is in ACM in us-east-1 (CloudFront's region),
   * validated by a CNAME there (docs/aws-deployment.md, "Domain: bizinsights.io"). Page requests on any
   * other name (`redirects`, the cloudfront.net address) are redirected to `name`.
   * Unset: the app lives on the cloudfront.net address.
   *
   * `originLock`: only Cloudflare's proxy may use CloudFront (viewer-request.ts). The Data stack
   * makes a secret, Cloudflare adds it to every request as the header `x-origin-lock` (a Transform
   * Rule the owner sets, docs/aws-deployment.md "Origin lock"), and CloudFront's viewer function
   * checks it. "report": the function knows the secret and `/edge-lock` says whether a request
   * carried it, nothing is refused. "enforce": a request without it gets 403. Always "report"
   * first, and "enforce" only once `https://<name>/edge-lock` answers 204: enforcing before
   * Cloudflare sends the header takes the whole site down, and rolling the functions back doesn't
   * undo it. Unset: no lock, no secret.
   *
   * `originLockRead`: CloudFormation copies the secret into the function when it deploys, and again
   * only when the function's source changes. After the secret's value was changed, a new date here
   * is that change (docs/aws-deployment.md, "Origin lock", has the order to do it in).
   */
  domain?: { name: string; redirects: string[]; certificateArn: string; originLock?: "report" | "enforce"; originLockRead?: string };
  /** Prefix of the Cognito domain, <prefix>.auth.<region>.amazoncognito.com (unique in the region). */
  cognitoDomainPrefix: string;
  /**
   * Optional: the pool's own OAuth domain under the app's (e.g. auth.bizinsights.io), so Google's
   * sign-in pages show it instead of amazoncognito.com, a domain nobody can verify with Google for
   * an OAuth consent screen. Added beside the prefix domain, which keeps working. Needs a public
   * ACM certificate for `name` in us-east-1, and a DNS-only CNAME at Cloudflare to the stack output
   * CustomDomainTarget (docs/cognito-setup.md, "Own sign-in domain"). Unset: the prefix domain only.
   *
   * `inUse` switches sign-in over in a second step, so Continue with Google never breaks: false
   * creates the domain (the CNAME's target then exists) while the app (COGNITO_DOMAIN) and
   * Google's redirect URI stay on the prefix domain; true, once the CNAME resolves and Google's
   * client lists the new redirect URI, moves the app to it.
   */
  cognitoCustomDomain?: { name: string; certificateArn: string; inUse: boolean };
  /**
   * Cognito's own emails (sign-up and email-change codes, password resets, sign-in codes, temporary
   * passwords) sent by the app's mail provider (Resend) from EMAIL_FROM, through the user pool's
   * Custom Email Sender trigger (auth-stack.ts; its KMS key is ~US$1/month). Off: Cognito sends
   * them itself (COGNITO_DEFAULT: from no-reply@verificationemail.com, 50 a day for the account).
   * `-c cognitoEmail=off` (or `on`) overrides it for one deploy, e.g. while the provider is down.
   */
  cognitoCustomEmail: boolean;
  /**
   * Continue with Google: the client id of Google sign-in's OAuth client (docs/cognito-setup.md,
   * section 2), which lists this pool's redirect URI. Not a secret: every Google sign-in page's
   * address carries it. Its secret, GOOGLE_SIGNIN_CLIENT_SECRET in insights/<env>/app, is resolved
   * by CloudFormation at deploy time (auth-stack.ts). Empty: no Google sign-in.
   * `-c googleClientId=...` overrides it for one deploy (the deploy workflow: GitHub variable
   * GOOGLE_SIGNIN_CLIENT_ID).
   */
  googleClientId: string;
  /**
   * Where alarm emails go (empty: the topic exists without subscribers). `-c alertEmail=...`
   * overrides it for one deploy (the deploy workflow: GitHub variable AWS_ALERT_EMAIL).
   */
  alertEmail: string;
  /**
   * Where the budget's emails go (spend at 50/70/85/95% of monthlyBudgetUsd, and a forecast above
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

const ENVIRONMENTS: Record<EnvConfig["name"], Omit<EnvConfig, "migrateBeforeLive">> = {
  production: {
    name: "production",
    account: ACCOUNT,
    region: REGION,
    dbInstanceType: "t4g.micro",
    // Single-AZ and one NAT instance since 2026-11-08, the owner's yes to cut the bill until the move to
    // iKorex (docs/aws-migration/AWS_MIGRATION_PLAN.md, changes 8 and 9): ~US$30 a month less. Back to
    // high availability: `dbMultiAz: true`, `natGateways: 2` (docs/aws-deployment.md, Fault tolerance).
    dbMultiAz: false,
    dbAllocatedStorageGb: 20,
    dbMaxStorageGb: 100,
    // 7 days of point-in-time restore since 2026-11-12 (14 before): half the backup storage beyond
    // the free allowance, and a week is still longer than any fault has taken to notice.
    dbBackupDays: 7,
    natGateways: 1,
    // The database's AZ: the instance there (insights-production-nat-b) stays, nat-a goes.
    natAz: "ap-southeast-2b",
    natInstanceType: "t4g.nano",
    logRetentionDays: 90,
    // On Fargate Spot since 2026-11-06 (the owner's yes; docs/aws-migration/AWS_MIGRATION_PLAN.md, change 5):
    // US$17.29/month on demand was the bill's second-largest line. When AWS reclaims the task, ECS starts
    // another and linked phones drop for a minute or two; back to on demand: `spot: false`. docs/whatsapp.md, "Cost".
    whatsapp: { cpu: 512, memoryMiB: 1024, tasks: 1, spot: true },
    schedulesEnabled: true,
    domain: {
      name: "bizinsights.io",
      redirects: ["www.bizinsights.io"],
      certificateArn: "arn:aws:acm:us-east-1:605411278365:certificate/776966d7-d73c-4896-bd30-1568c9f7b3f7",
      // Enforcing since 2026-11-12, once https://bizinsights.io/edge-lock answered 204 (Cloudflare
      // sending the header). Back to "report" before anything that takes Cloudflare out of the path.
      originLock: "enforce",
      originLockRead: "2026-11-12",
    },
    cognitoDomainPrefix: "insights-605411278365",
    // The own sign-in domain (docs/cognito-setup.md, "Own sign-in domain"), beside the prefix
    // domain, which keeps working. In use since step two: its DNS record resolves and Google's
    // client lists https://auth.bizinsights.io/oauth2/idpresponse.
    cognitoCustomDomain: {
      name: "auth.bizinsights.io",
      certificateArn: "arn:aws:acm:us-east-1:605411278365:certificate/b0849d46-9714-4de4-b893-a9ab1171761d",
      inUse: true,
    },
    cognitoCustomEmail: true,
    // Google sign-in's OAuth client, in a Google Cloud project of its own (docs/cognito-setup.md, section 2).
    googleClientId: "567753266621-ltq5j5kij5s3em8gr0err3tbrh5fqciq.apps.googleusercontent.com",
    // The owner's address for the alarms (an SNS email subscription: AWS's first email asks to confirm it).
    alertEmail: "bizinsightsaus@yahoo.com",
    // The owner's address for AWS costs: the budget, the daily cost email and Cost Anomaly Detection's daily alerts.
    budgetEmail: "bizinsightsaus@yahoo.com",
    // The owner's ceiling: US$50 a month, tax included (2026-11-12; it was US$50-80 from 2026-10-18.
    // docs/aws-deployment.md, Cost, says what the bill is made of and what has to stay off for it).
    monthlyBudgetUsd: 50,
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
    whatsapp: { cpu: 512, memoryMiB: 1024, tasks: 1, spot: true },
    schedulesEnabled: false,
    cognitoDomainPrefix: "insights-staging-605411278365",
    // A few test emails a day fit Cognito's own sender, without a second KMS key.
    cognitoCustomEmail: false,
    // Production's Google client lists only production's redirect URIs.
    googleClientId: "",
    alertEmail: "",
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

/** The origin lock's secret in Secrets Manager (config.ts `domain.originLock`): made by the Data stack, read by the App stack's deploy. */
export const originLockSecretName = (cfg: Pick<EnvConfig, "name">) => `insights/${cfg.name}/origin-lock`;

export function envConfig(context: (key: string) => unknown): EnvConfig {
  const name = String(context("env") ?? "production") as EnvConfig["name"];
  const base = ENVIRONMENTS[name];
  if (!base) throw new Error(`Unknown environment "${name}" (production or staging)`);
  // A flag left out or given empty keeps this environment's own value: the deploy workflow passes
  // its flags every time, empty when the GitHub variable behind one isn't set.
  const given = (key: string) => {
    const value = context(key);
    return value === undefined || value === "" ? undefined : String(value);
  };
  const onOff = (key: string, own: boolean) => {
    const value = given(key);
    return value === undefined ? own : value === "on";
  };
  return {
    ...base,
    schedulesEnabled: onOff("schedules", base.schedulesEnabled),
    // Only "off" stops it: unset, empty or a typo keeps this environment's own.
    whatsapp: given("whatsapp") === "off" ? { ...base.whatsapp, tasks: 0 } : base.whatsapp,
    // Only "off" turns it off: unset, empty or a typo keeps the safe default.
    migrateBeforeLive: String(context("migrate") ?? "on") !== "off",
    googleClientId: given("googleClientId") ?? base.googleClientId,
    alertEmail: given("alertEmail") ?? base.alertEmail,
    cognitoCustomEmail: onOff("cognitoEmail", base.cognitoCustomEmail),
    budgetEmail: given("budgetEmail") ?? base.budgetEmail,
    costReport: onOff("costReport", base.costReport),
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
 * The app's non-secret settings (apps/aws/src/settings.ts). The app's functions read them from their
 * package, not their environment; the Cognito email function is given the few it needs (auth-stack.ts).
 * The addresses and Cognito ids are not among them: this environment gets those from its own stacks
 * (the runtime parameter).
 */
export function appVars(): Record<string, string> {
  return { ...APP_SETTINGS };
}

/** The Lambda package built by apps/aws/scripts/build.mjs. */
export const FUNCTION_DIR = process.env.INSIGHTS_FUNCTION_DIR ?? resolve(REPO_ROOT, "apps/aws/dist/function");
export const COGNITO_TEMPLATE = resolve(REPO_ROOT, "infra/aws/cognito.yaml");
