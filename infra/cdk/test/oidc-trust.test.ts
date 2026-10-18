import { describe, expect, it } from "vitest";
import { envConfig, githubClaimConditions, githubTrustChecks } from "../lib/config.js";
import { type Assumed, canonical, checkTrust, compareClaims, tokenClaims } from "../lib/oidc-trust.js";

const cfg = envConfig(() => undefined);
const deployRoleArn = "arn:aws:iam::605411278365:role/insights-production-github-deploy";
const answer = (status: number, code: string, message = ""): Assumed => ({ ok: status === 200, status, code, message, answer: status === 200 ? "admitted" : `${status} ${code}: ${message}`, arn: status === 200 ? "arn:aws:sts::605411278365:assumed-role/x/trust-check-1" : "" });
const admitted = answer(200, "");
const refused = answer(403, "AccessDenied", "Not authorized to perform sts:AssumeRoleWithWebIdentity");
const roleName = (arn: string) => arn.split("/").pop()!;
const DEPLOY = "insights-production-github-deploy";

/** IAM as it should be: each trust-check role has exactly its claims. */
const liveAsDeployed = (name: string) => {
  const check = githubTrustChecks(cfg).find((c) => c.roleName === name);
  if (!check) throw new Error(`NoSuchEntity: The role with name ${name} cannot be found.`);
  return [{ StringEquals: githubClaimConditions(check.claims) }];
};
/** STS that enforces every claim: admits the matching role and the deploy role, refuses the rest. */
const enforcing = async (arn: string) => (roleName(arn).includes("wrong") ? refused : admitted);

describe("the trust check after a deploy", () => {
  it("proves the next trust when the matching role admits the workflow and both wrong ones refuse it", async () => {
    const asked: string[] = [];
    const r = await checkTrust({ cfg, deployRoleArn, liveConditions: liveAsDeployed, assume: async (arn) => (asked.push(roleName(arn)), enforcing(arn)) });
    expect(r.proven).toBe(true);
    expect(r.deployRole).toBe("admitted");
    expect(asked).toEqual(["insights-production-github-trust-check", "insights-production-github-trust-check-wrong-workflow", "insights-production-github-trust-check-wrong-ref", DEPLOY]);
    expect(r.lines.some((l) => l.startsWith("::"))).toBe(false);
  });

  it("isn't proven when IAM ignores a claim (a wrong role admits the workflow), and says so without failing the deploy", async () => {
    const r = await checkTrust({ cfg, deployRoleArn, liveConditions: liveAsDeployed, assume: async (arn) => (roleName(arn).endsWith("wrong-ref") ? admitted : enforcing(arn)) });
    expect(r.proven).toBe(false);
    expect(r.deployRole).toBe("admitted");
    expect(r.lines).toContain("::warning::insights-production-github-trust-check-wrong-ref: admitted this workflow (must refuse it)");
  });

  it("isn't proven when IAM doesn't match the claims at all (the matching role refuses too)", async () => {
    const r = await checkTrust({ cfg, deployRoleArn, liveConditions: liveAsDeployed, assume: async (arn) => (roleName(arn) === DEPLOY ? admitted : refused) });
    expect(r.proven).toBe(false);
    expect(r.lines.filter((l) => l.startsWith("::warning::"))).toHaveLength(2); // the matching role, and the verdict
  });

  it("takes no refusal from a role that isn't there or has another trust as proof, and doesn't even ask STS", async () => {
    const asked: string[] = [];
    const r = await checkTrust({
      cfg,
      deployRoleArn,
      liveConditions: (name) => {
        if (name.endsWith("wrong-workflow")) throw new Error("An error occurred (NoSuchEntity) when calling the GetRole operation: The role cannot be found.");
        if (name.endsWith("wrong-ref")) return [{ StringEquals: githubClaimConditions({ aud: "sts.amazonaws.com" }) }];
        return liveAsDeployed(name);
      },
      assume: async (arn) => (asked.push(roleName(arn)), enforcing(arn)),
    });
    expect(r.proven).toBe(false);
    expect(asked).toEqual(["insights-production-github-trust-check", DEPLOY]);
    expect(r.lines.find((l) => l.includes("wrong-workflow"))).toMatch(/unreadable: An error occurred \(NoSuchEntity\)/);
  });

  it("counts only STS's AccessDenied as a wrong role's refusal, not another error", async () => {
    const r = await checkTrust({ cfg, deployRoleArn, liveConditions: liveAsDeployed, assume: async (arn) => (roleName(arn).includes("wrong") ? answer(400, "InvalidIdentityToken", "expired") : admitted) });
    expect(r.proven).toBe(false);
  });

  it("keeps going when asking about a trust-check role throws (no network), and still checks the deploy role", async () => {
    const asked: string[] = [];
    const r = await checkTrust({
      cfg,
      deployRoleArn,
      liveConditions: liveAsDeployed,
      assume: async (arn) => {
        asked.push(roleName(arn));
        if (roleName(arn).endsWith("wrong-workflow")) throw new Error("fetch failed");
        return enforcing(arn);
      },
    });
    expect(r.proven).toBe(false);
    expect(r.deployRole).toBe("admitted");
    expect(asked).toHaveLength(4);
    expect(r.lines.find((l) => l.includes("wrong-workflow"))).toMatch(/^::warning::.*answered no answer \(fetch failed\)/);
  });

  it("reports the deploy role refusing the workflow as the error it is, AccessDenied or another refusal", async () => {
    for (const no of [refused, answer(400, "InvalidIdentityToken", "Incorrect token audience")]) {
      const r = await checkTrust({ cfg, deployRoleArn, liveConditions: liveAsDeployed, assume: async (arn) => (roleName(arn) === DEPLOY ? no : enforcing(arn)) });
      expect(r.deployRole).toBe("refused");
      expect(r.lines.at(-1)).toMatch(/^::error::The deploy role refused a fresh token from this workflow: STS answered/);
    }
  });

  it("tells not reaching STS (or STS too busy) apart from a refusal", async () => {
    for (const none of [() => Promise.reject(new Error("fetch failed")), async () => answer(503, "ServiceUnavailable"), async () => answer(400, "Throttling", "Rate exceeded"), async () => answer(400, "IDPCommunicationError", "Couldn't get a response from the identity provider"), async () => answer(400, "InvalidIdentityToken", "Couldn't retrieve verification key from your identity provider")]) {
      const r = await checkTrust({ cfg, deployRoleArn, liveConditions: liveAsDeployed, assume: (arn) => (roleName(arn) === DEPLOY ? none() : enforcing(arn)) });
      expect(r.deployRole).toBe("unknown");
      expect(r.lines.at(-1)).toMatch(/^::error::Couldn't check whether the deploy role still admits this workflow/);
    }
  });

  it("compares trusts whatever order IAM keeps their keys in", () => {
    expect(canonical([{ StringEquals: { b: "2", a: "1" } }])).toBe(canonical([{ StringEquals: { a: "1", b: "2" } }]));
    expect(canonical([{ StringEquals: { a: "1" } }])).not.toBe(canonical([{ StringEquals: { a: "1", b: "2" } }]));
  });
});

describe("the token check before signing in", () => {
  const token = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const main = {
    aud: "sts.amazonaws.com",
    sub: "repo:html-proof@68529971/pixmagic-projects@1413246051:environment:production",
    job_workflow_ref: "html-proof/pixmagic-projects/.github/workflows/aws-deploy.yml@refs/heads/main",
    ref: "refs/heads/main",
  };

  it("passes the deploy workflow's token from main", () => {
    expect(compareClaims(cfg, tokenClaims(token(main))).ok).toBe(true);
  });

  it("fails a token from another branch, naming both claims", () => {
    const { ok, lines } = compareClaims(cfg, tokenClaims(token({ ...main, ref: "refs/heads/x", job_workflow_ref: main.job_workflow_ref.replace("main", "x") })));
    expect(ok).toBe(false);
    expect(lines.filter((l) => l.startsWith("::error::"))).toHaveLength(2);
  });
});
