// The deploy role's GitHub OIDC trust (lib/ci-stack.ts), checked from inside the deploy workflow
// (.github/workflows/aws-deploy.yml). Needs the job's id-token permission.
//
//   tsx scripts/oidc-trust.ts claims [--env production]
//     Before signing in: this job's token carries exactly the claims the role requires
//     (githubDeployClaims in lib/config.ts). A deploy that would change the trust to something its
//     own workflow can't meet stops here, before anything is deployed.
//   tsx scripts/oidc-trust.ts assume --role <arn> [--region ap-southeast-2]
//     After `cdk deploy`: a fresh token still gets the role, so the next deploy can sign in.
//
// Prints claim values (repository, environment, workflow file, branch), never a token or credentials.
import { envConfig, githubDeployClaims } from "../lib/config.js";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

/** fetch, tried up to 3 times while the network fails or the server answers 5xx. */
async function fetchRetrying(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500 || attempt === 3) return res;
    } catch (err) {
      if (attempt === 3) throw err;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function idToken(): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("No OIDC token to request: run this in a GitHub Actions job with `id-token: write`.");
  const res = await fetchRetrying(`${url}&audience=sts.amazonaws.com`, { headers: { authorization: `bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GitHub refused an OIDC token (HTTP ${res.status}).`);
  const { value } = (await res.json()) as { value?: string };
  if (!value) throw new Error("GitHub's OIDC token response had no token.");
  return value;
}

async function checkClaims() {
  const required = githubDeployClaims(envConfig((k) => (k === "env" ? opt("--env", "production") : undefined)));
  const payload = (await idToken()).split(".")[1] ?? "";
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  let ok = true;
  for (const [claim, want] of Object.entries(required)) {
    const got = claims[claim];
    if (got === want) {
      console.log(`ok  ${claim} = ${want}`);
    } else {
      ok = false;
      console.log(`::error::The deploy role requires ${claim} = "${want}"; this job's token has "${String(got ?? "")}".`);
    }
  }
  if (!ok) throw new Error("This job's token doesn't meet the deploy role's trust (lib/config.ts, githubDeployClaims): nothing deployed.");
}

async function checkAssume() {
  const role = opt("--role", "");
  if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(role)) throw new Error(`--role must be a role ARN (got "${role}").`);
  const region = opt("--region", "ap-southeast-2");
  // AssumeRoleWithWebIdentity is unsigned: no AWS credentials involved. The session it creates
  // lasts the minimum 15 minutes and its credentials are dropped unread.
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: role,
    RoleSessionName: `trust-check-${process.env.GITHUB_RUN_ID ?? "local"}`,
    DurationSeconds: "900",
    WebIdentityToken: await idToken(),
  });
  const res = await fetchRetrying(`https://sts.${region}.amazonaws.com/`, { method: "POST", body });
  const xml = await res.text();
  const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";
  if (res.ok) {
    console.log(`A fresh token from this workflow still gets ${tag("Arn") || role}.`);
    return;
  }
  console.log(`::error::STS answered ${res.status} ${tag("Code")}: ${tag("Message")}`);
  throw new Error(
    "The deploy role no longer admits this workflow, so the next deploy can't sign in. This release is live (no rollback). " +
      "docs/aws-deployment.md, Deploy (GitHub Actions), says how to restore the trust.",
  );
}

const mode = args[0];
try {
  if (mode === "claims") await checkClaims();
  else if (mode === "assume") await checkAssume();
  else throw new Error("Usage: oidc-trust.ts claims [--env production] | assume --role <arn> [--region ap-southeast-2]");
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
