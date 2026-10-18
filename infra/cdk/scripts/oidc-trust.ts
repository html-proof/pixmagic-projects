// The deploy role's GitHub OIDC trust (lib/ci-stack.ts), checked from inside the deploy workflow
// (.github/workflows/aws-deploy.yml; the checks themselves are in lib/oidc-trust.ts). Needs the
// job's id-token permission.
//
//   tsx scripts/oidc-trust.ts claims [--env production]
//     Before signing in: this job's token carries exactly githubDeployClaims (lib/config.ts). A
//     deploy that would give the role a trust its own workflow can't meet stops here.
//   tsx scripts/oidc-trust.ts assume --role <arn> [--region ap-southeast-2] [--env production]
//     After `cdk deploy`: the trust-check roles (githubTrustChecks) admit or refuse this workflow
//     as they should, which shows IAM still checks the claims the deploy role requires (a warning if not);
//     and a fresh token still gets the deploy role, so the next deploy can sign in (an error if
//     not). Reads the trust-check roles with `aws iam get-role`: needs the deploy role's credentials.
//   tsx scripts/oidc-trust.ts prove --role <arn> [--region ap-southeast-2] [--env production]
//     Before `cdk deploy`, signed in: only the trust-check part, and it must prove IAM checks
//     job_workflow_ref and ref and this workflow meets them, which the deploy role's trust in this
//     commit requires. So a deploy never gives the role a trust that would lock the next one out.
//
// Prints claim values (repository, environment, workflow file, branch), never a token or credentials.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { envConfig } from "../lib/config.js";
import { assumeWithWebIdentity, checkTrust, compareClaims, proveTrustChecks, requestIdToken, tokenClaims } from "../lib/oidc-trust.js";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const cfg = envConfig((k) => (k === "env" ? opt("--env", "production") : undefined));

async function claims() {
  const { ok, lines } = compareClaims(cfg, tokenClaims(await requestIdToken()));
  for (const line of lines) console.log(line);
  if (!ok) throw new Error("This job's token doesn't meet the deploy role's trust (lib/config.ts, githubDeployClaims): nothing deployed.");
}

/** The deploy role, and how this job reads IAM and asks STS. */
function deps() {
  const role = opt("--role", "");
  if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(role)) throw new Error(`--role must be a role ARN (got "${role}").`);
  const region = opt("--region", "ap-southeast-2");
  const session = `trust-check-${process.env.GITHUB_RUN_ID ?? "local"}`;
  return {
    cfg,
    deployRoleArn: role,
    liveConditions: (roleName: string) => {
      const out = execFileSync("aws", ["iam", "get-role", "--role-name", roleName, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      type Doc = { Statement: Array<{ Condition?: unknown }> };
      const raw = (JSON.parse(out) as { Role: { AssumeRolePolicyDocument: Doc | string } }).Role.AssumeRolePolicyDocument;
      // The CLI decodes policy documents; the API itself sends them URL-encoded.
      const doc = typeof raw === "string" ? (JSON.parse(decodeURIComponent(raw)) as Doc) : raw;
      return doc.Statement.map((s) => s.Condition);
    },
    // A fresh token for each: they're short-lived.
    assume: async (roleArn: string) => assumeWithWebIdentity(roleArn, region, await requestIdToken(), session),
  };
}

async function prove() {
  const { proven, lines, summary } = await proveTrustChecks(deps());
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  if (!proven) {
    throw new Error(
      "This commit's deploy role trust requires job_workflow_ref and ref, and the trust-check roles don't prove that IAM checks them " +
        "for this workflow: nothing deployed, the live trust is unchanged (docs/aws-deployment.md, Deploy (GitHub Actions)).",
    );
  }
}

async function assume() {
  const report = await checkTrust(deps());
  for (const line of report.lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.summary.join("\n")}\n`);
  if (report.deployRole === "refused") {
    throw new Error(
      "The deploy role no longer admits this workflow, so the next deploy can't sign in. This release is live (no rollback). " +
        "docs/aws-deployment.md, Deploy (GitHub Actions), says how to restore the trust.",
    );
  }
  if (report.deployRole === "unknown") {
    throw new Error(
      "Couldn't ask STS whether the deploy role still admits this workflow (see above): that says nothing about its trust. " +
        "This release is live (no rollback). Re-run this job's failed steps; the trust needs fixing only if STS refuses the token.",
    );
  }
}

const mode = args[0];
try {
  if (mode === "claims") await claims();
  else if (mode === "assume") await assume();
  else if (mode === "prove") await prove();
  else throw new Error("Usage: oidc-trust.ts claims [--env production] | assume|prove --role <arn> [--region ap-southeast-2] [--env production]");
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
