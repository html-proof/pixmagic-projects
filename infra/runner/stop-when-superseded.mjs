// Stops a pull request's CI run once a newer push to that pull request changes the code a run tests:
// ci.yml's checks and e2e jobs start it on a pull request (step "Stop this run if a newer push
// changes code").
//
// A push to a pull request doesn't cancel its run in progress (ci.yml, concurrency). A run tests the
// pull request merged into main, and so will the run for the newer push. When both come to the same
// code (Markdown and docs/ aside: code-key.mjs), as after a push of only docs or a merge of main into
// the branch, the run's result is good for the newer push: the run finishes, and the next run skips
// what it passed. Otherwise the result is useless, so this cancels the run within a minute rather
// than let it hold the runner.
//
// Run with no arguments, it starts a detached copy of itself and returns at once (a child holding the
// step's output open would keep the step running). The copy lists the code this run tests (git
// ls-tree of the checkout), then asks GitHub every minute for the pull request's head. Once that
// moved, it waits for GitHub's merge of the newer head into main (the pull request's
// merge_commit_sha) and compares its files with this run's. What it found goes to
// $RUNNER_TEMP/superseded.log as annotations, which the job's last step prints, so a run it stopped
// says why under Annotations. A GitHub error is logged and asked again a minute later, never a
// reason to stop. The runner's clean-up ends the copy with the job (it ends every process carrying
// the job's RUNNER_TRACKING_ID), and it gives up by itself after 3 hours, longer than any job's
// timeout-minutes.
import { execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { codeEntries, listingEntries, pathOf, treeEntries } from "./code-key.mjs";

/**
 * Watch the pull request until a newer push changes the code its run tests (then cancel this run:
 * "cancelled"), it closes, or 3 hours pass. `tested`: `git ls-tree -r -z HEAD` of this run's checkout.
 */
export async function watch({ env = process.env, tested, request = fetch, wait = sleep, now = Date.now, log = console.log } = {}) {
  const { GITHUB_API_URL: api = "https://api.github.com", GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_TOKEN: token, PR_NUMBER: pr, PR_HEAD: head } = env;
  if (!repo || !run || !token || !pr || !head || !tested) throw new Error("GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN, PR_NUMBER, PR_HEAD and the tested listing are required");
  const github = async (path, method = "GET") => {
    const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
    const res = await request(`${api}/repos/${repo}/${path}`, { method, headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return method === "GET" ? res.json() : null;
  };
  const ours = new Set(codeEntries(listingEntries(tested)));

  // Why the newer push's run tests other code than this run, null when it's the same code, undefined
  // while GitHub hasn't merged the newer head into main yet.
  const difference = async (pull) => {
    if (pull.mergeable === null) return undefined;
    if (pull.mergeable === false) return "conflicts with main, so this run's result can't count for it";
    const merge = await github(`git/commits/${pull.merge_commit_sha}`);
    if (!merge.parents.some((parent) => parent.sha === pull.head.sha)) return undefined;
    const tree = await github(`git/trees/${merge.tree.sha}?recursive=1`);
    if (tree.truncated) return "has more files than GitHub lists at once, so this run can't tell whether it tests the same code";
    const theirs = new Set(codeEntries(treeEntries(tree.tree)));
    const paths = [...new Set([...theirs].filter((e) => !ours.has(e)).concat([...ours].filter((e) => !theirs.has(e))).map(pathOf))].sort();
    if (!paths.length) return null;
    const more = paths.length > 1 ? ` and ${paths.length - 1} more` : "";
    return `changes the code this run tests (${paths[0]}${more}). The run for that push tests it`;
  };

  const until = now() + 3 * 3600_000;
  let checked = head; // the newest head found to leave this run's code as it is
  while (now() < until) {
    try {
      const pull = await github(`pulls/${pr}`);
      if (pull.state !== "open") {
        log(`Pull request #${pr} was ${pull.merged ? "merged" : "closed"}: no longer watching it.`);
        return;
      }
      if (pull.head.sha !== checked) {
        const newer = pull.head.sha.slice(0, 7);
        const why = await difference(pull);
        if (why) {
          await github(`actions/runs/${run}/cancel`, "POST");
          log(`::notice::Stopped: a newer push to this pull request (${newer}) ${why}.`);
          return "cancelled";
        }
        if (why === null) {
          log(`::notice::A newer push to this pull request (${newer}) leaves the code this run tests as it is (Markdown and docs/ aside): this run carried on, and the run for that push skips what this one passes.`);
          checked = pull.head.sha;
        }
      }
    } catch (err) {
      log(`${new Date(now()).toISOString()} Couldn't check for a newer push (${err.message}); asking again in a minute.`);
    }
    await wait(60_000);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--watch") await watch({ tested: execFileSync("git", ["ls-tree", "-r", "-z", "HEAD"], { encoding: "utf8", maxBuffer: 64 << 20 }) });
  else {
    const out = openSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "superseded.log"), "a");
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--watch"], { detached: true, stdio: ["ignore", out, out], windowsHide: true }).unref();
    console.log(`Watching pull request #${process.env.PR_NUMBER} for a newer push that changes the code this run tests (${process.env.PR_HEAD?.slice(0, 7)} merged into main).`);
  }
}
