// What CI counts as code. ci.yml ignores Markdown files and docs/ (paths-ignore: a change of only
// those starts no run), so two commits that differ only there test the same: a job that passed on
// one has passed on the other. ci.yml's job "Already passed on this code?" records and looks up
// passes by codeKey, and stop-when-superseded.mjs lets a pull request's run carry on after a newer
// push that changes nothing else (codeChange).
import { createHash } from "node:crypto";

/** ci.yml's paths-ignore, which ignoredByCi implements (code-key.test.mjs holds them together). */
export const CI_IGNORES = ["**.md", "docs/**"];

/** Whether CI ignores a repository path. */
export const ignoredByCi = (path) => path.endsWith(".md") || path.startsWith("docs/");

/**
 * The key of the code in `git ls-tree -r -z <commit>` output: every entry but the ones CI ignores,
 * hashed. Git ids, so the same on every OS and checkout.
 */
export function codeKey(listing) {
  const code = listing.split("\0").filter((entry) => entry && !ignoredByCi(entry.slice(entry.indexOf("\t") + 1)));
  return createHash("sha256").update(code.join("\0")).digest("hex");
}

/**
 * What a newer push changed that CI tests, from GitHub's compare of the run's head with it
 * (GET /repos/{repo}/compare/{run head}...{newer head}): "changed <file>", or why it can't tell.
 * null when every file it changed is one CI ignores.
 */
export function codeChange(compare) {
  // Not ahead: the branch was rebased or reset, and the compare can't show what was dropped.
  if (compare.status !== "ahead" && compare.status !== "identical") return `rewrote the branch (${compare.status})`;
  const files = compare.files ?? [];
  // GitHub lists at most 300 files.
  if (files.length >= 300) return "changed 300 or more files";
  const file = files.find((f) => !ignoredByCi(f.filename) || (f.previous_filename && !ignoredByCi(f.previous_filename)));
  return file ? `changed ${file.filename}` : null;
}
