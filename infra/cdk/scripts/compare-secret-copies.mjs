// Is each Secrets Manager secret's copy in Parameter Store the same text? Prints one word per
// secret, never a value, a length or a hash (docs/aws-migration/SECRETS_TO_PARAMETER_STORE.md).
// (No #! line: it always runs as `node ...`, and a CRLF checkout breaks one.)
//
//   node infra/cdk/scripts/compare-secret-copies.mjs [--env production] [--region ap-southeast-2]
//
// Read-only. Exits 1 unless every secret that exists has an equal copy.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const envName = opt("--env", "production");
const region = opt("--region", "ap-southeast-2");
const NAMES = ["app", "db-owner", "db-system", "worker-cognito", "origin-lock", "evolution-api", "evolution-db"];

/** The command's JSON answer, or AWS's error code (its message is never shown: it can quote a value). */
function aws(cliArgs) {
  try {
    return { ok: JSON.parse(execFileSync("aws", [...cliArgs, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) };
  } catch (err) {
    return { error: /\((\w+)\)/.exec(String(err?.stderr ?? ""))?.[1] ?? "error" };
  }
}

let bad = 0;
for (const name of NAMES) {
  const id = `insights/${envName}/${name}`;
  const secret = aws(["secretsmanager", "get-secret-value", "--secret-id", id]);
  const copy = aws(["ssm", "get-parameter", "--name", `/${id}`, "--with-decryption"]);
  let verdict;
  if (secret.error === "ResourceNotFoundException") verdict = copy.ok ? "no secret (the parameter exists)" : "no secret, no parameter";
  else if (secret.error) verdict = `secret not read (${secret.error})`;
  else if (copy.error === "ParameterNotFound") verdict = "NO PARAMETER";
  else if (copy.error) verdict = `parameter not read (${copy.error})`;
  else if (copy.ok.Parameter.Type !== "SecureString") verdict = `NOT ENCRYPTED (${copy.ok.Parameter.Type})`;
  else verdict = copy.ok.Parameter.Value === secret.ok.SecretString ? "equal" : "NOT EQUAL";
  if (verdict !== "equal" && !verdict.startsWith("no secret")) bad++;
  console.log(`${id}: ${verdict}`);
}
process.exit(bad ? 1 : 0);
