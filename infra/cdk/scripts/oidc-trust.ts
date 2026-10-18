// The deploy role's GitHub OIDC trust (lib/ci-stack.ts), checked from inside the deploy workflow
// (.github/workflows/aws-deploy.yml; the checks themselves are in lib/oidc-trust.ts). Needs the
// job's id-token permission.
//
//   tsx scripts/oidc-trust.ts claims [--env production]
//     Before signing in: this job's token carries exactly githubDeployClaims (lib/config.ts). A
//     deploy that would give the role a trust its own workflow can't meet stops here.
//   tsx scripts/oidc-trust.ts assume --role <arn> [--region ap-southeast-2] [--env production]
//     After `cdk deploy`: the trust-check roles (githubTrustChecks) admit or refuse this workflow
//     as they should, which proves the trust the deploy role is to get next (a warning if not);
//     and a fresh token still gets the deploy role, so the next deploy can sign in (an error if
//     not). Reads the trust-check roles with `aws iam get-role`: needs the deploy role's credentials.
//
// Prints claim values (repository, environment, workflow file, branch), never a token or credentials.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { envConfig } from "../lib/config.js";
import { assumeWithWebIdentity, checkTrust, compareClaims, requestIdToken, tokenClaims } from "../lib/oidc-trust.js";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const cfg = envConfig((k) => (k === "env" ? opt("--env", "production") : undefined));

async function claims() {
  const { ok, lines } = compareClaims(cfg, tokenClaims(await requestIdToken()));
  for (const line of lines) console.log(line);
  if (!ok) throw new Error("This job's token doesn't meet the trust the deploy role is to get (lib/config.ts, githubDeployClaims): nothing deployed.");
}

async function assume() {
  const role = opt("--role", "");
  if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(role)) throw new Error(`--role must be a role ARN (got "${role}").`);
  const region = opt("--region", "ap-southeast-2");
  const session = `trust-check-${process.env.GITHUB_RUN_ID ?? "local"}`;
  const report = await checkTrust({
    cfg,
    deployRoleArn: role,
    liveConditions: (roleName) => {
      const out = execFileSync("aws", ["iam", "get-role", "--role-name", roleName, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const doc = (JSON.parse(out) as { Role: { AssumeRolePolicyDocument: { Statement: Array<{ Condition?: unknown }> } } }).Role.AssumeRolePolicyDocument;
      return doc.Statement.map((s) => s.Condition);
    },
    // A fresh token for each: they're short-lived.
    assume: async (roleArn) => assumeWithWebIdentity(roleArn, region, await requestIdToken(), session),
  });
  for (const line of report.lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.summary.join("\n")}\n`);
  if (!report.deployRole.ok) {
    throw new Error(
      "The deploy role no longer admits this workflow, so the next deploy can't sign in. This release is live (no rollback). " +
        "docs/aws-deployment.md, Deploy (GitHub Actions), says how to restore the trust.",
    );
  }
}

const mode = args[0];
try {
  if (mode === "claims") await claims();
  else if (mode === "assume") await assume();
  else throw new Error("Usage: oidc-trust.ts claims [--env production] | assume --role <arn> [--region ap-southeast-2] [--env production]");
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
