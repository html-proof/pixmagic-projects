// Checks of the deploy role's GitHub OIDC trust (ci-stack.ts) from inside the deploy workflow,
// for scripts/oidc-trust.ts. Nothing here prints or returns a token or credentials: only claim
// values (repository, environment, workflow file, branch) and STS's answers.
import { type EnvConfig, githubClaimConditions, githubDeployClaims, githubTrustChecks } from "./config.js";

/** fetch, tried up to 3 times while the network fails or the server answers 5xx. */
export async function fetchRetrying(url: string, init: RequestInit, waitMs = 5000): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500 || attempt === 3) return res;
    } catch (err) {
      if (attempt === 3) throw err;
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** A fresh OIDC token for AWS STS from the job's id-token endpoint. */
export async function requestIdToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("No OIDC token to request: run this in a GitHub Actions job with `id-token: write`.");
  const res = await fetchRetrying(`${url}&audience=sts.amazonaws.com`, { headers: { authorization: `bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GitHub refused an OIDC token (HTTP ${res.status}).`);
  const { value } = (await res.json()) as { value?: string };
  if (!value) throw new Error("GitHub's OIDC token response had no token.");
  return value;
}

/** The token's claims (its payload; the signature isn't checked here, STS does that). */
export function tokenClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Each of githubDeployClaims against the token: lines to print, and whether all match. */
export function compareClaims(cfg: EnvConfig, claims: Record<string, unknown>): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  for (const [claim, want] of Object.entries(githubDeployClaims(cfg))) {
    const got = claims[claim];
    if (got === want) {
      lines.push(`ok  ${claim} = ${want}`);
    } else {
      ok = false;
      lines.push(`::error::The deploy role requires ${claim} = "${want}"; this job's token has "${String(got ?? "")}".`);
    }
  }
  return { ok, lines };
}

/** STS's answer to one AssumeRoleWithWebIdentity; status 0 when there was none. */
export type Assumed = { ok: boolean; status: number; code: string; message: string; answer: string; arn: string };

/** Only this proves a trust refused the token: a role that doesn't exist gets the same answer. */
export const isRefusal = (r: Assumed) => r.status === 403 && r.code === "AccessDenied";
/**
 * No answer, STS too busy, or STS unable to reach GitHub to check the token (AWS calls these
 * transient): says nothing about the trust.
 */
export const isInconclusive = (r: Assumed) =>
  !r.ok &&
  (r.status === 0 ||
    r.status >= 500 ||
    /^Throttling/.test(r.code) ||
    r.code === "IDPCommunicationError" ||
    (r.code === "InvalidIdentityToken" && /^Couldn't retrieve verification key/.test(r.message)));

/**
 * One AssumeRoleWithWebIdentity, tried up to 3 times while the answer is inconclusive. It is
 * unsigned: no AWS credentials involved. The session lasts the minimum 15 minutes and its
 * credentials are dropped unread.
 */
export async function assumeWithWebIdentity(roleArn: string, region: string, token: string, sessionName: string, waitMs = 5000): Promise<Assumed> {
  const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: roleArn, RoleSessionName: sessionName, DurationSeconds: "900", WebIdentityToken: token });
  for (let attempt = 1; ; attempt++) {
    const res = await fetchRetrying(`https://sts.${region}.amazonaws.com/`, { method: "POST", body }, waitMs);
    const xml = await res.text();
    const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";
    const [code, message] = [tag("Code"), tag("Message")];
    const r = { ok: res.ok, status: res.status, code, message, answer: res.ok ? "admitted" : `${res.status} ${code}: ${message}`, arn: tag("Arn") };
    if (!isInconclusive(r) || attempt === 3) return r;
    await new Promise((done) => setTimeout(done, waitMs));
  }
}

/** JSON with every object's keys sorted: IAM needn't keep the order they were written in. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value));
}

type TrustDeps = {
  cfg: EnvConfig;
  deployRoleArn: string;
  /** The trust conditions IAM has for that role now, one entry per statement; throws if unreadable. */
  liveConditions: (roleName: string) => unknown;
  assume: (roleArn: string) => Promise<Assumed>;
};

/** o.assume, with a throw (no network after retries) turned into an answer, not a reason to stop. */
const asking = (o: TrustDeps) => async (roleArn: string): Promise<Assumed> => {
  try {
    return await o.assume(roleArn);
  } catch (err) {
    return { ok: false, status: 0, code: "", message: (err as Error).message, answer: `no answer (${(err as Error).message})`, arn: "" };
  }
};

/**
 * The trust-check roles (githubTrustChecks): each one's live trust must be exactly what it should
 * be (STS also refuses a role that doesn't exist, so a refusal proves something only from a role
 * that's there), then it must admit or refuse this workflow. All of that together shows IAM checks
 * job_workflow_ref and ref, and that this workflow meets them.
 */
export async function proveTrustChecks(o: TrustDeps): Promise<{ proven: boolean; lines: string[]; summary: string[] }> {
  const account = o.deployRoleArn.split(":")[4];
  const ask = asking(o);
  const lines: string[] = [];
  const summary = ["### GitHub OIDC trust", ""];
  let proven = true;
  for (const check of githubTrustChecks(o.cfg)) {
    let live: unknown;
    try {
      live = o.liveConditions(check.roleName);
    } catch (err) {
      live = `unreadable: ${(err as Error).message.split("\n").find((l) => l.trim()) ?? "no answer"}`;
    }
    let line: string;
    let asExpected = false;
    if (canonical(live) !== canonical([{ StringEquals: githubClaimConditions(check.claims) }])) {
      line = `${check.roleName}: its trust isn't the expected one, so nothing is proven (IAM has ${typeof live === "string" ? live : JSON.stringify(live)})`;
    } else {
      const r = await ask(`arn:aws:iam::${account}:role/${check.roleName}`);
      asExpected = check.admits ? r.ok : isRefusal(r);
      line = `${check.roleName}: ${r.ok ? "admitted" : isRefusal(r) ? "refused" : `answered ${r.answer}`} this workflow (${check.admits ? "must admit it" : "must refuse it"})`;
    }
    lines.push(asExpected ? `ok  ${line}` : `::warning::${line}`);
    summary.push(`- ${asExpected ? "✅" : "⚠️"} ${line}`);
    proven &&= asExpected;
  }
  const verdict = proven
    ? "Proven: IAM checks job_workflow_ref and ref, and this workflow meets them (the deploy role requires both)."
    : "Not proven that IAM checks job_workflow_ref and ref: the deploy role may admit more than this workflow (docs/aws-deployment.md).";
  lines.push(proven ? verdict : `::warning::${verdict}`);
  summary.push("", verdict, "");
  return { proven, lines, summary };
}

/**
 * proven: see proveTrustChecks. deployRole: whether the deploy role itself still admits this
 * workflow ("unknown" when STS couldn't be asked).
 */
export type TrustReport = { proven: boolean; deployRole: "admitted" | "refused" | "unknown"; lines: string[]; summary: string[] };

/** After a deploy: proveTrustChecks, then the deploy role itself with a fresh token, which the next deploy signs in with. */
export async function checkTrust(o: TrustDeps): Promise<TrustReport> {
  const { proven, lines, summary } = await proveTrustChecks(o);
  // Any other refusal (AccessDenied, InvalidIdentityToken...) would stop the next deploy too.
  const r = await asking(o)(o.deployRoleArn);
  const deployRole = r.ok ? "admitted" : isInconclusive(r) ? "unknown" : "refused";
  const line = {
    admitted: `A fresh token from this workflow still gets ${r.arn || o.deployRoleArn}.`,
    refused: `The deploy role refused a fresh token from this workflow: STS answered ${r.answer}`,
    unknown: `Couldn't check whether the deploy role still admits this workflow: ${r.answer}`,
  }[deployRole];
  lines.push(deployRole === "admitted" ? line : `::error::${line}`);
  summary.push(`- ${deployRole === "admitted" ? "✅" : "❌"} ${line}`);
  return { proven, deployRole, lines, summary };
}
