// What CI counts as code. ci.yml ignores Markdown files and docs/ (paths-ignore: a change of only
// those starts no run), so two commits that differ only there test the same: a job that passed on
// one has passed on the other. ci.yml's job "Already passed on this code?" records and looks up
// passes by codeKey, and stop-when-superseded.mjs lets a pull request's run carry on after a newer
// push when the code that push's run would test is this run's (codeEntries, both sides).
import { createHash } from "node:crypto";

/** ci.yml's paths-ignore, which ignoredByCi implements (code-key.test.mjs holds them together). */
export const CI_IGNORES = ["**.md", "docs/**"];

/** Whether CI ignores a repository path. */
export const ignoredByCi = (path) => path.endsWith(".md") || path.startsWith("docs/");

/** The path of a file entry as `git ls-tree -r` prints it: "<mode> <type> <object>\t<path>". */
export const pathOf = (entry) => entry.slice(entry.indexOf("\t") + 1);

/** The file entries CI tests, sorted: the same files with the same contents give the same list. */
export const codeEntries = (entries) => entries.filter((entry) => entry && !ignoredByCi(pathOf(entry))).sort();

/** The file entries of `git ls-tree -r -z <commit>` output. */
export const listingEntries = (listing) => listing.split("\0");

/** The file entries of GitHub's tree of a commit (GET /repos/{repo}/git/trees/{tree}?recursive=1), as git prints them. */
export const treeEntries = (tree) => tree.filter((item) => item.type !== "tree").map((item) => `${item.mode} ${item.type} ${item.sha}\t${item.path}`);

/** The key of the code in `git ls-tree -r -z <commit>` output. Git ids, so the same on every OS and checkout. */
export function codeKey(listing) {
  return createHash("sha256").update(codeEntries(listingEntries(listing)).join("\0")).digest("hex");
}
