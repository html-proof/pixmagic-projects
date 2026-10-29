// Stops a pull request's CI run once a newer push to that pull request changes code: ci.yml's checks
// and e2e jobs start it on a pull request (step "Stop this run if a newer push changes code").
//
// A push to a pull request doesn't cancel its run in progress (ci.yml, concurrency). One that changes
// only Markdown or docs/ (a merge of a docs-only main, say) leaves the run's result good: the run
// finishes, and the next run, on the same code, skips what it passed. One that changes code makes the
// result useless, so this cancels the run within a minute rather than let it hold the runner.
//
// Run with no arguments, it starts a detached copy of itself and returns at once (a child holding the
// step's output open would keep the step running). The copy asks GitHub every minute for the pull
// request's head; once that moved, it compares this run's head with it (code-key.mjs, codeChange).
// What it found goes to $RUNNER_TEMP/superseded.log as annotations, which the job's last step prints,
// so a run it stopped says why under Annotations. A GitHub error is logged and asked again a minute
// later, never a reason to stop. The runner's clean-up ends the copy with the job (it ends every
// process carrying the job's RUNNER_TRACKING_ID), and it gives up by itself after 3 hours, longer
// than any job's timeout-minutes.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { codeChange } from "./code-key.mjs";

/** Watch the pull request until a newer push changes code (then cancel this run: "cancelled"), it closes, or 3 hours pass. */
export async function watch({ env = process.env, request = fetch, wait = sleep, now = Date.now, log = console.log } = {}) {
  const { GITHUB_API_URL: api = "https://api.github.com", GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_TOKEN: token, PR_NUMBER: pr, PR_HEAD: head } = env;
  if (!repo || !run || !token || !pr || !head) throw new Error("GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN, PR_NUMBER and PR_HEAD are required");
  const github = async (path, method = "GET") => {
    const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
    const res = await request(`${api}/repos/${repo}/${path}`, { method, headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return method === "GET" ? res.json() : null;
  };
  const until = now() + 3 * 3600_000;
  let checked = head; // the newest head found to change no code
  while (now() < until) {
    try {
      const pull = await github(`pulls/${pr}`);
      if (pull.state !== "open") {
        log(`Pull request #${pr} was ${pull.merged ? "merged" : "closed"}: no longer watching it.`);
        return;
      }
      if (pull.head.sha !== checked) {
        const newer = pull.head.sha.slice(0, 7);
        const change = codeChange(await github(`compare/${head}...${pull.head.sha}`));
        if (change) {
          await github(`actions/runs/${run}/cancel`, "POST");
          log(`::notice::Stopped: a newer push to this pull request (${newer}) ${change}. The run for that push tests it.`);
          return "cancelled";
        }
        log(`::notice::A newer push to this pull request (${newer}) changed only Markdown or docs/: this run carried on, and the run for that push skips what this one passes.`);
        checked = pull.head.sha;
      }
    } catch (err) {
      log(`${new Date(now()).toISOString()} Couldn't check for a newer push (${err.message}); asking again in a minute.`);
    }
    await wait(60_000);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--watch") await watch();
  else {
    const out = openSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "superseded.log"), "a");
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--watch"], { detached: true, stdio: ["ignore", out, out], windowsHide: true }).unref();
    console.log(`Watching pull request #${process.env.PR_NUMBER} for a newer push that changes code (this run tests ${process.env.PR_HEAD?.slice(0, 7)}).`);
  }
}
